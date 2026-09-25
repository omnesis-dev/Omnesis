// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The model the compiler talks to, behind an interface it can be tested
 * without.
 *
 * Two implementations, and the split is deliberate. `ScriptedModel` replays a
 * fixed list of replies, which is what every test in this package uses: a test
 * that reached the network would be a test whose result depends on a model's
 * mood, and the compiler's own logic — the repair loop, the diagnostics
 * feedback, the revision pass — is exactly what deserves a deterministic test.
 * `OpenAiCompatibleModel` is the real one, and it is reachable only through
 * environment variables, so nothing in the tree names an endpoint or holds a
 * credential.
 *
 * Usage is returned alongside the text rather than logged, because the caller
 * is the only thing that knows whether it is running one query or six hundred.
 * Cache accounting is part of it: the prompt is built with a static prefix
 * precisely so a provider that prices cached input differently can charge for
 * it once, and a run that stops seeing cache hits has lost that property and
 * should be able to notice.
 */

import { z } from "zod";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ModelUsage {
  readonly promptTokens: number;
  /** Of `promptTokens`, how many the provider served from its prefix cache. */
  readonly cachedPromptTokens: number;
  readonly completionTokens: number;
}

export interface ModelReply {
  readonly text: string;
  readonly usage: ModelUsage;
}

export interface ChatModel {
  /** Identifies the model in reports. Not a credential and not an endpoint. */
  readonly name: string;
  complete(messages: readonly ChatMessage[]): Promise<ModelReply>;
}

export const NO_USAGE: ModelUsage = {
  promptTokens: 0,
  cachedPromptTokens: 0,
  completionTokens: 0,
};

/** Add two usage records. Reports accumulate across a run of many calls. */
export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    cachedPromptTokens: a.cachedPromptTokens + b.cachedPromptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
  };
}

/**
 * A model that replays prepared replies in order.
 *
 * Exhaustion throws rather than returning a default: a compiler loop that asks
 * one more question than the test scripted has taken a path the test does not
 * describe, and silently handing it an empty string would let that pass.
 */
export class ScriptedModel implements ChatModel {
  readonly name = "scripted";
  /** Every message list this model was asked to complete, in order. */
  readonly calls: (readonly ChatMessage[])[] = [];
  private next = 0;

  /**
   * `usagePerReply` is what each reply claims to have cost.
   *
   * Not zero by default: a compiler that dropped a turn's usage would be
   * invisible against a model that reports none, and how many tokens a run
   * spent is a number the evaluation prints and a person acts on.
   */
  constructor(
    private readonly replies: readonly string[],
    private readonly usagePerReply: ModelUsage = {
      promptTokens: 10,
      cachedPromptTokens: 4,
      completionTokens: 2,
    },
  ) {}

  complete(messages: readonly ChatMessage[]): Promise<ModelReply> {
    // Copied, not referenced: the caller appends to the same array between
    // calls, so a stored reference would show every later turn's messages as
    // though they had been present on this one.
    this.calls.push([...messages]);
    const text = this.replies[this.next];
    if (text === undefined) {
      throw new Error(
        `scripted model exhausted after ${this.replies.length} replies; the compiler asked for one more`,
      );
    }
    this.next += 1;
    return Promise.resolve({ text, usage: this.usagePerReply });
  }

  /** What this model has claimed so far, for a test to compare against. */
  get claimed(): ModelUsage {
    return {
      promptTokens: this.usagePerReply.promptTokens * this.next,
      cachedPromptTokens: this.usagePerReply.cachedPromptTokens * this.next,
      completionTokens: this.usagePerReply.completionTokens * this.next,
    };
  }

  /** Replies prepared but never asked for — an over-scripted test. */
  get unused(): number {
    return this.replies.length - this.next;
  }
}

export interface OpenAiCompatibleOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /**
   * Reasoning models spend completion tokens before they write anything, and
   * a watch document is thousands of tokens on its own. A ceiling sized for
   * the answer alone truncates the reply mid-JSON, which the loop then reads
   * as a parse failure and spends a repair turn on — so the default is
   * generous rather than tight.
   */
  readonly maxTokens?: number;
  readonly temperature?: number;
  /**
   * How long one request may take before it is abandoned.
   *
   * Without one, a provider that accepts a connection and then says nothing
   * hangs the whole run: a sweep is hundreds of sequential turns, and one of
   * them waiting forever is indistinguishable from a machine that has stopped.
   * Abandoning it makes "hung" an outcome the harness records and carries on
   * from, rather than a state it sits in.
   */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * Any OpenAI-compatible chat-completions endpoint.
 *
 * Deliberately the whole of the provider integration: one POST, no streaming,
 * no tool calling. The compiler asks for a JSON document and parses it, which
 * makes a malformed answer a *measurable* outcome rather than a provider-level
 * retry — and "the model did not emit parseable JSON" is one of the failure
 * classes the evaluation is meant to count.
 */
export class OpenAiCompatibleModel implements ChatModel {
  readonly name: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly body: { model: string; max_tokens: number; temperature: number };
  /**
   * The credential lives in a closure rather than a field.
   *
   * TypeScript's `private` is a compile-time promise and nothing more: a field
   * holding the key is an enumerable own property, so `JSON.stringify(model)`
   * or a logged config object writes it out — which a harness recording what it
   * ran against would plausibly do. Held this way there is nothing to
   * enumerate.
   */
  private readonly authorize: () => string;

  constructor(options: OpenAiCompatibleOptions) {
    const apiKey = options.apiKey;
    this.authorize = () => `Bearer ${apiKey}`;
    this.name = options.model;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.body = {
      model: options.model,
      max_tokens: options.maxTokens ?? 32_768,
      temperature: options.temperature ?? 0,
    };
  }

  async complete(messages: readonly ChatMessage[]): Promise<ModelReply> {
    // Abandoned rather than waited on. The signal is passed to `fetch` so the
    // socket is closed too, and the timer is cleared on every path so a
    // finished request does not hold the process open.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      return await this.request(messages, abort.signal);
    } catch (error) {
      if (abort.signal.aborted) {
        throw new Error(`chat completion gave up after ${this.timeoutMs}ms`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One request, under a signal that covers all of it.
   *
   * `fetch` resolves when the *headers* arrive, so a deadline cleared at that
   * point leaves the body unguarded — and a provider returning 200 and then
   * stalling mid-stream is the ordinary shape of a hung endpoint. Reading the
   * body inside the same window is what makes the deadline mean the request
   * rather than the handshake.
   */
  private async request(
    messages: readonly ChatMessage[],
    signal: AbortSignal,
  ): Promise<ModelReply> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.authorize() },
      body: JSON.stringify({ ...this.body, messages }),
      signal,
    });

    if (!response.ok) {
      // The body can echo request content, and the request carries no secret,
      // but the header does — so the status line is all that is reported.
      throw new Error(`chat completion failed: ${response.status} ${response.statusText}`);
    }

    // A 200 carrying something other than JSON — a proxy interstitial, an error
    // page from something sitting in front of the model — is a transport
    // failure rather than an unreadable answer, and saying so beats a syntax
    // error from a parser the caller never invoked.
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new Error(`chat completion returned ${response.status} with a body that is not JSON`);
    }

    // Parsed, not cast: this is an external payload, and a provider that
    // answers with content parts rather than a string would otherwise hand a
    // non-string onwards under a type claiming it is one.
    const body = chatCompletionSchema.parse(raw);
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        cachedPromptTokens:
          body.usage?.prompt_cache_hit_tokens ??
          body.usage?.prompt_tokens_details?.cached_tokens ??
          0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/**
 * The response shape this client reads.
 *
 * Everything is optional, because the provider is only promised to be
 * OpenAI-*compatible* and a missing field should degrade a count to zero rather
 * than end a run. What is not optional is the *type* of what is present: a
 * `content` arriving as an array of parts has to fail here rather than travel
 * onwards typed as a string. Unknown keys are ignored — a provider is free to
 * send more than this reads.
 */
const chatCompletionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().optional() }).optional() }))
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      prompt_cache_hit_tokens: z.number().optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
    })
    .optional(),
});

/** The environment variables that configure the live model. */
export const MODEL_ENV = {
  baseUrl: "WATCHV2_COMPILER_BASE_URL",
  apiKey: "WATCHV2_COMPILER_API_KEY",
  model: "WATCHV2_COMPILER_MODEL",
} as const;

/**
 * Build the live model from the environment, or say precisely what is missing.
 *
 * There is no fallback endpoint and no default credential. A caller that has
 * not set these is trying to reach a model it has not been given, and the
 * useful answer is which variable to set.
 */
export function modelFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  overrides: Partial<OpenAiCompatibleOptions> = {},
): OpenAiCompatibleModel {
  const missing = Object.values(MODEL_ENV).filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`the compiler model is unconfigured; set ${missing.join(", ")}`);
  }
  return new OpenAiCompatibleModel({
    baseUrl: env[MODEL_ENV.baseUrl]!,
    apiKey: env[MODEL_ENV.apiKey]!,
    model: env[MODEL_ENV.model]!,
    ...overrides,
  });
}
