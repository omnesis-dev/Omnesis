// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The collision sweep enqueuer — one due-gated pass that finds structural
 * collisions and seeds a `synthesis` run per candidate to JUDGE whether the
 * relation is real. Three deterministic generators ride one cadence:
 *   - loops sharing a person / document / deadline day (importance-ranked,
 *     take priority) and pairs of temporal annotations whose intervals overlap
 *     inside the forward horizon (soonest first) — the "collision" focus,
 *     sharing one per-sweep budget, gated by `brain.collision.enabled`;
 *   - groups of live annotations sharing a subject + claimType yet
 *     disagreeing on the claim — the "annotation-contradiction" focus, its
 *     own budget, gated by `brain.collision.annotationContradictions`.
 * Over-produce cheaply here; the judge grounds against the source documents.
 *
 * Independent of the noticing producer — all ride the `synthesis` kind.
 * Bounded per sweep; a candidate already covered by an active brief is
 * filtered by the candidate finder, and the per-set dedupe key folds a
 * re-detected group.
 */

import {
  findCollisionCandidates,
  findTemporalAnnotationCollisionCandidates,
  findAnnotationContradictionCandidates,
  collisionDedupeSuffix,
} from "../reconcile/collision-candidates.js";
import {
  synthesisCollisionDedupeKey,
  synthesisAnnotationContradictionDedupeKey,
} from "../run-payloads.js";
import {
  getCognitionEngineState,
  COGNITION_COLLISION_LAST_RUN_KEY,
} from "../storage/engine-state.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { DailyEnqueuerWriteOps } from "./daily-enqueuer.js";
import type { Clock } from "../storage/types.js";

type Db = Database.Database;

export interface CollisionSweepDeps {
  db: Db;
  writeGate: DailyEnqueuerWriteOps;
  clock: Clock;
  /** Minimum hours between sweeps. */
  getCadenceHours: () => number;
  /** Max collision-judge runs to enqueue per sweep. */
  getMaxPerSweep: () => number;
  /** Self person id, excluded from the person-collision signal (on everything). */
  getSelfPersonId: () => string | null;
  /** Forward horizon (days) for temporal-annotation interval collisions. */
  getTimeHorizonDays: () => number;
  /**
   * Whether the loop-join + time-overlap arms run this pass (the
   * `brain.collision.enabled` verdict). Absent = true, so direct callers
   * exercising the classic sweep keep its historical behaviour.
   */
  getLoopCollisionsEnabled?: () => boolean;
  /** Annotation-contradiction arm (`brain.collision.annotationContradictions.enabled`). Absent = off. */
  getAnnotationContradictionsEnabled?: () => boolean;
  /** Max annotation-contradiction judge runs per sweep (its own budget). */
  getAnnotationContradictionsMaxPerSweep?: () => number;
  log: Logger;
  idGen?: () => string;
}

export interface CollisionSweepPassResult {
  fired: boolean;
  enqueued: number;
}

export async function runCollisionSweepPass(
  deps: CollisionSweepDeps,
): Promise<CollisionSweepPassResult> {
  const now = deps.clock();
  const cadenceMs = Math.max(1, deps.getCadenceHours()) * 3_600_000;
  const lastRaw = getCognitionEngineState(deps.db, COGNITION_COLLISION_LAST_RUN_KEY);
  const last = lastRaw === null ? 0 : Number(lastRaw);
  if (Number.isFinite(last) && now - last < cadenceMs) return { fired: false, enqueued: 0 };

  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  let enqueued = 0;
  if (deps.getLoopCollisionsEnabled?.() ?? true) {
    const maxPerSweep = Math.max(1, deps.getMaxPerSweep());
    const candidates = findCollisionCandidates(deps.db, {
      limit: maxPerSweep,
      selfPersonId: deps.getSelfPersonId(),
    });
    for (const c of candidates) {
      await deps.writeGate.enqueueCognitionRun(
        {
          id: `run_${idGen()}`,
          kind: "synthesis",
          payload: { focus: "collision", loopIds: c.loopIds, matchedBy: c.matchedBy },
          dedupeKey: synthesisCollisionDedupeKey(collisionDedupeSuffix(c.loopIds)),
        },
        now,
      );
      enqueued += 1;
    }

    // Time-interval collisions fill whatever budget the loop joins left —
    // loop joins first (they carry importance ranking; time pairs are ranked
    // only by soonness), one shared per-sweep cap.
    const timeCandidates =
      enqueued < maxPerSweep
        ? findTemporalAnnotationCollisionCandidates(deps.db, {
            limit: maxPerSweep - enqueued,
            now,
            horizonDays: Math.max(1, deps.getTimeHorizonDays()),
          })
        : [];
    for (const c of timeCandidates) {
      await deps.writeGate.enqueueCognitionRun(
        {
          id: `run_${idGen()}`,
          kind: "synthesis",
          payload: {
            focus: "collision",
            temporalAnnotationIds: c.temporalAnnotationIds,
            matchedBy: c.matchedBy,
          },
          dedupeKey: synthesisCollisionDedupeKey(collisionDedupeSuffix(c.temporalAnnotationIds)),
        },
        now,
      );
      enqueued += 1;
    }
  }

  // Annotation contradictions ride their own budget — they repair the memory
  // tier, not the loop store, so a busy loop-collision day must not starve
  // them (and vice versa). The completed-run memory in the finder keeps a
  // settled false positive from being re-paid every sweep.
  if (deps.getAnnotationContradictionsEnabled?.() ?? false) {
    const annoMax = Math.max(1, deps.getAnnotationContradictionsMaxPerSweep?.() ?? 2);
    for (const c of findAnnotationContradictionCandidates(deps.db, { max: annoMax })) {
      await deps.writeGate.enqueueCognitionRun(
        {
          id: `run_${idGen()}`,
          kind: "synthesis",
          payload: {
            focus: "annotation-contradiction",
            annotationIds: c.annotationIds,
            store: c.store,
          },
          dedupeKey: synthesisAnnotationContradictionDedupeKey(
            collisionDedupeSuffix(c.annotationIds),
          ),
        },
        now,
      );
      enqueued += 1;
    }
  }
  // Marker LAST so a crash replays; the per-candidate dedupe keys fold.
  await deps.writeGate.setCognitionEngineState(COGNITION_COLLISION_LAST_RUN_KEY, String(now));
  if (enqueued > 0) deps.log.info(`collision sweep enqueued ${enqueued} judge run(s)`);
  return { fired: true, enqueued };
}
