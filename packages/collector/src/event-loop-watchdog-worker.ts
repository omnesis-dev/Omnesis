// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The watchdog's worker thread: see `event-loop-watchdog.ts`.
 *
 * Everything here writes synchronously to file descriptors. A worker's
 * `console` and `process.stderr` are relayed through the main thread, which is
 * the thread that has stopped, so anything written that way is never seen.
 */

import { appendFileSync, writeSync } from "node:fs";
import { Session } from "node:inspector";
import { parentPort, workerData } from "node:worker_threads";
import {
  formatPausedStack,
  StallJudge,
  WATCHDOG_ARMED,
  type PausedFrame,
  type WatchdogWorkerData,
} from "./event-loop-watchdog-shared.js";

const { heartbeat, stallLimitMs, checkIntervalMs, captureTimeoutMs } =
  workerData as WatchdogWorkerData;

/** A check this late means the process itself was not running. */
const SUSPENDED_GAP_MS = 3 * checkIntervalMs;

const nowMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

function report(message: string): void {
  const line = `${new Date().toISOString()} ERROR [collector:watchdog] ${message}\n`;
  try {
    writeSync(2, line);
  } catch {
    // stderr closed; the log file below may still take it
  }
  const logFile = process.env.OMNESIS_LOG_FILE;
  if (logFile) {
    try {
      appendFileSync(logFile, line);
    } catch {
      // nothing else to write to
    }
  }
}

function die(): void {
  // A stalled main thread cannot run a SIGTERM handler, so only a signal it
  // does not handle ends the process. The service unit restarts it.
  process.kill(process.pid, "SIGKILL");
}

/**
 * Pause the main thread and report where it is. The inspector interrupts
 * running JavaScript to deliver the pause, so this works while the thread
 * spins. Whatever happens, the process is killed afterwards.
 */
function captureAndDie(stalledMs: number): void {
  const header = `Event loop stalled for ${Math.round(stalledMs / 1000)}s; restarting the collector`;
  const deadline = setTimeout(() => {
    report(`${header}. The stack could not be captured within ${captureTimeoutMs}ms.`);
    die();
  }, captureTimeoutMs);
  try {
    const session = new Session();
    session.connectToMainThread();
    const scriptUrls = new Map<string, string>();
    session.on("Debugger.scriptParsed", (message) => {
      scriptUrls.set(message.params.scriptId, message.params.url);
    });
    session.on("Debugger.paused", (message) => {
      clearTimeout(deadline);
      const frames = message.params.callFrames as unknown as PausedFrame[];
      report(`${header}. Main thread stack:\n${formatPausedStack(frames, scriptUrls)}`);
      die();
    });
    session.post("Debugger.enable", () => {
      session.post("Debugger.pause");
    });
  } catch (err) {
    clearTimeout(deadline);
    report(
      `${header}. The stack could not be captured: ${err instanceof Error ? err.message : String(err)}`,
    );
    die();
  }
}

const judge = new StallJudge(stallLimitMs, SUSPENDED_GAP_MS, Atomics.load(heartbeat, 0), nowMs());

const check = setInterval(() => {
  const stalledMs = judge.check(Atomics.load(heartbeat, 0), nowMs());
  if (stalledMs === null) return;
  clearInterval(check);
  captureAndDie(stalledMs);
}, checkIntervalMs);

parentPort?.postMessage(WATCHDOG_ARMED);
