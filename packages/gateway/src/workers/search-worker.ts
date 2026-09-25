// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search worker — read-only sibling of io-worker.ts, on index.db.
 *
 * Owns a READ-ONLY `better-sqlite3` handle on `index.db` plus its own
 * {@link UsearchReadRegistry}, and runs the synchronous candidate-generation
 * core (`runCandidateGen`) off the main event loop (Slice 3B). The heavy,
 * blocking part of a search — BM25 over FTS5, native usearch over the HNSW
 * index, the candidate fetch, the pure-JS fusion/boost/diversity, and the
 * full-pool chunk-text + content-hash hydration — executes here so the main
 * thread stays free.
 *
 * Read profile — CRITICAL divergence from io-worker: it opens read-only but
 * MUST NOT set `PRAGMA query_only`. The candidate SQL's >10k-allowed-id path
 * (`withDocIdRestriction`) issues `CREATE TEMP TABLE docid_filter`, used by
 * both BM25 and browse; `query_only=ON` forbids temp tables. It sets the same
 * belt pragmas io-worker sets EXCEPT query_only: a generous page cache,
 * `temp_store=MEMORY` (the docid temp table lives in memory), and `mmap_size=0`.
 *
 * The worker opens ONLY index.db + usearch — NO gateway (omnesis.db) handle.
 * Under Scope X the person/source pre-stage and the metadata hydration stay on
 * the main thread, so nothing here reaches omnesis.db.
 *
 * usearch refresh: the registry's `maybeRefresh()` runs inside
 * `runCandidateGen`'s vector lane before each `usearch.search`, so an
 * embedder swap's `active_version` flip (committed by the writer) is observed
 * on this handle with no restart. better-sqlite3 autocommits per statement, so
 * no long-lived read transaction pins a stale generation across calls.
 *
 * Protocol: see `search-protocol.ts`. Transport is structured-clone
 * `postMessage`, never JSON — the request's `queryVector` (Float32Array) and
 * the result's `Infinity`/`NaN` scores + `bigint` usearch keys depend on it.
 */

import { parentPort } from "node:worker_threads";

import { assertNever } from "@omnesis/core";
import { runCandidateGen } from "../search/candidate-gen.js";
import { openIndexDb } from "../indexer/db.js";
import { UsearchReadRegistry } from "../indexer/usearch-read-registry.js";
import { deprioritizeBackgroundWorker } from "./worker-priority.js";

import type Database from "better-sqlite3";
type Db = Database.Database;
import type { CandidateGenRequest } from "../search/candidate-gen.js";
import type { LogLevel } from "./protocol.js";
import type { MainToSearch, SearchInit, SearchToMain } from "./search-protocol.js";

if (!parentPort) {
  throw new Error("search-worker must be run as a Node worker_thread");
}

function post(msg: SearchToMain): void {
  parentPort!.postMessage(msg);
}

function log(level: LogLevel, component: string, message: string): void {
  post({ type: "log", level, component, message });
}

/**
 * Open the read-only index.db handle for candidate generation.
 *
 * Read-only on a WAL DB opens a snapshot — it never touches -shm writes. We
 * deliberately do NOT set `PRAGMA query_only` here (unlike io-worker): the
 * >10k-allowed-id path in `withDocIdRestriction` creates a TEMP TABLE, which
 * query_only forbids. `temp_store=MEMORY` keeps that temp table off disk;
 * `mmap_size=0` is the same belt-and-suspenders posture io-worker uses.
 * `openIndexDb(readonly:true)` already applies the cache-size + mmap pragmas
 * and, under encryption, opens the ciphered handle.
 */
function openSearchIndexConn(
  path: string,
  indexDbKeyHex: string | undefined,
  cacheSizeBytes: number | undefined,
): Db {
  const db = openIndexDb(path, {
    readonly: true,
    mmapBytes: 0,
    cacheSizeBytes: cacheSizeBytes ?? 64 * 1024 * 1024,
    ...(indexDbKeyHex ? { encryptionKey: Buffer.from(indexDbKeyHex, "hex") } : {}),
  });
  db.exec("PRAGMA temp_store = MEMORY");
  return db;
}

let state: {
  indexDb: Db;
  usearchRead: UsearchReadRegistry;
  heartbeatInterval: ReturnType<typeof setInterval>;
  shuttingDown: boolean;
} | null = null;

async function handleInit(init: SearchInit): Promise<void> {
  if (state) {
    log("warn", "search-worker", "init received twice — ignoring");
    return;
  }
  try {
    const indexDb = openSearchIndexConn(init.indexDbPath, init.indexDbKeyHex, init.cacheSizeBytes);
    // Its own versioned read router — follows `active_version` on `maybeRefresh`
    // (called inside runCandidateGen before each usearch.search), so an embedder
    // swap is picked up on this handle with no worker restart.
    const usearchRead = new UsearchReadRegistry(indexDb, init.configDir);

    const heartbeatInterval = setInterval(() => {
      post({ type: "heartbeat", ts: Date.now() });
    }, init.heartbeatIntervalMs);

    state = { indexDb, usearchRead, heartbeatInterval, shuttingDown: false };

    // Yield CPU to real-time work under contention. Search candidate-gen is
    // user-facing, but it runs at the same OS priority as the main loop and the
    // embedder unless reniced; renicing DOWN lets the kernel prefer main-thread
    // work when cores are contended. See #199 (Lever 3).
    const nice = deprioritizeBackgroundWorker(init.backgroundWorkerNice, "search", (m) =>
      log("warn", "search-worker", m),
    );
    log(
      "info",
      "search-worker",
      `ready — read-only index.db handle on ${init.indexDbPath} (${usearchRead.size()} vectors)` +
        (nice !== null ? ` (background nice ${nice})` : ""),
    );
    post({ type: "ready" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "search-worker", `init failed: ${msg}`);
    post({ type: "initError", error: msg });
  }
}

function handleCall(id: number, request: CandidateGenRequest, enqueueMs: number): void {
  // Stamp dequeue immediately so queueMs reflects the FIFO wait, computed even
  // on early-return failure paths. Mirrors io-worker.handleCall.
  const dequeueMs = Date.now();
  const queueMs = Math.max(0, dequeueMs - enqueueMs);

  if (!state) {
    post({
      type: "result",
      id,
      ok: false,
      error: "search-worker not initialized",
      queueMs,
      execMs: 0,
      cpuUserUs: 0,
      cpuSystemUs: 0,
    });
    return;
  }
  if (state.shuttingDown) {
    post({
      type: "result",
      id,
      ok: false,
      error: "search-worker shutting down",
      queueMs,
      execMs: 0,
      cpuUserUs: 0,
      cpuSystemUs: 0,
    });
    return;
  }
  const cpuBefore = process.cpuUsage();
  try {
    const value = runCandidateGen(
      { indexDb: state.indexDb, usearchRead: state.usearchRead },
      request,
    );
    const execMs = Date.now() - dequeueMs;
    const cpuDelta = process.cpuUsage(cpuBefore);
    post({
      type: "result",
      id,
      ok: true,
      value,
      queueMs,
      execMs,
      cpuUserUs: cpuDelta.user,
      cpuSystemUs: cpuDelta.system,
    });
  } catch (err) {
    const error = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const execMs = Date.now() - dequeueMs;
    const cpuDelta = process.cpuUsage(cpuBefore);
    post({
      type: "result",
      id,
      ok: false,
      error,
      queueMs,
      execMs,
      cpuUserUs: cpuDelta.user,
      cpuSystemUs: cpuDelta.system,
    });
  }
}

async function handleShutdown(): Promise<void> {
  if (!state) {
    post({ type: "shutdownComplete" });
    return;
  }
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  clearInterval(state.heartbeatInterval);
  try {
    state.usearchRead.close();
  } catch {
    /* best-effort */
  }
  try {
    state.indexDb.close();
  } catch {
    /* best-effort */
  }

  post({ type: "shutdownComplete" });
}

parentPort.on("message", (msg: MainToSearch) => {
  switch (msg.type) {
    case "init":
      void handleInit(msg);
      break;
    case "call":
      handleCall(msg.id, msg.request, msg.enqueueMs);
      break;
    case "shutdown":
      void handleShutdown();
      break;
    default:
      // Internal protocol — adding a new MainToSearch variant should
      // fail the build at this site.
      assertNever(msg);
  }
});
