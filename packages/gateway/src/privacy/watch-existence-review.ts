// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type {
  PrivacyCumulativeDisclosure,
  SubscriptionCondition,
  SubscriptionInterpretation,
} from "@omnesis/types";
import type {
  PrivacyReviewPolicyFamily,
  PrivacyReviewResult,
  PrivacyReviewer,
} from "./reviewer.js";

export interface WatchExistenceReviewInput {
  condition: SubscriptionCondition;
  interpretation: SubscriptionInterpretation;
  categories: readonly string[];
  expiresAt: number | null;
  policy: string;
  policyRevision: string;
  /** Named on the review record when the governing policy document carries its family. */
  policyFamily?: PrivacyReviewPolicyFamily;
  workflowPurpose: string;
  cumulativeDisclosure: PrivacyCumulativeDisclosure;
}

export type WatchExistenceDecision = "allow" | "ask" | "deny";

export interface WatchExistenceReviewResult {
  decision: WatchExistenceDecision;
  /** Full reviewer output retained for the trusted audit trail. */
  review: PrivacyReviewResult;
}

export type WatchExistenceReviewer = (
  input: WatchExistenceReviewInput,
  signal?: AbortSignal,
) => Promise<WatchExistenceReviewResult>;

/**
 * Ask the ordinary privacy reviewer about the only information a Watch wake
 * releases: the condition's truth and approximate timing, potentially more
 * than once before expiry. Reduction has no coherent meaning for that one bit,
 * so a reviewer that requests it is conservatively mapped to approval.
 */
export async function reviewWatchExistence(
  reviewer: Pick<PrivacyReviewer, "review">,
  input: WatchExistenceReviewInput,
  signal?: AbortSignal,
): Promise<WatchExistenceReviewResult> {
  const review = await reviewer.review(
    {
      releaseKind: "watch_existence",
      currentQuestion: "May this external Watch disclose its existence signal?",
      candidateAnswer:
        "The proposed Watch condition became true at approximately this time. This signal may be sent repeatedly until the Watch expires.",
      policy: input.policy,
      policyRevision: input.policyRevision,
      ...(input.policyFamily ? { policyFamily: input.policyFamily } : {}),
      workflowPurpose: input.workflowPurpose,
      cumulativeDisclosure: input.cumulativeDisclosure,
      watchDisclosure: {
        condition: input.condition.description,
        interpretation: input.interpretation.summary,
        categories: [...input.categories],
        expiresAt: input.expiresAt,
      },
    },
    signal,
  );
  return {
    decision: review.decision === "reduce" ? "ask" : review.decision,
    review,
  };
}

export function createWatchExistenceReviewer(
  reviewer: Pick<PrivacyReviewer, "review">,
): WatchExistenceReviewer {
  return (input, signal) => reviewWatchExistence(reviewer, input, signal);
}
