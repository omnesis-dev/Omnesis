// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What the event-loop watchdog's two threads share, and the worker's logic. Kept free of any Omnesis
 * import so the worker thread loads nothing but Node built-ins and this file.
 */

/** What the watchdog worker is started with. */
export interface WatchdogWorkerData {
  /** One slot the main thread increments while its event loop turns. */
  heartbeat: BigInt64Array;
  stallLimitMs: number;
  /** How often the worker reads the heartbeat. */
  checkIntervalMs: number;
  /** How long capturing the stack may take before the process is killed without it. */
  captureTimeoutMs: number;
}

/** The message the worker posts once it is watching. */
export const WATCHDOG_ARMED = "armed";

/**
 * Whether the main thread has stalled, judged from the worker's checks.
 *
 * Time is counted on the worker's monotonic clock and only while the worker
 * was running. A check that arrives far later than its interval means the
 * whole process was suspended — a sleeping laptop, a stopped or swapped-out
 * process — and the main thread had no chance to move the heartbeat either,
 * so the count starts over rather than blaming it for time nobody ran.
 */
export class StallJudge {
  private lastBeat: bigint;
  private lastCheckAt: number;
  private movedAt: number;

  constructor(
    private readonly stallLimitMs: number,
    private readonly suspendedGapMs: number,
    beat: bigint,
    now: number,
  ) {
    this.lastBeat = beat;
    this.lastCheckAt = now;
    this.movedAt = now;
  }

  /** How long the main thread has stalled, once past the limit; otherwise null. */
  check(beat: bigint, now: number): number | null {
    const suspended = now - this.lastCheckAt > this.suspendedGapMs;
    this.lastCheckAt = now;
    if (beat !== this.lastBeat || suspended) {
      this.lastBeat = beat;
      this.movedAt = now;
      return null;
    }
    const stalledMs = now - this.movedAt;
    return stalledMs >= this.stallLimitMs ? stalledMs : null;
  }
}

/** One frame of a paused thread, as the inspector reports it. */
export interface PausedFrame {
  functionName: string;
  url: string;
  location: { scriptId: string; lineNumber: number; columnNumber: number };
}

/**
 * A paused stack as `at fn (file:line:col)` lines, innermost first. The
 * inspector leaves a frame's url empty for most scripts and names the script
 * by id instead, so the id is resolved through the scripts it announced.
 */
export function formatPausedStack(
  frames: readonly PausedFrame[],
  scriptUrls: ReadonlyMap<string, string>,
): string {
  if (frames.length === 0) return "  (no frames)";
  return frames
    .map((frame) => {
      const url = frame.url || scriptUrls.get(frame.location.scriptId) || "<unknown>";
      const name = frame.functionName || "<anonymous>";
      return `  at ${name} (${url}:${frame.location.lineNumber + 1}:${frame.location.columnNumber + 1})`;
    })
    .join("\n");
}
