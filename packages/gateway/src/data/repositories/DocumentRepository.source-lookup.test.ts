// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { sourcePrefixPredicate } from "../source-addressing.js";
import { findDocumentIdBySourceExternalId } from "./DocumentRepository.js";

let path: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  path = `/tmp/omnesis-document-source-lookup-${randomUUID()}.db`;
  db = createDatabase(path);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});

function insert(
  id: string,
  sourceId: string,
  externalId: string,
  streamId = "",
  providerId = sourceId.split(":")[0],
): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content,
                            content_hash, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '', '', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
  ).run(id, providerId, sourceId, externalId, streamId);
}

/**
 * The analytics catalog collapses a single-owner table's source id to the bare
 * type, so the row→document inverse arrives named either way. Naming the type
 * has to reach the account; naming an account must not reach a sibling.
 */
describe("findDocumentIdBySourceExternalId", () => {
  test("a bare type reaches the account that holds the external id", () => {
    insert("doc-1", "example-runs:52101", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBe("doc-1");
  });

  test("a named account does not reach a sibling account", () => {
    insert("doc-1", "example-runs:52101", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs:52102", "activity-7")).toBeNull();
  });

  test("a named account does not reach an account whose id extends it", () => {
    // `parseSourceId` splits on the first colon, so `52101:archive` is a whole
    // account id of its own — a different account, not a child of `52101`.
    insert("doc-1", "example-runs:52101:archive", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs:52101", "activity-7")).toBeNull();
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBe("doc-1");
  });

  test("a type is not a string prefix: it does not reach a differently named source", () => {
    insert("doc-1", "example-runs-archive:52101", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBeNull();
  });

  test("the exact account is preferred over another account of the same type", () => {
    insert("doc-1", "example-runs:52101", "activity-7");
    insert("doc-2", "example-runs", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBe("doc-2");
  });

  test("a named stream selects within it", () => {
    insert("doc-1", "example-runs:52101", "activity-7", "phone-a");
    insert("doc-2", "example-runs:52101", "activity-7", "phone-b");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7", "phone-b")).toBe(
      "doc-2",
    );
  });
});

describe("findDocumentIdBySourceExternalId with ids that collide", () => {
  test("an id differing only in case is a different document", () => {
    insert("doc-upper", "example-runs:52101", "Activity-7");
    insert("doc-lower", "example-runs:52102", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "Activity-7")).toBe("doc-upper");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBe("doc-lower");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "ACTIVITY-7")).toBeNull();
    expect(findDocumentIdBySourceExternalId(db, "example-runs:52101", "activity-7")).toBeNull();
  });

  test("an id differing only in the case of a non-ASCII letter is a different document", () => {
    insert("doc-upper", "example-runs:52101", "Étape-1");
    insert("doc-lower", "example-runs:52101", "étape-1");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "Étape-1")).toBe("doc-upper");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "étape-1")).toBe("doc-lower");
  });

  test("an id holding LIKE wildcards is matched literally", () => {
    insert("doc-wild", "example-runs:52101", "lap_1%");
    insert("doc-plain", "example-runs:52101", "lapX1-and-more");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "lap_1%")).toBe("doc-wild");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "lapX1%")).toBeNull();
  });

  test("a bare type holding the id under two accounts answers with the first account", () => {
    insert("doc-b", "example-runs:52102", "activity-7");
    insert("doc-a", "example-runs:52101", "activity-7");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBe("doc-a");
  });

  test("an id held under one source id by two providers answers in a fixed order", () => {
    // Not a state the gateway writes, but the unique key allows it: a bare
    // type orders the rows by provider, a named account by insertion.
    insert("doc-z", "example-runs:52101", "activity-7", "", "zeta-provider");
    insert("doc-a", "example-runs:52101", "activity-7", "", "alpha-provider");
    expect(findDocumentIdBySourceExternalId(db, "example-runs", "activity-7")).toBe("doc-a");
    expect(findDocumentIdBySourceExternalId(db, "example-runs:52101", "activity-7")).toBe("doc-z");
  });
});

/**
 * The same lookup written as a plain filter, with no index to seek: what the
 * function must answer for every combination of source id, external id and
 * stream, read from the whole table.
 */
function lookupByScan(sourceId: string, externalId: string, streamId?: string): string | null {
  const predicate = sourcePrefixPredicate("source_id", [sourceId]);
  const rows = db
    .prepare<
      unknown[],
      { id: string; provider_id: string; source_id: string; stream_id: string; rowid: number }
    >(
      `SELECT id, provider_id, source_id, stream_id, rowid FROM documents NOT INDEXED
        WHERE external_id = ? AND (${predicate.sql}) AND (? = '' OR stream_id = ?)`,
    )
    .all(externalId, ...predicate.params, streamId ?? "", streamId ?? "");
  const named = sourceId.includes(":");
  rows.sort(
    (a, b) =>
      Number(b.source_id === sourceId) - Number(a.source_id === sourceId) ||
      compareBinary(a.stream_id, b.stream_id) ||
      (named
        ? a.rowid - b.rowid
        : compareBinary(a.provider_id, b.provider_id) || compareBinary(a.source_id, b.source_id)),
  );
  return rows[0]?.id ?? null;
}

function compareBinary(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

describe("findDocumentIdBySourceExternalId against a full scan", () => {
  test("answers exactly what a scan of the table answers", () => {
    const rows: Array<[string, string, string?, string?]> = [
      ["example-runs:52101", "activity-1"],
      ["example-runs:52102", "activity-1"],
      ["example-runs", "activity-2"],
      ["example-runs:52101", "ACTIVITY-3"],
      ["example-runs:52102", "activity-3"],
      ["example-runs:52101:archive", "activity-4"],
      ["example-runs-archive:52101", "activity-1"],
      ["example_runs:1", "activity-5"],
      ["exampleXruns:1", "activity-5"],
      ["example-runs:52101", "activity-6", "phone-a"],
      ["example-runs:52101", "activity-6", "phone-b"],
      ["example-runs:52101", "activity-6", ""],
      ["example-runs:52102", "activity-7", "phone-b"],
      ["example-runs:52101", "activity-7", "phone-a"],
      ["example-runs:52101", "Étape-8"],
      ["example-runs:52101", "étape-8"],
      ["example-runs:52101", "activity-9", "", "zeta-provider"],
      ["example-runs:52101", "activity-9", "", "alpha-provider"],
      ["example-runs:52101", "lap_1%"],
      ["example-runs:52101", "lapX1-and-more"],
    ];
    rows.forEach(([sourceId, externalId, streamId, providerId], i) =>
      insert(`doc-${i}`, sourceId, externalId, streamId, providerId),
    );
    for (let i = 0; i < 40; i++) insert(`filler-${i}`, `example-notes:${i % 3}`, `activity-${i}`);

    const sourceIds = [
      "example-runs",
      "example-runs:52101",
      "example-runs:52102",
      "example-runs:52101:archive",
      "example-runs-archive",
      "example_runs",
      "EXAMPLE-RUNS",
      "example-runs:ACCT",
      "example-notes",
      "missing",
      "",
    ];
    const externalIds = [
      ...new Set(rows.map(([, externalId]) => externalId)),
      "Activity-1",
      "ÉTAPE-8",
      "activity-12",
      "lap%",
      "",
    ];
    const streams = [undefined, "", "phone-a", "phone-b", "phone-z"];
    let found = 0;
    for (const sourceId of sourceIds) {
      for (const externalId of externalIds) {
        for (const streamId of streams) {
          const expected = lookupByScan(sourceId, externalId, streamId);
          if (expected) found++;
          expect(
            findDocumentIdBySourceExternalId(db, sourceId, externalId, streamId),
            `${sourceId} / ${externalId} / ${streamId}`,
          ).toBe(expected);
        }
      }
    }
    // The cross product reaches documents, not only misses.
    expect(found).toBeGreaterThan(50);
  });
});

describe("findDocumentIdBySourceExternalId query plan", () => {
  /** The plan of the statement the lookup prepares for `sourceId`. */
  function planFor(sourceId: string): string[] {
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    }) as typeof db.prepare;
    try {
      findDocumentIdBySourceExternalId(db, sourceId, "activity-7");
    } finally {
      db.prepare = prepare;
    }
    expect(statements).toHaveLength(1);
    const sql = statements[0]!;
    const params = Array.from(sql.matchAll(/\?/g), () => "x");
    return db
      .prepare<string[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail);
  }

  // A bare type's `type:%` half is a case-folding LIKE, which no BINARY index
  // on source_id serves; without a seek on the external id the lookup reads an
  // index entry for every document in the store.
  test.each(["example-runs", "example-runs:52101"])(
    "seeks the external id for %s instead of scanning the documents",
    (sourceId) => {
      const plan = planFor(sourceId);
      expect(plan.some((step) => step.startsWith("SCAN documents"))).toBe(false);
      expect(plan).toContainEqual(
        expect.stringContaining(
          "SEARCH documents USING INDEX idx_documents_external_id_source (<expr>=?",
        ),
      );
    },
  );
});
