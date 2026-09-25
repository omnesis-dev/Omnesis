// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Boundary tests for `filterCommonTokens` that pin the EXACT comparison
 * boundaries the mutation tester flips. These use deliberately on-the-line
 * fixtures (a token whose chunk count equals the cutoff; a single token
 * after sanitization) so the assertion outcome differs between the current
 * operator and its mutated form.
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
import { filterCommonTokens } from "./bm25.js";
import { closeTempDb } from "./test-utils.js";

let db: Db;

beforeEach(() => {
  db = createIndexDatabase(`/tmp/omnesis-bm25-boundary-${randomUUID()}.db`);
});

afterEach(() => {
  closeTempDb(db);
});

function chunk(
  overrides: Partial<ChunkUpsertInput> & { id: string; documentId: string },
): ChunkUpsertInput {
  return {
    chunkIndex: 0,
    content: "",
    embedding: new Float32Array(EMBEDDING_DIM).fill(0),
    sourceId: "gmail",
    documentType: "email",
    title: "",
    sourceCreatedAt: "2026-03-10T00:00:00Z",
    ...overrides,
  };
}

describe("filterCommonTokens — common-token cutoff is strictly > cutoff (m1)", () => {
  // Kills gateway-search-m1: `row.doc > cutoff` -> `row.doc >= cutoff`.
  // A token whose chunk count EQUALS the cutoff must be KEPT (it is not
  // strictly "more than" the threshold). Under the `>=` mutant it would be
  // dropped. The two query tokens straddle the boundary so the result is
  // unambiguous: one above the cutoff is dropped, the one exactly on the
  // cutoff survives.
  test("token above the cutoff is dropped; token EXACTLY at the cutoff is kept", () => {
    // 11 chunks total -> cutoff = floor(11 * 0.5) = 5.
    //   "report" appears in 6 chunks (6 > 5  -> dropped).
    //   "wombat" appears in exactly 5 chunks (5 == 5, NOT > 5 -> kept).
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(chunk({ id: `r${i}`, documentId: `dr${i}`, content: "report" }));
    }
    for (let i = 0; i < 5; i++) {
      rows.push(chunk({ id: `w${i}`, documentId: `dw${i}`, content: "wombat" }));
    }
    upsertChunks(db, rows);

    const { filtered, dropped } = filterCommonTokens(db, "report wombat", 0.5);
    // Correct (`>`): report (6 > 5) dropped, wombat (5 not > 5) kept.
    // Mutant (`>=`): wombat (5 >= 5) ALSO dropped -> kept becomes [] -> the
    // function falls back to the original "report wombat" with dropped=[],
    // failing BOTH assertions below.
    expect(dropped).toEqual(["report"]);
    expect(filtered).toBe("wombat");
  });
});

describe("filterCommonTokens — single-token short-circuit boundary (m2)", () => {
  // Kills gateway-search-m2: `tokens.length <= 1` -> `tokens.length < 1`.
  // With a single token the correct code short-circuits and returns the
  // ORIGINAL query verbatim. The mutant (`< 1`) lets the lone token fall
  // through to the kept-tokens path, which rebuilds the query from the
  // SANITIZED token — so a single token carrying an FTS5 syntax char makes
  // the two paths diverge in their `filtered` output.
  test("a single token with an FTS5 syntax char returns the ORIGINAL query unchanged", () => {
    // "report*" sanitizes to "report". The token is absent from the corpus,
    // so the fall-through (mutant) path would classify it as rare, keep it,
    // and emit the sanitized "report". The short-circuit must instead return
    // the raw "report*" verbatim.
    const rows: ChunkUpsertInput[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(chunk({ id: `c${i}`, documentId: `dc${i}`, content: "unrelated filler text" }));
    }
    upsertChunks(db, rows);

    const { filtered, dropped } = filterCommonTokens(db, "report*", 0.5);
    // Correct (`<= 1`): single token -> short-circuit -> original "report*".
    // Mutant (`< 1`): 1 < 1 is false -> proceeds -> sanitizes -> "report".
    expect(dropped).toEqual([]);
    expect(filtered).toBe("report*");
  });
});
