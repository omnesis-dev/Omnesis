// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scoring an observation at the moment it is noted.
 *
 * The morning recheck decides what ships; this earlier judgement exists for
 * the "would have pushed" log. Only a score taken when the observation was
 * noted can say whether a same-day push would have fired, and when. The
 * score is also kept as the observation's first assessment, so a morning
 * with no decision model still has something to rank by.
 */

import { observationSources, recordSalienceDecision } from "./recheck.js";
import {
  judgeSalience,
  salienceVerdict,
  wouldHavePushed,
  type SalienceThresholds,
} from "./salience.js";
import type { DecisionCapability, Logger } from "@omnesis/core";
import type { CognitionDecisionRecord } from "../storage/decisions.js";
import type { ObservationScores } from "../storage/types.js";
import type Database from "better-sqlite3";

export interface ObservationScoringInput {
  id: string;
  summary: string;
  why: string;
  userAuthored: boolean;
  citations: readonly string[];
  windowStart: number | null;
  relevantUntil: number | null;
  notedAt: number;
}

export interface ObservationScoringResult {
  scores: ObservationScores | null;
  wouldPushAt: number | null;
}

export interface ObservationScorerDeps {
  db: Database.Database;
  getDecision: () => DecisionCapability | null;
  recordSpend: (modelId: string, inputTokens: number) => Promise<void>;
  recordDecision: (record: CognitionDecisionRecord) => Promise<void>;
  thresholds: () => SalienceThresholds;
  /** When the next morning brief is due, measured from `now`. */
  nextBriefAt: (now: number) => number;
  log: Logger;
}

/** Build the per-run scorer the `observation_note` tool calls. */
export function createObservationScorer(
  deps: ObservationScorerDeps,
  runId: string,
): (input: ObservationScoringInput) => Promise<ObservationScoringResult> {
  return async (input) => {
    const decision = deps.getDecision();
    if (!decision) return { scores: null, wouldPushAt: null };
    const judged = await judgeSalience(
      decision,
      {
        summary: input.summary,
        why: input.why,
        userAuthored: input.userAuthored,
        notedAt: input.notedAt,
        windowStart: input.windowStart,
        relevantUntil: input.relevantUntil,
        sources: observationSources(deps.db, input.citations),
      },
      input.notedAt,
      { recordSpend: deps.recordSpend, log: deps.log },
    );
    await recordSalienceDecision(
      { recordDecision: deps.recordDecision },
      {
        runId,
        observation: { id: input.id, citations: [...input.citations] },
        judged,
        verdict: salienceVerdict(judged.scores, deps.thresholds()),
        threshold: deps.thresholds().minConsequence,
        lane: "note",
        now: input.notedAt,
      },
    );
    if (judged.scores.consequence === null) return { scores: null, wouldPushAt: null };
    return {
      scores: judged.scores,
      wouldPushAt: wouldHavePushed(
        judged.scores,
        input.relevantUntil,
        deps.nextBriefAt(input.notedAt),
        input.notedAt,
      ),
    };
  };
}
