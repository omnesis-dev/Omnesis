// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search worker — read-only sibling of io-worker.ts, on index.db.
 *
 * Owns a READ-ONLY `better-sqlite3` handle on `index.db` plus its own
 * {@link UsearchReadRegistry}, and runs the synchronous candidate-generation
 * core (`runCandidateGen`) off the main event loop (Slice 3B). The heavy,
 * blocking part of a search — BM25 over the in-memory lexical index (or FTS5),
 * native usearch over the HNSW index, the candidate fetch, the pure-JS
 * fusion/boost/diversity, and the full-pool chunk-text + content-hash
 * hydration — executes here so the main thread stays free. Between calls a
 * {@link LexicalIndexFollower} keeps the lexical index current with the
 * chunk change log.
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
 * Temporal intent: the pipeline also sends each query here to read the time it
 * names (`parseTemporalIntent`), so the date recognizer's models are built and
 * run on this thread rather than on the main one. After reporting ready the worker
 * warms them one culture per turn of its event loop, so a call that arrives
 * meanwhile waits for at most one culture, and builds whichever model it needs
 * that is not warm yet.
 *
 * Protocol: see `search-protocol.ts`. Transport is structured-clone
 * `postMessage`, never JSON — the request's `queryVector` (Float32Array) and
 * the result's `Infinity`/`NaN` scores + `bigint` usearch keys depend on it.
 */

import { parentPort } from "node:worker_threads";

import { assertNever } from "@omnesis/core";
import { runCandidateGen } from "../search/candidate-gen.js";
import {
  parseTemporalIntent,
  TEMPORAL_INTENT_CULTURES,
  warmTemporalIntent,
} from "../search/temporal-intent.js";
import { LexicalIndexFollower } from "../search/lexical-index-follower.js";
import { openIndexDb } from "../indexer/db.js";
import { UsearchReadRegistry } from "../indexer/usearch-read-registry.js";
import { deprioritizeBackgroundWorker } from "./worker-priority.js";
import type { LexicalIndexData } from "../search/lexical-index-data.js";

import type Database from "better-sqlite3";
type Db = Database.Database;
import type { CandidateGenResult } from "../search/candidate-gen.js";
import type { TemporalIntent } from "../search/temporal-intent.js";
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

/** The lexical index sent before `init` finished, attached once the handle exists. */
let pendingLexical: LexicalIndexData | undefined;

let state: {
  indexDb: Db;
  usearchRead: UsearchReadRegistry;
  /** The in-memory lexical ranker, kept current between calls. */
  lexical: LexicalIndexFollower;
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

    const lexical = new LexicalIndexFollower(indexDb, {
      onError: (err) =>
        log(
          "warn",
          "search-worker",
          `lexical index catch-up failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
    });
    state = { indexDb, usearchRead, lexical, heartbeatInterval, shuttingDown: false };
    if (pendingLexical) attachLexicalIndex(pendingLexical);

    // Yield CPU to real-time work under contention. Search candidate-gen is
    // user-facing, but it runs at the same OS priority as the main loop and the
    // embedder unless reniced; renicing DOWN lets the kernel prefer main-thread
    // work when cores are contended.
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
    if (init.warmTemporalIntent) void warmTemporalModels();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "search-worker", `init failed: ${msg}`);
    post({ type: "initError", error: msg });
  }
}

/**
 * Build the date recognizer's models one culture per event-loop turn, so a
 * search arriving meanwhile runs between two cultures rather than after all.
 */
async function warmTemporalModels(): Promise<void> {
  const started = Date.now();
  try {
    for (const culture of TEMPORAL_INTENT_CULTURES) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!state || state.shuttingDown) return;
      warmTemporalIntent(culture);
    }
    log("info", "search-worker", `date recognizer ready in ${Date.now() - started}ms`);
  } catch (err) {
    log(
      "warn",
      "search-worker",
      `date recognizer warm-up failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run one operation and post its result, timed the same way for every
 * operation: the FIFO wait since the pool posted it, then the run itself.
 */
function answer(
  id: number,
  enqueueMs: number,
  run: (live: NonNullable<typeof state>) => CandidateGenResult | TemporalIntent | null,
): void {
  // Stamp dequeue immediately so queueMs reflects the FIFO wait, computed even
  // on early-return failure paths. Mirrors io-worker.handleCall.
  const dequeueMs = Date.now();
  const queueMs = Math.max(0, dequeueMs - enqueueMs);

  if (!state || state.shuttingDown) {
    post({
      type: "result",
      id,
      ok: false,
      error: state ? "search-worker shutting down" : "search-worker not initialized",
      queueMs,
      execMs: 0,
      cpuUserUs: 0,
      cpuSystemUs: 0,
    });
    return;
  }
  const cpuBefore = process.cpuUsage();
  try {
    const value = run(state);
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

function attachLexicalIndex(data: LexicalIndexData): void {
  if (!state) {
    pendingLexical = data;
    return;
  }
  pendingLexical = undefined;
  state.lexical.attach(data);
  log("info", "search-worker", `lexical index attached (${data.docCount} chunks)`);
}

async function handleShutdown(): Promise<void> {
  if (!state) {
    post({ type: "shutdownComplete" });
    return;
  }
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  clearInterval(state.heartbeatInterval);
  state.lexical.stop();
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
    case "call": {
      const { request } = msg;
      answer(msg.id, msg.enqueueMs, (live) =>
        runCandidateGen(
          {
            indexDb: live.indexDb,
            usearchRead: live.usearchRead,
            lexicalRanker: live.lexical.ranker,
          },
          request,
        ),
      );
      break;
    }
    case "temporalIntent": {
      const { text, options } = msg;
      answer(msg.id, msg.enqueueMs, () => parseTemporalIntent(text, options));
      break;
    }
    case "lexicalIndex":
      attachLexicalIndex(msg.data);
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
