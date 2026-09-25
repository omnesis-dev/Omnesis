// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Restart a collector whose event loop has stopped turning.
 *
 * A collector stuck in synchronous JavaScript stays alive while doing
 * nothing: no sync, no log line, no answer to the gateway's heartbeat. Its
 * service manager restarts a process that exits, not one that is merely
 * busy, so a stall of that kind lasts until someone notices it. Nothing on
 * the stalled thread can notice either, since its timers never fire.
 *
 * So the main thread increments a counter in shared memory every second, and
 * a worker thread — its own event loop, unaffected by the stall — watches it.
 * Once the counter has not moved for the stall limit, the worker pauses the
 * main thread through the inspector to record the JavaScript stack it is
 * stuck in, writes that to stderr and the log file, and kills the process.
 * The service unit restarts a collector that died on a signal.
 */

import { url as inspectorUrl } from "node:inspector";
import { Worker } from "node:worker_threads";
import { createLogger, resolveWorkerEntry } from "@omnesis/core";
import { WATCHDOG_ARMED, type WatchdogWorkerData } from "./event-loop-watchdog-shared.js";

const log = createLogger("collector").child("watchdog");

/**
 * How long the event loop may go without turning before the collector is
 * restarted. Far past anything a healthy collector blocks for — its slowest
 * synchronous work is a local database read — and short against the hours a
 * stall otherwise lasts.
 */
export const EVENT_LOOP_STALL_LIMIT_MS = 5 * 60_000;

/** How often the main thread moves the heartbeat. */
const HEARTBEAT_INTERVAL_MS = 1_000;

export interface EventLoopWatchdogOptions {
  stallLimitMs?: number;
  heartbeatIntervalMs?: number;
}

/**
 * Start the watchdog for this process. Neither the heartbeat timer nor the
 * worker holds the process open. A process with an inspector attached is left
 * unwatched: a developer stopped at a breakpoint is a stalled loop too.
 */
export function startEventLoopWatchdog(options: EventLoopWatchdogOptions = {}): void {
  if (inspectorUrl()) {
    log.info("Event-loop watchdog not armed: an inspector is attached");
    return;
  }
  const stallLimitMs = options.stallLimitMs ?? EVENT_LOOP_STALL_LIMIT_MS;
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(8));
  const timer = setInterval(
    () => Atomics.add(heartbeat, 0, 1n),
    options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
  );
  timer.unref();

  const entry = resolveWorkerEntry(
    "./event-loop-watchdog-worker.ts",
    import.meta.url,
    "./register-tsx.mjs",
  );
  const workerData: WatchdogWorkerData = {
    heartbeat,
    stallLimitMs,
    checkIntervalMs: Math.max(250, Math.min(10_000, Math.floor(stallLimitMs / 10))),
    captureTimeoutMs: 10_000,
  };
  const worker = new Worker(entry.url, { workerData, execArgv: entry.execArgv });
  worker.unref();
  worker.once("message", (message) => {
    if (message !== WATCHDOG_ARMED) return;
    log.info(
      `Event-loop watchdog armed: restart after ${Math.round(stallLimitMs / 1000)}s stalled`,
    );
  });
  // The watchdog is a safety net: losing it must never take the collector down.
  worker.on("error", (err) => {
    log.warn(`Event-loop watchdog stopped: ${err instanceof Error ? err.message : String(err)}`);
  });
}
