// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  fetchWithInferenceUrlPolicy,
  normalizeApiPathPrefix,
  retryRateLimitedRequest,
  stripThinkTags,
  type CompleteCapability,
} from "@omnesis/core";
import {
  modelReasoningRequestFields,
  outputBudgetForSelectedReasoning,
  preferredReasoningWireProtocol,
  type ReasoningWireProtocol,
} from "@omnesis/agent";
import type { ModelBehaviorValues, ModelControls } from "@omnesis/core/models";

const log = createLogger("inference:http-completer");

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Budget used when retrying a reasoning model. Reasoning/thinking models bill
 * hidden chain-of-thought against the completion-token budget before any
 * visible content, so the small completion budget (~90–150) is exhausted on
 * reasoning alone and the answer comes back empty. A few thousand tokens lets
 * the visible answer through; the retry only fires for reasoning models.
 */
const REASONING_RETRY_TOKENS = 2048;

interface ChatCompletionResponse {
  choices: Array<{
    message: { content?: string | null };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface ResponsesCompletionResponse {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Decoded token usage of one (possibly retried) completion call. */
interface HttpCompletionUsage {
  promptTokens: number;
  completionTokens: number;
}

/** Text + usage of one completion. `usage` is null when the server sent none. */
export interface HttpCompletion {
  text: string;
  usage: HttpCompletionUsage | null;
}

/**
 * CompleteCapability backed by an OpenAI-compatible `/v1/chat/completions`
 * endpoint. Used for HTTP-backed single-shot completions (vLLM, Ollama,
 * llama-server, etc.).
 */
export class HttpCompleter implements CompleteCapability {
  readonly name = "http";
  readonly modelId: string;
  private baseUrl: string;
  private apiPathPrefix: string;
  private timeoutMs: number;
  private apiKey?: string;
  private allowRemoteInference: boolean;
  private readonly modelControls?: ModelControls;
  private readonly modelBehavior?: ModelBehaviorValues;
  private readonly protocol: ReasoningWireProtocol;

  constructor(opts: {
    baseUrl: string;
    model: string;
    apiPathPrefix?: string;
    timeoutMs?: number;
    apiKey?: string;
    allowRemoteInference?: boolean;
    protocol?: ReasoningWireProtocol;
    modelControls?: ModelControls;
    modelBehavior?: ModelBehaviorValues;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiPathPrefix = normalizeApiPathPrefix(opts.apiPathPrefix);
    this.modelId = opts.model;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.apiKey = opts.apiKey;
    this.allowRemoteInference = opts.allowRemoteInference === true;
    this.modelControls = opts.modelControls;
    this.modelBehavior = opts.modelBehavior;
    this.protocol =
      opts.protocol ??
      preferredReasoningWireProtocol(opts.baseUrl, opts.modelControls, opts.modelBehavior) ??
      "chat-completions";
  }

  async complete(
    prompt: string,
    opts?: {
      maxTokens?: number;
      temperature?: number;
      stop?: readonly string[];
    },
  ): Promise<string> {
    return (await this.completeWithUsage(prompt, opts)).text;
  }

  /**
   * Like {@link complete}, but also returns the token usage the server
   * reported (the OpenAI `usage` field), summed across the internal
   * reasoning-model retry when it fires. `usage` is null when the server
   * reports none. Cost-accounted consumers (the entailment verifier) use
   * this; plain-text consumers keep calling `complete`.
   */
  async completeWithUsage(
    prompt: string,
    opts?: {
      maxTokens?: number;
      temperature?: number;
      stop?: readonly string[];
    },
  ): Promise<HttpCompletion> {
    const messages = [{ role: "user", content: prompt }];
    const maxTokens = outputBudgetForSelectedReasoning(
      opts?.maxTokens ?? 150,
      undefined,
      this.modelBehavior?.reasoningBudgetTokens,
    );
    if (this.protocol === "responses") {
      return this.completeViaResponses(prompt, maxTokens);
    }
    const reasoningFields = modelReasoningRequestFields(
      this.modelControls,
      this.modelBehavior,
      "chat-completions",
    );

    // Preferred shape — accepted by the vast majority of chat models.
    const primary: Record<string, unknown> = {
      model: this.modelId,
      messages,
      max_tokens: maxTokens,
      temperature: opts?.temperature ?? 0.3,
      ...reasoningFields,
    };
    if (opts?.stop && opts.stop.length > 0) {
      primary.stop = [...opts.stop];
    }

    // Budget for the reasoning-model retry: never below the caller's request.
    const reasoningBudget = Math.max(maxTokens, REASONING_RETRY_TOKENS);

    let res = await this.post(primary);

    // Reasoning models (OpenAI o-series, GPT-5, …) reject `max_tokens` and a
    // non-default `temperature` with a 400. Retry once with the shape they
    // accept — `max_completion_tokens`, default temperature, no `stop` — and a
    // budget large enough to fit hidden reasoning tokens before the visible
    // answer, so they work without Omnesis having to recognize which they are.
    let bumpedBudget = false;
    if (res.status === 400) {
      res = await this.post({
        model: this.modelId,
        messages,
        max_completion_tokens: reasoningBudget,
        ...reasoningFields,
      });
      bumpedBudget = true;
    }

    if (!res.ok) {
      // Never put the upstream response body in the thrown/logged error: a
      // malicious or misconfigured backend can echo the submitted prompt
      // (which carries the user's query) back in its 4xx/5xx body, which would
      // then persist in logs. Drain the body but report only metadata.
      await this.throwHttpError(res);
    }

    // Sum reported usage across the primary call and any internal retry —
    // every billed call counts, not just the one whose text is returned.
    let usage: HttpCompletionUsage | null = null;
    const addUsage = (j: ChatCompletionResponse): void => {
      if (!j.usage) return;
      usage = {
        promptTokens: (usage?.promptTokens ?? 0) + (j.usage.prompt_tokens ?? 0),
        completionTokens: (usage?.completionTokens ?? 0) + (j.usage.completion_tokens ?? 0),
      };
    };

    let json = (await res.json()) as ChatCompletionResponse;
    addUsage(json);
    let content = json.choices?.[0]?.message?.content ?? "";

    // Some reasoning models accept the request (HTTP 200) but spend the whole
    // budget on hidden chain-of-thought (or an inline <think> block), returning
    // empty content with finish_reason "length". Re-issue once with the larger
    // budget so query expansion isn't silently disabled. (Skip if we already
    // bumped the budget on the 400 path.)
    if (
      !bumpedBudget &&
      stripThinkTags(content).trim() === "" &&
      json.choices?.[0]?.finish_reason === "length"
    ) {
      const retry = await this.post({
        model: this.modelId,
        messages,
        max_completion_tokens: reasoningBudget,
        ...reasoningFields,
      });
      if (retry.ok) {
        json = (await retry.json()) as ChatCompletionResponse;
        addUsage(json);
        content = json.choices?.[0]?.message?.content ?? "";
      }
    }

    // Strip inline <think>…</think> reasoning so it never reaches the expansion
    // parser (it has no labels and would just be discarded as noise anyway).
    content = stripThinkTags(content);
    log.debug(`HTTP completion: model=${this.modelId} tokens=${content.length}`);
    return { text: content, usage };
  }

  private async completeViaResponses(prompt: string, maxTokens: number): Promise<HttpCompletion> {
    const reasoningFields = modelReasoningRequestFields(
      this.modelControls,
      this.modelBehavior,
      "responses",
    );
    const res = await this.postTo("responses", {
      model: this.modelId,
      input: prompt,
      max_output_tokens:
        Object.keys(reasoningFields).length > 0
          ? Math.max(maxTokens, REASONING_RETRY_TOKENS)
          : maxTokens,
      ...reasoningFields,
    });
    if (!res.ok) await this.throwHttpError(res);

    const json = (await res.json()) as ResponsesCompletionResponse;
    const text =
      json.output_text ??
      json.output
        ?.flatMap((item) => item.content ?? [])
        .filter((item) => item.type === "output_text" && typeof item.text === "string")
        .map((item) => item.text ?? "")
        .join("") ??
      "";
    const usage = json.usage
      ? {
          promptTokens: json.usage.input_tokens ?? 0,
          completionTokens: json.usage.output_tokens ?? 0,
        }
      : null;
    const content = stripThinkTags(text);
    log.debug(`HTTP completion: model=${this.modelId} tokens=${content.length}`);
    return { text: content, usage };
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    return this.postTo("chat/completions", body);
  }

  private async postTo(path: string, body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    const deadline = AbortSignal.timeout(this.timeoutMs);
    return retryRateLimitedRequest(
      () =>
        fetchWithInferenceUrlPolicy(
          `${this.baseUrl}${this.apiPathPrefix}/${path}`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: deadline,
          },
          { allowRemoteInference: this.allowRemoteInference },
        ),
      {
        signal: deadline,
        onRetry: ({ attempt, delayMs }) =>
          log.warn(
            `completion rate-limited for model=${this.modelId}; ` +
              `retrying attempt ${attempt} after ${delayMs}ms`,
          ),
      },
    );
  }

  private async throwHttpError(res: Response): Promise<never> {
    const text = await res.text().catch(() => "");
    const contentType = res.headers.get("content-type") ?? "?";
    throw new Error(
      `HTTP completer ${res.status} (model=${this.modelId}, ${text.length} bytes, ${contentType})`,
    );
  }

  async dispose(): Promise<void> {}
}
