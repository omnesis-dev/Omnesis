// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * TypeSafe System One client — the `typesafe/<model>` backend of the
 * decision capability.
 *
 * One request per decision: `POST <url>` with `{model, state, questions}` and a
 * bearer key; the reply carries one typed answer per question and the billed
 * input tokens (output is free). Rate limiting (429) and overload (529, 5xx)
 * are retried with backoff, honouring `retry-after`; every other failure —
 * a rejected key, a validation error, a malformed reply — throws, because the
 * capability contract is "throw rather than guess" and callers fail open.
 */

import {
  createLogger,
  fetchWithInferenceUrlPolicy,
  type DecisionAnswer,
  type DecisionCapability,
  type DecisionRequest,
  type DecisionResult,
} from "@omnesis/core";

const log = createLogger("gateway:decision:typesafe");

export interface TypeSafeDecisionOptions {
  url: string;
  model: string;
  apiKey: string;
  allowRemoteInference: boolean;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Retries after the first attempt for 429 / 529 / 5xx / network errors. */
  maxRetries?: number;
  /** Test seams. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 10_000;

export class TypeSafeDecision implements DecisionCapability {
  readonly modelId: string;
  private readonly opts: Required<Omit<TypeSafeDecisionOptions, "fetchFn">> & {
    fetchFn?: typeof fetch;
  };

  constructor(opts: TypeSafeDecisionOptions) {
    this.modelId = opts.model;
    this.opts = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...opts,
    };
  }

  async decide(
    request: DecisionRequest,
    callOpts?: { signal?: AbortSignal },
  ): Promise<DecisionResult> {
    const body = JSON.stringify({
      model: this.opts.model,
      state: request.state,
      questions: request.questions,
    });
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt += 1) {
      const signal = callOpts?.signal
        ? AbortSignal.any([callOpts.signal, AbortSignal.timeout(this.opts.timeoutMs)])
        : AbortSignal.timeout(this.opts.timeoutMs);
      let response: Response;
      try {
        response = await fetchWithInferenceUrlPolicy(
          this.opts.url,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.opts.apiKey}`,
            },
            body,
            signal,
          },
          {
            allowRemoteInference: this.opts.allowRemoteInference,
            ...(this.opts.fetchFn ? { fetchFn: this.opts.fetchFn } : {}),
          },
        );
      } catch (err) {
        if (callOpts?.signal?.aborted) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.opts.maxRetries) {
          await this.opts.sleep(backoffMs(attempt, null));
          continue;
        }
        break;
      }
      if (response.ok) return parseResponse(await response.json(), request);
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      const requestId = response.headers.get("x-typesafe-request-id");
      lastError = new Error(
        `TypeSafe HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}: ${detail || response.statusText}`,
      );
      if (!isRetryable(response.status) || attempt >= this.opts.maxRetries) break;
      const wait = backoffMs(attempt, response.headers.get("retry-after"));
      log.debug(`TypeSafe ${response.status}; retrying in ${wait}ms`);
      await this.opts.sleep(wait);
    }
    throw lastError ?? new Error("TypeSafe request failed");
  }

  dispose(): void {}
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * Exported for tests.
 *
 * Validate the reply against the questions asked. A reply missing an answer,
 * or carrying an answer of the wrong type, is a malformed reply — never
 * papered over with a default.
 */
export function parseResponse(raw: unknown, request: DecisionRequest): DecisionResult {
  const body = raw as { model?: unknown; answers?: unknown; usage?: { input_tokens?: unknown } };
  if (!body || typeof body !== "object" || typeof body.model !== "string") {
    throw new Error("TypeSafe reply has no model id");
  }
  if (!body.answers || typeof body.answers !== "object") {
    throw new Error("TypeSafe reply has no answers");
  }
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = (body.answers as Record<string, unknown>)[id] as
      | Record<string, unknown>
      | undefined;
    if (!answer || answer.type !== question.type) {
      throw new Error(`TypeSafe reply lacks a ${question.type} answer for "${id}"`);
    }
    answers[id] = validateAnswer(id, answer);
  }
  const inputTokens = body.usage?.input_tokens;
  return {
    model: body.model,
    answers,
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
  };
}

function validateAnswer(id: string, answer: Record<string, unknown>): DecisionAnswer {
  const probabilities = numberRecord(answer.probabilities);
  const confidence = typeof answer.confidence === "number" ? answer.confidence : undefined;
  switch (answer.type) {
    case "noul":
      if (typeof answer.noul !== "number") throw new Error(`TypeSafe noul "${id}" has no value`);
      return { type: "noul", noul: answer.noul };
    case "score":
      if (typeof answer.score !== "number") throw new Error(`TypeSafe score "${id}" has no value`);
      return {
        type: "score",
        score: answer.score,
        ...(confidence === undefined ? {} : { confidence }),
        ...(probabilities ? { probabilities } : {}),
      };
    case "choice":
      if (typeof answer.choice !== "string")
        throw new Error(`TypeSafe choice "${id}" has no value`);
      return {
        type: "choice",
        choice: answer.choice,
        ...(confidence === undefined ? {} : { confidence }),
        ...(probabilities ? { probabilities } : {}),
      };
    default:
      throw new Error(`TypeSafe answer "${id}" has unknown type`);
  }
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "number") out[k] = v;
  return out;
}
