// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The provenance-recheck sweep — the teeth on consumption provenance. When
 * an annotation PRIOR is invalidated or superseded (both stamp
 * `invalidated_at`), the briefs/loops built on it must not keep resting
 * silently on a dead belief: each pass scans the deaths since its watermark
 * (`cognition_consumption_edges` joined to the annotation stores), collects
 * the LIVE dependents, and enqueues one `feedback` run per dependent with
 * the provenance-recheck payload variant — the run re-examines whether the
 * dependent still holds. Hard retracts are out of scope by design: the
 * retracting run is an agent repairing its own beliefs and their fallout.
 *
 * Stampede discipline, four layers:
 *   - the dedupe key is per DEPENDENT (`provenanceRecheckDedupeKey`), so one
 *     dead prior with N dependents mints at most N runs, and N dead priors
 *     of ONE dependent fold into a single pending run (the prompt re-derives
 *     the dead set at claim time, so a fold loses nothing). Only CLAIMABLE
 *     pending rows count as coverage: a pending row at the drainer's
 *     attempts cap is crash residue it can never claim, so the sweep cancels
 *     it (freeing its dedupe key) instead of letting it shadow its dependent
 *     forever — exactly as the re-verification sweep does;
 *   - claim-time coverage extends that fold ACROSS a run's lifetime. The
 *     prompt re-derives the dead-prior set when the run is CLAIMED, not when
 *     it was enqueued, so a recheck of dependent D claimed at C already
 *     re-examined every death of D's priors at or before C — whatever
 *     enqueued it. Runs drain strictly serialized, so C routinely lands well
 *     after the enqueue and sweeps a whole burst of deaths with it. Each
 *     death at `T` is therefore skipped when D's latest recheck claim is at
 *     or after `T` — read as `cognition_runs.last_attempt_at`, which is the
 *     claim time (a claim is the only attempt this queue makes, and the claim
 *     statement is the column's only writer). Without this the pass after a
 *     run settles re-enqueues an identical recheck for deaths that run
 *     already covered. A cancelled residue row's claim does not count — it
 *     never finished and can never claim again;
 *   - the per-pass budget is {@link PROVENANCE_RECHECK_MAX_PER_PASS} runs —
 *     like the re-verification sweep, small on purpose: non-daily runs
 *     execute strictly serialized in the run drainer, so a large batch would
 *     monopolize the agent lane. The budget is a SOFT cap checked only at
 *     `invalidated_at`-group boundaries: deaths sharing one timestamp (the
 *     normal shape — one dead prior mints same-stamp deaths for all its
 *     dependents) are enqueued as a whole group or not started, never split.
 *     A group is therefore either entirely ahead of the watermark or
 *     entirely behind it, so completed rechecks can never be re-enqueued by
 *     a rescan of a half-processed timestamp. The overshoot is bounded by
 *     one group (the dependents of the priors that died in a single stamp);
 *   - when the soft cap stops the pass, the watermark holds at the last
 *     fully-handled group and the rest re-surface next pass.
 *
 * The watermark is set to "now" on the first ENABLED pass, and re-anchored
 * to "now" on every DISABLED tick ({@link reanchorProvenanceRecheckWatermark}),
 * so there is never a backfill of deaths from a window when the knob was off
 * — retroactively rechecking history would stampede the queue.
 *
 * The runs this enqueues carry `kind: "feedback"`, because they do the same
 * work a feedback run does — re-grounding a loop or brief whose evidence
 * moved. They are claimed at the BACKLOG rank rather than the reactive one:
 * nothing is waiting on a recheck, a sweep enqueues them rather than a person,
 * and the re-verification lane can produce them in bulk, so at the reactive
 * rank a large death set would hold the tier a dismissed brief needs. The
 * claim query reads their dedupe prefix to tell them apart — see
 * `CLAIM_KIND_RANK_SQL`. The per-pass budget below remains per TICK, which now
 * bounds how fast the set is worked through rather than what it delays.
 */

import {
  PROVENANCE_RECHECK_DEDUPE_PREFIX,
  provenanceRecheckDedupeKey,
  type CognitionProvenanceRecheckPayload,
} from "../run-payloads.js";
import {
  getCognitionEngineState,
  COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY,
} from "../storage/engine-state.js";
import { listDeadPriorDependents } from "../storage/consumption-edges.js";
import {
  DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
  listCognitionRunsByDedupePrefix,
} from "../storage/run-queue.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { DailyEnqueuerWriteOps } from "./daily-enqueuer.js";
import type { Clock } from "../storage/types.js";

type Db = Database.Database;

/**
 * The soft per-pass run budget. Derived, not an operator knob (the knob is
 * the single `brain.provenanceRecheck.enabled` switch): small enough that a
 * burst of prior deaths drips through the serialized drainer lane over a few
 * passes instead of parking it, and small enough to bound a lane that claims
 * at the reactive rank (see the module doc). Soft:
 * checked only at `invalidated_at`-group boundaries, so one pass may
 * overshoot by the dependents of a single timestamp group.
 */
export const PROVENANCE_RECHECK_MAX_PER_PASS = 4;

/** The `brain.provenanceRecheck` slice the sweep reads live per pass. */
export interface ProvenanceRecheckSettings {
  enabled: boolean;
}

/** The write-gate slice the sweep mutates through. */
export interface ProvenanceRecheckSweepWriteOps extends DailyEnqueuerWriteOps {
  cancelPendingCognitionRuns(dedupeKeys: string[]): Promise<number>;
}

export interface ProvenanceRecheckSweepDeps {
  db: Db;
  writeGate: ProvenanceRecheckSweepWriteOps;
  clock: Clock;
  log: Logger;
  idGen?: () => string;
}

export interface ProvenanceRecheckSweepPassResult {
  /** False = nothing to do (first-pass watermark init, or no deaths). */
  fired: boolean;
  /** Recheck runs enqueued (or folded into a pending row) this pass. */
  enqueued: number;
}

/** One pass. Called from the rhythm task each tick while the knob is on. */
export async function runProvenanceRecheckSweepPass(
  deps: ProvenanceRecheckSweepDeps,
): Promise<ProvenanceRecheckSweepPassResult> {
  const now = deps.clock();
  const raw = getCognitionEngineState(deps.db, COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY);
  const watermark = raw === null ? null : Number(raw);
  if (watermark === null || !Number.isFinite(watermark)) {
    // First enabled pass: anchor the watermark at now — deaths from before
    // the knob was turned on are deliberately not back-processed.
    await deps.writeGate.setCognitionEngineState(
      COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY,
      String(now),
    );
    return { fired: false, enqueued: 0 };
  }

  const deaths = listDeadPriorDependents(deps.db, { sinceExclusive: watermark, until: now });
  if (deaths.length === 0) return { fired: false, enqueued: 0 };

  // Run hygiene + coverage, read once per pass over every recheck run.
  //
  // A dependent already covered by a CLAIMABLE pending recheck folds for free
  // — its prompt reads the dead set at claim time, so skipping it here loses
  // nothing and its deaths count as handled for the watermark. A pending row
  // at the drainer's attempts cap is crash residue it can never claim again,
  // so it is cancelled outright — freeing its pending-unique dedupe key so a
  // later death of one of the dependent's priors enqueues a fresh claimable
  // run — exactly as the re-verification sweep treats its residue.
  //
  // Already-claimed runs (in flight or settled) carry the second coverage
  // layer. A recheck's prompt re-derives the dead-prior set at CLAIM time, so
  // its claim — `lastAttemptAt`, the only attempt this queue makes — is the
  // clock of what it examined: every death at or before it was seen. The
  // residue rows just cancelled are excluded from that clock: their claim
  // never finished, and the row is gone, so nothing will re-derive those
  // deaths.
  const runs = listCognitionRunsByDedupePrefix(deps.db, PROVENANCE_RECHECK_DEDUPE_PREFIX);
  const isResidue = (r: (typeof runs)[number]): boolean =>
    r.status === "pending" && r.attempts >= DEFAULT_COGNITION_RUN_MAX_ATTEMPTS;
  const exhaustedKeys = runs.filter(isResidue).map((r) => r.dedupeKey);
  if (exhaustedKeys.length > 0) {
    await deps.writeGate.cancelPendingCognitionRuns(exhaustedKeys);
    deps.log.info(
      `provenance recheck cancelled ${exhaustedKeys.length} attempts-exhausted pending run(s)`,
    );
  }
  const pendingKeys = new Set(
    runs.filter((r) => r.status === "pending" && !isResidue(r)).map((r) => r.dedupeKey),
  );
  // Per dependent, the LATEST claim — the newest re-derivation of its dead set.
  const claimedAtByKey = new Map<string, number>();
  for (const r of runs) {
    if (r.lastAttemptAt === null || isResidue(r)) continue;
    const prev = claimedAtByKey.get(r.dedupeKey);
    if (prev === undefined || r.lastAttemptAt > prev)
      claimedAtByKey.set(r.dedupeKey, r.lastAttemptAt);
  }

  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  const enqueuedKeys = new Set<string>();
  let enqueued = 0;
  // Deaths arrive oldest-first and are consumed in whole `invalidated_at`
  // groups: the soft cap is checked only BEFORE a group starts, and a started
  // group always finishes (the bounded overshoot — see the module doc). The
  // watermark therefore always lands exactly on a group boundary, so a later
  // rescan can never re-see a half-processed timestamp.
  let advancedTo = watermark;
  let capped = false;
  let i = 0;
  while (i < deaths.length) {
    if (enqueued >= PROVENANCE_RECHECK_MAX_PER_PASS) {
      // The watermark holds at the last fully-handled group; the remaining
      // groups re-surface next pass.
      capped = true;
      break;
    }
    const stamp = deaths[i]!.invalidatedAt;
    for (; i < deaths.length && deaths[i]!.invalidatedAt === stamp; i += 1) {
      const death = deaths[i]!;
      const key = provenanceRecheckDedupeKey(death.dependentKind, death.dependentId);
      if (pendingKeys.has(key) || enqueuedKeys.has(key)) continue;
      // Claimed at or after the death → that claim already re-derived it.
      const claimedAt = claimedAtByKey.get(key);
      if (claimedAt !== undefined && claimedAt >= death.invalidatedAt) continue;
      const payload: CognitionProvenanceRecheckPayload = {
        recheckDependentKind: death.dependentKind,
        recheckDependentId: death.dependentId,
      };
      await deps.writeGate.enqueueCognitionRun(
        { id: `run_${idGen()}`, kind: "feedback", payload, dedupeKey: key },
        now,
      );
      enqueuedKeys.add(key);
      enqueued += 1;
    }
    advancedTo = stamp;
  }

  if (advancedTo > watermark) {
    await deps.writeGate.setCognitionEngineState(
      COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY,
      String(advancedTo),
    );
  }
  if (enqueued > 0) {
    deps.log.info(
      `provenance recheck enqueued ${enqueued} run(s) for dependents of dead priors${capped ? " (per-pass cap hit; remainder next pass)" : ""}`,
    );
  }
  return { fired: true, enqueued };
}

/**
 * Idempotent watermark re-anchor, called by the rhythm task on every
 * DISABLED tick. While the knob is off an EXISTING watermark keeps sliding
 * up to "now", so deaths landing in the off window are already behind it
 * when the knob comes back on — re-enabling behaves like the first-ever
 * enabled pass (anchor at the enable moment, no backfill). A never-enabled
 * install has no watermark row and is left untouched, so the feature costs
 * no writes until first used.
 */
export async function reanchorProvenanceRecheckWatermark(
  deps: Pick<ProvenanceRecheckSweepDeps, "db" | "writeGate" | "clock">,
): Promise<void> {
  const raw = getCognitionEngineState(deps.db, COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY);
  if (raw === null) return;
  const now = deps.clock();
  const prev = Number(raw);
  if (Number.isFinite(prev) && prev >= now) return;
  await deps.writeGate.setCognitionEngineState(
    COGNITION_PROVENANCE_RECHECK_WATERMARK_KEY,
    String(now),
  );
}
