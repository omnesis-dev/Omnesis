// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search-worker relocation (Slice 3B) — the >10k-allowed-id temp-table path
 * under the worker's read profile.
 *
 * `withDocIdRestriction` inlines a `document_id IN (?, …)` list up to
 * `INLINE_DOCID_LIMIT` (10000) ids and, above it, stages the set into a
 * `CREATE TEMP TABLE docid_filter` — used by BOTH the BM25 lane and the recency
 * browse. The io-worker opens its handle with `PRAGMA query_only = ON`, which
 * FORBIDS temp tables; the search worker must therefore open read-only WITHOUT
 * `query_only`. This is the worker analogue of `docid-filter.test.ts`: it drives
 * a real worker thread with a >10k allowed-id set and asserts the candidate-gen
 * runs (no "cannot modify … within query_only" throw) and restricts correctly.
 *
 * A regression that copied the io-worker's `query_only=ON` into the search
 * worker's open profile would reject every >10k-filtered query — this reddens
 * the moment that happens.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  openIndexDb,
  setIndexedDocument,
  upsertChunks,
} from "../indexer/db.js";
import { UsearchReadRegistry } from "../indexer/usearch-read-registry.js";
import { SearchWorkerPool } from "../workers/search-pool.js";
import { INLINE_DOCID_LIMIT } from "./docid-filter.js";
import { runCandidateGen, type CandidateGenRequest } from "./candidate-gen.js";
import {
  resolveDiversityConfig,
  resolveSearchSettings,
  resolveSourcePriorsConfig,
  resolveVectorConfig,
} from "./search-config.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const dummyEmbedding = new Float32Array(EMBEDDING_DIM).fill(0);

const WORKER_URL = new URL("../workers/search-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

/** Three "budget" documents across three source types, distinct document_ids. */
function seedIndexDb(path: string): void {
  const db = createIndexDatabase(path);
  upsertChunks(db, [
    {
      id: "chunk-a",
      documentId: "doc-a",
      chunkIndex: 0,
      content: "Quarterly budget review notes for the finance team",
      embedding: dummyEmbedding,
      sourceId: "gmail:user@example.com",
      documentType: "email",
      title: "Q3 budget review",
      sourceCreatedAt: "2026-03-01T10:00:00Z",
      author: "Maya Reeves",
    },
    {
      id: "chunk-b",
      documentId: "doc-b",
      chunkIndex: 0,
      content: "Budget planning outline for the upcoming finance sync",
      embedding: dummyEmbedding,
      sourceId: "apple-notes:local",
      documentType: "note",
      title: "Budget planning outline",
      sourceCreatedAt: "2026-02-01T08:00:00Z",
    },
    {
      id: "chunk-c",
      documentId: "doc-c",
      chunkIndex: 0,
      content: "Reminder about the budget deadline this week",
      embedding: dummyEmbedding,
      sourceId: "whatsapp:local",
      documentType: "conversation",
      title: "Budget deadline reminder",
      sourceCreatedAt: "2026-03-10T09:00:00Z",
      author: "Jamie Lopez",
    },
  ]);
  setIndexedDocument(db, "doc-a", "hash-a", 1);
  setIndexedDocument(db, "doc-b", "hash-b", 1);
  setIndexedDocument(db, "doc-c", "hash-c", 1);
  db.close();
}

/** A large allowed-id set: the given real ids + `padTo` absent ids, well over
 *  the inline threshold so the worker takes the TEMP-table path. */
function largeAllowedSet(realIds: string[], padTo: number): string[] {
  const ids = [...realIds];
  for (let i = 0; i < padTo; i++) ids.push(`absent-${i}`);
  return ids;
}

/** No embedder attached, so BM25 alone produces the pool under test. */
function baseRequest(overrides: Partial<CandidateGenRequest>): CandidateGenRequest {
  const settings = resolveSearchSettings(undefined);
  return {
    mode: "hybrid",
    bm25Text: "budget",
    embedderPresent: false,
    queryVector: null,
    embedMs: 0,
    queryModelId: null,
    filters: {},
    allowedDocumentIds: undefined,
    candidateLimit: settings.params.candidateLimit,
    limit: settings.params.resultLimit,
    settings,
    vectorConfig: resolveVectorConfig(undefined),
    sourcePriors: resolveSourcePriorsConfig(
      undefined,
      {},
      { docCounts: [], rrfK: settings.params.rrfK },
    ),
    diversity: resolveDiversityConfig(undefined),
    commonTokenThreshold: 0.1,
    ...overrides,
  };
}

describe("search worker — >10k allowed-id temp-table path (no query_only)", () => {
  let configDir: string;
  let dbPath: string;
  let inProcDb: Db;
  let pool: SearchWorkerPool;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-swdid-"));
    dbPath = join(configDir, "index.db");
    seedIndexDb(dbPath);
    inProcDb = openIndexDb(dbPath, { readonly: true });
    pool = new SearchWorkerPool({
      indexDbPath: dbPath,
      configDir,
      concurrency: 1,
      maxInflightBeforeFallback: 2,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    });
    await pool.start();
  });

  afterEach(async () => {
    await pool.dispose();
    inProcDb.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("BM25 lane: a >10k allowed set runs on the worker and restricts correctly", async () => {
    const allowed = largeAllowedSet(["doc-a", "doc-c"], 40_000);
    expect(allowed.length).toBeGreaterThan(INLINE_DOCID_LIMIT);

    // The load-bearing assertion: this RESOLVES. With `query_only=ON` the worker
    // would reject with "cannot modify docid_filter within query_only".
    const remote = await pool.candidateGen(baseRequest({ allowedDocumentIds: allowed }));

    const ids = new Set(remote.results.map((r) => r.documentId));
    // Restricted to the allowed real ids — doc-b (matches "budget" but is not in
    // the set) is excluded.
    expect(ids).toEqual(new Set(["doc-a", "doc-c"]));

    // And byte-identical to the same request run in-process over a read-only
    // handle (whose open profile also omits query_only) — parity for the heavy
    // filtered path, not just the happy path.
    const local = runCandidateGen(
      { indexDb: inProcDb, usearchRead: new UsearchReadRegistry(inProcDb, configDir) },
      baseRequest({ allowedDocumentIds: allowed }),
    );
    expect(remote.results).toEqual(local.results);
  });

  test("browse lane: a >10k allowed set also runs on the worker (browse uses the same temp table)", async () => {
    // Empty-query recency browse ALSO goes through withDocIdRestriction — the
    // heavy `with:BigPerson` case the design calls out. Drive it directly.
    const allowed = largeAllowedSet(["doc-b"], 40_000);
    expect(allowed.length).toBeGreaterThan(INLINE_DOCID_LIMIT);

    const remote = await pool.candidateGen(
      baseRequest({
        mode: "browse",
        bm25Text: "",
        allowedDocumentIds: allowed,
      }),
    );

    const ids = remote.results.map((r) => r.documentId);
    expect(ids).toEqual(["doc-b"]);
  });

  test("a >10k allowed set resolving to zero real docs returns empty (no throw)", async () => {
    const allowed = largeAllowedSet([], 40_000); // 40k absent ids, none real
    expect(allowed.length).toBeGreaterThan(INLINE_DOCID_LIMIT);

    const remote = await pool.candidateGen(baseRequest({ allowedDocumentIds: allowed }));
    expect(remote.results).toEqual([]);
  });
});
