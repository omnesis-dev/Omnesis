// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * BackgroundJobsRegistry — central observability surface for every
 * long-running loop in the gateway.
 *
 * Pattern:
 *   - At boot, every background loop registers itself by calling
 *     `registry.register(job)`. The registry holds the BackgroundJob
 *     instance forever (jobs are long-lived).
 *   - The registry refreshes a cached snapshot on a 2s tick (matching
 *     the existing STATUS_REFRESH_INTERVAL_MS pattern in server.ts so
 *     N portal viewers don't multiply load).
 *   - HTTP handlers serve the cached snapshot directly — no DB hit.
 *
 * Performance notes (carry-over from the design discussion):
 *   - The refresh tick calls `job.observe()` on every job. Each
 *     `observe()` is a pure read of in-memory state — never a DB query.
 *     If a future job needs DB-backed progress, the recommended pattern
 *     is a separate periodic reconciler that pushes ground truth into
 *     the tracker via `tracker.setRemaining(...)`.
 *   - No persistence. Lost on restart, by design.
 */

import type { Logger } from "@omnesis/core";
import type { BackgroundJob, BackgroundJobsSnapshot, JobObservation } from "./types.js";

export interface BackgroundJobsRegistryOptions {
  log: Logger;
  /**
   * Refresh cadence for the cached snapshot (ms). Default 2s, matching
   * the existing STATUS_REFRESH_INTERVAL_MS used by other portal-facing
   * caches in server.ts.
   */
  refreshIntervalMs?: number;
}

/**
 * Empty default observation — used when a job throws inside `observe()`
 * so the snapshot stays well-formed instead of dropping the row.
 */
function fallbackObservation(): JobObservation {
  return {
    state: "unknown",
    inFlight: false,
    ticksLastHour: 0,
    avgTickMs: 0,
    p99TickMs: 0,
    progress: { kind: "stateless" },
  };
}

export class BackgroundJobsRegistry {
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly log: Logger;
  private readonly refreshIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cachedSnapshot: BackgroundJobsSnapshot = {
    generatedAt: new Date(0).toISOString(),
    jobs: [],
  };
  private inflightRefresh = false;

  constructor(opts: BackgroundJobsRegistryOptions) {
    this.log = opts.log;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? 2_000;
  }

  /**
   * Register a job. Idempotent on `id` — re-registering with the same
   * id replaces the previous entry. Returns the registered job.
   */
  register(job: BackgroundJob): BackgroundJob {
    if (this.jobs.has(job.id)) {
      this.log.warn(
        `BackgroundJobsRegistry: job "${job.id}" replaced — previous registration dropped`,
      );
    }
    this.jobs.set(job.id, job);
    return job;
  }

  /** Convenience for registering many at once. */
  registerAll(jobs: BackgroundJob[]): void {
    for (const j of jobs) this.register(j);
  }

  /** Lookup by id. Returns undefined for unknown ids. */
  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  /** All registered jobs. Stable ordering (insertion order). */
  list(): BackgroundJob[] {
    return Array.from(this.jobs.values());
  }

  /**
   * Start the periodic refresh timer. Idempotent — calling twice is a
   * no-op. Refresh fires immediately so `snapshot()` is non-empty
   * before the first interval elapses.
   */
  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.refreshIntervalMs);
    this.timer.unref?.();
  }

  /**
   * Synchronous refresh. Iterates all jobs and rebuilds the cached
   * snapshot. Errors from individual `observe()` calls are caught and
   * the offending job gets a fallback observation — one bad job must
   * not poison the whole snapshot.
   *
   * Marked `inflightRefresh` so a slow refresh can't pile up if the
   * timer fires before the previous run finishes (defensive — observes
   * are synchronous today, but better safe than sorry).
   */
  refresh(): void {
    if (this.inflightRefresh) return;
    this.inflightRefresh = true;
    try {
      const rows: BackgroundJobsSnapshot["jobs"] = [];
      for (const job of this.jobs.values()) {
        let obs: JobObservation;
        try {
          obs = job.observe();
        } catch (err) {
          this.log.warn(
            `BackgroundJobsRegistry: observe() failed for "${job.id}": ${err instanceof Error ? err.message : String(err)}`,
          );
          obs = fallbackObservation();
        }
        rows.push({
          id: job.id,
          displayName: job.displayName,
          description: job.description,
          category: job.category,
          cadence: job.cadence,
          observation: obs,
        });
      }
      this.cachedSnapshot = {
        generatedAt: new Date().toISOString(),
        jobs: rows,
      };
    } finally {
      this.inflightRefresh = false;
    }
  }

  /**
   * Return the cached snapshot. Cheap; suitable for HTTP handlers.
   * Snapshot is at most `refreshIntervalMs` stale.
   */
  snapshot(): BackgroundJobsSnapshot {
    return this.cachedSnapshot;
  }

  /** Stop the refresh timer. Safe to call multiple times. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
