// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { normalizeForQuoteMatch } from "./quote-normalize.js";

describe("normalizeForQuoteMatch", () => {
  it("lowercases, collapses whitespace runs, and trims", () => {
    expect(normalizeForQuoteMatch("  Invoice   TOTAL\n\tdue  NOW ")).toBe("invoice total due now");
  });

  // The regression that motivated this normalizer: a model quoting "it's" from
  // a source that renders "it’s" (U+2019) must not be refused as fabrication.
  it("folds curly apostrophes so it’s matches it's", () => {
    expect(normalizeForQuoteMatch("it’s")).toBe(normalizeForQuoteMatch("it's"));
  });

  it("folds single-quote variants to the straight apostrophe", () => {
    for (const variant of ["‘", "’", "‚", "′"]) {
      expect(normalizeForQuoteMatch(`don${variant}t`)).toBe("don't");
    }
  });

  it("folds double-quote variants to the straight double quote", () => {
    for (const variant of ["“", "”", "„", "″"]) {
      expect(normalizeForQuoteMatch(`${variant}quoted${variant}`)).toBe('"quoted"');
    }
  });

  it("folds en dash, em dash, and minus sign to the hyphen", () => {
    for (const variant of ["–", "—", "−"]) {
      expect(normalizeForQuoteMatch(`9${variant}5`)).toBe("9-5");
    }
  });

  it("folds no-break and thin spaces to a plain space", () => {
    for (const variant of ["\u00A0", "\u202F", "\u2009"]) {
      expect(normalizeForQuoteMatch(`12${variant}000`)).toBe("12 000");
    }
  });

  it("expands the ellipsis character to three dots", () => {
    expect(normalizeForQuoteMatch("wait…")).toBe("wait...");
  });

  it("applies Unicode NFC so composed and decomposed accents agree", () => {
    // "café" precomposed (U+00E9) vs decomposed (e + U+0301 combining acute).
    expect(normalizeForQuoteMatch("caf\u00E9")).toBe(normalizeForQuoteMatch("cafe\u0301"));
  });

  it("returns the empty string for whitespace-only input", () => {
    expect(normalizeForQuoteMatch("   \n\t")).toBe("");
    expect(normalizeForQuoteMatch("\u00A0")).toBe("");
  });

  it("leaves plain ASCII text untouched apart from case and spacing", () => {
    expect(normalizeForQuoteMatch("freeze scope by Friday")).toBe("freeze scope by friday");
  });
});
