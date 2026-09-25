// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Shared internals for the scheduler split. Types and
 * helpers used by `SchedulerCore`, `MetricsCollector`,
 * `PeriodicScheduler`, `WakeableScheduler`, and `WriterQueueInspector`.
 *
 * Nothing in this file is exported from the package's public surface —
 * the façade in `scheduler.ts` re-exports `Scheduler` and `SchedulerOptions`
 * only. New consumers that need a sub-class should import directly from
 * the matching `scheduler/<sub>.ts` file.
 */

import type { Logger } from "@omnesis/core";
import type { RequestTiming } from "../request-timing.js";
import type { PreemptBuffer } from "./preempt.js";
import type { TaskRunner } from "./runner.js";
import type {
  Priority,
  RunnerKind,
  PeriodicTask,
  Task,
  TaskOutcome,
  WakeableTask,
} from "./types.js";
import type { TaskExecOutcome } from "./metrics.js";

export const PRIORITIES: readonly Priority[] = ["user", "realtime", "background"];

/** Per-priority queue caps. Identical to the legacy WriterWorkerProxy caps. */
export const DEFAULT_QUEUE_CAP: Record<Priority, number> = {
  user: 200,
  realtime: 1000,
  background: 500,
};

/**
 * Anti-starvation budget: any background task aged past this gets
 * one chance to jump ahead of higher-priority work, rate-limited.
 * Same shape as today's writer-worker-proxy.
 */
export const STARVATION_BUDGET_MS = 10_000;
export const STARVATION_MIN_INTERVAL_MS = 1_000;

/**
 * Default reserved-user-slot count per runner kind (see
 * {@link RunnerState.reservedUserSlots}). Only the io pool reserves: it hosts
 * minutes-long non-user compute (near-dup DF rebuild, link/interaction stats,
 * and the realtime snapshot-reconcile diff) and latency-sensitive user reads
 * (`browsePeople`, `lookupPeople`, merge-candidates, doc-search) on the *same*
 * workers, and — running at concurrency > 1 — has no in-flight preemption (a
 * `PreemptBuffer` is built only for single-in-flight runners). Keeping one slot
 * free of *non-user* work (background and realtime alike — realtime reconcile
 * is not human-latency-sensitive and can otherwise camp the slot for minutes)
 * is the spatial complement to the admission pause's temporal one: a user read
 * always has somewhere to land without waiting for in-flight non-user work to
 * drain. The writer/cpu/main pools run background at full width. Overridable
 * per registration via `SchedulerCoreOptions.reservedUserSlotsByRunner`.
 */
export const DEFAULT_RESERVED_USER_SLOTS: Partial<Record<RunnerKind, number>> = { io: 1 };

export const DEFAULT_LATENCY_BUDGET_MS = 200;
export const DEFAULT_USER_SLA_BUDGET_MS = 1_000;

/** Sliding-window cap for per-task exec samples. */
export const PER_TASK_SAMPLES = 500;

/** Sliding-window cap for SLA samples (ring buffer in MetricsCollector). */
export const SLA_RING = 2_000;

export interface PendingTask {
  /** Stable id (for inflight Map keying). */
  id: number;
  task: Task<unknown, unknown>;
  args: unknown;
  /** Resolved priority — may be lower than task.priority for explicit overrides. */
  priority: Priority;
  enqueueMs: number;
  /** Promise plumbing — re-used across continuations. */
  resolve: (v: unknown) => void;
  reject: (err: Error) => void;
  /** True for re-enqueued continuations; skip coalesce check. */
  isContinuation: boolean;
  /**
   * The scheduled task that dispatched this one, when it was dispatched
   * from inside another task's execution. Null for work enqueued at the
   * top level — a request handler, a periodic tick.
   */
  dispatchedBy: string | null;
  /**
   * RequestTiming reference captured at enqueue time. The Scheduler
   * calls `recordWriterCall(timing, queueMs, execMs)` on completion so
   * the active HTTP request's `wq`+`wx` counters accumulate this op's
   * cost — same surface as today's `WriterWorkerProxy`. Null for
   * enqueues issued from background workers (no request context).
   */
  timing: RequestTiming | null;
  /**
   * Per-execution AbortController. Lives on the in-flight entry so
   * `dispose()` can abort it; the signal is exposed on `TaskContext`
   * inside `makeContext()`. A fresh controller is allocated on each
   * `execOne` call (continuations get a new one).
   */
  abortController: AbortController | null;
}

export interface RunnerState {
  runner: TaskRunner;
  /** Per-priority FIFO queues. */
  queues: Record<Priority, PendingTask[]>;
  /** Running tasks. Size capped at runner.concurrency. */
  inflight: Map<number, PendingTask>;
  /** Per-priority cap, defaults to DEFAULT_QUEUE_CAP. */
  cap: Record<Priority, number>;
  /** Last starvation override timestamp. */
  lastStarvationDispatchMs: number;
  /** Optional preempt buffer for cooperative-yield-capable runners. */
  preempt: PreemptBuffer | null;
  /**
   * Slots kept free of non-user work (background + realtime) so user-priority
   * tasks never wait behind in-flight non-user work — the pool runs at most
   * `concurrency − reservedUserSlots` non-user tasks concurrently. Resolved
   * and clamped to `[0, concurrency − 1]` at registration (see
   * {@link DEFAULT_RESERVED_USER_SLOTS}); 0 for pools that don't reserve, which
   * leaves their dispatch path unchanged.
   */
  reservedUserSlots: number;
}

export interface PeriodicState {
  task: PeriodicTask<unknown, unknown>;
  currentArgs: unknown;
  /** Armed re-arm timer. Null while a tick is in flight or before start(). */
  timer: ReturnType<typeof setTimeout> | null;
  /** True while a tick's enqueue() is outstanding. */
  inFlight: boolean;
  /** Kick received mid-tick; the next re-arm fires immediately. */
  kickPending: boolean;
  /** Monotonic completed-tick generation, including rejected ticks. */
  completedTicks: number;
  /** Callers awaiting a particular kicked generation. */
  waiters: Array<{
    targetGeneration: number;
    resolve: (result: unknown) => void;
    reject: (error: unknown) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
  stopped: boolean;
}

export interface WakeableState {
  task: WakeableTask<unknown, unknown>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  /** Trailing wake during in-flight; fire one more after completion. */
  pendingTrailing: boolean;
  stopped: boolean;
}

export function priorityRank(p: Priority): number {
  switch (p) {
    case "user":
      return 0;
    case "realtime":
      return 1;
    case "background":
      return 2;
  }
}

export function outcomeKind(o: TaskOutcome<unknown, unknown>): TaskExecOutcome {
  return o.kind === "done" ? "done" : "yield";
}

export function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/**
 * `Logger` is re-exported here so sub-classes can carry a typed
 * reference without each module re-importing it from `@omnesis/core`.
 */
export type { Logger };
