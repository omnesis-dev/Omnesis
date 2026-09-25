// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The retrospective bootstrap enqueuer (experimental). Each pass tops up the
 * pending `bootstrap` backlog with historical documents that still carry a
 * future-dated semantic time (recent→oldest), under a backlog cap and a
 * per-day run cap. `bootstrap` runs claim at the lowest queue priority, so
 * they never delay reactive or scheduled work — this enqueuer only paces how
 * fast the backlog is filled and caps the queue size + daily spend.
 *
 * The daily cap is the lane's real cost control. The lane ships enabled, the
 * cognition spend budget has no default, and the lifetime `maxRuns` backstop
 * sits far above any real corpus — so `maxRunsPerDay` is the number that
 * decides what enabling the Brain costs per day.
 *
 * The boundary with the live waker is the datum's own timestamp, not the
 * moment it was ingested: the waker takes anything inside its recency window,
 * this takes everything outside it. Keying both lanes on one clock is what
 * stops a source connected later from falling between them (see
 * `storage/bootstrap.ts`).
 *
 * **The lane never finishes.** A corpus is not a fixed body of work: a source
 * connected next month brings a decade of history with it, and a document
 * whose date enrichment lands later, or which simply ages out of the recency
 * window, becomes a candidate long after it was ingested. So running out of
 * candidates makes the lane quiet, not done. It records `drained` plus the two
 * facts that justified going quiet — the day it happened and the source
 * roster's high-water mark — and re-probes when either has moved: a new local
 * day, or a source added since. Until then a pass is a handful of key reads,
 * which matters because the probe itself joins `document_extracted_dates` and
 * reads `json_extract` per row over the whole corpus.
 *
 * **The boot hold.** Every pass — not only a drained lane's re-probe — waits
 * out a window after process start: a restart already has the backfill workers
 * competing for the same handle, and a lane that is behind stays behind
 * perfectly well for ten more minutes. The hold is bounded by wall clock
 * rather than by process lifetime, so a process that keeps restarting inside
 * the window still gets a pass once the window's worth of time has elapsed;
 * an absolute gate would let a restart loop starve the lane forever.
 *
 * The lifetime run backstop PARKS the lane rather than ending it, matching how
 * the daily spend ceiling parks the drain at the claim boundary: the ceiling is
 * re-read live, so raising it resumes the lane on the next tick instead of
 * requiring the operator to find a state row and edit it.
 *
 * State (all in `cognition_engine_state`, durable across enable/disable):
 *  - `bootstrap_state` — `running` | `drained` | `parked`;
 *  - `bootstrap_drained_day` / `bootstrap_drained_sources` — what the lane
 *    knew when it went quiet, and therefore what has to change to wake it;
 *  - `bootstrap_hold_since` — when the current boot hold began (`0` = none);
 *  - `bootstrap_enqueued:<day>` — the per-day run counter;
 *  - `bootstrap_total_enqueued` — the lifetime counter the backstop reads.
 *
 * Marker discipline: each enqueued doc is marked bootstrap-processed
 * immediately (mark-at-enqueue), so the next pass never re-selects it; a run's
 * settle additionally marks the older docs it opened (the cross-arc skip) and
 * the document a live `data` run reasoned over, so the two lanes never buy the
 * same document twice.
 */

import { cognitionSpendDay } from "../storage/spend.js";
import { bootstrapRunDedupeKey } from "../run-payloads.js";
import {
  countPendingBootstrap,
  fetchBootstrapBatch,
  latestSourceCreatedAt,
} from "../storage/bootstrap.js";
import { cognitiveWorkflowIdForRun, cognitiveWorkflowVersion } from "../cognition/workflows.js";
import {
  getCognitionEngineState,
  cognitionBootstrapEnqueuedKey,
  COGNITION_BOOTSTRAP_DRAINED_DAY_KEY,
  COGNITION_BOOTSTRAP_DRAINED_SOURCES_KEY,
  COGNITION_BOOTSTRAP_HOLD_SINCE_KEY,
  COGNITION_BOOTSTRAP_STATE_KEY,
  COGNITION_BOOTSTRAP_STARTED_AT_KEY,
  COGNITION_BOOTSTRAP_TOTAL_KEY,
} from "../storage/engine-state.js";
import { bootstrapWindowOpen } from "../bootstrap-window.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { CognitionCoverageDelta } from "../storage/coverage.js";
import type { EnqueueCognitionRunInput, EnqueueCognitionRunResult } from "../storage/run-queue.js";
import type { Clock } from "../storage/types.js";

type Db = Database.Database;

/** The lane's durable lifecycle marker. Neither quiet state is terminal. */
const BOOTSTRAP_STATE_RUNNING = "running";
const BOOTSTRAP_STATE_DRAINED = "drained";
const BOOTSTRAP_STATE_PARKED = "parked";

type BootstrapLaneState =
  | typeof BOOTSTRAP_STATE_RUNNING
  | typeof BOOTSTRAP_STATE_DRAINED
  | typeof BOOTSTRAP_STATE_PARKED;

/**
 * How long after process start the lane holds off a pass, and equally the
 * longest a hold may last across restarts. The minutes after a restart are
 * when the backfill workers are busiest on the same handle this pass reads.
 */
export const BOOTSTRAP_BOOT_GRACE_MS = 10 * 60_000;

export interface BootstrapSettings {
  enabled: boolean;
  /**
   * The live waker's recency window. Shared so the two lanes divide the corpus
   * on one boundary — a datum inside it is the waker's, outside it is this
   * lane's — rather than each keeping its own idea of "recent".
   */
  recencyWindowMs: number;
  direction: "recent-first" | "oldest-first";
  backlogTarget: number;
  /** Daily run cap — the lane's pace, and therefore its spend ceiling. */
  maxRunsPerDay: number;
  /** Lifetime run backstop — the lane parks once this many are enqueued. */
  maxRuns: number;
  batchSize: number;
  /**
   * Optional daily window, local wall-clock, during which the lane may buy
   * work. Absent means always. See `bootstrap-window.ts`.
   */
  activeHours?: { from: string; to: string };
}

export interface BootstrapEnqueuerWriteOps {
  enqueueCognitionRun(
    input: EnqueueCognitionRunInput,
    now: number,
  ): Promise<EnqueueCognitionRunResult>;
  setCognitionEngineState(key: string, value: string): Promise<void>;
  addToCognitionEngineCounter(key: string, delta: number): Promise<void>;
  markDocsBootstrapProcessed(docIds: readonly string[], nowIso: string): Promise<number>;
  recordCognitionCoverage(deltas: readonly CognitionCoverageDelta[], now: number): Promise<number>;
}

export interface BootstrapEnqueuerDeps {
  db: Db;
  writeGate: BootstrapEnqueuerWriteOps;
  clock: Clock;
  getSettings: () => BootstrapSettings;
  log: Logger;
  /** When this gateway process started (unix ms), for the boot hold. */
  startedAt: number;
  idGen?: () => string;
}

export interface BootstrapEnqueuePassResult {
  enqueued: number;
  /** The lane's state after the pass; `idle` when the knob is off. */
  state: "idle" | BootstrapLaneState;
  /**
   * Historical documents still owed after this pass, when the pass looked.
   *
   * Absent on a pass that returned without probing the corpus — the boot hold,
   * a shut window, a parked or quiet lane. Absent means "not measured just
   * now", which a progress gauge must not read as zero.
   */
  remaining?: number;
}

/** Currently-pending bootstrap runs (drives the backlog cap). */
function countPendingBootstrapRuns(db: Db): number {
  return (
    db
      .prepare<
        [],
        { c: number }
      >("SELECT COUNT(*) AS c FROM cognition_runs WHERE kind = 'bootstrap' AND status = 'pending'")
      .get()?.c ?? 0
  );
}

/**
 * Why a drained lane should probe again, or null to stay quiet. The two
 * reasons are the two ways a drained corpus gains candidates: a source arrives
 * with history behind it, or time passes and documents cross the boundary.
 *
 * Exported because the observability surface has to answer the same question:
 * a lane whose stored state is `drained` but whose reopen condition already
 * holds will probe on its very next pass, and reporting it as quiet would be a
 * lie with a shelf life of one tick. One predicate, so the two cannot drift.
 */
export function bootstrapReopenReason(db: Db, today: string): string | null {
  const drainedDay = getCognitionEngineState(db, COGNITION_BOOTSTRAP_DRAINED_DAY_KEY);
  if (drainedDay !== today) return `a new day (${today})`;
  const raw = getCognitionEngineState(db, COGNITION_BOOTSTRAP_DRAINED_SOURCES_KEY);
  // No recorded roster is no basis for staying quiet: probe rather than
  // assume. A build that went quiet without writing this leaves it absent.
  if (raw === null) return "the source roster it went quiet on was never recorded";
  const drainedSources = Number(raw);
  const newest = latestSourceCreatedAt(db);
  if (!Number.isFinite(drainedSources) || newest > drainedSources) return "a source was added";
  return null;
}

export async function runBootstrapEnqueuePass(
  deps: BootstrapEnqueuerDeps,
): Promise<BootstrapEnqueuePassResult> {
  const s = deps.getSettings();
  if (!s.enabled) return { enqueued: 0, state: "idle" };

  const now = deps.clock();
  // The lane buys nothing until the operator has started it. Assigning a
  // background-agent model is a capability choice — which model the Brain uses
  // — and treating it as consent to spend for days working through history is
  // a commitment nobody knowingly made. An install that has never started and
  // one that is paused are different states, and the surfaces say so.
  if (getCognitionEngineState(deps.db, COGNITION_BOOTSTRAP_STARTED_AT_KEY) === null) {
    return { enqueued: 0, state: "idle" };
  }
  const stored = getCognitionEngineState(deps.db, COGNITION_BOOTSTRAP_STATE_KEY);
  /** What the lane is right now — what a deferred pass reports unchanged. */
  const current: BootstrapLaneState =
    stored === BOOTSTRAP_STATE_DRAINED || stored === BOOTSTRAP_STATE_PARKED
      ? stored
      : BOOTSTRAP_STATE_RUNNING;

  // The boot hold, over the WHOLE pass: a running or first-ever lane would
  // otherwise probe the corpus and enqueue seconds after start, into exactly
  // the post-restart backfill contention the hold exists to stay out of.
  //
  // The hold is bounded by wall clock, not by process lifetime. `hold_since`
  // is stamped the first time a pass defers and cleared the first time one
  // proceeds, so a process restarting more often than the window still runs a
  // pass once the window's worth of time has gone by — steady state is a key
  // read and no write.
  const holdSince =
    Number(getCognitionEngineState(deps.db, COGNITION_BOOTSTRAP_HOLD_SINCE_KEY) ?? "0") || 0;
  if (now - deps.startedAt < BOOTSTRAP_BOOT_GRACE_MS) {
    if (holdSince === 0) {
      await deps.writeGate.setCognitionEngineState(COGNITION_BOOTSTRAP_HOLD_SINCE_KEY, String(now));
      return { enqueued: 0, state: current };
    }
    if (now - holdSince < BOOTSTRAP_BOOT_GRACE_MS) return { enqueued: 0, state: current };
  }
  if (holdSince !== 0) {
    await deps.writeGate.setCognitionEngineState(COGNITION_BOOTSTRAP_HOLD_SINCE_KEY, "0");
  }
  // The off-peak window, checked after the boot hold and before the candidate
  // probe: outside it the lane buys nothing, and the stored state is left
  // exactly as it was. Deliberately not persisted as a state of its own —
  // being outside the window is a fact about the clock, derivable at any time,
  // and a stored copy could only disagree with it.
  if (!bootstrapWindowOpen(s.activeHours, now)) return { enqueued: 0, state: current };

  const nowIso = new Date(now).toISOString();
  const today = cognitionSpendDay(now);

  let persisted = stored;
  /** Record a lane state, skipping the write when it is already the stored one. */
  const setState = async (next: BootstrapLaneState): Promise<void> => {
    if (persisted === next) return;
    await deps.writeGate.setCognitionEngineState(COGNITION_BOOTSTRAP_STATE_KEY, next);
    persisted = next;
  };

  // The quiet short-circuit — the only path that skips the candidate probe.
  if (stored === BOOTSTRAP_STATE_DRAINED) {
    const reason = bootstrapReopenReason(deps.db, today);
    if (reason === null) return { enqueued: 0, state: BOOTSTRAP_STATE_DRAINED };
    deps.log.info(`bootstrap reopening: ${reason}`);
  }

  // The lifetime run backstop. Checked before the probe so a parked lane costs
  // one key read per tick, and re-read live so raising the ceiling resumes the
  // lane without a restart.
  const totalEnqueued =
    Number(getCognitionEngineState(deps.db, COGNITION_BOOTSTRAP_TOTAL_KEY) ?? "0") || 0;
  if (totalEnqueued >= s.maxRuns) {
    if (persisted !== BOOTSTRAP_STATE_PARKED) {
      deps.log.info(
        `bootstrap parked at its lifetime run backstop (${totalEnqueued}/${s.maxRuns}) — raise brain.bootstrap.maxRuns to resume`,
      );
    }
    await setState(BOOTSTRAP_STATE_PARKED);
    return { enqueued: 0, state: BOOTSTRAP_STATE_PARKED };
  }
  await setState(BOOTSTRAP_STATE_RUNNING);

  // Both room checks sit AHEAD of the candidate probe. They are a count over
  // the run queue and one key read, and between them they are what most often
  // decides a pass does nothing — while the probe joins
  // `document_extracted_dates` and evaluates `json_extract` per row across the
  // whole corpus.

  // Backlog cap — leave the drainer room to catch up.
  const backlogRoom = Math.max(0, s.backlogTarget - countPendingBootstrapRuns(deps.db));
  if (backlogRoom === 0) return { enqueued: 0, state: BOOTSTRAP_STATE_RUNNING };

  // The daily pace cap — the lane's spend ceiling.
  const dayKey = cognitionBootstrapEnqueuedKey(today);
  const enqueuedToday = Number(getCognitionEngineState(deps.db, dayKey) ?? "0") || 0;
  const budgetRoom = Math.max(0, s.maxRunsPerDay - enqueuedToday);
  if (budgetRoom === 0) return { enqueued: 0, state: BOOTSTRAP_STATE_RUNNING };

  // The live/historical boundary, recomputed every pass: a datum older than
  // the waker's recency window is this lane's, anything newer is the waker's.
  const recencyFloor = new Date(now - s.recencyWindowMs).toISOString();

  // No historical candidates left → go quiet, recording what has to change
  // before the next probe is worth its cost.
  const remaining = countPendingBootstrap(deps.db, recencyFloor);
  if (remaining === 0) {
    await setState(BOOTSTRAP_STATE_DRAINED);
    await deps.writeGate.setCognitionEngineState(COGNITION_BOOTSTRAP_DRAINED_DAY_KEY, today);
    await deps.writeGate.setCognitionEngineState(
      COGNITION_BOOTSTRAP_DRAINED_SOURCES_KEY,
      String(latestSourceCreatedAt(deps.db)),
    );
    deps.log.info("bootstrap drained — no historical documents remain to review");
    return { enqueued: 0, state: BOOTSTRAP_STATE_DRAINED };
  }

  const totalRoom = Math.max(0, s.maxRuns - totalEnqueued);
  const take = Math.min(s.batchSize, backlogRoom, budgetRoom, totalRoom);
  const batch = fetchBootstrapBatch(deps.db, {
    recencyFloor,
    batchSize: take,
    direction: s.direction,
  });
  if (batch.length === 0) return { enqueued: 0, state: BOOTSTRAP_STATE_RUNNING };

  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  for (const row of batch) {
    await deps.writeGate.enqueueCognitionRun(
      {
        id: `run_${idGen()}`,
        kind: "bootstrap",
        payload: { docId: row.docId, datumAt: row.datumAt },
        dedupeKey: bootstrapRunDedupeKey(row.docId),
      },
      now,
    );
  }
  // Mark-at-enqueue so the next pass never re-selects these docs, then bump the
  // day's spend counter. Marker/counter LAST — a crash before them replays the
  // pass and the per-doc dedupe keys fold the re-enqueued rows.
  // Known gap: #2060 — a terminally FAILED run leaves the marker set, so the
  // document is never re-admitted (permanent backfill hole on provider outages).
  await deps.writeGate.markDocsBootstrapProcessed(
    batch.map((r) => r.docId),
    nowIso,
  );
  // Added, not assigned. Both counters were read at the top of this pass and
  // several awaits ago; writing back an absolute total lets a lost write drop
  // increments for good, and the lifetime one is the lane's own backstop.
  await deps.writeGate.addToCognitionEngineCounter(dayKey, batch.length);
  await deps.writeGate.addToCognitionEngineCounter(COGNITION_BOOTSTRAP_TOTAL_KEY, batch.length);
  // Per-source coverage: the documents this lane selected. Reporting only —
  // the counters never decide what the lane takes (see storage/coverage.ts).
  await deps.writeGate.recordCognitionCoverage(coverageDeltas(batch), now);
  deps.log.info(
    `bootstrap enqueued ${batch.length} run(s); ${Math.max(0, remaining - batch.length)} historical docs remain`,
  );
  // Say so once, on the pass that exhausts the day's allowance, rather than on
  // every tick that finds it already spent: the pace cap is what an operator
  // watching history converge slowly would want to raise.
  if (enqueuedToday + batch.length >= s.maxRunsPerDay) {
    deps.log.info(
      `bootstrap spent today's run allowance (${s.maxRunsPerDay}) — it resumes on the next local day; raise brain.bootstrap.maxRunsPerDay to converge faster`,
    );
  }
  return {
    enqueued: batch.length,
    state: BOOTSTRAP_STATE_RUNNING,
    remaining: Math.max(0, remaining - batch.length),
  };
}

/** One `eligible` increment per source represented in the batch. */
function coverageDeltas(batch: readonly { sourceId: string }[]): readonly CognitionCoverageDelta[] {
  // Read from the same mapping the settle path uses, so the enqueue-side and
  // settle-side tallies can never land on different workflow rows.
  const workflowId = cognitiveWorkflowIdForRun("bootstrap", null);
  const workflowVersion = cognitiveWorkflowVersion(workflowId);
  const bySource = new Map<string, number>();
  for (const row of batch) bySource.set(row.sourceId, (bySource.get(row.sourceId) ?? 0) + 1);
  return [...bySource].map(([sourceId, eligible]) => ({
    sourceId,
    workflowId,
    workflowVersion,
    eligible,
  }));
}
