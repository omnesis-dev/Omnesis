// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Decision capability over an OpenAI-compatible chat server — the
 * `<httpBackend>/<model>` backend of the decision role (llama-server, vLLM,
 * Ollama, or any server that returns token log-probabilities).
 *
 * One `/chat/completions` request per question: one output token at
 * temperature 0 with `logprobs` and `top_logprobs`, read as a distribution
 * over the question's labels (see `chat-decision.ts`). The questions of one
 * request run concurrently and share the content prefix, so a server with a
 * prompt cache evaluates it once.
 *
 * The answer must be the first token, so a model that reasons first never
 * gives one. Unless the operator set the model's reasoning controls, every
 * request asks for thinking off in the two common spellings: the chat-template
 * switch vLLM, SGLang and llama-server pass to Qwen-style templates, and
 * DeepSeek's `thinking` field. Servers differ in what they accept, so a 400
 * that names one of these fields, or a `top_logprobs` above the server's cap
 * (TGI and Fireworks allow 5), is retried once without the field or with
 * fewer alternatives, and the adjustment is kept for later requests.
 *
 * A server that returns no log-probabilities cannot serve the role: the call
 * throws, as does a reply whose next token is not a label, and callers fail
 * open. Rate limits are retried by the shared `retryRateLimitedRequest`.
 */

import {
  createLogger,
  fetchWithInferenceUrlPolicy,
  normalizeApiPathPrefix,
  retryRateLimitedRequest,
  type DecisionAnswer,
  type DecisionCapability,
  type DecisionQuestion,
  type DecisionRequest,
  type DecisionResult,
} from "@omnesis/core";
import { modelReasoningRequestFields } from "@omnesis/agent";
import {
  answerFromTokenProbabilities,
  decisionOptions,
  renderDecisionPrompt,
  type TokenProbability,
} from "./chat-decision.js";
import type { ModelBehaviorValues, ModelControls } from "@omnesis/core/models";

const log = createLogger("gateway:decision:http");

const DEFAULT_TIMEOUT_MS = 30_000;
/** The OpenAI maximum; servers that allow more gain nothing from it here. */
const TOP_LOGPROBS = 20;
/** What servers that cap the alternatives (TGI, Fireworks, mlx-lm) all allow. */
const FALLBACK_TOP_LOGPROBS = 5;

/** Thinking-off fields sent when the operator set no reasoning controls. */
const THINKING_OFF_FIELDS: Readonly<Record<string, unknown>> = {
  chat_template_kwargs: { enable_thinking: false },
  thinking: { type: "disabled" },
};

export interface HttpChatDecisionOptions {
  /** The backend key the assignment names (`<backendKey>/<model>`). */
  backendKey: string;
  baseUrl: string;
  model: string;
  apiPathPrefix?: string;
  apiKey?: string;
  allowRemoteInference: boolean;
  modelControls?: ModelControls;
  modelBehavior?: ModelBehaviorValues;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Test seams. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface ChatLogprobsResponse {
  choices?: Array<{
    logprobs?: {
      content?: Array<{
        token?: unknown;
        logprob?: unknown;
        top_logprobs?: Array<{ token?: unknown; logprob?: unknown }>;
      }> | null;
    } | null;
  }>;
  usage?: { prompt_tokens?: unknown };
}

export class HttpChatDecision implements DecisionCapability {
  readonly modelId: string;
  private readonly url: string;
  /** Request fields this server accepts, narrowed by the 400s it returned. */
  private topLogprobs = TOP_LOGPROBS;
  private thinkingOff: Record<string, unknown>;

  constructor(private readonly opts: HttpChatDecisionOptions) {
    this.modelId = `http:${opts.backendKey}/${opts.model}`;
    this.url = `${opts.baseUrl.replace(/\/+$/, "")}${normalizeApiPathPrefix(opts.apiPathPrefix)}/chat/completions`;
    // The operator's own reasoning controls, when set, are sent instead.
    const explicit = Object.keys(opts.modelBehavior ?? {}).length > 0;
    this.thinkingOff = explicit ? {} : { ...THINKING_OFF_FIELDS };
  }

  async decide(
    request: DecisionRequest,
    callOpts?: { signal?: AbortSignal },
  ): Promise<DecisionResult> {
    const entries = Object.entries(request.questions);
    const results = await Promise.all(
      entries.map(([, question]) => this.ask(request.state, question, callOpts?.signal)),
    );
    const answers: Record<string, DecisionAnswer> = {};
    let inputTokens: number | undefined;
    for (const [i, [id]] of entries.entries()) {
      const result = results[i]!;
      answers[id] = result.answer;
      if (result.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + result.inputTokens;
    }
    return { model: this.modelId, answers, ...(inputTokens === undefined ? {} : { inputTokens }) };
  }

  private async ask(
    state: unknown,
    question: DecisionQuestion,
    signal: AbortSignal | undefined,
  ): Promise<{ answer: DecisionAnswer; inputTokens?: number }> {
    const options = decisionOptions(question);
    const prompt = renderDecisionPrompt(state, question, options);
    const messages = [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ];
    let res: Response;
    for (let adjusted = false; ; adjusted = true) {
      const body = JSON.stringify({
        model: this.opts.model,
        messages,
        max_tokens: 1,
        temperature: 0,
        logprobs: true,
        top_logprobs: this.topLogprobs,
        ...modelReasoningRequestFields(
          this.opts.modelControls,
          this.opts.modelBehavior,
          "chat-completions",
        ),
        ...this.thinkingOff,
      });
      res = await this.post(body, signal);
      if (res.ok) break;
      // Never echo the body: a backend can reflect the prompt (the user's
      // content) into its error, which would then land in logs. It is only
      // searched for the names of the fields it refused.
      const text = await res.text().catch(() => "");
      if (!adjusted && this.adjustToRefusal(res.status, text)) continue;
      throw new Error(
        `Decision backend ${this.opts.backendKey} HTTP ${res.status} (model=${this.opts.model}, ${text.length} bytes)`,
      );
    }
    const json = (await res.json()) as ChatLogprobsResponse;
    const tokens = topLogprobs(json);
    if (!tokens) {
      throw new Error(
        `Decision backend ${this.opts.backendKey} returned no logprobs for ${this.opts.model}; ` +
          "the decision role needs a server that returns token log-probabilities",
      );
    }
    let answer: DecisionAnswer;
    try {
      answer = answerFromTokenProbabilities(question, options, tokens);
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)} (backend ${this.opts.backendKey}, ` +
          `model ${this.opts.model}; a model that reasons before answering needs its reasoning off)`,
        { cause: err },
      );
    }
    const promptTokens = json.usage?.prompt_tokens;
    return { answer, ...(typeof promptTokens === "number" ? { inputTokens: promptTokens } : {}) };
  }

  /**
   * Narrow the request to what a 400/422 says the server refused. True when
   * something changed and the request is worth sending again.
   */
  private adjustToRefusal(status: number, text: string): boolean {
    if (status !== 400 && status !== 422) return false;
    let changed = false;
    for (const field of Object.keys(this.thinkingOff)) {
      if (!text.includes(field)) continue;
      delete this.thinkingOff[field];
      changed = true;
    }
    if (this.topLogprobs > FALLBACK_TOP_LOGPROBS && /top_?logprobs|top_n_tokens/i.test(text)) {
      this.topLogprobs = FALLBACK_TOP_LOGPROBS;
      changed = true;
    }
    if (changed) {
      log.warn(
        `decision backend ${this.opts.backendKey} refused a request field (HTTP ${status}); ` +
          `retrying with top_logprobs=${this.topLogprobs} and ` +
          `${Object.keys(this.thinkingOff).join(", ") || "no thinking-off fields"}`,
      );
    }
    return changed;
  }

  private post(body: string, signal: AbortSignal | undefined): Promise<Response> {
    signal?.throwIfAborted();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return retryRateLimitedRequest(
      () =>
        fetchWithInferenceUrlPolicy(
          this.url,
          { method: "POST", headers, body, signal: deadline },
          {
            allowRemoteInference: this.opts.allowRemoteInference,
            ...(this.opts.fetchFn ? { fetchFn: this.opts.fetchFn } : {}),
          },
        ),
      {
        signal: deadline,
        ...(this.opts.sleep ? { sleep: this.opts.sleep } : {}),
        onRetry: ({ attempt, delayMs }) =>
          log.warn(
            `decision rate-limited on ${this.opts.backendKey}/${this.opts.model}; ` +
              `retrying attempt ${attempt} after ${delayMs}ms`,
          ),
      },
    );
  }

  dispose(): void {}
}

/**
 * The first output token's candidates as probabilities, or null when the reply
 * carries no log-probabilities. The sampled token itself is included in case a
 * server lists it only outside `top_logprobs`.
 */
export function topLogprobs(json: ChatLogprobsResponse): TokenProbability[] | null {
  const first = json.choices?.[0]?.logprobs?.content?.[0];
  if (!first) return null;
  const seen = new Map<string, number>();
  for (const c of [...(first.top_logprobs ?? []), { token: first.token, logprob: first.logprob }]) {
    if (typeof c.token !== "string" || typeof c.logprob !== "number") continue;
    if (!seen.has(c.token)) seen.set(c.token, Math.exp(c.logprob));
  }
  if (seen.size === 0) return null;
  return [...seen].map(([token, probability]) => ({ token, probability }));
}
