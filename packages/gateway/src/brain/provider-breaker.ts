// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The drainer's guard against a model backend that is refusing every call.
 *
 * When a provider is down — an exhausted account, a rejected key, a bad
 * gateway — every claimed run fails the same way. Without a guard the drainer
 * keeps claiming on its ordinary cadence, so an outage becomes a steady stream
 * of doomed requests against a backend that cannot serve them, and a log full
 * of identical errors that buries anything else.
 *
 * The runs themselves are already safe: a `provider`-scope failure refunds its
 * attempt, so nothing is retired and no document is consumed while the
 * environment is broken. This exists for the other two costs — the pointless
 * traffic, and the operator's ability to see that the brain is stopped and
 * why.
 *
 * Deliberately not a general-purpose circuit breaker. There is no half-open
 * probe count and no failure-rate window: after the cooldown the drainer simply
 * claims again, and that claim IS the probe. One success closes it.
 */

/** Consecutive provider-scope failures before the drainer stops claiming. */
export const PROVIDER_BREAKER_THRESHOLD = 3;

/** First cooldown, doubling per consecutive trip. */
const PROVIDER_BREAKER_BASE_COOLDOWN_MS = 60_000;

/**
 * Ceiling on the cooldown.
 *
 * Fifteen minutes rather than hours: the cost of probing too eagerly is one
 * failed request, while the cost of probing too lazily is that a topped-up
 * account sits idle. An operator who has just fixed the problem should not
 * have to restart the gateway to be believed.
 */
export const PROVIDER_BREAKER_MAX_COOLDOWN_MS = 15 * 60_000;

export interface ProviderBreakerState {
  /** Consecutive provider-scope failures since the last success. */
  consecutiveFailures: number;
  /** Trips since the last success — the cooldown's exponent. */
  trips: number;
  /** Epoch ms before which the drainer must not claim; 0 when closed. */
  openUntil: number;
  /** The failure that tripped it, for the operator. Empty when closed. */
  lastError: string;
}

export function newProviderBreakerState(): ProviderBreakerState {
  return { consecutiveFailures: 0, trips: 0, openUntil: 0, lastError: "" };
}

export function breakerCooldownMs(trips: number): number {
  const exp = Math.max(0, trips - 1);
  return Math.min(PROVIDER_BREAKER_MAX_COOLDOWN_MS, PROVIDER_BREAKER_BASE_COOLDOWN_MS * 2 ** exp);
}

/**
 * Fold one settled run into the breaker.
 *
 * `providerScoped` is the only failure that counts toward tripping: a run that
 * failed on its own content proves the backend is answering, which is exactly
 * what the breaker wants to know, so it resets the streak like a success does.
 */
export function recordRunOutcome(
  state: ProviderBreakerState,
  outcome: { providerScoped: boolean; error?: string },
  now: number,
): ProviderBreakerState {
  if (!outcome.providerScoped) return newProviderBreakerState();
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures < PROVIDER_BREAKER_THRESHOLD) {
    return { ...state, consecutiveFailures, lastError: outcome.error ?? state.lastError };
  }
  const trips = state.trips + 1;
  return {
    consecutiveFailures,
    trips,
    openUntil: now + breakerCooldownMs(trips),
    lastError: outcome.error ?? state.lastError,
  };
}

/** Whether the drainer must skip claiming right now. */
export function breakerIsOpen(state: ProviderBreakerState, now: number): boolean {
  return state.openUntil > now;
}

/** Engine-state keys mirroring the breaker for operator-facing surfaces. */
export const PROVIDER_BREAKER_OPEN_UNTIL_KEY = "provider_breaker_open_until";
export const PROVIDER_BREAKER_ERROR_KEY = "provider_breaker_error";
export const PROVIDER_BREAKER_FAILURES_KEY = "provider_breaker_failures";

/**
 * Whether the transition between two breaker states is worth persisting.
 *
 * The mirror is for a human reading a panel, not for the breaker itself, which
 * keeps its own state in memory. Writing on every failure would put a write on
 * the hot path of an outage — precisely when the backend is already producing
 * one settle per claimed run — so only the open/closed edge is recorded.
 */
export function breakerMirrorChanged(
  before: ProviderBreakerState,
  after: ProviderBreakerState,
): boolean {
  return before.openUntil !== after.openUntil;
}
