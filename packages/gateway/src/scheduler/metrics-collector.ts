// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `MetricsCollector` — sliding-window per-task exec samples + SLA
 * samples + slow-op log line + snapshot building. Pulled out of
 * `scheduler.ts` so the dispatch hot path doesn't have
 * to scroll past 200 lines of metrics state.
 *
 * The collector itself is stateless across runners; a single instance
 * is shared by the `SchedulerCore` (which calls `record()` from
 * `execOne`) and by the façade (which calls `snapshot()` /
 * `getLastTickInfo()` from the public surface).
 */

import { createLogger } from "@omnesis/core";
import { DEFAULT_LATENCY_BUDGET_MS, PER_TASK_SAMPLES, SLA_RING, pct } from "./internals.js";
import type { Priority, RunnerKind, Task } from "./types.js";
import type {
  PerRunnerStats,
  PerTaskStats,
  SchedulerMetricsSnapshot,
  TaskExecOutcome,
  TaskExecSample,
  UserSlaStats,
} from "./metrics.js";

const log = createLogger("gateway:scheduler");

/**
 * Snapshot input from the scheduler's runner state — the slice
 * `MetricsCollector.snapshot()` needs from each `RunnerState` without
 * importing the runner-state struct itself.
 */
export interface RunnerSnapshotInput {
  runner: RunnerKind;
  queueDepthByPriority: { user: number; realtime: number; background: number };
  inFlight: number;
}

export class MetricsCollector {
  private taskSamples = new Map<string, TaskExecSample[]>();
  private taskHeads = new Map<string, number>();
  private slaSamples: Array<{ ts: number; totalMs: number }> = [];
  private slaHead = 0;
  private slaCount = 0;

  constructor(private readonly userSlaBudgetMs: number) {}

  /**
   * Record one task execution. Updates the per-task ring buffer, the
   * SLA ring (for user-priority only), and emits the slow-op warn
   * when exec exceeded the task's latency budget.
   */
  record(
    taskName: string,
    taskBudgetMs: number | undefined,
    runner: RunnerKind,
    queueMs: number,
    execMs: number,
    priority: Priority,
    outcome: TaskExecOutcome,
    cpuUserUs?: number,
    cpuSystemUs?: number,
    dispatchedBy?: string | null,
  ): void {
    const sample: TaskExecSample = {
      ts: Date.now(),
      queueMs,
      execMs,
      priority,
      outcome,
      runner,
      cpuUserUs,
      cpuSystemUs,
    };
    let buf = this.taskSamples.get(taskName);
    if (!buf) {
      buf = new Array(PER_TASK_SAMPLES);
      this.taskSamples.set(taskName, buf);
      this.taskHeads.set(taskName, 0);
    }
    const head = this.taskHeads.get(taskName)!;
    buf[head] = sample;
    this.taskHeads.set(taskName, (head + 1) % PER_TASK_SAMPLES);

    // SLA: count user-priority (queueMs+execMs) against budget.
    if (priority === "user") {
      const totalMs = queueMs + execMs;
      this.slaSamples[this.slaHead] = { ts: sample.ts, totalMs };
      this.slaHead = (this.slaHead + 1) % SLA_RING;
      if (this.slaCount < SLA_RING) this.slaCount += 1;
    }

    // Slow-op log line. Background tasks are expected to wait behind
    // user/realtime work during busy periods — logging a warning for
    // every overrun is noise. Only warn for user and realtime priority
    // where latency directly affects portal, CLI, or collector ingest.
    const budget = taskBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS;
    if (execMs > budget && priority !== "background") {
      // Say whether this is the slow work or the wait for it. One slow unit
      // emits two lines — the op, and the task waiting on it — and read as
      // separate incidents they double every count. `via=` names the task
      // that dispatched this one; a line without it is the root.
      const provenance = dispatchedBy ? ` via=${dispatchedBy}` : " root";
      log.warn(
        `slow-op ${taskName} exec=${execMs}ms ` +
          `priority=${priority} budget=${budget}ms ` +
          `queue=${queueMs}ms outcome=${outcome}${provenance}`,
      );
    }
  }

  /**
   * Build a metrics snapshot for the given window. Per-task stats are
   * computed in-process; per-runner stats are passed in by the
   * scheduler (it owns the runner state). `findTaskDefinition` is the
   * façade's lookup callback (consults periodics + wakeables) so the
   * collector doesn't have to know about the registries.
   */
  snapshot(
    windowSeconds: number,
    runnerInputs: RunnerSnapshotInput[],
    findTaskDefinition: (name: string) => Task<unknown, unknown> | null,
    preemptRequestCount: number,
  ): SchedulerMetricsSnapshot {
    const cutoff = Date.now() - windowSeconds * 1000;

    // Worst queue wait observed per (runner, priority) inside the window,
    // accumulated from the same samples the per-task rows are built from.
    // Window-scoped like every other number here: a cumulative high-water
    // mark would pin the portal's starvation row red for the life of the
    // process — the first background task released by the anti-starvation
    // floor waits out the full floor, and no calm minute after it could
    // ever show through.
    const queueAgeMaxByRunner = new Map<RunnerKind, Record<Priority, number>>();

    // Per-task stats.
    const perTask: PerTaskStats[] = [];
    for (const [name, buf] of this.taskSamples) {
      const inWindow: TaskExecSample[] = [];
      for (let i = 0; i < buf.length; i++) {
        const s = buf[i];
        if (s && s.ts >= cutoff) inWindow.push(s);
      }
      if (inWindow.length === 0) continue;

      // We need to know the task definition to report runner/budget.
      // Look it up via the façade's callback (it walks periodics +
      // wakeables). For runner/budget, default to "main"/200 if the
      // task isn't in our registries (one-shot enqueue from outside).
      // Acceptable: the snapshot is for ops observability, not correctness.
      const taskDef = findTaskDefinition(name);
      const sample0 = inWindow[0];
      const execs = inWindow.map((s) => s.execMs).sort((a, b) => a - b);
      const total = execs.reduce((a, b) => a + b, 0);
      const budget = taskDef?.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS;
      // Priority is resolved per execution, so a task can run at more than
      // one inside the window; count each rather than sampling one.
      const countByPriority: Record<Priority, number> = { user: 0, realtime: 0, background: 0 };
      for (const s of inWindow) countByPriority[s.priority] += 1;
      const stats: PerTaskStats = {
        name,
        countByPriority,
        runner: sample0.runner ?? taskDef?.runner ?? "main",
        count: inWindow.length,
        p50: pct(execs, 0.5),
        p95: pct(execs, 0.95),
        p99: pct(execs, 0.99),
        max: execs[execs.length - 1] ?? 0,
        slowOpCount: inWindow.filter((s) => s.execMs > budget).length,
        yieldCount: inWindow.filter((s) => s.outcome === "yield").length,
        errorCount: inWindow.filter((s) => s.outcome === "error").length,
        totalExecMs: total,
      };

      const cpuSamples = inWindow.filter((s) => s.cpuUserUs != null);
      if (cpuSamples.length > 0) {
        const totalCpuUs = cpuSamples.reduce((a, s) => a + s.cpuUserUs! + s.cpuSystemUs!, 0);
        const cpuExecMs = cpuSamples.reduce((a, s) => a + s.execMs, 0);
        stats.totalCpuMs = totalCpuUs / 1_000;
        stats.cpuUtilization = cpuExecMs > 0 ? stats.totalCpuMs / cpuExecMs : 0;
      }

      perTask.push(stats);

      let ages = queueAgeMaxByRunner.get(stats.runner);
      if (!ages) {
        ages = { user: 0, realtime: 0, background: 0 };
        queueAgeMaxByRunner.set(stats.runner, ages);
      }
      for (const s of inWindow) {
        if (s.queueMs > ages[s.priority]) ages[s.priority] = s.queueMs;
      }
    }
    perTask.sort((a, b) => b.p99 - a.p99);

    // Per-runner stats: current queue snapshot + utilization from samples.
    const windowMs = windowSeconds * 1_000;
    const perRunner: PerRunnerStats[] = runnerInputs.map((r) => {
      const runnerTasks = perTask.filter((t) => t.runner === r.runner);
      const totalExecMs = runnerTasks.reduce((a, t) => a + t.totalExecMs, 0);
      const totalCpuMs = runnerTasks.reduce((a, t) => a + (t.totalCpuMs ?? 0), 0);
      return {
        runner: r.runner,
        queueDepthByPriority: { ...r.queueDepthByPriority },
        queueAgeMaxByPriority: queueAgeMaxByRunner.get(r.runner) ?? {
          user: 0,
          realtime: 0,
          background: 0,
        },
        inFlight: r.inFlight,
        utilization: windowMs > 0 ? Math.min(1, totalExecMs / windowMs) : 0,
        totalExecMs,
        totalCpuMs: totalCpuMs > 0 ? totalCpuMs : undefined,
      };
    });

    // SLA stats over the window.
    const slaInWindow: number[] = [];
    let violations = 0;
    for (let i = 0; i < this.slaCount; i++) {
      const s = this.slaSamples[i];
      if (s && s.ts >= cutoff) {
        slaInWindow.push(s.totalMs);
        if (s.totalMs > this.userSlaBudgetMs) violations += 1;
      }
    }
    slaInWindow.sort((a, b) => a - b);
    const userSla: UserSlaStats = {
      p50: pct(slaInWindow, 0.5),
      p95: pct(slaInWindow, 0.95),
      p99: pct(slaInWindow, 0.99),
      p999: pct(slaInWindow, 0.999),
      violations,
      count: slaInWindow.length,
      budgetMs: this.userSlaBudgetMs,
    };

    return {
      windowSeconds,
      generatedAt: new Date().toISOString(),
      userSla,
      perRunner,
      perTask,
      // Cumulative count of preempt requests fired since boot. Useful
      // for correlating against per-task yieldCount when tuning the
      // cooperative-yield path.
      preemptRequestCount,
    };
  }

  /**
   * Latest-sample accessor used by the BackgroundJob registry to render
   * "last tick X seconds ago" without requiring a full snapshot pass.
   * Returns undefined if the task has never run within the ring's
   * memory window. Cheap O(PER_TASK_SAMPLES) — capacity 500 — so safe
   * to call on every observe().
   */
  getLastTickInfo(name: string): { ts: number; execMs: number } | undefined {
    const buf = this.taskSamples.get(name);
    if (!buf) return undefined;
    let bestTs = 0;
    let bestExecMs = 0;
    for (let i = 0; i < buf.length; i++) {
      const s = buf[i];
      if (s && s.ts > bestTs) {
        bestTs = s.ts;
        bestExecMs = s.execMs;
      }
    }
    return bestTs > 0 ? { ts: bestTs, execMs: bestExecMs } : undefined;
  }
}
