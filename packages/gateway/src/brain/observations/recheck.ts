// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The morning recheck: decides which open observations ship in today's brief.
 *
 * Deterministic steps first, then judgement:
 *   1. expire observations whose window has ended;
 *   2. drop observations whose evidence went stale or disappeared, or whose
 *      quoted claim no longer appears in the document it quotes;
 *   3. drop observations whose related loops have all resolved;
 *   4. rescore the rest with the decision model, with what happened since
 *      they were noted, and hold or drop by the salience policy;
 *   5. check the survivors' claims with the entailment verifier.
 * The survivors, ranked, become the day's item list. Every judgement fails
 * open: an unavailable decision or verifier never hides an observation.
 */

import { randomUUID } from "node:crypto";
import { raceAbort } from "../decision-call.js";
import { captureOwnerDecisionPayload, type DecisionPayloadCapture } from "../decision-payload.js";
import { isKnowledgeEvidenceReadable } from "../knowledge/storage-source-fence.js";
import { observationEvidenceContext } from "../observation-evidence-context.js";
import { containsNormalizedForContent } from "../quote-match.js";
import { listOpenObservations } from "../storage/observations.js";
import { cognitionSpendDay } from "../storage/spend.js";
import {
  compareSalience,
  judgeSalience,
  OBSERVATION_SALIENCE_RUBRIC,
  salienceInterestQuery,
  salienceVerdict,
  type SalienceSubject,
  type SalienceThresholds,
} from "./salience.js";
import type { DecisionCapability, EntailCapability, Logger } from "@omnesis/core";
import type { CognitionDecisionRecord } from "../storage/decisions.js";
import type {
  ObservationClaim,
  ObservationCloseReason,
  ObservationRow,
  ObservationScores,
} from "../storage/types.js";
import type { ObservationTransition } from "../storage/observations.js";
import type { InterestLookup } from "../interest/engine.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** The writes the recheck performs; the write gate implements them. */
export interface ObservationRecheckWrites {
  expireObservations(now: number): Promise<string[]>;
  transitionObservation(
    id: string,
    transition: ObservationTransition,
    now: number,
  ): Promise<boolean>;
  recordObservationScores(id: string, scores: ObservationScores, now: number): Promise<boolean>;
  recordObservationClaims(
    id: string,
    claims: readonly ObservationClaim[],
    now: number,
  ): Promise<boolean>;
  replaceMorningBriefItems(
    day: string,
    runId: string,
    observationIds: readonly string[],
  ): Promise<boolean>;
  recordCognitionDecision(record: CognitionDecisionRecord): Promise<void>;
}

export interface ObservationRecheckDeps {
  db: Db;
  writes: ObservationRecheckWrites;
  getDecision: () => DecisionCapability | null;
  /** Records decision tokens under the salience spend mechanism. */
  recordSpend: (modelId: string, inputTokens: number) => Promise<void>;
  getEntailmentVerifier?: (signal?: AbortSignal) => Promise<EntailCapability | null>;
  thresholds: () => SalienceThresholds;
  /** The owner's past reactions, shown to the salience gate. Omitted, it judges without them. */
  interest?: InterestLookup;
  clock: () => number;
  log: Logger;
}

export interface RecheckResult {
  /** Observations chosen for today's brief, ranked. */
  shipped: ObservationRow[];
  held: string[];
  dropped: Array<{ id: string; reason: ObservationCloseReason }>;
}

const VERIFIER_TIMEOUT_MS = 45_000;

/** Titles, sources and dates of the cited documents, for the decision state. */
export function observationSources(
  db: Db,
  citations: readonly string[],
): SalienceSubject["sources"] {
  const statement = db.prepare<
    [string],
    { title: string; source_id: string; source_updated_at: string | null }
  >("SELECT title, source_id, source_updated_at FROM documents WHERE id = ?");
  return citations.slice(0, 8).flatMap((id) => {
    const row = statement.get(id);
    return row
      ? [{ title: row.title.slice(0, 200), source: row.source_id, date: row.source_updated_at }]
      : [];
  });
}

/** What happened to an observation's loops and sources after it was noted. */
export function sinceNoted(db: Db, observation: ObservationRow): string[] {
  const lines: string[] = [];
  for (const loopId of observation.relatedLoopIds) {
    const loop = db
      .prepare<
        [string],
        { title: string; state: string; last_update: number }
      >("SELECT title, state, last_update FROM open_loops WHERE id = ?")
      .get(loopId);
    if (!loop) {
      lines.push(`Related loop ${loopId} no longer exists.`);
      continue;
    }
    for (const entry of db
      .prepare<
        [string, number],
        { at: number; note: string }
      >("SELECT at, note FROM open_loop_ledger WHERE loop_id = ? AND at > ? ORDER BY seq DESC LIMIT 5")
      .all(loopId, observation.createdAt))
      lines.push(
        `${new Date(entry.at).toISOString()} loop "${loop.title}": ${entry.note.slice(0, 300)}`,
      );
    if (loop.last_update > observation.createdAt)
      lines.push(`Loop "${loop.title}" is now ${loop.state}.`);
  }
  return lines.slice(0, 12);
}

function evidenceGone(db: Db, observation: ObservationRow): boolean {
  return observation.citations.some(
    (id) =>
      !isKnowledgeEvidenceReadable(db, id) ||
      db.prepare("SELECT 1 FROM documents WHERE id = ?").get(id) === undefined,
  );
}

/**
 * A claim whose quote is gone from its document after an edit no longer has
 * the evidence it was noted on. The synthesis node mirrors citations only as
 * context, so this is the check that notices an edited source.
 */
function claimQuoteGone(db: Db, observation: ObservationRow): boolean {
  const statement = db.prepare<[string], { content: string | null; content_hash: string }>(
    "SELECT content, content_hash FROM documents WHERE id = ?",
  );
  return observation.claims.some((claim) => {
    const doc = statement.get(claim.docId);
    return !doc || !containsNormalizedForContent(doc.content_hash, doc.content ?? "", claim.quote);
  });
}

function nodeStale(db: Db, observationId: string): boolean {
  const row = db
    .prepare<
      [string],
      { validity: string }
    >("SELECT validity FROM knowledge_nodes WHERE kind='observation' AND owner_id = ?")
    .get(observationId);
  return row?.validity === "stale";
}

function loopsAllResolved(db: Db, observation: ObservationRow): boolean {
  if (observation.relatedLoopIds.length === 0) return false;
  return observation.relatedLoopIds.every((id) => {
    const loop = db
      .prepare<[string], { state: string }>("SELECT state FROM open_loops WHERE id = ?")
      .get(id);
    return !loop || loop.state === "done" || loop.state === "dismissed";
  });
}

async function verifyClaims(
  deps: ObservationRecheckDeps,
  observation: ObservationRow,
  now: number,
  signal: AbortSignal | undefined,
): Promise<ObservationClaim[] | "rejected" | null> {
  if (!deps.getEntailmentVerifier || observation.citations.length === 0) return null;
  let input: ReturnType<typeof observationEvidenceContext>;
  try {
    input = observationEvidenceContext(
      deps.db,
      {
        summary: observation.summary,
        why: observation.why,
        windowStart: observation.windowStart,
        relevantUntil: observation.relevantUntil,
      },
      observation.citations,
      now,
      observation.claims.map((c) => ({ evidenceDocId: c.docId, evidenceQuote: c.quote })),
    );
  } catch {
    // Unreadable or oversized evidence is the stale path's concern, not a verdict.
    return null;
  }
  if (!input) return null;
  const timeout = AbortSignal.timeout(VERIFIER_TIMEOUT_MS);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const verifier = await raceAbort(deps.getEntailmentVerifier(bounded), bounded);
    if (!verifier) return null;
    const verdict = await raceAbort(verifier.verify({ ...input, signal: bounded }), bounded);
    if (verdict.label !== "entailment") return "rejected";
    return observation.claims.map((claim) => ({ ...claim, verification: "entailed" as const }));
  } catch (err) {
    signal?.throwIfAborted();
    deps.log.warn(
      `observation ${observation.id}: verifier unavailable, shipping unverified (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

export async function recheckObservations(
  deps: ObservationRecheckDeps,
  input: { runId: string; day: string; signal?: AbortSignal },
): Promise<RecheckResult> {
  const now = deps.clock();
  const dropped: RecheckResult["dropped"] = [];
  for (const id of await deps.writes.expireObservations(now))
    dropped.push({ id, reason: "expired" });

  const drop = async (
    observation: ObservationRow,
    reason: ObservationCloseReason,
    scores?: ObservationScores,
  ) => {
    if (
      await deps.writes.transitionObservation(
        observation.id,
        { state: "dropped", reason, ...(scores ? { scores } : {}) },
        now,
      )
    )
      dropped.push({ id: observation.id, reason });
  };

  const decision = deps.getDecision();
  const thresholds = deps.thresholds();
  const candidates: ObservationRow[] = [];
  const held: string[] = [];
  for (const observation of listOpenObservations(deps.db)) {
    input.signal?.throwIfAborted();
    if (
      evidenceGone(deps.db, observation) ||
      claimQuoteGone(deps.db, observation) ||
      nodeStale(deps.db, observation.id)
    ) {
      await drop(observation, "stale");
      continue;
    }
    if (loopsAllResolved(deps.db, observation)) {
      await drop(observation, "superseded");
      continue;
    }
    // Not open yet: it stays live, unjudged, for the brief of the day its
    // window opens. Shipping it now would close it before it matters.
    if (observation.windowStart !== null && cognitionSpendDay(observation.windowStart) > input.day)
      continue;
    let scores = observation.scores ?? observation.notedScores;
    if (decision) {
      const payloadCapture = salienceDecisionCapture(deps.db, observation);
      const ownerInterest = deps.interest
        ? await deps.interest.lookup({ text: salienceInterestQuery(observation) })
        : null;
      const judged = await judgeSalience(
        decision,
        {
          summary: observation.summary,
          why: observation.why,
          userAuthored: observation.userAuthored,
          notedAt: observation.createdAt,
          windowStart: observation.windowStart,
          relevantUntil: observation.relevantUntil,
          sources: observationSources(deps.db, observation.citations),
          sinceNoted: sinceNoted(deps.db, observation),
          ownerInterest,
        },
        now,
        {
          recordSpend: deps.recordSpend,
          log: deps.log,
          signal: input.signal,
        },
      );
      await recordSalienceDecision(
        { recordDecision: (record) => deps.writes.recordCognitionDecision(record) },
        {
          runId: input.runId,
          observation,
          judged,
          verdict: salienceVerdict(judged.scores, thresholds),
          threshold: thresholds.minConsequence,
          lane: "recheck",
          now,
          payloadCapture,
        },
      );
      if (judged.scores.consequence !== null) scores = judged.scores;
    }
    const verdict = salienceVerdict(scores, thresholds);
    if (verdict === "already_known") {
      await drop(observation, "already_known", scores ?? undefined);
      continue;
    }
    if (verdict === "hold") {
      if (
        await deps.writes.transitionObservation(
          observation.id,
          { state: "held", reason: "below_bar", scores },
          now,
        )
      )
        held.push(observation.id);
      continue;
    }
    if (scores) await deps.writes.recordObservationScores(observation.id, scores, now);
    const verified = await verifyClaims(deps, observation, now, input.signal);
    if (verified === "rejected") {
      await drop(observation, "unsupported", scores ?? undefined);
      continue;
    }
    if (verified) await deps.writes.recordObservationClaims(observation.id, verified, now);
    candidates.push({ ...observation, scores, claims: verified ?? observation.claims });
  }
  candidates.sort(compareSalience);
  await deps.writes.replaceMorningBriefItems(
    input.day,
    input.runId,
    candidates.map((c) => c.id),
  );
  return { shipped: candidates, held, dropped };
}

/**
 * The subjects a salience judgement reads: the observation's knowledge node
 * and its cited documents. Captured before the judgement reads them.
 */
export function salienceDecisionCapture(
  db: Database.Database,
  observation: Pick<ObservationRow, "id" | "citations">,
): DecisionPayloadCapture | undefined {
  return (
    captureOwnerDecisionPayload(
      db,
      { kind: "observation", id: observation.id },
      observation.citations,
    ) ?? undefined
  );
}

/**
 * Ledger one salience judgement, anchored to the observation's first cited
 * document. An observation that cites none (one the user wrote) leaves the
 * row's anchors empty; its request and answer then live only in the payload
 * store, fenced by the observation's node.
 */
export async function recordSalienceDecision(
  deps: { recordDecision: (record: CognitionDecisionRecord) => Promise<void> },
  input: {
    runId: string;
    observation: Pick<ObservationRow, "id" | "citations">;
    judged: Awaited<ReturnType<typeof judgeSalience>>;
    verdict: ReturnType<typeof salienceVerdict>;
    threshold: number;
    lane: "note" | "recheck";
    now: number;
    payloadCapture?: DecisionPayloadCapture;
  },
): Promise<void> {
  const documentId = input.observation.citations[0] ?? null;
  const { judgement } = input.judged;
  await deps.recordDecision({
    id: `decision_${randomUUID()}`,
    runId: input.runId,
    documentId,
    subjectDocumentId: documentId,
    purpose: "observation-salience",
    lane: input.lane,
    rubricVersion: OBSERVATION_SALIENCE_RUBRIC,
    contentHash: null,
    requestedModelId: judgement.modelId,
    modelId: judgement.score === null ? null : judgement.modelId,
    requestJson: documentId === null ? null : judgement.requestJson,
    responseJson: documentId === null ? null : judgement.responseJson,
    ...(input.payloadCapture
      ? {
          payloadCapture: input.payloadCapture,
          payload: {
            requestJson: judgement.requestJson,
            responseJson: judgement.responseJson,
            error: judgement.error,
          },
        }
      : {}),
    score: judgement.score,
    threshold: input.threshold,
    verdict: judgement.score === null ? "unavailable" : input.verdict === "ship" ? "pass" : "skip",
    error: judgement.error,
    reusedFrom: null,
    recordId: input.observation.id,
    enforced: true,
    latencyMs: judgement.latencyMs,
    inputTokens: judgement.inputTokens,
    createdAt: input.now,
  });
}
