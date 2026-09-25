// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect } from "vitest";
import {
  DEEP_RESEARCH_OTHER_STAGE_MECHANISM,
  deepResearchSpendMechanism,
} from "./spend-recorder.js";

describe("deepResearchSpendMechanism", () => {
  it("names each known stage separately", () => {
    expect(deepResearchSpendMechanism("research-planner")).toBe("deep-research:research-planner");
    expect(deepResearchSpendMechanism("history-sweep")).toBe("deep-research:history-sweep");
    expect(deepResearchSpendMechanism("source-digest")).toBe("deep-research:source-digest");
  });

  it("folds an unknown specialist into one bucket instead of interpolating it", () => {
    // Reader names come from the planner model's own JSON plan, and `mechanism`
    // is part of cognition_spend's primary key in a table that survives every
    // prune. Interpolating would let model output grow the key space without
    // bound — and the plan echoes the user's question, so its text must not
    // reach a durable schema key.
    expect(deepResearchSpendMechanism("some-invented-reader")).toBe(
      DEEP_RESEARCH_OTHER_STAGE_MECHANISM,
    );
    expect(deepResearchSpendMechanism("")).toBe(DEEP_RESEARCH_OTHER_STAGE_MECHANISM);
    expect(deepResearchSpendMechanism("sweep the invoice archive")).toBe(
      DEEP_RESEARCH_OTHER_STAGE_MECHANISM,
    );
  });

  it("is bounded: any input maps into a fixed set of mechanisms", () => {
    const inputs = ["research-planner", "x", "y".repeat(500), "../etc", "history-sweep"];
    const produced = new Set(inputs.map(deepResearchSpendMechanism));
    expect(produced.size).toBeLessThanOrEqual(3);
    for (const mechanism of produced) expect(mechanism.length).toBeLessThan(64);
  });
});
