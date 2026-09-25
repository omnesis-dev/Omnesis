// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The absence sweep — where a snapshot's omission finally becomes a deletion.
 *
 * A source snapshot records absences; it never deletes (see
 * `data/repositories/AbsenceRepository.ts`). This task is what spends the
 * deadline: it asks the IO worker for the absences whose corroboration count
 * and elapsed time are both satisfied, records their ids for audit, and deletes
 * them through the ordinary document path with the ordinary cascade.
 *
 * It runs on the Scheduler at background priority so it is subject to admission
 * control — while a real user request is in flight, the sweep's work is
 * deferred rather than competing for the single writer. One tick does one
 * bounded batch and returns; a backlog drains over ticks instead of in one
 * pass. A sweep that is behind therefore leaves documents past their deadline
 * standing a little longer, which is the safe direction: nothing about being
 * behind should turn into a catch-up burst.
 */

import { type Logger } from "@omnesis/core";
import { ScanTracker } from "../background-jobs/trackers.js";
import { periodicJob } from "../background-jobs/scheduler-job.js";
import { runWithPriority } from "../priority.js";
import { yieldToEventLoop } from "../async-yield.js";
import { DELETE_IN_LIST_CHUNK } from "../db.js";
import { analyticsSweepCandidateKey } from "../data/repositories/AnalyticsReplicaClaimRepository.js";
import { finishDocumentCascade } from "./document-cascade.js";
import type { BackgroundJob } from "../background-jobs/types.js";
import type { AbsenceCascade, DueAbsence } from "../data/repositories/AbsenceRepository.js";
import type { DueAnalyticsAbsence } from "../analytics/absence-store.js";
import type { IndexWriteGate } from "../indexer/index-write-gate.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import type { IoGate } from "../scheduler/io-ops.js";
import type { PeriodicTask, TaskOutcome } from "../scheduler/types.js";
import type { WriteGate } from "../write-gate.js";

interface IdleResult {
  idle: boolean;
}

/**
 * The two planes a snapshot can leave an absence in. One tick sweeps one of
 * them, so neither plane's backlog can starve the other and neither batch is
 * ever the length of both.
 */
const SWEEP_PHASES = ["documents", "analytics"] as const;
type SweepPhase = (typeof SWEEP_PHASES)[number];

/**
 * Documents one tick may delete. Sized so a full batch is a handful of short
 * writer transactions (`DELETE_IN_LIST_CHUNK` ids each) with an event-loop
 * yield between them — small enough that an interactive read queued behind the
 * sweep waits on one chunk, not on the whole backlog.
 */
const DEFAULT_SWEEP_BATCH = 200;

/** How often the sweep looks for work while it is finding some. */
const DEFAULT_ACTIVE_PERIOD_MS = 5_000;

/**
 * How often it looks once the backlog is empty. Deadlines are measured in
 * hours, so an idle sweep costs one indexed range seek every ten minutes.
 */
const DEFAULT_IDLE_PERIOD_MS = 10 * 60_000;

/**
 * How long after boot new absence deletions remain disabled. Durable cascades
 * drain immediately, while collectors get a chance to revoke stale evidence.
 */
const DEFAULT_DELETION_GRACE_MS = 5 * 60_000;

export interface AbsenceSweepTaskOptions {
  writeGate: WriteGate;
  ioGate: Pick<
    IoGate,
    "dueAbsences" | "pendingAbsenceCascades" | "staleAbsences" | "planAnalyticsSweep"
  >;
  /**
   * Index-DB cascade for the deleted documents. Omitted on paths that wire no
   * index DB, matching how the ingest paths treat it.
   */
  indexWriteGate?: Pick<IndexWriteGate, "deleteChunksByDocuments">;
  /**
   * Cognitive-state cascade for the deleted documents — the same purge the
   * ingest paths run behind a tombstone. Injected rather than reached for, so
   * the sweep owns no database handle of its own.
   */
  purgeAnnotationsFor: (documentIds: readonly string[]) => Promise<void>;
  /**
   * The structured plane's absence store. `presentIds` on a structured page
   * carries the same semantics and the same exposure as `presentExternalIds`,
   * so its absences expire on the same deadline. Omitted where no analytics DB
   * is wired.
   */
  analyticsDb?: {
    dueAbsences(opts: {
      dueBefore: number;
      minObservations: number;
      limit: number;
    }): Promise<readonly DueAnalyticsAbsence[]>;
    deleteAbsentRecords(
      due: readonly DueAnalyticsAbsence[],
      judge?: (row: DueAnalyticsAbsence) => Promise<"delete" | "disputed">,
    ): Promise<{ deleted: number; disputed: number }>;
  };
  /** Corroboration count an absence must reach. Read fresh so a config edit applies. */
  getMinObservations: () => number;
  /** Elapsed ms an absence must stand for. Read fresh so a config edit applies. */
  getMinAgeMs: () => number;
  log: Logger;
  clock?: () => number;
  batchSize?: number;
  activePeriodMs?: number;
  idlePeriodMs?: number;
  /** Grace before evaluating new deletions; durable cascades still drain immediately. */
  deletionGraceMs?: number;
  /** @deprecated Use deletionGraceMs. */
  startDelayMs?: number;
}

export interface AbsenceSweepBundle {
  task: PeriodicTask<undefined, IdleResult>;
  job: BackgroundJob;
}

export function createAbsenceSweepTask(
  opts: AbsenceSweepTaskOptions,
  scheduler: Scheduler,
): AbsenceSweepBundle {
  const clock = opts.clock ?? Date.now;
  const tracker = new ScanTracker();
  const batchSize = opts.batchSize ?? DEFAULT_SWEEP_BATCH;
  const deletionAllowedAt =
    clock() + (opts.deletionGraceMs ?? opts.startDelayMs ?? DEFAULT_DELETION_GRACE_MS);
  // A gateway with no analytics DB has no structured plane to sweep, and a
  // phase that always finds nothing would report idle every other tick and back
  // the whole sweep off to its idle period while documents were still queued.
  const phases: readonly SweepPhase[] =
    opts.analyticsDb === undefined ? ["documents"] : SWEEP_PHASES;
  let phaseIndex = 0;
  // Idleness is a property of the sweep, not of a tick. One plane finding
  // nothing is the common case, and reporting idle from that tick alone would
  // rearm the scheduler at its idle period while the other plane still had a
  // backlog — draining it at a batch every ten minutes instead of every five
  // seconds. A phase's last answer stands until it runs again.
  const idleByPhase = new Map<SweepPhase, boolean>(phases.map((phase) => [phase, true]));

  /** One bounded batch of due document absences. Returns what it saw and took. */
  async function sweepDocuments(
    dueBefore: number,
    minObservations: number,
  ): Promise<{ checked: number; deleted: number }> {
    async function finishCascade(cascade: AbsenceCascade): Promise<void> {
      await finishDocumentCascade(cascade, {
        deleteIndex: opts.indexWriteGate
          ? (ids) => opts.indexWriteGate!.deleteChunksByDocuments(ids)
          : undefined,
        purgeCognition: opts.purgeAnnotationsFor,
        acknowledge: (id, part) => opts.writeGate.acknowledgeAbsenceCascade(id, part),
      });
    }

    // A delete commits before its separate index/cognition stores can. The
    // writer transaction leaves this durable obligation behind, so a crash or
    // transient failure resumes here rather than losing the deleted ids.
    const pending = await opts.ioGate.pendingAbsenceCascades(1);
    if (pending.length > 0) {
      await finishCascade(pending[0]!);
      return { checked: batchSize, deleted: 0 };
    }
    // Stay on the active cadence through the grace. Reporting idle here would
    // arm the ten-minute idle period and overshoot a five-minute grace.
    if (clock() < deletionAllowedAt) return { checked: batchSize, deleted: 0 };

    // Generation invalidation makes a mass recovery immediately safe without
    // deleting its whole ledger on the sync writer. Reclaim one bounded tail
    // here so those physical rows disappear even if the source never syncs
    // again; the live-generation due query never walks them in the meantime.
    const stale = await opts.ioGate.staleAbsences(batchSize);
    if (stale.length > 0) await opts.writeGate.reclaimStaleAbsences(stale);
    const due: DueAbsence[] = await opts.ioGate.dueAbsences({
      dueBefore,
      minObservations,
      limit: batchSize,
    });
    let deleted = 0;
    let revoked = 0;
    let disputed = 0;
    for (let i = 0; i < due.length; i += DELETE_IN_LIST_CHUNK) {
      const chunk = due.slice(i, i + DELETE_IN_LIST_CHUNK);
      // The writer decides due-ness again against the absence rows as they
      // stand, records the ids, and deletes — all in one transaction. A
      // snapshot that revoked an absence in the gap, or a wipe that replaced
      // the source's corpus, is caught there rather than here.
      const batch = await opts.writeGate.sweepDueAbsences(
        chunk.map((row) => row.documentId),
        { minObservations, dueBefore, now: clock() },
      );
      deleted += batch.deletedDocumentIds.length;
      revoked += batch.revoked;
      disputed += batch.disputed;
      if (batch.cascade) await finishCascade(batch.cascade);
      if (i + DELETE_IN_LIST_CHUNK < due.length) await yieldToEventLoop();
    }
    if (revoked > 0) {
      opts.log.debug(
        `absence sweep: ${revoked} candidate(s) had their deadline revoked between the read and the write`,
      );
    }
    if (disputed > 0) {
      opts.log.info(
        `absence sweep: ${disputed} replicated item(s) left standing — another member disputes their deletion`,
      );
    }
    return { checked: Math.max(due.length, stale.length), deleted };
  }

  /** One bounded batch of due analytics absences. Same deadline, other plane. */
  async function sweepAnalytics(
    dueBefore: number,
    minObservations: number,
  ): Promise<{ checked: number; deleted: number }> {
    const due = await opts.analyticsDb!.dueAbsences({
      dueBefore,
      minObservations,
      limit: batchSize,
    });
    if (due.length === 0) return { checked: 0, deleted: 0 };
    // On a replicated source the replica deletion ledger has the last word on
    // each row. What it has to say about the batch is read once, before any
    // verdict of the batch is recorded: a disputed row stays, and every
    // other row's deletion is the verdict of the member whose snapshots
    // earned it, recorded inside the sweep's transaction before the row
    // goes, together with the one reset per source that sends every member
    // back to bootstrap so a healthier replica can restore what the deletion
    // got wrong — the sweep's counterpart of a fresh tombstone's sibling
    // reset. A source that is not replicated never reaches the writer here.
    const plan = await opts.ioGate.planAnalyticsSweep(
      due.map((row) => ({
        sourceId: row.sourceId,
        tableName: row.tableName,
        keyValue: row.keyValue,
      })),
    );
    const replicated = new Set(plan.replicatedSources);
    const disputedKeys = new Set(plan.disputed);
    const resetDone = new Set<string>();
    const { deleted, disputed } = await opts.analyticsDb!.deleteAbsentRecords(due, async (row) => {
      if (!replicated.has(row.sourceId)) return "delete";
      if (disputedKeys.has(analyticsSweepCandidateKey(row))) return "disputed";
      await opts.writeGate.recordAnalyticsSweepVerdict(
        {
          sourceId: row.sourceId,
          tableName: row.tableName,
          keyValue: row.keyValue,
          observedBy: row.observedBy,
          resetMembers: !resetDone.has(row.sourceId),
        },
        clock(),
      );
      resetDone.add(row.sourceId);
      return "delete";
    });
    if (disputed > 0) {
      opts.log.info(
        `absence sweep: ${disputed} replicated row(s) left standing — another member disputes their deletion`,
      );
    }
    return { checked: due.length, deleted };
  }

  const task: PeriodicTask<undefined, IdleResult> = {
    name: "absence.sweep",
    runner: "main",
    priority: "background",
    periodMs: opts.activePeriodMs ?? DEFAULT_ACTIVE_PERIOD_MS,
    idlePeriodMs: opts.idlePeriodMs ?? DEFAULT_IDLE_PERIOD_MS,
    // Start immediately so a crash-left outbox is repaired at boot. The
    // deletion grace is enforced inside run(), after that durable work.
    startDelayMs: 0,
    latencyBudgetMs: 1_000,
    initialArgs: undefined,
    async run(): Promise<TaskOutcome<undefined, IdleResult>> {
      // A config edit can kick this periodic while its HTTP request still
      // carries user-priority AsyncLocalStorage. Override that inherited
      // context for the whole unit so every nested writer call remains
      // background work, and stays subject to admission control (#199).
      return runWithPriority("background", async () => {
        if (phaseIndex === 0) tracker.recordSweepStarted();
        const phase: SweepPhase = phases[phaseIndex]!;
        phaseIndex = (phaseIndex + 1) % phases.length;
        const dueBefore = clock() - opts.getMinAgeMs();
        const minObservations = opts.getMinObservations();
        let outcome: { checked: number; deleted: number };
        try {
          outcome =
            phase === "analytics"
              ? clock() < deletionAllowedAt
                ? { checked: batchSize, deleted: 0 }
                : await sweepAnalytics(dueBefore, minObservations)
              : await sweepDocuments(dueBefore, minObservations);
        } catch (err) {
          opts.log.warn(
            `absence sweep (${phase}) failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          // A later tick retries the same absences; the deadline has already
          // passed, so nothing is lost by waiting one period.
          // Failure proves neither that this plane is empty nor that a durable
          // cascade finished. Stay on the active cadence until a successful
          // short read establishes idleness.
          idleByPhase.set(phase, false);
          return { kind: "done", value: { idle: [...idleByPhase.values()].every(Boolean) } };
        }
        tracker.recordSweepCompleted({ checked: outcome.checked, affected: outcome.deleted });
        if (outcome.deleted > 0) {
          const noun = phase === "analytics" ? "analytics row" : "document";
          opts.log.info(
            `absence sweep deleted ${outcome.deleted} ${noun}${outcome.deleted === 1 ? "" : "s"} whose absence stood past its deadline`,
          );
        }
        // A full batch means more may be waiting: stay on the active period so
        // the backlog drains over ticks rather than in one pass.
        idleByPhase.set(phase, outcome.checked < batchSize);
        return { kind: "done", value: { idle: [...idleByPhase.values()].every(Boolean) } };
      });
    },
    isIdle: (result) => result.idle,
  };

  return {
    task,
    job: periodicJob(task, {
      scheduler,
      displayName: "Absence sweep",
      description:
        "Deletes documents whose absence from a source's snapshots has been corroborated and has stood past its deadline.",
      category: "infra",
      tracker,
    }),
  };
}
