// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Lexical index build worker — a one-shot thread that builds the in-memory
 * lexical index from `index.db` on `SharedArrayBuffer`s, posts it to the main
 * thread, closes its handle and exits.
 *
 * Read-only on a WAL database is a snapshot read: it never writes `-shm`
 * frames and never blocks the writer.
 */

import { parentPort, workerData } from "node:worker_threads";

import { openIndexDb } from "../indexer/db.js";
import { buildLexicalIndexData } from "../search/lexical-index-data.js";
import { deprioritizeBackgroundWorker } from "./worker-priority.js";
import type Database from "better-sqlite3";
import type { LexicalIndexBuildInit, LexicalIndexBuildToMain } from "./lexical-index-build.js";

type Db = Database.Database;

if (!parentPort) {
  throw new Error("lexical-index-build-worker must be run as a Node worker_thread");
}

function post(msg: LexicalIndexBuildToMain): void {
  parentPort!.postMessage(msg);
}

const init = workerData as LexicalIndexBuildInit;
const startMs = Date.now();
let db: Db | null = null;
try {
  deprioritizeBackgroundWorker(init.backgroundWorkerNice, "lexical-index");
  db = openIndexDb(init.indexDbPath, {
    readonly: true,
    mmapBytes: 0,
    cacheSizeBytes: init.cacheSizeBytes,
    ...(init.indexDbKeyHex ? { encryptionKey: Buffer.from(init.indexDbKeyHex, "hex") } : {}),
  });
  db.exec("PRAGMA temp_store = MEMORY");
  const data = buildLexicalIndexData(db, { shared: true });
  post({ type: "done", data, ms: Date.now() - startMs });
} catch (err) {
  post({ type: "error", error: err instanceof Error ? err.message : String(err) });
} finally {
  db?.close();
}
