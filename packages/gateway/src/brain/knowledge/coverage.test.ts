// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { parseClaimMarkup } from "./claims.js";
import { uncoveredKnowledgeSpans } from "./coverage.js";

describe("synthesis structural coverage", () => {
  it("finds untagged prose before and after a supported assertion", () => {
    const parsed = parseClaimMarkup(
      'The payment cleared. <claim id="time" refs="source:letter">Setup is tomorrow.</claim> The venue is booked.',
    );
    expect(
      uncoveredKnowledgeSpans(parsed).map((span) => parsed.text.slice(span.start, span.end).trim()),
    ).toEqual(["The payment cleared.", "The venue is booked."]);
  });
  it("accepts nested claim coverage without mistaking containment for proof", () => {
    expect(
      uncoveredKnowledgeSpans(
        parseClaimMarkup(
          ' <claim id="outer" refs="source:letter">Plan: <claim id="inner" refs="source:other">tomorrow</claim>.</claim>\n',
        ),
      ),
    ).toEqual([]);
  });
  it("does not exempt headings, code examples, or escaped claim-like text", () => {
    for (const text of [
      "# The payment cleared",
      '`<claim id="example" refs="source:letter">Paid</claim>`',
      "\\<claim>Paid",
    ])
      expect(uncoveredKnowledgeSpans(parseClaimMarkup(text))).toHaveLength(1);
    expect(uncoveredKnowledgeSpans(parseClaimMarkup("\n \t"))).toEqual([]);
  });
});
