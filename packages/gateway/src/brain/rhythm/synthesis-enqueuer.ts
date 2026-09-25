// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The synthesis ("Noticing") enqueuer — one due-gated pass of the
 * generative rhythm. Fires at most one `synthesis` run of focus "noticing"
 * per cadence window, hard-capped per local day. Mirrors the daily enqueuer's
 * marker discipline: read the last-fire marker, gate on the cadence + the
 * per-day cap, enqueue, then write the marker LAST so a crash replays and the
 * day-scoped dedupe key folds instead of double-enqueueing.
 */

import { cognitionSpendDay } from "../storage/spend.js";
import { synthesisNoticingDedupeKey } from "../run-payloads.js";
import {
  getCognitionEngineState,
  COGNITION_SYNTHESIS_LAST_RUN_KEY,
} from "../storage/engine-state.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { DailyEnqueuerWriteOps } from "./daily-enqueuer.js";
import type { Clock } from "../storage/types.js";

type Db = Database.Database;

export interface SynthesisEnqueuerDeps {
  db: Db;
  writeGate: DailyEnqueuerWriteOps;
  clock: Clock;
  /** Minimum hours between noticing passes. */
  getCadenceHours: () => number;
  /** Hard cap on noticing passes per local day. */
  getMaxPerDay: () => number;
  log: Logger;
  idGen?: () => string;
}

export interface SynthesisEnqueuePassResult {
  fired: boolean;
}

/** Noticing runs already enqueued for `day` (settled rows keep their key). */
function noticingRunsForDay(db: Db, day: string): number {
  const row = db
    .prepare<
      [string],
      { c: number }
    >("SELECT COUNT(*) AS c FROM cognition_runs WHERE dedupe_key = ?")
    .get(synthesisNoticingDedupeKey(day));
  return row?.c ?? 0;
}

export async function runSynthesisEnqueuePass(
  deps: SynthesisEnqueuerDeps,
): Promise<SynthesisEnqueuePassResult> {
  const now = deps.clock();
  const cadenceMs = Math.max(1, deps.getCadenceHours()) * 3_600_000;
  const lastRaw = getCognitionEngineState(deps.db, COGNITION_SYNTHESIS_LAST_RUN_KEY);
  const last = lastRaw === null ? 0 : Number(lastRaw);
  if (Number.isFinite(last) && now - last < cadenceMs) return { fired: false };

  const day = cognitionSpendDay(now);
  if (noticingRunsForDay(deps.db, day) >= Math.max(1, deps.getMaxPerDay())) {
    return { fired: false };
  }

  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  await deps.writeGate.enqueueCognitionRun(
    {
      id: `run_${idGen()}`,
      kind: "synthesis",
      payload: { focus: "noticing", date: day },
      dedupeKey: synthesisNoticingDedupeKey(day),
    },
    now,
  );
  // Marker LAST — a crash before this replays the pass; the dedupe key folds.
  await deps.writeGate.setCognitionEngineState(COGNITION_SYNTHESIS_LAST_RUN_KEY, String(now));
  deps.log.info(`synthesis noticing pass enqueued for ${day}`);
  return { fired: true };
}
