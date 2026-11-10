// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The HTTP side every decision API client shares: the auth header, the
 * inference URL policy, the per-attempt timeout, retries with backoff for
 * rate limiting and overload, and the backend's concurrency limit.
 */

import { setTimeout as delay } from "node:timers/promises";
import {
  assertNever,
  createLogger,
  fetchWithInferenceUrlPolicy,
  type DecisionAuth,
} from "@omnesis/core";
import type { ConcurrencyLimiter } from "./limiter.js";

const log = createLogger("gateway:decision:transport");

export interface DecisionTransportOptions {
  url: string;
  /** Omitted for a server that runs without one. */
  apiKey?: string;
  auth?: DecisionAuth;
  allowRemoteInference: boolean;
  /** Names the provider in error messages, e.g. "TypeSafe" or "Ollaya". */
  label?: string;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Retries after the first attempt for 425 / 429 / 529 / 5xx / network errors. */
  maxRetries?: number;
  /** Shared by every client of one backend, so a burst queues instead of timing out. */
  limiter?: ConcurrencyLimiter;
  /** Test seams. */
  fetchFn?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 10_000;
const REQUEST_ID_HEADERS = ["x-typesafe-request-id", "x-request-id", "cf-ray"];

/** A decision request the server answered with an error status. */
export class DecisionHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DecisionHttpError";
  }
}

export class DecisionTransport {
  readonly label: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly opts: DecisionTransportOptions) {
    this.label = opts.label ?? "Decision server";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleep = opts.sleep ?? ((ms, signal) => delay(ms, undefined, signal ? { signal } : {}));
  }

  /** POST a JSON body and return the parsed JSON reply, or throw. */
  post(url: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const run = () => this.send(url, JSON.stringify(body), signal);
    return this.opts.limiter ? this.opts.limiter.run(run, signal) : run();
  }

  private async send(url: string, body: string, callSignal?: AbortSignal): Promise<unknown> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const signal = callSignal
        ? AbortSignal.any([callSignal, AbortSignal.timeout(this.timeoutMs)])
        : AbortSignal.timeout(this.timeoutMs);
      let response: Response;
      try {
        response = await fetchWithInferenceUrlPolicy(
          url,
          { method: "POST", headers: this.headers(), body, signal },
          {
            allowRemoteInference: this.opts.allowRemoteInference,
            ...(this.opts.fetchFn ? { fetchFn: this.opts.fetchFn } : {}),
          },
        );
      } catch (err) {
        if (callSignal?.aborted) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries) {
          await this.sleep(backoffMs(attempt, null), callSignal);
          continue;
        }
        break;
      }
      if (response.ok) return response.json();
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      const requestId = REQUEST_ID_HEADERS.map((h) => response.headers.get(h)).find(Boolean);
      lastError = new DecisionHttpError(
        response.status,
        `${this.label} HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}: ${detail || response.statusText}`,
      );
      if (!isRetryable(response.status) || attempt >= this.maxRetries) break;
      const wait = backoffMs(attempt, response.headers.get("retry-after"));
      log.debug(`${this.label} ${response.status}; retrying in ${wait}ms`);
      await this.sleep(wait, callSignal);
    }
    throw lastError ?? new Error(`${this.label} request failed`);
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...decisionAuthHeaders(this.opts.auth ?? "bearer", this.opts.apiKey),
    };
  }
}

/** The header a decision provider expects its key in; none without a key. */
export function decisionAuthHeaders(
  auth: DecisionAuth,
  apiKey: string | undefined,
): Record<string, string> {
  if (!apiKey) return {};
  switch (auth) {
    case "bearer":
      return { authorization: `Bearer ${apiKey}` };
    case "api-key":
      return { "api-key": apiKey };
    case "x-api-key":
      return { "x-api-key": apiKey };
    default:
      return assertNever(auth);
  }
}

/** 425 is Fastino's "model warming up"; 529 is TypeSafe's "overloaded". */
function isRetryable(status: number): boolean {
  return status === 425 || status === 429 || status === 529 || status >= 500;
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS);
}
