// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Entailment loader + judge adapter tests.
 *
 * The loader is tested per resolution kind;
 * the judge adapter is tested structurally — style selection from the config
 * knob, verdict parsing (labels, Yes/No mapping, junk → throws), and the
 * usage callback — never by asserting prompt content verbatim. Fixture data
 * is invented.
 */

import { describe, expect, test, vi } from "vitest";
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
