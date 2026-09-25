// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The re-verification sweep — the PULL half of annotation correctness
 * (the entailment gate at the tool boundary is the push half). One pass
 * per day selects LIVE annotations whose entailment verdict is stale or
 * missing (`last_verified_at IS NULL OR < now - interval`), oldest-verified
 * first with never-checked rows leading and the SELF person's facts ahead of
 * everything (they are injected into every run as self-memory, so they are
 * the highest-leverage priors to keep honest), and enqueues them as
 * `verification` agent runs — batched, one store per run. Never a blind
 * re-stamper: the sweep only ENQUEUES; re-affirm / weaken / supersede /
 * retract is always the agent's judgment against the re-read evidence.
 *
 * Duplicate discipline, two layers:
 *   - annotations already named by a CLAIMABLE pending verification run are
 *     skipped at selection (parsed out of the surviving `verify:` dedupe
 *     keys), so a due-set that shifts between passes never mints overlapping
 *     runs. Only rows still under the attempts cap count: a pending row whose
 *     attempts hit the cap without settling is crash residue the drainer can
 *     never claim again, so the sweep cancels it outright (freeing its
 *     pending-unique dedupe key) and lets its annotations return to the due
 *     pool the same pass;
 *   - each run's dedupe key is the sorted id batch
 *     (`verificationRunDedupeKey`), so an identically re-detected batch
 *     folds into the pending row rather than duplicating it.
 *
 * Throughput is `maxPerSweep × batchSize` annotations per day: enough to work
 * an annotation store through its `intervalDays` freshness cycle, while
 * staying a dozen runs a day against a drainer that executes non-daily runs
 * strictly serialized. Raising it far past that monopolizes the agent lane.
 * All three are operator knobs (`brain.reverification`).
 *
 * Note the coupling: each weakened or superseded annotation is a dead prior,
 * and every dead prior mints a provenance-recheck run per live dependent. So
 * this budget sets the feedstock for that lane as well as its own cost.
 */

import { verificationRunDedupeKey, VERIFICATION_DEDUPE_PREFIX } from "../run-payloads.js";
import {
  getCognitionEngineState,
  COGNITION_REVERIFICATION_LAST_RUN_KEY,
} from "../storage/engine-state.js";
import { listDueVerificationDocAnnotations } from "../storage/annotations.js";
import { listDueVerificationPersonAnnotations } from "../storage/person-annotations.js";
import {
  DEFAULT_COGNITION_RUN_MAX_ATTEMPTS,
  listPendingCognitionRunsByDedupePrefix,
} from "../storage/run-queue.js";
import type Database from "better-sqlite3";
import type { Logger } from "@omnesis/core";
import type { CognitionVerificationRunPayload } from "../run-payloads.js";
import type { DailyEnqueuerWriteOps } from "./daily-enqueuer.js";
import type { Clock } from "../storage/types.js";

type Db = Database.Database;

/** Minimum gap between sweep passes: one per day (the daily-rhythm anchor). */
export const REVERIFICATION_SWEEP_CADENCE_MS = 24 * 3_600_000;

/** The `brain.reverification` slice the sweep reads live per pass. */
export interface ReverificationSettings {
  enabled: boolean;
  /** Days after which a verification stamp counts as stale. */
  intervalDays: number;
  /** Max verification runs enqueued per pass. */
  maxPerSweep: number;
  /** Annotations per run (one store per run). */
  batchSize: number;
}

/** The write-gate slice the sweep mutates through. */
export interface ReverificationSweepWriteOps extends DailyEnqueuerWriteOps {
  cancelPendingCognitionRuns(dedupeKeys: string[]): Promise<number>;
}

export interface ReverificationSweepDeps {
  db: Db;
  writeGate: ReverificationSweepWriteOps;
  clock: Clock;
  /** Live settings slice (config is hot-reloadable). */
  getSettings: () => ReverificationSettings;
  log: Logger;
  idGen?: () => string;
}

export interface ReverificationSweepPassResult {
  /** False = within the daily cadence; the pass did zero work. */
  fired: boolean;
  /** Verification runs enqueued this pass. */
  enqueued: number;
}

interface DueCandidate {
  store: "doc" | "person";
  id: string;
  /** 0 = a self-person fact (front of the queue), 1 = everything else. */
  selfRank: number;
  lastVerifiedAt: number | null;
  createdAt: number;
}

/** Parse the `store:id` member pairs out of one `verify:` dedupe key. */
function verifyKeyMembers(key: string): string[] {
  const rest = key.slice(VERIFICATION_DEDUPE_PREFIX.length);
  const cut = rest.indexOf(":");
  if (cut <= 0) return [];
  const store = rest.slice(0, cut);
  return rest
    .slice(cut + 1)
    .split(",")
    .filter((id) => id.length > 0)
    .map((id) => `${store}:${id}`);
}

/** One daily-gated pass. Called from the rhythm task each tick. */
export async function runReverificationSweepPass(
  deps: ReverificationSweepDeps,
): Promise<ReverificationSweepPassResult> {
  const now = deps.clock();
  const lastRaw = getCognitionEngineState(deps.db, COGNITION_REVERIFICATION_LAST_RUN_KEY);
  const last = lastRaw === null ? 0 : Number(lastRaw);
  if (Number.isFinite(last) && now - last < REVERIFICATION_SWEEP_CADENCE_MS) {
    return { fired: false, enqueued: 0 };
  }

  const s = deps.getSettings();
  const cutoff = now - Math.max(1, s.intervalDays) * 86_400_000;
  const maxPerSweep = Math.max(1, s.maxPerSweep);
  const batchSize = Math.max(1, s.batchSize);
  // Pending-run hygiene + coverage. Only CLAIMABLE pending rows (attempts
  // under the drainer's cap) cover their member annotations: a row whose
  // attempts hit the cap without settling is crash residue (a process death
  // mid-claim) the drainer can never claim again, so counting it as coverage
  // would shadow its annotations from re-verification forever. The residue is
  // cancelled outright — freeing its pending-unique dedupe key — and its
  // still-due annotations re-enqueue below under a fresh claimable run.
  const pending = listPendingCognitionRunsByDedupePrefix(deps.db, VERIFICATION_DEDUPE_PREFIX);
  const exhaustedKeys = pending
    .filter((r) => r.attempts >= DEFAULT_COGNITION_RUN_MAX_ATTEMPTS)
    .map((r) => r.dedupeKey);
  if (exhaustedKeys.length > 0) {
    await deps.writeGate.cancelPendingCognitionRuns(exhaustedKeys);
    deps.log.info(
      `re-verification sweep cancelled ${exhaustedKeys.length} attempts-exhausted pending run(s)`,
    );
  }
  const covered = new Set<string>();
  for (const r of pending) {
    if (r.attempts < DEFAULT_COGNITION_RUN_MAX_ATTEMPTS) {
      for (const member of verifyKeyMembers(r.dedupeKey)) covered.add(member);
    }
  }
  // Over-fetch by the covered count so rows already riding a pending run
  // cannot starve this pass's budget.
  const fetchLimit = maxPerSweep * batchSize + covered.size;

  const candidates: DueCandidate[] = [];
  for (const r of listDueVerificationPersonAnnotations(deps.db, { cutoff, limit: fetchLimit })) {
    if (!covered.has(`person:${r.id}`)) {
      candidates.push({
        store: "person",
        id: r.id,
        selfRank: r.isSelf ? 0 : 1,
        lastVerifiedAt: r.lastVerifiedAt,
        createdAt: r.createdAt,
      });
    }
  }
  for (const r of listDueVerificationDocAnnotations(deps.db, { cutoff, limit: fetchLimit })) {
    if (!covered.has(`doc:${r.id}`)) {
      candidates.push({
        store: "doc",
        id: r.id,
        selfRank: 1,
        lastVerifiedAt: r.lastVerifiedAt,
        createdAt: r.createdAt,
      });
    }
  }
  // Global due order: self-person facts first, then oldest-verified across
  // both stores (never-checked rows lead), oldest-created as the tiebreak.
  candidates.sort(
    (a, b) =>
      a.selfRank - b.selfRank ||
      (a.lastVerifiedAt ?? 0) - (b.lastVerifiedAt ?? 0) ||
      a.createdAt - b.createdAt,
  );

  const idGen = deps.idGen ?? (() => crypto.randomUUID());
  let enqueued = 0;
  // Pack in due order: the head of the remaining list picks each batch's
  // store, and the batch fills with that store's next-due ids.
  while (candidates.length > 0 && enqueued < maxPerSweep) {
    const store = candidates[0]!.store;
    const ids: string[] = [];
    for (let i = 0; i < candidates.length && ids.length < batchSize; ) {
      if (candidates[i]!.store === store) {
        ids.push(candidates[i]!.id);
        candidates.splice(i, 1);
      } else {
        i += 1;
      }
    }
    const payload: CognitionVerificationRunPayload = { annotationIds: ids, store };
    await deps.writeGate.enqueueCognitionRun(
      {
        id: `run_${idGen()}`,
        kind: "verification",
        payload,
        dedupeKey: verificationRunDedupeKey(store, ids),
      },
      now,
    );
    enqueued += 1;
  }

  // Marker LAST so a crash replays; the dedupe keys + pending-coverage skip fold.
  await deps.writeGate.setCognitionEngineState(COGNITION_REVERIFICATION_LAST_RUN_KEY, String(now));
  if (enqueued > 0) deps.log.info(`re-verification sweep enqueued ${enqueued} run(s)`);
  return { fired: true, enqueued };
}
