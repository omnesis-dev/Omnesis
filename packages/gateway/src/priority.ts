// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Writer-worker priority context.
 *
 * Three priority classes for writer-proxy ops:
 *   - "user"       — cli, portal, ios. Human is waiting on
 *                    a response right now. Sub-second latency target.
 *   - "realtime"   — collector ingest paths (POST /documents,
 *                    /sync-state). Async-of-a-human but still on the
 *                    user's clock — slow ones make the collector
 *                    fall behind.
 *   - "background" — backfill worker drips, people counts, link
 *                    reconcile, source-stats refresh, snapshot
 *                    reconcile, fire-and-forget beacons. Nobody is
 *                    waiting on these synchronously; they just need
 *                    to make eventual progress.
 *
 * Set per-request via `runWithPriority(priority, fn)`. The HTTP
 * middleware tags incoming requests based on the caller's device
 * kind; specific call sites can override with a tighter context
 * (e.g. wrap a snapshot reconcile in `runWithPriority("background",
 * ...)` even though the caller is the collector).
 *
 * Read by `Scheduler.enqueue()` at enqueue time via
 * `getActivePriority()`. The Scheduler's priority queue uses this to
 * decide which pending task to dispatch next.
 *
 * Anti-starvation is enforced inside the Scheduler, not here. See
 * `Scheduler.popNext()`.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { CallerKind } from "./metrics.js";

export type Priority = "user" | "realtime" | "background";

const store = new AsyncLocalStorage<Priority>();

export function runWithPriority<T>(priority: Priority, fn: () => Promise<T> | T): Promise<T> | T {
  return store.run(priority, fn);
}

/**
 * Returns the active priority if `runWithPriority` is on the stack,
 * otherwise null. Used by the Scheduler to distinguish "the caller
 * explicitly tagged this request" from "use the task definition's
 * default priority"; a plain "realtime" fallback would hide that
 * distinction.
 */
export function getActivePriority(): Priority | null {
  return store.getStore() ?? null;
}

/**
 * Run `fn` with no ambient priority, whatever the caller's.
 *
 * The store follows asynchronous work, which is what makes it useful for a
 * request and wrong for a timer: a timer armed inside a request's scope
 * keeps that scope for every tick it ever fires, and so does the timer it
 * arms next. Periodic scheduling uses this to arm from a clean context, so
 * a task's cadence never inherits the priority of whoever last asked it to
 * run sooner.
 */
export function runOutsidePriority<T>(fn: () => T): T {
  return store.exit(fn);
}

/**
 * Map a resolved caller kind to a default priority. Override at
 * the call site when the route is known to be heavier than the
 * caller's priority would suggest (snapshot reconcile from
 * collector should be "background", not "realtime").
 */
export function callerKindToPriority(kind: CallerKind): Priority {
  switch (kind) {
    // Agent integrations acknowledge subscription wakes and may use the
    // firing-bound Answer route, so classify them as user work. The browser
    // extension pushes captured pages the way a phone pushes its health
    // rows, so it takes the tier every other push contributor gets.
    case "cli":
    case "portal":
    case "ios":
    case "android":
    case "agent":
    case "browser":
      return "user";
    case "collector":
      return "realtime";
    case "unknown":
    default:
      return "realtime";
  }
}
