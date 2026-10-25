// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ContextualAssessmentError } from "../../inference/contextual-entailment.js";

type VerificationFailure = {
  category: "timeout" | "cancelled" | "rate_limited" | "protocol" | "unknown";
  protocol?:
    | "response_format"
    | "assessment_schema"
    | "positive_witness_missing"
    | "witness_outside_authority";
};

export class KnowledgeVerificationTimeoutError extends Error {
  constructor() {
    super("Knowledge entailment deadline exceeded");
  }
}

/** Closed diagnostics only. Provider messages, model IDs, causes and response bodies
 * are never interpolated, including errors whose message looks like a known failure. */
export function verificationFailure(error: unknown): VerificationFailure {
  if (error instanceof KnowledgeVerificationTimeoutError) return { category: "timeout" };
  if (error instanceof DOMException && error.name === "TimeoutError")
    return { category: "timeout" };
  if (error instanceof DOMException && error.name === "AbortError")
    return { category: "cancelled" };
  if (error instanceof ContextualAssessmentError) {
    switch (error.category) {
      case "response_format":
      case "assessment_schema":
      case "positive_witness_missing":
      case "witness_outside_authority":
        return { category: "protocol", protocol: error.category };
      default:
        return { category: "unknown" };
    }
  }
  // Some HTTP adapters preserve a numeric status; flattened provider messages do
  // not. Inspect a data property only, without invoking an unknown error getter.
  if (error instanceof Error && Object.getOwnPropertyDescriptor(error, "status")?.value === 429)
    return { category: "rate_limited" };
  return { category: "unknown" };
}
