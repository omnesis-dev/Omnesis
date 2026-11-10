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
 * A prompt longer than the context throws: node-llama-cpp would otherwise
 * erase its beginning (the instructions and the chat template) to make room,
 * and the model would answer what was left as if it were the question.
 *
 * Evaluation is native, but prompt preparation and the sampler run on the
 * main event loop. The distribution is read over the top {@link TOP_K} tokens
 * only: the whole vocabulary (150k–260k entries) costs tens of milliseconds
 * per question to copy into JavaScript. Deployments that care about that
 * latency should serve the role from an HTTP backend instead, which keeps the
 * model out of this process.
 */

import { createHash } from "node:crypto";
import { statSync } from "node:fs";

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

/**
 * The largest context to ask for, capped further by the model's trained
 * length and by what fits in memory. The Brain's urgency decision carries up
 * to 24,000 characters of content, which needs well over 8k tokens.
 */
const MAX_CONTEXT_SIZE = 16_384;
/**
 * Candidates read from the next-token distribution. The labels of a model that
 * is answering are among its most probable tokens; renormalising over the top
 * K slightly overstates their mass, which a 50% floor tolerates.
 */
export const TOP_K = 128;
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

/**
 * `local:<file name>@<fingerprint of size and mtime>`, so weights replaced in
 * place under the same name (another quantisation, a new fine-tune) get a new
 * id and stored answers from the old weights are not reused. A file that
 * cannot be read keeps the bare name; loading it fails anyway.
 */
function localModelId(modelPath: string): string {
  const name = `local:${basenameWithoutExt(modelPath)}`;
  try {
    const { size, mtimeMs } = statSync(modelPath);
    const print = createHash("sha256").update(`${size}:${mtimeMs}`).digest("hex").slice(0, 8);
    return `${name}@${print}`;
  } catch {
    return name;
  }
}

export class LlamaCppDecision implements DecisionCapability {
  /** Re-read on every load, so it always names the weights in memory. */
  modelId: string;
  private loading: Promise<Loaded> | null = null;
  private fence: Promise<unknown> = Promise.resolve();
  private unloadTimer?: ReturnType<typeof setTimeout>;
  private readonly unloadTimeoutMs: number;

  constructor(
    private readonly modelPath: string,
    opts?: { unloadTimeoutMs?: number },
  ) {
    this.modelId = localModelId(modelPath);
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
    { model, context, sequence, chatWrapper }: Loaded,
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
    // The answer needs one free slot after the prompt.
    if (tokens.length >= context.contextSize - 1) {
      throw new Error(
        `The decision prompt is ${tokens.length} tokens, more than the ${context.contextSize}-token ` +
          `context of ${this.modelId} holds`,
      );
    }
    // Keep the prefix the previous question already evaluated; at least one
    // token must be evaluated to produce the next-token distribution.
    await sequence.adaptStateToTokens(tokens, false);
    let start = Math.min(sequence.nextTokenIndex, tokens.length - 1);
    if (start < sequence.nextTokenIndex) {
      await sequence.eraseContextTokenRanges([{ start, end: sequence.nextTokenIndex }]);
      start = sequence.nextTokenIndex;
    }
    // Temperature 1 with nucleus and min-p off, so the reported distribution is
    // the model's softmax over its top K rather than a greedy one-hot. The
    // sampled token is irrelevant, but when it is end-of-generation the
    // evaluation would stop without yielding the distribution unless asked to.
    const evaluation = sequence.evaluateWithMetadata(
      tokens.slice(start),
      { probabilities: true },
      { temperature: 1, topK: TOP_K, topP: 1, minP: 0, yieldEogToken: true },
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
    this.modelId = localModelId(this.modelPath);
    const [llama, instance] = await Promise.all([getLlamaModule(), getLlamaInstance()]);
    const model = await instance.loadModel({ modelPath: this.modelPath });
    try {
      const context = await model.createContext({
        contextSize: { max: Math.min(model.trainContextSize, MAX_CONTEXT_SIZE) },
      });
      const sequence = context.getSequence();
      // Ask thinking models to answer directly: the label must be the first token.
      const chatWrapper = llama.resolveChatWrapper(model, {
        customWrapperSettings: { qwen: { thoughts: "discourage" } },
      });
      log.info(
        `Decision model loaded in ${Date.now() - startMs}ms with a ${context.contextSize}-token context`,
      );
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
