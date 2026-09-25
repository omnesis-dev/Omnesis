// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The boot search-cache warm runs its scans on a thread of its own.
 *
 * The proof is structural, not timed: the worker reports the `threadId` it
 * ran the scans on, and it is neither the main thread's (0) nor this test's.
 * Both inline and worker scans must read every row of all three tables,
 * without an early stop on a populated index.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadId } from "node:worker_threads";

import { resolveWorkerEntry } from "@omnesis/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  EMBEDDING_DIM,
  createIndexDatabase,
  openIndexDb,
  prewarmFtsCaches,
  setIndexedDocument,
  upsertChunks,
} from "../indexer/db.js";
import { startSearchCacheWarm } from "./search-warm.js";

const WARM_WORKER = resolveWorkerEntry(
  "./search-warm-worker.ts",
  import.meta.url,
  "./register-tsx.mjs",
);

/** Enough chunks that the tables the scans read have rows. */
const CHUNK_ROWS = 300;

function seedIndexDb(path: string): void {
  const db = createIndexDatabase(path);
  upsertChunks(
    db,
    Array.from({ length: CHUNK_ROWS }, (_, i) => ({
      id: `chunk-${i}`,
      documentId: `doc-${i}`,
      chunkIndex: 0,
      content: `Quarterly budget review ${i}: venue deposit, catering quote and the marathon entry form`,
      embedding: new Float32Array(EMBEDDING_DIM),
      sourceId: "synthetic:test@example.com",
      documentType: "note",
      title: `Note ${i}`,
      sourceCreatedAt: "2026-02-11T09:00:00Z",
    })),
  );
  for (let i = 0; i < CHUNK_ROWS; i++) setIndexedDocument(db, `doc-${i}`, `hash-${i}`, 1);
  db.close();
}

describe("search cache warm", () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-swarm-"));
    dbPath = join(dir, "index.db");
    seedIndexDb(dbPath);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("the scans read all three tables completely inline and on a separate thread", async () => {
    const db = openIndexDb(dbPath, { readonly: true, mmapBytes: 0 });
    const expectedRows = db
      .prepare<[], { count: number }>(
        `SELECT (SELECT count(*) FROM chunks_fts_data)
              + (SELECT count(*) FROM chunks_fts_docsize)
              + (SELECT count(*) FROM chunks) AS count`,
      )
      .get()!.count;
    const inline = prewarmFtsCaches(db);
    db.close();
    expect(expectedRows).toBeGreaterThan(CHUNK_ROWS * 2);
    expect(inline.stoppedBy).toBeUndefined();
    expect(inline.rows).toBe(expectedRows);

    const outcome = await startSearchCacheWarm({
      indexDbPath: dbPath,
      mmapBytes: 0,
      cacheSizeBytes: 64 * 1024 * 1024,
      backgroundWorkerNice: 0,
      workerUrl: WARM_WORKER.url,
      workerExecArgv: WARM_WORKER.execArgv,
    }).done;

    expect(outcome.threadId, "the scans ran off the main thread").toBeGreaterThan(0);
    expect(outcome.threadId, "and off this thread").not.toBe(threadId);
    expect(outcome.rows).toBe(expectedRows);
    expect(outcome.stoppedBy).toBeUndefined();
    expect(outcome.ms).toBeGreaterThanOrEqual(0);
  });

  test("a warm that cannot open the index reports the failure instead of hanging", async () => {
    const warm = startSearchCacheWarm({
      indexDbPath: join(dir, "missing.db"),
      mmapBytes: 0,
      cacheSizeBytes: 64 * 1024 * 1024,
      backgroundWorkerNice: 0,
      workerUrl: WARM_WORKER.url,
      workerExecArgv: WARM_WORKER.execArgv,
    });
    await expect(warm.done).rejects.toThrow(/unable to open database file/);
  });

  test("terminate stops a warm in progress and settles its outcome as a stop", async () => {
    const warm = startSearchCacheWarm({
      indexDbPath: dbPath,
      mmapBytes: 0,
      cacheSizeBytes: 64 * 1024 * 1024,
      backgroundWorkerNice: 0,
      workerUrl: WARM_WORKER.url,
      workerExecArgv: WARM_WORKER.execArgv,
    });
    await warm.terminate();
    await expect(warm.done).rejects.toThrow(/stopped before it finished/);
    // Idempotent.
    await warm.terminate();
  });
});
