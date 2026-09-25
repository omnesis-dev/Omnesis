// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Background drain of the Briefs waker buffer — the flush half of the
 * near-dup inbox pattern. Runs outside any request ALS scope, so the
 * `data`-run enqueues execute at their declared `background` priority
 * and yield to realtime/user writes.
 *
 * Per drained wake, one write-gate enqueue with the per-document fold
 * key (`data:doc:<id>`), scheduled `debounceMs` out and carrying the
 * per-doc-type `maxDeferMs` ceiling. Because the enqueue's fold check
 * replaces the pending row's schedule, a busy document (or conversation)
 * keeps pushing its run out — a true trailing debounce: the run fires
 * once the doc has been quiet for the configured window, OR once the
 * max-defer ceiling (`cycle_anchor_at + maxDeferMs`) is reached, so a
 * forever-active doc still becomes claimable within a bounded time
 * instead of being deferred forever (debounce starvation).
 *
 * Diff handling (criterion 3):
 *   - Fresh update, no pending row: diff = buffered pre-update body vs
 *     latest body; the pre-update body is stored on the row as the fold
 *     `snapshot`.
 *   - Pending `updated` row exists: the diff is recomputed from the
 *     row's snapshot (first-enqueue content) vs the latest body, so one
 *     run's diff spans every edit since the first enqueue.
 *   - Pending `created` row: the doc is still new to the agent — the
 *     folded run stays `created`, no diff.
 *   The pending-row read happens on the main thread and the fold lands
 *   via the writer; if the drainer claims the row in between, the
 *   enqueue simply inserts a fresh row (the spec folds only *unclaimed*
 *   rows — see also the finalize-side fold guard in
 *   `storage/run-queue.ts`).
 *
 * A failed enqueue re-buffers its wake for the next tick. When the
 * feature gate goes inactive (live deactivation), the tick discards the
 * buffer instead of enqueueing, so a disabled gateway accumulates
 * nothing.
 */

import { randomUUID } from "node:crypto";
import { QueueTracker } from "../../background-jobs/trackers.js";
import { periodicJob } from "../../background-jobs/scheduler-job.js";
import { getPendingRunByDedupeKey, listBarrierHeldDataRuns } from "../storage/run-queue.js";
import {
  DERIVATION_STAGES,
  derivationReadyDocIds,
  documentDerivationState,
  type DerivationStage,
} from "../../domain/DocumentDerivation.js";
import { systemClock, type Clock } from "../storage/types.js";
import {
  dataRunDedupeKey,
  dataRunThreadDedupeKey,
  parseCognitionDataRunPayload,
  type CognitionDataRunPayload,
} from "../run-payloads.js";
import { mergeChangedAddressedEntryIds } from "../addressed-entry-context.js";
import { computeContentDiff, type ContentDiffLimits } from "./diff.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { BackgroundJob } from "../../background-jobs/types.js";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { PeriodicTask, TaskOutcome } from "../../scheduler/types.js";
import type { WriteGate } from "../../write-gate.js";
import type { BriefsWakerBuffer, BufferedWake } from "./event-handler.js";

type Db = Database.Database;

interface IdleResult {
  idle: boolean;
}

/** Active drain cadence (buffer non-empty). */
const DEFAULT_INTERVAL_MS = 1_000;
/** Idle cadence. */
const DEFAULT_IDLE_MS = 15_000;
const DEFAULT_START_DELAY_MS = 2_000;

/** Cadence env override (test harnesses drive the drain faster than prod). */
function envInt(name: string): number | undefined {
  const raw = process.env[name];
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/**
 * How many deferred `data` runs one readiness pass reconsiders. The set is
 * ordered soonest-due first, so a backlog larger than this is not skipped —
 * only spread across ticks, oldest wait first.
 */
const READINESS_PASS_LIMIT = 200;

export interface BriefsWakerDrainOpts {
  db: Db;
  writeGate: Pick<WriteGate, "enqueueCognitionRun" | "pullForwardCognitionRuns">;
  buffer: BriefsWakerBuffer;
  log: Logger;
  /** Live feature-gate verdict, re-read per tick. */
  isEnabled: () => boolean;
  /**
   * Readiness-barrier ceiling (ms), re-read per tick so a config change takes
   * on the next enqueue. Omitted or 0 disables the barrier entirely: runs are
   * then scheduled on their debounce alone.
   */
  derivationBarrierMs?: () => number;
  /**
   * The derivation stages currently running, re-read per use. Defaults to every
   * registered stage. A stage whose producer is switched off never stamps its
   * column, so including it would hold every run for the full barrier.
   */
  activeDerivationStages?: () => readonly DerivationStage[];
  clock?: Clock;
  intervalMs?: number;
  idleMs?: number;
  startDelayMs?: number;
  diffLimits?: ContentDiffLimits;
}

export interface BriefsWakerDrainBundle {
  task: PeriodicTask<unknown, IdleResult>;
  job: BackgroundJob;
  /** Drain + enqueue everything now (tests / graceful shutdown). */
  flushNow(): Promise<void>;
}

/** Build the `data`-run payload for one buffered wake. */
export function buildDataRunPayload(
  wake: BufferedWake,
  pendingPayload: unknown | null,
  now: number,
  diffLimits?: ContentDiffLimits,
): CognitionDataRunPayload {
  const prev = pendingPayload === null ? null : parseCognitionDataRunPayload(pendingPayload);
  const changed = mergeChangedAddressedEntryIds(
    prev?.changedAddressedEntryIds,
    wake.changedAddressedEntryIds,
  );
  const base: CognitionDataRunPayload = {
    docId: wake.docId,
    event: wake.event,
    datumAt: wake.datumAt,
    // Sticky across folds, exactly as the wake buffer keeps it: a cycle that
    // ever carried addressed content keeps the no-delay guarantee for the
    // whole cycle, including the one an in-flight fold resurrects.
    ...(wake.immediate === true || prev?.immediate === true ? { immediate: true } : {}),
    ...(changed.ids.length > 0 ? { changedAddressedEntryIds: changed.ids } : {}),
    ...(prev?.addressedEntriesTruncated === true ||
    wake.addressedEntriesTruncated === true ||
    changed.truncated
      ? { addressedEntriesTruncated: true }
      : {}),
  };
  if (prev?.event === "created") {
    // Folding onto a not-yet-processed fresh doc — still fresh.
    return { ...base, event: "created" };
  }
  if (wake.event === "created") return base;

  // Update path: prefer the pending row's snapshot (first-enqueue
  // content) as the diff base so the diff spans every edit; fall back
  // to the buffered pre-update body for a first enqueue.
  const diffBase = prev?.snapshot?.content ?? wake.beforeContent;
  if (diffBase === undefined || wake.afterContent === undefined) return base;
  const diff = computeContentDiff(diffBase, wake.afterContent, diffLimits);
  if (diff === null) return base;
  return {
    ...base,
    diff,
    snapshot: prev?.snapshot ?? { content: diffBase, capturedAt: now },
  };
}

export function briefsWakerDrainTask(
  opts: BriefsWakerDrainOpts,
  scheduler: Scheduler,
): BriefsWakerDrainBundle {
  const { buffer, writeGate, db, log } = opts;
  const clock = opts.clock ?? systemClock;
  // Which derivation stages the barrier may wait on, re-read per use: a stage
  // that is switched off never stamps, so waiting on it would turn the barrier
  // into a flat ceiling-length delay on every document.
  const stages = (): readonly DerivationStage[] =>
    opts.activeDerivationStages?.() ?? DERIVATION_STAGES;
  const tracker = new QueueTracker({ initialRemaining: buffer.size() });

  async function flush(): Promise<{ hadWork: boolean; enqueued: number }> {
    const wakes = buffer.drain();
    if (wakes.length === 0) {
      tracker.setRemaining(buffer.size());
      return { hadWork: false, enqueued: 0 };
    }
    if (!opts.isEnabled()) {
      // Live deactivation: discard rather than accumulate or enqueue.
      tracker.setRemaining(buffer.size());
      return { hadWork: false, enqueued: 0 };
    }
    let enqueued = 0;
    for (const wake of wakes) {
      const now = clock();
      // Thread-membership documents (emails in a thread) fold on a source-scoped
      // thread key so a burst of same-thread arrivals batches into one run;
      // standalone documents fold per-document.
      const dedupeKey =
        wake.threadKey !== undefined
          ? dataRunThreadDedupeKey(wake.threadKey)
          : dataRunDedupeKey(wake.docId);
      // The readiness barrier. A run answers to two independent waits: the
      // trailing debounce (has the document stopped changing?) and derivation
      // (does the graph know where this document sits yet?). It becomes due at
      // whichever is later — but only until derivation completes, at which
      // point `releaseReadyRuns` pulls it back to the debounce deadline. The
      // barrier is thus a CEILING on the wait, not the wait itself.
      //
      // `wake.immediate` opts out entirely: content the user handed to the
      // assistant deliberately has already bypassed every volume gate and
      // carries no debounce, so making it wait on background derivation would
      // contradict the one property that marker exists to guarantee.
      const debounceUntil = now + wake.debounceMs;
      const barrierMs = wake.immediate ? 0 : (opts.derivationBarrierMs?.() ?? 0);
      const barrierUntil = now + barrierMs;
      const derivation = barrierMs > 0 ? documentDerivationState(db, wake.docId, stages()) : null;
      // Only a barrier deadline that actually pushes the run out is a hold; if
      // the debounce already runs longer, there is nothing for the release pass
      // to give back and the row must not advertise a claim on its schedule.
      const heldForDerivation =
        derivation !== null &&
        derivation.exists &&
        !derivation.complete &&
        barrierUntil > debounceUntil;
      const notBefore = heldForDerivation ? barrierUntil : debounceUntil;
      try {
        const pending = getPendingRunByDedupeKey(db, dedupeKey);
        const payload = buildDataRunPayload(wake, pending?.payload ?? null, now, opts.diffLimits);
        await writeGate.enqueueCognitionRun(
          {
            id: randomUUID(),
            kind: "data",
            payload: {
              ...payload,
              debounceUntil,
              ...(heldForDerivation ? { barrierUntil } : {}),
            },
            notBefore,
            dedupeKey,
            // Only `data` folds carry the ceiling — a forever-active doc's run
            // stays claimable within `cycle_anchor_at + maxDeferMs`. Inert on
            // the fresh INSERT this may be (inserts fire on their debounce).
            maxDeferMs: wake.maxDeferMs,
          },
          now,
        );
        enqueued++;
      } catch (err) {
        buffer.restore(wake);
        log.debug(
          `briefs waker re-buffered wake for ${wake.docId} after writer error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    tracker.setRemaining(buffer.size());
    return { hadWork: true, enqueued };
  }

  /**
   * Release `data` runs whose datum has finished deriving or disappeared since
   * they were enqueued — the other half of the barrier. A deleted document can
   * never finish deriving, and its run prompt already handles that terminal
   * state explicitly.
   *
   * Candidacy is decided in SQL by the run still sitting exactly at the
   * barrier deadline recorded in its payload, so a run rescheduled by anything
   * else (retry backoff, a fold's fresh quiet window, the max-defer clamp) is
   * not this pass's to move. Released runs go to `max(now, debounceUntil)`:
   * due immediately if the debounce elapsed during the wait, otherwise at the
   * moment it does. A still-underived datum stays put until it either derives
   * or ages past the barrier into being due on its own.
   *
   * Readiness is judged on the payload's `docId`. For a thread-keyed run that
   * is the most recently folded message rather than the whole batch, so a
   * thread can be released while an earlier message in it is still deriving —
   * accepted, because the alternative is holding a conversation on the
   * slowest document it ever contained.
   */
  async function releaseReadyRuns(now: number): Promise<number> {
    if ((opts.derivationBarrierMs?.() ?? 0) <= 0) return 0;
    // A disabled engine has no runs to be timely for; leave the queue alone.
    if (!opts.isEnabled()) return 0;
    const held = listBarrierHeldDataRuns(db, now, READINESS_PASS_LIMIT);
    if (held.length === 0) return 0;

    const ready = derivationReadyDocIds(
      db,
      held.map((r) => r.docId),
      stages(),
    );
    const entries = held
      .filter((r) => ready.has(r.docId))
      .map((r) => ({
        id: r.id,
        docId: r.docId,
        observedDebounceUntil: r.debounceUntil,
        nextAttemptAt: Math.max(now, r.debounceUntil),
        expectedNextAttemptAt: r.barrierUntil,
      }));
    if (entries.length === 0) return 0;

    const released = await writeGate.pullForwardCognitionRuns(
      entries,
      stages().map((stage) => stage.id),
    );
    if (released > 0) {
      log.debug(`readiness barrier released ${released} data run(s) after datum became ready`);
    }
    return released;
  }

  const task: PeriodicTask<unknown, IdleResult> = {
    name: "briefs.wakerDrain",
    runner: "main",
    priority: "background",
    periodMs:
      opts.intervalMs ?? envInt("OMNESIS_COGNITION_WAKER_INTERVAL_MS") ?? DEFAULT_INTERVAL_MS,
    idlePeriodMs: opts.idleMs ?? envInt("OMNESIS_COGNITION_WAKER_IDLE_MS") ?? DEFAULT_IDLE_MS,
    startDelayMs:
      opts.startDelayMs ??
      envInt("OMNESIS_COGNITION_WAKER_START_DELAY_MS") ??
      DEFAULT_START_DELAY_MS,
    initialArgs: undefined,
    isIdle: (r) => r.idle,
    async run(): Promise<TaskOutcome<unknown, IdleResult>> {
      const { hadWork, enqueued } = await flush();
      if (enqueued > 0) tracker.recordTick(enqueued);
      // Releasing counts as work, so the drip keeps its active cadence while
      // documents are still coming ready — the barrier must not be held open
      // by the loop that clears it dropping to its 15s idle period.
      const released = await releaseReadyRuns(clock());
      return { kind: "done", value: { idle: !hadWork && released === 0 } };
    },
  };

  const job = periodicJob(task, {
    scheduler,
    displayName: "Briefs waker drain",
    description:
      "Drains buffered document wakes into debounced Cognition Steward data runs (per-document fold, event-time diffs).",
    category: "briefs",
    tracker,
  });

  return {
    task,
    job,
    flushNow: async () => {
      await flush();
      await releaseReadyRuns(clock());
    },
  };
}
