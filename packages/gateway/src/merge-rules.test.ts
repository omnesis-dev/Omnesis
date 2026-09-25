// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the user-driven + auto-detected merge rules system.
 *
 * Covers:
 *   - Rule CRUD (create, soft-delete, idempotence, validation)
 *   - Side canonicalization (mirror collapse, name lowercasing)
 *   - Eval correctness: single-rule, chains, conflicts, dormant rules
 *   - Apply / unmerge round-trips with score recompute
 *   - Auto-detect → system rules → veto via deactivate
 *   - Read-path aggregation (getDocumentPeople, getPersonById alias union,
 *     interaction-score attribution to canonical)
 *   - Migration of pre-rules merged_into → system rules
 *   - Concurrency: race between rule add and people-graph mutation
 *   - Yieldable upsert
 *   - Self-merge cases (rule includes is_self person)
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createDatabase, deleteAllBySource } from "./db.js";
import {
  createMergeRule,
  deleteMergeRule,
  listMergeRules,
  countMergeRules,
  computeMergeEquivalences,
  upsertMergeEquivalences,
  computeAutoDetectedRules,
  upsertAutoDetectedRules,
  runMergePass,
  mergePeople,
  unmergePerson,
  resolvePersonId,
  resolveDocumentPeople,
  findOrCreatePerson,
  getPersonById,
  getDocumentPeople,
  searchPeople,
  refreshInteractionScores,
  refreshPeopleCounts,
  readMergeRulesMeta,
  markMergeRulesDirty,
} from "./people.js";
import type { PersonMention } from "@omnesis/types";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-mergerules-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────

function insertDoc(opts: {
  id?: string;
  sourceId?: string;
  date?: string;
  mentions: PersonMention[];
}): string {
  const id = opts.id ?? `doc-${randomUUID()}`;
  const sourceId = opts.sourceId ?? "test";
  const date = opts.date ?? "2026-04-30T00:00:00.000Z";
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', ?, ?, 'Doc', 'c', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sourceId,
    id,
    `hash-${id}`,
    JSON.stringify({ documentType: "email", people: opts.mentions }),
    date,
    date,
    new Date().toISOString(),
    new Date().toISOString(),
  );
  resolveDocumentPeople(db, id, opts.mentions, sourceId, date);
  return id;
}

function makeSelf(emails: string[] = ["me@example.com"]): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, 'Me', 'contacts', TRUE, '2020-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id);
  for (const e of emails) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, ?, 'email', '2026-01-01')`,
    ).run(randomUUID(), id, e);
  }
  return id;
}

function applyAllRules(): void {
  upsertMergeEquivalences(db, computeMergeEquivalences(db));
}

// ─── CRUD ───────────────────────────────────────────────────────────

describe("createMergeRule", () => {
  test("inserts an active rule with normalized sides", () => {
    const result = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "phone", alias: "+15551234" },
      winnerSide: "a",
      reason: "same Alice",
    });
    expect(result.created).toBe(true);
    expect(result.rule.kind).toBe("user");
    expect(result.rule.active).toBe(true);
    expect(result.rule.reason).toBe("same Alice");
    // Canonicalization sorts (a, b) — email < phone alphabetically.
    expect(result.rule.sideA.aliasType).toBe("email");
    expect(result.rule.sideB.aliasType).toBe("phone");
  });

  test("canonicalizes mirror sides — re-creating with sides swapped returns the same row", () => {
    const r1 = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    const r2 = createMergeRule(db, {
      sideA: { aliasType: "phone", alias: "+1" },
      sideB: { aliasType: "email", alias: "a@x.com" },
      winnerSide: "b",
    });
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.rule.id).toBe(r1.rule.id);
  });

  test("name aliases are lowercased on insert (case-insensitive matching)", () => {
    const r1 = createMergeRule(db, {
      sideA: { aliasType: "name", alias: "James Bond" },
      sideB: { aliasType: "email", alias: "a@x.com" },
      winnerSide: "a",
    });
    // Find the name side (canonicalization may have swapped a/b — email
    // sorts before name alphabetically).
    const nameSide = r1.rule.sideA.aliasType === "name" ? r1.rule.sideA : r1.rule.sideB;
    expect(nameSide.alias).toBe("james bond");
    // Re-create with different case → same row.
    const r2 = createMergeRule(db, {
      sideA: { aliasType: "name", alias: "JAMES BOND" },
      sideB: { aliasType: "email", alias: "a@x.com" },
      winnerSide: "a",
    });
    expect(r2.created).toBe(false);
    expect(r2.rule.id).toBe(r1.rule.id);
  });

  test("rejects user rules with identical sides", () => {
    expect(() =>
      createMergeRule(db, {
        sideA: { aliasType: "email", alias: "a@x.com" },
        sideB: { aliasType: "email", alias: "a@x.com" },
        winnerSide: "a",
      }),
    ).toThrow(/different aliases/);
  });

  test("allows system rules with identical sides (auto-detect tautology)", () => {
    const r = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "shared@x.com" },
      sideB: { aliasType: "email", alias: "shared@x.com" },
      winnerSide: "a",
      kind: "system",
    });
    expect(r.created).toBe(true);
    expect(r.rule.kind).toBe("system");
  });

  test("rejects empty alias values", () => {
    expect(() =>
      createMergeRule(db, {
        sideA: { aliasType: "email", alias: "  " },
        sideB: { aliasType: "phone", alias: "+1" },
        winnerSide: "a",
      }),
    ).toThrow(/non-empty/);
  });

  test("rejects invalid alias types", () => {
    expect(() =>
      createMergeRule(db, {
        // @ts-expect-error testing invalid type
        sideA: { aliasType: "twitter", alias: "@x" },
        sideB: { aliasType: "email", alias: "a@x.com" },
        winnerSide: "a",
      }),
    ).toThrow(/Invalid alias type/);
  });

  test("rejects invalid winnerSide", () => {
    expect(() =>
      createMergeRule(db, {
        sideA: { aliasType: "email", alias: "a@x.com" },
        sideB: { aliasType: "phone", alias: "+1" },
        // @ts-expect-error testing invalid winner
        winnerSide: "c",
      }),
    ).toThrow(/winnerSide/);
  });

  test("re-creating an active rule is a no-op", () => {
    const r1 = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    const r2 = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    expect(r1.rule.id).toBe(r2.rule.id);
    expect(r2.created).toBe(false);
  });

  test("re-creating a deleted rule produces a fresh row with a new id", () => {
    const r1 = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    deleteMergeRule(db, r1.rule.id);
    const r2 = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    // Delete is permanent — re-create is a brand-new row, NOT a
    // reactivation of the old id.
    expect(r2.created).toBe(true);
    expect(r2.rule.id).not.toBe(r1.rule.id);
    expect(r2.rule.active).toBe(true);
  });
});

describe("deleteMergeRule", () => {
  test("returns true on first delete, false on second", () => {
    const r = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    expect(deleteMergeRule(db, r.rule.id)).toBe(true);
    expect(deleteMergeRule(db, r.rule.id)).toBe(false);
  });

  test("returns false for nonexistent id", () => {
    expect(deleteMergeRule(db, "nope")).toBe(false);
  });

  test("bumps merge_rules_meta dirty_version", () => {
    const r = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    const before = readMergeRulesMeta(db).dirtyVersion;
    deleteMergeRule(db, r.rule.id);
    expect(readMergeRulesMeta(db).dirtyVersion).toBeGreaterThan(before);
  });
});

describe("upsertMergeEquivalences stale-snapshot guard", () => {
  test("a snapshot computed against an older dirty version is skipped", () => {
    // Two people bridged by a rule: snapshot V1 sees no rules yet.
    const a = randomUUID();
    const b = randomUUID();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'Maya Reeves', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
              (?, 'M Reeves', 'extracted', '2026-02-01', '2026-02-01', '2026-02-01', '2026-02-01')`,
    ).run(a, b);
    for (const [pid, alias] of [
      [a, "mreeves@example.com"],
      [b, "maya.reeves@northstar.example"],
    ] as const) {
      db.prepare(
        `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
         VALUES (?, ?, ?, 'email', '2026-01-01')`,
      ).run(randomUUID(), pid, alias);
    }
    const staleSnapshot = computeMergeEquivalences(db); // pre-rule state

    // The rule lands (bumping the dirty version) and a fresh pass applies it.
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "mreeves@example.com" },
      sideB: { aliasType: "email", alias: "maya.reeves@northstar.example" },
      winnerSide: "a",
      reason: "same person",
    });
    upsertMergeEquivalences(db, computeMergeEquivalences(db));
    const mergedInto = (): string | null =>
      db
        .prepare<
          [string],
          { merged_into: string | null }
        >("SELECT merged_into FROM people WHERE id = ?")
        .get(b)?.merged_into ?? null;
    expect(mergedInto()).toBe(a);

    // Replaying the stale (empty) snapshot must not unwind the newer state.
    const result = upsertMergeEquivalences(db, staleSnapshot);
    expect(result).toEqual({ added: 0, changed: 0, removed: 0, unchanged: 0, deletedCollapsed: 0 });
    expect(mergedInto()).toBe(a);
  });
});

describe("upsertMergeEquivalences orphan sweep", () => {
  test("clears orphan merged_into pointer with no backing equivalence", () => {
    // Inject corruption: person points at another person, but no
    // active rule produces that equivalence.
    const a = randomUUID();
    const b = randomUUID();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'A', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
              (?, 'B', 'extracted', '2026-02-01', '2026-02-01', '2026-02-01', '2026-02-01')`,
    ).run(a, b);
    db.prepare("UPDATE people SET merged_into = ? WHERE id = ?").run(a, b);

    // No rule, no equivalence — eval should clear the orphan.
    upsertMergeEquivalences(db, computeMergeEquivalences(db));

    const after = db
      .prepare<
        [string],
        { merged_into: string | null }
      >("SELECT merged_into FROM people WHERE id = ?")
      .get(b);
    expect(after?.merged_into).toBeNull();
  });

  test("clears self-cycle merged_into = id", () => {
    const a = randomUUID();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'A', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(a);
    db.prepare("UPDATE people SET merged_into = id WHERE id = ?").run(a);

    upsertMergeEquivalences(db, computeMergeEquivalences(db));

    const after = db
      .prepare<
        [string],
        { merged_into: string | null }
      >("SELECT merged_into FROM people WHERE id = ?")
      .get(a);
    expect(after?.merged_into).toBeNull();
  });

  test("does NOT touch merged_into pointers backed by an active rule", () => {
    // A normal rule-driven merge: should pass through unchanged.
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(resolvePersonId(db, b)).toBe(a);

    // Re-running eval should leave the merge intact.
    applyAllRules();
    expect(resolvePersonId(db, b)).toBe(a);
  });
});

describe("listMergeRules", () => {
  test("filter by kind; deleted rows disappear from all lists", () => {
    const a = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "b@x.com" },
      sideB: { aliasType: "email", alias: "b@x.com" },
      winnerSide: "a",
      kind: "system",
    });
    // Delete the user rule. Only the system one remains.
    deleteMergeRule(db, a.rule.id);
    expect(listMergeRules(db, {}).length).toBe(1);
    expect(listMergeRules(db, { active: true }).length).toBe(1);
    // active=false has no semantic meaning anymore (delete is permanent).
    // The filter still works (returns rows with active=0); should be empty.
    expect(listMergeRules(db, { active: false }).length).toBe(0);
    expect(listMergeRules(db, { kind: "system" }).length).toBe(1);
    expect(listMergeRules(db, { kind: "user" }).length).toBe(0);
  });

  test("countMergeRules matches the active list length without resolving", () => {
    const a = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "b@x.com" },
      sideB: { aliasType: "email", alias: "b@x.com" },
      winnerSide: "a",
      kind: "system",
    });
    expect(countMergeRules(db)).toBe(2);
    expect(countMergeRules(db, { active: true })).toBe(2);
    // Default (active-only) count mirrors what the rules screen renders.
    expect(countMergeRules(db, { active: true })).toBe(listMergeRules(db, { active: true }).length);
    deleteMergeRule(db, a.rule.id);
    expect(countMergeRules(db, { active: true })).toBe(1);
    expect(countMergeRules(db, { active: false })).toBe(0);
  });

  test("touchesPersonId returns rules whose alias resolves to that person", () => {
    findOrCreatePerson(db, { role: "sender", emails: ["alice@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-01-02");
    const r = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    const aliceId = db
      .prepare<
        [],
        { person_id: string }
      >("SELECT person_id FROM person_aliases WHERE alias='alice@x.com'")
      .get()!.person_id;
    const matched = listMergeRules(db, { touchesPersonId: aliceId });
    expect(matched.length).toBe(1);
    expect(matched[0].id).toBe(r.rule.id);
  });

  test("keyset-pages touching rules by created time and id", () => {
    const aliceId = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@example.com"] },
      "test",
      "2026-01-01",
    )!;
    const rules = [
      createMergeRule(db, {
        sideA: { aliasType: "email", alias: "alice@example.com" },
        sideB: { aliasType: "phone", alias: "+15550100101" },
        winnerSide: "a",
      }).rule,
      createMergeRule(db, {
        sideA: { aliasType: "email", alias: "alice@example.com" },
        sideB: { aliasType: "phone", alias: "+15550100102" },
        winnerSide: "a",
      }).rule,
      createMergeRule(db, {
        sideA: { aliasType: "email", alias: "alice@example.com" },
        sideB: { aliasType: "phone", alias: "+15550100103" },
        winnerSide: "a",
      }).rule,
    ];
    rules.forEach((rule, index) => {
      db.prepare("UPDATE merge_rules SET created_at = ? WHERE id = ?").run(
        `2026-07-0${3 - index}T00:00:00.000Z`,
        rule.id,
      );
    });

    const first = listMergeRules(db, { touchesPersonId: aliceId, limit: 2 });
    expect(first.map((rule) => rule.id)).toEqual([rules[0]!.id, rules[1]!.id]);
    const second = listMergeRules(db, {
      touchesPersonId: aliceId,
      limit: 2,
      beforeCreated: { createdAt: first[1]!.createdAt, id: first[1]!.id },
    });
    expect(second.map((rule) => rule.id)).toEqual([rules[2]!.id]);
  });

  test("withDetails fills aliases + sourceIds per resolved side", () => {
    // Build two people with multiple aliases each, one doc apiece.
    findOrCreatePerson(
      db,
      { role: "sender", name: "Alice", emails: ["alice@x.com"], phones: ["+15550001"] },
      "test",
      "2026-01-01",
    );
    findOrCreatePerson(
      db,
      { role: "sender", name: "Bob", emails: ["bob@x.com"], phones: ["+15550002"] },
      "test",
      "2026-01-02",
    );
    insertDoc({
      id: "doc-alice",
      mentions: [{ role: "sender", emails: ["alice@x.com"] }],
      date: "2026-04-29T00:00:00.000Z",
    });
    insertDoc({
      id: "doc-bob",
      mentions: [{ role: "sender", emails: ["bob@x.com"] }],
      date: "2026-04-30T00:00:00.000Z",
    });
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "email", alias: "bob@x.com" },
      winnerSide: "a",
    });

    // Without withDetails, no aliases / sourceIds.
    const rulesPlain = listMergeRules(db, { withResolved: true });
    expect(rulesPlain[0].resolvedSideA?.[0].aliases).toBeUndefined();
    expect(rulesPlain[0].resolvedSideA?.[0].sourceIds).toBeUndefined();

    // With withDetails, each resolved person carries their full alias
    // list and the distinct source-ids that contributed a doc.
    const rulesRich = listMergeRules(db, { withResolved: true, withDetails: true });
    expect(rulesRich.length).toBe(1);
    const sideA = rulesRich[0].resolvedSideA![0];
    const sideB = rulesRich[0].resolvedSideB![0];
    const aliasesA = (sideA.aliases ?? []).map((a) => `${a.aliasType}=${a.alias}`).sort();
    expect(aliasesA).toContain("email=alice@x.com");
    expect(aliasesA).toContain("phone=+15550001");
    expect(aliasesA.some((a) => a.startsWith("name="))).toBe(true);
    expect(sideA.sourceIds).toEqual(["test"]);
    expect(sideB.sourceIds).toEqual(["test"]);
    expect(typeof sideA.interactionScoreRecent).toBe("number");
  });

  test("preMerge mode: each side resolves to its pre-merge identity, not the canonical", () => {
    // Set up the same scenario as above, then APPLY the rule so the
    // people are logically merged.
    const aliceId = findOrCreatePerson(
      db,
      { role: "sender", name: "Alice", emails: ["alice@x.com"], phones: ["+15550001"] },
      "test",
      "2026-01-01",
    )!;
    const bobId = findOrCreatePerson(
      db,
      { role: "sender", name: "Bob", emails: ["bob@x.com"], phones: ["+15550002"] },
      "test",
      "2026-01-02",
    )!;
    insertDoc({
      id: "doc-alice",
      mentions: [{ role: "sender", emails: ["alice@x.com"] }],
      date: "2026-04-29T00:00:00.000Z",
    });
    insertDoc({
      id: "doc-bob",
      mentions: [{ role: "sender", emails: ["bob@x.com"] }],
      date: "2026-04-30T00:00:00.000Z",
    });
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "email", alias: "bob@x.com" },
      winnerSide: "a",
    });
    applyAllRules();
    // bob is now merged into alice (earliest first_seen wins).
    expect(resolvePersonId(db, bobId)).toBe(aliceId);

    // ── Canonical mode (default): both sides collapse to alice with
    //    the union of aliases and the union of docs. This is the
    //    "useless dual-card" view the user complained about.
    const canonical = listMergeRules(db, { withResolved: true, withDetails: true });
    expect(canonical[0].resolvedSideA?.[0].id).toBe(aliceId);
    expect(canonical[0].resolvedSideB?.[0].id).toBe(aliceId);
    const canonAliasesA = (canonical[0].resolvedSideA![0].aliases ?? []).map(
      (a) => `${a.aliasType}=${a.alias}`,
    );
    expect(canonAliasesA).toContain("email=alice@x.com");
    // Canonical's alias list comes from alice's own row only — bob's
    // aliases are surfaced via the read-path UNION at higher levels;
    // this primitive returns just the canonical row's aliases.
    expect(canonAliasesA).not.toContain("email=bob@x.com");
    // Equivalence-class source sample: covers both alice's and bob's
    // contributing sources (here both come from the "test" source, so
    // it dedupes to one).
    expect(canonical[0].resolvedSideA![0].sourceIds).toEqual(["test"]);

    // ── Pre-merge mode: each side returns its pre-merge identity.
    //    This is what the rules page wants — the operator can see
    //    the two distinct people that were merged.
    const preMerge = listMergeRules(db, {
      withResolved: true,
      withDetails: true,
      preMerge: true,
    });
    const preA = preMerge[0].resolvedSideA![0];
    const preB = preMerge[0].resolvedSideB![0];
    expect(preA.id).toBe(aliceId);
    expect(preB.id).toBe(bobId);

    // Each pre-merge row has only its own aliases.
    const preAliasesA = (preA.aliases ?? []).map((a) => `${a.aliasType}=${a.alias}`);
    const preAliasesB = (preB.aliases ?? []).map((a) => `${a.aliasType}=${a.alias}`);
    expect(preAliasesA).toContain("email=alice@x.com");
    expect(preAliasesA).toContain("phone=+15550001");
    expect(preAliasesA).not.toContain("email=bob@x.com");
    expect(preAliasesB).toContain("email=bob@x.com");
    expect(preAliasesB).toContain("phone=+15550002");
    expect(preAliasesB).not.toContain("email=alice@x.com");

    // Each pre-merge row has only its own contributing sources (no
    // equivalence-class union — both rows happen to share the "test"
    // source here, but the field reflects the row's own docs only).
    expect(preA.sourceIds).toEqual(["test"]);
    expect(preB.sourceIds).toEqual(["test"]);

    // The merged-loser side surfaces the canonical name so the UI
    // can render "merged into Alice" if it wants.
    expect(preA.mergedIntoCanonicalName).toBeUndefined();
    expect(preB.mergedIntoCanonicalName).toBe("Alice");
  });

  test("withDetails issues O(1) batched queries regardless of rule count", () => {
    // Pre-fix: each rule fired 4 per-person queries (sideA + sideB ×
    // {alias-list, source-ids}). For N rules with M resolved persons
    // each, that's ~4 × N × M extra queries. The batched path collapses
    // them to ONE alias-by-person SELECT and ONE source-by-person SELECT
    // (using ROW_NUMBER() for the per-person LIMIT), regardless of N.
    //
    // We assert the batch shape by counting `prepare()` calls across
    // varying rule counts: when rule count grows, the prepared-statement
    // tally must stay flat.
    function countPrepares(call: () => void): number {
      const orig = db.prepare.bind(db);
      let count = 0;
      const spy = ((sql: string) => {
        count += 1;
        return orig(sql);
      }) as typeof db.prepare;
      Object.defineProperty(db, "prepare", { value: spy, configurable: true });
      try {
        call();
      } finally {
        Object.defineProperty(db, "prepare", { value: orig, configurable: true });
      }
      return count;
    }
    // Two rules, each side resolves to one person.
    findOrCreatePerson(db, { role: "sender", emails: ["a1@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", emails: ["a2@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", emails: ["b1@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", emails: ["b2@x.com"] }, "test", "2026-01-01");
    insertDoc({
      id: "d1",
      mentions: [{ role: "sender", emails: ["a1@x.com"] }],
      date: "2026-04-01T00:00:00.000Z",
    });
    insertDoc({
      id: "d2",
      mentions: [{ role: "sender", emails: ["a2@x.com"] }],
      date: "2026-04-01T00:00:00.000Z",
    });
    insertDoc({
      id: "d3",
      mentions: [{ role: "sender", emails: ["b1@x.com"] }],
      date: "2026-04-01T00:00:00.000Z",
    });
    insertDoc({
      id: "d4",
      mentions: [{ role: "sender", emails: ["b2@x.com"] }],
      date: "2026-04-01T00:00:00.000Z",
    });
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a1@x.com" },
      sideB: { aliasType: "email", alias: "a2@x.com" },
      winnerSide: "a",
    });
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "b1@x.com" },
      sideB: { aliasType: "email", alias: "b2@x.com" },
      winnerSide: "a",
    });
    const prepares2 = countPrepares(() => {
      listMergeRules(db, { withResolved: true, withDetails: true });
    });

    // Add two more rules (4 fresh emails / docs) — same batched
    // prepare count must hold.
    findOrCreatePerson(db, { role: "sender", emails: ["c1@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", emails: ["c2@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", emails: ["d1@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", emails: ["d2@x.com"] }, "test", "2026-01-01");
    insertDoc({
      id: "d5",
      mentions: [{ role: "sender", emails: ["c1@x.com"] }],
      date: "2026-04-01T00:00:00.000Z",
    });
    insertDoc({
      id: "d6",
      mentions: [{ role: "sender", emails: ["c2@x.com"] }],
      date: "2026-04-01T00:00:00.000Z",
    });
    insertDoc({
      id: "d7",
      mentions: [{ role: "sender", emails: ["d1@x.com"] }],
      date: "2026-04-01T00:00:00.000Z",
    });
    insertDoc({
      id: "d8",
      mentions: [{ role: "sender", emails: ["d2@x.com"] }],
      date: "2026-04-01T00:00:00.000Z",
    });
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "c1@x.com" },
      sideB: { aliasType: "email", alias: "c2@x.com" },
      winnerSide: "a",
    });
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "d1@x.com" },
      sideB: { aliasType: "email", alias: "d2@x.com" },
      winnerSide: "a",
    });
    const prepares4 = countPrepares(() => {
      listMergeRules(db, { withResolved: true, withDetails: true });
    });

    // The batched path is dominated by:
    //   - one rules SELECT
    //   - per-side bare-resolve prepares (cached in JS, prepared once
    //     across the loop — 2 prepares for name vs other-alias variant)
    //   - one batched aliases SELECT
    //   - one batched source-ids SELECT
    // Doubling rules (and their resolved persons) MUST NOT double the
    // prepared-statement count. Allow a small tolerance for SQL ops
    // outside the listMergeRules path that may run incidentally.
    expect(prepares4).toBeLessThanOrEqual(prepares2 + 2);
  });
});

// ─── Eval — single rule ─────────────────────────────────────────────

describe("computeMergeEquivalences — single rule", () => {
  test("email-to-phone bridge merges two people", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(
      db,
      { role: "sender", phones: ["+15551234"] },
      "test",
      "2026-02-01",
    )!;
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "phone", alias: "+15551234" },
      winnerSide: "a",
    });
    applyAllRules();
    // a was created first → earliest first_seen → wins canonical.
    expect(resolvePersonId(db, b)).toBe(a);
    expect(resolvePersonId(db, a)).toBe(a);
  });

  test("rule with one dormant side does nothing", () => {
    findOrCreatePerson(db, { role: "sender", emails: ["alice@x.com"] }, "test", "2026-01-01");
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      // No person has this phone yet.
      sideB: { aliasType: "phone", alias: "+15551234" },
      winnerSide: "a",
    });
    const snap = computeMergeEquivalences(db);
    expect(snap.equivalences).toEqual([]);
  });

  test("rule with both sides dormant does nothing", () => {
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "noone@x.com" },
      sideB: { aliasType: "phone", alias: "+0" },
      winnerSide: "a",
    });
    const snap = computeMergeEquivalences(db);
    expect(snap.equivalences).toEqual([]);
  });

  test("dormant rule wakes up when its alias appears", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@x.com"] },
      "test",
      "2026-01-01",
    )!;
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "phone", alias: "+15551234" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(computeMergeEquivalences(db).equivalences).toEqual([]);
    // Now insert a person carrying the dormant alias.
    const b = findOrCreatePerson(
      db,
      { role: "sender", phones: ["+15551234"] },
      "test",
      "2026-02-01",
    )!;
    applyAllRules();
    expect(resolvePersonId(db, b)).toBe(a);
  });

  test("name-based rule is case-insensitive", () => {
    const a = findOrCreatePerson(
      db,
      { role: "contact", name: "James Bond", emails: ["a@x.com"] },
      "contacts",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(
      db,
      { role: "contact", name: "james BOND", phones: ["+1"] },
      "contacts",
      "2026-02-01",
    )!;
    createMergeRule(db, {
      sideA: { aliasType: "name", alias: "James Bond" },
      sideB: { aliasType: "email", alias: "a@x.com" },
      winnerSide: "a",
    });
    applyAllRules();
    // The name rule resolves both via case-insensitive lookup.
    // Even though side B is a@x.com, the person carrying that email
    // is a, so a stays canonical and b joins via the name match.
    expect(resolvePersonId(db, b)).toBe(a);
  });

  test("rule with side A matching multiple distinct people merges all of them", () => {
    // Three distinct people all carrying the same email (extracted
    // separately before any merging). Rule says (email=foo) ↔ (phone=bar).
    const a1 = randomUUID();
    const a2 = randomUUID();
    const a3 = randomUUID();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'A1', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
              (?, 'A2', 'extracted', '2026-01-02', '2026-01-02', '2026-01-02', '2026-01-02'),
              (?, 'A3', 'extracted', '2026-01-03', '2026-01-03', '2026-01-03', '2026-01-03')`,
    ).run(a1, a2, a3);
    for (const id of [a1, a2, a3]) {
      db.prepare(
        `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
         VALUES (?, ?, 'shared@x.com', 'email', '2026-01-01')`,
      ).run(randomUUID(), id);
    }
    const b = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "shared@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    // a1 has earliest first_seen → canonical for the whole component.
    expect(resolvePersonId(db, a1)).toBe(a1);
    expect(resolvePersonId(db, a2)).toBe(a1);
    expect(resolvePersonId(db, a3)).toBe(a1);
    expect(resolvePersonId(db, b)).toBe(a1);
  });
});

// ─── Eval — chains and components ───────────────────────────────────

describe("computeMergeEquivalences — chains", () => {
  test("two chained rules merge three people into one root", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;
    const c = findOrCreatePerson(db, { role: "sender", lids: ["lid:c"] }, "test", "2026-03-01")!;
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    createMergeRule(db, {
      sideA: { aliasType: "phone", alias: "+1" },
      sideB: { aliasType: "lid", alias: "lid:c" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(resolvePersonId(db, a)).toBe(a);
    expect(resolvePersonId(db, b)).toBe(a);
    expect(resolvePersonId(db, c)).toBe(a);
  });

  test("diamond (a-b, a-c, b-d, c-d) merges all four", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;
    const c = findOrCreatePerson(db, { role: "sender", lids: ["lid:c"] }, "test", "2026-03-01")!;
    const d = findOrCreatePerson(
      db,
      { role: "sender", emails: ["d@x.com"] },
      "test",
      "2026-04-01",
    )!;
    for (const [aA, aB] of [
      [
        { aliasType: "email" as const, alias: "a@x.com" },
        { aliasType: "phone" as const, alias: "+1" },
      ],
      [
        { aliasType: "email" as const, alias: "a@x.com" },
        { aliasType: "lid" as const, alias: "lid:c" },
      ],
      [
        { aliasType: "phone" as const, alias: "+1" },
        { aliasType: "email" as const, alias: "d@x.com" },
      ],
      [
        { aliasType: "lid" as const, alias: "lid:c" },
        { aliasType: "email" as const, alias: "d@x.com" },
      ],
    ]) {
      createMergeRule(db, { sideA: aA, sideB: aB, winnerSide: "a" });
    }
    applyAllRules();
    const root = resolvePersonId(db, a);
    expect(resolvePersonId(db, b)).toBe(root);
    expect(resolvePersonId(db, c)).toBe(root);
    expect(resolvePersonId(db, d)).toBe(root);
  });

  test("transitively-collapsed depth = 1 (loser points DIRECTLY at root)", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;
    const c = findOrCreatePerson(db, { role: "sender", lids: ["lid:c"] }, "test", "2026-03-01")!;
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    createMergeRule(db, {
      sideA: { aliasType: "phone", alias: "+1" },
      sideB: { aliasType: "lid", alias: "lid:c" },
      winnerSide: "a",
    });
    applyAllRules();
    // Direct merged_into pointers, no intermediate hops needed.
    const cMerged = db
      .prepare<
        [string],
        { merged_into: string | null }
      >("SELECT merged_into FROM people WHERE id = ?")
      .get(c)!.merged_into;
    expect(cMerged).toBe(a);
  });
});

// ─── Eval — self-aware canonical pick ───────────────────────────────

describe("computeMergeEquivalences — self handling", () => {
  test("self person always wins the canonical pick regardless of first_seen", () => {
    // Self created LATER than the extracted person, but is_self wins.
    const oldExtracted = findOrCreatePerson(
      db,
      { role: "sender", emails: ["me@x.com"] },
      "test",
      "2024-01-01",
    )!;
    const self = makeSelf(["me-self@x.com"]);
    // Update self's first_seen to be LATER than the extracted person.
    db.prepare("UPDATE people SET first_seen = '2026-01-01' WHERE id = ?").run(self);

    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "me@x.com" },
      sideB: { aliasType: "email", alias: "me-self@x.com" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(resolvePersonId(db, oldExtracted)).toBe(self);
  });
});

// ─── Eval — winner_side tiebreaker ──────────────────────────────────

describe("computeMergeEquivalences — winner_side", () => {
  test("winnerSide is honored when first_seen ties (vote-counting overrides lex tiebreaker)", () => {
    // Same first_seen on both → no determinism from that. Without
    // vote-counting, lex-smaller id (aId) would have won. Now with
    // vote-counting, side B's person wins because the rule gave it
    // +1 vote (aId got 0).
    const aId = "a-aaaa";
    const bId = "b-bbbb";
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'A', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
              (?, 'B', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(aId, bId);
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, 'a@x.com', 'email', '2026-01-01'),
              (?, ?, '+1', 'phone', '2026-01-01')`,
    ).run(randomUUID(), aId, randomUUID(), bId);
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "b",
    });
    applyAllRules();
    // bId wins via the +1 vote from winner_side='b' (single rule
    // → unambiguous). aId merges into bId.
    expect(resolvePersonId(db, bId)).toBe(bId);
    expect(resolvePersonId(db, aId)).toBe(bId);
  });

  test("lex tiebreaker still kicks in when votes also tie", () => {
    // Two rules with conflicting winner_sides — votes balance to 1
    // each person → fall through to first_seen → lex id.
    const aId = "a-aaaa";
    const bId = "b-bbbb";
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'A', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
              (?, 'B', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(aId, bId);
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, 'a@x.com', 'email', '2026-01-01'),
              (?, ?, '+1', 'phone', '2026-01-01'),
              (?, ?, 'a-extra', 'lid', '2026-01-01'),
              (?, ?, 'b-extra', 'lid', '2026-01-01')`,
    ).run(randomUUID(), aId, randomUUID(), bId, randomUUID(), aId, randomUUID(), bId);
    // Rule 1: A wins.
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    // Rule 2: B wins.
    createMergeRule(db, {
      sideA: { aliasType: "lid", alias: "a-extra" },
      sideB: { aliasType: "lid", alias: "b-extra" },
      winnerSide: "b",
    });
    applyAllRules();
    // Votes: aId=1 (R1), bId=1 (R2). Tied. first_seen also tied.
    // Lex id: a-aaaa < b-bbbb → aId wins.
    expect(resolvePersonId(db, aId)).toBe(aId);
    expect(resolvePersonId(db, bId)).toBe(aId);
  });
});

// ─── Apply / unmerge round-trips ────────────────────────────────────

describe("upsertMergeEquivalences", () => {
  test("idempotent: re-applying same snapshot is a no-op", () => {
    findOrCreatePerson(db, { role: "sender", emails: ["a@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01");
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    const snap = computeMergeEquivalences(db);
    const r1 = upsertMergeEquivalences(db, snap);
    expect(r1.added).toBe(1);
    const r2 = upsertMergeEquivalences(db, snap);
    expect(r2.added).toBe(0);
    expect(r2.changed).toBe(0);
    expect(r2.removed).toBe(0);
  });

  test("deactivating a rule unmerges the people it bridged", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;
    const r = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(resolvePersonId(db, b)).toBe(a);

    deleteMergeRule(db, r.rule.id);
    applyAllRules();
    expect(resolvePersonId(db, b)).toBe(b);
    expect(resolvePersonId(db, a)).toBe(a);
  });

  test("redundant rules: deactivating one keeps merge via the other", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"], phones: ["+1"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(
      db,
      { role: "sender", emails: ["b@x.com"], phones: ["+2"] },
      "test",
      "2026-02-01",
    )!;
    // Two separate rules both bridging a ↔ b.
    const r1 = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "email", alias: "b@x.com" },
      winnerSide: "a",
    });
    createMergeRule(db, {
      sideA: { aliasType: "phone", alias: "+1" },
      sideB: { aliasType: "phone", alias: "+2" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(resolvePersonId(db, b)).toBe(a);

    deleteMergeRule(db, r1.rule.id);
    applyAllRules();
    // Still merged via the second rule.
    expect(resolvePersonId(db, b)).toBe(a);
  });

  test("re-activating a deactivated rule restores the merge", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;
    const r = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(resolvePersonId(db, b)).toBe(a);

    deleteMergeRule(db, r.rule.id);
    applyAllRules();
    expect(resolvePersonId(db, b)).toBe(b);

    // Reactivate via re-create.
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(resolvePersonId(db, b)).toBe(a);
  });
});

// ─── Read-path aggregation ──────────────────────────────────────────

describe("read paths after logical merge", () => {
  test("getDocumentPeople returns canonical (not merged loser)", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;
    insertDoc({ id: "d1", mentions: [{ role: "sender", phones: ["+1"] }] });
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    const links = getDocumentPeople(db, "d1");
    expect(links.length).toBe(1);
    expect(links[0].personId).toBe(a);
    // Aliases on the canonical include the loser's phone.
    expect(links[0].aliases.some((al) => al.alias === "+1")).toBe(true);
    expect(links[0].aliases.some((al) => al.alias === "a@x.com")).toBe(true);
  });

  test("getPersonById on canonical returns aliases from all merged people", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01");
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    const detail = getPersonById(db, a)!;
    const aliasValues = detail.aliases.map((al) => al.alias).sort();
    expect(aliasValues).toContain("a@x.com");
    expect(aliasValues).toContain("+1");
  });

  test("getPersonById dedupes aliases across the equivalence class", () => {
    // Canonical has name="Eve" + email; loser has name="Eve"
    // (case-different) + phone. The union should expose ONE name=Eve
    // chip, not three.
    const a = findOrCreatePerson(
      db,
      { role: "sender", name: "Eve", emails: ["s@x.com"] },
      "test",
      "2026-01-01",
    )!;
    findOrCreatePerson(db, { role: "sender", name: "eve", phones: ["+1"] }, "test", "2026-02-01");
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "s@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    const detail = getPersonById(db, a)!;
    const names = detail.aliases.filter((al) => al.aliasType === "name");
    // Case-insensitive dedupe on names (matches rule-eval resolver).
    expect(names.length).toBe(1);
    // Other types still present.
    expect(detail.aliases.some((al) => al.alias === "s@x.com")).toBe(true);
    expect(detail.aliases.some((al) => al.alias === "+1")).toBe(true);
  });

  test("findOrCreatePerson does NOT cross-walk new aliases onto canonical when the matched alias lives on a logical loser", () => {
    // Setup: rule (email=A) ↔ (phone=B). Two people pre-merge: alice
    // with email A, bob with phone B. After eval, bob is a logical
    // loser of alice.
    const alice = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const bob = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(resolvePersonId(db, bob)).toBe(alice);

    // A new doc mentions phone=+1 (bob's alias) PLUS a brand-new
    // identifier (lid). Pre-fix: findOrCreatePerson would walk
    // merged_into to alice and attach the new lid to alice's row,
    // polluting her aliases over time. With the fix: the new lid
    // lands on bob (the row that owns the matching phone), preserving
    // the loser's pre-merge identity.
    const result = findOrCreatePerson(
      db,
      { role: "sender", phones: ["+1"], lids: ["new-lid-123"] },
      "test",
      "2026-03-01",
    )!;
    // Returns canonical (alice) for downstream document_people.
    expect(result).toBe(alice);
    // New lid is on BOB's row, NOT alice's.
    const aliceAliases = db
      .prepare<[string], { alias: string }>("SELECT alias FROM person_aliases WHERE person_id = ?")
      .all(alice)
      .map((r) => r.alias);
    const bobAliases = db
      .prepare<[string], { alias: string }>("SELECT alias FROM person_aliases WHERE person_id = ?")
      .all(bob)
      .map((r) => r.alias);
    expect(aliceAliases).not.toContain("new-lid-123");
    expect(bobAliases).toContain("new-lid-123");
    // And read paths still see the lid on the canonical via the
    // equivalence-class union.
    const detail = getPersonById(db, alice)!;
    expect(detail.aliases.some((a) => a.alias === "new-lid-123")).toBe(true);
  });

  test("getPersonById on a loser returns the loser's own pre-merge state, not the canonical's", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    // `a` is canonical, `b` is the loser (merged_into=a).
    const winner = getPersonById(db, a)!;
    const loser = getPersonById(db, b)!;
    expect(winner.id).toBe(a);
    expect(winner.mergedInto).toBeNull();
    expect(winner.mergedIntoCanonicalName).toBeNull();
    expect(loser.id).toBe(b);
    expect(loser.mergedInto).toBe(a);
    expect(loser.mergedIntoCanonicalName).toBe(winner.canonicalName);
    // Loser should expose ONLY its own aliases — not the canonical's.
    const loserAliasValues = loser.aliases.map((al) => al.alias).sort();
    expect(loserAliasValues).toContain("+1");
    expect(loserAliasValues).not.toContain("a@x.com");
    // And mergedFrom is empty on a loser (a loser doesn't have its
    // own losers — the equivalence class fans in to one canonical).
    expect(loser.mergedFrom).toEqual([]);
  });

  test("searchPeople only returns canonicals, not merged losers", () => {
    findOrCreatePerson(db, { role: "sender", emails: ["a@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01");
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    const all = searchPeople(db, "");
    // Both people existed pre-merge; only one (canonical) should remain in search.
    expect(all.length).toBe(1);
  });
});

// ─── Score recompute integration ────────────────────────────────────

describe("interaction scores follow merges", () => {
  test("merging reattributes edges to canonical", () => {
    const self = makeSelf();
    // Person A and B are the same person, but unmerged at first.
    insertDoc({
      mentions: [
        { role: "sender", emails: ["me@example.com"] },
        { role: "recipient", emails: ["alice@x.com"] },
      ],
    });
    insertDoc({
      mentions: [
        { role: "sender", phones: ["+1"] },
        { role: "recipient", emails: ["me@example.com"] },
      ],
    });

    refreshInteractionScores(db);
    const aliceId = db
      .prepare<
        [],
        { person_id: string }
      >("SELECT person_id FROM person_aliases WHERE alias='alice@x.com'")
      .get()!.person_id;
    const phoneId = db
      .prepare<[], { person_id: string }>("SELECT person_id FROM person_aliases WHERE alias='+1'")
      .get()!.person_id;
    expect(aliceId).not.toBe(phoneId);
    // Pre-merge: alice has 1 outbound (self → alice), phone has 1 inbound (phone → self).
    expect(getPersonById(db, aliceId)!.outboundCount).toBe(1);
    expect(getPersonById(db, phoneId)!.inboundCount).toBe(1);

    // User asserts they're the same.
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    refreshInteractionScores(db);

    // Post-merge: canonical has BOTH inbound + outbound = 1 each.
    const canonicalId = resolvePersonId(db, aliceId);
    const detail = getPersonById(db, canonicalId)!;
    expect(detail.inboundCount).toBe(1);
    expect(detail.outboundCount).toBe(1);
    expect(detail.interactionScore).toBeGreaterThan(0);
  });

  test("unmerging breaks the canonical's accumulated edges back apart", () => {
    makeSelf();
    insertDoc({
      mentions: [
        { role: "sender", emails: ["me@example.com"] },
        { role: "recipient", emails: ["alice@x.com"] },
      ],
    });
    insertDoc({
      mentions: [
        { role: "sender", phones: ["+1"] },
        { role: "recipient", emails: ["me@example.com"] },
      ],
    });
    const r = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    refreshInteractionScores(db);

    const aliceId = db
      .prepare<
        [],
        { person_id: string }
      >("SELECT person_id FROM person_aliases WHERE alias='alice@x.com'")
      .get()!.person_id;
    const phoneId = db
      .prepare<[], { person_id: string }>("SELECT person_id FROM person_aliases WHERE alias='+1'")
      .get()!.person_id;
    // Confirm pre-unmerge canonical has both.
    const canonicalId = resolvePersonId(db, aliceId);
    expect(getPersonById(db, canonicalId)!.outboundCount).toBe(1);
    expect(getPersonById(db, canonicalId)!.inboundCount).toBe(1);

    // Unmerge: deactivate the rule + re-apply.
    deleteMergeRule(db, r.rule.id);
    applyAllRules();
    refreshInteractionScores(db);

    // Now they're separate again; alice has only outbound, phone has only inbound.
    expect(getPersonById(db, aliceId)!.outboundCount).toBe(1);
    expect(getPersonById(db, aliceId)!.inboundCount).toBe(0);
    expect(getPersonById(db, phoneId)!.inboundCount).toBe(1);
    expect(getPersonById(db, phoneId)!.outboundCount).toBe(0);
  });
});

// ─── Auto-detect: physical merge for shared identifiers ────────────

describe("auto-detect physical-merges shared identifiers", () => {
  test("two people sharing an email are physical-merged (no rule)", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["shared@x.com"], name: "A" },
      "test",
      "2026-01-01",
    )!;
    // Create a second person with the same email manually (bypassing
    // findOrCreatePerson so we can test the auto-detect behavior).
    const b = randomUUID();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'B', 'extracted', '2026-02-01', '2026-02-01', '2026-02-01', '2026-02-01')`,
    ).run(b);
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, 'shared@x.com', 'email', '2026-02-01')`,
    ).run(randomUUID(), b);

    runMergePass(db);
    // a wins (earliest first_seen) and b is gone — physical merge.
    const survivors = db
      .prepare<[], { id: string }>("SELECT id FROM people WHERE id IN (?, ?)")
      .all(a, b) as { id: string }[];
    expect(survivors.map((r) => r.id)).toEqual([a]);
    // No rule is created — strong-identifier shares don't go through
    // the rules system anymore.
    expect(listMergeRules(db, { kind: "system" })).toHaveLength(0);
  });

  test("re-running auto-detect after physical merge is a no-op", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["shared@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = randomUUID();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'B', 'extracted', '2026-02-01', '2026-02-01', '2026-02-01', '2026-02-01')`,
    ).run(b);
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, 'shared@x.com', 'email', '2026-02-01')`,
    ).run(randomUUID(), b);

    runMergePass(db);
    // Physical merge happened on the first pass.
    const candidates = computeAutoDetectedRules(db);
    expect(candidates).toHaveLength(0);
    const result = upsertAutoDetectedRules(db, candidates);
    expect(result).toEqual({ inserted: 0, skipped: 0 });

    // Person `a` still around as canonical.
    expect(resolvePersonId(db, a)).toBe(a);
  });

  test("shared strong-identifier between logical-losers is detected but NOT physical-merged (sticky logical merge)", () => {
    // Set up: two extracted people share the same noreply email.
    // A user rule pulls both into the same equivalence class via a
    // third-party canonical. Auto-detect's compute step still sees the
    // candidate (no `merged_into IS NULL` filter), but the sticky-logical-
    // merge guard in physicalMergePeopleByAlias intentionally skips the
    // physical merge — the two losers are already rule-equivalent, the
    // duplicate alias is benign (read paths union across the equivalence
    // class), and physical-merging would destroy the losers' pre-merge
    // identities (which is exactly what the sticky guard was added to
    // prevent — see physical-merge.ts).
    const canonical = randomUUID();
    const loser1 = randomUUID();
    const loser2 = randomUUID();
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'Canonical', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
              (?, 'Loser 1', 'extracted', '2026-02-01', '2026-02-01', '2026-02-01', '2026-02-01'),
              (?, 'Loser 2', 'extracted', '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01')`,
    ).run(canonical, loser1, loser2);
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, 'canonical@x.com', 'email', '2026-01-01'),
              (?, ?, 'shared@x.com', 'email', '2026-02-01'),
              (?, ?, 'shared@x.com', 'email', '2026-03-01')`,
    ).run(randomUUID(), canonical, randomUUID(), loser1, randomUUID(), loser2);
    db.prepare("UPDATE people SET merged_into = ? WHERE id IN (?, ?)").run(
      canonical,
      loser1,
      loser2,
    );

    const candidates = computeAutoDetectedRules(db);
    // Compute still surfaces the candidate (no merged_into filter).
    expect(candidates.some((c) => c.sideA.alias === "shared@x.com")).toBe(true);

    upsertAutoDetectedRules(db, candidates);

    // Both losers survive: sticky guard preserves their pre-merge
    // identity. The shared-email duplication is benign — read paths
    // union aliases across the equivalence class.
    const ownersAfter = db
      .prepare<
        [],
        { person_id: string }
      >("SELECT DISTINCT person_id FROM person_aliases WHERE alias = 'shared@x.com'")
      .all();
    expect(ownersAfter.length).toBe(2);
    expect(db.prepare("SELECT id FROM people WHERE id = ?").get(loser1)).toBeTruthy();
    expect(db.prepare("SELECT id FROM people WHERE id = ?").get(loser2)).toBeTruthy();
  });

  test("contact-name share is physical-merged (no rule)", () => {
    const a = findOrCreatePerson(
      db,
      { role: "contact", name: "James Bond", emails: ["a@x.com"] },
      "apple-contacts:test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(
      db,
      { role: "contact", name: "james BOND", phones: ["+1"] },
      "google-contacts:test",
      "2026-02-01",
    )!;
    db.prepare("UPDATE people SET source = 'contacts' WHERE id IN (?, ?)").run(a, b);

    runMergePass(db);
    // Physical merge: b is gone, no name rule was created.
    const survivors = db
      .prepare<[], { id: string }>("SELECT id FROM people WHERE id IN (?, ?)")
      .all(a, b) as { id: string }[];
    expect(survivors.map((r) => r.id)).toEqual([a]);
    expect(
      listMergeRules(db, { kind: "system" }).filter((r) => r.sideA.aliasType === "name"),
    ).toHaveLength(0);
  });

  test("yields the writer mid-pass and finishes the rest on resume", () => {
    // The candidate set does not drain: a cluster the applicator permanently
    // refuses — here a shared mailbox the hub guard rejects — is re-detected
    // on every 5-minute pass. Without a seam between candidates the writer,
    // which serializes every write on the gateway, is held for the whole set
    // each time.
    const people: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const shared = randomUUID();
      const other = randomUUID();
      db.prepare(
        `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
         VALUES (?, ?, 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
                (?, ?, 'extracted', '2026-02-01', '2026-02-01', '2026-02-01', '2026-02-01')`,
      ).run(shared, `Maya Reeves ${i}`, other, `Jamie Lopez ${i}`);
      db.prepare(
        `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
         VALUES (?, ?, ?, 'email', '2026-01-01'), (?, ?, ?, 'email', '2026-02-01')`,
      ).run(
        randomUUID(),
        shared,
        `dup${i}@example.com`,
        randomUUID(),
        other,
        `dup${i}@example.com`,
      );
      people.push(shared, other);
    }

    const candidates = computeAutoDetectedRules(db);
    expect(candidates.length).toBe(4);

    // A token that always wants the writer back: every candidate yields.
    const preempting = { requested: () => true };
    let applied = 0;
    let result = upsertAutoDetectedRules(db, candidates, preempting);
    while (result.resume) {
      applied += 1;
      expect(result.resume.candidates.length).toBe(candidates.length - applied);
      result = upsertAutoDetectedRules(db, [], preempting, result.resume);
    }
    expect(applied, "the pass ran to completion without ever offering the writer back").toBe(3);
    // The same four merges as an uninterrupted pass, counted once.
    expect(result.inserted).toBe(4);
    const survivors = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM people").get()!.c;
    expect(survivors).toBe(4);
  });

  test("contact-name merge is confined to contact-curated rows carrying that canonical name", () => {
    // The detector only proposes a name merge when BOTH sides are
    // `source='contacts'` canonical rows (the address book is curated;
    // extracted display labels are not). The applicator must honor the
    // same scope: a physical merge DELETES the loser, so sweeping in an
    // unrelated human who merely carries the string as a name alias is
    // irreversible data loss.
    const contactA = randomUUID();
    const contactB = randomUUID();
    const stranger = randomUUID(); // different human, same display name, oldest row
    const bystander = randomUUID(); // different name; carries the string as a demoted alias
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
       VALUES (?, 'Maya Reeves', 'contacts',  '2026-02-01', '2026-02-01', '2026-02-01', '2026-02-01'),
              (?, 'maya reeves', 'contacts',  '2026-03-01', '2026-03-01', '2026-03-01', '2026-03-01'),
              (?, 'Maya Reeves', 'extracted', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
              (?, 'Jamie Lopez', 'extracted', '2026-01-15', '2026-01-15', '2026-01-15', '2026-01-15')`,
    ).run(contactA, contactB, stranger, bystander);
    const alias = db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, ?, ?, '2026-01-01')`,
    );
    alias.run(randomUUID(), contactA, "Maya Reeves", "name");
    alias.run(randomUUID(), contactA, "maya.card@example.com", "email");
    alias.run(randomUUID(), contactB, "Maya Reeves", "name");
    alias.run(randomUUID(), contactB, "+15550100111", "phone");
    alias.run(randomUUID(), stranger, "Maya Reeves", "name");
    alias.run(randomUUID(), stranger, "m.reeves@example.org", "email");
    alias.run(randomUUID(), bystander, "Jamie Lopez", "name");
    alias.run(randomUUID(), bystander, "Maya Reeves", "name");
    alias.run(randomUUID(), bystander, "jamie.lopez@example.org", "email");

    const docId = insertDoc({ mentions: [] });
    db.prepare(
      "INSERT INTO document_people (document_id, person_id, role, source_id) VALUES (?, ?, 'sender', 'test')",
    ).run(docId, stranger);

    runMergePass(db);

    const alive = (id: string): boolean =>
      Boolean(db.prepare<[string], { id: string }>("SELECT id FROM people WHERE id = ?").get(id));

    // The two contact cards still collapse — that is the intended merge.
    expect(alive(contactA)).toBe(true);
    expect(alive(contactB)).toBe(false);
    // Everyone outside the contact scope survives, aliases and edges intact.
    expect(alive(stranger)).toBe(true);
    expect(alive(bystander)).toBe(true);
    expect(
      db
        .prepare<
          [string],
          { person_id: string }
        >("SELECT person_id FROM person_aliases WHERE alias = 'm.reeves@example.org' AND alias_type = ?")
        .get("email")?.person_id,
    ).toBe(stranger);
    expect(
      db
        .prepare<
          [string],
          { person_id: string }
        >("SELECT person_id FROM document_people WHERE document_id = ?")
        .get(docId)?.person_id,
    ).toBe(stranger);
  });
});

// ─── Source delete + re-add survives rule ───────────────────────────

describe("dirty bump on new alias creation (regression)", () => {
  test("resolveDocumentPeople bumps merge_rules dirty so dormant rules wake up", () => {
    // Reproducer for the Drive QA finding: a rule references aliases
    // that don't yet exist (dormant). When a new doc arrives whose
    // mention creates one of those aliases, the rule should be
    // re-evaluated. Without the bump in resolveDocumentPeople, the
    // eval task only re-fires on rule changes / cascade deletes —
    // missing this trigger means the rule sits dormant indefinitely.
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    // Apply current state so last_evaluated catches up to dirty.
    applyAllRules();
    const before = readMergeRulesMeta(db);
    expect(before.dirtyVersion).toBe(before.lastEvaluatedVersion);

    // Now seed a doc whose mention creates the dormant alias.
    insertDoc({
      mentions: [{ role: "sender", emails: ["alice@x.com"] }],
    });

    // Dirty should now be > last_evaluated → the next eval tick will fire.
    const after = readMergeRulesMeta(db);
    expect(after.dirtyVersion).toBeGreaterThan(after.lastEvaluatedVersion);
  });

  test("the bumped eval correctly merges the newly-resolvable rule", () => {
    // End-to-end: create rule → side B exists → dormant. Add side A
    // person via doc ingest. Apply rules. Verify merge happened.
    findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "imessage:test", "2026-01-01");
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(computeMergeEquivalences(db).equivalences.length).toBe(0); // dormant

    // Now an alice doc arrives.
    insertDoc({
      mentions: [{ role: "sender", emails: ["alice@x.com"] }],
    });
    // applyAllRules() simulates the next eval tick.
    applyAllRules();

    const aliceId = personIdByEmail("alice@x.com");
    const phoneId = db
      .prepare<
        [],
        { person_id: string }
      >("SELECT person_id FROM person_aliases WHERE alias='+1' AND alias_type='phone'")
      .get()!.person_id;
    // One of them is canonical, the other merged_into it.
    const aliceCanonical = resolvePersonId(db, aliceId!);
    expect(resolvePersonId(db, phoneId)).toBe(aliceCanonical);
  });
});

function personIdByEmail(email: string): string | null {
  const row = db
    .prepare<
      [string],
      { person_id: string }
    >("SELECT person_id FROM person_aliases WHERE alias_type='email' AND alias=? LIMIT 1")
    .get(email);
  return row?.person_id ?? null;
}

describe("rule survives source delete + re-add", () => {
  test("user rule persists across source delete; re-applies on re-add", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@x.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(
      db,
      { role: "sender", phones: ["+1"] },
      "imessage:test",
      "2026-02-01",
    )!;
    insertDoc({
      sourceId: "gmail:test",
      mentions: [{ role: "sender", emails: ["alice@x.com"] }],
    });
    insertDoc({
      sourceId: "imessage:test",
      mentions: [{ role: "sender", phones: ["+1"] }],
    });

    const r = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    applyAllRules();
    expect(resolvePersonId(db, b)).toBe(a);

    // Delete gmail source — alice's email + person + docs go away.
    deleteAllBySource(db, "gmail:test");
    // Rule still exists.
    expect(listMergeRules(db, { active: true }).length).toBe(1);
    expect(listMergeRules(db, { active: true })[0].id).toBe(r.rule.id);

    // Re-add by re-inserting the same email.
    const a2 = findOrCreatePerson(
      db,
      { role: "sender", emails: ["alice@x.com"] },
      "gmail:test",
      "2026-03-01",
    )!;
    expect(a2).not.toBe(a); // new person id
    applyAllRules();
    // Now b is merged into the new alice (or vice versa, depending on first_seen).
    const root = resolvePersonId(db, a2);
    expect(resolvePersonId(db, b)).toBe(root);
  });
});

// ─── Yieldable upsert ───────────────────────────────────────────────

describe("upsertMergeEquivalences yieldable", () => {
  test("token request bails partway, doesn't advance watermark", () => {
    // 5 people, each carrying a unique email; chain rules
    // (e0↔e1)(e1↔e2)(e2↔e3)(e3↔e4) bridge them into one 5-person
    // equivalence component → 4 equivalence rows. (Same-alias
    // tautology rules used to drive this test, but the post-pivot
    // architecture replaces those with physical merges; the eval pass
    // now auto-deletes tautology rules as collapsed.)
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
         VALUES (?, ?, 'extracted', ?, ?, ?, ?)`,
      ).run(
        id,
        `P${i}`,
        `2026-01-0${i + 1}`,
        `2026-01-0${i + 1}`,
        `2026-01-0${i + 1}`,
        `2026-01-0${i + 1}`,
      );
      db.prepare(
        `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
         VALUES (?, ?, ?, 'email', '2026-01-01')`,
      ).run(randomUUID(), id, `e${i}@x.com`);
      ids.push(id);
    }
    for (let i = 0; i < 4; i++) {
      createMergeRule(db, {
        sideA: { aliasType: "email", alias: `e${i}@x.com` },
        sideB: { aliasType: "email", alias: `e${i + 1}@x.com` },
        winnerSide: "a",
        kind: "user",
      });
    }
    const snap = computeMergeEquivalences(db);
    expect(snap.equivalences.length).toBe(4); // 5-person component → 4 losers

    let polls = 0;
    const token = {
      requested: () => {
        polls += 1;
        return polls >= 1; // yield after first chunk
      },
    };
    const metaBefore = readMergeRulesMeta(db);
    const result = upsertMergeEquivalences(db, snap, { token, chunkSize: 2 });
    expect(result.added + result.changed + result.removed).toBeGreaterThan(0);
    // Watermark NOT advanced on partial.
    const metaAfter = readMergeRulesMeta(db);
    expect(metaAfter.lastEvaluatedVersion).toBe(metaBefore.lastEvaluatedVersion);
  });
});

// ─── Auto-delete collapsed rules ────────────────────────────────────

describe("collapsed rule auto-cleanup", () => {
  test("eval auto-deletes a rule whose two sides resolve to the same single person", () => {
    // Build one person with two emails (e.g. an email signature with
    // both addresses caused findOrCreatePerson to attach both aliases
    // to a single row). A rule bridging those two emails has nothing
    // to merge.
    const id = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com", "b@x.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const rule = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "email", alias: "b@x.com" },
      winnerSide: "a",
      kind: "user",
    });
    expect(listMergeRules(db, { active: true })).toHaveLength(1);

    const snap = computeMergeEquivalences(db);
    expect(snap.collapsedRuleIds).toContain(rule.rule.id);
    expect(snap.equivalences).toHaveLength(0);

    const result = upsertMergeEquivalences(db, snap);
    expect(result.deletedCollapsed).toBe(1);
    expect(listMergeRules(db, { active: true })).toHaveLength(0);
    // Person row untouched.
    expect(getPersonById(db, id)).toBeTruthy();
  });

  test("dormant rule (one side resolves to nothing) is NOT deleted as collapsed", () => {
    findOrCreatePerson(db, { role: "sender", emails: ["a@x.com"] }, "gmail:test", "2026-01-01")!;
    // Bridge a@x.com to a phone no one carries.
    const rule = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+99999999" },
      winnerSide: "a",
      kind: "user",
    });

    const snap = computeMergeEquivalences(db);
    expect(snap.collapsedRuleIds).toHaveLength(0);
    expect(snap.equivalences).toHaveLength(0); // dormant; nothing to merge

    const result = upsertMergeEquivalences(db, snap);
    expect(result.deletedCollapsed).toBe(0);
    expect(listMergeRules(db, { active: true })[0].id).toBe(rule.rule.id);
  });

  test("genuine cross-person rule still produces equivalences and is NOT deleted", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "gmail:test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(
      db,
      { role: "sender", phones: ["+447700000005"] },
      "gmail:test",
      "2026-02-01",
    )!;
    expect(a).not.toBe(b);
    const rule = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+447700000005" },
      winnerSide: "a",
      kind: "user",
    });

    const snap = computeMergeEquivalences(db);
    expect(snap.collapsedRuleIds).toHaveLength(0);
    expect(snap.equivalences.length).toBeGreaterThan(0);

    const result = upsertMergeEquivalences(db, snap);
    expect(result.deletedCollapsed).toBe(0);
    expect(result.added).toBe(1);
    expect(listMergeRules(db, { active: true })[0].id).toBe(rule.rule.id);
  });
});

// ─── mergePeople / unmergePerson primitives ─────────────────────────

describe("mergePeople / unmergePerson primitives", () => {
  test("mergePeople sets merged_into; unmergePerson clears it", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    const b = findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01")!;

    mergePeople(db, a, b);
    expect(resolvePersonId(db, b)).toBe(a);
    // Aliases stay on b (logical merge, no data movement).
    const bAliases = db
      .prepare<[string], { alias: string }>("SELECT alias FROM person_aliases WHERE person_id = ?")
      .all(b);
    expect(bAliases.some((r) => r.alias === "+1")).toBe(true);

    unmergePerson(db, b);
    expect(resolvePersonId(db, b)).toBe(b);
  });

  test("mergePeople is a no-op on identical winner/loser", () => {
    const a = findOrCreatePerson(
      db,
      { role: "sender", emails: ["a@x.com"] },
      "test",
      "2026-01-01",
    )!;
    expect(() => mergePeople(db, a, a)).not.toThrow();
    expect(resolvePersonId(db, a)).toBe(a);
  });
});

// ─── Dirty version contracts ────────────────────────────────────────

describe("merge_rules_meta dirty_version", () => {
  test("starts at 0 / -1 on a fresh DB", () => {
    const meta = readMergeRulesMeta(db);
    expect(meta.dirtyVersion).toBe(0);
    expect(meta.lastEvaluatedVersion).toBe(-1);
  });

  test("createMergeRule bumps dirty_version", () => {
    const before = readMergeRulesMeta(db).dirtyVersion;
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    expect(readMergeRulesMeta(db).dirtyVersion).toBeGreaterThan(before);
  });

  test("upsertMergeEquivalences advances last_evaluated_version on full pass", () => {
    findOrCreatePerson(db, { role: "sender", emails: ["a@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", phones: ["+1"] }, "test", "2026-02-01");
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    const dirty = readMergeRulesMeta(db).dirtyVersion;
    const snap = computeMergeEquivalences(db);
    upsertMergeEquivalences(db, snap);
    expect(readMergeRulesMeta(db).lastEvaluatedVersion).toBe(dirty);
  });

  test("a dirty bump landing AFTER compute snapshot still triggers next refresh", () => {
    findOrCreatePerson(db, { role: "sender", emails: ["a@x.com"] }, "test", "2026-01-01");
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "a@x.com" },
      sideB: { aliasType: "phone", alias: "+1" },
      winnerSide: "a",
    });
    const snap = computeMergeEquivalences(db);
    markMergeRulesDirty(db);
    upsertMergeEquivalences(db, snap);
    const meta = readMergeRulesMeta(db);
    expect(meta.dirtyVersion).toBeGreaterThan(meta.lastEvaluatedVersion);
  });
});
