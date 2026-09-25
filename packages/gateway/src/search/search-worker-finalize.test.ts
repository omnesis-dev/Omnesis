// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search-worker relocation (Slice 3B) — finalize / snapshot proof.
 *
 * The refined Scope X has the worker hydrate the ENTIRE candidate pool (chunk
 * text + a `document_id → content_hash` map) and return both, so the main
 * thread issues ZERO `index.db` reads after the worker returns: dedupe consumes
 * the map and the final chunk-text hydration is a no-op. That collapse is not a
 * latency nicety — it is the correctness fix. Left un-collapsed, the main
 * thread's finalize would read a SECOND, independently-snapshotted `index.db`
 * handle, which within one query can produce empty snippets (a rowid in the
 * worker's snapshot but not main's), wrong snippets (a rowid remapped to a
 * different chunk after a mid-query rebuild), and dedupe misfires (a content
 * hash missing on main's handle lets a duplicate through).
 *
 * These tests prove the load-bearing invariant two ways:
 *   1. Zero-main-index-read: a real worker-thread search over the pipeline's own
 *      `index.db` handle issues ZERO `.prepare` on that handle. A control proves
 *      the counter is real — the inline (no-worker) path DOES read it.
 *   2. Poisoned-main-handle: the pipeline's main `index.db` is a DIFFERENT,
 *      EMPTY database than the worker's. Results are still correct (hydrated
 *      text present, a duplicate collapsed) — proving finalize consumed the
 *      worker's snapshot, never main's. Had main read its own (empty) handle,
 *      the shared-hash pair would NOT collapse (an empty map = "fresh ingest,
 *      pass through") and the snippets would be empty.
 */

import { randomUUID } from "node:crypto";
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
import { SearchWorkerPool } from "../workers/search-pool.js";
import { SearchPipeline } from "./pipeline.js";
import { closeTempDb } from "./test-utils.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const dummyEmbedding = new Float32Array(EMBEDDING_DIM).fill(0);

// Worker + tsx loader resolved relative to this test file (src/search/ → src/workers/).
const WORKER_URL = new URL("../workers/search-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

/**
 * Three "budget" documents across three source types. `doc-a` and `doc-b`
 * deliberately share a `content_hash`, so the post-fusion content-hash dedupe
 * collapses them to one survivor — the observable that distinguishes "dedupe
 * consumed the worker's map" from "dedupe read (an empty) main handle".
 */
function seedIndexDb(path: string): void {
  const db = createIndexDatabase(path);
  upsertChunks(db, [
    {
      id: "chunk-a",
      documentId: "doc-a",
      chunkIndex: 0,
      content: "Quarterly budget review notes shared with the finance team",
      embedding: dummyEmbedding,
      sourceId: "gmail:user@example.com",
      documentType: "email",
      title: "Q3 budget review",
      sourceUrl: "https://mail.example.com/a",
      sourceCreatedAt: "2026-03-01T10:00:00Z",
      author: "Maya Reeves",
      tags: ["finance"],
    },
    {
      id: "chunk-b",
      documentId: "doc-b",
      chunkIndex: 0,
      content: "Budget planning outline drafted before the finance sync",
      embedding: dummyEmbedding,
      sourceId: "apple-notes:local",
      documentType: "note",
      title: "Budget planning outline",
      sourceCreatedAt: "2026-01-20T08:00:00Z",
    },
    {
      id: "chunk-c",
      documentId: "doc-c",
      chunkIndex: 0,
      content: "Reminder about the budget deadline coming up this week",
      embedding: dummyEmbedding,
      sourceId: "whatsapp:local",
      documentType: "conversation",
      title: "Budget deadline reminder",
      sourceCreatedAt: "2026-03-10T09:00:00Z",
      author: "Jamie Lopez",
    },
  ]);
  // doc-a and doc-b are byte-distinct but share a content hash → the content-
  // hash dedupe keeps exactly one of them.
  setIndexedDocument(db, "doc-a", "hash-shared", 1);
  setIndexedDocument(db, "doc-b", "hash-shared", 1);
  setIndexedDocument(db, "doc-c", "hash-c", 1);
  db.close();
}

/** Wrap a handle's `.prepare` with a call counter (bulletproof across the
 *  prototype method); returns a `{ count }` box read after the search. */
function countPrepares(db: Db): { count: number } {
  const box = { count: 0 };
  const orig = db.prepare.bind(db);
  // Shadow the prototype method with an own property.
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((...args: unknown[]) => {
    box.count += 1;
    return (orig as (...a: unknown[]) => unknown)(...args);
  }) as typeof db.prepare;
  return box;
}

describe("search worker — finalize issues zero main-thread index.db reads", () => {
  let configDir: string;
  let dbPath: string;
  let pool: SearchWorkerPool;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-swfin-"));
    dbPath = join(configDir, "index.db");
    seedIndexDb(dbPath);
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
    rmSync(configDir, { recursive: true, force: true });
  });

  test("worker path → main index.db handle is NOT read during the search", async () => {
    const mainDb = openIndexDb(dbPath, { readonly: true });
    const pipeline = new SearchPipeline({ indexDb: mainDb });
    pipeline.setSearchPool(pool);

    const prepares = countPrepares(mainDb);
    const res = await pipeline.search({ text: "budget" });

    // The worker served (no fallback), so the whole candidate-gen + hydrate ran
    // off-thread.
    expect(pipeline.getSearchWorkerFallbacks()).toEqual({
      saturated: 0,
      error: 0,
      unconfigured: 0,
    });
    // The shared-hash pair collapsed to one survivor; doc-c stands alone → 2.
    expect(res.results.length).toBe(2);
    // Every survivor carries hydrated chunk text (the worker hydrated the whole
    // pool; main did no final hydrate).
    for (const r of res.results) {
      expect(r.chunkText.length).toBeGreaterThan(0);
      expect(r.chunkText.toLowerCase()).toContain("budget");
    }
    // The load-bearing assertion: the main thread's own index.db handle issued
    // ZERO statements across the search — dedupe used the worker's content-hash
    // map and the final hydrate was a no-op.
    expect(prepares.count).toBe(0);

    closeTempDb(mainDb);
  });

  test("control: the inline (no-worker) path DOES read the main index.db handle", async () => {
    // Same query, same handle, but no pool wired → candidate-gen runs inline on
    // main, which MUST touch index.db (BM25 + hydrate). Proves the counter above
    // measures a real property, not a dead spy.
    const mainDb = openIndexDb(dbPath, { readonly: true });
    const pipeline = new SearchPipeline({ indexDb: mainDb });

    const prepares = countPrepares(mainDb);
    const res = await pipeline.search({ text: "budget" });

    expect(pipeline.getSearchWorkerFallbacks().unconfigured).toBe(1);
    expect(res.results.length).toBe(2);
    expect(prepares.count).toBeGreaterThan(0);

    closeTempDb(mainDb);
  });

  test("poisoned main handle → results still correct (finalize consumed the worker snapshot, not main's)", async () => {
    // The pipeline's OWN index.db is a different, EMPTY database than the
    // worker's seeded one. If any finalize step read this handle, the shared-
    // hash pair would NOT collapse (empty map ⇒ every doc "passes through") and
    // snippets would be empty. Correct results here prove main read nothing but
    // the worker's returned snapshot.
    const emptyPath = join(configDir, `empty-${randomUUID()}.db`);
    const emptyMainDb = createIndexDatabase(emptyPath);
    const pipeline = new SearchPipeline({ indexDb: emptyMainDb });
    pipeline.setSearchPool(pool);

    const res = await pipeline.search({ text: "budget" });

    expect(pipeline.getSearchWorkerFallbacks()).toEqual({
      saturated: 0,
      error: 0,
      unconfigured: 0,
    });
    // Dedupe collapsed the shared-hash pair using the WORKER's map — an empty
    // main handle would have let both through (3 results).
    expect(res.results.length).toBe(2);
    // Snippets came from the worker's snapshot, so they are the seeded content —
    // an empty main handle would leave them blank.
    const byId = new Map(res.results.map((r) => [r.documentId, r.chunkText]));
    expect(byId.get("doc-c")).toContain("budget deadline");
    for (const text of byId.values()) {
      expect(text.length).toBeGreaterThan(0);
    }

    closeTempDb(emptyMainDb);
  });
});
