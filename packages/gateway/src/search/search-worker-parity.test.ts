// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search-worker relocation (Slice 3B) proof.
 *
 * Two layers:
 *   1. The pipeline's delegate-or-fallback GATE — the critical invariant. With
 *      no pool it runs candidate-gen inline; with a wired pool it uses the
 *      pool's result; when the pool throws it falls back to the IDENTICAL
 *      inline result; when the pool is saturated it never posts and runs inline.
 *   2. A REAL worker thread: `runCandidateGen` in-process === the same request
 *      driven through `SearchWorkerPool` over a real `search-worker.ts` thread.
 *      This is the byte-identity proof for the extraction + the structured-clone
 *      transport, which the in-process unit nets can never exercise.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  openIndexDb,
  setIndexedDocument,
  upsertChunks,
} from "../indexer/db.js";
import { UsearchReadRegistry } from "../indexer/usearch-read-registry.js";
import { SearchWorkerPool } from "../workers/search-pool.js";
import { SearchPipeline } from "./pipeline.js";
import { runCandidateGen, type CandidateGenRequest } from "./candidate-gen.js";
import {
  resolveDiversityConfig,
  resolveSearchSettings,
  resolveSourcePriorsConfig,
  resolveVectorConfig,
} from "./search-config.js";
import { closeTempDb } from "./test-utils.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

// ── Shared fixture ──────────────────────────────────────────────────────────

const dummyEmbedding = new Float32Array(EMBEDDING_DIM).fill(0);

/** A small, BM25-searchable index.db on disk (so the worker can open the path). */
function seedIndexDb(path: string): void {
  const db = createIndexDatabase(path);
  upsertChunks(db, [
    {
      id: "chunk-1",
      documentId: "doc-email-1",
      chunkIndex: 0,
      content: "Q3 budget review meeting notes with the finance team",
      embedding: dummyEmbedding,
      sourceId: "gmail:user@example.com",
      documentType: "email",
      title: "Q3 Budget Review",
      sourceUrl: "https://mail.example.com/1",
      sourceCreatedAt: "2026-03-01T10:00:00Z",
      author: "Maya Reeves",
      tags: ["finance", "quarterly"],
    },
    {
      id: "chunk-2",
      documentId: "doc-note-1",
      chunkIndex: 0,
      content: "Personal notes on the quarterly budget allocation strategy",
      embedding: dummyEmbedding,
      sourceId: "apple-notes:local",
      documentType: "note",
      title: "Budget Strategy Notes",
      sourceCreatedAt: "2026-01-20T08:00:00Z",
    },
    {
      id: "chunk-3",
      documentId: "doc-chat-1",
      chunkIndex: 0,
      content: "Hey, did you see the budget numbers? They look great",
      embedding: dummyEmbedding,
      sourceId: "whatsapp:local",
      documentType: "conversation",
      title: "Chat with the finance team",
      sourceCreatedAt: "2026-03-10T09:00:00Z",
      author: "Jamie Lopez",
    },
  ]);
  setIndexedDocument(db, "doc-email-1", "hash-a", 1);
  setIndexedDocument(db, "doc-note-1", "hash-b", 1);
  setIndexedDocument(db, "doc-chat-1", "hash-c", 1);
  db.close();
}

// ── (1) Delegate-or-fallback gate ───────────────────────────────────────────

describe("SearchPipeline candidate-gen gate", () => {
  let configDir: string;
  let dbPath: string;
  let db: Db;
  let pipeline: SearchPipeline;

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-swgate-"));
    dbPath = join(configDir, `index-${randomUUID()}.db`);
    seedIndexDb(dbPath);
    db = openIndexDb(dbPath, { readonly: true });
    pipeline = new SearchPipeline({
      indexDb: db,
      usearchRead: new UsearchReadRegistry(db, configDir),
    });
  });

  afterEach(() => {
    closeTempDb(db);
    rmSync(configDir, { recursive: true, force: true });
  });

  test("no pool → runs inline (unconfigured fallback), returns real results", async () => {
    const res = await pipeline.search({ text: "budget" });
    expect(res.results.length).toBeGreaterThan(0);
    expect(pipeline.getSearchWorkerFallbacks()).toEqual({
      saturated: 0,
      error: 0,
      unconfigured: 1,
    });
  });

  test("ready pool → the pipeline USES the pool's result", async () => {
    const marker = {
      results: [],
      contentHashByDoc: {},
      stageReports: {},
      timing: {},
      vectorDegraded: false,
      notices: [
        {
          filter: "person" as const,
          level: "info" as const,
          token: "WORKER",
          message: "from-worker",
        },
      ],
    };
    let calls = 0;
    pipeline.setSearchPool(
      fakePool({
        isReady: true,
        inflightCount: 0,
        maxInflightBeforeFallback: 2,
        candidateGen: async () => {
          calls += 1;
          return marker;
        },
      }),
    );
    const res = await pipeline.search({ text: "budget" });
    expect(calls).toBe(1);
    // The pool returned an empty pool + a marker notice — proving its output,
    // not the inline path (which returns non-empty results for this query), was used.
    expect(res.results).toEqual([]);
    expect(res.notices?.some((n) => n.token === "WORKER")).toBe(true);
    expect(pipeline.getSearchWorkerFallbacks()).toEqual({
      saturated: 0,
      error: 0,
      unconfigured: 0,
    });
  });

  test("pool throws → falls back to the IDENTICAL inline result", async () => {
    // Baseline: the pure inline result for this query.
    const baseline = await pipeline.search({ text: "budget" });

    pipeline.setSearchPool(
      fakePool({
        isReady: true,
        inflightCount: 0,
        maxInflightBeforeFallback: 2,
        candidateGen: async () => {
          throw new Error("worker crashed");
        },
      }),
    );
    const fellBack = await pipeline.search({ text: "budget" });

    // Byte-identical results (ids / order / score / chunkText), notices, facets —
    // the fallback is the same runCandidateGen over the same handles.
    expect(fellBack.results).toEqual(baseline.results);
    expect(fellBack.notices).toEqual(baseline.notices);
    expect(fellBack.facets).toEqual(baseline.facets);
    expect(pipeline.getSearchWorkerFallbacks().error).toBe(1);
  });

  test("saturated pool → runs inline WITHOUT posting to the worker", async () => {
    let calls = 0;
    pipeline.setSearchPool(
      fakePool({
        isReady: true,
        inflightCount: 5, // >= maxInflightBeforeFallback
        maxInflightBeforeFallback: 2,
        candidateGen: async () => {
          calls += 1;
          throw new Error("must not be called when saturated");
        },
      }),
    );
    const res = await pipeline.search({ text: "budget" });
    expect(calls).toBe(0);
    expect(res.results.length).toBeGreaterThan(0); // inline ran
    expect(pipeline.getSearchWorkerFallbacks().saturated).toBe(1);
  });

  test("not-ready pool → runs inline (bucketed as saturated)", async () => {
    let calls = 0;
    pipeline.setSearchPool(
      fakePool({
        isReady: false,
        inflightCount: 0,
        maxInflightBeforeFallback: 2,
        candidateGen: async () => {
          calls += 1;
          throw new Error("must not be called when not ready");
        },
      }),
    );
    const res = await pipeline.search({ text: "budget" });
    expect(calls).toBe(0);
    expect(res.results.length).toBeGreaterThan(0);
    expect(pipeline.getSearchWorkerFallbacks().saturated).toBe(1);
  });
});

/** Build a `SearchWorkerPool` stand-in exposing only the gate surface. */
function fakePool(shape: {
  isReady: boolean;
  inflightCount: number;
  maxInflightBeforeFallback: number;
  candidateGen: SearchWorkerPool["candidateGen"];
}): SearchWorkerPool {
  return {
    isReady: shape.isReady,
    isDisposed: false,
    inflightCount: shape.inflightCount,
    maxInflightBeforeFallback: shape.maxInflightBeforeFallback,
    candidateGen: shape.candidateGen,
  } as unknown as SearchWorkerPool;
}

// ── (2) Real worker-thread parity ───────────────────────────────────────────

// Worker + loader resolved relative to this test file (src/search/ → src/workers/).
const WORKER_URL = new URL("../workers/search-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

/**
 * A request with no embedder attached: BM25 carries the whole pool and the
 * vector lane degrades to a skip report. Keeps the parity comparison free of
 * an embedding model while still exercising the real candidate-gen core.
 */
function noEmbedderRequest(): CandidateGenRequest {
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
  };
}

test("candidate generation refreshes a completed model flip before comparing model ids", () => {
  const dbPath = `/tmp/omnesis-refresh-before-model-${randomUUID()}.db`;
  const db = createIndexDatabase(dbPath);
  let activeModel = "fictional-embedder-a";
  let refreshes = 0;
  const request = noEmbedderRequest();
  request.embedderPresent = true;
  request.queryVector = new Float32Array(EMBEDDING_DIM);
  request.queryModelId = "fictional-embedder-b";

  const result = runCandidateGen(
    {
      indexDb: db,
      usearchRead: {
        maybeRefresh: () => {
          refreshes += 1;
          activeModel = "fictional-embedder-b";
        },
        activeModelId: () => activeModel,
        search: () => [],
        size: () => 0,
      },
    },
    request,
  );

  expect(refreshes).toBe(1);
  expect(result.stageReports.vector?.status).toBe("ran");
  db.close();
  rmSync(dbPath, { force: true });
});

test("candidate generation degrades safely when a native refresh fails", () => {
  const dbPath = `/tmp/omnesis-refresh-failure-${randomUUID()}.db`;
  const db = createIndexDatabase(dbPath);
  const request = noEmbedderRequest();
  request.embedderPresent = true;
  request.queryVector = new Float32Array(EMBEDDING_DIM);

  const result = runCandidateGen(
    {
      indexDb: db,
      usearchRead: {
        maybeRefresh: () => {
          throw new Error("fictional remap failure");
        },
        search: () => {
          throw new Error("search must not run after refresh fails");
        },
        size: () => 1,
      },
    },
    request,
  );

  expect(result.vectorDegraded).toBe(true);
  expect(result.stageReports.vector).toMatchObject({ status: "skipped" });
  db.close();
  rmSync(dbPath, { force: true });
});

describe("search worker — real thread parity", () => {
  let configDir: string;
  let dbPath: string;
  let inProcDb: Db;
  let pool: SearchWorkerPool;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-swpar-"));
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

  test("worker candidate-gen == in-process candidate-gen (byte-identical pool + hashes)", async () => {
    const req = noEmbedderRequest();

    const local = runCandidateGen(
      { indexDb: inProcDb, usearchRead: new UsearchReadRegistry(inProcDb, configDir) },
      req,
    );
    const remote = await pool.candidateGen(req);

    // Results (ids / order / score / chunkText / breakdown) must match exactly —
    // the same function over the same on-disk data, only a different thread.
    expect(remote.results).toEqual(local.results);
    expect(remote.results.length).toBeGreaterThan(0);
    // The content-hash map survives structured-clone with its values intact.
    expect({ ...remote.contentHashByDoc }).toEqual({ ...local.contentHashByDoc });
    expect(remote.vectorDegraded).toBe(local.vectorDegraded);
    expect(remote.notices).toEqual(local.notices);
  });

  test("saturation gate on the real pool exposes a truthful inflight count", async () => {
    expect(pool.isReady).toBe(true);
    expect(pool.inflightCount).toBe(0);
    const p = pool.candidateGen(noEmbedderRequest());
    // One call is in flight until it resolves.
    expect(pool.inflightCount).toBe(1);
    await p;
    expect(pool.inflightCount).toBe(0);
  });
});

afterAll(() => {
  /* temp dirs removed per-test; nothing global to tear down. */
});
