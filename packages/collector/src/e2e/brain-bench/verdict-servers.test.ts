// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it } from "vitest";
import { startVerdictServer, type EntailmentLabel } from "./verdict-servers.js";

it.each(["entailment", "neutral", "contradiction"] as const)(
  "preserves scripted %s for structured contextual requests",
  async (label: EntailmentLabel) => {
    const subject = {
      claim: "The prism glows.",
      evidence: "The prism glows.",
      context: "Optics exhibit",
    };
    const server = await startVerdictServer({
      role: "entailment",
      policy(input) {
        expect(input).toMatchObject(subject);
        return label;
      },
    });
    try {
      const response = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: `contentInContext placementSupport\n${JSON.stringify(subject)}`,
            },
          ],
        }),
      });
      const body = (await response.json()) as { choices: { message: { content: string } }[] };
      const result = JSON.parse(body.choices[0]!.message.content) as Record<
        string,
        { verdict: string; evidenceQuotes: string[] }
      >;
      const expected =
        label === "entailment" ? "supported" : label === "neutral" ? "unsupported" : "contradicted";
      expect(result.contentInContext!.verdict).toBe(expected);
      expect(result.placementSupport!.verdict).toBe(expected);
      expect(result.contentInContext!.evidenceQuotes).toEqual(
        label === "entailment" ? [subject.evidence] : [],
      );
      expect(server.calls[0]).toMatchObject(subject);
    } finally {
      await server.close();
    }
  },
);

it("keeps ordinary literal verdict requests unchanged", async () => {
  const server = await startVerdictServer({ role: "entailment", policy: "reject-all" });
  try {
    const response = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "Evidence quote: The prism glows.\nClaim: The prism spins." },
        ],
      }),
    });
    const body = (await response.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]!.message.content).toBe("NEUTRAL");
    expect(server.calls[0]).not.toHaveProperty("context");
  } finally {
    await server.close();
  }
});

it.each(["sources", "verifiedReferences"] as const)(
  "quotes actual %s content inside a joint evidence envelope",
  async (kind) => {
    const text = "The fictional observatory opens at noon.";
    const frame = JSON.stringify({
      sources: kind === "sources" ? [{ title: "Hours", text, selectedQuotes: [] }] : [],
      verifiedReferences: kind === "verifiedReferences" ? [{ text }] : [],
      limitation: "Fixture evidence only.",
    });
    const server = await startVerdictServer({ role: "entailment", policy: "accept-all" });
    try {
      const response = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: `contentInContext placementSupport\n${JSON.stringify({ claim: text, context: "Hours", evidence: JSON.stringify({ evidenceParts: [frame] }) })}`,
            },
          ],
        }),
      });
      const body = (await response.json()) as { choices: { message: { content: string } }[] };
      const verdict = JSON.parse(body.choices[0]!.message.content);
      expect(verdict.contentInContext.evidenceQuotes).toEqual([text]);
      expect(verdict.placementSupport.evidenceQuotes).toEqual([text]);
    } finally {
      await server.close();
    }
  },
);

it.each(["entailment", "neutral", "contradiction"] as const)(
  "preserves scripted %s in atomic annotation requests",
  async (label) => {
    const subject = {
      claim: "The prism glows.",
      evidence: "The prism glows.",
      context: "Generic note",
      assessment: "annotation_atomic",
    };
    const server = await startVerdictServer({ role: "entailment", policy: () => label });
    try {
      const response = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content: `annotation_atomic placementSupport\n${JSON.stringify(subject)}`,
            },
          ],
        }),
      });
      const body = (await response.json()) as { choices: { message: { content: string } }[] };
      const parsed = JSON.parse(body.choices[0]!.message.content);
      expect(parsed).toMatchObject({
        coverage: { verdict: "complete" },
        assertions: [
          {
            id: "a1",
            spans: [{ text: subject.claim, occurrence: 0 }],
            verdict:
              label === "entailment"
                ? "supported"
                : label === "neutral"
                  ? "unsupported"
                  : "contradicted",
            evidenceQuotes: label === "entailment" ? [subject.evidence] : [],
          },
        ],
        placementSupport: { verdict: "not_applicable" },
      });
      expect(parsed).not.toHaveProperty("contentInContext");
      expect(server.calls[0]).toMatchObject(subject);
    } finally {
      await server.close();
    }
  },
);

it.each(
  ["entailment", "neutral", "contradiction"].flatMap((label) =>
    ["answer_segments", "contextual_segments"].map((mode) => ({
      label: label as EntailmentLabel,
      mode,
    })),
  ),
)("serves the actual $mode loader protocol with scripted $label", async ({ label, mode }) => {
  const { LlmJudgeEntailmentVerifier } =
    await import("../../../../gateway/src/inference/entailment-loader.js");
  const { HttpCompleter } = await import("../../../../gateway/src/inference/http-completer.js");
  const server = await startVerdictServer({ role: "entailment", policy: () => label });
  const http = new HttpCompleter({ baseUrl: server.url, model: "scripted" });
  const verifier = new LlmJudgeEntailmentVerifier({
    completer: {
      modelId: http.modelId,
      complete: (prompt, options) => http.completeWithUsage(prompt, options),
      dispose: () => http.dispose(),
    },
    getPromptStyle: () => "judge",
  });
  try {
    const result = await verifier.verify({
      claim: "A prism inspection is proposed.",
      context: "Historical recorded proposal.",
      ...(mode === "answer_segments" ? { assessment: "answer_segments" as const } : {}),
      evidence: JSON.stringify({
        evidenceParts: [
          JSON.stringify({
            sources: [
              {
                title: "Laboratory note",
                authority: "selected_quote",
                text: "Unproven surrounding assertion.",
                selectedQuotes: ['**Proposal:** inspect the "prism".'],
              },
            ],
            verifiedReferences: [],
            limitation: "Only the selected quote is factual authority.",
          }),
        ],
      }),
    });
    expect(result.label).toBe(label === "entailment" ? "entailment" : "neutral");
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]?.assessment).toBe(mode);
    expect(JSON.parse(server.calls[0]!.answer).contentInContext).toHaveProperty("evidenceSegments");
  } finally {
    await verifier.dispose();
    await server.close();
  }
});
