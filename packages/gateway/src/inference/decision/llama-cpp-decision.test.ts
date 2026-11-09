// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionRequest } from "@omnesis/core";

/**
 * A stand-in for node-llama-cpp: a tokenizer over a tiny vocabulary, a chat
 * wrapper that renders the prompt to one token per character, and a sequence
 * that keeps its evaluated tokens and reports a scripted next-token
 * distribution. No model runs.
 */
const VOCAB: Record<string, number> = {
  yes: 1,
  " yes": 2,
  Yes: 3,
  no: 4,
  "0": 10,
  "1": 11,
  "2": 12,
  "3": 13,
  A: 20,
  B: 21,
};

const fake = vi.hoisted(() => ({
  /** Next-token probabilities by token id, chosen from the prompt's labels. */
  distribution: (_user: string) => new Map<number, number>(),
  lastUser: "",
  evaluated: [] as number[][],
  evaluateOptions: [] as unknown[],
  inFlight: 0,
  maxInFlight: 0,
  modelDisposed: 0,
  contextDisposed: 0,
  wrapperSettings: undefined as unknown,
}));

vi.mock("../../llama-instance.js", () => {
  const sequence = {
    contextTokens: [] as number[],
    get nextTokenIndex() {
      return this.contextTokens.length;
    },
    async adaptStateToTokens(tokens: number[]) {
      let i = 0;
      while (
        i < tokens.length &&
        i < this.contextTokens.length &&
        tokens[i] === this.contextTokens[i]
      )
        i++;
      this.contextTokens = this.contextTokens.slice(0, i);
    },
    async eraseContextTokenRanges(ranges: Array<{ start: number; end: number }>) {
      for (const { start, end } of ranges) this.contextTokens.splice(start, end - start);
    },
    evaluateWithMetadata(tokens: number[], _meta: unknown, options: unknown) {
      fake.evaluated.push(tokens);
      fake.evaluateOptions.push(options);
      const self = this;
      return (async function* () {
        fake.inFlight++;
        fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
        await new Promise((r) => setTimeout(r, 5));
        self.contextTokens.push(...tokens);
        fake.inFlight--;
        yield { token: 0, probabilities: fake.distribution(fake.lastUser) };
      })();
    },
  };
  const model = {
    tokenizer: {},
    tokenize: (text: string) => (text in VOCAB ? [VOCAB[text]] : [900, 901]),
    createContext: async () => ({
      getSequence: () => sequence,
      dispose: async () => {
        fake.contextDisposed++;
      },
    }),
    dispose: async () => {
      fake.modelDisposed++;
      sequence.contextTokens = [];
    },
  };
  return {
    getLlamaInstance: async () => ({ loadModel: async () => model }),
    getLlamaModule: async () => ({
      resolveChatWrapper: (_model: unknown, opts: unknown) => {
        fake.wrapperSettings = opts;
        return {
          generateContextState: ({ chatHistory }: { chatHistory: Array<{ text?: string }> }) => {
            const rendered = `${chatHistory[0]!.text}\n${chatHistory[1]!.text}\n<assistant>`;
            fake.lastUser = chatHistory[1]!.text!;
            return {
              contextText: { tokenize: () => [...rendered].map((c) => 1000 + c.charCodeAt(0)) },
            };
          },
        };
      },
    }),
  };
});

const { LlamaCppDecision } = await import("./llama-cpp-decision.js");

const request: DecisionRequest = {
  state: { subject: "Invoice due", body: "Due 12 Nov." },
  questions: {
    worth: {
      type: "score",
      instructions: "Worth recording?",
      criteria: ["No.", "Minor.", "Yes.", "Important."],
    },
    bill: { type: "noul", instructions: "Is this a bill to pay?" },
    route: { type: "choice", instructions: "Route it.", criteria: { record: null, skip: null } },
  },
};

beforeEach(() => {
  fake.distribution = (user) => {
    if (user.includes("(0, 1, 2, 3)"))
      return new Map([
        [12, 0.6],
        [13, 0.3],
        [900, 0.1],
      ]);
    if (user.includes("(yes, no)"))
      return new Map([
        [1, 0.5],
        [2, 0.2],
        [4, 0.2],
        [900, 0.1],
      ]);
    return new Map([
      [20, 0.2],
      [21, 0.8],
    ]);
  };
  fake.evaluated = [];
  fake.evaluateOptions = [];
  fake.inFlight = 0;
  fake.maxInFlight = 0;
  fake.modelDisposed = 0;
  fake.contextDisposed = 0;
});

describe("LlamaCppDecision", () => {
  it("answers each question from the next-token probabilities of its labels", async () => {
    const decision = new LlamaCppDecision("/models/decider-1b.Q4_K_M.gguf");
    const result = await decision.decide(request);
    await decision.dispose();

    expect(result.model).toBe("local:decider-1b.Q4_K_M");
    expect(decision.modelId).toBe("local:decider-1b.Q4_K_M");
    const worth = result.answers.worth;
    expect(worth).toMatchObject({ type: "score" });
    if (worth?.type !== "score") throw new Error("unreachable");
    expect(worth.score).toBeCloseTo((2 * 0.6 + 3 * 0.3) / 0.9);
    // yes + " yes" against no.
    expect((result.answers.bill as { noul: number }).noul).toBeCloseTo(0.7 / 0.9);
    expect(result.answers.route).toMatchObject({ type: "choice", choice: "skip" });
    // The full softmax, not a greedy one-hot.
    expect(fake.evaluateOptions[0]).toEqual({ temperature: 1, topK: 0, topP: 1, minP: 0 });
    expect(fake.wrapperSettings).toMatchObject({
      customWrapperSettings: { qwen: { thoughts: "discourage" } },
    });
  });

  it("re-evaluates only what follows the content prefix the previous question shared", async () => {
    const decision = new LlamaCppDecision("/models/decider.gguf");
    const result = await decision.decide(request);
    await decision.dispose();
    const [first, second] = fake.evaluated;
    expect(second!.length).toBeLessThan(first!.length);
    expect(result.inputTokens).toBeGreaterThan(first!.length);
  });

  it("evaluates the last token again when a prompt repeats exactly", async () => {
    const decision = new LlamaCppDecision("/models/decider.gguf");
    const one = { state: "x", questions: { bill: request.questions.bill! } };
    await decision.decide(one);
    await decision.decide(one);
    await decision.dispose();
    expect(fake.evaluated[1]).toHaveLength(1);
  });

  it("runs concurrent decisions one at a time", async () => {
    const decision = new LlamaCppDecision("/models/decider.gguf");
    await Promise.all([
      decision.decide(request),
      decision.decide(request),
      decision.decide(request),
    ]);
    await decision.dispose();
    expect(fake.maxInFlight).toBe(1);
    expect(fake.evaluated).toHaveLength(9);
  });

  it("throws when the labels do not dominate, and keeps serving later calls", async () => {
    const decision = new LlamaCppDecision("/models/decider.gguf");
    const real = fake.distribution;
    fake.distribution = () =>
      new Map([
        [900, 0.95],
        [1, 0.05],
      ]);
    await expect(decision.decide(request)).rejects.toThrow(/answer labels/);
    fake.distribution = real;
    await expect(decision.decide(request)).resolves.toMatchObject({
      answers: { route: { choice: "skip" } },
    });
    await decision.dispose();
  });

  it("frees the model on dispose, after in-flight work", async () => {
    const decision = new LlamaCppDecision("/models/decider.gguf");
    const pending = decision.decide(request);
    const disposed = decision.dispose();
    await expect(pending).resolves.toBeDefined();
    await disposed;
    expect(fake.contextDisposed).toBe(1);
    expect(fake.modelDisposed).toBe(1);
  });
});
