// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search cache warm worker — a one-shot thread that runs the boot FTS
 * pre-warm off the main event loop.
 *
 * The job arrives via `workerData` (`SearchWarmInit`). The thread opens its
 * own read-only `index.db` handle with the tunables it was given, runs
 * `prewarmFtsCaches` — the three full-table scans a BM25 query touches —
 * posts `done` with the row count and its own thread id, closes the handle
 * and exits. The handle's own page cache dies with the thread; the kernel
 * page cache the scans filled is what the search workers read through
 * afterwards.
 *
 * Read-only on a WAL database is a snapshot read: it never writes `-shm`
 * frames and never blocks the writer.
 */

import { parentPort, threadId, workerData } from "node:worker_threads";

import { openIndexDb, prewarmFtsCaches } from "../indexer/db.js";
import { deprioritizeBackgroundWorker } from "./worker-priority.js";
import type Database from "better-sqlite3";
import type { SearchWarmInit, SearchWarmToMain } from "./search-warm.js";

type Db = Database.Database;

if (!parentPort) {
  throw new Error("search-warm-worker must be run as a Node worker_thread");
}

function post(msg: SearchWarmToMain): void {
  parentPort!.postMessage(msg);
}

const init = workerData as SearchWarmInit;
const startMs = Date.now();
let db: Db | null = null;
try {
  // A boot courtesy, never a reason to starve the main loop of a core.
  deprioritizeBackgroundWorker(init.backgroundWorkerNice, "search-warm");
  db = openIndexDb(init.indexDbPath, {
    readonly: true,
    mmapBytes: init.mmapBytes,
    cacheSizeBytes: init.cacheSizeBytes,
    ...(init.indexDbKeyHex ? { encryptionKey: Buffer.from(init.indexDbKeyHex, "hex") } : {}),
  });
  const outcome = prewarmFtsCaches(db);
  post({ type: "done", outcome: { ...outcome, ms: Date.now() - startMs, threadId } });
} catch (err) {
  post({ type: "error", error: err instanceof Error ? err.message : String(err) });
} finally {
  db?.close();
}
