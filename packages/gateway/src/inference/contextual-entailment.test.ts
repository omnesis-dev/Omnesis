// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  contextualEntailmentFeedback,
  contextualEntailmentPrompt,
  contextualAssessmentFailure,
  parseContextualEntailment,
} from "./contextual-entailment.js";

const evidence = "The prism glows after the switch closes.";
const supported = {
  verdict: "supported",
  reason: "Source establishes the condition.",
  evidenceQuotes: [evidence],
};
const encode = (content: unknown, placement: unknown) =>
  JSON.stringify({ contentInContext: content, placementSupport: placement });

describe("contextual assessment contract", () => {
  it("requires both positive assessments and source-exact witnesses", () => {
    expect(parseContextualEntailment(encode(supported, supported), evidence)).toBe("entailment");
    expect(
      parseContextualEntailment(
        encode(supported, { ...supported, evidenceQuotes: ["A different prism"] }),
        evidence,
      ),
    ).toBeNull();
    expect(
      parseContextualEntailment(encode(supported, { ...supported, evidenceQuotes: [] }), evidence),
    ).toBeNull();
    expect(
      parseContextualEntailment(
        encode(supported, { ...supported, evidenceQuotes: [" "] }),
        evidence,
      ),
    ).toBeNull();
  });
  it("normalizes whitespace without accepting paraphrases or proposed context", () => {
    const quote = { ...supported, evidenceQuotes: ["The prism\n glows after the switch closes."] };
    expect(parseContextualEntailment(encode(quote, supported), evidence)).toBe("entailment");
    expect(
      parseContextualEntailment(
        encode({ ...supported, evidenceQuotes: ["The prism shines."] }, supported),
        evidence,
      ),
    ).toBeNull();
  });
  it("allows generic placement only with an explicit reason and verified content", () => {
    const generic = {
      verdict: "not_applicable",
      reason: "Generic organization adds no relationship.",
      evidenceQuotes: [],
    };
    expect(parseContextualEntailment(encode(supported, generic), evidence)).toBe("entailment");
    expect(
      parseContextualEntailment(encode(supported, { ...generic, reason: " " }), evidence),
    ).toBeNull();
    expect(parseContextualEntailment(encode(generic, supported), evidence)).toBeNull();
  });
  it.each(["unsupported", "contradicted"])(
    "lets valid %s dominate a malformed sibling without demanding negative proof",
    (verdict) => {
      const negative = {
        verdict,
        reason: "Association is not established.",
        evidenceQuotes: ["not in source"],
      };
      expect(parseContextualEntailment(encode(null, negative), evidence)).toBe("neutral");
      expect(
        parseContextualEntailment(encode({ ...negative, evidenceQuotes: [] }, null), evidence),
      ).toBe("neutral");
    },
  );
  it("does not promote absent, malformed or truncated assessments", () => {
    for (const text of [
      "ENTAILMENT",
      "{}",
      encode(supported, undefined),
      '{"contentInContext":',
      encode(supported, { verdict: "unsupported" }),
    ]) {
      expect(parseContextualEntailment(text, evidence)).toBeNull();
    }
  });
  it("bounds raw output, reasons and witness arrays", () => {
    expect(parseContextualEntailment(" ".repeat(32769), evidence)).toBeNull();
    expect(
      parseContextualEntailment(
        encode(supported, { ...supported, reason: "x".repeat(4097) }),
        evidence,
      ),
    ).toBeNull();
    expect(
      parseContextualEntailment(
        encode(supported, { ...supported, evidenceQuotes: Array(17).fill(evidence) }),
        evidence,
      ),
    ).toBeNull();
  });
  it("accepts a fenced JSON result after thinking without parsing deliberation", () => {
    expect(
      parseContextualEntailment(
        `<think>unsupported</think>\n\`\`\`json\n${encode(supported, supported)}\n\`\`\``,
        evidence,
      ),
    ).toBe("entailment");
  });
});

it("matches decoded source excerpts from brief JSON framing without admitting proposed context", () => {
  const text = 'The label reads "amber".\nThe switch is closed.';
  const frame = JSON.stringify({
    sources: [
      {
        text,
        title: 'Prism "amber"',
        sourceCreatedAt: null,
        sourceUpdatedAt: null,
        selectedQuotes: [],
      },
    ],
    verifiedReferences: [{ text: 'The panel reads "ready".' }],
    limitation: "Record dates are not event dates.",
    context: "The unsupported relationship is established.",
  });
  const content = { ...supported, evidenceQuotes: [text] };
  const placement = { ...supported, evidenceQuotes: ['The panel reads "ready".'] };
  expect(parseContextualEntailment(encode(content, placement), frame)).toBe("entailment");
  expect(
    parseContextualEntailment(
      encode(
        { ...content, evidenceQuotes: ["The unsupported relationship is established."] },
        placement,
      ),
      frame,
    ),
  ).toBeNull();
});

it("decodes bounded joint source frames without admitting context fields or nested envelopes", () => {
  const sourceText = 'The panel reads "ready".\nIts indicator is lit.';
  const frame = JSON.stringify({
    sources: [{ text: sourceText, title: "Panel", selectedQuotes: [] }],
    verifiedReferences: [],
    limitation: "This instruction is not source evidence.",
    context: "An invented relation",
  });
  const packet = JSON.stringify({ evidenceParts: [frame, evidence] });
  expect(
    parseContextualEntailment(
      encode({ ...supported, evidenceQuotes: [sourceText] }, supported),
      packet,
    ),
  ).toBe("entailment");
  for (const quote of ["An invented relation", "This instruction is not source evidence."])
    expect(
      parseContextualEntailment(
        encode({ ...supported, evidenceQuotes: [quote] }, supported),
        packet,
      ),
    ).toBeNull();
  for (const packet of [
    JSON.stringify({ evidenceParts: Array(129).fill(evidence) }),
    JSON.stringify({ evidenceParts: [JSON.stringify({ evidenceParts: [evidence] })] }),
    JSON.stringify({ evidenceParts: [evidence], context: evidence }),
  ])
    expect(parseContextualEntailment(encode(supported, supported), packet)).toBeNull();
});

it("does not accept surrounding facts as witnesses for a selected-quote reference", () => {
  const frame = JSON.stringify({
    sources: [
      {
        authority: "selected_quote",
        text: "The rack has six places. The prism is blue.",
        title: "Blue prism",
        selectedQuotes: ["The rack has six places."],
      },
    ],
    verifiedReferences: [],
    limitation: "Surroundings qualify interpretation only.",
  });
  const unrelated = { ...supported, evidenceQuotes: ["The prism is blue."] };
  expect(parseContextualEntailment(encode(unrelated, unrelated), frame)).toBeNull();
  const selected = { ...supported, evidenceQuotes: ["The rack has six places."] };
  expect(parseContextualEntailment(encode(selected, selected), frame)).toBe("entailment");
});

it("returns only bounded validated negative feedback without promoting malformed assessments", () => {
  const raw = encode(supported, {
    verdict: "unsupported",
    reason:
      "The evidence does not connect this statement to the named project. " + "detail ".repeat(100),
    evidenceQuotes: [],
    privateExtra: "not diagnostic output",
  });
  const feedback = contextualEntailmentFeedback(raw);
  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toMatchObject({ check: "placement_support", verdict: "unsupported" });
  expect(feedback[0]!.reason).toHaveLength(256);
  expect(JSON.stringify(feedback)).not.toContain("privateExtra");
  expect(contextualEntailmentFeedback(encode(supported, supported))).toEqual([]);
  for (const malformed of [
    "unavailable",
    encode(supported, { verdict: "unsupported", reason: "unvalidated" }),
    "x".repeat(32769),
  ]) {
    expect(contextualEntailmentFeedback(malformed)).toEqual([]);
    expect(parseContextualEntailment(malformed, evidence)).toBeNull();
  }
});

it("explains selected witness authority and categorizes failed positives without revealing prose", () => {
  const frame = JSON.stringify({
    sources: [
      {
        authority: "selected_quote",
        text: "A telescope is packed. The crate is blue.",
        title: null,
        selectedQuotes: ["A telescope is packed."],
      },
    ],
    verifiedReferences: [],
    limitation: "Selected evidence only",
  });
  const raw = encode(
    { ...supported, evidenceQuotes: ["The crate is blue."] },
    { ...supported, verdict: "not_applicable", evidenceQuotes: [] },
  );
  expect(parseContextualEntailment(raw, frame)).toBeNull();
  expect(contextualAssessmentFailure(raw)).toBe("witness_outside_authority");
  expect(contextualAssessmentFailure("not JSON")).toBe("response_format");
  expect(contextualAssessmentFailure("{}")).toBe("assessment_schema");
  expect(contextualAssessmentFailure(encode({ ...supported, evidenceQuotes: [] }, supported))).toBe(
    "positive_witness_missing",
  );
  expect(
    contextualEntailmentPrompt({
      claim: "The crate is blue.",
      context: "Inventory",
      evidence: frame,
    }),
  ).toContain("exclusively from that source's selectedQuotes");
  const valid = encode(
    { ...supported, evidenceQuotes: ["A telescope is packed."] },
    { ...supported, verdict: "not_applicable", evidenceQuotes: [] },
  );
  expect(parseContextualEntailment(valid, frame)).toBe("entailment");
});

it("fails closed for malformed recognized evidence frames while preserving ordinary JSON documents", () => {
  const source = {
    authority: "selected_quote",
    text: "The crate is blue.",
    title: null,
    selectedQuotes: ["A telescope is packed."],
  };
  for (const malformed of [
    {
      sources: Array.from({ length: 33 }, () => source),
      verifiedReferences: [],
      limitation: "Selection only",
    },
    {
      sources: [source],
      verifiedReferences: Array.from({ length: 17 }, () => ({ text: "Other evidence" })),
      limitation: "Selection only",
    },
    {
      sources: [{ ...source, selectedQuotes: "invalid" }],
      verifiedReferences: [],
      limitation: "Selection only",
    },
  ]) {
    const raw = encode(
      { ...supported, evidenceQuotes: ["The crate is blue."] },
      { ...supported, verdict: "not_applicable", evidenceQuotes: [] },
    );
    expect(parseContextualEntailment(raw, JSON.stringify(malformed))).toBeNull();
  }
  const ordinary = JSON.stringify({ description: "The crate is blue." });
  expect(
    parseContextualEntailment(
      encode(
        { ...supported, evidenceQuotes: ["The crate is blue."] },
        { ...supported, verdict: "not_applicable", evidenceQuotes: [] },
      ),
      ordinary,
    ),
  ).toBe("entailment");
});

it("refuses limitation-only and mixed framing witnesses without stripping invalid quotes", () => {
  const body = "The calibration completed on Tuesday.";
  const limitation = "This packet is not exhaustive.";
  const frame = JSON.stringify({
    sources: [{ authority: "whole_source", title: null, text: body, selectedQuotes: [] }],
    verifiedReferences: [],
    limitation,
  });
  const placement = { ...supported, verdict: "not_applicable", evidenceQuotes: [] };
  for (const quotes of [[limitation], [body, limitation]]) {
    const raw = encode({ ...supported, evidenceQuotes: quotes }, placement);
    expect(parseContextualEntailment(raw, frame)).toBeNull();
    expect(contextualAssessmentFailure(raw)).toBe("witness_outside_authority");
  }
  expect(
    parseContextualEntailment(encode({ ...supported, evidenceQuotes: [body] }, placement), frame),
  ).toBe("entailment");
  const prompt = contextualEntailmentPrompt({
    claim: body,
    evidence: frame,
    context: "Generic answer",
  });
  expect(prompt).toContain("framing labels and instructions are never positive evidenceQuotes");
  expect(prompt).toContain("do not require administrative-prose quotes");
  expect(prompt).toContain("their factual premises still require authorized evidence");
});

it("retains an exact evidence and context prefix across changed candidate claims", () => {
  const evidence = 'Original record: "amber".\r\nSecond paragraph.\n'.repeat(400);
  const context = JSON.stringify({ heading: "Conditional proposal", scope: "Historical" });
  const firstClaim = "The panel may be amber.";
  const secondClaim = "The panel is amber.";
  const first = contextualEntailmentPrompt({ claim: firstClaim, evidence, context });
  const second = contextualEntailmentPrompt({ claim: secondClaim, evidence, context });
  const payloadStart = first.lastIndexOf("\n") + 1;
  const firstPayload = first.slice(payloadStart);
  const secondPayload = second.slice(second.lastIndexOf("\n") + 1);
  const stablePayload = JSON.stringify({ evidence, context }).slice(0, -1) + ',"claim":';
  expect(firstPayload.startsWith(stablePayload)).toBe(true);
  expect(secondPayload.startsWith(stablePayload)).toBe(true);
  expect(first.slice(0, payloadStart + stablePayload.length)).toBe(
    second.slice(0, payloadStart + stablePayload.length),
  );
  expect(JSON.parse(firstPayload)).toEqual({ evidence, context, claim: firstClaim });
  expect(JSON.parse(secondPayload)).toEqual({ evidence, context, claim: secondClaim });
  expect(firstPayload).not.toBe(secondPayload);
  const changedContext = contextualEntailmentPrompt({
    evidence,
    context: "Different enclosing qualification",
    claim: secondClaim,
  });
  const evidencePrefix = JSON.stringify({ evidence }).slice(0, -1) + ",";
  expect(changedContext.slice(0, payloadStart + evidencePrefix.length)).toBe(
    first.slice(0, payloadStart + evidencePrefix.length),
  );
  expect(JSON.parse(changedContext.slice(changedContext.lastIndexOf("\n") + 1))).toMatchObject({
    evidence,
    context: "Different enclosing qualification",
    claim: secondClaim,
  });
  expect(first.slice(0, payloadStart)).toContain("untrusted");
});
