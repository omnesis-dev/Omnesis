// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Types for the BackgroundJob abstraction.
 *
 * A "background job" is any long-running, periodic, or wake-driven loop
 * inside the gateway whose progress is worth surfacing to operators.
 * That covers Scheduler PeriodicTasks (link/people backfill, stats
 * refreshes, merge pass, token usage flush, …), WakeableTasks (indexer
 * wake), and worker-hosted loops that don't go through the Scheduler at
 * all (the indexer worker's cycle / reconcile / reindex-missing passes).
 *
 * All four shapes implement the same `BackgroundJob` interface so the
 * registry, the HTTP endpoint, and the portal renderer can be uniform.
 *
 * Design notes:
 *   - `progress` is a discriminated union, not a 0..1 percentage. Each
 *     job declares the *shape* of its progress (`queue` for drips,
 *     `watermark` for cursor-driven loops, `scan` for sweeps,
 *     `stateless` for caches with no progress concept). Forces honesty.
 *   - `observe()` must be a pure read of in-memory state. Issuing a DB
 *     query inside `observe()` would worsen writer-worker queue
 *     contention and turn portal pollers into bursty readers. Counters
 *     are maintained as a side effect of the work itself; periodic
 *     ground-truth reconciliation lives elsewhere.
 *   - No persistence. All observation state is in-memory; lost on
 *     restart. Adding writer-side work to track observability would be
 *     self-defeating.
 */

/**
 * Coarse grouping for the portal UI. Lets operators filter / collapse
 * jobs they don't care about. Stable identifiers — additions go at the
 * end of the union.
 */
export type JobCategory =
  | "indexer"
  | "graph"
  | "people"
  | "stats"
  | "auth"
  | "search"
  | "infra"
  | "watches"
  | "briefs";

/**
 * High-level lifecycle state, derived per-observation. UI renders this
 * as a coloured pill.
 *
 *   - "running"   — currently in flight or recently active
 *   - "idle"      — registered but no work to do right now
 *   - "disabled"  — explicitly turned off (config / env)
 *   - "erroring"  — last tick(s) ended in error
 *   - "unknown"   — no observation yet (e.g. job registered but never ticked)
 */
export type JobState = "running" | "idle" | "disabled" | "erroring" | "unknown";

/**
 * How a job is scheduled. Maps onto the Scheduler's PeriodicTask /
 * WakeableTask shapes plus worker-hosted loops.
 *
 *   - "periodic"     — fires on a fixed interval. `intervalMs` carries
 *                      the active period.
 *   - "drip"         — periodic with idle backoff. `activeMs` while
 *                      there's work, `idleMs` once caught up.
 *   - "wake-driven"  — fires only on `wake()` signal, debounced.
 *   - "continuous"   — long-lived loop inside a worker (e.g. indexer
 *                      cycle). The "interval" is whatever the worker
 *                      decides between cycles.
 *   - "on-demand"    — only runs when explicitly triggered (e.g.
 *                      reindex-missing via /admin endpoint).
 */
export type JobCadence =
  | { mode: "periodic"; intervalMs: number; startDelayMs?: number }
  | { mode: "drip"; activeMs: number; idleMs: number; startDelayMs?: number }
  | { mode: "wake-driven"; debounceMs: number }
  | { mode: "continuous"; nominalIntervalMs?: number }
  | { mode: "on-demand" };

/**
 * Progress of a background job. Discriminated by `kind` because
 * different loops have fundamentally different progress semantics —
 * pretending they're all "% done" forces fake numbers. Each variant
 * carries the fields naturally relevant to its kind.
 */
export type JobProgress =
  /**
   * A drip loop with a backlog. `remaining` is the in-memory count of
   * items still to process; reconciled against ground truth on a slow
   * cadence (typically ~5 min). May *under*-estimate between
   * reconciliations if new work arrives faster than the next refresh.
   *
   * `processedSinceBoot` is monotonic; useful for "throughput since
   * gateway started" displays.
   *
   * `rateLastMin` is items/sec averaged over the last 60s of ticks.
   */
  | {
      kind: "queue";
      remaining: number;
      processedSinceBoot: number;
      rateLastMin: number;
      /** Ground-truth `remaining` only; in-memory drift between the two. */
      groundTruthAt?: number;
      /**
       * Age of the OLDEST item still in the backlog, in ms — how long the work
       * at the head of the queue has been waiting. `remaining` says how much is
       * outstanding; this says how late it is, which is the quantity a latency
       * SLA is actually written against. Set only by jobs whose backlog carries
       * a timestamp, and only from a ground-truth pass (trackers issue no
       * queries of their own).
       */
      oldestPendingMs?: number;
      /**
       * The latency this backlog is held to, in ms — the operator-configured
       * threshold `oldestPendingMs` is judged against. Carried rather than
       * assumed by the reader, so a display cannot drift from the setting the
       * server actually enforces. Set only alongside `oldestPendingMs`.
       */
      pendingSlaMs?: number;
    }
  /**
   * A loop with a watermark / cursor advancing through documents in
   * order. `cursor` is the last-processed identifier (typically a
   * stringified `lastUpdatedAt` ISO timestamp). `lagDocs` / `lagSec`
   * are how far behind ground truth we are.
   */
  | {
      kind: "watermark";
      cursor: string;
      lagDocs?: number;
      lagSec?: number;
    }
  /**
   * A sweep / scan that walks an entire dataset (e.g. reconcile-deleted
   * scanning index for orphan rows). `coverage` is 0..1 — fraction of
   * the dataset checked since the last full sweep. `lastSweepCompletedAt`
   * is wall-clock of the most recent end-to-end pass.
   */
  | {
      kind: "scan";
      coverage: number;
      lastSweepCompletedAt?: number;
      itemsCheckedLastSweep?: number;
      itemsAffectedLastSweep?: number;
    }
  /**
   * No meaningful progress concept (caches, refreshes, plumbing). The
   * UI renders just state + last-tick info.
   */
  | { kind: "stateless" };

/**
 * One observation of a background job's current state. The registry
 * caches the most recent observation per job and serves it via HTTP.
 */
export interface JobObservation {
  state: JobState;
  inFlight: boolean;
  /** Wall-clock ms of the most recent tick, if any. */
  lastTickAt?: number;
  /** Wall-clock duration of the most recent tick. */
  lastTickElapsedMs?: number;
  /** Most recent error, if any tick has errored within the observation window. */
  lastError?: { message: string; at: number };
  /** Number of ticks completed in the last hour (rolling). */
  ticksLastHour: number;
  /** Mean tick execution time over the observation window (ms). */
  avgTickMs: number;
  /** P99 tick execution time (ms). */
  p99TickMs: number;
  /** Discriminated progress shape — see JobProgress. */
  progress: JobProgress;
}

/**
 * Public face of a background job. Stable across observations; the
 * mutable state lives behind `observe()`.
 */
export interface BackgroundJob {
  /** Stable id. Matches `Task.name` for Scheduler-backed jobs. */
  readonly id: string;
  /** Short human-friendly label for the UI. */
  readonly displayName: string;
  /** One-sentence description — for the UI tooltip. */
  readonly description: string;
  readonly category: JobCategory;
  readonly cadence: JobCadence;
  /** Pure in-memory read; must NOT touch the DB. */
  observe(): JobObservation;
}

/**
 * Common interface for the four progress trackers in `trackers.ts`.
 * Tasks hold a tracker instance and update it as work happens; the
 * registry calls `observe()` to get the current shape.
 */
export interface ProgressTracker {
  /**
   * Read-only snapshot of the tracker's state. Cheap; does not mutate.
   * Multiple readers may call concurrently from the registry refresh.
   */
  observe(): JobProgress;
}

/**
 * Snapshot returned by GET /admin/background-jobs. Matches the on-the-
 * wire JSON shape exactly so the portal can consume it directly.
 */
export interface BackgroundJobsSnapshot {
  generatedAt: string;
  jobs: Array<{
    id: string;
    displayName: string;
    description: string;
    category: JobCategory;
    cadence: JobCadence;
    observation: JobObservation;
  }>;
}
