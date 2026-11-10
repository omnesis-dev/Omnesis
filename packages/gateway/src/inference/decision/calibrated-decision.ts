// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A decision backend whose score answers are moved onto Jev's scale by a
 * stored calibration (see `decision-calibration.ts` in core), so every
 * threshold tuned on Jev cuts where it was meant to.
 *
 * Only `score` answers change: a `choice` is already the model's most likely
 * option and a `noul` is a probability. The level probabilities stay as the
 * model gave them; the score is the one number callers compare. The model id
 * gains `+cal`, so the decision ledger tells calibrated answers from raw ones.
 */

import {
  calibrateDecisionScore,
  type DecisionAnswer,
  type DecisionCalibration,
  type DecisionCapability,
  type DecisionRequest,
  type DecisionResult,
} from "@omnesis/core";

export class CalibratedDecision implements DecisionCapability {
  readonly modelId: string;

  constructor(
    private readonly inner: DecisionCapability,
    private readonly calibration: DecisionCalibration,
  ) {
    this.modelId = `${inner.modelId}+cal`;
  }

  async decide(request: DecisionRequest, opts?: { signal?: AbortSignal }): Promise<DecisionResult> {
    const result = await this.inner.decide(request, opts);
    const answers: Record<string, DecisionAnswer> = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      const question = request.questions[id];
      answers[id] =
        answer.type === "score" && question?.type === "score"
          ? {
              ...answer,
              score: calibrateDecisionScore(
                this.calibration,
                answer.score,
                question.criteria.length,
              ),
            }
          : answer;
    }
    return { ...result, model: `${result.model}+cal`, answers };
  }

  dispose(): void | Promise<void> {
    return this.inner.dispose();
  }
}
