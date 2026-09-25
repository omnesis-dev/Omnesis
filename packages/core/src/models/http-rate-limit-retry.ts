// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_TOTAL_DELAY_MS = 15_000;
const DEFAULT_BASE_DELAY_MS = 1_000;

/**
 * How long a caller is willing to wait out a provider's rate limit. The
 * defaults suit a person waiting on the reply: a short burst limit is retried,
 * a quota reset measured in minutes fails fast so they can decide what to do.
 */
export interface RateLimitPatience {
  /** Requests sent in total, the first one included. */
  maxAttempts?: number;
  /** Sum of the waits between attempts; the requests' own time is not counted. */
  maxTotalDelayMs?: number;
}

/**
 * Patience for work that runs as a task nobody is watching token by token, such
 * as an Answer task and its privacy review. A per-minute token quota typically
 * resets within a minute, so this waits out one or two resets instead of
 * failing a task the provider would have served shortly after.
 */
export const BACKGROUND_RATE_LIMIT_PATIENCE: Readonly<Required<RateLimitPatience>> = {
  maxAttempts: 5,
  maxTotalDelayMs: 180_000,
};

export interface HttpRateLimitRetryOptions extends RateLimitPatience {
  signal?: AbortSignal;
  baseDelayMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (detail: { attempt: number; delayMs: number }) => void;
}

/**
 * Return the provider's suggested delay for a 429, without retaining or
 * exposing its headers. Standard Retry-After takes precedence. Exhausted
 * Cerebras-style dimensions set the required floor; if none is literally at
 * zero, use the soonest reset because a weighted token request can be rejected
 * when its reservation is larger than a still-positive remainder.
 */
export function rateLimitRetryDelayMs(headers: Headers, nowMs = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }

  const resets: Array<{ delayMs: number; exhausted: boolean | undefined }> = [];
  headers.forEach((value, name) => {
    const prefix = "x-ratelimit-reset-";
    if (!name.startsWith(prefix)) return;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    const remaining = headers.get(`x-ratelimit-remaining-${name.slice(prefix.length)}`);
    const parsedRemaining = remaining === null ? undefined : Number(remaining);
    resets.push({
      delayMs: seconds * 1_000,
      exhausted:
        parsedRemaining === undefined || !Number.isFinite(parsedRemaining)
          ? undefined
          : parsedRemaining <= 0,
    });
  });
  const exhausted = resets.filter((entry) => entry.exhausted === true);
  if (exhausted.length > 0) return Math.max(...exhausted.map((entry) => entry.delayMs));
  return resets.length > 0 ? Math.min(...resets.map((entry) => entry.delayMs)) : undefined;
}

function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry an HTTP request only when it returns 429, before any response is
 * consumed. `request` receives the 1-based attempt number, so a caller can give
 * each attempt its own deadline.
 */
export async function retryRateLimitedRequest(
  request: (attempt: number) => Promise<Response>,
  options: HttpRateLimitRetryOptions = {},
): Promise<Response> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const maxTotalDelayMs = Math.max(0, options.maxTotalDelayMs ?? DEFAULT_MAX_TOTAL_DELAY_MS);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  let totalDelayMs = 0;

  for (let attempt = 1; ; attempt += 1) {
    const response = await request(attempt);
    if (response.status !== 429 || attempt >= maxAttempts) return response;

    const exponentialMs = baseDelayMs * 2 ** (attempt - 1);
    const jitteredMs = exponentialMs * (0.8 + 0.4 * random());
    // A provider's reset time is shared by every request it rejected, so it is
    // jittered upward: concurrent callers that all hit the same quota spread
    // out after the reset instead of colliding with it again at once.
    const providerDelayMs =
      (rateLimitRetryDelayMs(response.headers, now()) ?? 0) * (1 + 0.1 * random());
    const delayMs = Math.ceil(Math.max(jitteredMs, providerDelayMs));
    if (totalDelayMs + delayMs > maxTotalDelayMs) return response;

    await response.body?.cancel().catch(() => undefined);
    options.onRetry?.({ attempt: attempt + 1, delayMs });
    await sleep(delayMs, options.signal);
    totalDelayMs += delayMs;
  }
}
