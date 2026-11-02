// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which unit of work the main thread is running, published where the stall
 * watchdog thread can read it while the main thread is stuck.
 *
 * `withActivity(name, fn)` marks `fn`'s synchronous run with `name`, nested
 * marks forming a short stack, and restores the previous mark when `fn`
 * returns or throws. When `fn` returns a promise, `name` also occupies an
 * in-flight slot until that promise settles: the synchronous mark covers
 * only the code before `fn`'s first `await`, and the in-flight slot is what
 * still names the work when a later continuation of it is the one that
 * stalls.
 *
 * It is wired at a few choke points — the scheduler's main-thread runner
 * (the task name), the HTTP layer (`METHOD route-pattern`), WebSocket
 * message dispatch, and the periodic refreshes that are not scheduler tasks
 * — rather than around every call. Names are code-chosen labels, never data:
 * a route pattern, not the URL it matched.
 *
 * The cost is a map lookup and a few stores into shared memory per call, plus
 * one extra promise reaction for asynchronous work; there is no
 * AsyncLocalStorage and no hook on every promise.
 */

import {
  createStallSharedState,
  DEPTH_INDEX,
  INFLIGHT_BASE,
  INFLIGHT_SLOTS,
  STACK_BASE,
  STACK_SLOTS,
  type StallSharedState,
} from "./stall-protocol.js";

/**
 * Distinct names the registry holds. Every name is a code-chosen label, so
 * real use stays far below this; the cap only bounds a label built from
 * something unexpected.
 */
export const MAX_ACTIVITY_NAMES = 1024;

/** The name every activity past the cap is recorded under. */
export const OVERFLOW_ACTIVITY = "(other)";

const shared: StallSharedState = createStallSharedState();
const ids = new Map<string, number>();
/** Index = id. Id 0 means "no activity". */
const names: string[] = [""];
let depth = 0;
let nextInFlightSlot = 0;
let onNewName: ((id: number, name: string) => void) | null = null;

function register(name: string): number {
  const id = names.length;
  names.push(name);
  ids.set(name, id);
  onNewName?.(id, name);
  return id;
}

register(OVERFLOW_ACTIVITY);

function activityId(name: string): number {
  const known = ids.get(name);
  if (known !== undefined) return known;
  if (names.length >= MAX_ACTIVITY_NAMES) return 1;
  return register(name);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Hold an in-flight slot for `pending` until it settles. Returns a promise
 * that settles the same way rather than reacting to `pending` itself, so a
 * rejection nobody handles stays unhandled — reported, not swallowed by the
 * release.
 */
function trackInFlight(id: number, pending: PromiseLike<unknown>): PromiseLike<unknown> {
  const slots = shared.slots;
  for (let i = 0; i < INFLIGHT_SLOTS; i++) {
    const slot = (nextInFlightSlot + i) % INFLIGHT_SLOTS;
    if (Atomics.compareExchange(slots, INFLIGHT_BASE + slot, 0, id) !== 0) continue;
    nextInFlightSlot = (slot + 1) % INFLIGHT_SLOTS;
    const release = (): void => {
      Atomics.store(slots, INFLIGHT_BASE + slot, 0);
    };
    return pending.then(
      (value) => {
        release();
        return value;
      },
      (err: unknown) => {
        release();
        throw err;
      },
    );
  }
  // Every slot is taken: this activity goes untracked rather than evicting one.
  return pending;
}

/**
 * Run `fn` marked as `name`. Returns what `fn` returns and rethrows what it
 * throws; when `fn` returns a promise, the result is a promise that settles
 * the same way, with the same value or reason.
 */
export function withActivity<T>(name: string, fn: () => T): T {
  const id = activityId(name);
  const slots = shared.slots;
  const saved = depth;
  if (saved < STACK_SLOTS) Atomics.store(slots, STACK_BASE + saved, id);
  depth = saved + 1;
  Atomics.store(slots, DEPTH_INDEX, depth);
  let result: T;
  try {
    result = fn();
  } finally {
    // Restore the saved depth rather than decrementing, so an imbalance can
    // never outlive the call that caused it.
    depth = saved;
    Atomics.store(slots, DEPTH_INDEX, saved);
  }
  return isPromiseLike(result) ? (trackInFlight(id, result) as T) : result;
}

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/**
 * The activity name of an HTTP request: its method and the pattern of the
 * route that handles it, or `(unmatched)` when no route does. A method
 * outside the standard set is folded into one name, since it is whatever the
 * client sent.
 */
export function httpActivityName(method: string, pattern: string): string {
  return `${HTTP_METHODS.has(method) ? method : "OTHER"} ${pattern || "(unmatched)"}`;
}

/** The shared memory the watchdog reads. One per thread that imports this module. */
export function activitySharedState(): StallSharedState {
  return shared;
}

/** The name an id stands for, or null for 0 / an unknown id. */
export function activityName(id: number): string | null {
  return id > 0 && id < names.length ? names[id]! : null;
}

/**
 * Be told of every name registered from now on, and receive the ones
 * registered so far. One listener: the stall monitor.
 */
export function subscribeActivityNames(
  listener: ((id: number, name: string) => void) | null,
): Array<[number, string]> {
  onNewName = listener;
  return names.slice(1).map((name, i) => [i + 1, name]);
}
