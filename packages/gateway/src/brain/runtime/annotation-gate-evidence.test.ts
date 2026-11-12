// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { contextualEvidence, jointContextualEvidence } from "./annotation-gate-evidence.js";

describe("contextual annotation evidence", () => {
  it("retains draft framing and later correction around a selected sentence", () => {
    const quote = "The lab opens on Tuesday.";
    const source = `DRAFT — not approved\n${quote}\nCorrection: the opening date is undecided.`;
    expect(JSON.parse(contextualEvidence(quote, source))).toEqual({
      quote,
      source_context: source,
      truncated: false,
    });
  });

  it("bounds long evidence while retaining framing, quote neighborhood, and ending", () => {
    const quote = "The test assembly passed inspection.";
    const source = `Preliminary report\n${"x".repeat(8_000)}\nWithdrawn result:\n${quote}\n${"y".repeat(8_000)}\nFinal review pending.`;
    const result = JSON.parse(contextualEvidence(quote, source)) as {
      source_context: string;
      truncated: boolean;
      limitation: string;
    };
    expect(result.source_context).toContain("Preliminary report");
    expect(result.source_context).toContain(`Withdrawn result:\n${quote}`);
    expect(result.source_context).toContain("Final review pending.");
    expect(result.source_context.length).toBeLessThan(3_100);
    expect(result.truncated).toBe(true);
    expect(result.limitation).toContain("cannot establish absence");
  });

  it("keeps independently framed sources distinct for joint synthesis", () => {
    const evidence = jointContextualEvidence([
      { quote: "The parcel arrived.", source: "The parcel arrived." },
      {
        quote: "The sample is usable.",
        source: "Conditional assessment: The sample is usable. Await inspection.",
      },
    ]);
    expect(evidence).toContain("[1] The parcel arrived.");
    expect(evidence).toContain("[2] ");
    expect(evidence).toContain("Conditional assessment");
    expect(evidence).toContain("Await inspection");
  });
});
