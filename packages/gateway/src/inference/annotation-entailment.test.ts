// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import { describe, expect, it } from "vitest";
import {
  assessAnnotationEntailment,
  AnnotationAssessmentError,
  annotationAssessmentFailure,
  annotationEntailmentFailures,
  annotationEntailmentPrompt,
  parseAnnotationEntailment,
  uncoveredClaimWords,
} from "./annotation-entailment.js";

const claim = "The mosaic is green; the plinth is square.";
const candidate = {
  actor: null,
  action: null,
  target: null,
  stage: null,
  time: null,
  condition: null,
  quantifier: null,
};
const row = (text = claim, id = "a1") => ({
  id,
  spans: [{ text, occurrence: 0 }],
  candidate,
  verdict: "supported",
  reason: "Scripted assessment",
  evidenceQuotes: [text],
});
const response = (assertions = [row()]) => ({
  coverage: { verdict: "complete", reason: "Scripted coverage" },
  assertions,
  placementSupport: { verdict: "not_applicable", reason: "Generic note", evidenceQuotes: [] },
});
const parse = (value: unknown, text = claim, evidence = claim) =>
  parseAnnotationEntailment(JSON.stringify(value), text, evidence);

describe("annotation atomic protocol", () => {
  it("keeps rules before dynamic inputs and requires independent assessments", () => {
    const prompt = annotationEntailmentPrompt({ claim, evidence: claim });
    expect(prompt).toContain("Separate different actor/recipient/action-stage relationships");
    expect(prompt).toContain("Each assertion has its own verdict");
    expect(JSON.parse(prompt.split("\n").at(-1)!)).toEqual({
      claim,
      evidence: claim,
      assessment: "annotation_atomic",
    });
  });
  it("accepts exact fully covered support but not an unsupported sibling", () => {
    const value = response([row("The mosaic is green", "a1"), row("the plinth is square", "a2")]);
    expect(parse(value)).toBe("entailment");
    value.assertions[1]!.verdict = "unsupported";
    value.assertions[1]!.evidenceQuotes = [];
    expect(parse(value)).toBe("neutral");
    expect(annotationEntailmentFailures(JSON.stringify(value), claim)).toEqual([
      { id: "a2", spans: ["the plinth is square"] },
    ]);
  });
  it("lets candidate-bound negatives dominate incomplete coverage and malformed siblings", () => {
    const value = {
      ...response(),
      coverage: { verdict: "incomplete" },
      assertions: [
        { ...row("The mosaic", "a1"), verdict: "contradicted", evidenceQuotes: [] },
        { id: "a2" },
      ],
    };
    expect(parse(value)).toBe("neutral");
    expect(
      parse({
        ...value,
        assertions: [{ ...row("absent candidate text"), verdict: "contradicted" }],
      }),
    ).toBeNull();
    expect(
      parse({ ...value, assertions: [{ ...row(), id: "a9", verdict: "contradicted" }] }),
    ).toBeNull();
  });
  it("refuses duplicate IDs even when one repeats a negative", () => {
    const value = response([{ ...row(), verdict: "unsupported" }, row()]);
    expect(parse(value)).toBeNull();
    expect(annotationEntailmentFailures(JSON.stringify(value), claim)).toEqual([]);
  });
  it("requires full positive coverage including negation, connectives and numbers", () => {
    expect(parse(response([row("The mosaic is green")]))).toBeNull();
    const text = "The mosaic is not blue.";
    expect(
      parse(
        response([
          {
            ...row(),
            spans: [
              { text: "The mosaic is", occurrence: 0 },
              { text: "blue", occurrence: 0 },
            ],
            evidenceQuotes: [text],
          },
        ]),
        text,
        text,
      ),
    ).toBeNull();
    expect(
      parse({ ...response(), coverage: { verdict: "incomplete", reason: "Missing unit" } }),
    ).toBeNull();
  });
  it("resolves repeated anchors with overlap and Unicode without splitting surrogate pairs", () => {
    const text = "Élan 🪁; Élan 🪁.";
    const value = response([
      row("Élan 🪁"),
      { ...row("Élan 🪁", "a2"), spans: [{ text: "Élan 🪁", occurrence: 1 }] },
    ]);
    expect(parse(value, text, text)).toBe("entailment");
    value.assertions[1]!.spans[0]!.occurrence = 2;
    expect(parse(value, text, text)).toBeNull();
    expect(
      parse(response([{ ...row("Élan \ud83e"), verdict: "contradicted" }]), text, text),
    ).toBeNull();
    const overlapping = response([row(), { ...row("The mosaic", "a2"), evidenceQuotes: [claim] }]);
    expect(parse(overlapping)).toBe("entailment");
  });
  it("retains selected quote authority and joint evidence without trusting surrounding text", () => {
    const frame = JSON.stringify({
      sources: [
        {
          title: "The display is antique",
          text: "The display is antique. " + claim,
          authority: "selected_quote",
          selectedQuotes: [claim],
        },
      ],
      verifiedReferences: [],
      limitation: "Only selected text",
    });
    expect(parse(response(), claim, frame)).toBe("entailment");
    expect(
      parse(response([{ ...row(), evidenceQuotes: ["The display is antique"] }]), claim, frame),
    ).toBeNull();
    const joint = response([
      { ...row(), evidenceQuotes: ["The mosaic is green", "the plinth is square"] },
    ]);
    expect(
      parse(
        joint,
        claim,
        JSON.stringify({ evidenceParts: ["The mosaic is green", "the plinth is square"] }),
      ),
    ).toBe("entailment");
    expect(
      parse(
        response(),
        claim,
        JSON.stringify({
          sources: [{ text: claim }],
          verifiedReferences: [],
          limitation: "Malformed",
        }),
      ),
    ).toBeNull();
  });
  it("never uses placement context as evidence and requires placement unless a valid negative exists", () => {
    expect(parse({ ...response(), placementSupport: undefined })).toBeNull();
    expect(
      parse({
        ...response(),
        placementSupport: {
          verdict: "supported",
          reason: "Specific context",
          evidenceQuotes: ["unseen association"],
        },
      }),
    ).toBeNull();
    expect(
      parse({
        ...response(),
        placementSupport: {
          verdict: "unsupported",
          reason: "Unsupported association",
          evidenceQuotes: [],
        },
      }),
    ).toBe("neutral");
  });
  it("bounds malformed responses, anchors and output counts", () => {
    expect(parseAnnotationEntailment("x".repeat(32769), claim, claim)).toBeNull();
    expect(parseAnnotationEntailment("{bad", claim, claim)).toBeNull();
    expect(
      parse(response(Array.from({ length: 13 }, (_, i) => row(claim, `a${i + 1}`)))),
    ).toBeNull();
    const long = "z".repeat(1000);
    expect(
      parse(
        response(
          Array.from({ length: 12 }, (_, i) => ({
            ...row(long, `a${i + 1}`),
            spans: [
              { text: long, occurrence: 0 },
              { text: long, occurrence: 0 },
            ],
          })),
        ),
        long,
        long,
      ),
    ).toBeNull();
  });
});

it("does not permit an inner assistant assertion to escape indivisible historical attribution", () => {
  const text =
    'The recorded assistant utterance was "The mosaic is green; the plinth is square.". This records speech, not independent world confirmation.';
  const evidence = JSON.stringify({
    sources: [],
    verifiedReferences: [{ text, wholeStatementOnly: true }],
    limitation: "Attributed speech only",
  });
  const value = response();
  expect(parse(value, claim, evidence)).toBeNull();
  value.assertions[0]!.evidenceQuotes = [text];
  expect(parse(value, claim, evidence)).toBe("entailment");
  // The parser proves protocol mechanics only; the model still judges semantic scope.
});

it("retains an exact evidence and context prefix across changed candidate claims", () => {
  const evidence = 'Original record: "amber".\r\nSecond paragraph.\n'.repeat(400);
  const context = JSON.stringify({ heading: "Conditional proposal", scope: "Historical" });
  const firstClaim = "The panel may be amber.";
  const secondClaim = "The panel is amber.";
  const first = annotationEntailmentPrompt({ claim: firstClaim, evidence, context });
  const second = annotationEntailmentPrompt({ claim: secondClaim, evidence, context });
  const payloadStart = first.lastIndexOf("\n") + 1;
  const firstPayload = first.slice(payloadStart);
  const secondPayload = second.slice(second.lastIndexOf("\n") + 1);
  const stablePayload =
    JSON.stringify({ evidence, context, assessment: "annotation_atomic" }).slice(0, -1) +
    ',"claim":';
  expect(firstPayload.startsWith(stablePayload)).toBe(true);
  expect(secondPayload.startsWith(stablePayload)).toBe(true);
  expect(first.slice(0, payloadStart + stablePayload.length)).toBe(
    second.slice(0, payloadStart + stablePayload.length),
  );
  expect(JSON.parse(firstPayload)).toEqual({
    evidence,
    context,
    assessment: "annotation_atomic",
    claim: firstClaim,
  });
  expect(JSON.parse(secondPayload)).toEqual({
    evidence,
    context,
    assessment: "annotation_atomic",
    claim: secondClaim,
  });
  expect(firstPayload).not.toBe(secondPayload);
  const changedContext = annotationEntailmentPrompt({
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

it("names the claim words no span covers, and nothing for unreadable or complete output", () => {
  expect(uncoveredClaimWords(JSON.stringify(response([row("The mosaic")])), claim)).toEqual(
    claim.split(/\s+/u).slice(2),
  );
  expect(uncoveredClaimWords(JSON.stringify(response()), claim)).toEqual([]);
  expect(uncoveredClaimWords('{"coverage":', claim)).toEqual([]);
});

describe("closed annotation diagnostics", () => {
  const assess = (value: unknown, text = claim, evidence = claim) =>
    assessAnnotationEntailment(JSON.stringify(value), text, evidence);

  it.each([
    [response(), { label: "entailment" }],
    [{ ...response(), assertions: [] }, { failure: "assessment_shape" }],
    [response([{ ...row(), reason: "" }]), { failure: "assessment_shape" }],
    [response([row(claim, "a2")]), { failure: "candidate_identity" }],
    [response([row(), row()]), { failure: "candidate_identity" }],
    [response([row("Absent anchor")]), { failure: "candidate_span" }],
    [response([row(";")]), { failure: "candidate_span" }],
    [response([row("The mosaic")]), { failure: "coverage" }],
    [{ ...response(), coverage: undefined }, { failure: "coverage" }],
    [response([{ ...row(), evidenceQuotes: [] }]), { failure: "positive_witness_missing" }],
    [
      response([{ ...row(), evidenceQuotes: ["unobserved"] }]),
      { failure: "witness_outside_authority" },
    ],
    [{ ...response(), placementSupport: undefined }, { failure: "placement_schema" }],
    [
      {
        ...response(),
        placementSupport: { verdict: "supported", reason: "Context", evidenceQuotes: [] },
      },
      { failure: "positive_witness_missing" },
    ],
    [
      {
        ...response(),
        placementSupport: {
          verdict: "supported",
          reason: "Context",
          evidenceQuotes: ["unobserved"],
        },
      },
      { failure: "witness_outside_authority" },
    ],
  ])("reports a closed obstruction while preserving wrapper verdicts", (value, expected) => {
    expect(assess(value)).toEqual(expected);
    expect(parse(value)).toBe("label" in expected ? expected.label : null);
  });

  it("preserves both negative-dominance paths over positive-only failures", () => {
    const malformedPositive = { id: "a2", reason: "private canary" };
    const negative = { ...row("The mosaic"), verdict: "unsupported", evidenceQuotes: [] };
    const value = { assertions: [negative, malformedPositive], coverage: undefined };
    expect(assess(value)).toEqual({ label: "neutral" });
    expect(annotationEntailmentFailures(JSON.stringify(value), claim)).toEqual([
      { id: "a1", spans: ["The mosaic"] },
    ]);
    const placementSupport = {
      verdict: "contradicted",
      reason: "Association missing",
      evidenceQuotes: [],
    };
    expect(assess({ ...value, assertions: [malformedPositive], placementSupport })).toEqual({
      label: "neutral",
    });
    expect(assess({ ...value, assertions: [{ ...negative, id: "a9" }] })).toEqual({
      failure: "candidate_identity",
    });
    expect(
      assess({
        ...value,
        assertions: [{ ...negative, spans: [{ text: "missing", occurrence: 0 }] }],
      }),
    ).toEqual({ failure: "candidate_span" });
    expect(assess({ ...value, assertions: [negative, { id: "a1" }] })).toEqual({
      failure: "candidate_identity",
    });
    expect(
      assess({ ...value, assertions: [{ ...negative, evidenceQuotes: Array(9).fill("x") }] }),
    ).toEqual({ failure: "assessment_shape" });
  });

  it("keeps global evidence, response and anchor limits ahead of negatives", () => {
    const value = response([{ ...row(), verdict: "unsupported" }]);
    expect(assess(value, claim, "x".repeat(262145))).toEqual({ failure: "evidence_bounds" });
    expect(assessAnnotationEntailment(" ".repeat(32769), claim, claim)).toEqual({
      failure: "response_bounds",
    });
    expect(assessAnnotationEntailment("界".repeat(22000), claim, claim)).toEqual({
      failure: "response_bounds",
    });
    expect(assessAnnotationEntailment("{invalid", claim, claim)).toEqual({
      failure: "response_format",
    });
    const long = "z".repeat(1000);
    const rows = Array.from({ length: 7 }, (_, i) => ({
      ...row(long, `a${i + 1}`),
      verdict: i === 0 ? "unsupported" : "supported",
      spans: [
        { text: long, occurrence: 0 },
        { text: long, occurrence: 0 },
      ],
      evidenceQuotes: [],
    }));
    expect(assess(response(rows), long, long)).toEqual({ failure: "anchor_budget" });
    expect(annotationEntailmentFailures(JSON.stringify(response(rows)), long)).toEqual([]);
  });

  it("diagnoses exact anchor occurrence and UTF16 boundaries without exposing offsets", () => {
    expect(assess(response([{ ...row(), spans: [{ text: claim, occurrence: 1 }] }]))).toEqual({
      failure: "candidate_span",
    });
    expect(assess(response([row("Élan \ud83e")]), "Élan 🪁.", "Élan 🪁.")).toEqual({
      failure: "candidate_span",
    });
  });

  it("does not turn selected context or an inner attributed quote into authorized witnesses", () => {
    const evidence = JSON.stringify({
      sources: [{ authority: "selected_quote", text: claim, selectedQuotes: ["The mosaic"] }],
      verifiedReferences: [],
      limitation: "Scope",
    });
    expect(assess(response(), claim, evidence)).toEqual({ failure: "witness_outside_authority" });
    const attributed = JSON.stringify({
      sources: [],
      verifiedReferences: [{ text: "Recorded statement: " + claim, wholeStatementOnly: true }],
      limitation: "Attribution",
    });
    expect(assess(response(), claim, attributed)).toEqual({ failure: "witness_outside_authority" });
  });

  it("only exposes fixed own-data diagnostic literals, never raw provider text or accessors", () => {
    const error = new AnnotationAssessmentError("candidate_span", "scripted-model");
    expect(error.category).toBe("assessment_schema");
    expect(annotationAssessmentFailure(error)).toBe("candidate_span");
    Object.defineProperty(error, "annotationFailure", {
      value: "secret canary",
      configurable: true,
    });
    expect(annotationAssessmentFailure(error)).toBeUndefined();
    Object.defineProperty(error, "annotationFailure", {
      get: () => {
        throw new Error("secret getter");
      },
    });
    expect(annotationAssessmentFailure(error)).toBeUndefined();
    expect(annotationAssessmentFailure({ annotationFailure: "coverage" })).toBeUndefined();
  });
});
