// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { askScore } from "../decision-call.js";
import { knowledgeHash } from "./storage-validation.js";
import type { DecisionCapability, DecisionQuestion, Logger } from "@omnesis/core";

export type KnowledgeDecisionPurpose = "urgency" | "impact" | "discovery" | "review";
const questions: Record<KnowledgeDecisionPurpose, Extract<DecisionQuestion, { type: "score" }>> = {
  urgency: {
    type: "score",
    instructions:
      "How soon must the personal brain incorporate this evidence change? Judge consequences of waiting, not just topic importance.",
    criteria: [
      "Routine: waiting six hours has little cost.",
      "Soon: incorporation within an hour is useful.",
      "Immediate: waiting an hour risks missing a concrete action window or using materially wrong current context.",
    ],
  },
  impact: {
    type: "score",
    instructions:
      "Could these changed inputs alter this synthesis node's claims, uncertainty, attribution, temporal applicability or tracked outcome? Score low only with clear irrelevance; wording alone need not change.",
    criteria: [
      "Clearly unrelated or already completely accounted for at these input versions.",
      "Uncertain relevance: inspect and re-synthesize.",
      "Direct material change or contradiction requiring repair.",
    ],
  },
  discovery: {
    type: "score",
    instructions:
      "Does this evidence warrant interpretation or linking to durable personal context, a tracked outcome, or a reusable synthesis? Durable understanding is useful even without an open action.",
    criteria: [
      "No personal or durable relevance.",
      "Possibly relevant context or connection.",
      "Clear durable context, new commitment or change to an existing project.",
    ],
  },
  review: {
    type: "score",
    instructions:
      "Choose proactive review timing from objective signals: canonical loop deadline and importance, last meaningful review, uncertain claims, activity, volatility and checkpoint. The ordered levels are dormant, defer, and review now. Uncertainty or consequential change means review now. The engine computes the bounded timestamp; a deferral is never verification.",
    criteria: [
      "Dormant: stable historical context; wait for evidence changes or the mandatory backstop.",
      "Defer: a short bounded wait is clearly safe; check again at an engine-computed time.",
      "Due checkpoint, stale evidence or important unresolved contradiction.",
    ],
  },
};
export interface KnowledgeDecisionDeps {
  getDecision?: () => DecisionCapability | null;
  log: Logger;
  recordSpend: (modelId: string, tokens: number) => Promise<void>;
  /** Persist metadata-only verdicts; source text remains in the evidence store. */
  record?: (entry: {
    purpose: KnowledgeDecisionPurpose;
    inputFingerprint: string;
    rubricVersion: string;
    score: number | null;
    modelId: string;
    latencyMs: number;
    inputTokens: number | null;
  }) => Promise<void>;
}
export async function judgeKnowledge(
  deps: KnowledgeDecisionDeps,
  purpose: KnowledgeDecisionPurpose,
  state: Record<string, unknown>,
): Promise<number | null> {
  const decision = deps.getDecision?.();
  if (!decision) return null;
  const result = await askScore(
    decision,
    { state, questions: { [purpose]: questions[purpose] } },
    purpose,
    { recordSpend: deps.recordSpend, log: deps.log },
  );
  // The model returns a probability-weighted level (0..levels-1), while
  // scheduling thresholds and stored verdicts use a normalized 0..1 score.
  const maximum = questions[purpose].criteria.length - 1;
  const score =
    result.score !== null &&
    Number.isFinite(result.score) &&
    result.score >= 0 &&
    result.score <= maximum
      ? result.score / maximum
      : null;
  await deps.record?.({
    purpose,
    inputFingerprint: knowledgeHash(state),
    rubricVersion: purpose === "review" ? "knowledge-review-timing-v3" : "knowledge-decisions-v2",
    score,
    modelId: result.modelId,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
  });
  return score;
}
