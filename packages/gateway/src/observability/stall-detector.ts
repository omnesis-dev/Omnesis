// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The watchdog's judgement, free of threads and clocks so it can be driven
 * step by step in a test.
 *
 * The main thread stamps a heartbeat every `heartbeatIntervalMs` and keeps
 * the longest gap between two of its stamps. The watchdog calls
 * {@link StallDetector.poll} on its own timer with the latest stamp and its
 * own clock:
 *
 *   - While the stamp is overdue (older than two heartbeat intervals) the
 *     main thread is stuck, and each poll samples what it is stuck in.
 *   - When the stamp moves again, the longest gap the main thread measured
 *     since the last move, less the interval its timer was meant to wait, is
 *     how long the loop was blocked — the same "lag" an event-loop-delay
 *     histogram measures. At or above the threshold that is a stall,
 *     attributed to the activity seen in most of its samples. Taking the gap
 *     from the main thread, not from the stamps this thread happened to see,
 *     is what keeps a watchdog that fell behind from reporting a stall that
 *     did not happen.
 *
 * A poll that arrives long after the previous one means this thread was not
 * running either: the whole process was suspended (a sleeping laptop, a
 * stopped container), and the gap it leaves in the heartbeat is not a stall.
 */

import type { ActivitySample } from "./stall-protocol.js";

export interface DetectedStall {
  startedAt: number;
  durationMs: number;
  /** Innermost activity id seen most often, 0 when most samples saw none. */
  inner: number;
  outer: number;
  /** In-flight activity ids, most often seen first. */
  inFlight: number[];
}

/** In-flight activities a stall reports, at most. */
const MAX_IN_FLIGHT_REPORTED = 8;

export class StallDetector {
  private lastBeat: number;
  private lastPollAt: number;
  private suspended = false;
  private stackCounts = new Map<string, { inner: number; outer: number; n: number }>();
  private inFlightCounts = new Map<number, number>();

  constructor(
    private readonly heartbeatIntervalMs: number,
    private readonly thresholdMs: number,
    /** A poll arriving this long after the previous one means the process was suspended. */
    private readonly suspendedGapMs: number,
    initialBeat: number,
    now: number,
  ) {
    this.lastBeat = initialBeat;
    this.lastPollAt = now;
  }

  /**
   * `takeMaxGap` returns, and resets, the longest gap between two heartbeats
   * the main thread measured; it is called only when the stamp has moved.
   */
  poll(
    beat: number,
    now: number,
    sample: () => ActivitySample,
    takeMaxGap: () => number,
  ): DetectedStall | null {
    if (now - this.lastPollAt > this.suspendedGapMs) this.suspended = true;
    this.lastPollAt = now;

    if (beat !== this.lastBeat) {
      this.lastBeat = beat;
      const gapMs = takeMaxGap();
      const lagMs = gapMs - this.heartbeatIntervalMs;
      const suspended = this.suspended;
      this.suspended = false;
      const attribution = this.takeAttribution();
      if (suspended || lagMs < this.thresholdMs) return null;
      return {
        // The longest gap is, but for a watchdog that fell behind, the one
        // that ended at this stamp.
        startedAt: beat - gapMs + this.heartbeatIntervalMs,
        durationMs: Math.round(lagMs),
        ...attribution,
      };
    }

    if (now - this.lastBeat > 2 * this.heartbeatIntervalMs) this.record(sample());
    return null;
  }

  private record(s: ActivitySample): void {
    const key = `${s.inner}:${s.outer}`;
    const entry = this.stackCounts.get(key);
    if (entry) entry.n += 1;
    else this.stackCounts.set(key, { inner: s.inner, outer: s.outer, n: 1 });
    for (const id of new Set(s.inFlight)) {
      this.inFlightCounts.set(id, (this.inFlightCounts.get(id) ?? 0) + 1);
    }
  }

  private takeAttribution(): Pick<DetectedStall, "inner" | "outer" | "inFlight"> {
    // The mode over every sample, "nothing marked" included: an activity
    // seen in a minority of the samples is not what the stall was.
    let best: { inner: number; outer: number; n: number } | null = null;
    for (const entry of this.stackCounts.values()) {
      if (!best || entry.n > best.n) best = entry;
    }
    const inFlight = [...this.inFlightCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_IN_FLIGHT_REPORTED)
      .map(([id]) => id);
    this.stackCounts = new Map();
    this.inFlightCounts = new Map();
    return { inner: best?.inner ?? 0, outer: best?.outer ?? 0, inFlight };
  }
}

/**
 * When the flight recorder should capture: once `stallCount` stalls of at
 * least `minStallMs` fall within `windowMs`, unless a capture started less
 * than `cooldownMs` ago or one is still running.
 */
export class ProfileTrigger {
  private recent: number[] = [];
  private lastStartAt = Number.NEGATIVE_INFINITY;
  private running = false;

  constructor(
    private readonly policy: {
      minStallMs: number;
      stallCount: number;
      windowMs: number;
      cooldownMs: number;
    },
  ) {}

  /** Note a stall that ended at `now`; true when a capture should start now. */
  noteStall(durationMs: number, now: number): boolean {
    if (durationMs < this.policy.minStallMs) return false;
    this.recent.push(now);
    this.recent = this.recent.filter((t) => now - t <= this.policy.windowMs);
    if (this.running) return false;
    if (now - this.lastStartAt < this.policy.cooldownMs) return false;
    if (this.recent.length < this.policy.stallCount) return false;
    this.running = true;
    this.lastStartAt = now;
    this.recent = [];
    return true;
  }

  /** The capture that {@link noteStall} started has ended, however it ended. */
  finished(): void {
    this.running = false;
  }
}
