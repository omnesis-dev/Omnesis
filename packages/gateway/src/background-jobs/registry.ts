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
 *   - `snapshot()` observes every job when it is asked for and the last
 *     snapshot is older than `maxAgeMs` (2 s by default), so N portal
 *     viewers polling it cost one pass every two seconds, and a gateway
 *     nobody is looking at spends nothing on it.
 *
 * Performance notes:
 *   - A pass calls `job.observe()` on every job, on the main thread. Each
 *     `observe()` is a read of in-memory state — never a DB query, a file
 *     read, or the construction of anything. A job needing DB-backed
 *     progress has a separate periodic reconciler push ground truth into
 *     its tracker via `tracker.setRemaining(...)`.
 *   - No persistence. Lost on restart, by design.
 */

import { withActivity } from "../observability/main-activity.js";
import type { Logger } from "@omnesis/core";
import type { BackgroundJob, BackgroundJobsSnapshot, JobObservation } from "./types.js";

export interface BackgroundJobsRegistryOptions {
  log: Logger;
  /** How stale a served snapshot may be before the next request observes again (ms). Default 2s. */
  maxAgeMs?: number;
  /** Clock for the snapshot's age. Default `Date.now`. */
  now?: () => number;
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
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private cached: { at: number; snapshot: BackgroundJobsSnapshot } | null = null;

  constructor(opts: BackgroundJobsRegistryOptions) {
    this.log = opts.log;
    this.maxAgeMs = opts.maxAgeMs ?? 2_000;
    this.now = opts.now ?? Date.now;
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
    this.cached = null;
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
   * Every job's observation, at most `maxAgeMs` old: the previous snapshot
   * while it is that fresh, otherwise a new pass over the jobs.
   */
  snapshot(): BackgroundJobsSnapshot {
    const now = this.now();
    // A clock stepped back makes the age negative: observe again rather than
    // serve the old snapshot until the clock catches up.
    const age = this.cached ? now - this.cached.at : Number.POSITIVE_INFINITY;
    if (this.cached && age >= 0 && age < this.maxAgeMs) return this.cached.snapshot;
    const snapshot = withActivity("backgroundJobs.refresh", () => this.observeAll());
    this.cached = { at: now, snapshot };
    return snapshot;
  }

  /**
   * One pass over the jobs. Errors from individual `observe()` calls are
   * caught and the offending job gets a fallback observation — one bad job
   * must not poison the whole snapshot.
   */
  private observeAll(): BackgroundJobsSnapshot {
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
    return { generatedAt: new Date(this.now()).toISOString(), jobs: rows };
  }
}
