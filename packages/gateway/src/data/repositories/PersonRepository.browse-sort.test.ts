// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * searchPeople browse ordering + the index that keeps it cheap.
 *
 * An empty query (the portal / iOS People list) must return people ordered
 * (is_self pinned first, then interaction_score_recent DESC, then doc_count
 * DESC), exclude merged people, and — critically — be satisfied by
 * idx_people_interaction_recent as an ordered index walk rather than a
 * full-table TEMP B-TREE sort of every person (the ~3.4s regression this
 * guards against).
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../schema.js";
import { searchPeople } from "./PersonRepository.js";
import type { Db } from "../types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

function insertPerson(p: {
  id: string;
  name: string;
  isSelf?: boolean;
  docCount?: number;
  scoreRecent?: number;
  mergedInto?: string;
}): void {
  db.prepare(
    `INSERT INTO people
       (id, canonical_name, source, merged_into, is_self, first_seen, last_seen,
        created_at, updated_at, doc_count, interaction_score_recent)
     VALUES (?, ?, 'contacts', ?, ?, '2026-01-01', '2026-06-01',
             '2026-01-01', '2026-06-01', ?, ?)`,
  ).run(p.id, p.name, p.mergedInto ?? null, p.isSelf ? 1 : 0, p.docCount ?? 0, p.scoreRecent ?? 0);
}

describe("searchPeople browse ordering", () => {
  test("pins self, then orders by interaction_score_recent, then doc_count; excludes merged", () => {
    insertPerson({ id: "self", name: "self-user", isSelf: true, scoreRecent: 0, docCount: 5 });
    insertPerson({ id: "top", name: "top-score", scoreRecent: 9.0, docCount: 100 });
    insertPerson({ id: "mid-hi", name: "tie-more-docs", scoreRecent: 5.0, docCount: 80 });
    insertPerson({ id: "mid-lo", name: "tie-fewer-docs", scoreRecent: 5.0, docCount: 50 });
    insertPerson({ id: "vol", name: "high-volume-no-score", scoreRecent: 0, docCount: 200 });
    insertPerson({
      id: "gone",
      name: "merged-away",
      scoreRecent: 99,
      docCount: 999,
      mergedInto: "top",
    });

    const rows = searchPeople(db, "", 10);

    // self pinned first (despite score 0); then score DESC; doc_count breaks
    // the 5.0 tie (mid-hi's 80 docs before mid-lo's 50); the merged "gone" is
    // excluded; vol's high doc_count can't outrank a nonzero score.
    expect(rows.map((r) => r.id)).toEqual(["self", "top", "mid-hi", "mid-lo", "vol"]);
    expect(rows.find((r) => r.id === "self")?.isSelf).toBe(true);
  });

  test("browse plan uses idx_people_interaction_recent, not a TEMP B-TREE sort", () => {
    for (let i = 0; i < 40; i++) {
      insertPerson({ id: `p${i}`, name: `Person ${i}`, scoreRecent: i, docCount: i * 2 });
    }
    const plan = db
      .prepare<[number], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT p.id FROM people p
         WHERE p.merged_into IS NULL
         ORDER BY p.is_self DESC, p.interaction_score_recent DESC, p.doc_count DESC
         LIMIT ?`,
      )
      .all(25)
      .map((r) => r.detail)
      .join(" | ");

    expect(plan).toContain("idx_people_interaction_recent");
    expect(plan).not.toContain("TEMP B-TREE");
  });

  test("keyset pages do not shift when a higher-ranked person is inserted", () => {
    insertPerson({ id: "p1", name: "First", scoreRecent: 10, docCount: 4 });
    insertPerson({ id: "p2", name: "Second", scoreRecent: 8, docCount: 3 });
    insertPerson({ id: "p3", name: "Third", scoreRecent: 8, docCount: 3 });
    insertPerson({ id: "p4", name: "Fourth", scoreRecent: 2, docCount: 1 });

    const first = searchPeople(db, "", 2);
    expect(first.map((person) => person.id)).toEqual(["p1", "p2"]);

    // This row belongs before the already-rendered page. An OFFSET walk would
    // now return p2 twice; the complete score/count/id keyset starts after it.
    insertPerson({ id: "p0", name: "Inserted", scoreRecent: 12, docCount: 5 });
    const boundary = first[first.length - 1];
    const second = searchPeople(db, "", 2, {
      after: {
        isSelf: boundary.isSelf ? 1 : 0,
        interactionScoreRecent: boundary.interactionScoreRecent,
        documentCount: boundary.documentCount,
        id: boundary.id,
      },
    });

    expect(second.map((person) => person.id)).toEqual(["p3", "p4"]);
  });
});

function linkDoc(personId: string, docId: string, sourceId: string): void {
  // The FK to documents is enforced, so the document must exist first.
  db.prepare(
    `INSERT OR IGNORE INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'prov', ?, ?, 't', 'c', 'h', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(docId, sourceId, `ext-${docId}`);
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, 'sender', ?)`,
  ).run(docId, personId, sourceId);
}

describe("searchPeople source_ids strip (covering index, no documents join)", () => {
  test("returns the per-person deduped set of source_ids", () => {
    insertPerson({ id: "alice", name: "Alice", scoreRecent: 5, docCount: 3 });
    insertPerson({ id: "bob", name: "Bob", scoreRecent: 4, docCount: 1 });
    // Alice: docs across gmail + whatsapp, gmail appears twice (must dedupe).
    linkDoc("alice", "d1", "gmail:alice@example.com");
    linkDoc("alice", "d2", "gmail:alice@example.com");
    linkDoc("alice", "d3", "whatsapp:+15550100");
    // Bob: a single source.
    linkDoc("bob", "d4", "notion:workspace");

    const rows = searchPeople(db, "", 10);
    const alice = rows.find((r) => r.id === "alice")!;
    const bob = rows.find((r) => r.id === "bob")!;
    expect([...alice.sourceIds].sort()).toEqual(["gmail:alice@example.com", "whatsapp:+15550100"]);
    expect(bob.sourceIds).toEqual(["notion:workspace"]);
  });

  test("a person with no documents has an empty source_ids strip", () => {
    insertPerson({ id: "solo", name: "Solo", scoreRecent: 1, docCount: 0 });
    const rows = searchPeople(db, "", 10);
    expect(rows.find((r) => r.id === "solo")!.sourceIds).toEqual([]);
  });

  test("the source_ids subquery is index-only: covering index, no documents / TEMP B-TREE", () => {
    const plan = db
      .prepare<[], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT (SELECT GROUP_CONCAT(DISTINCT dp.source_id)
                   FROM document_people dp
                   WHERE dp.person_id = p.id) AS source_ids
         FROM people p WHERE p.merged_into IS NULL`,
      )
      .all()
      .map((r) => r.detail)
      .join(" | ");

    expect(plan).toContain("idx_document_people_person_source");
    expect(plan).toContain("COVERING INDEX");
    // No random probes into documents, no temp b-tree for the DISTINCT.
    expect(plan).not.toContain("sqlite_autoindex_documents");
    expect(plan).not.toMatch(/SEARCH d\b/);
    expect(plan).not.toContain("TEMP B-TREE");
  });
});
