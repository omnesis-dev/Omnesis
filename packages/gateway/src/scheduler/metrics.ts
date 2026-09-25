// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scheduler-level metrics types.
 *
 * The Scheduler maintains:
 *   - Per-task ring buffer of execution samples.
 *   - Per-(runner, priority) queue depth + age sample at 1Hz.
 *   - User-priority SLA tracker (filtered request latency).
 *
 * `Scheduler.snapshot(windowSec)` returns this shape; the gateway
 * surfaces it at `GET /admin/scheduler-metrics` (separate from
 * the HTTP-route metrics at `/admin/metrics`).
 *
 * No runtime here — the implementation lives alongside the Scheduler
 * class. This file just pins the wire shape so consumers (debug.js,
 * tests) have a stable type to bind against.
 */

import type { Priority, RunnerKind } from "./types.js";

/** Outcome category for one task execution. */
export type TaskExecOutcome = "done" | "yield" | "error";

export interface TaskExecSample {
  ts: number;
  /** ms the task spent waiting in the priority queue before exec started. */
  queueMs: number;
  /** ms the runner spent actually running the task. */
  execMs: number;
  priority: Priority;
  outcome: TaskExecOutcome;
  /** Which runner executed this sample. Recorded at sample time. */
  runner: RunnerKind;
  /** CPU time (µs) in user-space JS. Present for writer/compute ops. */
  cpuUserUs?: number;
  /** CPU time (µs) in kernel syscalls. Present for writer/compute ops. */
  cpuSystemUs?: number;
}

export interface PerTaskStats {
  name: string;
  /**
   * Executions in the window per resolved priority. Priority is a
   * per-execution property — an enqueue override, the calling request's
   * ambient priority, or the task's own default — so one task can run at
   * several within a window; the three values sum to `count`.
   */
  countByPriority: Record<Priority, number>;
  runner: RunnerKind;
  /**
   * Executions in the window. Bounded by the per-task sample ring, so a
   * task that ran more than the ring holds inside the window reports its
   * most recent executions rather than the window's true total.
   */
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Count of executions where execMs > task.latencyBudgetMs. */
  slowOpCount: number;
  /** Count of executions that returned a yield outcome. */
  yieldCount: number;
  /** Count of executions that threw. */
  errorCount: number;
  /** Sum of execMs across all executions in the window. */
  totalExecMs: number;
  /**
   * CPU utilization during exec: cpuMs / execMs (0..1). Near 1.0 means
   * CPU-bound; near 0 means IO-bound (waiting on SQLite, disk, etc.).
   * Only present for writer/compute tasks that report CPU time.
   */
  cpuUtilization?: number;
  /** Total CPU time (ms) consumed in the window. */
  totalCpuMs?: number;
}

export interface PerRunnerStats {
  runner: RunnerKind;
  queueDepthByPriority: Record<Priority, number>;
  /**
   * Longest wait (ms) any task on this runner served in the window, per
   * priority — catches starvation. Window-scoped, so it falls back to
   * calm values once a spike ages out.
   */
  queueAgeMaxByPriority: Record<Priority, number>;
  inFlight: number;
  /** Fraction of the window the runner spent executing (0..1). */
  utilization?: number;
  /** Total wall-clock exec ms consumed by tasks on this runner. */
  totalExecMs?: number;
  /** Total CPU ms consumed by tasks on this runner. */
  totalCpuMs?: number;
}

export interface UserSlaStats {
  p50: number;
  p95: number;
  p99: number;
  p999: number;
  /** Count of user-priority executions exceeding budgetMs. */
  violations: number;
  /** Total user-priority executions in the window. */
  count: number;
  budgetMs: number;
}

export interface SchedulerMetricsSnapshot {
  windowSeconds: number;
  generatedAt: string;
  userSla: UserSlaStats;
  perRunner: PerRunnerStats[];
  perTask: PerTaskStats[];
  /**
   * Cumulative count of `requestYield()` calls fired by the Scheduler
   * since boot. Useful when correlating against per-task `yieldCount`
   * to tune the cooperative-yield path: a high preempt count with a
   * low yield count points at a worker that isn't polling the SAB
   * flag often enough.
   *
   * Cumulative (not windowed) — the value monotonically increases for
   * the lifetime of the process. The portal subtracts the previous
   * snapshot's value when rendering rate.
   */
  preemptRequestCount: number;
}
