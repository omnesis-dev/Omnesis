// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * IO worker — read-only sibling of writer-worker.ts.
 *
 * Owns a READ-ONLY `better-sqlite3` handle on `omnesis.db`. Runs the
 * compute-heavy SELECT-side halves of compute/upsert splits — e.g.
 * `computePeopleCounts`, `computeLinkResolutions`, `computeAutoMergePairs`,
 * `computeSourceStatsRow`. The writer worker still owns every mutation;
 * results from this worker get fanned out to writer tasks by the
 * Scheduler.
 *
 * Why read-only: a read-only handle on a WAL DB just opens a snapshot
 * — it never participates in -shm mmap writes, so the SIGBUS-class
 * race that motivated #192 can't originate here. We don't set
 * journal_mode/synchronous; those are writer concerns.
 *
 * Protocol: see `protocol.ts`. Same envelope shape as the writer
 * (id, op, args, enqueueMs → result) so the runner code is uniform
 * across writer + compute.
 *
 * Dispatch table lives in `scheduler/io-handlers.ts`. This file
 * just owns init, message loop, and shutdown.
 */

import Database from "better-sqlite3";
type Db = Database.Database;
import { parentPort } from "node:worker_threads";

import { assertNever } from "@omnesis/core";
import { ioHandlers } from "../scheduler/io-handlers.js";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { deprioritizeBackgroundWorker } from "./worker-priority.js";

import type { IoInit, IoToMain, LogLevel, MainToIo } from "./protocol.js";

if (!parentPort) {
  throw new Error("io-worker must be run as a Node worker_thread");
}

function post(msg: IoToMain): void {
  parentPort!.postMessage(msg);
}

function log(level: LogLevel, component: string, message: string): void {
  post({ type: "log", level, component, message });
}

function openReadConn(path: string, gatewayDbKeyHex?: string, cacheSizeBytes?: number): Db {
  // Read-only on a WAL DB opens a snapshot — never touches -shm writes.
  // fileMustExist:true catches mis-configured paths early instead of
  // silently creating an empty DB the rest of the gateway doesn't see.
  const db = gatewayDbKeyHex
    ? (openEncryptedSqlite(path, {
        key: Buffer.from(gatewayDbKeyHex, "hex"),
        readonly: true,
        fileMustExist: true,
        migratePlaintext: false,
      }) as unknown as Db)
    : new Database(path, { readonly: true, fileMustExist: true });
  // query_only is belt-and-suspenders on top of the readonly flag —
  // SQLite refuses any statement that would mutate state. Cheap.
  db.exec("PRAGMA query_only = ON");
  // Page cache. Compute ops re-scan large tables (people counts, link
  // reconcile) and benefit from a generous cache — doubly so under storage
  // encryption, where a resident page saves a re-decrypt. Configurable via
  // `gateway.readHandle.ioCacheSizeBytes`; defaults to 64 MiB.
  const cacheKib = Math.max(2, Math.floor((cacheSizeBytes ?? 64 * 1024 * 1024) / 1024));
  db.exec(`PRAGMA cache_size = -${cacheKib}`);
  db.exec("PRAGMA temp_store = MEMORY");
  // Disable mmap for the same belt-and-suspenders reason as elsewhere
  // in the codebase (see writer-worker openWriteConn header).
  db.exec("PRAGMA mmap_size = 0");
  return db;
}

const dispatch = ioHandlers as Record<string, (db: Db, ...args: unknown[]) => unknown>;

let state: {
  db: Db;
  heartbeatInterval: ReturnType<typeof setInterval>;
  shuttingDown: boolean;
} | null = null;

async function handleInit(init: IoInit): Promise<void> {
  if (state) {
    log("warn", "io-worker", "init received twice — ignoring");
    return;
  }
  try {
    const db = openReadConn(init.gatewayDbPath, init.gatewayDbKeyHex, init.cacheSizeBytes);

    const heartbeatInterval = setInterval(() => {
      post({ type: "heartbeat", ts: Date.now() });
    }, init.heartbeatIntervalMs);

    state = { db, heartbeatInterval, shuttingDown: false };

    // Yield CPU to real-time work under contention — this worker mostly runs
    // the background compute-halves of splits, plus a few user-priority
    // read ops (e.g. io.browsePeople for GET /people) the scheduler
    // front-of-queues. See #199 (Lever 3).
    const nice = deprioritizeBackgroundWorker(init.backgroundWorkerNice, "io", (m) =>
      log("warn", "io-worker", m),
    );
    log(
      "info",
      "io-worker",
      `ready — read-only handle on ${init.gatewayDbPath}${nice !== null ? ` (background nice ${nice})` : ""}`,
    );
    post({ type: "ready" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "io-worker", `init failed: ${msg}`);
    post({ type: "initError", error: msg });
  }
}

function handleCall(id: number, op: string, args: unknown[], enqueueMs: number): void {
  // Stamp dequeue immediately on entering the handler so queueMs reflects
  // the time the message actually waited in the worker's FIFO. Computed
  // even on early-return failure paths so the slow-log/metrics see a
  // queue measurement on every call. Mirrors writer-worker.handleCall.
  const dequeueMs = Date.now();
  const queueMs = Math.max(0, dequeueMs - enqueueMs);

  if (!state) {
    post({
      type: "result",
      id,
      ok: false,
      error: "io-worker not initialized",
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
      error: "io-worker shutting down",
      queueMs,
      execMs: 0,
      cpuUserUs: 0,
      cpuSystemUs: 0,
    });
    return;
  }
  const handler = dispatch[op];
  if (!handler) {
    post({
      type: "result",
      id,
      ok: false,
      error: `unknown op: ${op}`,
      queueMs,
      execMs: 0,
      cpuUserUs: 0,
      cpuSystemUs: 0,
    });
    return;
  }
  const cpuBefore = process.cpuUsage();
  try {
    const value = handler(state.db, ...args);
    const execMs = Date.now() - dequeueMs;
    const cpuDelta = process.cpuUsage(cpuBefore);
    post({
      type: "result",
      id,
      ok: true,
      value: value ?? null,
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
    state.db.close();
  } catch {
    /* best-effort */
  }

  post({ type: "shutdownComplete" });
}

parentPort.on("message", (msg: MainToIo) => {
  switch (msg.type) {
    case "init":
      void handleInit(msg);
      break;
    case "call":
      handleCall(msg.id, msg.op, msg.args, msg.enqueueMs);
      break;
    case "shutdown":
      void handleShutdown();
      break;
    default:
      // Internal protocol — adding a new MainToIo variant should
      // fail the build at this site.
      assertNever(msg);
  }
});
