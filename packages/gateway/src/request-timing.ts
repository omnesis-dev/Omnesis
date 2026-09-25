// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Per-request timing accumulator threaded through AsyncLocalStorage.
 *
 * Why: the slow-request log line previously reported only total
 * wall-clock ("slow GET /status in 41442ms"). Under heavy background
 * load that 41s could be (a) a single multi-second writer op the
 * route waited on, (b) the route waiting in the writer-worker FIFO
 * behind dozens of background ops, or (c) a slow read on the main
 * thread. Without breaking the time down we couldn't tell which
 * bottleneck to fix.
 *
 * Every writer-runner call goes through `Scheduler.enqueue()` — the
 * Scheduler captures `queueMs` (time waiting in the priority queue) and
 * `execMs` (time the worker actually spent) and accumulates them into
 * the active RequestTiming via `recordWriterCall`. The slow-log
 * middleware reads the totals back at response time.
 *
 * Routes that do no writer calls naturally report queue=0/exec=0
 * with the slow time being middleware + read + handler — still
 * useful for spotting cases where the read-only handle is the
 * bottleneck (e.g. a heavy /search query).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestTiming {
  /**
   * Total time (ms) the request spent waiting for writer-worker slots
   * across all writer-proxy `call()`s issued from this request.
   * Sum of (dequeueMs - enqueueMs) per call.
   */
  writerQueueMs: number;
  /**
   * Total time (ms) the writer worker spent actually running ops
   * issued by this request. Sum of (finishMs - dequeueMs) per call.
   */
  writerExecMs: number;
  /** Number of writer-proxy calls issued by this request. */
  writerCalls: number;
}

const storage = new AsyncLocalStorage<RequestTiming>();

export function newRequestTiming(): RequestTiming {
  return { writerQueueMs: 0, writerExecMs: 0, writerCalls: 0 };
}

/**
 * Run `fn` inside the storage scope of the supplied `timing` object.
 * The middleware passes its own pre-allocated timing in so it can
 * read the accumulated counts AFTER the scope ends — `storage.getStore()`
 * outside the scope returns undefined, so the slow-log can't poll it
 * post-`next()`.
 */
export function runWithTiming<T>(timing: RequestTiming, fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run(timing, fn);
}

/** Convenience wrapper that creates a fresh timing internally. */
export function withRequestTiming<T>(fn: () => Promise<T> | T): Promise<T> | T {
  return storage.run(newRequestTiming(), fn);
}

/** Returns the active timing accumulator, or null if outside a request. */
export function getRequestTiming(): RequestTiming | null {
  return storage.getStore() ?? null;
}

/**
 * Add a single writer-runner call's measurements to a previously
 * captured RequestTiming reference. We resolve the active timing
 * object at Scheduler.enqueue() time (when AsyncLocalStorage is
 * alive) and pass it back here when the worker reply arrives — the
 * reply runs in the worker.on("message") event-loop tick which is
 * outside the request's async context, so `storage.getStore()` would
 * return undefined there. Capturing the reference dodges that.
 *
 * No-op if `timing` is null (call was issued from gateway boot
 * wiring or a periodic task without a request context).
 */
export function recordWriterCall(
  timing: RequestTiming | null,
  queueMs: number,
  execMs: number,
): void {
  if (!timing) return;
  timing.writerQueueMs += queueMs;
  timing.writerExecMs += execMs;
  timing.writerCalls += 1;
}
