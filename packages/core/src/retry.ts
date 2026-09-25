// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Generic async retry-with-exponential-backoff primitive.
 *
 * Replaces five+ near-identical retry loops scattered across the
 * collector, gateway, and provider packages — each one re-derived
 * its own attempt counter, backoff schedule, and Retry-After parse.
 * The differences between them were two-line decisions
 * (which-errors-are-transient, what-extra-budget-does-Retry-After-buy)
 * worth a proper option, not a fork.
 *
 * Hooks:
 *
 * - `shouldRetry(err, attempt)` — gate on whether the caught error is
 *   transient. Default: every error is retried until `maxAttempts`.
 *
 * - `computeBackoff(err, attempt, defaultMs)` — replace the default
 *   exponential backoff for a given error. Useful when the server
 *   sent a `Retry-After` header or the Notion / Strava SDKs surface a
 *   structured rate-limit hint that should override the schedule.
 *   Returning the `defaultMs` arg keeps the standard schedule.
 *
 * - `onRetry(err, attempt, delayMs)` — telemetry hook called once per
 *   retry. Use it to log + bump a counter; never use it to mutate
 *   state the next attempt depends on.
 *
 * - `sleep(ms)` — swappable so tests can fake the clock without
 *   depending on a particular timer-mock library.
 *
 * This primitive is **async** by design — the synchronous
 * SQLITE_BUSY-retry helper in `gateway/src/data/retry.ts` lives
 * inside a sync write path that must not unwind to the event loop;
 * its needs aren't a fit and it stays bespoke. The two collector
 * retries (`http-gateway-client.ts`, `gateway-config.ts`) likewise
 * carry domain-specific semantics — backpressure budget exemption
 * and infinite-retry-with-cache-fallback — that don't model cleanly
 * here and stay bespoke for now.
 */

export interface RetryOptions<E = unknown> {
  /** Max attempts including the first try. Defaults to 4. */
  maxAttempts?: number;
  /** Base backoff in ms for the first retry. Defaults to 100. */
  baseBackoffMs?: number;
  /** Cap per-attempt backoff (Math.min at the cap). Defaults to Infinity. */
  maxBackoffMs?: number;
  /**
   * Decide whether an error is transient and should trigger a retry.
   * `attempt` is the 1-indexed attempt number that just failed.
   * Returning `false` re-throws immediately. Default: retry every
   * error until `maxAttempts` is exhausted.
   */
  shouldRetry?: (err: E, attempt: number) => boolean;
  /**
   * Override the computed backoff for a given error. The default
   * exponential schedule is passed in as `defaultMs`; return it
   * unchanged to keep it, or return a different value (e.g. a
   * `Retry-After` header parsed off `err`). Capping with
   * `maxBackoffMs` happens AFTER this hook.
   */
  computeBackoff?: (err: E, attempt: number, defaultMs: number) => number;
  /**
   * Called once per retry, after `shouldRetry` agreed and the
   * backoff has been computed. `delayMs` is the actual wait,
   * post-cap. Use for logging + metrics; do not mutate state the
   * next attempt depends on.
   */
  onRetry?: (err: E, attempt: number, delayMs: number) => void;
  /** Swappable sleep — tests inject a fake. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying with exponential backoff on errors that
 * `shouldRetry` accepts. Throws the last error after `maxAttempts`.
 */
export async function retry<T, E = unknown>(
  fn: () => Promise<T>,
  opts: RetryOptions<E> = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseBackoffMs = opts.baseBackoffMs ?? 100;
  const maxBackoffMs = opts.maxBackoffMs ?? Number.POSITIVE_INFINITY;
  const shouldRetry = opts.shouldRetry ?? (() => true);
  const sleep = opts.sleep ?? defaultSleep;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const typedErr = err as E;
      if (attempt === maxAttempts || !shouldRetry(typedErr, attempt)) {
        throw err;
      }
      const defaultMs = baseBackoffMs * 2 ** (attempt - 1);
      const computed = opts.computeBackoff
        ? opts.computeBackoff(typedErr, attempt, defaultMs)
        : defaultMs;
      const delayMs = Math.min(Math.max(0, computed), maxBackoffMs);
      opts.onRetry?.(typedErr, attempt, delayMs);
      await sleep(delayMs);
    }
  }
  // Unreachable — the loop either returns from `fn()` or throws on the
  // final attempt. Kept to satisfy the type checker.
  throw lastErr;
}
