// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";

import {
  createWatchExistenceReviewer,
  reviewWatchExistence,
  type WatchExistenceReviewInput,
} from "./watch-existence-review.js";
import type { PrivacyReviewResult, ReviewCandidateInput } from "./reviewer.js";

const input: WatchExistenceReviewInput = {
  condition: { kind: "natural-language", description: "A fictional launch is announced" },
  interpretation: { summary: "A fictional launch is announced.", pushDetail: "existence" },
  categories: ["documents", "people"],
  expiresAt: 12_345,
  policy: "# Fictional policy",
  policyRevision: "policy-fictional",
  workflowPurpose: "Review the fictional launch announcement",
  cumulativeDisclosure: {
    revision: 0,
    existenceRevision: 0,
    existenceSignals: 0,
    releasedTurns: 0,
    releasedCharacters: 0,
    olderTurnsOmitted: 0,
    categories: [],
  },
};

function result(decision: PrivacyReviewResult["decision"]): PrivacyReviewResult {
  return {
    decision,
    ...(decision === "reduce" ? { reducedAnswer: "A reduced answer" } : {}),
    reductions: [],
    hardStop: false,
    review: {
      recipeVersion: "privacy-reviewer-fictional",
      provider: "fictional-provider",
      model: "fictional-model",
      confidence: 1,
      policyRevision: input.policyRevision,
      findings: [],
      rationale: "Fictional rationale",
    },
    audit: {
      stage: "initial",
      envelope: {
        releaseKind: "watch_existence",
        userPolicy: { revision: input.policyRevision, text: input.policy },
        workflowPurpose: input.workflowPurpose,
        currentRequest: "",
        priorExternalConversation: [],
        cumulativeDisclosure: {
          revision: 0,
          existenceRevision: 0,
          existenceSignals: 0,
          releasedTurns: 0,
          releasedCharacters: 0,
          olderTurnsOmitted: 0,
          categories: [],
        },
        reviewStage: "initial",
        candidateAnswer: "",
        watchDisclosure: null,
      },
      envelopeDigest: "digest-fictional",
      rawModelOutput: null,
      parsedModelOutput: null,
      fallbackCause: null,
      fallbackReason: null,
      hardStop: false,
    },
  };
}

describe("watch existence privacy review", () => {
  it.each(["allow", "ask", "deny"] as const)("preserves a %s decision", async (decision) => {
    const reviewer = { review: vi.fn(async () => result(decision)) };
    await expect(reviewWatchExistence(reviewer, input)).resolves.toMatchObject({ decision });
  });

  it("maps an impossible reduction to approval", async () => {
    const reviewer = { review: vi.fn(async () => result("reduce")) };
    const reviewed = await createWatchExistenceReviewer(reviewer)(input);
    expect(reviewed.decision).toBe("ask");
    expect(reviewed.review.decision).toBe("reduce");
  });

  it("describes truth, timing, repetition, and the untrusted watch fields", async () => {
    let submitted: ReviewCandidateInput | null = null;
    const reviewer = {
      review: vi.fn(async (candidate: ReviewCandidateInput) => {
        submitted = candidate;
        return result("allow");
      }),
    };
    await reviewWatchExistence(reviewer, input);
    expect(submitted).toMatchObject({
      releaseKind: "watch_existence",
      policy: input.policy,
      policyRevision: input.policyRevision,
      cumulativeDisclosure: input.cumulativeDisclosure,
      watchDisclosure: {
        condition: input.condition.description,
        interpretation: input.interpretation.summary,
        categories: input.categories,
        expiresAt: input.expiresAt,
      },
    });
    expect(submitted!.candidateAnswer).toMatch(/approximately this time/);
    expect(submitted!.candidateAnswer).toMatch(/repeatedly/);
  });

  it("hands the reviewer the governing policy family, and none when the input names none", async () => {
    const submitted: ReviewCandidateInput[] = [];
    const reviewer = {
      review: vi.fn(async (candidate: ReviewCandidateInput) => {
        submitted.push(candidate);
        return result("allow");
      }),
    };
    const policyFamily = { id: "00000000-0000-4000-8000-000000000001", name: "Default policy" };
    await reviewWatchExistence(reviewer, { ...input, policyFamily });
    await reviewWatchExistence(reviewer, input);
    expect(submitted[0]).toMatchObject({ policyFamily });
    expect(submitted[1]).not.toHaveProperty("policyFamily");
  });
});
