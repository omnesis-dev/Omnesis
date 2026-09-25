// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Helpers shared by every backfill PeriodicTask in `backfill.ts`.
 *
 * Three abstractions:
 *
 * - **`runBackfillTick(label, log, body)`** — wraps a task body with
 *   try/catch + backpressure-skip + log-on-error. Backpressure (writer
 *   queue full) becomes "no work this tick, retry next"; everything
 *   else logs at error level and goes idle to avoid spin-failing.
 *
 * - **`occRefreshTask(config)`** — factory for OCC-driven refresh tasks
 *   that follow the meta-poll → compute → apply pattern. The factory
 *   owns the meta comparison, the tracker bookkeeping, and the optional
 *   pre-step that runs each tick regardless of OCC state.
 *
 * - **`sweepAccumulateTask(config)`** — factory for multi-tick
 *   cursor-paginated sweeps. Each tick fetches one bounded chunk,
 *   merges it into an in-memory accumulator, and yields. When the
 *   cursor wraps, the accumulated result is applied atomically.
 */

import { isBackpressure } from "../backpressure.js";
import type { Logger } from "@omnesis/core";
import type { ScanTracker } from "../../background-jobs/trackers.js";
import type { PeriodicTask, TaskOutcome } from "../types.js";

export interface IdleResult {
  /** True if the tick had no work; Scheduler waits idlePeriodMs next. */
  idle: boolean;
}

export const isIdleResult = (r: IdleResult): boolean => r.idle;

export async function runBackfillTick<T extends IdleResult>(
  label: string,
  log: Logger,
  body: () => Promise<T>,
): Promise<TaskOutcome<unknown, T | IdleResult>> {
  try {
    const value = await body();
    return { kind: "done", value };
  } catch (err) {
    if (isBackpressure(err)) {
      log.debug(`${label} backpressured — skipping tick`);
      return { kind: "done", value: { idle: true } };
    }
    log.error(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    return { kind: "done", value: { idle: true } };
  }
}

/** Shape every meta-poll returns: a dirty version + a last-applied watermark. */
export interface OccMeta {
  dirtyVersion: number;
  /** Either `lastComputedVersion` or `lastEvaluatedVersion` — whichever
   *  the underlying meta row uses. The factory only needs the comparison. */
  lastAppliedVersion: number;
}

export interface OccRefreshTaskConfig<S> {
  name: string;
  log: Logger;
  periodMs: number;
  idlePeriodMs: number;
  startDelayMs: number;
  tracker: ScanTracker;
  /** Optional work that runs before the OCC poll every tick. Returns
   *  `true` if it did work — keeps the tick active even when OCC says idle. */
  preStep?: () => Promise<boolean>;
  readMeta: () => Promise<OccMeta>;
  computeSnapshot: () => Promise<S>;
  applySnapshot: (snapshot: S) => Promise<{ affected: number; checked?: number }>;
  /** Callback to emit the human-friendly summary log when work landed. */
  logSummary: (
    snapshot: S,
    applied: { affected: number; checked?: number },
    timing: { computedMs: number; tookMs: number },
    preStep: { active: boolean; ranWork: boolean },
  ) => void;
}

// ── Sweep-accumulate factory ──────────────────────────────────────────
//
// Multi-tick cursor-paginated sweep. Each tick fetches one bounded
// chunk, merges it into an in-memory accumulator, and yields back to
// the scheduler. When the cursor wraps (nextCursor === null), the
// accumulated result is applied atomically via the writer.
//
// Complements `occRefreshTask` (single-shot compute) for operations
// whose unbounded query would block an IO worker for seconds.

export interface SweepAccumulateTaskConfig<TChunk, TAcc> {
  name: string;
  log: Logger;
  /** Cadence between chunks during an active sweep. */
  periodMs: number;
  /** Cadence between completed sweeps (idle backoff). */
  idlePeriodMs: number;
  startDelayMs: number;
  tracker: ScanTracker;
  /** Gate: checked before starting a NEW sweep. Not called mid-sweep. */
  shouldStartSweep: () => Promise<boolean>;
  /** Called once when a new sweep starts. Returns the initial accumulator. */
  initSweep: () => Promise<TAcc>;
  /** Fetch one bounded chunk. cursor=null on first call of a sweep. */
  fetchChunk: (cursor: string | null) => Promise<{ rows: TChunk[]; nextCursor: string | null }>;
  /** Merge one chunk into the accumulator (mutates acc). */
  mergeChunk: (acc: TAcc, rows: TChunk[]) => void;
  /** Apply the finalized accumulator via the writer. */
  applyResult: (acc: TAcc) => Promise<{ affected: number; checked?: number }>;
  logSummary: (
    acc: TAcc,
    applied: { affected: number; checked?: number },
    timing: { sweepMs: number },
  ) => void;
}

export function sweepAccumulateTask<TChunk, TAcc>(
  cfg: SweepAccumulateTaskConfig<TChunk, TAcc>,
): PeriodicTask<unknown, IdleResult> {
  let cursor: string | null = null;
  let acc: TAcc | null = null;
  let sweepStartMs = 0;
  let sweepInProgress = false;

  return {
    name: cfg.name,
    runner: "main",
    priority: "background",
    periodMs: cfg.periodMs,
    idlePeriodMs: cfg.idlePeriodMs,
    startDelayMs: cfg.startDelayMs,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      return runBackfillTick(cfg.name, cfg.log, async () => {
        if (!sweepInProgress) {
          const should = await cfg.shouldStartSweep();
          if (!should) {
            cfg.tracker.recordSweepCompleted();
            return { idle: true, successful: true as const };
          }
          acc = await cfg.initSweep();
          cursor = null;
          sweepStartMs = Date.now();
          sweepInProgress = true;
          cfg.tracker.recordSweepStarted();
        }

        const chunk = await cfg.fetchChunk(cursor);
        cfg.mergeChunk(acc!, chunk.rows);
        cursor = chunk.nextCursor;

        if (cursor !== null) {
          return { idle: false, successful: true as const };
        }

        // Sweep complete — apply accumulated result. Reset sweep
        // state BEFORE applying so a thrown error (backpressure or
        // otherwise) doesn't leave a stale accumulator that the next
        // tick would merge fresh data into.
        const finishedAcc = acc!;
        acc = null;
        sweepInProgress = false;

        const applied = await cfg.applyResult(finishedAcc);
        const sweepMs = Date.now() - sweepStartMs;
        cfg.tracker.recordSweepCompleted({
          checked: applied.checked,
          affected: applied.affected,
        });
        cfg.logSummary(finishedAcc, applied, { sweepMs });

        return { idle: true, successful: true as const };
      });
    },
  };
}

// ── OCC refresh factory ──────────────────────────────────────────────

export function occRefreshTask<S>(cfg: OccRefreshTaskConfig<S>): PeriodicTask<unknown, IdleResult> {
  return {
    name: cfg.name,
    runner: "main",
    priority: "background",
    periodMs: cfg.periodMs,
    idlePeriodMs: cfg.idlePeriodMs,
    startDelayMs: cfg.startDelayMs,
    initialArgs: undefined,
    isIdle: isIdleResult,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      return runBackfillTick(cfg.name, cfg.log, async () => {
        const preStepRan = cfg.preStep ? await cfg.preStep() : false;

        const meta = await cfg.readMeta();
        if (meta.dirtyVersion <= meta.lastAppliedVersion) {
          // Caught up — coverage stays at 1, sweep timestamp ticks so
          // observers see the loop is alive. Idle iff the optional
          // pre-step also had nothing to do.
          cfg.tracker.recordSweepCompleted();
          return { idle: !preStepRan };
        }

        cfg.tracker.recordSweepStarted();
        const startMs = Date.now();
        const snapshot = await cfg.computeSnapshot();
        const computedMs = Date.now() - startMs;
        const applied = await cfg.applySnapshot(snapshot);
        const tookMs = Date.now() - startMs;
        cfg.tracker.recordSweepCompleted({
          checked: applied.checked,
          affected: applied.affected,
        });
        cfg.logSummary(
          snapshot,
          applied,
          { computedMs, tookMs },
          { active: cfg.preStep !== undefined, ranWork: preStepRan },
        );
        return { idle: false };
      });
    },
  };
}
