// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The decay engine's sweep — schedules agent status-checks on stale
 * open loops with exponential back-off, so loops whose relevant data
 * was filtered out (or dried up) still get revisited, demoted, and
 * eventually deleted by the agent's judgment. Never a blind reaper: the
 * sweep only ENQUEUES checks; keep/demote/delete is always the agent.
 *
 * Scheduling shape: the check for a loop is enqueued as a future-dated
 * `time_based` run (`notBefore` = the due time — the run queue's own
 * `next_attempt_at` gate delivers it), with one fold key per loop so at
 * most one pending check exists per loop and a rescheduling sweep just
 * folds the schedule forward.
 *
 * Back-off: `base·2^n` after the loop's `last_update`, capped, where
 * `n` = `decay_check_count` (checks kept since the loop was last
 * reinforced; see `storage/open-loops.ts`). A kept check increments the
 * counter (the next check is twice as far out); any reinforcement
 * resets it.
 *
 * Sweeps are gated on the decay dirty-mark, never kick-chained: every
 * loop mutation bumps `decay_dirty_version`, and the sweep does zero
 * work while the version it last completed against still matches. The
 * version is read BEFORE the scan and recorded after — a mutation
 * landing mid-sweep leaves dirty > swept, so the next tick sweeps
 * again (the DirtyMarks OCC shape).
 */

import {
  decayCheckRunDedupeKey,
  DECAY_CHECK_DEDUPE_PREFIX,
  type CognitionDecayCheckRunPayload,
} from "../run-payloads.js";
import {
  COGNITION_DECAY_SWEPT_VERSION_KEY,
  readCognitionDecayDirtyVersion,
  readCognitionDecaySweptVersion,
} from "../storage/engine-state.js";
import { listDecayCandidateLoops, type DecayCandidateLoop } from "../storage/open-loops.js";
import { deadlineDueDay } from "../ranking.js";
import { listPendingCognitionDedupeKeys } from "../storage/run-queue.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { EnqueueCognitionRunInput, EnqueueCognitionRunResult } from "../storage/run-queue.js";
import type { Clock } from "../storage/types.js";

type Db = Database.Database;

export interface DecayBackoffConfig {
  /** Delay before a fresh (or freshly reinforced) UNDATED loop's first check. */
  backoffBaseMs: number;
  /** Ceiling on the check interval (~1 month by default). */
  backoffCapMs: number;
  /**
   * Dense floor for a DATED loop: the minimum interval near/past its deadline.
   * A loop at or past its deadline is re-checked on this floor and NEVER backs
   * off toward auto-deletion.
   */
  datedFloorMs: number;
  /**
   * Fraction (0-1) of the time remaining to a future deadline to wait before
   * the next check — value-of-information spacing, so the agent polls more
   * densely as the deadline nears.
   */
  datedFraction: number;
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0;
}

/**
 * When the next status-check for a loop is due — the anti-Zeigarnik split.
 *
 * - **Dated, pre-deadline** → a tension ramp: wait `datedFraction ×
 *   time-remaining`, floored at `datedFloorMs` and capped, so checks bunch up
 *   as the deadline nears. Importance shortens the interval (an important loop
 *   is revisited more persistently).
 * - **Dated, at/past deadline** → the dense `datedFloorMs` floor; an overdue
 *   loop NEVER widens toward auto-deletion — the agent owns deletion.
 * - **Undated** → keep fade-and-forget (`base·2^count`), but importance
 *   stretches the curve so an important loop decays slower.
 *
 * Pure — tests compress a month to milliseconds through the config.
 */
export function nextDecayCheckAt(
  loop: Pick<DecayCandidateLoop, "lastUpdate" | "decayCheckCount" | "importance" | "deadline">,
  cfg: DecayBackoffConfig,
  now: number,
): number {
  // Importance in [1, 2] as a divisor: importance 1 halves the interval (more
  // persistent revisits), importance 0 leaves it as-is (fades on schedule).
  const importanceScale = 1 + clamp01(loop.importance);
  const dueDay = deadlineDueDay(loop.deadline);
  if (dueDay !== null) {
    // Deadline = end of the loop's LOCAL due day (no `Z` → parsed local).
    const deadlineMs = Date.parse(`${dueDay}T23:59:59.999`);
    const remaining = Number.isNaN(deadlineMs) ? 0 : deadlineMs - now;
    if (remaining > 0) {
      const interval = Math.min(
        cfg.backoffCapMs,
        Math.max(cfg.datedFloorMs, (remaining * cfg.datedFraction) / importanceScale),
      );
      return now + interval;
    }
    return now + cfg.datedFloorMs;
  }
  const backoff = Math.min(
    cfg.backoffCapMs,
    (cfg.backoffBaseMs * 2 ** loop.decayCheckCount) / importanceScale,
  );
  return loop.lastUpdate + backoff;
}

/** The write-gate slice the sweep mutates through. */
export interface DecaySweepWriteOps {
  enqueueCognitionRun(
    input: EnqueueCognitionRunInput,
    now: number,
  ): Promise<EnqueueCognitionRunResult>;
  cancelPendingCognitionRuns(dedupeKeys: string[]): Promise<number>;
  setCognitionEngineState(key: string, value: string): Promise<void>;
}

export interface DecaySweepDeps {
  db: Db;
  writeGate: DecaySweepWriteOps;
  clock: Clock;
  getBackoff: () => DecayBackoffConfig;
  log: Logger;
  idGen?: () => string;
}

export interface DecaySweepPassResult {
  /** False = dirty-mark unchanged; the pass did zero work. */
  swept: boolean;
  /** Checks enqueued or rescheduled (folded) this pass. */
  scheduled: number;
  /** Pending checks retracted (loop no longer open). */
  cancelled: number;
}

/** One dirty-gated pass. Called from the rhythm task each tick. */
export async function runDecaySweepPass(deps: DecaySweepDeps): Promise<DecaySweepPassResult> {
  const dirtyVersion = readCognitionDecayDirtyVersion(deps.db);
  if (dirtyVersion === readCognitionDecaySweptVersion(deps.db)) {
    return { swept: false, scheduled: 0, cancelled: 0 };
  }

  const now = deps.clock();
  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  const cfg = deps.getBackoff();
  const loops = listDecayCandidateLoops(deps.db);

  let scheduled = 0;
  for (const loop of loops) {
    const payload: CognitionDecayCheckRunPayload = { decayCheckLoopId: loop.id };
    await deps.writeGate.enqueueCognitionRun(
      {
        id: `run_${idGen()}`,
        kind: "time_based",
        payload,
        notBefore: nextDecayCheckAt(loop, cfg, now),
        dedupeKey: decayCheckRunDedupeKey(loop.id),
      },
      now,
    );
    scheduled += 1;
  }

  // Retract pending checks for loops that are no longer open (closed,
  // deleted, privacy-cascaded) — the run would only burn a model call to
  // discover there is nothing to check.
  const eligibleKeys = new Set(loops.map((l) => decayCheckRunDedupeKey(l.id)));
  const staleKeys = listPendingCognitionDedupeKeys(deps.db, DECAY_CHECK_DEDUPE_PREFIX).filter(
    (key) => !eligibleKeys.has(key),
  );
  const cancelled =
    staleKeys.length > 0 ? await deps.writeGate.cancelPendingCognitionRuns(staleKeys) : 0;

  await deps.writeGate.setCognitionEngineState(
    COGNITION_DECAY_SWEPT_VERSION_KEY,
    String(dirtyVersion),
  );
  if (scheduled > 0 || cancelled > 0) {
    deps.log.info(`decay sweep: ${scheduled} check(s) scheduled, ${cancelled} retracted`);
  }
  return { swept: true, scheduled, cancelled };
}
