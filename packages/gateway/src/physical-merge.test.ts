// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the physical merge primitive (physical-merge.ts).
 *
 * The primitive moves aliases + document_people from loser → winner,
 * then deletes the loser. These tests cover:
 *
 *   - Happy path: every loser alias / doc-people row ends up on winner.
 *   - Conflicts: when winner already has an alias / doc-people row that
 *     would collide, we leave winner's row intact and let the loser's
 *     duplicate cascade-delete.
 *   - Refusals: same id, missing winner, is_self loser.
 *   - Side-effect bookkeeping: dirty bumps + first/last_seen span.
 *   - person_equivalences cleanup so derived state doesn't dangle.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createDatabase } from "./db.js";
import { aliasWriter } from "./data/repositories/PersonAliasRepository.js";
import {
  physicalMergePeople,
  PhysicalMergeError,
  physicalDedupSharedAliases,
} from "./physical-merge.js";
import { readMergeRulesMeta, createMergeRule, listMergeRules } from "./people.js";

let tmpDir: string;
let db: Db;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "omnesis-physmerge-test-"));
  db = createDatabase(join(tmpDir, "test.db"));
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Helpers ────────────────────────────────────────────────────────

function insertPerson(
  id: string,
  opts: {
    canonicalName?: string;
    isSelf?: boolean;
    firstSeen?: string;
    lastSeen?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'extracted', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.canonicalName ?? `Person ${id.slice(0, 4)}`,
    opts.isSelf ? 1 : 0,
    opts.firstSeen ?? "2026-01-01",
    opts.lastSeen ?? "2026-01-01",
    "2026-01-01",
    "2026-01-01",
  );
}

function insertAlias(personId: string, aliasType: string, alias: string): void {
  db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias_type, alias, created_at)
     VALUES (?, ?, ?, ?, '2026-01-01')`,
  ).run(randomUUID(), personId, aliasType, alias);
}

function insertDoc(id: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test', 'test', ?, 'Doc', 'c', ?, '{}', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, id, `hash-${id}`);
}

function insertDocPerson(docId: string, personId: string, role: string): void {
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, 'test')`,
  ).run(docId, personId, role);
}

function getAliases(personId: string): Array<{ alias_type: string; alias: string }> {
  return db
    .prepare<
      [string],
      { alias_type: string; alias: string }
    >("SELECT alias_type, alias FROM person_aliases WHERE person_id = ? ORDER BY alias_type, alias")
    .all(personId);
}

function getDocPeople(personId: string): Array<{ document_id: string; role: string }> {
  return db
    .prepare<
      [string],
      { document_id: string; role: string }
    >("SELECT document_id, role FROM document_people WHERE person_id = ? ORDER BY document_id, role")
    .all(personId);
}

function personExists(id: string): boolean {
  return Boolean(
    db.prepare<[string], { id: string }>("SELECT id FROM people WHERE id = ?").get(id),
  );
}

// ─── Refusals ───────────────────────────────────────────────────────

describe("physicalMergePeople refusals", () => {
  test("throws when loserId === winnerId", () => {
    const id = randomUUID();
    insertPerson(id);
    expect(() => physicalMergePeople(db, { loserId: id, winnerId: id })).toThrow(
      PhysicalMergeError,
    );
  });

  test("throws when winner doesn't exist", () => {
    const loser = randomUUID();
    insertPerson(loser);
    expect(() => physicalMergePeople(db, { loserId: loser, winnerId: "ghost" })).toThrow(
      /winner ghost does not exist/,
    );
  });

  test("returns zero counts when loser doesn't exist (idempotent retry)", () => {
    const winner = randomUUID();
    insertPerson(winner);
    const result = physicalMergePeople(db, { loserId: "ghost", winnerId: winner });
    expect(result).toEqual({
      aliasesMoved: 0,
      aliasesDuplicateDropped: 0,
      docPeopleMoved: 0,
      docPeopleDuplicateDropped: 0,
    });
  });

  test("throws when loser is is_self=TRUE", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser, { isSelf: true });
    expect(() => physicalMergePeople(db, { loserId: loser, winnerId: winner })).toThrow(
      /refusing to delete is_self/,
    );
  });
});

// ─── Happy path: everything moves ───────────────────────────────────

describe("physicalMergePeople happy path", () => {
  test("moves all aliases when none collide", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    insertAlias(loser, "email", "alice@x.com");
    insertAlias(loser, "phone", "+1");
    insertAlias(loser, "name", "Alice");

    const result = physicalMergePeople(db, { loserId: loser, winnerId: winner });

    expect(result.aliasesMoved).toBe(3);
    expect(result.aliasesDuplicateDropped).toBe(0);
    expect(
      getAliases(winner)
        .map((a) => `${a.alias_type}=${a.alias}`)
        .sort(),
    ).toEqual(["email=alice@x.com", "name=Alice", "phone=+1"]);
    expect(personExists(loser)).toBe(false);
  });

  test("moves doc-people edges when none collide", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    insertDoc("d1");
    insertDoc("d2");
    insertDocPerson("d1", loser, "sender");
    insertDocPerson("d2", loser, "recipient");

    const result = physicalMergePeople(db, { loserId: loser, winnerId: winner });

    expect(result.docPeopleMoved).toBe(2);
    expect(result.docPeopleDuplicateDropped).toBe(0);
    expect(getDocPeople(winner)).toEqual([
      { document_id: "d1", role: "sender" },
      { document_id: "d2", role: "recipient" },
    ]);
  });

  test("merges both aliases and doc-people in one call", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    insertAlias(loser, "email", "alice@x.com");
    insertDoc("d1");
    insertDocPerson("d1", loser, "sender");

    const result = physicalMergePeople(db, { loserId: loser, winnerId: winner });

    expect(result.aliasesMoved).toBe(1);
    expect(result.docPeopleMoved).toBe(1);
    expect(personExists(loser)).toBe(false);
    expect(getAliases(winner)).toEqual([{ alias_type: "email", alias: "alice@x.com" }]);
    expect(getDocPeople(winner)).toEqual([{ document_id: "d1", role: "sender" }]);
  });

  test("trivially succeeds when loser has nothing attached", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    const result = physicalMergePeople(db, { loserId: loser, winnerId: winner });
    expect(result).toEqual({
      aliasesMoved: 0,
      aliasesDuplicateDropped: 0,
      docPeopleMoved: 0,
      docPeopleDuplicateDropped: 0,
    });
    expect(personExists(loser)).toBe(false);
  });

  test("re-keys the cognitive-graph person backlinks loser → winner (no orphans)", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    // FK-less person backlinks would dangle under the deleted loser without the
    // re-key. Seed a temporal annotation + a loop so the composite-PK join rows
    // have a valid parent (those FKs ARE enforced).
    db.prepare(
      `INSERT INTO temporal_annotations (id, interval_start_ms, interval_end_ms, precision, sentence, created_by_run, created_at, updated_at)
       VALUES ('ta_1', 1000, 2000, 'day', 's', 'r', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO open_loops (id, created_by_run, confidence, importance, title, created_at, last_update)
       VALUES ('olp_1', 'r', 0.9, 0.5, 'L', 1000, 1000)`,
    ).run();
    db.prepare(
      `INSERT INTO person_annotations (id, person_id, claim_type, claim_text, evidence_doc_id, evidence_quote, confidence, created_by_run, created_at)
       VALUES ('panno_1', ?, 'role', 'c', 'doc_1', 'q', 0.7, 'r', 1000)`,
    ).run(loser);
    db.prepare(
      "INSERT INTO temporal_annotation_people (annotation_id, person_id) VALUES ('ta_1', ?)",
    ).run(loser);
    db.prepare(
      "INSERT INTO open_loop_people (loop_id, person_id, role) VALUES ('olp_1', ?, 'actor')",
    ).run(loser);

    physicalMergePeople(db, { loserId: loser, winnerId: winner });

    const countFor = (table: string, id: string): number =>
      (
        db
          .prepare<
            [string],
            { n: number }
          >(`SELECT COUNT(*) AS n FROM ${table} WHERE person_id = ?`)
          .get(id) as { n: number }
      ).n;
    // All three moved to the winner; nothing left stranded under the deleted loser.
    expect(countFor("person_annotations", winner)).toBe(1);
    expect(countFor("person_annotations", loser)).toBe(0);
    expect(countFor("temporal_annotation_people", winner)).toBe(1);
    expect(countFor("temporal_annotation_people", loser)).toBe(0);
    expect(countFor("open_loop_people", winner)).toBe(1);
    expect(countFor("open_loop_people", loser)).toBe(0);
  });

  test("cognitive backlink re-key drops composite-PK conflicts instead of duplicating", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    db.prepare(
      `INSERT INTO temporal_annotations (id, interval_start_ms, interval_end_ms, precision, sentence, created_by_run, created_at, updated_at)
       VALUES ('ta_1', 1000, 2000, 'day', 's', 'r', 1000, 1000)`,
    ).run();
    // Both loser and winner already link the SAME entry — after the merge only
    // the winner's single row survives (UPDATE OR IGNORE + delete-remainder).
    db.prepare(
      "INSERT INTO temporal_annotation_people (annotation_id, person_id) VALUES ('ta_1', ?)",
    ).run(loser);
    db.prepare(
      "INSERT INTO temporal_annotation_people (annotation_id, person_id) VALUES ('ta_1', ?)",
    ).run(winner);

    physicalMergePeople(db, { loserId: loser, winnerId: winner });

    const rows = db
      .prepare<
        [],
        { annotation_id: string; person_id: string }
      >("SELECT annotation_id, person_id FROM temporal_annotation_people")
      .all();
    expect(rows).toEqual([{ annotation_id: "ta_1", person_id: winner }]);
  });
});

// ─── Conflicts ──────────────────────────────────────────────────────

describe("physicalMergePeople conflicts", () => {
  test("alias already on winner: dropped on loser, winner row preserved", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    // Both carry the same email — that's the whole point of physical merge.
    insertAlias(winner, "email", "alice@x.com");
    insertAlias(loser, "email", "alice@x.com");

    const result = physicalMergePeople(db, { loserId: loser, winnerId: winner });

    expect(result.aliasesMoved).toBe(0);
    expect(result.aliasesDuplicateDropped).toBe(1);
    expect(getAliases(winner)).toEqual([{ alias_type: "email", alias: "alice@x.com" }]);
    // Total alias count for the email is 1 — the loser's duplicate
    // was cascade-deleted with the loser row.
    const totalForEmail = db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM person_aliases WHERE alias_type='email' AND alias='alice@x.com'")
      .get()!.n;
    expect(totalForEmail).toBe(1);
  });

  test("the dropped duplicate's vouchers move to the row that survives", () => {
    // Two people are merged precisely because they share a strong identifier,
    // so the duplicate almost always carries a source the winner's copy does
    // not. Letting it cascade away leaves the survivor vouched for by fewer
    // sources than actually assert it — and removing one of those later takes
    // an identifier the others still hold, which is the chain migration 172
    // exists to break.
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    const vouch = (personId: string, sourceId: string) =>
      aliasWriter(db, sourceId, "2026-04-01T00:00:00Z").claim(personId, "email", "a@example.com");
    vouch(winner, "gmail");
    vouch(loser, "apple-contacts");

    physicalMergePeople(db, { loserId: loser, winnerId: winner });

    const vouchers = db
      .prepare<[string], { source_id: string }>(
        `SELECT a.source_id FROM person_alias_assertions a
           JOIN person_aliases al ON al.id = a.alias_id
          WHERE al.person_id = ? ORDER BY a.source_id`,
      )
      .all(winner)
      .map((r) => r.source_id);
    expect(vouchers).toEqual(["apple-contacts", "gmail"]);
  });

  test("partial alias overlap: matching ones drop, unique ones move", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    insertAlias(winner, "email", "alice@x.com");
    insertAlias(loser, "email", "alice@x.com"); // duplicate
    insertAlias(loser, "phone", "+1"); // unique to loser

    const result = physicalMergePeople(db, { loserId: loser, winnerId: winner });

    expect(result.aliasesMoved).toBe(1);
    expect(result.aliasesDuplicateDropped).toBe(1);
    expect(
      getAliases(winner)
        .map((a) => `${a.alias_type}=${a.alias}`)
        .sort(),
    ).toEqual(["email=alice@x.com", "phone=+1"]);
  });

  test("doc-people: same (doc, role) on winner: loser's duplicate dropped", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    insertDoc("d1");
    insertDocPerson("d1", winner, "sender");
    insertDocPerson("d1", loser, "sender"); // would conflict on PK

    const result = physicalMergePeople(db, { loserId: loser, winnerId: winner });

    expect(result.docPeopleMoved).toBe(0);
    expect(result.docPeopleDuplicateDropped).toBe(1);
    const totalForDocRole = db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(*) AS n FROM document_people WHERE document_id='d1' AND role='sender'")
      .get()!.n;
    expect(totalForDocRole).toBe(1);
  });

  test("doc-people: same doc, different role: both kept on winner", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    insertDoc("d1");
    insertDocPerson("d1", winner, "sender");
    insertDocPerson("d1", loser, "recipient");

    const result = physicalMergePeople(db, { loserId: loser, winnerId: winner });

    expect(result.docPeopleMoved).toBe(1);
    expect(result.docPeopleDuplicateDropped).toBe(0);
    expect(getDocPeople(winner)).toEqual([
      { document_id: "d1", role: "recipient" },
      { document_id: "d1", role: "sender" },
    ]);
  });
});

// ─── Side-effect bookkeeping ────────────────────────────────────────

describe("physicalMergePeople side-effects", () => {
  test("bumps merge_rules_meta.dirty_version", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    const before = readMergeRulesMeta(db).dirtyVersion;
    physicalMergePeople(db, { loserId: loser, winnerId: winner });
    const after = readMergeRulesMeta(db).dirtyVersion;
    expect(after).toBeGreaterThan(before);
  });

  test("bumps interaction_scores dirty_version", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    const before = db
      .prepare<
        [],
        { dirty_version: number }
      >("SELECT dirty_version FROM refresh_meta WHERE job = 'interaction_scores'")
      .get()!.dirty_version;
    physicalMergePeople(db, { loserId: loser, winnerId: winner });
    const after = db
      .prepare<
        [],
        { dirty_version: number }
      >("SELECT dirty_version FROM refresh_meta WHERE job = 'interaction_scores'")
      .get()!.dirty_version;
    expect(after).toBeGreaterThan(before);
  });

  test("expands winner's first_seen / last_seen to span both", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner, { firstSeen: "2026-03-01", lastSeen: "2026-03-31" });
    insertPerson(loser, { firstSeen: "2026-01-15", lastSeen: "2026-04-15" });
    physicalMergePeople(db, { loserId: loser, winnerId: winner });
    const w = db
      .prepare<
        [string],
        { first_seen: string; last_seen: string }
      >("SELECT first_seen, last_seen FROM people WHERE id = ?")
      .get(winner);
    expect(w!.first_seen).toBe("2026-01-15");
    expect(w!.last_seen).toBe("2026-04-15");
  });

  test("clears dangling merged_into pointers aimed at the loser", () => {
    // Reproduces a live bug: rule eval set winner.merged_into=loser
    // BEFORE physical-dedup picks loser as the row to delete. After
    // delete, winner.merged_into is dangling. resolvePersonId returns
    // the deleted id and downstream addNewAliases trips a FK error.
    const winner = randomUUID();
    const loser = randomUUID();
    const dangler = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    insertPerson(dangler);
    db.prepare("UPDATE people SET merged_into = ? WHERE id = ?").run(loser, dangler);

    physicalMergePeople(db, { loserId: loser, winnerId: winner });

    const row = db
      .prepare<
        [string],
        { merged_into: string | null }
      >("SELECT merged_into FROM people WHERE id = ?")
      .get(dangler);
    expect(row?.merged_into).toBeNull();
    expect(personExists(loser)).toBe(false);
    expect(personExists(winner)).toBe(true);
  });

  test("drops person_equivalences rows referencing loser", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    db.prepare(
      "INSERT INTO person_equivalences (from_id, to_id, applied_at) VALUES (?, ?, '2026-01-01')",
    ).run(loser, winner);
    db.prepare(
      "INSERT INTO person_equivalences (from_id, to_id, applied_at) VALUES (?, 'unrelated', '2026-01-01')",
    ).run("other-loser-id");
    physicalMergePeople(db, { loserId: loser, winnerId: winner });
    const remaining = db
      .prepare<
        [],
        { from_id: string; to_id: string }
      >("SELECT from_id, to_id FROM person_equivalences")
      .all();
    // Only the unrelated row survives.
    expect(remaining).toEqual([{ from_id: "other-loser-id", to_id: "unrelated" }]);
  });

  test("cascade-deletes any unmoved person_aliases rows on loser", () => {
    // Set up the same email on both. The loser's row can't move
    // (UNIQUE collision) and must be cascade-deleted with the person.
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner);
    insertPerson(loser);
    insertAlias(winner, "email", "x@y.com");
    insertAlias(loser, "email", "x@y.com");
    physicalMergePeople(db, { loserId: loser, winnerId: winner });
    // Loser is gone; cascade removed loser's alias row.
    const onLoser = db
      .prepare<
        [string],
        { n: number }
      >("SELECT COUNT(*) AS n FROM person_aliases WHERE person_id = ?")
      .get(loser)!.n;
    expect(onLoser).toBe(0);
  });
});

// ─── physicalDedupSharedAliases ─────────────────────────────────────

describe("physicalDedupSharedAliases", () => {
  test("no clusters: returns zeroes (idempotent on clean DB)", () => {
    const result = physicalDedupSharedAliases(db);
    expect(result).toMatchObject({ clustersProcessed: 0, peopleMerged: 0 });
  });

  test("two people share an email: merged to one canonical (earliest first_seen wins)", () => {
    const a = "11111111-1111-1111-1111-111111111111";
    const b = "22222222-2222-2222-2222-222222222222";
    insertPerson(a, { firstSeen: "2026-01-01" });
    insertPerson(b, { firstSeen: "2026-02-01" });
    insertAlias(a, "email", "alice@x.com");
    insertAlias(b, "email", "alice@x.com");

    const result = physicalDedupSharedAliases(db);

    expect(result).toMatchObject({ clustersProcessed: 1, peopleMerged: 1 });
    expect(personExists(a)).toBe(true);
    expect(personExists(b)).toBe(false);
    expect(getAliases(a)).toEqual([{ alias_type: "email", alias: "alice@x.com" }]);
  });

  test("shared-mailbox guard: different names on one email are NOT merged", () => {
    const a = "d1111111-1111-1111-1111-111111111111";
    const b = "d2222222-2222-2222-2222-222222222222";
    insertPerson(a, { firstSeen: "2026-01-01" });
    insertPerson(b, { firstSeen: "2026-02-01" });
    insertAlias(a, "email", "household@example.com");
    insertAlias(b, "email", "household@example.com");
    insertAlias(a, "name", "Alice Reeves");
    insertAlias(b, "name", "Bob Lopez");

    const result = physicalDedupSharedAliases(db);

    expect(result.peopleMerged).toBe(0);
    expect(personExists(a)).toBe(true);
    expect(personExists(b)).toBe(true); // distinct human not deleted
  });

  test("same name on a shared email still merges (not a shared mailbox)", () => {
    const a = "e1111111-1111-1111-1111-111111111111";
    const b = "e2222222-2222-2222-2222-222222222222";
    insertPerson(a, { firstSeen: "2026-01-01" });
    insertPerson(b, { firstSeen: "2026-02-01" });
    insertAlias(a, "email", "maya@example.com");
    insertAlias(b, "email", "maya@example.com");
    insertAlias(a, "name", "Maya Reeves");
    insertAlias(b, "name", "Maya Reeves");

    const result = physicalDedupSharedAliases(db);

    expect(result.peopleMerged).toBe(1);
    expect(personExists(a)).toBe(true);
    expect(personExists(b)).toBe(false);
  });

  test("self is protected from a different-named person on a shared address", () => {
    const self = "f0000000-0000-0000-0000-000000000002";
    const other = "f0000000-0000-0000-0000-000000000001";
    insertPerson(self, { firstSeen: "2026-04-01", isSelf: true });
    insertPerson(other, { firstSeen: "2026-01-01" });
    insertAlias(self, "email", "forward@example.com");
    insertAlias(other, "email", "forward@example.com");
    insertAlias(self, "name", "Sam Quinn");
    insertAlias(other, "name", "Pat Mercer");

    const result = physicalDedupSharedAliases(db);

    expect(result.peopleMerged).toBe(0);
    expect(personExists(self)).toBe(true);
    expect(personExists(other)).toBe(true); // family member not folded into self
  });

  test("self-person always wins, even with later first_seen", () => {
    const earlier = "00000000-0000-0000-0000-000000000001";
    const self = "00000000-0000-0000-0000-000000000002";
    insertPerson(earlier, { firstSeen: "2026-01-01" });
    insertPerson(self, { firstSeen: "2026-04-01", isSelf: true });
    insertAlias(earlier, "email", "me@x.com");
    insertAlias(self, "email", "me@x.com");

    const result = physicalDedupSharedAliases(db);

    expect(result.peopleMerged).toBe(1);
    expect(personExists(earlier)).toBe(false);
    expect(personExists(self)).toBe(true);
  });

  test("three people share an email: all collapse into one", () => {
    const a = "10000000-0000-0000-0000-00000000000a";
    const b = "20000000-0000-0000-0000-00000000000b";
    const c = "30000000-0000-0000-0000-00000000000c";
    insertPerson(a, { firstSeen: "2026-01-01" });
    insertPerson(b, { firstSeen: "2026-02-01" });
    insertPerson(c, { firstSeen: "2026-03-01" });
    for (const id of [a, b, c]) insertAlias(id, "email", "shared@x.com");

    const result = physicalDedupSharedAliases(db);

    expect(result.peopleMerged).toBe(2); // b and c folded into a
    expect(personExists(a)).toBe(true);
    expect(personExists(b)).toBe(false);
    expect(personExists(c)).toBe(false);
    const distinctOnEmail = db
      .prepare<
        [],
        { n: number }
      >("SELECT COUNT(DISTINCT person_id) AS n FROM person_aliases WHERE alias='shared@x.com'")
      .get()!.n;
    expect(distinctOnEmail).toBe(1);
  });

  test("multiple clusters processed independently", () => {
    const a1 = "a1111111-0000-0000-0000-000000000001";
    const a2 = "a1111111-0000-0000-0000-000000000002";
    const b1 = "b2222222-0000-0000-0000-000000000001";
    const b2 = "b2222222-0000-0000-0000-000000000002";
    insertPerson(a1, { firstSeen: "2026-01-01" });
    insertPerson(a2, { firstSeen: "2026-02-01" });
    insertPerson(b1, { firstSeen: "2026-03-01" });
    insertPerson(b2, { firstSeen: "2026-04-01" });
    insertAlias(a1, "email", "alice@x.com");
    insertAlias(a2, "email", "alice@x.com");
    insertAlias(b1, "phone", "+1");
    insertAlias(b2, "phone", "+1");

    const result = physicalDedupSharedAliases(db);

    expect(result.clustersProcessed).toBe(2);
    expect(result.peopleMerged).toBe(2);
    expect(personExists(a1)).toBe(true);
    expect(personExists(a2)).toBe(false);
    expect(personExists(b1)).toBe(true);
    expect(personExists(b2)).toBe(false);
  });

  test("cluster spanning multiple shared aliases collapses once", () => {
    // Same two people share BOTH an email and a phone — should be
    // detected as two clusters but the second pass finds the loser
    // already deleted and does nothing.
    const a = "aabbccdd-0000-0000-0000-00000000000a";
    const b = "aabbccdd-0000-0000-0000-00000000000b";
    insertPerson(a, { firstSeen: "2026-01-01" });
    insertPerson(b, { firstSeen: "2026-02-01" });
    insertAlias(a, "email", "shared@x.com");
    insertAlias(b, "email", "shared@x.com");
    insertAlias(a, "phone", "+15551234");
    insertAlias(b, "phone", "+15551234");

    const result = physicalDedupSharedAliases(db);

    // Two clusters detected (one per shared alias type), but only one
    // person was actually merged — the second cluster sees b already
    // deleted and skips.
    expect(result.peopleMerged).toBe(1);
    expect(personExists(a)).toBe(true);
    expect(personExists(b)).toBe(false);
    expect(
      getAliases(a)
        .map((al) => `${al.alias_type}=${al.alias}`)
        .sort(),
    ).toEqual(["email=shared@x.com", "phone=+15551234"]);
  });

  test("ignores name shares (only strong identifiers eligible)", () => {
    const a = randomUUID();
    const b = randomUUID();
    insertPerson(a, { canonicalName: "John Smith" });
    insertPerson(b, { canonicalName: "John Smith" });
    insertAlias(a, "name", "John Smith");
    insertAlias(b, "name", "John Smith");

    const result = physicalDedupSharedAliases(db);

    expect(result).toMatchObject({ clustersProcessed: 0, peopleMerged: 0 });
    expect(personExists(a)).toBe(true);
    expect(personExists(b)).toBe(true);
  });

  test("ignores already-merged duplicates (running again is a no-op)", () => {
    // Run dedup, then run again — second run should find nothing.
    const a = randomUUID();
    const b = randomUUID();
    insertPerson(a, { firstSeen: "2026-01-01" });
    insertPerson(b, { firstSeen: "2026-02-01" });
    insertAlias(a, "email", "x@y.com");
    insertAlias(b, "email", "x@y.com");
    physicalDedupSharedAliases(db);
    const second = physicalDedupSharedAliases(db);
    expect(second).toMatchObject({ clustersProcessed: 0, peopleMerged: 0 });
  });

  test("preserves doc-people across the merge", () => {
    const a = randomUUID();
    const b = randomUUID();
    insertPerson(a, { firstSeen: "2026-01-01" });
    insertPerson(b, { firstSeen: "2026-02-01" });
    insertAlias(a, "email", "alice@x.com");
    insertAlias(b, "email", "alice@x.com");
    insertDoc("d1");
    insertDoc("d2");
    insertDocPerson("d1", a, "sender");
    insertDocPerson("d2", b, "sender");

    physicalDedupSharedAliases(db);

    const docs = getDocPeople(a);
    expect(docs).toEqual([
      { document_id: "d1", role: "sender" },
      { document_id: "d2", role: "sender" },
    ]);
  });

  test("sticky logical merge: skips physical merge between rule-equivalent rows (different aliases, same canonical)", () => {
    // Setup: A is canonical, B is a logical-merge loser (B.merged_into = A).
    // Both happen to carry the same email — could be from a contact-card
    // re-seed cross-walking via merged_into and attaching the alias to A,
    // or from any pre-existing data overlap. Without sticky check, the
    // boot-time physicalDedupSharedAliases pass would silently delete B.
    const A = randomUUID();
    const B = randomUUID();
    insertPerson(A, { firstSeen: "2026-01-01" });
    insertPerson(B, { firstSeen: "2026-02-01" });
    insertAlias(A, "email", "shared@x.com");
    insertAlias(B, "email", "shared@x.com");
    // Mark B as a logical-merge loser of A.
    db.prepare("UPDATE people SET merged_into = ?, updated_at = ? WHERE id = ?").run(
      A,
      "2026-03-01",
      B,
    );

    const result = physicalDedupSharedAliases(db);

    // The cluster of two people was processed but ZERO physical merges
    // happened — both rows survive because they're rule-equivalent.
    expect(result.peopleMerged).toBe(0);
    expect(personExists(A)).toBe(true);
    expect(personExists(B)).toBe(true);
    // B's merged_into still points at A.
    const bRow = db
      .prepare<
        [string],
        { merged_into: string | null }
      >("SELECT merged_into FROM people WHERE id = ?")
      .get(B);
    expect(bRow?.merged_into).toBe(A);
  });

  test("sticky logical merge: still merges genuinely-distinct people (not in same equivalence class)", () => {
    // Sanity check: when two people share an alias and are NOT
    // rule-equivalent (both unmerged canonicals), the physical merge
    // proceeds as before.
    const A = randomUUID();
    const B = randomUUID();
    insertPerson(A, { firstSeen: "2026-01-01" });
    insertPerson(B, { firstSeen: "2026-02-01" });
    insertAlias(A, "email", "shared@x.com");
    insertAlias(B, "email", "shared@x.com");

    const result = physicalDedupSharedAliases(db);

    expect(result.peopleMerged).toBe(1);
    expect(personExists(A)).toBe(true);
    expect(personExists(B)).toBe(false);
  });

  test("never deletes an is_self person, even when not the only self", () => {
    // Hypothetical bad data: two is_self rows. We still pick one as
    // winner; the other is a "self loser". The primitive refuses to
    // delete an is_self loser — verify that surfaces as a skipped
    // merge with no data loss.
    const winner = randomUUID();
    const loser = randomUUID();
    insertPerson(winner, { isSelf: true, firstSeen: "2026-01-01" });
    insertPerson(loser, { isSelf: true, firstSeen: "2026-02-01" });
    insertAlias(winner, "email", "me@x.com");
    insertAlias(loser, "email", "me@x.com");

    const result = physicalDedupSharedAliases(db);

    // Winner is the earlier self (winner above). The "loser" is also
    // is_self=true, so the primitive refuses; the dedup function logs
    // a warning and counts zero merges for this cluster.
    expect(result.peopleMerged).toBe(0);
    expect(personExists(winner)).toBe(true);
    expect(personExists(loser)).toBe(true);
  });
});

describe("physicalDedupSharedAliases — yieldable", () => {
  test("yields between clusters and accumulates counts across a resume", () => {
    // Two independent clusters, each two people sharing one email.
    const a1 = randomUUID();
    const a2 = randomUUID();
    const b1 = randomUUID();
    const b2 = randomUUID();
    insertPerson(a1, { firstSeen: "2026-01-01" });
    insertPerson(a2, { firstSeen: "2026-02-01" });
    insertPerson(b1, { firstSeen: "2026-01-01" });
    insertPerson(b2, { firstSeen: "2026-02-01" });
    insertAlias(a1, "email", "cluster-a@x.com");
    insertAlias(a2, "email", "cluster-a@x.com");
    insertAlias(b1, "email", "cluster-b@x.com");
    insertAlias(b2, "email", "cluster-b@x.com");

    // A token that always requests → after the first cluster (one remains) the
    // function yields with the un-processed cluster.
    const first = physicalDedupSharedAliases(db, { requested: () => true });
    expect(first.done).toBe(false);
    expect(first.clustersProcessed).toBe(1);
    expect(first.peopleMerged).toBe(1);
    expect(first.resumeClusters).toHaveLength(1);

    // Resume with the carried state and a token that never requests → the
    // second cluster is processed and counts accumulate.
    const second = physicalDedupSharedAliases(
      db,
      { requested: () => false },
      {
        clusters: first.resumeClusters,
        clustersProcessed: first.clustersProcessed,
        peopleMerged: first.peopleMerged,
      },
    );
    expect(second.done).toBe(true);
    expect(second.clustersProcessed).toBe(2);
    expect(second.peopleMerged).toBe(2);

    // Both clusters collapsed to a single canonical (the earlier first_seen).
    expect(personExists(a1)).toBe(true);
    expect(personExists(a2)).toBe(false);
    expect(personExists(b1)).toBe(true);
    expect(personExists(b2)).toBe(false);
  });

  test("a stale carried cluster key whose members were already merged is a safe no-op", () => {
    const a1 = randomUUID();
    const a2 = randomUUID();
    insertPerson(a1, { firstSeen: "2026-01-01" });
    insertPerson(a2, { firstSeen: "2026-02-01" });
    insertAlias(a1, "email", "shared@x.com");
    insertAlias(a2, "email", "shared@x.com");

    // Collapse the cluster in a full pass first.
    const full = physicalDedupSharedAliases(db);
    expect(full.peopleMerged).toBe(1);

    // Now resume carrying the (now-collapsed) cluster key. Live re-resolution
    // sees <2 members and no-ops — no crash, no double-count.
    const resumed = physicalDedupSharedAliases(
      db,
      { requested: () => false },
      {
        clusters: [{ alias_type: "email", alias: "shared@x.com" }],
        clustersProcessed: 5,
        peopleMerged: 5,
      },
    );
    expect(resumed.done).toBe(true);
    expect(resumed.peopleMerged).toBe(5); // unchanged — the stale key merged nobody
    expect(personExists(a1)).toBe(true);
    expect(personExists(a2)).toBe(false);
  });
});
