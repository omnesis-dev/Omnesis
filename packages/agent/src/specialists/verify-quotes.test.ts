// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { verifyQuotes } from "./verify-quotes.js";

// Fictional document text — invented, not from any corpus (frozen privacy rule).
const DOC =
  "The Northstar release ships on the 14th. Maya Reeves confirmed the budget at " +
  "$12,000 and asked the team to freeze scope by Friday. No further changes after that.";

describe("citation-verifier quote check (#748 trust feature)", () => {
  it("VERIFIES a quote that appears verbatim in the cited text", () => {
    const report = verifyQuotes(DOC, ["confirmed the budget at $12,000"]);
    expect(report.allPresent).toBe(true);
    expect(report.mismatches).toHaveLength(0);
    expect(report.results[0]?.present).toBe(true);
  });

  it("VERIFIES despite reflowed whitespace and case differences", () => {
    const report = verifyQuotes(DOC, ["The   NORTHSTAR\nrelease ships on the 14th."]);
    expect(report.allPresent).toBe(true);
  });

  it("VERIFIES a straight-apostrophe quote against curly-apostrophe source text", () => {
    // Sources routinely render U+2019 where the model quotes U+0027 — the
    // shared normalizer folds typographic punctuation, so this is not flagged.
    const curlyDoc = "Maya Reeves noted the launch window: “it’s the 14th — no later”.";
    const report = verifyQuotes(curlyDoc, ['"it\'s the 14th - no later"']);
    expect(report.allPresent).toBe(true);
    expect(report.mismatches).toHaveLength(0);
  });

  // The negative control: a quote that is NOT in the document must be flagged.
  it("FLAGS a fabricated quote that does not appear in the cited text", () => {
    const fabricated = "Maya Reeves approved an extra $5,000 of contingency.";
    const report = verifyQuotes(DOC, [fabricated]);
    expect(report.allPresent).toBe(false);
    expect(report.results[0]?.present).toBe(false);
    expect(report.mismatches).toContain(fabricated);
  });

  it("FLAGS a paraphrase passed off as a quote (strict, not fuzzy)", () => {
    // Same meaning, different words → a MISMATCH, not a verification.
    const paraphrase = "Maya locked the budget at twelve thousand dollars.";
    const report = verifyQuotes(DOC, [paraphrase]);
    expect(report.allPresent).toBe(false);
    expect(report.mismatches).toContain(paraphrase);
  });

  it("reports a mixed batch per-quote", () => {
    const real = "freeze scope by Friday";
    const fake = "delay the release to next quarter";
    const report = verifyQuotes(DOC, [real, fake]);
    expect(report.results.map((r) => r.present)).toEqual([true, false]);
    expect(report.mismatches).toEqual([fake]);
    expect(report.allPresent).toBe(false);
  });

  it("treats an empty quote as NOT present — a citation must carry text", () => {
    const report = verifyQuotes(DOC, ["   "]);
    expect(report.allPresent).toBe(false);
    expect(report.results[0]?.present).toBe(false);
  });
});
