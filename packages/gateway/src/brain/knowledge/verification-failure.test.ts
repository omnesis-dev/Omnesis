// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import { ContextualAssessmentError } from "../../inference/contextual-entailment.js";
import { verificationFailure } from "./verification-failure.js";

test("uses an explicit numeric HTTP status, never provider prose or arbitrary diagnostic strings", () => {
  expect(verificationFailure(Object.assign(new Error("sensitive"), { status: 429 }))).toEqual({
    category: "rate_limited",
  });
  expect(verificationFailure(new Error("429 rate limit timeout sensitive"))).toEqual({
    category: "unknown",
  });
  expect(verificationFailure({ category: "secret", message: "secret" })).toEqual({
    category: "unknown",
  });
  const error = new Error("sensitive");
  Object.defineProperty(error, "status", {
    get() {
      throw new Error("must not run");
    },
  });
  expect(verificationFailure(error)).toEqual({ category: "unknown" });
  const malformed = new ContextualAssessmentError("response_format", "private-model");
  Object.defineProperty(malformed, "category", { value: "private-response" });
  expect(verificationFailure(malformed)).toEqual({ category: "unknown" });
});
