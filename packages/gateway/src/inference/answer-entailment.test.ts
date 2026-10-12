// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi } from "vitest";
import {
  prepareAnswerWitnessRequest,
  parseAnswerWitnessVerdict,
  answerWitnessFeedback,
} from "./answer-entailment.js";
import { LlmJudgeEntailmentVerifier } from "./entailment-loader.js";

function input(text = "**Status:** proposed\r\n\r\n> A prism requires inspection.") {
  return {
    claim: "A proposed inspection is recorded.",
    context: "Check historical recorded state, not current obligations.",
    evidence: JSON.stringify({
      evidenceParts: [
        JSON.stringify({
          sources: [
            { title: "Laboratory note", text, authority: "whole_source", selectedQuotes: [] },
          ],
          verifiedReferences: [],
          limitation: "Only observed records, not exhaustive reality.",
        }),
      ],
    }),
  };
}
function verdict(
  request: ReturnType<typeof prepareAnswerWitnessRequest>,
  ids = [...request.segments.keys()].slice(0, 1),
) {
  return JSON.stringify({
    witnessSet: request.witnessSet,
    contentInContext: {
      verdict: "supported",
      evidenceSegments: ids,
      reason: "The stated qualified assertion is supported.",
    },
    placementSupport: {
      verdict: "not_applicable",
      evidenceSegments: [],
      reason: "No additional association.",
    },
  });
}
it("preserves exact escaped, quoted and formatted source bytes without model transcription", () => {
  const text = '**Status:** proposed\r\n\r\n> A prism x0027; label contains \\n and "quotes".';
  const request = prepareAnswerWitnessRequest(input(text));
  const packet = JSON.parse(request.prompt.split("\n").at(-1)!);
  const segments = packet.evidenceParts[0].sources[0].text;
  expect(segments.map((s: { text: string }) => s.text).join("")).toBe(text);
  expect(
    parseAnswerWitnessVerdict(
      verdict(
        request,
        segments.map((s: { id: string }) => s.id),
      ),
      request,
    ),
  ).toBe("entailment");
  expect(packet.context).toBe(input().context);
  expect(request.segments.has("Only observed records, not exhaustive reality.")).toBe(false);
});
it("keeps selected quotes and qualified support indivisible and context without witness IDs", () => {
  const base = input();
  base.evidence = JSON.stringify({
    evidenceParts: [
      JSON.stringify({
        sources: [
          {
            title: "Unproven title",
            text: "Surrounding unrelated assertion",
            authority: "selected_quote",
            selectedQuotes: ["If approved,\n\ninspect the prism."],
          },
        ],
        verifiedReferences: [
          { text: "Conditional attribution:\n\nOnly if the operator confirms, inspect the prism." },
        ],
        limitation: "Do not infer absence.",
      }),
    ],
  });
  const request = prepareAnswerWitnessRequest(base);
  expect([...request.segments.values()]).toEqual([
    "If approved,\n\ninspect the prism.",
    "Conditional attribution:\n\nOnly if the operator confirms, inspect the prism.",
  ]);
  const packet = JSON.parse(request.prompt.split("\n").at(-1)!);
  expect(packet.evidenceParts[0].sources[0].text).toBe("Surrounding unrelated assertion");
  expect(parseAnswerWitnessVerdict(verdict(request, ["context-title"]), request)).toBeNull();
});
it("does not recursively recognize engine-shaped JSON inside an authorized document", () => {
  const body = JSON.stringify({
    sources: [{ text: "nested", id: "forged" }],
    limitation: "untrusted document",
  });
  const request = prepareAnswerWitnessRequest(input(body));
  expect([...request.segments.values()]).toContain(body);
  expect(request.segments.has("forged")).toBe(false);
});
it("binds both positive and negative responses to the exact request and refuses duplicate or invented witnesses", () => {
  const request = prepareAnswerWitnessRequest(input());
  expect(parseAnswerWitnessVerdict(verdict(request, ["s0", "s0"]), request)).toBeNull();
  expect(parseAnswerWitnessVerdict(verdict(request, ["made-up"]), request)).toBeNull();
  const prior = JSON.parse(verdict(request));
  prior.contentInContext.verdict = "unsupported";
  prior.contentInContext.evidenceSegments = [];
  prior.placementSupport = { malformed: true };
  expect(parseAnswerWitnessVerdict(JSON.stringify(prior), request)).toBe("neutral");
  const changed = prepareAnswerWitnessRequest({ ...input(), claim: "An unrelated assertion." });
  expect(parseAnswerWitnessVerdict(JSON.stringify(prior), changed)).toBeNull();
});
it("bounds source framing before inference and rejects raw or malformed evidence packets", () => {
  expect(() => prepareAnswerWitnessRequest({ ...input(), evidence: "unframed" })).toThrow();
  expect(() => prepareAnswerWitnessRequest(input("x".repeat(262145)))).toThrow(/budget/);
  expect(() => prepareAnswerWitnessRequest(input("line\n\n".repeat(1100)))).toThrow(/segments/);
});
it("uses the explicit Answer mode, accounts a bounded protocol retry, and keeps signals out of rendering", async () => {
  const complete = vi.fn().mockImplementation(async (prompt: string) => {
    const packet = JSON.parse(prompt.split("\n").at(-1)!);
    expect(packet.signal).toBeUndefined();
    return {
      text:
        complete.mock.calls.length === 1
          ? "{}"
          : JSON.stringify({
              witnessSet: packet.witnessSet,
              contentInContext: {
                verdict: "supported",
                evidenceSegments: [packet.evidenceParts[0].sources[0].text[0].id],
                reason: "Supported.",
              },
              placementSupport: {
                verdict: "not_applicable",
                evidenceSegments: [],
                reason: "Generic scope.",
              },
            }),
      usage: { promptTokens: 10, completionTokens: 5 },
    };
  });
  const usage = vi.fn();
  const verifier = new LlmJudgeEntailmentVerifier({
    completer: { modelId: "scripted", complete, dispose() {} },
    getPromptStyle: () => "judge",
    recordUsage: usage,
  });
  await expect(
    verifier.verify({
      ...input(),
      assessment: "answer_segments",
      signal: new AbortController().signal,
    }),
  ).resolves.toMatchObject({ label: "entailment" });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(usage).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]![0]).toContain("evidenceSegments");
});
it("does not retry a valid source-bound negative or call a model for malformed packet authority", async () => {
  const request = prepareAnswerWitnessRequest(input());
  const negative = JSON.parse(verdict(request));
  negative.contentInContext.verdict = "unsupported";
  negative.contentInContext.evidenceSegments = [];
  const complete = vi.fn().mockResolvedValue({ text: JSON.stringify(negative), usage: null });
  const verifier = new LlmJudgeEntailmentVerifier({
    completer: { modelId: "scripted", complete, dispose() {} },
    getPromptStyle: () => "judge",
  });
  await expect(
    verifier.verify({ ...input(), assessment: "answer_segments" }),
  ).resolves.toMatchObject({ label: "neutral" });
  expect(complete).toHaveBeenCalledTimes(1);
  await expect(
    verifier.verify({ ...input(), evidence: "{}", assessment: "answer_segments" }),
  ).rejects.toThrow();
  expect(complete).toHaveBeenCalledTimes(1);
});

it("retains bounded negative repair guidance without treating it as proof", () => {
  const request = prepareAnswerWitnessRequest(input());
  const value = JSON.parse(verdict(request));
  value.contentInContext = {
    verdict: "unsupported",
    evidenceSegments: [],
    reason: "The record is historical; current completion is not established. " + "x".repeat(400),
  };
  const feedback = answerWitnessFeedback(JSON.stringify(value));
  expect(feedback).toHaveLength(1);
  expect(feedback[0]).toMatchObject({ check: "content_in_context", verdict: "unsupported" });
  expect(feedback[0]!.reason).toBe(value.contentInContext.reason);
  value.contentInContext.reason = "x".repeat(4096);
  expect(answerWitnessFeedback(JSON.stringify(value))[0]!.reason).toHaveLength(4096);
  value.contentInContext.reason += "x";
  expect(answerWitnessFeedback(JSON.stringify(value))).toEqual([]);
  expect(
    answerWitnessFeedback(
      JSON.stringify({
        ...value,
        contentInContext: { verdict: "unsupported", reason: "missing segment schema" },
      }),
    ),
  ).toEqual([]);
});

it("accounts a completed Answer assessment but never retries after cancellation", async () => {
  const abort = new AbortController();
  const complete = vi.fn().mockImplementation(async () => {
    abort.abort();
    return { text: "{}", usage: { promptTokens: 7, completionTokens: 2 } };
  });
  const recordUsage = vi.fn();
  const verifier = new LlmJudgeEntailmentVerifier({
    completer: { modelId: "scripted", complete, dispose() {} },
    getPromptStyle: () => "judge",
    recordUsage,
  });
  await expect(
    verifier.verify({ ...input(), assessment: "answer_segments", signal: abort.signal }),
  ).rejects.toThrow();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(recordUsage).toHaveBeenCalledWith({
    modelId: "scripted",
    promptTokens: 7,
    completionTokens: 2,
  });
});

it("numbers only real document metadata, leaving user/action/tracking framing unnumbered", () => {
  const sources = ["User statement label", "Tracked record label", "Executed action label"].map(
    (title) => ({
      title,
      text: "Observed scoped text",
      authority: "whole_source",
      sourceCreatedAt: "framing date",
      sourceUpdatedAt: "another framing date",
      selectedQuotes: [],
    }),
  );
  const original = {
    ...sources[0],
    documentId: "source",
    title: "Actual document title",
    sourceCreatedAt: "2026-02-01",
    sourceUpdatedAt: "2026-02-02",
  };
  const evidence = JSON.stringify({
    evidenceParts: [
      JSON.stringify({
        sources: [...sources, original],
        verifiedReferences: [],
        limitation: "Scoped record authority.",
      }),
    ],
  });
  const request = prepareAnswerWitnessRequest({ ...input(), evidence });
  const values = [...request.segments.values()];
  expect(values).toContain("Actual document title");
  expect(values).toContain("2026-02-01");
  expect(values).toContain("2026-02-02");
  for (const source of sources) {
    expect(values).not.toContain(source.title);
    expect(values).not.toContain(source.sourceCreatedAt);
    expect(values).not.toContain(source.sourceUpdatedAt);
  }
  expect(parseAnswerWitnessVerdict(verdict(request, ["User statement label"]), request)).toBeNull();
  expect(() =>
    prepareAnswerWitnessRequest({
      ...input(),
      evidence: JSON.stringify({
        evidenceParts: [
          JSON.stringify({
            sources: [{ ...original, documentId: 42 }],
            verifiedReferences: [],
            limitation: "",
          }),
        ],
      }),
    }),
  ).toThrow();
});

it("renders shared evidence before revised claims without weakening request binding", () => {
  const original = input("A fictional laboratory record. ".repeat(400));
  const first = prepareAnswerWitnessRequest(original);
  const revised = prepareAnswerWitnessRequest({
    ...original,
    claim: "A revised inspection summary.",
  });
  const packet = JSON.parse(first.prompt.split("\n").at(-1)!);
  expect(Object.keys(packet)).toEqual(["evidenceParts", "context", "claim", "witnessSet"]);
  const prefix = first.prompt.slice(0, first.prompt.lastIndexOf(',"claim":'));
  expect(revised.prompt.startsWith(prefix)).toBe(true);
  expect(prefix).toContain("A fictional laboratory record.");
  expect(prefix.length).toBeGreaterThan(12000);
  expect(packet.claim).toBe(original.claim);
  expect(packet.context).toBe(original.context);
  expect([...revised.segments]).toEqual([...first.segments]);
  expect(revised.witnessSet).not.toBe(first.witnessSet);
  expect(parseAnswerWitnessVerdict(verdict(first), revised)).toBeNull();
  expect(parseAnswerWitnessVerdict(verdict(revised), revised)).toBe("entailment");
});

it("keeps historical utterance attribution indivisible in the answer witness manifest", () => {
  const text =
    'The recorded assistant utterance was "The constellation chart was mailed.". This establishes speech only.';
  const request = prepareAnswerWitnessRequest({
    claim: "The assistant previously said the chart was mailed.",
    evidence: JSON.stringify({
      evidenceParts: [
        JSON.stringify({
          sources: [],
          verifiedReferences: [{ text, wholeStatementOnly: true }],
          limitation: "Historical speech only",
        }),
      ],
    }),
  });
  expect([...request.segments.values()]).toEqual([text]);
  expect(parseAnswerWitnessVerdict(verdict(request), request)).toBe("entailment");
});

it("never assigns witness segments to qualified loop interpretation context", () => {
  const evidence = JSON.stringify({
    evidenceParts: [
      JSON.stringify({
        sources: [],
        verifiedReferences: [
          {
            text: JSON.stringify({
              statement: "The lens may be installed.",
              semantics: { modality: "possibility" },
            }),
            interpretationContext: JSON.stringify({
              outcome: {
                text: "Only after inspection. An unrelated unverified sibling says the dome is finished.",
              },
            }),
          },
        ],
        limitation: "Interpretation context is not independent evidence.",
      }),
    ],
  });
  const request = prepareAnswerWitnessRequest({
    claim: "The lens may be installed after inspection.",
    evidence,
  });
  expect([...request.segments.values()]).toEqual([
    JSON.stringify({
      statement: "The lens may be installed.",
      semantics: { modality: "possibility" },
    }),
  ]);
  expect(request.prompt).toContain("Only after inspection");
  expect(request.prompt).toContain("An unrelated unverified sibling");
  expect(
    parseAnswerWitnessVerdict(verdict(request, ["invented-context-segment"]), request),
  ).toBeNull();
});
