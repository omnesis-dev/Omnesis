// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The morning-digest enqueuer — one due-gated pass that fires the day's
 * single `digest` run (the composed "Morning brief") once per local day
 * at `brain.digest.hour`, BEHIND a readiness barrier so the digest
 * never composes a stale world:
 *
 *   1. today's daily batches must have been ENQUEUED (the daily-boundary
 *      marker says so — the dailies anchor earlier, at `dailyRunHour`), and
 *      every sweep that declares itself a digest prerequisite must have fired
 *      for today (the day-ahead pass is most of the overnight work the digest
 *      is an editorial pass over, so composing before it has run yields a
 *      thinner brief);
 *   2. the run queue must be QUIET — no pending run due for a claim and
 *      nothing executing right now — i.e. the overnight work has
 *      settled, not merely been scheduled. Debounced rows with a future
 *      next_attempt_at deliberately don't hold the digest hostage;
 *   3. a grace deadline (`hour` + `graceMinutes`) bounds the wait — on a
 *      pathologically busy morning a slightly-incomplete brief beats no
 *      morning brief. The digest's facts are injected at PROMPT-BUILD
 *      time (when the drainer claims the run), so even the grace path
 *      composes from the substrates as they stand at that moment.
 */

import { digestRunDedupeKey } from "../run-payloads.js";
import {
  countDuePendingCognitionRuns,
  hasCognitionRunWithDedupeKey,
} from "../storage/run-queue.js";
import {
  getCognitionEngineState,
  cognitionSweepLastBoundaryKey,
  COGNITION_DAILY_LAST_RUN_DAY_KEY,
  COGNITION_DIGEST_LAST_RUN_DAY_KEY,
} from "../storage/engine-state.js";
import { mostRecentSweepBoundary } from "../sweeps/anchor.js";
import { mostRecentDailyBoundary } from "./daily-boundary.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { DailyEnqueuerWriteOps } from "./daily-enqueuer.js";
import type { Clock } from "../storage/types.js";

type Db = Database.Database;

export interface DigestEnqueuerDeps {
  db: Db;
  writeGate: DailyEnqueuerWriteOps;
  clock: Clock;
  /** Local hour (0-23) the digest composes at; read live. */
  getDigestHour: () => number;
  /** Minutes past the hour after which the barrier stops waiting. */
  getGraceMinutes: () => number;
  /** Runs executing right now (the drainer's live word); 0 when unwired. */
  getActiveRunCount: () => number;
  /**
   * Sweeps the digest must wait for, with the anchor each one fires on. Read
   * live. Absent (or empty) leaves the barrier as batches-plus-quiet, which is
   * what a composition without a sweep store gets.
   */
  getDigestPrerequisiteSweeps?: () => readonly { id: string; anchorMinutes: number }[];
  log: Logger;
  idGen?: () => string;
}

export type DigestEnqueuePassResult =
  | { fired: true }
  | { fired: false; reason: "disabled-window" | "already-ran" | "waiting" };

/**
 * Whether every sweep that declares itself a digest prerequisite has fired for
 * its most recent anchor. A sweep the operator has switched off is simply not
 * in the list, so a disabled prerequisite never holds the digest.
 */
function prerequisiteSweepsFired(deps: DigestEnqueuerDeps, now: number): boolean {
  const required = deps.getDigestPrerequisiteSweeps?.() ?? [];
  for (const sweep of required) {
    const raw = getCognitionEngineState(deps.db, cognitionSweepLastBoundaryKey(sweep.id));
    const last = raw === null ? 0 : Number(raw);
    if (!Number.isFinite(last) || last < mostRecentSweepBoundary(now, sweep.anchorMinutes)) {
      return false;
    }
  }
  return true;
}

/** One due-gated pass. Called from the rhythm task each tick. */
export async function runDigestEnqueuePass(
  deps: DigestEnqueuerDeps,
): Promise<DigestEnqueuePassResult> {
  const now = deps.clock();
  const boundary = mostRecentDailyBoundary(now, deps.getDigestHour());
  const lastRunDay = getCognitionEngineState(deps.db, COGNITION_DIGEST_LAST_RUN_DAY_KEY);
  // Strict `>=`: a clock jump backwards past a day it already ran stays quiet.
  if (lastRunDay !== null && lastRunDay >= boundary.day) {
    return { fired: false, reason: "already-ran" };
  }
  // Crash-replay guard: a crash between enqueue and the marker write
  // replays this pass with the marker missing — but the day's run row
  // (any status; a pending one would fold, a SETTLED one would not)
  // proves the day already fired. Repair the marker and stand down.
  if (hasCognitionRunWithDedupeKey(deps.db, digestRunDedupeKey(boundary.day))) {
    await deps.writeGate.setCognitionEngineState(COGNITION_DIGEST_LAST_RUN_DAY_KEY, boundary.day);
    return { fired: false, reason: "already-ran" };
  }

  const gracePassed = now >= boundary.boundaryMs + deps.getGraceMinutes() * 60_000;
  if (!gracePassed) {
    // Readiness barrier: today's dailies enqueued AND the queue settled.
    const dailyDay = getCognitionEngineState(deps.db, COGNITION_DAILY_LAST_RUN_DAY_KEY);
    const dailiesEnqueued = dailyDay !== null && dailyDay >= boundary.day;
    const queueQuiet =
      countDuePendingCognitionRuns(deps.db, now) === 0 && deps.getActiveRunCount() === 0;
    if (!dailiesEnqueued || !queueQuiet || !prerequisiteSweepsFired(deps, now)) {
      return { fired: false, reason: "waiting" };
    }
  } else {
    deps.log.info(
      `digest grace deadline passed for ${boundary.day} — composing with the queue still busy`,
    );
  }

  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  await deps.writeGate.enqueueCognitionRun(
    {
      id: `run_${idGen()}`,
      kind: "daily",
      payload: { digest: true, date: boundary.day },
      dedupeKey: digestRunDedupeKey(boundary.day),
    },
    now,
  );
  // Marker LAST — a crash before this replays the pass; the dedupe key folds.
  await deps.writeGate.setCognitionEngineState(COGNITION_DIGEST_LAST_RUN_DAY_KEY, boundary.day);
  deps.log.info(`digest run enqueued for ${boundary.day}`);
  return { fired: true };
}
