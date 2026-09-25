// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the fuzzy merge-candidate detection system.
 *
 * Covers:
 *   - Tokenizers (name + email): folding, splitting, stop-words
 *   - IDF-weighted scorer: prefix-name match, cross-type, common
 *     names suppressed, substring fallback for unsplit emails
 *   - computeFuzzyMergeCandidates end-to-end on a synthetic graph
 *   - upsert: insert / refresh pending / skip decided
 *   - accept: creates merge_rule, idempotent re-accept returns
 *     existing rule
 *   - deny: durable veto; detector skips denied pairs on re-run
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createDatabase } from "./db.js";
import {
  tokenizeName,
  tokenizeEmail,
  tokenizeAlias,
  scoreTokenBags,
  computeFuzzyMergeCandidates,
  fetchMergeCandidatesData,
  upsertMergeCandidates,
  listMergeCandidates,
  listAllMergeCandidates,
  acceptMergeCandidate,
  applyMergeAdjudication,
  autoApproveHighConfidenceCandidates,
  denyMergeCandidate,
  getMergeCandidateById,
  countMergeCandidates,
  pruneSuppressedMergeCandidates,
  reconcilePendingMergeCandidates,
  upsertTokenLabels,
  loadTokenLabels,
  selectTokensNeedingClassification,
  mergeCluster,
  computeEnrichedMergeCandidates,
  currentEvidenceFingerprint,
  explainMergeCandidateVisibility,
  isAdjudicationDue,
  mergeCandidateEvidenceFingerprint,
  needsOperatorAdjudication,
  DEFAULT_SCORE_THRESHOLD,
  type IdfContext,
  type MergeCandidateProposal,
} from "./merge-candidates.js";
import {
  emailDomain,
  buildDomainSpread,
  shouldSuppressCandidate,
  findIdentityBridges,
  hasFirstNameConflict,
  hasInternalNameConflict,
  hasSurnameConflict,
  isGenericOrgPair,
  isHighConfidenceMerge,
  sharesExactStructuredName,
  isPersonEntity,
  sharesDistinctiveEmailHandle,
  distinctNameConcepts,
  distinctNameGroups,
  isHubPerson,
  nameMatchStrength,
  rankCandidateClusters,
  ROLE_TOKEN_MIN_SPREAD,
  type SuppressionContext,
  type TokenLabel,
} from "./domain/MergeCandidateDetector.js";
import {
  createMergeRule,
  deleteMergeRuleGroup,
  findOrCreatePerson,
  listMergeRules,
  resolveAliasSide,
} from "./people.js";
import { recomputeNamePrimaries } from "./data/repositories/PersonRepository.js";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-mc-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────

function makePerson(opts: {
  name?: string;
  emails?: string[];
  phones?: string[];
  lids?: string[];
  isSelf?: boolean;
  /** Extra non-primary name aliases — how a multi-person contact card looks. */
  extraNames?: string[];
}): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO people
       (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'test', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, opts.name ?? "Unknown", opts.isSelf ? 1 : 0);
  for (const email of opts.emails ?? []) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, ?, 'email', '2026-01-01')`,
    ).run(randomUUID(), id, email);
  }
  for (const phone of opts.phones ?? []) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, ?, 'phone', '2026-01-01')`,
    ).run(randomUUID(), id, phone);
  }
  for (const lid of opts.lids ?? []) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
       VALUES (?, ?, ?, 'lid', '2026-01-01')`,
    ).run(randomUUID(), id, lid);
  }
  if (opts.name) {
    // A single name is the person's primary (mirrors recomputeNamePrimaries on a
    // one-name person); detection filters name aliases to is_primary=1.
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at, occurrence_count, is_primary)
       VALUES (?, ?, ?, 'name', '2026-01-01', 1, 1)`,
    ).run(randomUUID(), id, opts.name);
  }
  for (const extra of opts.extraNames ?? []) {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at, occurrence_count, is_primary)
       VALUES (?, ?, ?, 'name', '2026-01-01', 1, 0)`,
    ).run(randomUUID(), id, extra);
  }
  return id;
}

function uniformIdf(tokens: string[], totalPeople = 100): IdfContext {
  const df = new Map<string, number>();
  for (const t of tokens) df.set(t, 1); // every token appears once → max IDF
  return { df, totalPeople };
}

// ─── Tokenizer ──────────────────────────────────────────────────────

describe("tokenizeName", () => {
  test("splits on whitespace and lowercases", () => {
    expect(tokenizeName("Maya Hadley")).toEqual(["maya", "hadley"]);
  });
  test("strips diacritics", () => {
    expect(tokenizeName("Sándor László")).toEqual(["sandor", "laszlo"]);
    expect(tokenizeName("Maëlle Brévaux")).toEqual(["maelle", "brevaux"]);
  });
  test("preserves single-char initials", () => {
    expect(tokenizeName("M. Brevaux")).toEqual(["m", "brevaux"]);
    expect(tokenizeName("A B Hadley")).toEqual(["a", "b", "hadley"]);
  });
  test("drops honorifics", () => {
    expect(tokenizeName("Mr. Jamie Hadley")).toEqual(["jamie", "hadley"]);
    expect(tokenizeName("Dr Smith")).toEqual(["smith"]);
  });
  test("handles empty / whitespace-only input", () => {
    expect(tokenizeName("")).toEqual([]);
    expect(tokenizeName("  ")).toEqual([]);
  });
  test("strips channel / provenance annotations", () => {
    expect(tokenizeName("Oscar VAN HOLT (Google Drive)")).toEqual(["oscar", "van", "holt"]);
    expect(tokenizeName("Elena Voss (via Google Sheets)")).toEqual(["elena", "voss"]);
    expect(tokenizeName("Owen Pike via RT")).toEqual(["owen", "pike"]);
    expect(tokenizeName("Clara Nolan on behalf of Stellar Accountants")).toEqual([
      "clara",
      "nolan",
    ]);
    expect(tokenizeName("Leo Marsh via Splitwise")).toEqual(["leo", "marsh"]);
  });
});

describe("tokenizeEmail", () => {
  test("splits local-part on . _ - +", () => {
    expect(tokenizeEmail("maya.hadley@gmail.com")).toEqual(["maya", "hadley"]);
    expect(tokenizeEmail("maya_hadley@gmail.com")).toEqual(["maya", "hadley"]);
    expect(tokenizeEmail("maya-hadley@gmail.com")).toEqual(["maya", "hadley"]);
    expect(tokenizeEmail("maya+work@gmail.com")).toEqual(["maya", "work"]);
  });
  test("strips digits", () => {
    expect(tokenizeEmail("maya.hadley92@gmail.com")).toEqual(["maya", "hadley"]);
    expect(tokenizeEmail("maya2024@gmail.com")).toEqual(["maya"]);
  });
  test("drops generic mailbox stop-words", () => {
    expect(tokenizeEmail("team.jamie@x.com")).toEqual(["jamie"]);
    expect(tokenizeEmail("noreply@x.com")).toEqual([]);
    expect(tokenizeEmail("info@x.com")).toEqual([]);
    // Inline-image / CID artifacts treated as stop-words.
    expect(tokenizeEmail("image001.png@cid.example.com")).toEqual([]);
  });
  test("drops single-char tokens (initials too noisy in emails)", () => {
    expect(tokenizeEmail("a.b.c@x.com")).toEqual([]);
  });
  test("drops emails with URL-encoding (% chars)", () => {
    expect(tokenizeEmail("%2f%2fwhatever@example.com")).toEqual([]);
  });
  test("drops single tokens >16 chars (random ID heuristic)", () => {
    // Long alpha string with no separators — gets dropped wholesale.
    expect(tokenizeEmail("axcpnwhonbpwepvoasct@x.com")).toEqual([]);
    // Short enough to keep.
    expect(tokenizeEmail("axcpnwhonbpw@x.com")).toEqual(["axcpnwhonbpw"]);
  });
  test("handles unsplit local-parts as single tokens", () => {
    expect(tokenizeEmail("hadleysarah@gmail.com")).toEqual(["hadleysarah"]);
  });
  test("ignores domain", () => {
    expect(tokenizeEmail("alice@hadley.fr")).toEqual(["alice"]);
  });
  test("strips diacritics in local-part too", () => {
    // RFC-wise rare but possible
    expect(tokenizeEmail("sándor@x.com")).toEqual(["sandor"]);
  });
});

describe("tokenizeAlias dispatch", () => {
  test("phone / lid produce no tokens", () => {
    expect(tokenizeAlias("phone", "+15551234567")).toEqual([]);
    expect(tokenizeAlias("lid", "265588060475643")).toEqual([]);
  });
  test("name + email use their respective tokenizers", () => {
    expect(tokenizeAlias("name", "Mike Smith")).toEqual(["mike", "smith"]);
    // Email tokenizer drops single-char tokens (initials in email
    // locals are rare and noisy); names keep initials.
    expect(tokenizeAlias("email", "m.smith@gmail.com")).toEqual(["smith"]);
    expect(tokenizeAlias("name", "M. Smith")).toEqual(["m", "smith"]);
  });
});

// ─── Scorer ─────────────────────────────────────────────────────────

describe("scoreTokenBags", () => {
  test("identical full-name match scores high", () => {
    const ctx = uniformIdf(["milo", "brevaux"], 1000);
    const res = scoreTokenBags(["milo", "brevaux"], ["milo", "brevaux"], ctx, {
      crossType: false,
    });
    expect(res.score).toBeGreaterThan(0.85);
    expect(res.matchedTokens).toEqual(["brevaux", "milo"]);
  });

  test("first-name only ↔ full name (containment) fires above threshold", () => {
    const ctx = uniformIdf(["maya", "hadley"], 200);
    const res = scoreTokenBags(["maya"], ["maya", "hadley"], ctx, { crossType: false });
    expect(res.score).toBeGreaterThan(DEFAULT_SCORE_THRESHOLD);
  });

  test("cross-type name ↔ email (period-split) scores high", () => {
    const ctx = uniformIdf(["milo", "brevaux"], 1000);
    const res = scoreTokenBags(["milo", "brevaux"], ["milo", "brevaux"], ctx, {
      crossType: true,
    });
    // Cross-type penalty applied — still passes threshold.
    expect(res.score).toBeGreaterThan(DEFAULT_SCORE_THRESHOLD);
  });

  test("cross-type via substring fallback (concatenated email)", () => {
    // "hadleysarah" is a single token; the scorer's substring
    // fallback should match "hadley" and "sarah" against it.
    const df = new Map<string, number>();
    df.set("hadleysarah", 1);
    df.set("sarah", 1);
    df.set("hadley", 1);
    const ctx: IdfContext = { df, totalPeople: 200 };
    const res = scoreTokenBags(["sarah", "hadley"], ["hadleysarah"], ctx, {
      crossType: true,
    });
    expect(res.score).toBeGreaterThan(DEFAULT_SCORE_THRESHOLD);
  });

  test("common-name only match (Pablo ↔ Pablo, both common) is suppressed", () => {
    // Common name: appears in many people → high df → low IDF.
    const df = new Map<string, number>();
    df.set("pablo", 80); // hyper-common in this corpus
    const ctx: IdfContext = { df, totalPeople: 100 };
    const res = scoreTokenBags(["pablo"], ["pablo"], ctx, { crossType: false });
    expect(res.score).toBeLessThan(DEFAULT_SCORE_THRESHOLD);
  });

  test("rare single-token shared by both sides — borderline / depends on multiplier", () => {
    // Even with a rare name, both-single-token gets the 0.7 multiplier.
    const ctx = uniformIdf(["zlatibor"], 500);
    const res = scoreTokenBags(["zlatibor"], ["zlatibor"], ctx, { crossType: false });
    // Should pass threshold for very rare names — single token but
    // unambiguous. Calibration target.
    expect(res.score).toBeGreaterThan(0.5);
  });

  test("no overlap → score 0", () => {
    const ctx = uniformIdf(["alice", "bob", "carol"], 100);
    const res = scoreTokenBags(["alice"], ["bob"], ctx, { crossType: false });
    expect(res.score).toBe(0);
    expect(res.matchedTokens).toEqual([]);
  });

  test("empty bags → score 0", () => {
    const ctx = uniformIdf([], 100);
    expect(scoreTokenBags([], ["alice"], ctx, { crossType: false }).score).toBe(0);
    expect(scoreTokenBags(["alice"], [], ctx, { crossType: false }).score).toBe(0);
  });

  test("initial-expansion: 'm' matches 'milo' when unambiguous", () => {
    const ctx = uniformIdf(["m", "brevaux", "milo"], 200);
    const res = scoreTokenBags(["m", "brevaux"], ["milo", "brevaux"], ctx, { crossType: false });
    expect(res.matchedTokens).toContain("brevaux");
    // Score should still pass threshold via the matching last name.
    expect(res.score).toBeGreaterThan(DEFAULT_SCORE_THRESHOLD);
  });

  test("matchedTokens are deduped + sorted", () => {
    const ctx = uniformIdf(["alice", "bob", "carol"], 100);
    const res = scoreTokenBags(["alice", "bob"], ["bob", "alice"], ctx, { crossType: false });
    expect(res.matchedTokens).toEqual(["alice", "bob"]);
  });
});

// ─── computeFuzzyMergeCandidates end-to-end ───────────────────────────────

describe("computeFuzzyMergeCandidates", () => {
  test("requires a full-name match: a shared first name alone is not proposed", () => {
    const firstOnly = makePerson({ name: "Maya" });
    const full1 = makePerson({ name: "Maya Hadley" });
    const full2 = makePerson({ name: "Maya Hadley", emails: ["maya.hadley@x.com"] });
    // Add some unrelated noise people so IDF isn't degenerate.
    for (let i = 0; i < 10; i++) {
      makePerson({ name: `Noise Person ${i}`, emails: [`noise${i}@x.com`] });
    }
    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    // Two "Maya Hadley" share two name concepts → proposed.
    expect(
      proposals.find(
        (p) => [p.personA, p.personB].includes(full1) && [p.personA, p.personB].includes(full2),
      ),
    ).toBeDefined();
    // "Maya" (first name only) shares a single concept with any Hadley → not proposed.
    expect(
      proposals.find((p) => p.personA === firstOnly || p.personB === firstOnly),
    ).toBeUndefined();
  });

  test("proposes Sarah Hadley ↔ hadleysarah@gmail.com (cross-type substring)", () => {
    makePerson({ name: "Sarah Hadley" });
    makePerson({ emails: ["hadleysarah@gmail.com"] });
    for (let i = 0; i < 20; i++) {
      makePerson({ name: `Noise ${i}`, emails: [`n${i}@x.com`] });
    }
    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    const found = proposals.find(
      (p) =>
        (p.sideA.alias.includes("hadleysarah") || p.sideB.alias.includes("hadleysarah")) &&
        (p.sideA.alias.toLowerCase().includes("sarah") ||
          p.sideB.alias.toLowerCase().includes("sarah") ||
          p.sideA.alias === "Sarah Hadley" ||
          p.sideB.alias === "Sarah Hadley"),
    );
    expect(found).toBeDefined();
    expect(found!.matchedTokens.sort()).toEqual(["hadley", "sarah"]);
  });

  test("does NOT propose merged people", () => {
    const a = makePerson({ name: "Maya" });
    const b = makePerson({ name: "Maya Hadley" });
    db.prepare("UPDATE people SET merged_into = ? WHERE id = ?").run(a, b);
    for (let i = 0; i < 10; i++) makePerson({ name: `Noise ${i}` });
    const proposals = computeFuzzyMergeCandidates(db);
    // b is merged into a → b shouldn't appear; a appears solo so no
    // pair to propose.
    expect(proposals.find((p) => p.personA === b || p.personB === b)).toBeUndefined();
  });

  test("does not fragment a recurring first name into a fake full-name match", () => {
    // Make 'anna' and 'leigh' exist as standalone tokens so a naive smart-split
    // would fragment 'annaleigh' -> 'anna'+'leigh' and treat two unrelated
    // Annaleighs as a 2-concept full-name match.
    makePerson({ emails: ["anna@durlston.example"] });
    makePerson({ name: "Leigh Brooks" });
    const harlow = makePerson({ emails: ["annaleigh.harlow@campus.example"] });
    const keaton = makePerson({ emails: ["annaleigh.keaton@campus.example"] });
    for (let i = 0; i < 20; i++) makePerson({ name: `Noise ${i}`, emails: [`n${i}@x.com`] });

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    // Two different Annaleighs (different surnames) share only the first name
    // "annaleigh" — must NOT be proposed as the same person.
    expect(
      proposals.find(
        (p) => [p.personA, p.personB].includes(harlow) && [p.personA, p.personB].includes(keaton),
      ),
    ).toBeUndefined();
  });

  test("hub bucket (multiple distinct names) is excluded and does not bridge", () => {
    // A shared queue carrying two different people's full names.
    const hub = makePerson({ name: "Owen Pike", emails: ["deadline@acu.example.org"] });
    db.prepare(
      "INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at) VALUES (?, ?, ?, 'name', '2026-01-01')",
    ).run(randomUUID(), hub, "Ravi Okafor");
    const owen = makePerson({ name: "Owen Pike", emails: ["owen.pike@x.com"] });
    const ravi = makePerson({ name: "Ravi Okafor", emails: ["ravi.okafor@y.com"] });
    for (let i = 0; i < 10; i++) makePerson({ name: `Noise ${i}`, emails: [`n${i}@x.com`] });

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    // The hub never appears in a proposal…
    expect(proposals.find((p) => p.personA === hub || p.personB === hub)).toBeUndefined();
    // …so it can't bridge Owen and Ravi (two different people) into one cluster.
    expect(
      proposals.find(
        (p) => [p.personA, p.personB].includes(owen) && [p.personA, p.personB].includes(ravi),
      ),
    ).toBeUndefined();
  });

  test("does NOT propose self person", () => {
    makePerson({ name: "Jamie", isSelf: true });
    makePerson({ name: "Jamie Hadley" });
    for (let i = 0; i < 10; i++) makePerson({ name: `Noise ${i}` });
    const proposals = computeFuzzyMergeCandidates(db);
    expect(proposals.length).toBe(0);
  });

  test("head-gate: skips pairs where neither side is in head", () => {
    // Two full-name-overlapping people (≥2 concepts so the name gate passes),
    // both with zero interaction.
    const a = makePerson({ name: "Maya Hadley" });
    const b = makePerson({ name: "Maya Hadley", emails: ["maya.hadley@x.com"] });
    // Plus a "head" person — high interaction score — to anchor the
    // distribution. Without it, p95 would be 0 and the gate would
    // pass everyone through (since 0 == 0 is below `s > 0` check).
    const head = makePerson({ name: "Head Contact", emails: ["head@x.com"] });
    db.prepare("UPDATE people SET interaction_score_recent = 1.0 WHERE id = ?").run(head);
    for (let i = 0; i < 20; i++) makePerson({ name: `Noise ${i}` });

    // With p95: head-only person scores high; Maya + Maya Hadley
    // both at 0 → gated out.
    const gated = computeFuzzyMergeCandidates(db, { headPercentile: 0.95 });
    const found = gated.find(
      (p) => [p.personA, p.personB].includes(a) && [p.personA, p.personB].includes(b),
    );
    expect(found).toBeUndefined();

    // With percentile=0 the gate is disabled — pair surfaces.
    const ungated = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    const foundUngated = ungated.find(
      (p) => [p.personA, p.personB].includes(a) && [p.personA, p.personB].includes(b),
    );
    expect(foundUngated).toBeDefined();
  });

  test("family-name gate: suppresses pairs that share only a high-df surname", () => {
    // Five "Smith" family members — none should pair with each
    // other on shared surname alone. Make all of them head so the
    // head-gate doesn't suppress them first.
    const family = ["Alice Smith", "Bob Smith", "Carol Smith", "David Smith", "Eve Smith"];
    const ids = family.map((name) => makePerson({ name }));
    for (const id of ids) {
      db.prepare("UPDATE people SET interaction_score_recent = 0.5 WHERE id = ?").run(id);
    }
    // Add some unrelated noise people.
    for (let i = 0; i < 30; i++) makePerson({ name: `Noise ${i}` });

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    // No pair of family members should be proposed (their only
    // shared token is "smith" which appears in 5 people).
    const familySet = new Set(ids);
    const familyPair = proposals.find((p) => familySet.has(p.personA) && familySet.has(p.personB));
    expect(familyPair).toBeUndefined();
  });

  test("smart-split: bobsmith@example.com matches Bob Smith as full-name pair", () => {
    // The person with the unsplit-local email should match
    // "Bob Smith" the contact via TWO matched tokens
    // (bob + smith), passing the family-name gate.
    const person = makePerson({ name: "Bob Smith" });
    const emailPerson = makePerson({ emails: ["bobsmith@example.com"] });
    db.prepare("UPDATE people SET interaction_score_recent = 0.5 WHERE id = ?").run(person);
    // Add other Smith family members so "smith" is high-df,
    // ensuring single-token "smith" matches alone wouldn't fire.
    for (const name of ["Alice Smith", "Carol Smith", "David Smith"]) {
      makePerson({ name });
    }
    for (let i = 0; i < 20; i++) makePerson({ name: `Noise ${i}` });

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    const found = proposals.find(
      (p) =>
        [p.personA, p.personB].includes(person) && [p.personA, p.personB].includes(emailPerson),
    );
    expect(found).toBeDefined();
    // Smart-split made the email contribute "bob" + "smith",
    // so both tokens match and the family-name gate doesn't fire.
    expect(found!.matchedTokens.sort()).toEqual(["bob", "smith"]);
  });

  test("head-gate: passes pairs where at least one side is head", () => {
    const a = makePerson({ name: "Maya Hadley" });
    const b = makePerson({ name: "Maya Hadley", emails: ["maya.hadley@x.com"] });
    // Mark `a` as head with non-zero score.
    db.prepare("UPDATE people SET interaction_score_recent = 0.5 WHERE id = ?").run(a);
    for (let i = 0; i < 20; i++) makePerson({ name: `Noise ${i}` });

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0.95 });
    const found = proposals.find(
      (p) => [p.personA, p.personB].includes(a) && [p.personA, p.personB].includes(b),
    );
    expect(found).toBeDefined();
  });

  test("skips already-denied pairs on re-detect", () => {
    makePerson({ name: "Maya" });
    makePerson({ name: "Maya Hadley" });
    for (let i = 0; i < 20; i++) makePerson({ name: `Noise ${i}` });
    const round1 = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    expect(round1.length).toBeGreaterThan(0);
    const upsert1 = upsertMergeCandidates(db, round1);
    expect(upsert1.inserted).toBeGreaterThan(0);

    // Deny the first pending one.
    const pending = listMergeCandidates(db, { status: "pending" });
    expect(pending.length).toBeGreaterThan(0);
    denyMergeCandidate(db, pending[0].id);

    // Re-run detection; the denied pair should not re-appear in the
    // upsert as inserted (it's filtered out at the compute step).
    const round2 = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    const denied = pending[0];
    const reAppeared = round2.find(
      (p) =>
        (p.sideA.aliasType === denied.sideA.aliasType &&
          p.sideA.alias === denied.sideA.alias &&
          p.sideB.aliasType === denied.sideB.aliasType &&
          p.sideB.alias === denied.sideB.alias) ||
        (p.sideA.aliasType === denied.sideB.aliasType &&
          p.sideA.alias === denied.sideB.alias &&
          p.sideB.aliasType === denied.sideA.aliasType &&
          p.sideB.alias === denied.sideA.alias),
    );
    expect(reAppeared).toBeUndefined();
  });
});

// ─── upsert / list / count ──────────────────────────────────────────

describe("upsertMergeCandidates", () => {
  test("insert then refresh updates score on existing pending", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "name", alias: "Maya" },
      sideB: { aliasType: "name", alias: "Maya Hadley" },
      score: 0.7,
      matchedTokens: ["maya"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    const r1 = upsertMergeCandidates(db, [proposal]);
    expect(r1.inserted).toBe(1);

    const r2 = upsertMergeCandidates(db, [{ ...proposal, score: 0.9 }]);
    expect(r2.refreshed).toBe(1);
    expect(r2.inserted).toBe(0);

    const candidates = listMergeCandidates(db, { status: "pending" });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].score).toBe(0.9);
  });

  test("sub-precision score drift restates the row without moving detected_at", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "name", alias: "Maya" },
      sideB: { aliasType: "name", alias: "Maya Hadley" },
      score: 0.9424916782930021,
      matchedTokens: ["maya", "hadley"],
      matchStrength: 1.4,
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    const before = listMergeCandidates(db, { status: "pending" })[0];

    // What a detector pass produces after unrelated people are ingested: the
    // IDF over the whole alias corpus shifts, this pair's evidence does not.
    const drifted = upsertMergeCandidates(db, [
      { ...proposal, score: 0.9424916782930044, matchStrength: 1.4000000000000004 },
    ]);
    expect(drifted.refreshed).toBe(0);
    expect(drifted.skipped).toBe(1);

    const after = listMergeCandidates(db, { status: "pending" })[0];
    expect(after.detectedAt).toBe(before.detectedAt);
    // Still restated, so rank and display track the latest computation.
    expect(after.score).toBe(0.9424916782930044);
  });

  test("a score change at display precision does move detected_at", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "name", alias: "Maya" },
      sideB: { aliasType: "name", alias: "Maya Hadley" },
      score: 0.7,
      matchedTokens: ["maya"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    const before = listMergeCandidates(db, { status: "pending" })[0];
    db.prepare("UPDATE merge_candidates SET detected_at = ? WHERE id = ?").run(
      "2020-01-01T00:00:00.000Z",
      before.id,
    );

    const changed = upsertMergeCandidates(db, [{ ...proposal, score: 0.85 }]);
    expect(changed.refreshed).toBe(1);

    const after = listMergeCandidates(db, { status: "pending" })[0];
    expect(after.detectedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  test("new matched tokens are a material change even at the same score", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "name", alias: "Maya" },
      sideB: { aliasType: "name", alias: "Maya Hadley" },
      score: 0.7,
      matchedTokens: ["maya"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    const r = upsertMergeCandidates(db, [{ ...proposal, matchedTokens: ["maya", "hadley"] }]);
    expect(r.refreshed).toBe(1);
  });

  test("skips proposals matching accepted/denied rows", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "name", alias: "Maya" },
      sideB: { aliasType: "name", alias: "Maya Hadley" },
      score: 0.8,
      matchedTokens: ["maya"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    const cand = listMergeCandidates(db, { status: "pending" })[0];
    denyMergeCandidate(db, cand.id);

    const r = upsertMergeCandidates(db, [proposal]);
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(1);
  });

  test("counts work across statuses", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "name", alias: "X" },
      sideB: { aliasType: "name", alias: "Y" },
      score: 0.9,
      matchedTokens: ["x"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    expect(countMergeCandidates(db, "pending")).toBe(1);
    expect(countMergeCandidates(db, "denied")).toBe(0);
    expect(countMergeCandidates(db)).toBe(1);
  });
});

// ─── accept ─────────────────────────────────────────────────────────

describe("acceptMergeCandidate", () => {
  test("creates a kind='user' merge_rule and flips status", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "email", alias: "alice@x.com" },
      sideB: { aliasType: "name", alias: "Alice" },
      score: 0.8,
      matchedTokens: ["alice"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    const cand = listMergeCandidates(db, { status: "pending" })[0];

    const result = acceptMergeCandidate(db, {
      candidateId: cand.id,
      winnerSide: "a",
    });
    expect(result.candidate.status).toBe("accepted");
    expect(result.candidate.ruleId).toBe(result.rule.id);
    expect(result.rule.kind).toBe("user");
    expect(result.ruleCreated).toBe(true);

    const rules = listMergeRules(db, { active: true });
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe(result.rule.id);
  });

  test("re-accepting an accepted candidate returns the existing rule", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "name", alias: "A" },
      sideB: { aliasType: "name", alias: "Alpha" },
      score: 0.8,
      matchedTokens: ["a"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    const cand = listMergeCandidates(db, { status: "pending" })[0];
    const r1 = acceptMergeCandidate(db, { candidateId: cand.id, winnerSide: "a" });
    const r2 = acceptMergeCandidate(db, { candidateId: cand.id, winnerSide: "a" });
    expect(r2.rule.id).toBe(r1.rule.id);
    expect(r2.ruleCreated).toBe(false);
  });

  test("accepts as no-op (alreadyMerged=true) when both aliases live on the same person", () => {
    // Mid-detection drift scenario: a candidate was proposed when the
    // two aliases were on different people, but by the time the user
    // clicks "Accept" they've been physically merged (or were on one
    // person from the start).
    findOrCreatePerson(
      db,
      { role: "sender", emails: ["x@y.com", "x@z.com"] },
      "gmail:test",
      "2026-01-01",
    );
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "email", alias: "x@y.com" },
      sideB: { aliasType: "email", alias: "x@z.com" },
      score: 0.99,
      matchedTokens: ["x"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    const cand = listMergeCandidates(db, { status: "pending" })[0];

    const result = acceptMergeCandidate(db, { candidateId: cand.id, winnerSide: "a" });
    expect(result.alreadyMerged).toBe(true);
    expect(result.rule).toBeNull();
    expect(result.ruleCreated).toBe(false);
    expect(result.candidate.status).toBe("accepted");
    expect(result.candidate.ruleId).toBeNull();
    // No rule was created.
    expect(listMergeRules(db, { active: true })).toHaveLength(0);
  });

  test("sweepCollapsedMergeCandidates auto-accepts stale pending rows where both sides resolve to one person", async () => {
    // Arrange: a person carries both aliases (drift case — could be
    // direct or post-physical-merge). A pending candidate proposes
    // merging those aliases.
    findOrCreatePerson(
      db,
      { role: "sender", emails: ["x@y.com", "x@z.com"] },
      "gmail:test",
      "2026-01-01",
    );
    upsertMergeCandidates(db, [
      {
        sideA: { aliasType: "email", alias: "x@y.com" },
        sideB: { aliasType: "email", alias: "x@z.com" },
        score: 0.99,
        matchedTokens: ["x"],
        detectionKind: "name_token_overlap",
        personA: "p-a",
        personB: "p-b",
      },
    ]);
    expect(listMergeCandidates(db, { status: "pending" })).toHaveLength(1);

    // Act: sweep
    const { sweepCollapsedMergeCandidates } = await import("./merge-candidates.js");
    const result = sweepCollapsedMergeCandidates(db);

    // Assert: candidate marked accepted with no rule
    expect(result.swept).toBe(1);
    expect(listMergeCandidates(db, { status: "pending" })).toHaveLength(0);
    const accepted = listMergeCandidates(db, { status: "accepted" });
    expect(accepted).toHaveLength(1);
    expect(accepted[0].ruleId).toBeNull();
  });

  test("accepts as no-op when the pair was already satisfied by a logical (rule-driven) merge", () => {
    // Aliases stay on the loser row under a logical merge, so a raw
    // row comparison would miss it and create a redundant rule — one
    // the eval never auto-deletes and that would keep the pair merged
    // after the original rules are undone.
    findOrCreatePerson(db, { role: "sender", emails: ["jamie@example.com"] }, "test", "2026-01-01");
    findOrCreatePerson(
      db,
      { role: "sender", emails: ["j.lopez@example.org"] },
      "test",
      "2026-02-01",
    );
    upsertMergeCandidates(db, [
      {
        sideA: { aliasType: "email", alias: "jamie@example.com" },
        sideB: { aliasType: "email", alias: "j.lopez@example.org" },
        score: 0.9,
        matchedTokens: ["jamie"],
        detectionKind: "name_token_overlap",
        personA: "p-a",
        personB: "p-b",
      },
    ]);
    const cand = listMergeCandidates(db, { status: "pending" })[0];

    const personIdFor = (alias: string): string =>
      db
        .prepare<
          [string],
          { person_id: string }
        >("SELECT person_id FROM person_aliases WHERE alias_type = 'email' AND alias = ?")
        .get(alias)!.person_id;
    db.prepare("UPDATE people SET merged_into = ? WHERE id = ?").run(
      personIdFor("jamie@example.com"),
      personIdFor("j.lopez@example.org"),
    );

    const result = acceptMergeCandidate(db, { candidateId: cand.id, winnerSide: "a" });
    expect(result.alreadyMerged).toBe(true);
    expect(result.rule).toBeNull();
    expect(result.ruleCreated).toBe(false);
    expect(result.candidate.status).toBe("accepted");
    expect(listMergeRules(db, { active: true })).toHaveLength(0);
  });

  test("sweepCollapsedMergeCandidates flips candidates satisfied by a logical (rule-driven) merge", async () => {
    // Two distinct people, one alias each, bridged by a pending
    // candidate. A rule-driven merge is logical: the eval sets
    // merged_into but the aliases stay on the loser row, so each side
    // still resolves to a different person ROW — only the canonicals
    // collapse. This is the cluster-merge path the portal polls on.
    findOrCreatePerson(db, { role: "sender", emails: ["maya@example.com"] }, "test", "2026-01-01");
    findOrCreatePerson(
      db,
      { role: "sender", emails: ["m.reeves@example.org"] },
      "test",
      "2026-02-01",
    );
    upsertMergeCandidates(db, [
      {
        sideA: { aliasType: "email", alias: "maya@example.com" },
        sideB: { aliasType: "email", alias: "m.reeves@example.org" },
        score: 0.9,
        matchedTokens: ["maya"],
        detectionKind: "name_token_overlap",
        personA: "p-a",
        personB: "p-b",
      },
    ]);

    const personIdFor = (alias: string): string =>
      db
        .prepare<
          [string],
          { person_id: string }
        >("SELECT person_id FROM person_aliases WHERE alias_type = 'email' AND alias = ?")
        .get(alias)!.person_id;
    const winner = personIdFor("maya@example.com");
    const loser = personIdFor("m.reeves@example.org");
    expect(winner).not.toBe(loser);
    db.prepare("UPDATE people SET merged_into = ? WHERE id = ?").run(winner, loser);

    const { sweepCollapsedMergeCandidates } = await import("./merge-candidates.js");
    expect(sweepCollapsedMergeCandidates(db).swept).toBe(1);
    expect(listMergeCandidates(db, { status: "pending" })).toHaveLength(0);
    const accepted = listMergeCandidates(db, { status: "accepted" });
    expect(accepted).toHaveLength(1);
    expect(accepted[0].ruleId).toBeNull();
  });

  test("sweepCollapsedMergeCandidates leaves genuinely-distinct pending candidates alone", async () => {
    findOrCreatePerson(db, { role: "sender", emails: ["alice@x.com"] }, "test", "2026-01-01");
    findOrCreatePerson(db, { role: "sender", phones: ["+447123"] }, "test", "2026-02-01");
    upsertMergeCandidates(db, [
      {
        sideA: { aliasType: "email", alias: "alice@x.com" },
        sideB: { aliasType: "phone", alias: "+447123" },
        score: 0.85,
        matchedTokens: ["alice"],
        detectionKind: "name_token_overlap",
        personA: "p-a",
        personB: "p-b",
      },
    ]);

    const { sweepCollapsedMergeCandidates } = await import("./merge-candidates.js");
    const result = sweepCollapsedMergeCandidates(db);

    expect(result.swept).toBe(0);
    expect(listMergeCandidates(db, { status: "pending" })).toHaveLength(1);
  });

  test("accepting a denied candidate throws", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "name", alias: "X" },
      sideB: { aliasType: "name", alias: "Y" },
      score: 0.8,
      matchedTokens: ["x"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    const cand = listMergeCandidates(db, { status: "pending" })[0];
    denyMergeCandidate(db, cand.id);
    expect(() => acceptMergeCandidate(db, { candidateId: cand.id, winnerSide: "a" })).toThrow(
      /denied/,
    );
  });
});

// ─── deny ───────────────────────────────────────────────────────────

describe("denyMergeCandidate", () => {
  test("flips status; idempotent", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "name", alias: "X" },
      sideB: { aliasType: "name", alias: "Y" },
      score: 0.8,
      matchedTokens: ["x"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    const cand = listMergeCandidates(db, { status: "pending" })[0];
    const r1 = denyMergeCandidate(db, cand.id);
    expect(r1.status).toBe("denied");
    expect(r1.decidedAt).not.toBeNull();
    const r2 = denyMergeCandidate(db, cand.id);
    expect(r2.status).toBe("denied");
    expect(r2.decidedAt).toBe(r1.decidedAt); // not re-stamped
  });

  test("denying an accepted candidate throws", () => {
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "name", alias: "X" },
      sideB: { aliasType: "name", alias: "Y" },
      score: 0.8,
      matchedTokens: ["x"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    upsertMergeCandidates(db, [proposal]);
    const cand = listMergeCandidates(db, { status: "pending" })[0];
    acceptMergeCandidate(db, { candidateId: cand.id, winnerSide: "a" });
    expect(() => denyMergeCandidate(db, cand.id)).toThrow(/accepted/);
  });
});

// ─── Role-mailbox suppression: pure predicate ────────────────────────

describe("emailDomain", () => {
  test("returns lowercased domain", () => {
    expect(emailDomain("Reservation@Harborbistro.example")).toBe("harborbistro.example");
  });
  test("uses the last @ for malformed double-@ strings", () => {
    expect(emailDomain("frame@pixvault.example@pixvault.example")).toBe("pixvault.example");
  });
  test("empty when no @", () => {
    expect(emailDomain("notanemail")).toBe("");
  });
});

describe("buildDomainSpread", () => {
  test("counts distinct domains per email-local token; ignores non-email", () => {
    const spread = buildDomainSpread([
      { alias_type: "email", alias: "reservations@a.com" },
      { alias_type: "email", alias: "reservations@b.com" },
      { alias_type: "email", alias: "reservations@a.com" }, // dup domain
      { alias_type: "email", alias: "maya.hadley@a.com" },
      { alias_type: "name", alias: "Reservations Desk" }, // not an email → ignored
    ]);
    expect(spread.get("reservations")).toBe(2);
    expect(spread.get("hadley")).toBe(1);
    expect(spread.get("desk")).toBeUndefined();
  });
});

describe("shouldSuppressCandidate", () => {
  const email = (alias: string) => ({ aliasType: "email" as const, alias });
  function ctx(over: Partial<SuppressionContext> = {}): SuppressionContext {
    return {
      domainSpread: new Map(),
      tokenLabels: new Map(),
      blockedEmails: new Set(),
      ...over,
    };
  }
  const roleCtx = (labels: Record<string, TokenLabel>, spread: Record<string, number>) =>
    ctx({
      domainSpread: new Map(Object.entries(spread)),
      tokenLabels: new Map(Object.entries(labels) as [string, TokenLabel][]),
    });

  test("suppresses cross-domain role↔role (the reservations class)", () => {
    expect(
      shouldSuppressCandidate(
        email("reservation@harborbistro.example"),
        email("reservations@swiftcar.example"),
        ["reservation", "reservations"],
        roleCtx(
          { reservation: "role_generic", reservations: "role_generic" },
          { reservation: 8, reservations: 28 },
        ),
      ),
    ).toBe(true);
  });

  test("suppresses ambiguous+role across domains (ne-pas-repondre)", () => {
    expect(
      shouldSuppressCandidate(
        email("ne-pas-repondre@a.fr"),
        email("ne-pas-repondre@b.fr"),
        ["ne", "pas", "repondre"],
        roleCtx(
          { ne: "ambiguous", pas: "ambiguous", repondre: "role_generic" },
          { ne: 18, pas: 17, repondre: 16 },
        ),
      ),
    ).toBe(true);
  });

  test("never suppresses when a matched token is a personal_name (hadley veto)", () => {
    expect(
      shouldSuppressCandidate(
        email("jp.hadley@example.fr"),
        email("jphadley@gmail.com"),
        ["hadley", "theo", "owen"],
        roleCtx(
          { hadley: "personal_name", theo: "personal_name", owen: "role_generic" },
          { hadley: 27, theo: 12, owen: 9 },
        ),
      ),
    ).toBe(false);
  });

  test("does not suppress same-domain pairs", () => {
    expect(
      shouldSuppressCandidate(
        email("reservation@acme.com"),
        email("reservations@acme.com"),
        ["reservation", "reservations"],
        roleCtx(
          { reservation: "role_generic", reservations: "role_generic" },
          { reservation: 8, reservations: 28 },
        ),
      ),
    ).toBe(false);
  });

  test("a low-spread (discriminative) matched token protects the pair", () => {
    // "kessler" is rare → below floor → protects even though paired with a role word.
    expect(
      shouldSuppressCandidate(
        email("a.kessler@x.fr"),
        email("reservations.kessler@y.fr"),
        ["kessler", "reservations"],
        roleCtx({ reservations: "role_generic" }, { kessler: 2, reservations: 28 }),
      ),
    ).toBe(false);
  });

  test("holds off on a high-spread but unlabeled token", () => {
    expect(
      shouldSuppressCandidate(
        email("reservation@a.com"),
        email("reservations@b.com"),
        ["reservation", "reservations"],
        roleCtx({ reservation: "role_generic" }, { reservation: 8, reservations: 28 }),
      ),
    ).toBe(false); // "reservations" high-spread but no label yet
  });

  test("ambiguous-only (no role evidence) does not suppress", () => {
    expect(
      shouldSuppressCandidate(
        email("ne-pas@a.fr"),
        email("ne-pas@b.fr"),
        ["ne", "pas"],
        roleCtx({ ne: "ambiguous", pas: "ambiguous" }, { ne: 18, pas: 17 }),
      ),
    ).toBe(false);
  });

  test("blocklisted email on either side suppresses regardless", () => {
    const c = ctx({ blockedEmails: new Set(["invitations@linkedin.com"]) });
    expect(
      shouldSuppressCandidate(
        email("invitations@linkedin.com"),
        email("someone@example.com"),
        [],
        c,
      ),
    ).toBe(true);
  });

  test("statically non-identifying email suppresses even when not in the table", () => {
    // Empty blocklist table — caught only by the static isNonIdentifyingEmail
    // heuristic (the firehose addresses demotion deletes but never records).
    expect(
      shouldSuppressCandidate(
        email("invitations@linkedin.com"),
        email("marco.voss@example.com"),
        ["voss"],
        ctx(),
      ),
    ).toBe(true);
    expect(
      shouldSuppressCandidate(
        email("hit-reply@linkedin.com"),
        email("rafe.quillon@example.com"),
        ["quillon"],
        ctx(),
      ),
    ).toBe(true);
  });

  test("does not apply the role rule to name↔email cross-type matches", () => {
    expect(
      shouldSuppressCandidate(
        { aliasType: "name", alias: "Reservations" },
        email("reservations@swiftcar.example"),
        ["reservations"],
        roleCtx({ reservations: "role_generic" }, { reservations: 28 }),
      ),
    ).toBe(false);
  });

  test("dictionary role words suppress without spread/label (fused customerservice)", () => {
    // `customerservice` is a fused handle: low per-token spread and no label, so
    // the classifier path can't catch it — the ROLE_WORDS dictionary does.
    expect(
      shouldSuppressCandidate(
        email("customerservice@northstar.example"),
        email("customerservice@brightmarket.example"),
        ["customerservice"],
        ctx(),
      ),
    ).toBe(true);
  });

  test("dictionary role words suppress name-derived service/client glue", () => {
    expect(
      shouldSuppressCandidate(
        email("serviceclient@acme.example"),
        email("serviceclient@brightmarket.example"),
        ["client", "service"],
        ctx(),
      ),
    ).toBe(true);
  });

  test("a real surname is not a role word, so it still protects the pair", () => {
    // `reeves` is rare/discriminative (no spread, not a dictionary role word)
    // → the pair is NOT suppressed even though it's cross-domain email↔email.
    expect(
      shouldSuppressCandidate(
        email("maya.reeves@acme.example"),
        email("reeves@brightmarket.example"),
        ["reeves"],
        ctx(),
      ),
    ).toBe(false);
  });
});

describe("hasFirstNameConflict", () => {
  const name = (alias: string) => ({ aliasType: "name", alias });
  const email = (alias: string) => ({ aliasType: "email", alias });

  test("same surname, different given names → conflict (different people)", () => {
    expect(hasFirstNameConflict([name("Alex Reeves")], [name("Jamie Reeves")], ["reeves"])).toBe(
      true,
    );
  });

  test("conflict via given.surname email locals (no clean name alias)", () => {
    expect(
      hasFirstNameConflict(
        [email("alex.reeves@acme.example")],
        [email("jamie.reeves@northstar.example")],
        ["reeves"],
      ),
    ).toBe(true);
  });

  test("same person across handles → no conflict (givens agree)", () => {
    expect(
      hasFirstNameConflict(
        [name("Maya Reeves"), email("maya.reeves@acme.example")],
        [email("mayareeves99@northstar.example")],
        ["reeves"],
      ),
    ).toBe(false);
  });

  test("bare initials never drive a conflict (jp = Jean-Paul → review, not veto)", () => {
    expect(
      hasFirstNameConflict(
        [email("jp.reeves@acme.example")],
        [name("Jean-Paul Reeves")],
        ["reeves"],
      ),
    ).toBe(false);
  });

  test("role-word handles are not given names → same org never conflicts", () => {
    // "Queries"/"Website" are role words, not personal names; the shared token is
    // an org name. No structured given on either side → no conflict.
    expect(
      hasFirstNameConflict(
        [name("Northstar Tools"), email("queries@northstar.example")],
        [name("Northstar"), email("website@northstar.example")],
        ["northstar"],
      ),
    ).toBe(false);
  });

  test("no shared surname → no conflict", () => {
    expect(hasFirstNameConflict([name("Alex Reeves")], [name("Jamie Lopez")], [])).toBe(false);
  });

  test("conflict requires a full given on BOTH sides", () => {
    // One side has only an org name (no given) → not a person conflict.
    expect(
      hasFirstNameConflict([name("Alex Reeves")], [email("reeves@northstar.example")], ["reeves"]),
    ).toBe(false);
  });
});

describe("hasSurnameConflict", () => {
  const name = (alias: string) => ({ aliasType: "name", alias });
  const email = (alias: string) => ({ aliasType: "email", alias });

  test("shared compound given, different surnames → conflict (namesakes)", () => {
    expect(
      hasSurnameConflict(
        [name("Jean-Marc Roussel")],
        [name("Jean-Marc Varenne")],
        ["jean", "marc"],
      ),
    ).toBe(true);
  });

  test("conflict via given.surname email locals", () => {
    expect(
      hasSurnameConflict(
        [email("jean-marc.roussel@example.com")],
        [email("jean-marc.varenne@example.org")],
        ["jean", "marc"],
      ),
    ).toBe(true);
  });

  test("same person across handles → no conflict (surname is shared/matched)", () => {
    expect(
      hasSurnameConflict(
        [name("Jean-Marc Roussel")],
        [name("Jean-Marc Roussel")],
        ["jean", "marc", "roussel"],
      ),
    ).toBe(false);
  });

  test("a single shared given token is not enough — needs a compound given", () => {
    expect(hasSurnameConflict([name("John David")], [name("John Varenne")], ["john"])).toBe(false);
  });

  test("a surname-less side goes to review, not veto", () => {
    expect(
      hasSurnameConflict([name("Jean-Marc Roussel")], [name("Jean-Marc")], ["jean", "marc"]),
    ).toBe(false);
  });

  test("a compound / married-name variant is not a conflict", () => {
    expect(
      hasSurnameConflict([name("Maya Reeves")], [name("Maya Reeves Quinn")], ["maya", "reeves"]),
    ).toBe(false);
  });

  test("handles the formal SURNAME-first name order", () => {
    // "QUINN Jean-Marc" puts the surname first — the conflict must still fire.
    expect(
      hasSurnameConflict([name("Jean-Marc Reeves")], [name("QUINN Jean-Marc")], ["jean", "marc"]),
    ).toBe(true);
  });

  test("recognizes a fused compound given in an email local", () => {
    // "jeanmarc.roussel@…" fuses the given into one token; the surname (roussel)
    // must still be found and conflict with the other side's surname.
    expect(
      hasSurnameConflict(
        [email("jeanmarc.roussel@example.com")],
        [email("jean-marc.varenne@example.org")],
        ["jean", "marc"],
      ),
    ).toBe(true);
  });
});

describe("surname-conflict gate end-to-end", () => {
  test("compound-given namesakes are not proposed; the same person is", () => {
    // Two different Jean-Marcs (different surnames) must NOT merge.
    const roussel = makePerson({
      name: "Jean-Marc Roussel",
      emails: ["jean-marc.roussel@example.com"],
    });
    const varenne = makePerson({
      name: "Jean-Marc Varenne",
      emails: ["jeanmarc.varenne@example.org"],
    });
    // The same person across two addresses (same surname) → still proposed.
    makePerson({ name: "Jean-Marc Mercier", emails: ["jean-marc.mercier@example.com"] });
    makePerson({ name: "Jean-Marc Mercier", emails: ["jeanmarcmercier@example.org"] });
    for (let i = 0; i < 100; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    // The same-surname pair survives.
    expect(proposals.some((p) => p.matchedTokens.includes("mercier"))).toBe(true);
    // Neither namesake appears in any proposal.
    expect(proposals.some((p) => p.personA === roussel || p.personB === roussel)).toBe(false);
    expect(proposals.some((p) => p.personA === varenne || p.personB === varenne)).toBe(false);
  });
});

describe("resolveAliasSide name lookup (case-insensitive)", () => {
  test("resolves a name-type side regardless of the query's case", () => {
    const id = makePerson({ name: "Maya Reeves", emails: ["maya.reeves@example.com"] });
    // The stored name alias is mixed-case; the lookup must still find it.
    expect(
      resolveAliasSide(db, { aliasType: "name", alias: "Maya Reeves" }).map((p) => p.id),
    ).toEqual([id]);
    expect(
      resolveAliasSide(db, { aliasType: "name", alias: "MAYA REEVES" }).map((p) => p.id),
    ).toEqual([id]);
  });
});

describe("findIdentityBridges", () => {
  test("flags a node matching neighbours on disjoint token sets", () => {
    const edges = [
      { a: "B", b: "U", matchedTokens: ["maya", "reeves"] },
      { a: "B", b: "V", matchedTokens: ["quinn", "bond"] },
    ];
    expect([...findIdentityBridges(edges)]).toEqual(["B"]);
  });

  test("does not flag a node whose edges share a token (a real person's alternates)", () => {
    const edges = [
      { a: "P", b: "alt1", matchedTokens: ["maya", "reeves"] },
      { a: "P", b: "alt2", matchedTokens: ["maya", "reeves"] },
    ];
    expect(findIdentityBridges(edges).size).toBe(0);
  });

  test("a spanning edge keeps the token groups connected (not a bridge)", () => {
    // P matches x on {maya}, z on {reeves}, but y spans both → one group.
    const edges = [
      { a: "P", b: "x", matchedTokens: ["maya"] },
      { a: "P", b: "y", matchedTokens: ["maya", "reeves"] },
      { a: "P", b: "z", matchedTokens: ["reeves"] },
    ];
    expect(findIdentityBridges(edges).size).toBe(0);
  });

  test("a node with a single incident edge is never a bridge", () => {
    expect(findIdentityBridges([{ a: "P", b: "q", matchedTokens: ["maya", "reeves"] }]).size).toBe(
      0,
    );
  });

  test("only the bridge node is flagged, not its neighbours", () => {
    const edges = [
      { a: "B", b: "U", matchedTokens: ["alpha", "beta"] },
      { a: "B", b: "V", matchedTokens: ["gamma", "delta"] },
    ];
    const bridges = findIdentityBridges(edges);
    expect(bridges.has("B")).toBe(true);
    expect(bridges.has("U")).toBe(false);
    expect(bridges.has("V")).toBe(false);
  });
});

describe("identity-bridge gate end-to-end", () => {
  test("a bridge record's edges are dropped, leaving the two clusters separate", () => {
    // Two unrelated 2-email clusters, plus one bridge record that matches the
    // first on {maya,reeves} and the second on {quinn,bond} (disjoint).
    makePerson({ name: "Maya Reeves", emails: ["maya.reeves@u1.example"] });
    makePerson({ name: "Maya Reeves", emails: ["mayareeves@u2.example"] });
    makePerson({ name: "Quinn Bond", emails: ["quinn.bond@v1.example"] });
    makePerson({ name: "Quinn Bond", emails: ["quinnbond@v2.example"] });
    // The bridge: name supplies maya+quinn, email supplies reeves+bond.
    makePerson({ name: "Maya Quinn", emails: ["reeves.bond@bridge.example"] });
    for (let i = 0; i < 100; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    const tokensOf = (p: MergeCandidateProposal) => new Set(p.matchedTokens);
    // The two real clusters survive (each cluster's two emails still pair up).
    expect(proposals.some((p) => tokensOf(p).has("reeves"))).toBe(true);
    expect(proposals.some((p) => tokensOf(p).has("bond"))).toBe(true);
    // No surviving proposal mixes the two clusters' tokens — the bridge is gone.
    expect(proposals.some((p) => tokensOf(p).has("reeves") && tokensOf(p).has("bond"))).toBe(false);
    expect(proposals.some((p) => tokensOf(p).has("quinn") && tokensOf(p).has("maya"))).toBe(false);
  });
});

describe("isPersonEntity", () => {
  test("a structured given-plus-surname name is a person", () => {
    expect(isPersonEntity([{ aliasType: "name", alias: "Maya Reeves" }])).toBe(true);
  });

  test("a role-mailbox display name is not a person", () => {
    expect(isPersonEntity([{ aliasType: "name", alias: "Customer Service" }])).toBe(false);
  });

  test("email-only (no structured name) is not a person", () => {
    expect(
      isPersonEntity([{ aliasType: "email", alias: "customerservice@northstar.example" }]),
    ).toBe(false);
  });

  test("a single-token name is not enough", () => {
    expect(isPersonEntity([{ aliasType: "name", alias: "Northstar" }])).toBe(false);
  });

  test("a descriptively-named organisation is not a person", () => {
    expect(isPersonEntity([{ aliasType: "name", alias: "Central Group North" }])).toBe(false);
    expect(isPersonEntity([{ aliasType: "name", alias: "Hotel Riverside" }])).toBe(false);
  });
});

describe("isGenericOrgPair", () => {
  const email = (alias: string) => ({ aliasType: "email", alias });
  const never = () => false;
  const common = (set: Set<string>) => (t: string) => set.has(t);

  test("org↔org cross-domain on only generic words → generic (suppress)", () => {
    expect(
      isGenericOrgPair(
        email("x1@northcentral.example"),
        email("x2@southcentral.example"),
        ["central", "group"],
        false,
        false,
        never,
      ),
    ).toBe(true);
  });

  test("a distinctive brand token protects the pair", () => {
    expect(
      isGenericOrgPair(
        email("contact@brightmarket.example"),
        email("hello@brightmarket-mail.example"),
        ["brightmarket", "group"],
        false,
        false,
        never,
      ),
    ).toBe(false);
  });

  test("a high-frequency (common) place token counts as generic", () => {
    // "rive" is in the generic set; the place token is supplied as common.
    expect(
      isGenericOrgPair(
        email("x@hotels-a.example"),
        email("x@agency-b.example"),
        ["riverside", "rive"],
        false,
        false,
        common(new Set(["riverside"])),
      ),
    ).toBe(true);
  });

  test("never fires when either side is a person", () => {
    expect(
      isGenericOrgPair(email("a@x.example"), email("b@y.example"), ["group"], true, false, never),
    ).toBe(false);
  });

  test("same domain is not suppressed", () => {
    expect(
      isGenericOrgPair(
        email("x1@acme.example"),
        email("x2@acme.example"),
        ["central", "group"],
        false,
        false,
        never,
      ),
    ).toBe(false);
  });

  test("a name-type side is out of scope (email↔email only)", () => {
    expect(
      isGenericOrgPair(
        { aliasType: "name", alias: "Central Group" },
        email("x@b.example"),
        ["central", "group"],
        false,
        false,
        never,
      ),
    ).toBe(false);
  });
});

describe("generic-org gate end-to-end", () => {
  test("an all-generic org pair is not proposed; a distinctive brand is", () => {
    // Two same-named generic orgs on different domains — no distinctive brand.
    makePerson({ name: "Central Group", emails: ["x1@central-a.example"] });
    makePerson({ name: "Central Group", emails: ["x2@central-b.example"] });
    // A real same-brand pair (distinctive tokens) → still proposed.
    makePerson({ name: "Stellar Sound", emails: ["x3@stellarsound.example"] });
    makePerson({ name: "Stellar Sound", emails: ["x4@stellar-sound-mail.example"] });
    for (let i = 0; i < 100; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    expect(
      proposals.some(
        (p) => p.matchedTokens.includes("central") && p.matchedTokens.includes("group"),
      ),
    ).toBe(false);
    expect(
      proposals.some(
        (p) => p.matchedTokens.includes("stellar") && p.matchedTokens.includes("sound"),
      ),
    ).toBe(true);
  });
});

// ─── Role-mailbox suppression: end-to-end + prune ────────────────────

describe("role-mailbox suppression end-to-end", () => {
  function seedToken(token: string, domains: string[]) {
    for (const d of domains) makePerson({ emails: [`${token}@${d}`] });
  }
  const domsSingular = [
    "a1.com",
    "a2.com",
    "a3.com",
    "a4.com",
    "a5.com",
    "a6.com",
    "a7.com",
    "harborbistro.example",
  ];
  const domsPlural = [
    "b1.com",
    "b2.com",
    "b3.com",
    "b4.com",
    "b5.com",
    "b6.com",
    "b7.com",
    "swiftcar.example",
  ];
  const hasRole = (p: MergeCandidateProposal) =>
    p.matchedTokens.includes("reservations") || p.matchedTokens.includes("enquiries");

  test("labels flip role-mailbox pairs from proposed to suppressed; real names survive", () => {
    // Distinct orgs whose locals share TWO generic role words — the shape
    // that clears the single-token family-name gate and reaches suppression.
    const orgDomains = [
      "harborbistro.example",
      "swiftcar.example",
      "o3.com",
      "o4.com",
      "o5.com",
      "o6.com",
      "o7.com",
      "o8.com",
    ];
    for (const d of orgDomains) makePerson({ emails: [`reservations.enquiries@${d}`] });
    // A genuine cross-domain person match on a rare surname.
    makePerson({ emails: ["maya.hadley@personx.com"] });
    makePerson({ emails: ["maya.hadley@persony.com"] });
    // Filler people with unique tokens so the role words stay rare relative
    // to the corpus (high IDF), as they are in the real 50k-person graph —
    // otherwise a tiny corpus makes them look common and the scorer's
    // attenuator drops them below threshold before suppression is even tested.
    for (let i = 0; i < 100; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });

    // Baseline (no labels): role-mailbox pairs ARE proposed.
    const before = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    expect(before.some(hasRole)).toBe(true);

    // Classify the role words; re-run.
    upsertTokenLabels(db, [
      { token: "reservations", label: "role_generic", domainSpread: 8 },
      { token: "enquiries", label: "role_generic", domainSpread: 8 },
    ]);
    const after = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    expect(after.some(hasRole)).toBe(false);
    // The real surname match is untouched, and the detector tags it with a
    // strong match strength (two distinct name concepts → > 1).
    const hadleyPair = after.find(
      (p) => p.matchedTokens.includes("hadley") && p.matchedTokens.includes("maya"),
    );
    expect(hadleyPair).toBeDefined();
    expect(hadleyPair!.matchStrength ?? 0).toBeGreaterThan(1);
  });

  test("matchStrength persists through upsert and lists back", () => {
    makePerson({ emails: ["p1@example.com"] });
    makePerson({ emails: ["p2@example.com"] });
    const proposal: MergeCandidateProposal = {
      sideA: { aliasType: "email", alias: "p1@example.com" },
      sideB: { aliasType: "email", alias: "p2@example.com" },
      score: 0.9,
      matchedTokens: ["chris", "christophe"],
      matchStrength: 0.15,
      detectionKind: "name_token_overlap",
      personA: "p-1",
      personB: "p-2",
    };
    upsertMergeCandidates(db, [proposal]);
    const row = listMergeCandidates(db, { status: "pending" }).find((c) =>
      c.matchedTokens.includes("chris"),
    );
    expect(row?.matchStrength).toBeCloseTo(0.15);
  });

  test("pruneSuppressedMergeCandidates removes pending role rows, keeps names and denied", () => {
    seedToken("reservation", domsSingular);
    seedToken("reservations", domsPlural);
    // Seed the name-pair people so their sides resolve (isolating the
    // suppression decision from the vanished-side prune).
    makePerson({ emails: ["maya.hadley@personx.com"], name: "Maya Hadley" });
    makePerson({ emails: ["maya.hadley@persony.com"], name: "Maya Hadley" });
    upsertTokenLabels(db, [
      { token: "reservation", label: "role_generic", domainSpread: 8 },
      { token: "reservations", label: "role_generic", domainSpread: 8 },
    ]);

    const rolePair: MergeCandidateProposal = {
      sideA: { aliasType: "email", alias: "reservation@harborbistro.example" },
      sideB: { aliasType: "email", alias: "reservations@swiftcar.example" },
      score: 0.95,
      matchedTokens: ["reservation", "reservations"],
      detectionKind: "name_token_overlap",
      personA: "p-a",
      personB: "p-b",
    };
    const namePair: MergeCandidateProposal = {
      sideA: { aliasType: "email", alias: "maya.hadley@personx.com" },
      sideB: { aliasType: "email", alias: "maya.hadley@persony.com" },
      score: 0.98,
      matchedTokens: ["maya", "hadley"],
      detectionKind: "name_token_overlap",
      personA: "p-c",
      personB: "p-d",
    };
    upsertMergeCandidates(db, [rolePair, namePair]);
    expect(countMergeCandidates(db, "pending")).toBe(2);

    const { pruned } = pruneSuppressedMergeCandidates(db);
    expect(pruned).toBe(1);
    const remaining = listMergeCandidates(db, { status: "pending" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].matchedTokens).toContain("hadley");
  });

  test("prune removes candidates with a vanished side and firehose-named sides", () => {
    // One real person; the other side references an address carried by nobody
    // (its bucket was deleted) — a "dormant" candidate that can't be actioned.
    makePerson({ emails: ["marco.voss@example.com"], name: "Marco Voss" });
    const dormant: MergeCandidateProposal = {
      sideA: { aliasType: "email", alias: "invitations@linkedin.com" }, // resolves to no person
      sideB: { aliasType: "email", alias: "marco.voss@example.com" },
      score: 1.0,
      matchedTokens: ["voss"],
      detectionKind: "name_token_overlap",
      personA: "p-x",
      personB: "p-y",
    };
    upsertMergeCandidates(db, [dormant]);
    expect(countMergeCandidates(db, "pending")).toBe(1);
    const { pruned } = pruneSuppressedMergeCandidates(db);
    expect(pruned).toBe(1);
    expect(countMergeCandidates(db, "pending")).toBe(0);
  });
});

describe("distinctNameConcepts", () => {
  test("collapses prefix-variant tokens into one concept", () => {
    expect(distinctNameConcepts(["chris", "christophe"])).toEqual(["christophe"]);
    expect(distinctNameConcepts(["chris", "christopher"])).toEqual(["christopher"]);
    expect(distinctNameConcepts(["c", "christophe"])).toEqual(["christophe"]);
    // christophe IS a prefix of christopher → one concept (the variant pair
    // the operator flagged).
    expect(distinctNameConcepts(["christophe", "christopher"])).toEqual(["christopher"]);
  });
  test("keeps independent name tokens distinct", () => {
    expect(distinctNameConcepts(["maya", "hadley"]).sort()).toEqual(["hadley", "maya"]);
  });
  test("an initial is NOT collapsed into a longer token it merely substrings", () => {
    // "m" is a mid-substring of "smith" but not a prefix → first-initial +
    // surname stays two concepts (a real full-name match).
    expect(distinctNameConcepts(["m", "smith"]).sort()).toEqual(["m", "smith"]);
  });
  test("an <initials><surname> email handle collapses into the surname concept", () => {
    // `ahadley@…` is the surname concept (Hadley with the initial "a"), not a
    // second one. So a relative whose handle is `ahadley` and another who only
    // shares the surname `hadley` overlap on ONE concept — below the merge gate.
    expect(distinctNameConcepts(["ahadley", "hadley"])).toEqual(["ahadley"]);
    expect(distinctNameConcepts(["jpdupont", "dupont"])).toEqual(["jpdupont"]);
    // But a first name + that surname handle stays two concepts (a full match):
    // `maya` neither prefixes nor is an initials-suffix of `ahadley`.
    expect(distinctNameConcepts(["maya", "ahadley"]).sort()).toEqual(["ahadley", "maya"]);
  });
  test("does not collapse a surname-suffixed token across more than two initials", () => {
    // `norahadley` is NOT `hadley` with ≤2 initials (the lead is "nora"),
    // so the family surname stays a separate concept from the full handle —
    // `norahadley`/`nora` collapse instead (prefix), leaving nora + hadley.
    expect(distinctNameConcepts(["norahadley", "hadley", "nora"]).sort()).toEqual([
      "hadley",
      "norahadley",
    ]);
  });
});

describe("isHubPerson / distinctNameGroups", () => {
  test("a bucket carrying multiple distinct people's names is a hub", () => {
    const names = [
      "Owen Pike via RT",
      "Ravi Okafor via RT",
      "pierre_c via RT",
      "Felix Reyes via RT",
    ];
    expect(distinctNameGroups(names)).toBeGreaterThanOrEqual(2);
    expect(isHubPerson(names)).toBe(true);
  });
  test("one real person's aliases (variants, initials, reorders, provenance) are NOT a hub", () => {
    expect(isHubPerson(["Elena Voss", "Ele", "voss elena"])).toBe(false);
    expect(isHubPerson(["Elena Voss", "Elena Voss (via Google Docs)"])).toBe(false);
    expect(isHubPerson(["Jamie Hadley", "Jamie", "J. Hadley"])).toBe(false);
  });
  test("a bucket with different family members (shared surname) is a hub", () => {
    // The bridge that wrongly merged the whole Hadley family: one bucket
    // carrying two relatives' full names. They share only the surname, so each
    // is a distinct person.
    expect(isHubPerson(["Maya Hadley", "David Hadley"])).toBe(true);
    expect(isHubPerson(["David Hadley", "Sarah Hadley"])).toBe(true);
  });
  test("a channel bucket templating multiple people's names is a hub", () => {
    // "Air France for JAMIE HADLEY" + "… for ELENA VOSS": shared channel
    // prefix, different people.
    expect(isHubPerson(["Air France for JAMIE HADLEY", "Air France for ELENA VOSS"])).toBe(true);
  });
  test("a single name is never a hub", () => {
    expect(isHubPerson(["Owen Pike via RT"])).toBe(false);
  });
});

describe("nameMatchStrength (rank multiplier)", () => {
  // isCommon predicate: a token is "common" iff carried by many people. In
  // these tests we just enumerate the common ones explicitly.
  const commonIs =
    (...common: string[]) =>
    (t: string) =>
      common.includes(t);

  test("single common given name sinks to the bottom (still > 0)", () => {
    const common = commonIs("chris", "christophe", "christopher");
    const weak = nameMatchStrength(["chris", "christophe"], common);
    expect(weak).toBeCloseTo(0.15);
    // Christopher Hale ↔ Christopher Winters: one shared common given name.
    expect(nameMatchStrength(["chris", "christopher"], common)).toBeCloseTo(0.15);
  });

  test("first + last (two concepts) ranks strong, above a single given name", () => {
    const strong = nameMatchStrength(["maya", "hadley"], commonIs("maya")); // hadley rare
    expect(strong).toBeGreaterThan(1);
    expect(strong).toBeGreaterThan(
      nameMatchStrength(["chris", "christophe"], commonIs("chris", "christophe")),
    );
  });

  test("a single RARE shared token (surname) still ranks strong", () => {
    const strong = nameMatchStrength(["ferraro"], commonIs()); // nobody common → rare
    expect(strong).toBeGreaterThan(1);
  });

  test("colleague match on a shared firm token is not demoted", () => {
    // anna + stellar + nolan — multiple concepts → strong, left for the
    // operator to accept/deny.
    const s = nameMatchStrength(["anna", "stellar", "nolan"], commonIs("anna"));
    expect(s).toBeGreaterThan(1);
  });
});

describe("reconcilePendingMergeCandidates", () => {
  const proposal = (aliasA, aliasB, tokens) => ({
    sideA: { aliasType: "email" as const, alias: aliasA },
    sideB: { aliasType: "email" as const, alias: aliasB },
    score: 0.95,
    matchedTokens: tokens,
    detectionKind: "name_token_overlap",
    personA: "p-a",
    personB: "p-b",
  });

  test("deletes pending rows no longer proposed, keeps still-proposed + denied", () => {
    const stillProposed = proposal("a@x.com", "a@y.com", ["maya", "reeves"]);
    const stale = proposal("b@x.com", "b@y.com", ["jamie", "lopez"]);
    const toDeny = proposal("c@x.com", "c@y.com", ["david", "lin"]);
    upsertMergeCandidates(db, [stillProposed, stale, toDeny]);
    // Deny one — must survive reconcile (durable veto).
    const denyRow = listMergeCandidates(db, { status: "pending" }).find((r) =>
      r.matchedTokens.includes("david"),
    )!;
    denyMergeCandidate(db, denyRow.id);
    expect(countMergeCandidates(db, "pending")).toBe(2);

    // New detection output contains only `stillProposed`.
    const { deleted } = reconcilePendingMergeCandidates(db, [stillProposed]);
    expect(deleted).toBe(1); // `stale` dropped
    const pending = listMergeCandidates(db, { status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].matchedTokens).toContain("maya");
    expect(countMergeCandidates(db, "denied")).toBe(1); // deny untouched
  });
});

describe("mergeCluster", () => {
  test("creates N-1 user rules unifying the people", () => {
    const p1 = makePerson({ emails: ["a@example.com"], name: "Maya Reeves" });
    const p2 = makePerson({ emails: ["b@example.org"], name: "Maya Reeves" });
    const p3 = makePerson({ emails: ["c@example.io"], name: "Maya Reeves" });
    const res = mergeCluster(db, [p1, p2, p3]);
    expect(res.rulesCreated).toBe(2);
    const rules = listMergeRules(db, { active: true, kind: "user" });
    expect(rules.length).toBe(2);
    // Star topology: one anchor alias is present in every rule (createMergeRule
    // canonicalizes which side it lands on), so all members union together.
    const aliasSets = rules.map(
      (r) =>
        new Set([`${r.sideA.aliasType}:${r.sideA.alias}`, `${r.sideB.aliasType}:${r.sideB.alias}`]),
    );
    const common = [...aliasSets[0]].filter((a) => aliasSets.every((s) => s.has(a)));
    expect(common.length).toBe(1);
  });

  test("no-ops with fewer than two people", () => {
    const p1 = makePerson({ emails: ["solo@example.com"] });
    expect(mergeCluster(db, [p1]).rulesCreated).toBe(0);
    expect(mergeCluster(db, []).rulesCreated).toBe(0);
  });

  test("dedupes repeated person ids", () => {
    const p1 = makePerson({ emails: ["x@example.com"], name: "Jamie Lopez" });
    const p2 = makePerson({ emails: ["y@example.com"], name: "Jamie Lopez" });
    expect(mergeCluster(db, [p1, p1, p2, p2]).rulesCreated).toBe(1);
  });
});

describe("mergeCluster anchor selection", () => {
  function setMeta(
    id: string,
    meta: { isSelf?: boolean; interaction?: number; firstSeen?: string },
  ): void {
    db.prepare(
      "UPDATE people SET is_self = ?, interaction_score_recent = ?, first_seen = ? WHERE id = ?",
    ).run(meta.isSelf ? 1 : 0, meta.interaction ?? 0, meta.firstSeen ?? "2026-01-01", id);
  }

  test("anchors on the self person even when another carries more aliases", () => {
    const self = makePerson({ emails: ["me@example.com"], name: "Maya Reeves", isSelf: true });
    const rich = makePerson({
      emails: ["maya@work.example", "maya2@work.example"],
      phones: ["+15550100142"],
      name: "Maya Reeves",
    });
    // Self survives in the eval regardless of votes, so it must be the anchor.
    expect(mergeCluster(db, [rich, self]).anchorId).toBe(self);
  });

  test("absent a self, anchors on the highest-interaction member, not the alias-richest", () => {
    const rich = makePerson({
      emails: ["a@example.com", "a2@example.org"],
      phones: ["+15550100001"],
      name: "Jamie Lopez",
    });
    const active = makePerson({ emails: ["b@example.com"], name: "Jamie Lopez" });
    setMeta(rich, { interaction: 0.1 });
    setMeta(active, { interaction: 0.9 });
    expect(mergeCluster(db, [rich, active]).anchorId).toBe(active);
  });

  test("ties on interaction fall through to the earliest first_seen", () => {
    const older = makePerson({ emails: ["old@example.com"], name: "David Lin" });
    const newer = makePerson({ emails: ["new@example.com"], name: "David Lin" });
    setMeta(older, { firstSeen: "2018-01-01" });
    setMeta(newer, { firstSeen: "2024-01-01" });
    expect(mergeCluster(db, [newer, older]).anchorId).toBe(older);
  });

  test("alias count does not drive the anchor (stable as a member gains aliases)", () => {
    // The old anchor was the alias-richest member, which drifts as sources sync.
    // The deterministic ordering ignores alias count: the longest-standing record
    // anchors even though the other has more aliases.
    const old = makePerson({ emails: ["old@example.com"], name: "Sarah Mendez" });
    const aliasRich = makePerson({
      emails: ["r1@example.com", "r2@example.org", "r3@example.io"],
      phones: ["+15550100188"],
      name: "Sarah Mendez",
    });
    setMeta(old, { firstSeen: "2018-01-01" });
    setMeta(aliasRich, { firstSeen: "2023-01-01" });
    expect(mergeCluster(db, [aliasRich, old]).anchorId).toBe(old);
  });
});

describe("mergeCluster group_id", () => {
  test("stamps one shared group_id on every rule of the batch", () => {
    const p1 = makePerson({ emails: ["a@example.com"], name: "Maya Reeves" });
    const p2 = makePerson({ emails: ["b@example.com"], name: "Maya Reeves" });
    const p3 = makePerson({ emails: ["c@example.com"], name: "Maya Reeves" });
    const res = mergeCluster(db, [p1, p2, p3]);
    expect(res.groupId).toBeTruthy();
    const rules = listMergeRules(db, { active: true, kind: "user" });
    expect(rules.length).toBe(2);
    expect(rules.every((r) => r.groupId === res.groupId)).toBe(true);
  });

  test("a single-pair createMergeRule leaves group_id null", () => {
    const res = createMergeRule(db, {
      sideA: { aliasType: "email", alias: "x@example.com" },
      sideB: { aliasType: "email", alias: "y@example.com" },
      winnerSide: "a",
      kind: "user",
    });
    expect(res.rule.groupId).toBeNull();
  });
});

describe("deleteMergeRuleGroup", () => {
  test("deletes exactly the batch and leaves unrelated rules intact", () => {
    const p1 = makePerson({ emails: ["a@example.com"], name: "Maya Reeves" });
    const p2 = makePerson({ emails: ["b@example.com"], name: "Maya Reeves" });
    const p3 = makePerson({ emails: ["c@example.com"], name: "Maya Reeves" });
    const res = mergeCluster(db, [p1, p2, p3]); // 2 rules, one group
    // An unrelated standalone rule (no group).
    createMergeRule(db, {
      sideA: { aliasType: "email", alias: "solo1@example.com" },
      sideB: { aliasType: "email", alias: "solo2@example.com" },
      winnerSide: "a",
      kind: "user",
    });
    expect(listMergeRules(db, { active: true }).length).toBe(3);

    expect(deleteMergeRuleGroup(db, res.groupId!)).toBe(2);
    const remaining = listMergeRules(db, { active: true });
    expect(remaining.length).toBe(1);
    expect(remaining[0].groupId).toBeNull();
  });

  test("returns 0 for an unknown group id", () => {
    expect(deleteMergeRuleGroup(db, "no-such-group")).toBe(0);
  });
});

describe("first-name-conflict gate end-to-end", () => {
  const hasToken = (t: string) => (p: MergeCandidateProposal) => p.matchedTokens.includes(t);

  test("vetoes a shared-surname / different-given pair but keeps a same-person pair", () => {
    // Two DIFFERENT people sharing a two-token family name "van reeves" (passes
    // the ≥2-concept gate, so without the first-name veto this WOULD be proposed).
    makePerson({ name: "Alex Van Reeves", emails: ["alex.vanreeves@northstar.example"] });
    makePerson({ name: "Jamie Van Reeves", emails: ["jamie.vanreeves@brightmarket.example"] });
    // Positive control: the SAME person across two addresses (givens agree) with
    // an equally compound name — must still be proposed. This isolates the veto:
    // the only difference from the pair above is given-name agreement.
    makePerson({ name: "Maya Quinn Lopez", emails: ["maya.quinnlopez@northstar.example"] });
    makePerson({ name: "Maya Quinn Lopez", emails: ["maya.quinnlopez@brightmarket.example"] });
    // Filler so the shared tokens stay rare (high IDF), as in the real graph.
    for (let i = 0; i < 100; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    // Conflicting givens (alex vs jamie) on a shared surname → vetoed.
    expect(proposals.some(hasToken("reeves"))).toBe(false);
    // Agreeing givens (maya == maya) on the same structure → survives.
    expect(proposals.some((p) => hasToken("quinn")(p) || hasToken("lopez")(p))).toBe(true);
  });
});

describe("invalid-TLD email gate end-to-end", () => {
  test("an invalid-TLD email is ignored by the detector (no junk candidate)", () => {
    // Two valid records for one person DO match; a junk record whose only signal
    // is the name fused into an invalid-TLD email never enters the candidate graph.
    makePerson({ name: "Nora Bond", emails: ["nora.bond@example.com"] });
    makePerson({ name: "Nora Bond", emails: ["norabond@example.org"] });
    const junk = makePerson({ emails: ["norabond@example.com.vous"] });
    for (let i = 0; i < 100; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    // The two valid Nora Bond records match.
    expect(proposals.some((p) => p.matchedTokens.includes("bond"))).toBe(true);
    // The invalid-TLD record appears in no proposal.
    expect(proposals.some((p) => p.personA === junk || p.personB === junk)).toBe(false);
  });
});

describe("rankCandidateClusters", () => {
  const idsOf = (ranked: { id: string }[]) => ranked.map((r) => r.id);

  test("propagates the cluster's max interaction to every member and groups them", () => {
    // Cluster {A,B,C} via c1(A-B), c2(B-C); A has high interaction. Cluster
    // {D,E} via c3, all low. ABC should outrank DE and stay contiguous.
    const cands = [
      { id: "c1", personIds: ["A", "B"], score: 1.0, matchStrength: 1 },
      { id: "c2", personIds: ["B", "C"], score: 0.8, matchStrength: 1 },
      { id: "c3", personIds: ["D", "E"], score: 1.0, matchStrength: 1 },
    ];
    const interaction: Record<string, number> = { A: 0.5, B: 0, C: 0, D: 0.001, E: 0 };
    const ranked = rankCandidateClusters(cands, (id) => interaction[id] ?? 0);

    expect(idsOf(ranked)).toEqual(["c1", "c2", "c3"]);
    // Every ABC member inherits A's 0.5 interaction.
    expect(ranked.find((r) => r.id === "c2")!.clusterInteraction).toBeCloseTo(0.5);
    expect(ranked.find((r) => r.id === "c1")!.clusterId).toBe(
      ranked.find((r) => r.id === "c2")!.clusterId,
    );
    expect(ranked.find((r) => r.id === "c3")!.clusterId).not.toBe(
      ranked.find((r) => r.id === "c1")!.clusterId,
    );
  });

  test("keeps a cluster contiguous even when a strong outside pair sits between", () => {
    // Cluster {A,B,C}: c1 strong (A interaction high), c2 weak. A standalone
    // cluster {D,E} c3 with mid interaction would rank between c1 and c2 if
    // ranked per-pair — but clustering keeps c1 and c2 together.
    const cands = [
      { id: "c1", personIds: ["A", "B"], score: 1.0, matchStrength: 1 },
      { id: "c2", personIds: ["B", "C"], score: 0.3, matchStrength: 1 },
      { id: "c3", personIds: ["D", "E"], score: 1.0, matchStrength: 1 },
    ];
    const interaction: Record<string, number> = { A: 0.5, D: 0.2 };
    const ranked = rankCandidateClusters(cands, (id) => interaction[id] ?? 0);
    // ABC (max 0.5) outranks DE (0.2); c1 and c2 are adjacent, c3 after.
    expect(idsOf(ranked)).toEqual(["c1", "c2", "c3"]);
  });

  test("a side-less candidate forms its own singleton cluster", () => {
    const cands = [
      { id: "c1", personIds: ["A", "B"], score: 1.0, matchStrength: 1 },
      { id: "orphan", personIds: [], score: 1.0, matchStrength: 1 },
    ];
    const ranked = rankCandidateClusters(cands, () => 0);
    const a = ranked.find((r) => r.id === "c1")!;
    const o = ranked.find((r) => r.id === "orphan")!;
    expect(o.clusterId).not.toBe(a.clusterId);
  });

  test("person↔person outranks org↔org at equal score/interaction", () => {
    // Two clusters, identical score and interaction. With the isPersonOf signal,
    // the all-person candidate must rank above the org-only one.
    const cands = [
      { id: "org", personIds: ["O1", "O2"], score: 1.0, matchStrength: 1 },
      { id: "ppl", personIds: ["P1", "P2"], score: 1.0, matchStrength: 1 },
    ];
    const persons = new Set(["P1", "P2"]);
    const ranked = rankCandidateClusters(
      cands,
      () => 0.1,
      (id) => persons.has(id),
    );
    expect(idsOf(ranked)).toEqual(["ppl", "org"]);
    expect(ranked.find((r) => r.id === "ppl")!.rankScore).toBeGreaterThan(
      ranked.find((r) => r.id === "org")!.rankScore,
    );
  });

  test("without an isPersonOf predicate, ranking is unchanged (backward compatible)", () => {
    const cands = [
      { id: "c1", personIds: ["A", "B"], score: 1.0, matchStrength: 1 },
      { id: "c2", personIds: ["C", "D"], score: 0.5, matchStrength: 1 },
    ];
    const ranked = rankCandidateClusters(cands, () => 0.1);
    expect(idsOf(ranked)).toEqual(["c1", "c2"]);
  });
});

describe("selectTokensNeedingClassification", () => {
  test("returns unlabeled high-spread tokens, excludes labeled ones", () => {
    for (const d of ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com", "h.com"]) {
      makePerson({ emails: [`reservations@${d}`] });
    }
    const before = selectTokensNeedingClassification(db, { minSpread: ROLE_TOKEN_MIN_SPREAD });
    expect(before.find((c) => c.token === "reservations")?.domainSpread).toBe(8);

    upsertTokenLabels(db, [{ token: "reservations", label: "role_generic", domainSpread: 8 }]);
    const after = selectTokensNeedingClassification(db, { minSpread: ROLE_TOKEN_MIN_SPREAD });
    expect(after.find((c) => c.token === "reservations")).toBeUndefined();
    expect(loadTokenLabels(db).get("reservations")).toBe("role_generic");
  });
});

describe("sharesDistinctiveEmailHandle", () => {
  const e = (alias: string) => ({ aliasType: "email", alias });

  test("same distinctive local across domains → true", () => {
    expect(
      sharesDistinctiveEmailHandle(
        [e("mayareeves@example.com")],
        [e("mayareeves@northstar.example")],
      ),
    ).toBe(true);
  });

  test("same local, same domain → false (exact dup, not a cross-domain signal)", () => {
    expect(
      sharesDistinctiveEmailHandle([e("mayareeves@example.com")], [e("mayareeves@example.com")]),
    ).toBe(false);
  });

  test("a short or role-word local does not count", () => {
    expect(sharesDistinctiveEmailHandle([e("info@a.example")], [e("info@b.example")])).toBe(false);
    expect(sharesDistinctiveEmailHandle([e("ab@a.example")], [e("ab@b.example")])).toBe(false);
  });

  test("different locals → false", () => {
    expect(sharesDistinctiveEmailHandle([e("mayareeves@a.example")], [e("jlopez@b.example")])).toBe(
      false,
    );
  });

  test("same handle modulo separators across domains → true (work↔personal)", () => {
    // given.surname at school/work vs the dotless personal variant.
    expect(
      sharesDistinctiveEmailHandle(
        [e("maya.reeves@school.example")],
        [e("mayareeves@gmail.example")],
      ),
    ).toBe(true);
    // mixed underscores / hyphens normalize to the same handle.
    expect(
      sharesDistinctiveEmailHandle([e("maya_reeves@a.example")], [e("maya-reeves@b.example")]),
    ).toBe(true);
  });

  test("separator normalization still requires DIFFERENT domains", () => {
    expect(
      sharesDistinctiveEmailHandle([e("maya.reeves@a.example")], [e("mayareeves@a.example")]),
    ).toBe(false);
  });

  test("a separated role word is still excluded after normalization", () => {
    expect(sharesDistinctiveEmailHandle([e("no.reply@a.example")], [e("noreply@b.example")])).toBe(
      false,
    );
  });

  test("genuinely different handle forms stay unmatched (left for review)", () => {
    // not the same handle even after stripping separators — ambiguous, must NOT auto-merge.
    expect(
      sharesDistinctiveEmailHandle([e("rjones@a.example")], [e("jonesrebecca@b.example")]),
    ).toBe(false);
  });
});

describe("sharesExactStructuredName", () => {
  const nm = (...names: string[]) => names.map((n) => ({ aliasType: "name", alias: n }));

  test("same name modulo case / accents matches", () => {
    expect(sharesExactStructuredName(nm("Renée Vance"), nm("Renee Vance"))).toBe(true);
    expect(sharesExactStructuredName(nm("Maya Reeves"), nm("maya reeves"))).toBe(true);
  });

  test("token order and provenance suffixes don't matter", () => {
    expect(sharesExactStructuredName(nm("Reeves, Maya"), nm("Maya Reeves"))).toBe(true);
    expect(sharesExactStructuredName(nm("Maya Reeves"), nm("Maya Reeves (Google+)"))).toBe(true);
  });

  test("a genuine subset with an extra distinctive word does NOT match", () => {
    expect(sharesExactStructuredName(nm("Maya Reeves"), nm("Maya Reeves Foundation"))).toBe(false);
  });

  test("placeholders, single-token, and all-generic names never match", () => {
    expect(sharesExactStructuredName(nm("No Name"), nm("No Name"))).toBe(false);
    expect(sharesExactStructuredName(nm("Unknown"), nm("Unknown"))).toBe(false);
    expect(sharesExactStructuredName(nm("Maya"), nm("Maya"))).toBe(false);
    expect(sharesExactStructuredName(nm("Customer Service"), nm("Customer Service"))).toBe(false);
  });

  test("different names don't match", () => {
    expect(sharesExactStructuredName(nm("Maya Reeves"), nm("Maya Lopez"))).toBe(false);
  });
});

describe("isHighConfidenceMerge", () => {
  const nm = (...names: string[]) => names.map((n) => ({ aliasType: "name", alias: n }));
  const em = (...emails: string[]) => emails.map((e) => ({ aliasType: "email", alias: e }));

  test("distinctive name ↔ email-only handle (person, no org domain) → true", () => {
    // One side is a named person; the other an email-only record whose handle is
    // the same distinctive name. The surname is not an org domain brand → merge.
    expect(
      isHighConfidenceMerge({
        aliasesA: [...nm("Maya Reeves"), ...em("maya@gmail.example")],
        aliasesB: em("maya.reeves@school.example"),
        score: 1,
        matchStrength: 1.7,
        isPersonA: true,
        isPersonB: false,
      }),
    ).toBe(true);
  });

  test("two email-only records with the same distinctive name (different handle forms) → true", () => {
    // Neither side has a display name; the handles encode the same distinctive
    // given.surname in different forms across domains — still one person.
    expect(
      isHighConfidenceMerge({
        aliasesA: em("maya.reeves@school.example"),
        aliasesB: em("reevesmaya@personal.example"),
        score: 1,
        matchStrength: 1.7,
        isPersonA: false,
        isPersonB: false,
      }),
    ).toBe(true);
  });

  test("org named after its domain is NOT merged via the email-only path", () => {
    // "Northwind Health" ↔ northwindhealth@partner.example — the name appears in
    // the org's own domain (northwindhealth.example), so it's a brand, not a person.
    expect(
      isHighConfidenceMerge({
        aliasesA: [...nm("Northwind Health"), ...em("billing@northwindhealth.example")],
        aliasesB: em("northwindhealth@partner.example"),
        score: 1,
        matchStrength: 1.7,
        isPersonA: true,
        isPersonB: false,
      }),
    ).toBe(false);
  });

  test("email-only-handle path still requires a distinctive (high-matchStrength) match", () => {
    expect(
      isHighConfidenceMerge({
        aliasesA: [...nm("Maya Reeves"), ...em("maya@gmail.example")],
        aliasesB: em("maya.reeves@school.example"),
        score: 1,
        matchStrength: 1.4, // common surname → not distinctive → stays for review
        isPersonA: true,
        isPersonB: false,
      }),
    ).toBe(false);
  });

  test("an exact structured-name match is high confidence even at low matchStrength", () => {
    expect(
      isHighConfidenceMerge({
        aliasesA: nm("Renée Vance"),
        aliasesB: nm("Renee Vance"),
        score: 0.9,
        matchStrength: 1.4,
        isPersonA: true,
        isPersonB: true,
      }),
    ).toBe(true);
  });

  test("distinctive full-name match (both persons, high matchStrength) → true", () => {
    expect(
      isHighConfidenceMerge({
        aliasesA: nm("Maya Reeves"),
        aliasesB: nm("Maya Reeves"),
        score: 1,
        matchStrength: 1.7,
        isPersonA: true,
        isPersonB: true,
      }),
    ).toBe(true);
  });

  test("a distinctive full-name match just under the old 0.95 ceiling qualifies (floor is 0.90)", () => {
    // Two-token name matches attenuate to ~0.947; the distinctiveness carries it.
    expect(
      isHighConfidenceMerge({
        aliasesA: nm("Maya Reeves"),
        aliasesB: nm("Maya Reeves"),
        score: 0.93,
        matchStrength: 1.7,
        isPersonA: true,
        isPersonB: true,
      }),
    ).toBe(true);
  });

  test("a loose distinctive match below the 0.90 score floor does not qualify", () => {
    expect(
      isHighConfidenceMerge({
        aliasesA: nm("Maya Reeves"),
        aliasesB: nm("Maya Reeves"),
        score: 0.85,
        matchStrength: 1.7,
        isPersonA: true,
        isPersonB: true,
      }),
    ).toBe(false);
  });

  test("a common-name match (low matchStrength) is not high confidence", () => {
    expect(
      isHighConfidenceMerge({
        aliasesA: nm("Jamie Lopez"),
        aliasesB: nm("Jamie Lopez"),
        score: 1,
        matchStrength: 1.4,
        isPersonA: true,
        isPersonB: true,
      }),
    ).toBe(false);
  });

  test("a shared distinctive handle overrides a weak name signal", () => {
    expect(
      isHighConfidenceMerge({
        aliasesA: [{ aliasType: "email", alias: "mayareeves@example.com" }],
        aliasesB: [{ aliasType: "email", alias: "mayareeves@northstar.example" }],
        score: 0.5,
        matchStrength: 0,
        isPersonA: false,
        isPersonB: false,
      }),
    ).toBe(true);
  });

  test("an org↔org name match (not both persons, no handle) is not high confidence", () => {
    expect(
      isHighConfidenceMerge({
        aliasesA: nm("Central Group"),
        aliasesB: nm("Central Group"),
        score: 1,
        matchStrength: 2,
        isPersonA: false,
        isPersonB: false,
      }),
    ).toBe(false);
  });

  test("a surname-only vanity domain does not read as an org", () => {
    // david@lin.example for "David Lin": his surname IS the domain — a personal
    // domain, the opposite of an org signal. The distinctive-name branch applies.
    expect(
      isHighConfidenceMerge({
        aliasesA: [...nm("David Lin"), ...em("david@lin.example")],
        aliasesB: em("davidlin@gmail.example"),
        score: 1,
        matchStrength: 1.7,
        isPersonA: true,
        isPersonB: false,
      }),
    ).toBe(true);
  });

  test("an employer-embedded display name at the employer domain is still a person", () => {
    // "Maya Reeves | Northstar" at northstar.example: the domain carries the
    // employer token, not her given name — an employee, not the brand.
    expect(
      isHighConfidenceMerge({
        aliasesA: [...nm("Maya Reeves | Northstar"), ...em("maya.reeves@northstar.example")],
        aliasesB: nm("Maya Reeves"),
        score: 0.95,
        matchStrength: 1.7,
        isPersonA: true,
        isPersonB: true,
      }),
    ).toBe(true);
  });

  test("an org whose full identifying name is its domain never reads as a person", () => {
    // "Riverside Florist" at riversideflorist.example: the whole identifying
    // name is the domain — the org pattern, person-shaped lead or not.
    expect(
      isHighConfidenceMerge({
        aliasesA: [...nm("Riverside Florist"), ...em("hello@riversideflorist.example")],
        aliasesB: em("riversideflorist@marketplace.example"),
        score: 1,
        matchStrength: 1.7,
        isPersonA: true,
        isPersonB: false,
      }),
    ).toBe(false);
  });
});

describe("autoApproveHighConfidenceCandidates", () => {
  test("approves a distinctive-name pair as a reversible system rule", () => {
    makePerson({ name: "Maya Reeves", emails: ["mayareeves@example.com"] });
    makePerson({ name: "Maya Reeves", emails: ["mayareeves@northstar.example"] });
    for (let i = 0; i < 20; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });

    upsertMergeCandidates(db, computeFuzzyMergeCandidates(db, { headPercentile: 0 }));
    const { approved } = autoApproveHighConfidenceCandidates(db);

    expect(approved).toBeGreaterThanOrEqual(1);
    const systemRules = listMergeRules(db, { active: true }).filter((r) => r.kind === "system");
    expect(systemRules.length).toBeGreaterThanOrEqual(1);
    // The approved pair leaves the pending queue.
    expect(
      listAllMergeCandidates(db, "pending").some((c) => c.matchedTokens.includes("reeves")),
    ).toBe(false);
  });

  test("never auto-approves a pair that touches is_self", () => {
    makePerson({ name: "Maya Reeves", emails: ["mayareeves@example.com"], isSelf: true });
    makePerson({ name: "Maya Reeves", emails: ["mayareeves@northstar.example"] });
    for (let i = 0; i < 20; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });

    upsertMergeCandidates(db, computeFuzzyMergeCandidates(db, { headPercentile: 0 }));
    const { approved } = autoApproveHighConfidenceCandidates(db);

    expect(approved).toBe(0);
    expect(listMergeRules(db, { active: true }).filter((r) => r.kind === "system")).toHaveLength(0);
  });

  test("auto-approves a distinctive name ↔ matching email-only handle (Option 2)", () => {
    // One side is a named person; the other an email-only record whose handle is
    // the same distinctive name (a work/school address). The surname is not an org
    // domain brand → high-confidence same person, so it is auto-approved.
    makePerson({ name: "Jamie Lopez", emails: ["jlopez@example.com"] });
    makePerson({ emails: ["jamie.lopez@northstar.example"] });
    for (let i = 0; i < 20; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });

    upsertMergeCandidates(db, computeFuzzyMergeCandidates(db, { headPercentile: 0 }));
    const { approved } = autoApproveHighConfidenceCandidates(db);

    expect(approved).toBeGreaterThanOrEqual(1);
  });

  test("never auto-approves into an internally-conflicted blob person", () => {
    // A shared-account blob that accreted several people's names onto one row.
    // Its PRIMARY name (David Bond) is what matches a clean record; the minority
    // names make it internally-conflicted, which the blob guard reads on ALL names.
    const blob = makePerson({ name: "David Bond", emails: ["mixedfamily@example.com"] });
    for (const n of ["Maya Bond", "Nora Bond"]) {
      db.prepare(
        `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
         VALUES (?, ?, ?, 'name', '2026-01-01')`,
      ).run(randomUUID(), blob, n);
    }
    // A clean record that high-confidence-matches the blob's primary name.
    makePerson({ name: "David Bond", emails: ["david.bond@northstar.example"] });
    for (let i = 0; i < 20; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });

    upsertMergeCandidates(db, computeFuzzyMergeCandidates(db, { headPercentile: 0 }));
    const { approved } = autoApproveHighConfidenceCandidates(db);

    expect(approved).toBe(0); // the blob guard blocks the only high-confidence pair
    expect(listMergeRules(db, { active: true }).filter((r) => r.kind === "system")).toHaveLength(0);
  });
});

describe("computeEnrichedMergeCandidates — cluster pagination", () => {
  test("never splits a connected cluster across pages", () => {
    const connectedA = makePerson({
      name: "Maya Reeves",
      emails: ["maya.pagination@example.com"],
    });
    const connectedB = makePerson({
      name: "Jamie Lopez",
      emails: ["jamie.pagination@example.com"],
    });
    const connectedC = makePerson({
      name: "FixtureDavid",
      emails: ["david.pagination@example.com"],
    });
    makePerson({ name: "Sarah Mendez", emails: ["sarah.pagination@example.com"] });
    makePerson({ name: "Owen Pike", emails: ["owen.pagination@example.com"] });
    // Make the two-edge connected component deterministically rank ahead of
    // the isolated pair; pagination still operates on clusters, not rows.
    db.prepare("UPDATE people SET interaction_score_recent = 10 WHERE id = ?").run(connectedA);

    upsertMergeCandidates(db, [
      {
        sideA: { aliasType: "email", alias: "maya.pagination@example.com" },
        sideB: { aliasType: "email", alias: "jamie.pagination@example.com" },
        score: 0.99,
        detectionKind: "name_token_overlap",
        matchedTokens: ["pagination"],
        matchStrength: 1.4,
        personA: connectedA,
        personB: connectedB,
      },
      {
        sideA: { aliasType: "email", alias: "jamie.pagination@example.com" },
        sideB: { aliasType: "email", alias: "david.pagination@example.com" },
        score: 0.98,
        detectionKind: "name_token_overlap",
        matchedTokens: ["pagination"],
        matchStrength: 1.4,
        personA: connectedB,
        personB: connectedC,
      },
      {
        sideA: { aliasType: "email", alias: "sarah.pagination@example.com" },
        sideB: { aliasType: "email", alias: "owen.pagination@example.com" },
        score: 0.8,
        detectionKind: "name_token_overlap",
        matchedTokens: ["pagination"],
        matchStrength: 1.2,
      },
    ]);
    for (const candidate of listAllMergeCandidates(db, "pending")) {
      applyMergeAdjudication(db, {
        candidateId: candidate.id,
        verdict: "unsure",
        reason: "Synthetic pagination fixture.",
        runId: "run_pagination",
      });
    }

    const first = computeEnrichedMergeCandidates(db, {
      status: "pending",
      limit: 100,
      clusterLimit: 1,
    });
    expect(first.hasMoreClusters).toBe(true);
    expect(first.nextClusterCursor).toEqual({
      kind: "rank",
      rankScore: first.candidates[0]!.rankScore,
      clusterId: first.candidates[0]!.clusterId,
    });
    expect(first.candidates).toHaveLength(2);
    expect(new Set(first.candidates.map((candidate) => candidate.clusterId)).size).toBe(1);

    const second = computeEnrichedMergeCandidates(db, {
      status: "pending",
      limit: 100,
      clusterLimit: 1,
      clusterAfter: first.nextClusterCursor!,
    });
    expect(second.hasMoreClusters).toBe(false);
    expect(second.candidates).toHaveLength(1);
    expect(
      new Set([...first.candidates, ...second.candidates].map((candidate) => candidate.id)).size,
    ).toBe(3);
  });

  test("keyset-pages settled history without rebuilding its unbounded cluster graph", () => {
    const addPair = (prefix: string, decidedAt: string): string => {
      makePerson({
        name: `${prefix} Alpha`,
        emails: [`${prefix.toLowerCase()}.alpha@example.com`],
      });
      makePerson({
        name: `${prefix} Beta`,
        emails: [`${prefix.toLowerCase()}.beta@example.com`],
      });
      upsertMergeCandidates(db, [
        {
          sideA: {
            aliasType: "email",
            alias: `${prefix.toLowerCase()}.alpha@example.com`,
          },
          sideB: {
            aliasType: "email",
            alias: `${prefix.toLowerCase()}.beta@example.com`,
          },
          score: 0.9,
          detectionKind: "name_token_overlap",
          matchedTokens: [prefix.toLowerCase()],
          matchStrength: 1.2,
        },
      ]);
      const row = listAllMergeCandidates(db, "pending").find(
        (candidate) =>
          candidate.sideA.alias.startsWith(prefix.toLowerCase()) ||
          candidate.sideB.alias.startsWith(prefix.toLowerCase()),
      )!;
      db.prepare("UPDATE merge_candidates SET status = 'denied', decided_at = ? WHERE id = ?").run(
        decidedAt,
        row.id,
      );
      return row.id;
    };

    const oldest = addPair("Atlas", "2026-01-01T00:00:00.000Z");
    const middle = addPair("Beacon", "2026-02-01T00:00:00.000Z");
    const newest = addPair("Comet", "2026-03-01T00:00:00.000Z");
    const first = computeEnrichedMergeCandidates(db, {
      status: "denied",
      limit: 100,
      clusterLimit: 2,
    });
    expect(first.candidates.map((candidate) => candidate.id)).toEqual([newest, middle]);
    expect(first.candidates.every((candidate) => candidate.clusterId === candidate.id)).toBe(true);
    expect(first.nextClusterCursor).toEqual({
      kind: "history",
      sortAt: "2026-02-01T00:00:00.000Z",
      id: middle,
    });

    // A later decision belongs before the rendered page. OFFSET would repeat
    // the middle row; the decision-time/id keyset continues at the oldest.
    const later = addPair("Delta", "2026-04-01T00:00:00.000Z");
    const second = computeEnrichedMergeCandidates(db, {
      status: "denied",
      limit: 100,
      clusterLimit: 2,
      clusterAfter: first.nextClusterCursor!,
    });
    expect(second.candidates.map((candidate) => candidate.id)).toEqual([oldest]);
    expect(second.candidates.map((candidate) => candidate.id)).not.toContain(later);
    expect(second.hasMoreClusters).toBe(false);
  });

  test("searches settled history in SQL before applying the page limit", () => {
    const insert = db.prepare(
      `INSERT INTO merge_candidates (
         id, side_a_alias_type, side_a_alias, side_b_alias_type, side_b_alias,
         score, detection_kind, status, detected_at, decided_at
       ) VALUES (?, 'email', ?, 'email', ?, 0.8, 'name_token_overlap', 'denied', ?, ?)`,
    );
    db.transaction(() => {
      for (let index = 0; index < 250; index += 1) {
        const decidedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
        insert.run(
          `candidate_${index.toString().padStart(3, "0")}`,
          index === 0 ? "needle.oldest@example.com" : `alpha.${index}@example.com`,
          `beta.${index}@example.com`,
          decidedAt,
          decidedAt,
        );
      }
    })();

    const page = computeEnrichedMergeCandidates(db, {
      status: "denied",
      limit: 100,
      clusterLimit: 2,
      q: "needle.oldest",
    });

    expect(page.candidates.map((candidate) => candidate.id)).toEqual(["candidate_000"]);
    expect(page.hasMoreClusters).toBe(false);
  });
});

describe("applyMergeAdjudication", () => {
  function seedCandidate(
    sideA: { aliasType: "email" | "name" | "phone"; alias: string },
    sideB: { aliasType: "email" | "name" | "phone"; alias: string },
  ): string {
    upsertMergeCandidates(db, [
      {
        sideA,
        sideB,
        score: 0.95,
        detectionKind: "name_token_overlap",
        matchedTokens: ["reeves"],
        matchStrength: 1.4,
      },
    ]);
    const cand = listAllMergeCandidates(db, "pending").find(
      (c) =>
        (c.sideA.alias === sideA.alias && c.sideB.alias === sideB.alias) ||
        (c.sideA.alias === sideB.alias && c.sideB.alias === sideA.alias),
    );
    if (!cand) throw new Error("seed candidate not found");
    return cand.id;
  }

  test("merge verdict creates a system rule carrying the model's reason", () => {
    makePerson({ name: "Maya Reeves", emails: ["mreeves@example.com"] });
    makePerson({ name: "Maya Reeves", emails: ["maya.reeves@northstar.example"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "mreeves@example.com" },
      { aliasType: "email", alias: "maya.reeves@northstar.example" },
    );

    const res = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "merge",
      reason: "Both addresses sign the same way and share a contact card.",
      runId: "run_test1",
    });

    expect(res.outcome).toBe("merged");
    const rule = listMergeRules(db, { active: true }).find((r) => r.id === res.ruleId);
    expect(rule?.kind).toBe("system");
    expect(rule?.reason).toBe("Both addresses sign the same way and share a contact card.");
    expect(rule?.createdBy).toBe("run_test1");
    const cand = getMergeCandidateById(db, id);
    expect(cand?.status).toBe("accepted");
    expect(cand?.adjudicationVerdict).toBe("merge");
    expect(cand?.adjudicationReason).toContain("contact card");
    expect(cand?.adjudicatedAt).toBeTruthy();
  });

  test("distinct verdict denies the candidate as a durable veto", () => {
    makePerson({ name: "Maya Reeves", emails: ["mreeves@example.com"] });
    makePerson({ name: "Nora Reeves", emails: ["nreeves@example.com"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "mreeves@example.com" },
      { aliasType: "email", alias: "nreeves@example.com" },
    );

    const res = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "distinct",
      reason: "Two different given names appear as separate thread participants.",
      runId: "run_test2",
    });

    expect(res.outcome).toBe("denied");
    const cand = getMergeCandidateById(db, id);
    expect(cand?.status).toBe("denied");
    expect(cand?.adjudicationVerdict).toBe("distinct");
  });

  test("unsure verdict stamps the reason and leaves the candidate pending", () => {
    makePerson({ name: "Maya Reeves", emails: ["mreeves@example.com"] });
    makePerson({ name: "Maya Reeves", emails: ["reeves.family@example.com"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "mreeves@example.com" },
      { aliasType: "email", alias: "reeves.family@example.com" },
    );

    const res = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "unsure",
      reason: "Could be a shared family mailbox; no decisive signal either way.",
      runId: "run_test3",
    });

    expect(res.outcome).toBe("recorded");
    const cand = getMergeCandidateById(db, id);
    expect(cand?.status).toBe("pending");
    expect(cand?.adjudicationVerdict).toBe("unsure");
    expect(cand?.adjudicationReason).toContain("family mailbox");
  });

  test("a verdict records the evidence it judged and counts itself", () => {
    makePerson({ name: "Maya Reeves", emails: ["mreeves@example.com"] });
    makePerson({ name: "Maya Reeves", emails: ["reeves.family@example.com"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "mreeves@example.com" },
      { aliasType: "email", alias: "reeves.family@example.com" },
    );
    const before = getMergeCandidateById(db, id)!;
    expect(before.adjudicationEvidenceFingerprint).toBeNull();
    expect(before.adjudicationCount).toBe(0);

    applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "unsure",
      reason: "No decisive signal either way.",
      runId: "run_fingerprint",
    });

    const after = getMergeCandidateById(db, id)!;
    expect(after.adjudicationEvidenceFingerprint).toBe(currentEvidenceFingerprint(before));
    expect(after.adjudicationCount).toBe(1);
    // A verdict covering the current evidence is not re-opened, and is the
    // operator's to settle.
    expect(isAdjudicationDue(after)).toBe(false);
    expect(needsOperatorAdjudication(after)).toBe(true);

    applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "unsure",
      reason: "Still no decisive signal.",
      runId: "run_fingerprint_2",
    });
    expect(getMergeCandidateById(db, id)!.adjudicationCount).toBe(2);
  });

  test("evidence fingerprints ignore drift below display precision", () => {
    const base = {
      matchedTokens: ["maya", "reeves"],
      score: 0.9424916782930021,
      matchStrength: 1.4,
    };
    expect(mergeCandidateEvidenceFingerprint(base)).toBe(
      mergeCandidateEvidenceFingerprint({
        ...base,
        score: 0.9424916782930044,
        matchStrength: 1.4000000000000004,
      }),
    );
    // Token order is not evidence; a different token is.
    expect(mergeCandidateEvidenceFingerprint(base)).toBe(
      mergeCandidateEvidenceFingerprint({ ...base, matchedTokens: ["reeves", "maya"] }),
    );
    expect(mergeCandidateEvidenceFingerprint(base)).not.toBe(
      mergeCandidateEvidenceFingerprint({ ...base, matchedTokens: ["maya"] }),
    );
    expect(mergeCandidateEvidenceFingerprint(base)).not.toBe(
      mergeCandidateEvidenceFingerprint({ ...base, score: 0.943 }),
    );
  });

  test("a merge verdict the guards refuse leaves the candidate as the operator's", () => {
    // The blob guard blocks the merge, so the candidate stays pending holding
    // a `merge` verdict. Nothing will revisit it — that is the exact state the
    // operator needs to see, and the one an "is it unsure?" test would miss.
    makePerson({ name: "Maya Reeves", emails: ["mreeves@example.com"] });
    makePerson({
      name: "Household",
      emails: ["reeves.family@example.com"],
      extraNames: ["Jamie Reeves", "David Reeves"],
    });
    const id = seedCandidate(
      { aliasType: "email", alias: "mreeves@example.com" },
      { aliasType: "email", alias: "reeves.family@example.com" },
    );

    const res = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "merge",
      reason: "Same person on both sides.",
      runId: "run_guarded",
    });

    expect(res.outcome).toBe("guard_blocked");
    const cand = getMergeCandidateById(db, id)!;
    expect(cand.status).toBe("pending");
    expect(cand.adjudicationVerdict).toBe("merge");
    expect(isAdjudicationDue(cand)).toBe(false);
    expect(needsOperatorAdjudication(cand)).toBe(true);
  });

  test("a verdict is stamped with the evidence the run judged, not the row's latest", () => {
    // A detector pass landing between the run's evidence pack and its verdict
    // must leave the new evidence due. Stamping the live row would mark it as
    // covered by a judgment that never saw it.
    makePerson({ name: "Maya Reeves", emails: ["mreeves@example.com"] });
    makePerson({ name: "Maya Reeves", emails: ["reeves.family@example.com"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "mreeves@example.com" },
      { aliasType: "email", alias: "reeves.family@example.com" },
    );
    const judged = currentEvidenceFingerprint(getMergeCandidateById(db, id)!);

    // The detector re-proposes with a genuinely different token set mid-run.
    db.prepare("UPDATE merge_candidates SET matched_tokens = ? WHERE id = ?").run(
      JSON.stringify(["reeves", "maya"]),
      id,
    );

    applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "unsure",
      reason: "No decisive signal either way.",
      runId: "run_midflight",
      judgedEvidenceFingerprint: judged,
    });

    const after = getMergeCandidateById(db, id)!;
    expect(after.adjudicationEvidenceFingerprint).toBe(judged);
    expect(isAdjudicationDue(after)).toBe(true);
  });

  test("a candidate the Brain has not judged is not the operator's yet", () => {
    makePerson({ name: "Maya Reeves", emails: ["mreeves@example.com"] });
    makePerson({ name: "Maya Reeves", emails: ["reeves.family@example.com"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "mreeves@example.com" },
      { aliasType: "email", alias: "reeves.family@example.com" },
    );
    expect(needsOperatorAdjudication(getMergeCandidateById(db, id)!)).toBe(false);
  });

  test("merge verdict touching self is guard-blocked, never applied", () => {
    makePerson({ name: "Maya Reeves", emails: ["mreeves@example.com"], isSelf: true });
    makePerson({ name: "Maya Reeves", emails: ["maya.reeves@northstar.example"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "mreeves@example.com" },
      { aliasType: "email", alias: "maya.reeves@northstar.example" },
    );

    const res = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "merge",
      reason: "Same person across the two providers, clearly.",
      runId: "run_test4",
    });

    expect(res.outcome).toBe("guard_blocked");
    expect(getMergeCandidateById(db, id)?.status).toBe("pending");
    expect(listMergeRules(db, { active: true })).toHaveLength(0);
  });

  test("merge verdict into a blob person is guard-blocked", () => {
    const blob = makePerson({ name: "Maya Reeves", emails: ["sharedbox@example.com"] });
    for (const n of ["David Reeves", "Nora Reeves"]) {
      db.prepare(
        `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
         VALUES (?, ?, ?, 'name', '2026-01-01')`,
      ).run(randomUUID(), blob, n);
    }
    makePerson({ name: "Maya Reeves", emails: ["maya.reeves@northstar.example"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "sharedbox@example.com" },
      { aliasType: "email", alias: "maya.reeves@northstar.example" },
    );

    const res = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "merge",
      reason: "The display names agree, so it looks like the same person.",
      runId: "run_test5",
    });

    expect(res.outcome).toBe("guard_blocked");
    expect(getMergeCandidateById(db, id)?.status).toBe("pending");
    expect(listMergeRules(db, { active: true })).toHaveLength(0);
  });

  test("a decided candidate is a no-op", () => {
    makePerson({ name: "Maya Reeves", emails: ["mreeves@example.com"] });
    makePerson({ name: "Nora Reeves", emails: ["nreeves@example.com"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "mreeves@example.com" },
      { aliasType: "email", alias: "nreeves@example.com" },
    );
    denyMergeCandidate(db, id);

    const res = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "merge",
      reason: "This verdict arrives after the operator already decided.",
      runId: "run_test6",
    });

    expect(res.outcome).toBe("not_pending");
    const cand = getMergeCandidateById(db, id);
    expect(cand?.status).toBe("denied");
    expect(cand?.adjudicationVerdict).toBeNull(); // no stamp on decided rows
  });

  test("a missing candidate reports not_found", () => {
    const res = applyMergeAdjudication(db, {
      candidateId: "no-such-candidate",
      verdict: "unsure",
      reason: "This candidate id does not exist anymore at apply time.",
      runId: "run_test7",
    });
    expect(res.outcome).toBe("not_found");
  });

  test("sides already collapsed to one canonical report already_merged, no rule", () => {
    const winner = makePerson({ name: "Carla Vance", emails: ["cvance@example.com"] });
    const loser = makePerson({ name: "Carla Vance", emails: ["carla.vance@northstar.example"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "cvance@example.com" },
      { aliasType: "email", alias: "carla.vance@northstar.example" },
    );
    // Collapse the pair before the verdict lands: both sides now resolve to
    // the same canonical, as after a rule-driven merge.
    db.prepare(`UPDATE people SET merged_into = ? WHERE id = ?`).run(winner, loser);

    const res = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "merge",
      reason: "Same signature and shared calendar invites across both boxes.",
      runId: "run_test8",
    });

    expect(res.outcome).toBe("already_merged");
    expect(res.ruleId).toBeNull();
    const cand = getMergeCandidateById(db, id);
    expect(cand?.adjudicationVerdict).toBe("merge");
    expect(cand?.adjudicatedAt).toBeTruthy();
  });

  test("a side that no longer resolves to anyone is guard-blocked", () => {
    makePerson({ name: "Carla Vance", emails: ["cvance@example.com"] });
    makePerson({ name: "Carla Vance", emails: ["carla.vance@northstar.example"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "cvance@example.com" },
      { aliasType: "email", alias: "carla.vance@northstar.example" },
    );
    // The alias vanished between detection and verdict (e.g. an alias cleanup).
    db.prepare(`DELETE FROM person_aliases WHERE alias = ?`).run("carla.vance@northstar.example");

    const res = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "merge",
      reason: "The two addresses belong to the same account holder.",
      runId: "run_test9",
    });

    expect(res.outcome).toBe("guard_blocked");
    expect(res.ruleId).toBeNull();
    expect(getMergeCandidateById(db, id)?.status).toBe("pending");
    expect(listMergeRules(db, { active: true })).toHaveLength(0);
  });

  test("resolution drift blocks the merge; the correct expected set applies it", () => {
    const p1 = makePerson({ name: "Carla Vance", emails: ["cvance@example.com"] });
    const p2 = makePerson({ name: "Carla Vance", emails: ["carla.vance@northstar.example"] });
    const id = seedCandidate(
      { aliasType: "email", alias: "cvance@example.com" },
      { aliasType: "email", alias: "carla.vance@northstar.example" },
    );

    // The run's evidence saw only p1 — apply-time resolution also includes p2,
    // so the verdict would weld a person the model never examined.
    const drifted = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "merge",
      reason: "Both addresses appear on the same booking confirmation.",
      runId: "run_test10",
      expectedPersonIds: [p1],
    });
    expect(drifted.outcome).toBe("guard_blocked");
    expect(drifted.ruleId).toBeNull();
    expect(getMergeCandidateById(db, id)?.status).toBe("pending");
    expect(listMergeRules(db, { active: true })).toHaveLength(0);

    // With the expected set matching live resolution, the merge goes through.
    const applied = applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "merge",
      reason: "Both addresses appear on the same booking confirmation.",
      runId: "run_test10",
      expectedPersonIds: [p1, p2],
    });
    expect(applied.outcome).toBe("merged");
    expect(applied.ruleId).toBeTruthy();
    expect(getMergeCandidateById(db, id)?.status).toBe("accepted");
  });
});

describe("hasInternalNameConflict", () => {
  const nm = (...names: string[]) => names.map((n) => ({ aliasType: "name", alias: n }));

  test("≥2 conflicting givens over one surname → conflict (a blob)", () => {
    expect(hasInternalNameConflict(nm("Maya Bond", "David Bond", "Nora Bond"))).toBe(true);
  });

  test("a single coherent identity is not a conflict", () => {
    expect(hasInternalNameConflict(nm("Maya Reeves", "Maya"))).toBe(false);
  });

  test("prefix-agreeing variants are not a conflict", () => {
    expect(hasInternalNameConflict(nm("Maya Reeves", "Mayara Reeves"))).toBe(false);
  });

  test("a short or initial lead does not seed a conflict", () => {
    expect(hasInternalNameConflict(nm("JP Bond", "David Bond"))).toBe(false);
  });

  test("order/case variants of ONE name are not a conflict", () => {
    // The formal surname-first convention next to given-first: same person.
    expect(hasInternalNameConflict(nm("Vance Carla", "Carla VANCE", "carla vance"))).toBe(false);
  });

  test("an order-variant group with an initial still groups as one name", () => {
    expect(hasInternalNameConflict(nm("Carla Vance", "VANCE Carla J"))).toBe(false);
  });

  test("a provenance-suffixed spelling is the same name", () => {
    expect(hasInternalNameConflict(nm("Carla Vance", "Carla Vance (via Google Docs)"))).toBe(false);
  });

  test("order variants of one name PLUS a different person is still a blob", () => {
    expect(hasInternalNameConflict(nm("Vance Carla", "Carla VANCE", "David Vance"))).toBe(true);
  });

  test("two genuinely different names remain a conflict after grouping", () => {
    // Distinct sorted-token keys with disagreeing leads — the classic blob.
    expect(hasInternalNameConflict(nm("Maya Reeves", "Nora Reeves"))).toBe(true);
  });

  test("two family members each written in BOTH orders are still a blob", () => {
    // The shared surname appears as a lead of both groups (from the
    // order-variant spellings), but reading it as the given leaves the two
    // groups' remaining tokens disagreeing — no consistent reading exists.
    expect(
      hasInternalNameConflict(nm("Maya Reeves", "Reeves Maya", "Nora Reeves", "Reeves Nora")),
    ).toBe(true);
  });

  test("an order-variant name next to a surname-first relative is a blob", () => {
    expect(hasInternalNameConflict(nm("Maya Reeves", "Reeves Maya", "Reeves Nora"))).toBe(true);
  });

  test("a middle-name extension of the same name is not a conflict", () => {
    expect(hasInternalNameConflict(nm("Carla Vance", "Carla Dupont Vance"))).toBe(false);
  });
});

describe("recomputeNamePrimaries", () => {
  function addNameAlias(
    personId: string,
    name: string,
    count: number,
    createdAt = "2026-01-01",
  ): void {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at, occurrence_count, is_primary)
       VALUES (?, ?, ?, 'name', 'test', ?, ?, 0)`,
    ).run(randomUUID(), personId, name, createdAt, count);
  }
  const primaryName = (personId: string): string | undefined =>
    db
      .prepare<
        [string],
        { alias: string }
      >("SELECT alias FROM person_aliases WHERE person_id=? AND alias_type='name' AND is_primary=1")
      .get(personId)?.alias;
  const canonical = (personId: string): string =>
    db
      .prepare<[string], { canonical_name: string }>("SELECT canonical_name FROM people WHERE id=?")
      .get(personId)!.canonical_name;

  test("the highest-count name becomes primary and the headline", () => {
    const p = makePerson({ emails: ["x@example.com"] });
    addNameAlias(p, "David Bond", 80);
    addNameAlias(p, "Maya Bond", 3);
    addNameAlias(p, "Nora Bond", 2);

    recomputeNamePrimaries(db);

    expect(primaryName(p)).toBe("David Bond");
    expect(canonical(p)).toBe("David Bond");
  });

  test("a contact-floor name outranks a high-volume sender name", () => {
    const p = makePerson({ emails: ["y@example.com"] });
    addNameAlias(p, "Maya Bond", 500); // high-volume sender display-name
    addNameAlias(p, "David Bond", 1_000_000); // contact-card floor

    recomputeNamePrimaries(db);

    expect(primaryName(p)).toBe("David Bond");
  });

  test("folds case/diacritic variants into one count", () => {
    const p = makePerson({ emails: ["z@example.com"] });
    addNameAlias(p, "David Bond", 30);
    addNameAlias(p, "david bond", 25); // same folded name → real activity sums to 55
    addNameAlias(p, "Maya Bond", 40); // distinct → 40, loses to 55

    recomputeNamePrimaries(db);

    expect(primaryName(p)).toBe("David Bond");
  });

  test("two floored variants don't out-rank a single more-active floored name", () => {
    // Regression: the contact floor must count ONCE per folded group, not sum
    // across variants — else a name with two floored variants (2× floor) wrongly
    // beats a single floored name that's genuinely more active.
    const p = makePerson({ emails: ["w@example.com"] });
    addNameAlias(p, "Maya Bond", 1_000_000); // floored
    addNameAlias(p, "maya bond", 1_000_000); // folds with the above → 2 floored variants
    addNameAlias(p, "David Bond", 1_000_004); // 1 floored variant + 4 real mentions

    recomputeNamePrimaries(db);

    expect(primaryName(p)).toBe("David Bond");
  });
});

describe("name-frequency merge filter", () => {
  function addNameAlias(personId: string, name: string, count: number): void {
    db.prepare(
      `INSERT INTO person_aliases (id, person_id, alias, alias_type, source_id, created_at, occurrence_count, is_primary)
       VALUES (?, ?, ?, 'name', 'test', '2026-01-01', ?, 0)`,
    ).run(randomUUID(), personId, name, count);
  }

  test("only the primary name is tokenized (the full set still feeds the hub gate)", () => {
    const p = makePerson({ emails: ["e@example.com"] });
    addNameAlias(p, "David Bond", 80);
    addNameAlias(p, "Maya Bond", 2);
    recomputeNamePrimaries(db);

    // fetch still returns every alias (with is_primary) for the gates/hub…
    const rows = fetchMergeCandidatesData(db).aliasRows.filter(
      (r) => r.person_id === p && r.alias_type === "name",
    );
    expect(rows.map((r) => r.alias).sort()).toEqual(["David Bond", "Maya Bond"]);
    expect(rows.find((r) => r.alias === "David Bond")?.is_primary).toBe(1);
    expect(rows.find((r) => r.alias === "Maya Bond")?.is_primary).toBe(0);
  });

  test("a minority name cannot drive a candidate match", () => {
    const blob = makePerson({ emails: ["bondfamily@example.com"] });
    addNameAlias(blob, "David Bond", 80); // dominant
    addNameAlias(blob, "Maya Bond", 2); // minority
    // A clean, separate Maya Bond the minority name would otherwise match.
    const cleanMaya = makePerson({ name: "Maya Bond", emails: ["maya.bond@northstar.example"] });
    for (let i = 0; i < 20; i++) makePerson({ emails: [`uniq${i}box@f${i}.example`] });
    recomputeNamePrimaries(db); // David Bond becomes the blob's primary

    const proposals = computeFuzzyMergeCandidates(db, { headPercentile: 0 });
    const bridged = proposals.some(
      (p) => [p.personA, p.personB].includes(blob) && [p.personA, p.personB].includes(cleanMaya),
    );
    expect(bridged).toBe(false);
  });
});

describe("needsOperator badge", () => {
  /**
   * Seed the shape that made this a bug on a live install: a pending pair the
   * Brain adjudicated `unsure` — i.e. escalated to the operator — whose sides
   * resolve to a person carrying many unrelated names, so the hub veto hides
   * it from the queue.
   */
  function seedHubVetoedEscalation(): string {
    const hub = makePerson({
      name: "Maya Reeves",
      emails: ["bookings@stellarsound.example"],
      extraNames: ["Jamie Lopez", "David Lin", "Sarah Mendez", "Owen Pike"],
    });
    makePerson({ name: "Maya Reeves", emails: ["m.reeves@northstar.example"] });
    upsertMergeCandidates(db, [
      {
        sideA: { aliasType: "email", alias: "m.reeves@northstar.example" },
        sideB: { aliasType: "name", alias: "Maya Reeves" },
        score: 0.94,
        detectionKind: "name_token_overlap",
        matchedTokens: ["maya", "reeves"],
        matchStrength: 1.4,
      },
    ]);
    const id = listAllMergeCandidates(db, "pending")[0]!.id;
    // The hub veto must be what hides it — otherwise this test would pass for
    // the wrong reason once some other gate changes.
    expect(explainMergeCandidateVisibility(db, { status: "pending" })[0]!.veto).toBe("hub");
    expect(isHubPerson(["Maya Reeves", "Jamie Lopez", "David Lin"])).toBe(true);
    expect(hub).toBeTruthy();

    applyMergeAdjudication(db, {
      candidateId: id,
      verdict: "unsure",
      reason: "No decisive signal either way.",
      runId: "run_escalation",
    });
    expect(needsOperatorAdjudication(getMergeCandidateById(db, id)!)).toBe(true);
    return id;
  }

  test("the badge means the same thing on every tab", () => {
    seedHubVetoedEscalation();
    // Give the other two tabs content, so a count that silently followed the
    // rendered status would have something different to report.
    for (const status of ["accepted", "denied"] as const) {
      makePerson({ name: "Elena Voss", emails: [`voss-${status}@example.com`] });
      makePerson({ name: "Elena Voss", emails: [`e.voss-${status}@northstar.example`] });
      upsertMergeCandidates(db, [
        {
          sideA: { aliasType: "email", alias: `voss-${status}@example.com` },
          sideB: { aliasType: "email", alias: `e.voss-${status}@northstar.example` },
          score: 0.9,
          detectionKind: "name_token_overlap",
          matchedTokens: ["elena", "voss"],
          matchStrength: 1.4,
        },
      ]);
      const seeded = listAllMergeCandidates(db, "pending").find(
        (c) => c.sideA.alias.includes(status) || c.sideB.alias.includes(status),
      )!;
      db.prepare("UPDATE merge_candidates SET status = ? WHERE id = ?").run(status, seeded.id);
    }

    const counts = (["pending", "accepted", "denied"] as const).map(
      (status) => computeEnrichedMergeCandidates(db, { status, limit: 100 }).counts.needsOperator,
    );
    expect(counts).toEqual([1, 1, 1]);
  });

  test("an adjudicated pending candidate is listed, not only counted", () => {
    const id = seedHubVetoedEscalation();
    const rendered = computeEnrichedMergeCandidates(db, { status: "pending", limit: 100 });

    // The whole point: the operator can act on what the badge points at.
    expect(rendered.counts.needsOperator).toBe(1);
    expect(rendered.candidates.map((c) => c.id)).toEqual([id]);
    expect(rendered.candidates[0]!.needsOperator).toBe(true);
  });

  test("the vetoes still hide an unadjudicated candidate", () => {
    // The bypass is scoped to adjudication. Raw detector output that trips a
    // veto stays suppressed — that filtering is what keeps the queue usable.
    seedHubVetoedEscalation();
    const id = listAllMergeCandidates(db, "pending")[0]!.id;
    db.prepare(
      "UPDATE merge_candidates SET adjudicated_at = NULL, adjudication_verdict = NULL WHERE id = ?",
    ).run(id);

    const rendered = computeEnrichedMergeCandidates(db, { status: "pending", limit: 100 });
    expect(rendered.candidates).toHaveLength(0);
    expect(rendered.counts.needsOperator).toBe(0);
  });

  test("visibility diagnostic names the veto and the reason it is shown anyway", () => {
    seedHubVetoedEscalation();
    const [row] = explainMergeCandidateVisibility(db, { status: "pending" });

    expect(row!.veto).toBe("hub");
    expect(row!.surfacedByAdjudication).toBe(true);
    expect(row!.visible).toBe(true);
    expect(row!.needsOperator).toBe(true);
    // Safe to paste into a bug report: alias TYPES and opaque ids, never the
    // alias values themselves. Asserted against every value the fixture seeds,
    // so a name, an email or a phone leaking would all redden this.
    const serialized = JSON.stringify(row);
    for (const secret of [
      "Maya Reeves",
      "Jamie Lopez",
      "David Lin",
      "Sarah Mendez",
      "Owen Pike",
      "bookings@stellarsound.example",
      "m.reeves@northstar.example",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(row!.sideAAliasType).toBe("email");
    expect(row!.sideBAliasType).toBe("name");
  });

  test("a candidate the Brain will revisit is listed but not badged", () => {
    // `surfacesDespiteVeto` is deliberately wider than the badge: adjudicating
    // a pair at all is what earns it a look, but only a verdict covering the
    // CURRENT evidence means the operator is being asked to act. A row whose
    // evidence moved since the verdict is back in the Brain's hands, so it
    // shows without claiming the human's attention.
    const id = seedHubVetoedEscalation();
    db.prepare("UPDATE merge_candidates SET matched_tokens = ? WHERE id = ?").run(
      JSON.stringify(["maya", "reeves", "lopez"]),
      id,
    );
    const cand = getMergeCandidateById(db, id)!;
    expect(isAdjudicationDue(cand)).toBe(true);
    expect(needsOperatorAdjudication(cand)).toBe(false);

    const rendered = computeEnrichedMergeCandidates(db, { status: "pending", limit: 100 });
    expect(rendered.candidates.map((c) => c.id)).toEqual([id]);
    expect(rendered.counts.needsOperator).toBe(0);
    // Still counted-implies-listed: the badge is a subset of what is shown.
    expect(explainMergeCandidateVisibility(db, { status: "pending" })[0]!.veto).toBe("hub");
  });

  test("the count comes from the same read as the list", () => {
    // Both halves of one response must describe one snapshot. Counting from a
    // second SELECT would let an adjudication that commits mid-render be
    // counted while absent from the accompanying list — the very split this
    // fixes, reintroduced as a race.
    seedHubVetoedEscalation();
    const rendered = computeEnrichedMergeCandidates(db, { status: "pending", limit: 100 });
    expect(rendered.counts.needsOperator).toBe(
      rendered.candidates.filter((c) => c.needsOperator).length,
    );
  });
});
