// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The sweep enqueuer — one due-gated pass over the resolved sweep set (system
 * sweeps layered with the operator's files; see `brain/sweeps/registry.ts`).
 *
 * Each enabled sweep fires at most once per cadence, on its own local-time
 * anchor rather than whenever a timer happens to elapse (`sweeps/anchor.ts`
 * carries the reasoning). Marker discipline mirrors the digest enqueuer's:
 * read the per-sweep boundary marker, gate on it, check that the occurrence
 * has not already been recorded, enqueue, then write the marker LAST so a
 * crash replays and the (sweep, boundary-day)-scoped dedupe key folds instead
 * of double-enqueueing. The steering prose is snapshotted onto the run
 * payload, so an in-flight run is unaffected by a mid-run edit of its file.
 */

import { cognitionSpendDay } from "../storage/spend.js";
import { sweepDedupeKey } from "../run-payloads.js";
import { hasCognitionRunWithDedupeKey } from "../storage/run-queue.js";
import {
  getCognitionEngineState,
  cognitionSweepLastBoundaryKey,
  cognitionSweepLegacyLastRunKey,
} from "../storage/engine-state.js";
import { sweepDue } from "../sweeps/anchor.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { DailyEnqueuerWriteOps } from "./daily-enqueuer.js";
import type { Clock } from "../storage/types.js";
import type { SweepDef } from "../sweeps/types.js";

type Db = Database.Database;

export interface SweepEnqueuerDeps {
  db: Db;
  writeGate: DailyEnqueuerWriteOps;
  clock: Clock;
  /** The resolved sweep set, read live (files and config are hot-reloadable). */
  getSweeps: () => readonly SweepDef[];
  log: Logger;
  idGen?: () => string;
}

export interface SweepEnqueuePassResult {
  /** How many sweep runs this pass enqueued. */
  fired: number;
}

/**
 * The boundary a sweep last fired for. Falls back once to the pre-anchor
 * marker, which held a wall-clock fire time — close enough in kind to seed the
 * cadence, and it stops an upgrade from re-firing every theme at once.
 */
function lastBoundaryFor(db: Db, sweepId: string): number {
  const raw =
    getCognitionEngineState(db, cognitionSweepLastBoundaryKey(sweepId)) ??
    getCognitionEngineState(db, cognitionSweepLegacyLastRunKey(sweepId));
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function runSweepEnqueuePass(
  deps: SweepEnqueuerDeps,
): Promise<SweepEnqueuePassResult> {
  const now = deps.clock();
  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  let fired = 0;
  for (const sweep of deps.getSweeps()) {
    if (!sweep.enabled) continue;
    const due = sweepDue({
      nowMs: now,
      cadenceHours: sweep.cadenceHours,
      anchorMinutes: sweep.anchorMinutes,
      lastBoundaryMs: lastBoundaryFor(deps.db, sweep.id),
    });
    if (!due.due) {
      // A sweep that has never run starts its phase without firing, so a fresh
      // install does not enqueue every sweep in one serialized batch.
      if ("seedBoundaryMs" in due) {
        await deps.writeGate.setCognitionEngineState(
          cognitionSweepLastBoundaryKey(sweep.id),
          String(due.seedBoundaryMs),
        );
        deps.log.info(`sweep '${sweep.id}' seeded — first run at its next anchor`);
      }
      continue;
    }
    // The day comes from the BOUNDARY, not from the tick that noticed it: a
    // crash between the enqueue and the marker write must replay onto the same
    // dedupe key, and a sweep anchored late in the evening would otherwise
    // replay after midnight under a different one and run twice.
    const day = cognitionSpendDay(due.boundaryMs);
    const dedupeKey = sweepDedupeKey(sweep.id, day);
    // Crash-replay guard, mirroring the digest enqueuer: a pending row folds on
    // its own, but a row that already SETTLED would not — the occurrence
    // already happened, so repair the marker and stand down.
    if (hasCognitionRunWithDedupeKey(deps.db, dedupeKey)) {
      await deps.writeGate.setCognitionEngineState(
        cognitionSweepLastBoundaryKey(sweep.id),
        String(due.boundaryMs),
      );
      continue;
    }
    await deps.writeGate.enqueueCognitionRun(
      {
        id: `run_${idGen()}`,
        kind: "sweep",
        payload: {
          sweepId: sweep.id,
          date: day,
          steeringPrompt: sweep.steeringPrompt,
          origin: sweep.origin,
          ...(sweep.briefLane !== undefined ? { briefLane: sweep.briefLane } : {}),
          ...(sweep.temporalAnnotationPrimeDays !== undefined
            ? { temporalAnnotationPrimeDays: sweep.temporalAnnotationPrimeDays }
            : {}),
        },
        dedupeKey,
      },
      now,
    );
    // Marker LAST — a crash before this replays the pass; the dedupe key folds.
    await deps.writeGate.setCognitionEngineState(
      cognitionSweepLastBoundaryKey(sweep.id),
      String(due.boundaryMs),
    );
    deps.log.info(`sweep '${sweep.id}' (${sweep.origin}) enqueued for ${day}`);
    fired += 1;
  }
  return { fired };
}
