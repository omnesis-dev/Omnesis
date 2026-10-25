// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  OBSERVATION_STATE_FILTERS,
  closeReasonLabel,
  observationScoreParts,
  observationScoreSummary,
  observationStateColor,
  shippedMessageHref,
  // @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
} from "./cognition-observations.js";

describe("observation rendering helpers", () => {
  it("reads the decision model's three judgements with their scales", () => {
    const scores = { consequence: 3, timing: 1, alreadyKnown: 0.2, modelId: "fixture-decision", at: 1 };
    expect(observationScoreParts(scores)).toEqual([
      { key: "consequence", label: "Consequence", value: "3/4" },
      { key: "timing", label: "Timing", value: "1/3" },
      { key: "alreadyKnown", label: "Already known", value: "20%" },
    ]);
    expect(observationScoreSummary(scores)).toBe("C 3/4 · T 1/3 · K 20%");
  });

  it("reads missing judgements as dashes and missing scores as not scored", () => {
    expect(observationScoreSummary({ consequence: null, timing: 0, alreadyKnown: null, modelId: null, at: 1 })).toBe(
      "C — · T 0/3 · K —",
    );
    expect(observationScoreSummary(null)).toBe("not scored");
  });

  it("explains every close reason and passes an unknown one through readably", () => {
    expect(closeReasonLabel(null)).toBeNull();
    expect(closeReasonLabel("below_bar")).toBe("Below the bar this morning");
    expect(closeReasonLabel("already_known")).toBe("The user already knows it");
    expect(closeReasonLabel("suppressed")).toBe("The user asked not to see it");
    expect(closeReasonLabel("some_new_reason")).toBe("some new reason");
  });

  it("links a shipped observation to the conversation its brief message sits in", () => {
    expect(shippedMessageHref({ shippedConversationId: "conv/morning" })).toBe("/portal/agent/conv%2Fmorning");
    expect(shippedMessageHref({ shippedConversationId: null })).toBeNull();
  });

  it("colours every lifecycle state and filters on open (live + held) by default", () => {
    const colors = ["live", "held", "shipped", "dropped"].map(observationStateColor);
    expect(new Set(colors).size).toBe(4);
    expect(OBSERVATION_STATE_FILTERS[0].value).toBe("open");
  });
});
