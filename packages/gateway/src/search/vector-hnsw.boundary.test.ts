// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boundary test for the vector `dateTo` post-filter. Pins the exact endpoint
 * the mutation tester flips: a row whose `source_created_at` EQUALS `dateTo`
 * must be INCLUDED (the window is inclusive of the upper bound). The Phase-4
 * coverage suite uses strictly-interior timestamps, so this on-the-line
 * fixture is what catches the `>` -> `>=` flip.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  upsertChunks,
  type ChunkUpsertInput,
} from "../indexer/db.js";
import { hnswSearchCandidates } from "./vector-hnsw.js";
import type { UsearchReadHandle } from "../indexer/usearch-index.js";
import type { SearchFilters } from "./types.js";
import { closeTempDb } from "./test-utils.js";

let db: Db;

beforeEach(() => {
  db = createIndexDatabase(`/tmp/omnesis-vector-hnsw-boundary-${randomUUID()}.db`);
});

afterEach(() => {
  closeTempDb(db);
});

const QUERY_VEC = new Float32Array(EMBEDDING_DIM).fill(0.01);

function chunk(
  overrides: Partial<ChunkUpsertInput> & { id: string; documentId: string },
): ChunkUpsertInput {
  return {
    chunkIndex: 0,
    content: "",
    embedding: new Float32Array(EMBEDDING_DIM).fill(0),
    sourceId: "gmail",
    documentType: "email",
    title: "title",
    sourceCreatedAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

function rowidOf(documentId: string): bigint {
  const row = db
    .prepare<
      [string],
      { rowid: number }
    >("SELECT rowid FROM chunks WHERE document_id = ? AND chunk_index = 0")
    .get(documentId);
  if (!row) throw new Error(`no chunk for ${documentId}`);
  return BigInt(row.rowid);
}

function stubUsearch(entries: Array<{ key: bigint; distance: number }>): UsearchReadHandle {
  return {
    search(_vector: Float32Array, k: number) {
      return entries.slice(0, k);
    },
    maybeRefresh() {},
    reopen() {},
    close() {},
    size() {
      return entries.length;
    },
  } as unknown as UsearchReadHandle;
}

describe("hnswSearchCandidates — dateTo upper bound is inclusive (m8)", () => {
  // Kills gateway-search-m8: `row.source_created_at > filters.dateTo` ->
  // `>= filters.dateTo`. A row whose created-at EQUALS dateTo must survive
  // (the upper bound is inclusive). The mutant would drop the on-the-line
  // row.
  test("a row created EXACTLY at dateTo is included", () => {
    const dateTo = "2026-05-21T00:00:00Z";
    upsertChunks(db, [
      // Exactly on the boundary — must be kept.
      chunk({ id: "edge", documentId: "dEdge", sourceCreatedAt: dateTo }),
      // One second past the boundary — must be dropped under both operators.
      chunk({ id: "after", documentId: "dAfter", sourceCreatedAt: "2026-05-21T00:00:01Z" }),
      // Before the boundary — kept under both operators.
      chunk({ id: "before", documentId: "dBefore", sourceCreatedAt: "2026-05-20T12:00:00Z" }),
    ]);
    const entries = [
      { key: rowidOf("dEdge"), distance: 0.1 },
      { key: rowidOf("dAfter"), distance: 0.2 },
      { key: rowidOf("dBefore"), distance: 0.3 },
    ];
    const filters: SearchFilters = { dateTo };
    const out = hnswSearchCandidates(stubUsearch(entries), db, QUERY_VEC, filters, 10);

    // Correct (`>`): dEdge (== dateTo, not > dateTo) is kept; dBefore kept;
    // dAfter dropped. Mutant (`>=`): dEdge (== dateTo) is ALSO dropped, so
    // it disappears from the result, failing the inclusion assertion.
    const ids = out.map((c) => c.documentId).sort();
    expect(ids).toEqual(["dBefore", "dEdge"]);
    expect(ids).toContain("dEdge");
  });
});
