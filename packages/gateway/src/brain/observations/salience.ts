// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Observation salience — the decision model as the morning brief's editor.
 *
 * Each observation is judged on three questions in one decision call:
 * whether the user already knows it, what missing it would cost, and when
 * acting on it matters. The decision model scores; a deterministic policy
 * decides whether the observation ships, holds or drops, so the ordering is
 * explicit and the thresholds tunable. An unavailable judgement fails open:
 * the observation ships, because a missing score is not evidence that it does
 * not matter.
 */

import { askScore, type ScoreJudgement } from "../decision-call.js";
import type { DecisionCapability, DecisionQuestion, DecisionRequest, Logger } from "@omnesis/core";

type DecisionScoreQuestion = Extract<DecisionQuestion, { type: "score" }>;
import type { ObservationScores } from "../storage/types.js";

export const OBSERVATION_SALIENCE_SPEND_MECHANISM = "observation-salience";
export const OBSERVATION_SALIENCE_RUBRIC = "observation-salience-v1";

/** Highest consequence level: money, legal, health or a hard commitment at stake. */
export const TOP_CONSEQUENCE = 4;
/** Highest timing level: acting today or tomorrow matters. */
export const TOP_TIMING = 3;

const CONSEQUENCE: DecisionScoreQuestion = {
  type: "score",
  instructions:
    "If the user never hears about this observation, what is the realistic cost to them? Judge the consequence of missing it, not how interesting it is.",
  criteria: [
    "Nothing: missing it changes nothing for the user.",
    "Minor: a small convenience or a nice-to-know detail.",
    "Moderate: wasted time, a missed opportunity, or a small avoidable cost.",
    "Serious: a missed commitment, a meaningful cost, or a problem for someone relying on the user.",
    "Severe: money, legal standing, health, travel or a hard deadline is at stake.",
  ],
};

const TIMING: DecisionScoreQuestion = {
  type: "score",
  instructions:
    "When does acting on this observation matter? Use the time window and any deadline in the state.",
  criteria: [
    "No deadline: it can wait indefinitely.",
    "This month: it matters within the next few weeks.",
    "This week: it matters within the next few days.",
    "Today or tomorrow: acting now matters.",
  ],
};

const ALREADY_KNOWN: DecisionScoreQuestion = {
  type: "score",
  instructions:
    "Would the user already know this without being told? The state says whether the user wrote the cited sources themselves and what they did after the observation was noted. Something the user wrote, sent, scheduled or handled is already known.",
  criteria: [
    "The user probably does not know this yet, or has not connected it.",
    "The user already knows this: they wrote it, did it, or were just told.",
  ],
};

export interface SalienceSubject {
  summary: string;
  why: string;
  userAuthored: boolean;
  notedAt: number;
  windowStart: number | null;
  relevantUntil: number | null;
  /** Titles, sources and dates of the cited documents. */
  sources: Array<{ title: string; source: string; date: string | null }>;
  /** What happened after the observation was noted (the morning recheck only). */
  sinceNoted?: string[];
}

export function buildSalienceRequest(subject: SalienceSubject, now: number): DecisionRequest {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    state: {
      now: iso(now),
      observation: subject.summary,
      whyItMatters: subject.why || null,
      notedAt: iso(subject.notedAt),
      windowStart: iso(subject.windowStart),
      relevantUntil: iso(subject.relevantUntil),
      userWroteEverySource: subject.userAuthored,
      sources: subject.sources,
      sinceNoted: subject.sinceNoted?.length ? subject.sinceNoted : null,
    },
    questions: { consequence: CONSEQUENCE, timing: TIMING, already_known: ALREADY_KNOWN },
  };
}

export interface SalienceJudgement {
  scores: ObservationScores;
  judgement: ScoreJudgement;
}

/** Ask the decision model; never throws. Levels are null when unavailable. */
export async function judgeSalience(
  decision: DecisionCapability,
  subject: SalienceSubject,
  now: number,
  opts: {
    recordSpend: (modelId: string, inputTokens: number) => Promise<void>;
    log: Logger;
    signal?: AbortSignal;
  },
): Promise<SalienceJudgement> {
  const judgement = await askScore(decision, buildSalienceRequest(subject, now), "consequence", {
    recordSpend: opts.recordSpend,
    log: opts.log,
    signal: opts.signal,
    additionalQuestionIds: ["timing", "already_known"],
  });
  const extra = judgement.additionalScores ?? {};
  return {
    judgement,
    scores: {
      consequence: judgement.score,
      timing: judgement.score === null ? null : (extra.timing ?? null),
      alreadyKnown: judgement.score === null ? null : (extra.already_known ?? null),
      modelId: judgement.score === null ? null : judgement.modelId,
      at: now,
    },
  };
}

export interface SalienceThresholds {
  /** At or above this probability the user already knows it: drop. */
  alreadyKnownMax: number;
  /** Ship at or above this consequence level regardless of timing. */
  minConsequence: number;
  /** Ship a timely observation (timing ≥ `timelyLevel`) at or above this consequence. */
  minTimelyConsequence: number;
  timelyLevel: number;
}

export const DEFAULT_SALIENCE_THRESHOLDS: SalienceThresholds = {
  alreadyKnownMax: 0.6,
  minConsequence: 2,
  minTimelyConsequence: 1,
  timelyLevel: 2,
};

export type SalienceVerdict = "ship" | "hold" | "already_known";

/** The deterministic editorial policy over one observation's scores. */
export function salienceVerdict(
  scores: ObservationScores | null,
  thresholds: SalienceThresholds,
): SalienceVerdict {
  if (!scores || scores.consequence === null) return "ship";
  if (scores.alreadyKnown !== null && scores.alreadyKnown >= thresholds.alreadyKnownMax)
    return "already_known";
  if (scores.consequence >= thresholds.minConsequence) return "ship";
  if (
    scores.timing !== null &&
    scores.timing >= thresholds.timelyLevel &&
    scores.consequence >= thresholds.minTimelyConsequence
  )
    return "ship";
  return "hold";
}

/**
 * Order by consequence, then timing, then age. Unscored observations (an
 * unavailable judgement) follow every scored one, oldest first.
 */
export function compareSalience(
  a: { scores: ObservationScores | null; createdAt: number; id: string },
  b: { scores: ObservationScores | null; createdAt: number; id: string },
): number {
  const level = (s: ObservationScores | null, key: "consequence" | "timing") =>
    s?.[key] ?? Number.NEGATIVE_INFINITY;
  return (
    level(b.scores, "consequence") - level(a.scores, "consequence") ||
    level(b.scores, "timing") - level(a.scores, "timing") ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

/**
 * The "would have pushed" rule: noted at the top consequence level with
 * timing "today or tomorrow", and a deadline that ends before the next
 * morning brief. Returns the noting time, or null.
 */
export function wouldHavePushed(
  scores: ObservationScores | null,
  relevantUntil: number | null,
  nextBriefAt: number,
  notedAt: number,
): number | null {
  if (!scores || scores.consequence === null || scores.timing === null) return null;
  if (scores.consequence < TOP_CONSEQUENCE - 0.5 || scores.timing < TOP_TIMING - 0.5) return null;
  if (relevantUntil === null || relevantUntil >= nextBriefAt) return null;
  return notedAt;
}
