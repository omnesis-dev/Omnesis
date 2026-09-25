// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * CPU worker — pure-compute sibling of io-worker.ts.
 *
 * Owns NO database handle. Receives pre-fetched data via postMessage
 * and returns pure-compute results. Intended for CPU-heavy work that
 * the io worker currently interleaves with SQL reads: MinHash
 * signing, shingle extraction, weighted Jaccard verification, link
 * extraction regex, merge-candidate IDF scoring.
 *
 * Protocol mirrors the io worker (same call/result envelope) so
 * the CpuTaskRunner on the main thread is structurally identical to
 * IoTaskRunner. Dispatch table lives in `scheduler/cpu-handlers.ts`.
 */

import { parentPort } from "node:worker_threads";

import { assertNever } from "@omnesis/core";
import { cpuHandlers } from "../scheduler/cpu-handlers.js";
import { deprioritizeBackgroundWorker } from "./worker-priority.js";

import type { CpuInit, CpuToMain, LogLevel, MainToCpu } from "./protocol.js";

if (!parentPort) {
  throw new Error("cpu-worker must be run as a Node worker_thread");
}

function post(msg: CpuToMain): void {
  parentPort!.postMessage(msg);
}

function log(level: LogLevel, component: string, message: string): void {
  post({ type: "log", level, component, message });
}

const dispatch = cpuHandlers as Record<string, (...args: unknown[]) => unknown>;

let state: {
  heartbeatInterval: ReturnType<typeof setInterval>;
  shuttingDown: boolean;
} | null = null;

async function handleInit(init: CpuInit): Promise<void> {
  if (state) {
    log("warn", "cpu-worker", "init received twice — ignoring");
    return;
  }
  try {
    const heartbeatInterval = setInterval(() => {
      post({ type: "heartbeat", ts: Date.now() });
    }, init.heartbeatIntervalMs);

    state = { heartbeatInterval, shuttingDown: false };

    // Yield CPU to real-time work (main-loop reads, writer, embedder) under
    // contention — this pool is background compute only. See #199 (Lever 3).
    const nice = deprioritizeBackgroundWorker(init.backgroundWorkerNice, "cpu", (m) =>
      log("warn", "cpu-worker", m),
    );
    log("info", "cpu-worker", nice !== null ? `ready — background nice ${nice}` : "ready");
    post({ type: "ready" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("error", "cpu-worker", `init failed: ${msg}`);
    post({ type: "initError", error: msg });
  }
}

function handleCall(id: number, op: string, args: unknown[], enqueueMs: number): void {
  const dequeueMs = Date.now();
  const queueMs = Math.max(0, dequeueMs - enqueueMs);

  if (!state) {
    post({
      type: "result",
      id,
      ok: false,
      error: "cpu-worker not initialized",
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
      error: "cpu-worker shutting down",
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
    const value = handler(...args);
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
  post({ type: "shutdownComplete" });
}

parentPort.on("message", (msg: MainToCpu) => {
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
      assertNever(msg);
  }
});
