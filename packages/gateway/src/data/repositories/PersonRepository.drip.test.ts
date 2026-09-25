// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../schema.js";
import { runMigrations } from "../migrations.js";
import {
  computePeopleCounts,
  computePeopleCountsChunk,
  peopleCountsChunkSql,
  zeroPeopleCountsForLosers,
  type PeopleCountRow,
  type PeopleCountsChunkResult,
} from "./PersonRepository.js";

type Db = Database.Database;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

const NOW = "2026-01-01T00:00:00Z";

/** Insert a person row with sensible defaults. */
function insertPerson(id: string, opts: { mergedInto?: string; isSelf?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, merged_into, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `Name ${id}`, opts.mergedInto ?? null, "test", opts.isSelf ? 1 : 0, NOW, NOW, NOW, NOW);
}

/** Insert a minimal document row. */
function insertDocument(id: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "prov", "src", id, "", "", "h", "{}", NOW, NOW, NOW, NOW);
}

/** Link a person to a document. */
function linkDocPerson(documentId: string, personId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, ?)`,
  ).run(documentId, personId, "participant", "src");
}

/** Insert an alias for a person. */
function insertAlias(personId: string, alias: string, aliasType = "email"): void {
  const id = `${personId}-${aliasType}-${alias}`;
  db.prepare(
    `INSERT OR IGNORE INTO person_aliases (id, person_id, alias, alias_type, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, personId, alias, aliasType, NOW);
}

/**
 * Accumulate all chunks from the paginated function into a flat list,
 * using the given batchSize.
 */
function drainChunks(batchSize: number): PeopleCountRow[] {
  let cursor: string | null = null;
  const accumulated: PeopleCountRow[] = [];
  do {
    const chunk: PeopleCountsChunkResult = computePeopleCountsChunk(db, cursor, batchSize);
    accumulated.push(...chunk.rows);
    cursor = chunk.nextCursor;
  } while (cursor !== null);
  return accumulated;
}

/**
 * Convert an array of PeopleCountRow to a Map keyed by personId for
 * order-independent comparison.
 */
function toMap(rows: PeopleCountRow[]): Map<string, { docCount: number; aliasCount: number }> {
  const m = new Map<string, { docCount: number; aliasCount: number }>();
  for (const r of rows) {
    m.set(r.personId, { docCount: r.docCount, aliasCount: r.aliasCount });
  }
  return m;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computePeopleCountsChunk equivalence", () => {
  test("empty people table — both return empty", () => {
    const full = computePeopleCounts(db);
    const chunked = drainChunks(10);

    expect(full).toEqual([]);
    expect(chunked).toEqual([]);
  });

  test("single canonical person — same count", () => {
    insertPerson("p1");
    insertDocument("d1");
    insertDocument("d2");
    linkDocPerson("d1", "p1");
    linkDocPerson("d2", "p1");
    insertAlias("p1", "alice@example.com");

    const full = computePeopleCounts(db);
    const chunked = drainChunks(10);

    // The unbounded query returns every person (canonical + losers).
    // With a single canonical and no losers, both should match exactly.
    const fullCanonical = full.filter((r) => r.personId === "p1");
    expect(fullCanonical).toHaveLength(1);
    expect(fullCanonical[0]).toEqual({ personId: "p1", docCount: 2, aliasCount: 1 });

    expect(chunked).toHaveLength(1);
    expect(chunked[0]).toEqual({ personId: "p1", docCount: 2, aliasCount: 1 });
  });

  test("multiple canonical people with small batch — paginated accumulation matches unbounded", () => {
    // Create 5 canonical people with varying doc/alias counts.
    for (let i = 1; i <= 5; i++) {
      const pid = `p${String(i).padStart(2, "0")}`;
      insertPerson(pid);
      // Each person gets i documents and i aliases.
      for (let j = 1; j <= i; j++) {
        const docId = `d-${pid}-${j}`;
        insertDocument(docId);
        linkDocPerson(docId, pid);
        insertAlias(pid, `alias${j}@example.com`);
      }
    }

    const full = computePeopleCounts(db);
    // Paginate with batchSize=2 across 5 people (should take 3 pages).
    const chunked = drainChunks(2);

    // The unbounded function returns ALL people rows (canonical only here
    // since we created no losers). The chunked function only returns
    // canonical rows. Both should agree on canonical rows.
    const fullMap = toMap(full);
    const chunkedMap = toMap(chunked);

    expect(chunked).toHaveLength(5);
    for (const [pid, counts] of chunkedMap) {
      expect(fullMap.get(pid)).toEqual(counts);
    }
  });

  test("merged losers — unbounded includes losers with 0, paginated only returns canonicals", () => {
    insertPerson("canonical-1");
    insertPerson("loser-1", { mergedInto: "canonical-1" });
    insertPerson("loser-2", { mergedInto: "canonical-1" });

    const full = computePeopleCounts(db);
    const chunked = drainChunks(10);

    // Unbounded returns rows for canonical AND losers.
    const fullIds = full.map((r) => r.personId).sort();
    expect(fullIds).toEqual(["canonical-1", "loser-1", "loser-2"]);

    // Losers have 0 counts in the unbounded result (no docs/aliases
    // roll up onto loser rows — they roll up onto the canonical).
    const loserRows = full.filter((r) => r.personId.startsWith("loser"));
    for (const r of loserRows) {
      expect(r.docCount).toBe(0);
      expect(r.aliasCount).toBe(0);
    }

    // Paginated only returns canonical people (WHERE merged_into IS NULL).
    const chunkedIds = chunked.map((r) => r.personId);
    expect(chunkedIds).toEqual(["canonical-1"]);
  });

  test("zeroPeopleCountsForLosers zeros out merged losers", () => {
    insertPerson("canonical-1");
    insertPerson("loser-1", { mergedInto: "canonical-1" });

    // Manually set non-zero counts on the loser to simulate stale data.
    db.prepare("UPDATE people SET doc_count = 5, alias_count = 3 WHERE id = ?").run("loser-1");

    const before = db
      .prepare<
        [string],
        { doc_count: number; alias_count: number }
      >("SELECT doc_count, alias_count FROM people WHERE id = ?")
      .get("loser-1");
    expect(before).toEqual({ doc_count: 5, alias_count: 3 });

    const result = zeroPeopleCountsForLosers(db);
    expect(result.updated).toBe(1);

    const after = db
      .prepare<
        [string],
        { doc_count: number; alias_count: number }
      >("SELECT doc_count, alias_count FROM people WHERE id = ?")
      .get("loser-1");
    expect(after).toEqual({ doc_count: 0, alias_count: 0 });
  });

  test("document counts roll up via merge — loser docs attributed to canonical", () => {
    insertPerson("person-a");
    insertPerson("person-b", { mergedInto: "person-a" });

    // Person A has 3 docs directly.
    for (let i = 1; i <= 3; i++) {
      insertDocument(`da-${i}`);
      linkDocPerson(`da-${i}`, "person-a");
    }
    // Person B (merged into A) has 2 docs.
    for (let i = 1; i <= 2; i++) {
      insertDocument(`db-${i}`);
      linkDocPerson(`db-${i}`, "person-b");
    }

    const full = computePeopleCounts(db);
    const chunked = drainChunks(10);

    // Canonical should show 5 docs (3 own + 2 from loser).
    const fullCanonical = full.find((r) => r.personId === "person-a");
    expect(fullCanonical?.docCount).toBe(5);

    const chunkedCanonical = chunked.find((r) => r.personId === "person-a");
    expect(chunkedCanonical?.docCount).toBe(5);

    // Both functions agree on the canonical's doc count.
    expect(chunkedCanonical?.docCount).toBe(fullCanonical?.docCount);
  });

  test("alias counts roll up via merge — loser aliases attributed to canonical", () => {
    insertPerson("person-x");
    insertPerson("person-y", { mergedInto: "person-x" });

    // Person X has 2 aliases directly.
    insertAlias("person-x", "x1@example.com");
    insertAlias("person-x", "x2@example.com");

    // Person Y (merged into X) has 3 aliases.
    insertAlias("person-y", "y1@example.com");
    insertAlias("person-y", "y2@example.com");
    insertAlias("person-y", "y3@example.com");

    const full = computePeopleCounts(db);
    const chunked = drainChunks(10);

    // Canonical should show 5 aliases (2 own + 3 from loser).
    const fullCanonical = full.find((r) => r.personId === "person-x");
    expect(fullCanonical?.aliasCount).toBe(5);

    const chunkedCanonical = chunked.find((r) => r.personId === "person-x");
    expect(chunkedCanonical?.aliasCount).toBe(5);

    // Both functions agree on the canonical's alias count.
    expect(chunkedCanonical?.aliasCount).toBe(fullCanonical?.aliasCount);
  });

  test("mixed canonical + loser graph — full equivalence on canonical subset", () => {
    // Build a small graph: 3 canonicals, 2 losers, documents + aliases.
    insertPerson("c1");
    insertPerson("c2");
    insertPerson("c3");
    insertPerson("l1", { mergedInto: "c1" });
    insertPerson("l2", { mergedInto: "c2" });

    // Documents: c1 gets 1 direct + 2 via l1, c2 gets 1 via l2, c3 gets 0.
    insertDocument("d-c1");
    linkDocPerson("d-c1", "c1");
    insertDocument("d-l1-1");
    linkDocPerson("d-l1-1", "l1");
    insertDocument("d-l1-2");
    linkDocPerson("d-l1-2", "l1");
    insertDocument("d-l2");
    linkDocPerson("d-l2", "l2");

    // Aliases: c1 has 1, l1 has 1, c2 has 2, l2 has 1, c3 has 3.
    insertAlias("c1", "c1@example.com");
    insertAlias("l1", "l1@example.com");
    insertAlias("c2", "c2a@example.com");
    insertAlias("c2", "c2b@example.com");
    insertAlias("l2", "l2@example.com");
    insertAlias("c3", "c3a@example.com");
    insertAlias("c3", "c3b@example.com");
    insertAlias("c3", "c3c@example.com");

    const full = computePeopleCounts(db);
    const chunked = drainChunks(2); // small batch to force multiple pages

    const fullMap = toMap(full);
    const chunkedMap = toMap(chunked);

    // Chunked only returns canonical rows.
    expect(chunked).toHaveLength(3);
    expect([...chunkedMap.keys()].sort()).toEqual(["c1", "c2", "c3"]);

    // c1: 3 docs (1 own + 2 via l1), 2 aliases (1 own + 1 via l1)
    expect(chunkedMap.get("c1")).toEqual({ docCount: 3, aliasCount: 2 });
    expect(fullMap.get("c1")).toEqual({ docCount: 3, aliasCount: 2 });

    // c2: 1 doc (via l2), 3 aliases (2 own + 1 via l2)
    expect(chunkedMap.get("c2")).toEqual({ docCount: 1, aliasCount: 3 });
    expect(fullMap.get("c2")).toEqual({ docCount: 1, aliasCount: 3 });

    // c3: 0 docs, 3 aliases (all own)
    expect(chunkedMap.get("c3")).toEqual({ docCount: 0, aliasCount: 3 });
    expect(fullMap.get("c3")).toEqual({ docCount: 0, aliasCount: 3 });
  });

  test("pagination cursor advances correctly with exact batch boundaries", () => {
    // 4 canonical people, batchSize=2 — exactly 2 full pages, no partial.
    insertPerson("a");
    insertPerson("b");
    insertPerson("c");
    insertPerson("d");

    const page1 = computePeopleCountsChunk(db, null, 2);
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = computePeopleCountsChunk(db, page1.nextCursor, 2);
    expect(page2.rows).toHaveLength(2);
    expect(page2.nextCursor).not.toBeNull();

    const page3 = computePeopleCountsChunk(db, page2.nextCursor, 2);
    expect(page3.rows).toHaveLength(0);
    expect(page3.nextCursor).toBeNull();

    // All 4 people covered across pages 1+2.
    const allIds = [...page1.rows, ...page2.rows].map((r) => r.personId).sort();
    expect(allIds).toEqual(["a", "b", "c", "d"]);
  });

  test("batchSize=1 still accumulates correctly", () => {
    insertPerson("p1");
    insertPerson("p2");
    insertPerson("p3");
    insertDocument("d1");
    linkDocPerson("d1", "p1");
    insertAlias("p2", "hello@example.com");

    const full = computePeopleCounts(db);
    const chunked = drainChunks(1);

    const fullMap = toMap(full);
    const chunkedMap = toMap(chunked);

    expect(chunked).toHaveLength(3);
    for (const [pid, counts] of chunkedMap) {
      expect(fullMap.get(pid)).toEqual(counts);
    }
  });

  test("zeroPeopleCountsForLosers is idempotent and skips already-zero losers", () => {
    insertPerson("canon");
    insertPerson("loser-a", { mergedInto: "canon" });
    insertPerson("loser-b", { mergedInto: "canon" });

    // Both losers already at default 0.
    const first = zeroPeopleCountsForLosers(db);
    expect(first.updated).toBe(0); // no-op: already zero

    // Set one to non-zero.
    db.prepare("UPDATE people SET doc_count = 10 WHERE id = ?").run("loser-a");
    const second = zeroPeopleCountsForLosers(db);
    expect(second.updated).toBe(1); // only loser-a had non-zero

    // Third call is no-op again.
    const third = zeroPeopleCountsForLosers(db);
    expect(third.updated).toBe(0);
  });
});

describe("computePeopleCountsChunk — bounded by its batch, equal to the old shape", () => {
  /**
   * The query this replaced, kept as the oracle. It filtered the graph
   * through `COALESCE(merged_into, id)` — correct, and unservable by any
   * index. The rewrite must agree with it on every graph, so it stays here
   * as the specification rather than in a comment.
   */
  function referenceCounts(cursor: string, batchSize: number) {
    return db
      .prepare<[string, number], { person_id: string; doc_count: number; alias_count: number }>(
        `WITH batch AS (
           SELECT id FROM people WHERE merged_into IS NULL AND id > ? ORDER BY id LIMIT ?
         )
         SELECT b.id AS person_id,
           COALESCE(d.cnt, 0) AS doc_count,
           COALESCE(a.cnt, 0) AS alias_count
         FROM batch b
         LEFT JOIN (
           SELECT COALESCE(p2.merged_into, p2.id) AS canonical, COUNT(DISTINCT dp.document_id) AS cnt
           FROM document_people dp JOIN people p2 ON p2.id = dp.person_id
           WHERE COALESCE(p2.merged_into, p2.id) IN (SELECT id FROM batch)
           GROUP BY canonical
         ) d ON d.canonical = b.id
         LEFT JOIN (
           SELECT COALESCE(p2.merged_into, p2.id) AS canonical, COUNT(*) AS cnt
           FROM person_aliases pa JOIN people p2 ON p2.id = pa.person_id
           WHERE COALESCE(p2.merged_into, p2.id) IN (SELECT id FROM batch)
           GROUP BY canonical
         ) a ON a.canonical = b.id`,
      )
      .all(cursor, batchSize)
      .map((r) => ({ personId: r.person_id, docCount: r.doc_count, aliasCount: r.alias_count }));
  }

  test("agrees with the old query across merges, losers, shared documents and aliases", () => {
    // A deliberately awkward graph: a canonical with two losers, a
    // canonical with none, a loser sharing a document with its winner (so
    // DISTINCT matters), a person with only aliases, and a person with
    // nothing at all.
    insertPerson("p-alone");
    insertPerson("p-win");
    insertPerson("p-lose-a", { mergedInto: "p-win" });
    insertPerson("p-lose-b", { mergedInto: "p-win" });
    insertPerson("p-aliases-only");
    insertPerson("p-empty");

    for (const d of ["d1", "d2", "d3", "d4"]) insertDocument(d);
    linkDocPerson("d1", "p-win");
    linkDocPerson("d1", "p-lose-a"); // same document, both sides of a merge
    linkDocPerson("d2", "p-lose-a");
    linkDocPerson("d3", "p-lose-b");
    linkDocPerson("d4", "p-alone");

    insertAlias("p-win", "win@example.com");
    insertAlias("p-lose-a", "lose-a@example.com");
    insertAlias("p-lose-b", "lose-b@example.com");
    insertAlias("p-aliases-only", "solo@example.com");
    insertAlias("p-aliases-only", "solo.alt@example.com");

    expect(toMap(drainChunks(1000))).toEqual(toMap(referenceCounts("", 1000)));
    // And chunk-by-chunk, so batching cannot hide a disagreement.
    for (const size of [1, 2, 3]) {
      expect(toMap(drainChunks(size))).toEqual(toMap(referenceCounts("", 1000)));
    }
    // The merged pair rolls up: d1 counted once, plus d2 and d3.
    expect(toMap(drainChunks(1000)).get("p-win")).toEqual({ docCount: 3, aliasCount: 3 });
  });

  test("reads its edges through the person_id indexes", () => {
    insertPerson("p-plan");
    const plan = db
      .prepare<[string, number], { detail: string }>(`EXPLAIN QUERY PLAN ${peopleCountsChunkSql()}`)
      .all("", 1000)
      .map((r) => r.detail);

    // Edges are found by person id, one indexed lookup per member…
    expect(
      plan.some((d) => /SEARCH dp USING (COVERING )?INDEX idx_document_people_person/.test(d)),
    ).toBe(true);
    expect(
      plan.some((d) => /SEARCH pa USING (COVERING )?INDEX idx_person_aliases_person/.test(d)),
    ).toBe(true);
    // …and the members of the batch by following merged_into from it,
    // rather than walking every merged person in the database.
    expect(plan.some((d) => /SEARCH p USING INDEX idx_people_merged/.test(d))).toBe(true);
    // …never by walking an edge table and testing each row.
    expect(plan.some((d) => /^SCAN (dp|document_people)\b/.test(d))).toBe(false);
    expect(plan.some((d) => /^SCAN (pa|person_aliases)\b/.test(d))).toBe(false);
  });
});
