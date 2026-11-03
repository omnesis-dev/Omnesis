// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The memory the main thread shares with the stall watchdog, and the
 * messages the two exchange.
 *
 * The main thread writes; the watchdog thread only reads. One
 * `SharedArrayBuffer` holds:
 *
 *   - a heartbeat: the time (ms) the main thread last turned its event loop,
 *     written by a timer every `heartbeatIntervalMs`, and the longest gap
 *     between two heartbeats since the watchdog last took it. The gap is
 *     measured by the main thread itself, so a watchdog that falls behind —
 *     its own loop busy summarising a profile, or starved of CPU — misses
 *     heartbeats without mistaking the jump between them for a stall;
 *   - the activity stack: the ids of the units of synchronous work the main
 *     thread is inside right now, outermost first, and its depth;
 *   - the in-flight slots: the ids of asynchronous activities that have
 *     started and not yet settled, one per slot, 0 for a free slot.
 *
 * A stall is synchronous by definition, so while one lasts nothing on the
 * main thread changes these values: whatever the watchdog reads during it is
 * what the stalled thread was doing. Ids map to names through a registry the
 * main thread posts to the watchdog as each new name is first used.
 *
 * This module imports nothing at run time, so the watchdog thread that loads
 * it starts small.
 */

import type { ProfileFrame } from "./profile-summary.js";

/** Byte offset of the `BigInt64` heartbeat. */
const HEARTBEAT_BYTES = 8;

/** Int32 index of the activity stack's depth. */
export const DEPTH_INDEX = 0;
/** Int32 index of the outermost activity stack slot. */
export const STACK_BASE = 1;
/** Activities nested deeper than this still count toward the depth but are not recorded. */
export const STACK_SLOTS = 16;
/** Int32 index of the first in-flight slot. */
export const INFLIGHT_BASE = STACK_BASE + STACK_SLOTS;
/** Concurrent asynchronous activities tracked; more than this go untracked. */
export const INFLIGHT_SLOTS = 64;
/** Int32 index of the longest heartbeat gap not yet taken, in ms. */
const MAX_GAP_INDEX = INFLIGHT_BASE + INFLIGHT_SLOTS;
const INT32_LENGTH = MAX_GAP_INDEX + 1;

export interface StallSharedState {
  buffer: SharedArrayBuffer;
  /** `[0]` is the last heartbeat, in epoch milliseconds. */
  beat: BigInt64Array;
  /** The activity stack and in-flight slots; layout above. */
  slots: Int32Array;
}

export function createStallSharedState(): StallSharedState {
  return stallSharedStateOf(new SharedArrayBuffer(HEARTBEAT_BYTES + INT32_LENGTH * 4));
}

/** Views over a buffer made by {@link createStallSharedState}, on either thread. */
export function stallSharedStateOf(buffer: SharedArrayBuffer): StallSharedState {
  return {
    buffer,
    beat: new BigInt64Array(buffer, 0, 1),
    slots: new Int32Array(buffer, HEARTBEAT_BYTES, INT32_LENGTH),
  };
}

/**
 * Wall-clock milliseconds from this thread's monotonic clock. Each thread's
 * `timeOrigin` is taken from the wall clock when it starts, so two threads
 * agree to within a millisecond or so, while neither jumps when the system
 * clock is adjusted.
 */
export function epochNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Main thread: stamp a heartbeat at `nowMs`, the previous one having been at
 * `previousMs`. The gap is recorded before the stamp, so a watchdog that sees
 * the new stamp always finds the gap that ended at it.
 */
export function recordHeartbeat(state: StallSharedState, nowMs: number, previousMs: number): void {
  const gap = Math.round(nowMs - previousMs);
  for (;;) {
    const current = Atomics.load(state.slots, MAX_GAP_INDEX);
    if (gap <= current) break;
    if (Atomics.compareExchange(state.slots, MAX_GAP_INDEX, current, gap) === current) break;
  }
  Atomics.store(state.beat, 0, BigInt(Math.round(nowMs)));
}

/** Watchdog: the longest heartbeat gap since the last call, in ms; resets it. */
export function takeMaxGap(slots: Int32Array): number {
  return Atomics.exchange(slots, MAX_GAP_INDEX, 0);
}

/** What the main thread was doing at one instant, as activity ids (0 = none). */
export interface ActivitySample {
  /** The innermost synchronous activity. */
  inner: number;
  /** The outermost synchronous activity. */
  outer: number;
  /** Asynchronous activities started and not yet settled. */
  inFlight: number[];
}

export function sampleActivity(slots: Int32Array): ActivitySample {
  const depth = Atomics.load(slots, DEPTH_INDEX);
  const recorded = Math.min(depth, STACK_SLOTS);
  const inner = recorded > 0 ? Atomics.load(slots, STACK_BASE + recorded - 1) : 0;
  const outer = recorded > 0 ? Atomics.load(slots, STACK_BASE) : 0;
  const inFlight: number[] = [];
  for (let i = 0; i < INFLIGHT_SLOTS; i++) {
    const id = Atomics.load(slots, INFLIGHT_BASE + i);
    if (id !== 0) inFlight.push(id);
  }
  return { inner, outer, inFlight };
}

/** The flight recorder's policy, resolved to milliseconds. */
export interface FlightRecorderPolicy {
  /** A stall at least this long counts toward the budget. */
  minStallMs: number;
  /** This many counting stalls within `windowMs` start a capture. */
  stallCount: number;
  windowMs: number;
  /** How long one capture profiles for. */
  durationMs: number;
  /** Least time between the starts of two captures. */
  cooldownMs: number;
  /** Profile summaries kept on disk. */
  keep: number;
}

/** Everything the watchdog thread needs, handed over as `workerData`. */
export interface StallWatchdogInit {
  buffer: SharedArrayBuffer;
  heartbeatIntervalMs: number;
  /** A gap at least this long beyond the heartbeat interval is a stall. */
  thresholdMs: number;
  /** How often the watchdog reads the shared memory. */
  pollIntervalMs: number;
  /** Null when the flight recorder is off. */
  profile: FlightRecorderPolicy | null;
  /** Directory the profile summaries are kept in. */
  profileDir: string;
  /** Absolute path that profile file paths are made relative to. */
  codeRoot: string;
}

/** Main thread → watchdog: activity names first used since the last message. */
export interface ActivityNamesMessage {
  type: "names";
  entries: Array<[id: number, name: string]>;
}

/** One stall, as the watchdog observed it. */
export interface StallEvent {
  /** Epoch ms the event loop stopped turning (to within a heartbeat interval). */
  startedAt: number;
  durationMs: number;
  /** The innermost synchronous activity seen most often during the stall, if any. */
  activity: string | null;
  /** The outermost synchronous activity it was nested in. */
  outer: string | null;
  /** Asynchronous activities in flight during the stall, most often seen first. */
  inFlight: string[];
  /**
   * Where in the code the stall was, from a short profile the watchdog took
   * while it lasted: the innermost frame of the repository's own code on the
   * hottest stack. Null when no snapshot was taken (see the watchdog for when
   * one is) or none of the hot stack was our code.
   */
  code: ProfileFrame | null;
  /**
   * The innermost marked activity the main thread was in while the snapshot
   * behind `code` sampled it; null when no snapshot named code, or when no
   * activity was marked.
   * Callbacks that fall due together run back to back within one gap, so this
   * can differ from `activity`, which is the one seen for most of the stall.
   */
  codeActivity: string | null;
  /** The snapshot's hottest stack, innermost frame first; empty without one. */
  stack: ProfileFrame[];
  /** The flight-recorder capture this stall fell inside, if one was running. */
  profileId: string | null;
}

/** Watchdog → main thread. */
export type StallWatchdogMessage =
  | { type: "ready" }
  | { type: "stall"; stall: StallEvent }
  | { type: "profile-started"; id: string; durationMs: number; reason: string }
  | {
      type: "profile-finished";
      id: string;
      /** Where the summary was written; null when the capture held no long busy run. */
      file: string | null;
      /** Where in the code the long busy runs spent most time, as `name (file:line)`. */
      top: string | null;
      busyMs: number;
    }
  | { type: "profile-failed"; id: string; error: string };
