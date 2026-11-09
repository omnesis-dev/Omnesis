// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Decision capability over a local GGUF chat model — the `local/<model>`
 * backend of the decision role, via node-llama-cpp.
 *
 * Each question is rendered through the model's own chat template up to the
 * start of the assistant's reply, evaluated once, and answered from the
 * probabilities of the next token restricted to the question's labels (see
 * `chat-decision.ts`). Nothing is generated. The sequence keeps the evaluated
 * prompt, so the next question re-evaluates only what differs after the shared
 * content prefix.
 *
 * One context sequence serves every call, so decisions run one at a time
 * behind a promise-chain fence; concurrent callers (the worth gate runs four)
 * queue. The model loads on first use and unloads after an idle minute.
 *
 * Evaluation is native, but prompt preparation and the sampler run on the
 * main event loop. Deployments that care about that latency should serve the
 * role from an HTTP backend instead, which keeps the model out of this
 * process.
 */

import {
  createLogger,
  type DecisionAnswer,
  type DecisionCapability,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResult,
} from "@omnesis/core";
import { getLlamaModule, getLlamaInstance } from "../../llama-instance.js";
import {
  answerFromTokenProbabilities,
  decisionOptions,
  renderDecisionPrompt,
  type DecisionOption,
  type TokenProbability,
} from "./chat-decision.js";
import type {
  ChatWrapper,
  LlamaContext,
  LlamaContextSequence,
  LlamaModel,
  Token,
} from "node-llama-cpp";

const log = createLogger("gateway:decision:local");

/** A decision prompt with a 2,000-character excerpt fits comfortably. */
const CONTEXT_SIZE = 8192;
const DEFAULT_UNLOAD_TIMEOUT_MS = 60_000;

interface Loaded {
  model: LlamaModel;
  context: LlamaContext;
  sequence: LlamaContextSequence;
  chatWrapper: ChatWrapper;
}

function basenameWithoutExt(p: string): string {
  const base = p.split(/[/\\]/).pop() ?? p;
  return base.replace(/\.gguf$/i, "");
}

export class LlamaCppDecision implements DecisionCapability {
  readonly modelId: string;
  private loading: Promise<Loaded> | null = null;
  private fence: Promise<unknown> = Promise.resolve();
  private unloadTimer?: ReturnType<typeof setTimeout>;
  private readonly unloadTimeoutMs: number;

  constructor(
    private readonly modelPath: string,
    opts?: { unloadTimeoutMs?: number },
  ) {
    this.modelId = `local:${basenameWithoutExt(modelPath)}`;
    this.unloadTimeoutMs = opts?.unloadTimeoutMs ?? DEFAULT_UNLOAD_TIMEOUT_MS;
  }

  decide(request: DecisionRequest, opts?: { signal?: AbortSignal }): Promise<DecisionResult> {
    const run = this.fence.then(() => this.decideNow(request, opts?.signal));
    this.fence = run.catch(() => {});
    return run;
  }

  private async decideNow(
    request: DecisionRequest,
    signal: AbortSignal | undefined,
  ): Promise<DecisionResult> {
    signal?.throwIfAborted();
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    try {
      const loaded = await this.ensureLoaded();
      const answers: Record<string, DecisionAnswer> = {};
      let inputTokens = 0;
      for (const [id, question] of Object.entries(request.questions)) {
        signal?.throwIfAborted();
        const asked = await this.ask(loaded, request.state, question);
        answers[id] = asked.answer;
        inputTokens += asked.inputTokens;
      }
      return { model: this.modelId, answers, inputTokens };
    } finally {
      this.unloadTimer = setTimeout(() => void this.unload(), this.unloadTimeoutMs);
      this.unloadTimer.unref?.();
    }
  }

  private async ask(
    { model, sequence, chatWrapper }: Loaded,
    state: unknown,
    question: DecisionQuestion,
  ): Promise<{ answer: DecisionAnswer; inputTokens: number }> {
    const options = decisionOptions(question);
    const prompt = renderDecisionPrompt(state, question, options);
    const { contextText } = chatWrapper.generateContextState({
      chatHistory: [
        { type: "system", text: prompt.system },
        { type: "user", text: prompt.user },
        { type: "model", response: [] },
      ],
    });
    const tokens = contextText.tokenize(model.tokenizer);
    // Keep the prefix the previous question already evaluated; at least one
    // token must be evaluated to produce the next-token distribution.
    await sequence.adaptStateToTokens(tokens, false);
    let start = Math.min(sequence.nextTokenIndex, tokens.length - 1);
    if (start < sequence.nextTokenIndex) {
      await sequence.eraseContextTokenRanges([{ start, end: sequence.nextTokenIndex }]);
      start = sequence.nextTokenIndex;
    }
    // Temperature 1 with every truncation off, so the reported distribution is
    // the model's full softmax rather than a greedy one-hot.
    const evaluation = sequence.evaluateWithMetadata(
      tokens.slice(start),
      { probabilities: true },
      { temperature: 1, topK: 0, topP: 1, minP: 0 },
    );
    const first = await evaluation.next();
    await evaluation.return();
    if (first.done) throw new Error(`Local model ${this.modelId} produced no next token`);
    const probabilities = first.value.probabilities;
    const answer = answerFromTokenProbabilities(
      question,
      options,
      labelTokenProbabilities(model, options, probabilities),
    );
    return { answer, inputTokens: tokens.length };
  }

  private ensureLoaded(): Promise<Loaded> {
    this.loading ??= this.load().catch((err: unknown) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async load(): Promise<Loaded> {
    log.info(`Loading decision model: ${this.modelPath}`);
    const startMs = Date.now();
    const [llama, instance] = await Promise.all([getLlamaModule(), getLlamaInstance()]);
    const model = await instance.loadModel({ modelPath: this.modelPath });
    try {
      const context = await model.createContext({ contextSize: { max: CONTEXT_SIZE } });
      const sequence = context.getSequence();
      // Ask thinking models to answer directly: the label must be the first token.
      const chatWrapper = llama.resolveChatWrapper(model, {
        customWrapperSettings: { qwen: { thoughts: "discourage" } },
      });
      log.info(`Decision model loaded in ${Date.now() - startMs}ms`);
      return { model, context, sequence, chatWrapper };
    } catch (err) {
      await model.dispose();
      throw err;
    }
  }

  private async unload(): Promise<void> {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = undefined;
    const loading = this.loading;
    this.loading = null;
    if (!loading) return;
    const loaded = await loading.catch(() => null);
    if (!loaded) return;
    await loaded.context.dispose();
    await loaded.model.dispose();
    log.info(`Decision model unloaded: ${this.modelId}`);
  }

  async dispose(): Promise<void> {
    // Wait for in-flight decisions before freeing the model under them.
    await this.fence;
    await this.unload();
  }
}

/**
 * The probability of every single-token spelling of each label (`yes`,
 * ` yes`, `Yes`, …), read from the model's next-token distribution.
 */
function labelTokenProbabilities(
  model: LlamaModel,
  options: readonly DecisionOption[],
  probabilities: ReadonlyMap<Token, number>,
): TokenProbability[] {
  const seen = new Set<Token>();
  const out: TokenProbability[] = [];
  for (const { label } of options) {
    const capitalized = label.charAt(0).toUpperCase() + label.slice(1);
    for (const variant of new Set([label, capitalized, label.toUpperCase()])) {
      for (const spelling of [variant, ` ${variant}`]) {
        const ids = model.tokenize(spelling, false);
        // A spelling the tokenizer splits is not a label token; the label's
        // other spellings cover it.
        if (ids.length !== 1 || seen.has(ids[0]!)) continue;
        seen.add(ids[0]!);
        out.push({ token: variant, probability: probabilities.get(ids[0]!) ?? 0 });
      }
    }
  }
  return out;
}
