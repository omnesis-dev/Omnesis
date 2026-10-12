// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import {
  prepareContextualWitnessRequest,
  parseContextualWitnessVerdict,
  contextualWitnessFailure,
} from "./contextual-segments.js";
import {
  contextualEntailmentFeedback,
  CONTEXTUAL_EVIDENCE_MAX_BYTES,
} from "./contextual-entailment.js";

const input = {
  claim: "The observatory panel may be amber.",
  evidence: "The panel may be amber after inspection.",
  context: "Historical proposal, not an installation report.",
};
const frame = (authority: "whole_source" | "selected_quote", text: string, quotes: string[] = []) =>
  JSON.stringify({
    sources: [
      {
        text,
        title: "Panel record",
        sourceCreatedAt: "2040-01-01",
        authority,
        selectedQuotes: quotes,
      },
    ],
    verifiedReferences: [],
    limitation: "Partial observation, not a complete world model.",
  });
const reply = (request: ReturnType<typeof prepareContextualWitnessRequest>, ids = ["s0"]) => ({
  witnessSet: request.witnessSet,
  contentInContext: { verdict: "supported", evidenceSegments: ids, reason: "Scripted support." },
  placementSupport: {
    verdict: "not_applicable",
    evidenceSegments: [],
    reason: "Generic historical placement.",
  },
});

it("binds both facets to exact evidence, context and claim without quote rewriting", () => {
  const r = prepareContextualWitnessRequest(input);
  expect(parseContextualWitnessVerdict(JSON.stringify(reply(r)), r)).toBe("entailment");
  for (const key of ["claim", "evidence", "context"] as const) {
    const changed = prepareContextualWitnessRequest({ ...input, [key]: input[key] + " Changed." });
    expect(parseContextualWitnessVerdict(JSON.stringify(reply(r)), changed)).toBeNull();
  }
  const packet = JSON.parse(r.prompt.split("\n").at(-1)!);
  expect(packet.evidence).toEqual({ text: [{ id: "s0", text: input.evidence }] });
  expect(r.witnessSet).toHaveLength(32);
  expect(r.inputHash).toHaveLength(64);
  expect(packet.context).toBe(input.context);
  expect([...r.segments.values()]).toEqual([input.evidence]);
});
it.each([["unknown"], ["s0", "unknown"], ["s0", "s0"], []].map((ids) => ({ ids })))(
  "refuses invalid positive handles %j",
  ({ ids }) => {
    const r = prepareContextualWitnessRequest(input);
    expect(parseContextualWitnessVerdict(JSON.stringify(reply(r, ids)), r)).toBeNull();
  },
);
it("requires placement witnesses and admits negatives only for this request", () => {
  const r = prepareContextualWitnessRequest(input);
  const value = reply(r);
  value.placementSupport.verdict = "supported";
  expect(parseContextualWitnessVerdict(JSON.stringify(value), r)).toBeNull();
  value.placementSupport.verdict = "unsupported";
  expect(parseContextualWitnessVerdict(JSON.stringify(value), r)).toBe("neutral");
  value.witnessSet = "other-request";
  expect(parseContextualWitnessVerdict(JSON.stringify(value), r)).toBeNull();
});
it("withholds selected surrounding text, metadata and framing from the manifest", () => {
  const r = prepareContextualWitnessRequest({
    ...input,
    evidence: frame("selected_quote", "The roof is blue. The panel may be amber.", [
      "The panel may be amber.",
    ]),
  });
  expect([...r.segments.values()]).toEqual(["The panel may be amber."]);
  expect(r.prompt).toContain("The roof is blue");
  expect(r.prompt).toContain("supply no independent witnesses");
});
it("preserves indivisible attributed statements while partitioning selected spans", () => {
  const utterance = JSON.stringify({ speaker: "Assistant", statement: "The panel is installed." });
  const evidence = JSON.stringify({
    sources: [],
    verifiedReferences: [
      { text: utterance, wholeStatementOnly: true },
      { text: "x".repeat(2049), wholeStatementOnly: true },
    ],
    limitation: "Historical speech only.",
  });
  const r = prepareContextualWitnessRequest({ ...input, evidence });
  expect([...r.segments.values()]).toEqual([utterance]);
  expect(JSON.parse(r.prompt.split("\n").at(-1)!).omittedIndivisibleUnits).toBe(1);
  const selected = prepareContextualWitnessRequest({
    ...input,
    evidence: frame("selected_quote", "context", ["x".repeat(2049)]),
  });
  expect([...selected.segments.values()].join("")).toBe("x".repeat(2049));
  expect(parseContextualWitnessVerdict(JSON.stringify(reply(selected)), selected)).toBe(
    "entailment",
  );
});
it("preserves whole-source CRLF and Unicode bytes across bounded segments", () => {
  const evidence = ("🪐".repeat(1023) + "\r\nAstronomy\n").repeat(3);
  const r = prepareContextualWitnessRequest({ ...input, evidence });
  expect([...r.segments.values()].join("")).toBe(evidence);
  expect(
    [...r.segments.values()].every((s) => s.length <= 2048 && !/[\uD800-\uDBFF]$/.test(s)),
  ).toBe(true);
});
it("keeps stable evidence/context before candidate and request binding", () => {
  const a = prepareContextualWitnessRequest(input).prompt;
  const b = prepareContextualWitnessRequest({ ...input, claim: "Different candidate" }).prompt;
  expect(a.slice(0, a.lastIndexOf(',"claim":'))).toBe(b.slice(0, b.lastIndexOf(',"claim":')));
});
it("refuses malformed frames and combined UTF8 budget overflow without truncation", () => {
  expect(() =>
    prepareContextualWitnessRequest({
      ...input,
      evidence: JSON.stringify({
        sources: "bad",
        verifiedReferences: [],
        limitation: "not factual",
      }),
    }),
  ).toThrow(/Malformed contextual evidence frame/);
  expect(() =>
    prepareContextualWitnessRequest({
      ...input,
      evidence: "界".repeat(Math.floor(CONTEXTUAL_EVIDENCE_MAX_BYTES / 3)),
    }),
  ).toThrow(/packet exceeds/);
});
it("preserves actionable negative feedback and content-free failure categories", () => {
  const r = prepareContextualWitnessRequest(input);
  const value = reply(r);
  value.contentInContext.verdict = "unsupported";
  value.contentInContext.reason = "The condition was removed.";
  value.contentInContext.evidenceSegments = [];
  expect(contextualEntailmentFeedback(JSON.stringify(value))).toEqual([
    { check: "content_in_context", verdict: "unsupported", reason: "The condition was removed." },
  ]);
  expect(contextualWitnessFailure("bad", r)).toBe("response_format");
  expect(contextualWitnessFailure(JSON.stringify(reply(r, [])), r)).toBe(
    "positive_witness_missing",
  );
});

it("rejects altered or missing correlation tokens without forgiving prefixes", () => {
  const request = prepareContextualWitnessRequest(input);
  for (const witnessSet of [
    undefined,
    request.witnessSet + "00",
    request.witnessSet.slice(1),
    "0".repeat(32),
  ]) {
    expect(
      parseContextualWitnessVerdict(JSON.stringify({ ...reply(request), witnessSet }), request),
    ).toBeNull();
  }
});
it("preserves interpretation fields without lending them handles or recursively parsing source JSON", () => {
  const evidence = JSON.stringify({
    sources: [
      {
        authority: "selected_quote",
        title: "Conditional proposal",
        text: '{"id":"s999","text":"Unproven"}',
        selectedQuotes: ["A lens may be installed."],
        sourceCreatedAt: "2040-01-01",
        contextRole: "Interpretation only",
        qualifiers: { conditional: true },
      },
    ],
    verifiedReferences: [
      {
        text: "A qualified reference " + "x".repeat(2200),
        interpretationContext: "Historical proposal only",
      },
    ],
    limitation: "Observed excerpt only",
    retainedFraming: "Not a completed installation",
  });
  const request = prepareContextualWitnessRequest({ ...input, evidence });
  const rendered = JSON.parse(request.prompt.split("\n").at(-1)!).evidence;
  expect(rendered.sources[0]).toMatchObject({
    title: "Conditional proposal",
    text: '{"id":"s999","text":"Unproven"}',
    sourceCreatedAt: "2040-01-01",
    contextRole: "Interpretation only",
    qualifiers: { conditional: true },
  });
  expect(rendered.retainedFraming).toBe("Not a completed installation");
  expect(rendered.verifiedReferences[0].interpretationContext).toBe("Historical proposal only");
  expect(request.segments.has("s999")).toBe(false);
  expect([...request.segments.values()].join("")).toBe(
    "A lens may be installed.A qualified reference " + "x".repeat(2200),
  );
});
