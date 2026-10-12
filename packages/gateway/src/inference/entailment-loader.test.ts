// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Entailment loader + judge adapter tests.
 *
 * The loader is tested per resolution kind;
 * the judge adapter is tested structurally — style selection from the config
 * knob, guardrail delivery, verdict parsing (labels, Yes/No mapping, junk →
 * throws), and the usage callback. Scripted replies do not test model accuracy.
 * Fixture data is invented.
 */

import { describe, expect, test, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import * as credentials from "../model-credentials.js";
import { prepareContextualWitnessRequest } from "./contextual-segments.js";
import { annotationEntailmentPrompt } from "./annotation-entailment.js";
import { HttpCompleter } from "./http-completer.js";
import {
  LlmJudgeEntailmentVerifier,
  loadEntailmentFromResolved,
  type EntailmentCompleter,
  type EntailmentPromptStyle,
  type EntailmentUsage,
} from "./entailment-loader.js";
import type { ResolvedAssignment } from "@omnesis/core";

const INPUT = {
  claim: "the deposit was paid on the fifth",
  evidence: "we sent the deposit on the fifth",
};

function fakeCompleter(
  reply: string,
  opts: { usage?: { promptTokens: number; completionTokens: number } | null } = {},
): EntailmentCompleter & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    modelId: "fake-judge",
    prompts,
    // eslint-disable-next-line @typescript-eslint/require-await
    complete: async (prompt) => {
      prompts.push(prompt);
      return { text: reply, usage: opts.usage ?? null };
    },
    dispose: () => {},
  };
}

function judge(
  completer: EntailmentCompleter,
  style: EntailmentPromptStyle = "judge",
  recordUsage?: (u: EntailmentUsage) => void,
): LlmJudgeEntailmentVerifier {
  return new LlmJudgeEntailmentVerifier({
    completer,
    getPromptStyle: () => style,
    ...(recordUsage ? { recordUsage } : {}),
  });
}

describe("LlmJudgeEntailmentVerifier — parsing", () => {
  test.each([
    ["ENTAILMENT", "entailment"],
    ["  neutral\n", "neutral"],
    ["Contradiction.", "contradiction"],
    ["The answer is NEUTRAL because the quote only shows a request.", "neutral"],
  ] as const)("judge style: %j → %s", async (reply, label) => {
    const verdict = await judge(fakeCompleter(reply)).verify(INPUT);
    expect(verdict.label).toBe(label);
    expect(verdict.raw).toBe(reply.trim());
  });

  test("judge style: an explicit verdict wins over a negated mention", async () => {
    const verdict = await judge(
      fakeCompleter("CONTRADICTION — definitely not ENTAILMENT here"),
    ).verify(INPUT);
    expect(verdict.label).toBe("contradiction");
  });

  test.each([
    // A negated ENTAILMENT is a reject-side answer, never a pass.
    ["No entailment", "neutral"],
    ["There is no entailment here.", "neutral"],
    ["Not entailment.", "neutral"],
    // The final line carries the verdict of a chatty judge — recency wins.
    ["Entailment would require possession. The quote shows a request. NEUTRAL", "neutral"],
  ] as const)("judge style, negation/recency: %j → %s", async (reply, label) => {
    const verdict = await judge(fakeCompleter(reply)).verify(INPUT);
    expect(verdict.label).toBe(label);
  });

  test("judge style: a reasoning model's think-block never supplies the verdict", async () => {
    const verdict = await judge(
      fakeCompleter(
        "<think>could be entailment... weighing entailment vs neutral</think>\nNEUTRAL",
      ),
    ).verify(INPUT);
    expect(verdict.label).toBe("neutral");
    // An unclosed think-block with no verdict after it is unparseable.
    await expect(
      judge(fakeCompleter("<think>entailment entailment entailment")).verify(INPUT),
    ).rejects.toThrow(/no parseable/i);
  });

  test.each([
    ["Yes", "entailment"],
    ["no", "neutral"],
    ["Yes, the document supports the claim.", "entailment"],
  ] as const)("minicheck style: %j → %s", async (reply, label) => {
    const verdict = await judge(fakeCompleter(reply), "minicheck").verify(INPUT);
    expect(verdict.label).toBe(label);
  });

  test("an unparseable answer throws (verifier-unavailable, never a verdict)", async () => {
    await expect(judge(fakeCompleter("I cannot decide, sorry")).verify(INPUT)).rejects.toThrow(
      /no parseable/i,
    );
    await expect(judge(fakeCompleter("maybe? unclear"), "minicheck").verify(INPUT)).rejects.toThrow(
      /no parseable/i,
    );
  });

  test("minicheck style never reads the three-label vocabulary as a verdict", async () => {
    // A chat model mistakenly assigned with minicheck style answers with a
    // label instead of Yes/No — that must surface as unavailable, not as a
    // silent misparse.
    await expect(judge(fakeCompleter("ENTAILMENT"), "minicheck").verify(INPUT)).rejects.toThrow(
      /no parseable/i,
    );
  });
});

describe("LlmJudgeEntailmentVerifier — style selection + usage", () => {
  test("judge instructions require support for every factual clause, time scope, and advice premise", async () => {
    const input = {
      evidence: "The pond gate latch was loose last autumn.",
      claim: "The latch was loose last autumn; repair it because it remains loose today.",
    };
    const completer = fakeCompleter("NEUTRAL");
    await judge(completer).verify(input);
    const prompt = completer.prompts[0]!;
    expect(prompt).toContain(input.evidence);
    expect(prompt).toContain(input.claim);
    expect(prompt.indexOf("CONTRADICTION only")).toBeLessThan(prompt.indexOf("Evidence quote:"));
    expect(prompt).toContain("every factual clause and implied factual premise must be supported");
    expect(prompt).toContain("does not establish that the condition persists now");
    expect(prompt).toContain(
      "Missing later evidence establishes neither resolution nor non-resolution",
    );
    expect(prompt).toContain(
      "Advice or a recommendation does not excuse an unsupported factual premise",
    );
    // This pins the instructions delivered to the backend, not model accuracy.
    // MiniCheck retains its trained Document/Claim format rather than chat instructions.
    const mini = fakeCompleter("No");
    await judge(mini, "minicheck").verify(input);
    expect(mini.prompts[0]).toBe(`Document: ${input.evidence}\nClaim: ${input.claim}`);
  });

  test("style is read live per call from the config knob", async () => {
    const completer = fakeCompleter("Yes ENTAILMENT"); // parseable under both styles
    let style: EntailmentPromptStyle = "judge";
    const verifier = new LlmJudgeEntailmentVerifier({
      completer,
      getPromptStyle: () => style,
    });
    await verifier.verify(INPUT);
    style = "minicheck";
    await verifier.verify(INPUT);
    // The minicheck convention is the bare Document/Claim pair; the judge
    // prompt is instruction-shaped. Assert structure, not wording.
    expect(completer.prompts).toHaveLength(2);
    expect(completer.prompts[1]).toBe(`Document: ${INPUT.evidence}\nClaim: ${INPUT.claim}`);
    expect(completer.prompts[0]).not.toBe(completer.prompts[1]);
    expect(completer.prompts[0]).toContain(INPUT.claim);
    expect(completer.prompts[0]).toContain(INPUT.evidence);
    expect(completer.prompts[0]).toContain("a bare ‘I’ or ‘you’ is otherwise NEUTRAL");
  });

  test("fires the usage callback with the transport's decoded usage", async () => {
    const recorded: EntailmentUsage[] = [];
    const completer = fakeCompleter("neutral", {
      usage: { promptTokens: 42, completionTokens: 3 },
    });
    await judge(completer, "judge", (u) => recorded.push(u)).verify(INPUT);
    expect(recorded).toEqual([{ promptTokens: 42, completionTokens: 3, modelId: "fake-judge" }]);
  });

  test("reports zeros when the transport carries no usage (local/anthropic paths)", async () => {
    const recorded: EntailmentUsage[] = [];
    await judge(fakeCompleter("entailment"), "judge", (u) => recorded.push(u)).verify(INPUT);
    expect(recorded).toEqual([{ promptTokens: 0, completionTokens: 0, modelId: "fake-judge" }]);
  });

  test("dispose delegates to the completer", async () => {
    const dispose = vi.fn();
    const completer: EntailmentCompleter = {
      modelId: "m",
      // eslint-disable-next-line @typescript-eslint/require-await
      complete: async () => ({ text: "neutral", usage: null }),
      dispose,
    };
    await judge(completer).dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("loadEntailmentFromResolved", () => {
  const deps = {
    configDir: "/tmp/omnesis-entailment-loader-test-nonexistent",
    getPromptStyle: () => "judge" as const,
  };

  test("disabled → null (role unset = gate absent)", async () => {
    const resolved: ResolvedAssignment = { role: "entailment-verifier", kind: "disabled" };
    expect(await loadEntailmentFromResolved(resolved, deps)).toBeNull();
  });

  test("unresolved → null", async () => {
    const resolved: ResolvedAssignment = {
      role: "entailment-verifier",
      kind: "unresolved",
      reason: 'Unknown backend "typo"',
    };
    expect(await loadEntailmentFromResolved(resolved, deps)).toBeNull();
  });

  test("local + unavailable → null (model not on disk)", async () => {
    const resolved: ResolvedAssignment = {
      role: "entailment-verifier",
      kind: "local",
      catalogId: "tiny-judge",
      modelPath: "/models/missing.gguf",
      available: false,
    };
    expect(await loadEntailmentFromResolved(resolved, deps)).toBeNull();
  });

  test("http + available → a verifier over an HttpCompleter", async () => {
    const resolved: ResolvedAssignment = {
      role: "entailment-verifier",
      kind: "http",
      backendKey: "judge",
      url: "http://127.0.0.1:9999",
      model: "tiny-judge-model",
      allowRemoteInference: false,
      available: true,
    };
    const verifier = await loadEntailmentFromResolved(resolved, deps);
    expect(verifier).toBeInstanceOf(LlmJudgeEntailmentVerifier);
    await verifier?.dispose();
  });

  test("http + unavailable → null", async () => {
    const resolved: ResolvedAssignment = {
      role: "entailment-verifier",
      kind: "http",
      backendKey: "judge",
      url: "http://127.0.0.1:9999",
      model: "tiny-judge-model",
      allowRemoteInference: false,
      available: false,
      reason: "Backend down",
    };
    expect(await loadEntailmentFromResolved(resolved, deps)).toBeNull();
  });

  test("anthropic without remote inference → null; without an API key → null", async () => {
    const noEgress: ResolvedAssignment = {
      role: "entailment-verifier",
      kind: "anthropic",
      catalogId: "anthropic/claude-haiku",
      apiModelId: "claude-haiku-4-5",
      allowRemoteInference: false,
      available: true,
    };
    expect(await loadEntailmentFromResolved(noEgress, deps)).toBeNull();
    const noKey: ResolvedAssignment = { ...noEgress, allowRemoteInference: true };
    // deps.configDir holds no credentials file, so the key lookup fails.
    expect(await loadEntailmentFromResolved(noKey, deps)).toBeNull();
  });

  test("replay and Codex without a runtime → null", async () => {
    expect(
      await loadEntailmentFromResolved({ role: "entailment-verifier", kind: "replay" }, deps),
    ).toBeNull();
    expect(
      await loadEntailmentFromResolved(
        {
          role: "entailment-verifier",
          kind: "codex",
          model: "gpt-5.4",
          allowRemoteInference: true,
          available: true,
        },
        deps,
      ),
    ).toBeNull();
  });
});

describe("HttpCompleter.completeWithUsage", () => {
  test("decodes the OpenAI usage field and returns it with the text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "ENTAILMENT" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 17, completion_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const completer = new HttpCompleter({
        baseUrl: "http://127.0.0.1:9999",
        model: "tiny-judge-model",
      });
      const res = await completer.completeWithUsage("q");
      expect(res.text).toBe("ENTAILMENT");
      expect(res.usage).toEqual({ promptTokens: 17, completionTokens: 2 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("sums usage across the internal reasoning-model retry", async () => {
    // Primary answer: empty content + finish_reason "length" (a reasoning
    // model burned the whole budget thinking) — the completer re-issues once
    // with a larger budget, and the decoded usage must be the SUM of both.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: { prompt_tokens: 10, completion_tokens: 512 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "NEUTRAL" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 40 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const completer = new HttpCompleter({
        baseUrl: "http://127.0.0.1:9999",
        model: "tiny-judge-model",
      });
      const res = await completer.completeWithUsage("q");
      expect(res.text).toBe("NEUTRAL");
      expect(res.usage).toEqual({ promptTokens: 20, completionTokens: 552 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("returns null usage when the server reports none", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: "no" }, finish_reason: "stop" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const completer = new HttpCompleter({
        baseUrl: "http://127.0.0.1:9999",
        model: "tiny-judge-model",
      });
      const res = await completer.completeWithUsage("q");
      expect(res.usage).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("contextual verification transport", () => {
  test("bounds malformed contextual recovery to two completions and accounts for both", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue({ text: "ENTAILMENT", usage: { promptTokens: 45, completionTokens: 3 } });
    const recordUsage = vi.fn();
    const verifier = judge(
      { modelId: "scripted-context", complete, dispose() {} },
      "judge",
      recordUsage,
    );
    await expect(
      verifier.verify({ ...INPUT, context: "Generic historical overview" }),
    ).rejects.toThrow("Contextual entailment assessment unavailable");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledWith(expect.stringContaining("contentInContext"), {
      maxTokens: 2048,
      temperature: 0,
    });
    const prompt = complete.mock.calls[0]![0] as string;
    expect(prompt).toContain("Preserve inherited restrictions");
    expect(JSON.parse(prompt.split("\n").at(-1)!)).toMatchObject({
      evidence: { text: [{ id: "s0", text: INPUT.evidence }] },
      context: "Generic historical overview",
      claim: INPUT.claim,
    });
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledWith({
      promptTokens: 45,
      completionTokens: 3,
      modelId: "scripted-context",
    });
  });
  test("refuses contextual MiniCheck before paying for an unsupported protocol", async () => {
    const completer = fakeCompleter("Yes");
    await expect(
      judge(completer, "minicheck").verify({ ...INPUT, context: "A named project" }),
    ).rejects.toThrow("MiniCheck cannot verify interpretation context");
    expect(completer.prompts).toEqual([]);
  });
  test("returns structured neutral without requiring a source quote for rejection", async () => {
    const negative = {
      verdict: "unsupported",
      reason: "Missing association",
      evidenceSegments: [],
    };
    const completer = fakeCompleter(
      JSON.stringify({
        witnessSet: prepareContextualWitnessRequest({ ...INPUT, context: "A named project" })
          .witnessSet,
        contentInContext: null,
        placementSupport: negative,
      }),
    );
    expect((await judge(completer).verify({ ...INPUT, context: "A named project" })).label).toBe(
      "neutral",
    );
  });
});

test("holds oversized contextual evidence before calling the paid completer", async () => {
  const completer = fakeCompleter("ENTAILMENT");
  await expect(
    judge(completer).verify({ ...INPUT, evidence: "界".repeat(90_000), context: "Factual note" }),
  ).rejects.toThrow("bounded input budget");
  expect(completer.prompts).toEqual([]);
});

const contextualSupported = JSON.stringify({
  witnessSet: prepareContextualWitnessRequest({ ...INPUT, context: "Historical context" })
    .witnessSet,
  contentInContext: {
    verdict: "supported",
    reason: "Original evidence supports the assertion",
    evidenceSegments: ["s0"],
  },
  placementSupport: {
    verdict: "not_applicable",
    reason: "No additional placement",
    evidenceSegments: [],
  },
});

test.each(["entailment", "neutral"] as const)(
  "re-evaluates invalid contextual output once and accepts a valid %s verdict",
  async (label) => {
    const final =
      label === "entailment"
        ? contextualSupported
        : JSON.stringify({
            witnessSet: prepareContextualWitnessRequest({ ...INPUT, context: "Historical context" })
              .witnessSet,
            contentInContext: {
              verdict: "unsupported",
              reason: "Evidence insufficient",
              evidenceSegments: [],
            },
            placementSupport: null,
          });
    const invalid = contextualSupported.replace('"s0"', '"invented witness"');
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ text: invalid, usage: { promptTokens: 10, completionTokens: 2 } })
      .mockResolvedValueOnce({ text: final, usage: { promptTokens: 12, completionTokens: 3 } });
    const recordUsage = vi.fn();
    const signal = new AbortController().signal;
    const verifier = judge({ modelId: "scripted", complete, dispose() {} }, "judge", recordUsage);
    expect((await verifier.verify({ ...INPUT, context: "Historical context", signal })).label).toBe(
      label,
    );
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls.every((call) => call[1].signal === signal)).toBe(true);
    const original = complete.mock.calls[0]![0] as string;
    const retry = complete.mock.calls[1]![0] as string;
    expect(retry).toContain("witness_outside_authority");
    expect(retry.endsWith(original)).toBe(true);
    expect(retry).not.toContain("invented witness");
    expect(retry).not.toContain('"signal"');
    expect(recordUsage.mock.calls.map(([usage]) => usage.promptTokens)).toEqual([10, 12]);
    expect(recordUsage.mock.calls.map(([usage]) => usage.completionTokens)).toEqual([2, 3]);
  },
);

test("does not retry valid contextual rejection or transport failure", async () => {
  const negative = JSON.stringify({
    witnessSet: prepareContextualWitnessRequest({ ...INPUT, context: "Scope" }).witnessSet,
    contentInContext: { verdict: "unsupported", reason: "No support", evidenceSegments: [] },
    placementSupport: null,
  });
  const complete = vi.fn().mockResolvedValue({ text: negative, usage: null });
  const verifier = judge({ modelId: "scripted", complete, dispose() {} });
  expect((await verifier.verify({ ...INPUT, context: "Scope" })).label).toBe("neutral");
  expect(complete).toHaveBeenCalledTimes(1);
  complete.mockReset().mockRejectedValue(new Error("transport unavailable"));
  await expect(verifier.verify({ ...INPUT, context: "Scope" })).rejects.toThrow(
    "transport unavailable",
  );
  expect(complete).toHaveBeenCalledTimes(1);
});

test("counts an in-flight completion but neither releases nor retries after cancellation", async () => {
  const abort = new AbortController();
  const complete = vi.fn().mockImplementation(async () => {
    abort.abort();
    return { text: "invalid", usage: { promptTokens: 7, completionTokens: 1 } };
  });
  const recordUsage = vi.fn();
  const verifier = judge({ modelId: "scripted", complete, dispose() {} }, "judge", recordUsage);
  await expect(
    verifier.verify({ ...INPUT, context: "Scope", signal: abort.signal }),
  ).rejects.toThrow();
  expect(complete).toHaveBeenCalledTimes(1);
  expect(recordUsage).toHaveBeenCalledWith({
    promptTokens: 7,
    completionTokens: 1,
    modelId: "scripted",
  });
  await expect(
    verifier.verify({ ...INPUT, context: "Scope", signal: abort.signal }),
  ).rejects.toThrow();
  expect(complete).toHaveBeenCalledTimes(1);
});

describe("annotation-only atomic assessment", () => {
  const input = {
    ...INPUT,
    context: "Generic annotation",
    assessment: "annotation_atomic" as const,
  };
  const reply = JSON.stringify({
    coverage: { verdict: "complete", reason: "Scripted coverage" },
    assertions: [
      {
        id: "a1",
        spans: [{ text: INPUT.claim, occurrence: 0 }],
        candidate: {
          actor: null,
          action: null,
          target: null,
          stage: null,
          time: null,
          condition: null,
          quantifier: null,
        },
        verdict: "supported",
        reason: "Scripted result",
        evidenceQuotes: [INPUT.evidence],
      },
    ],
    placementSupport: { verdict: "not_applicable", reason: "Generic note", evidenceQuotes: [] },
  });
  test("selects the atomic wire only for an explicit annotation assessment", async () => {
    const completer = fakeCompleter(reply);
    const usage = vi.fn();
    expect(
      (
        await judge(completer, "judge", usage).verify({
          ...input,
          signal: new AbortController().signal,
        })
      ).label,
    ).toBe("entailment");
    expect(completer.prompts).toHaveLength(1);
    expect(JSON.parse(completer.prompts[0]!.split("\n").at(-1)!)).toEqual(input);
    expect(usage).toHaveBeenCalledTimes(1);
    await expect(judge(fakeCompleter(reply)).verify(INPUT)).rejects.toThrow("no parseable");
  });
  test("malformed atomic output is unavailable without spending a repair call", async () => {
    const completer = fakeCompleter('{"coverage":');
    const usage = vi.fn();
    await expect(judge(completer, "judge", usage).verify(input)).rejects.toMatchObject({
      name: "AnnotationAssessmentError",
      category: "assessment_schema",
      annotationFailure: "response_format",
    });
    expect(completer.prompts).toEqual([annotationEntailmentPrompt(input)]);
    expect(completer.prompts).toHaveLength(1);
    expect(usage).toHaveBeenCalledTimes(1);
  });
  test("spans that leave claim words uncovered get one repair call naming those words", async () => {
    const partial = JSON.parse(reply) as {
      assertions: Array<{ spans: Array<{ text: string; occurrence: number }> }>;
    };
    const words = INPUT.claim.split(" ");
    partial.assertions[0]!.spans = [{ text: words.slice(0, -1).join(" "), occurrence: 0 }];
    const replies = [JSON.stringify(partial), reply];
    const prompts: string[] = [];
    const completer: EntailmentCompleter = {
      modelId: "fake-judge",
      // eslint-disable-next-line @typescript-eslint/require-await
      complete: async (prompt) => {
        prompts.push(prompt);
        return { text: replies.shift() ?? JSON.stringify(partial), usage: null };
      },
      dispose: () => {},
    };
    expect((await judge(completer).verify(input)).label).toBe("entailment");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(`outside every assertion's spans: "fifth".`);
    expect(prompts[1]!.endsWith(annotationEntailmentPrompt(input))).toBe(true);

    const stubborn = fakeCompleter(JSON.stringify(partial));
    await expect(judge(stubborn).verify(input)).rejects.toMatchObject({
      name: "AnnotationAssessmentError",
      annotationFailure: "coverage",
    });
    expect(stubborn.prompts).toHaveLength(2);
  });
  test("MiniCheck refuses unsupported atomic assessment before paid inference", async () => {
    const completer = fakeCompleter("Yes");
    await expect(judge(completer, "minicheck").verify(input)).rejects.toThrow("unavailable");
    expect(completer.prompts).toHaveLength(0);
  });
});

test("forwards caller cancellation to the Anthropic SDK without serializing it", async () => {
  const key = vi.spyOn(credentials, "resolveAnthropicApiKey").mockReturnValue("fictional-key");
  const controller = new AbortController();
  const create = vi
    .spyOn(Anthropic.Messages.prototype, "create")
    .mockImplementation((body, options) => {
      expect(JSON.stringify(body)).not.toContain("signal");
      expect(options?.signal).toBe(controller.signal);
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      }) as ReturnType<Anthropic.Messages["create"]>;
    });
  try {
    const capability = await loadEntailmentFromResolved(
      {
        role: "entailment-verifier",
        kind: "anthropic",
        catalogId: "fictional-judge",
        apiModelId: "fictional-judge",
        available: true,
        allowRemoteInference: true,
      },
      { configDir: "/unused", getPromptStyle: () => "judge" },
    );
    const checking = expect(
      capability!.verify({ ...INPUT, signal: controller.signal }),
    ).rejects.toThrow("caller stopped");
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    controller.abort(new Error("caller stopped"));
    await checking;
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    create.mockRestore();
    key.mockRestore();
  }
});
