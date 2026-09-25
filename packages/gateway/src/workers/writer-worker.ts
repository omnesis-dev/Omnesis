// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Writer worker — owns the ONLY writable `better-sqlite3` handle to
 * `omnesis.db` across the entire gateway process. Main thread (read-
 * only) and the compute worker (read-only) send write-intent messages
 * here via {type:"call", op, args}, dispatched by the Scheduler's
 * WriterTaskRunner.
 *
 * Why single-writer: with two writable handles on macOS,
 * WAL's `-shm` mmap is shared between threads and when one connection's
 * checkpoint resizes it the other thread's in-progress read page-faults
 * → SIGBUS. Collapsing every writer into this worker puts exactly one
 * writer on the `-shm` mapping, matching the configuration Mozilla
 * landed on for the same class of bug.
 *
 * Protocol: see `protocol.ts`. The dispatch tables (`writerHandlers` +
 * `writerYieldableHandlers` from `scheduler/writer-handlers.ts`) hold
 * every op signature; this file just owns the worker thread's
 * lifecycle (init, message loop, shutdown, checkpoint).
 */

import Database from "better-sqlite3";
type Db = Database.Database;
import { parentPort } from "node:worker_threads";

import { assertNever } from "@omnesis/core";
import { writerHandlers, writerYieldableHandlers } from "../scheduler/writer-handlers.js";

import { PreemptToken } from "../scheduler/preempt.js";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import type { MainToWriter, WriterInit, WriterToMain, LogLevel } from "./protocol.js";

if (!parentPort) {
  throw new Error("writer-worker must be run as a Node worker_thread");
}

/**
 * No-op token used when init didn't include a shared preempt buffer
 * (tests, or a Scheduler with `enablePreemption: false`). Always
 * returns `false` from `requested()` so yieldable handlers run to
 * completion as if preemption were disabled.
 */
const NO_PREEMPT_TOKEN: PreemptToken = {
  requested: () => false,
} as PreemptToken;

function post(msg: WriterToMain): void {
  parentPort!.postMessage(msg);
}

function log(level: LogLevel, component: string, message: string): void {
  post({ type: "log", level, component, message });
}

function openWriteConn(
  path: string,
  journalMode: "WAL" | "TRUNCATE",
  gatewayDbKeyHex?: string,
): Db {
  const db = gatewayDbKeyHex
    ? (openEncryptedSqlite(path, {
        key: Buffer.from(gatewayDbKeyHex, "hex"),
        fileMustExist: true,
        migratePlaintext: false,
      }) as unknown as Db)
    : new Database(path, { fileMustExist: true });
  // Default WAL: MVCC-style concurrent reads, writes don't block
  // readers. Only safe with the single-writer architecture
  // (writer worker owns the only writable handle; main + backfill +
  // indexer are all read-only) — otherwise multi-writer races on the
  // `-shm` mmap reintroduce the SIGBUS class.
  // Opt-out path: TRUNCATE (rollback-journal, no `-shm`). Set
  // OMNESIS_JOURNAL_MODE=TRUNCATE or gateway.journalMode in
  // omnesis.json. Use it if a SIGBUS reappears under WAL.
  db.exec(`PRAGMA journal_mode = ${journalMode}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  // mmap_size=0 belt-and-suspenders against the residual Crash B
  // mmap class (disables DB-file mmap reads). Cheap; keep set in
  // both journal modes. TRUNCATE has no DB-file mmap risk; harmless.
  db.exec("PRAGMA mmap_size = 0");
  if (journalMode === "WAL") {
    // No per-commit autocheckpoint — let an explicit PASSIVE timer
    // drive checkpoints (see handleInit). PASSIVE never truncates
    // `-shm`, only copies frames back to the main DB; that's the
    // pattern that survived the chaos test. NEVER use a TRUNCATE
    // checkpoint here — that's the SIGBUS-prone op.
    db.exec("PRAGMA wal_autocheckpoint = 0");
  }
  // synchronous = FULL narrows the fsync window. Mozilla belt-and-
  // suspenders recipe; useful in both modes.
  db.exec("PRAGMA synchronous = FULL");
  return db;
}

let state: {
  db: Db;
  journalMode: "WAL" | "TRUNCATE";
  heartbeatInterval: ReturnType<typeof setInterval>;
  checkpointInterval: ReturnType<typeof setInterval>;
  shuttingDown: boolean;
  /** Constructed once at init from the SharedArrayBuffer (if any). */
  preemptToken: PreemptToken;
} | null = null;

// Explicit PASSIVE checkpoint cadence. Only fires in WAL mode — a
// no-op under TRUNCATE since there's no WAL to checkpoint.
const CHECKPOINT_INTERVAL_MS = 60_000;

function runPassiveCheckpoint(db: Db): void {
  try {
    // wal_checkpoint returns (busy, log_frames, checkpointed_frames).
    // PASSIVE never blocks on readers; the worst case is it copies 0
    // frames because a reader holds the oldest WAL frame. We don't
    // need the result — just log when it moves enough to be interesting.
    const startMs = Date.now();
    const res = db.pragma("wal_checkpoint(PASSIVE)") as Array<{
      busy: number;
      log: number;
      checkpointed: number;
    }>;
    const row = res[0];
    const tookMs = Date.now() - startMs;
    if (row && row.log > 0 && tookMs > 250) {
      log(
        "info",
        "writer-worker",
        `wal_checkpoint(PASSIVE) busy=${row.busy} log=${row.log} checkpointed=${row.checkpointed} in ${tookMs}ms`,
      );
    }
  } catch (err) {
    log(
      "warn",
      "writer-worker",
      `wal_checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleInit(init: WriterInit): Promise<void> {
  if (state) {
    log("warn", "writer-worker", "init received twice — ignoring");
    return;
  }
  try {
    const journalMode = init.journalMode;
    const db = openWriteConn(init.gatewayDbPath, journalMode, init.gatewayDbKeyHex);

    const heartbeatInterval = setInterval(() => {
      post({ type: "heartbeat", ts: Date.now() });
    }, init.heartbeatIntervalMs);

    // Timer-driven PASSIVE checkpoint replaces the autocheckpoint we
    // disabled in openWriteConn (WAL mode only; under TRUNCATE this
    // interval is installed but effectively a no-op — wal_checkpoint
    // on a non-WAL DB returns quickly with no effect).
    const checkpointInterval = setInterval(() => {
      if (!state || state.shuttingDown) return;
      if (state.journalMode !== "WAL") return;
      runPassiveCheckpoint(state.db);
    }, CHECKPOINT_INTERVAL_MS);

    const preemptToken = init.preemptBuffer
      ? new PreemptToken(init.preemptBuffer)
      : NO_PREEMPT_TOKEN;

    state = {
      db,
      journalMode,
      heartbeatInterval,
      checkpointInterval,
      shuttingDown: false,
      preemptToken,
    };

    log(
      "info",
      "writer-worker",
      `ready — owning writable handle on ${init.gatewayDbPath} (journal=${journalMode}, preempt=${init.preemptBuffer ? "on" : "off"})`,
    );
    post({ type: "ready" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "writer-worker", `init failed: ${msg}`);
    post({ type: "initError", error: msg });
  }
}

// Dispatch via the typed handler maps. The yieldable variants are
// checked first because their handler signature carries the preempt
// token after `db` and the runner's `asOutcome()` looks for the
// {kind:"yield"} discriminator on the return.
const yieldableDispatch = writerYieldableHandlers as Record<
  string,
  (db: Db, token: PreemptToken, ...args: unknown[]) => unknown
>;
const dispatch = writerHandlers as Record<string, (db: Db, ...args: unknown[]) => unknown>;

function serializeCallError(err: unknown): {
  error: string;
  errorName?: string;
  errorMessage?: string;
  errorCode?: string;
} {
  if (!(err instanceof Error)) return { error: String(err) };
  const code = (err as Error & { code?: unknown }).code;
  return {
    error: err.stack ?? err.message,
    errorName: err.name,
    errorMessage: err.message,
    ...(typeof code === "string" ? { errorCode: code } : {}),
  };
}

function handleCall(id: number, op: string, args: unknown[], enqueueMs: number): void {
  // Stamp dequeue immediately on entering the handler so queueMs
  // reflects the time the message actually waited in the worker's
  // FIFO (postMessage delivery + previous-op completion). Computed
  // even on early-return failure paths so the slow-log/metrics see
  // a queue measurement on every call.
  const dequeueMs = Date.now();
  const queueMs = Math.max(0, dequeueMs - enqueueMs);

  if (!state) {
    post({
      type: "result",
      id,
      ok: false,
      error: "writer-worker not initialized",
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
      error: "writer-worker shutting down",
      queueMs,
      execMs: 0,
      cpuUserUs: 0,
      cpuSystemUs: 0,
    });
    return;
  }
  // Yieldable ops take precedence — handler signature differs (carries
  // the preempt token) so we can't fall through. Same value semantics:
  // the runner's `asOutcome()` detects the {kind:"yield"} discriminator
  // and re-enqueues, so handlers can return either a value or a yield.
  const yieldableHandler = yieldableDispatch[op];
  if (yieldableHandler) {
    const cpuBefore = process.cpuUsage();
    try {
      const value = yieldableHandler(state.db, state.preemptToken, ...args);
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
      const execMs = Date.now() - dequeueMs;
      const cpuDelta = process.cpuUsage(cpuBefore);
      post({
        type: "result",
        id,
        ok: false,
        ...serializeCallError(err),
        queueMs,
        execMs,
        cpuUserUs: cpuDelta.user,
        cpuSystemUs: cpuDelta.system,
      });
    }
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
    const execMs = Date.now() - dequeueMs;
    const cpuDelta = process.cpuUsage(cpuBefore);
    post({
      type: "result",
      id,
      ok: false,
      ...serializeCallError(err),
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
  clearInterval(state.checkpointInterval);
  // Final PASSIVE checkpoint (WAL mode only) so the next boot doesn't
  // have a giant WAL to replay. Best-effort.
  if (state.journalMode === "WAL") {
    try {
      runPassiveCheckpoint(state.db);
    } catch {
      /* best-effort */
    }
  }
  try {
    state.db.close();
  } catch {
    /* best-effort */
  }

  post({ type: "shutdownComplete" });
}

parentPort.on("message", (msg: MainToWriter) => {
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
      // Internal protocol — adding a new MainToWriter variant should
      // fail the build at this site.
      assertNever(msg);
  }
});
