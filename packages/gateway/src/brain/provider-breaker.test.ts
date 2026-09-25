// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The breaker's arithmetic. What it guards — the drainer declining to claim —
 * is asserted against a real queue in the drainer and bench suites; here the
 * concern is only when it opens, for how long, and what closes it.
 */

import { describe, expect, test } from "vitest";

import {
  breakerCooldownMs,
  breakerIsOpen,
  breakerMirrorChanged,
  newProviderBreakerState,
  recordRunOutcome,
  PROVIDER_BREAKER_MAX_COOLDOWN_MS,
  PROVIDER_BREAKER_THRESHOLD,
  type ProviderBreakerState,
} from "./provider-breaker.js";

const NOW = 1_700_000_000_000;
const fail = (state = newProviderBreakerState(), now = NOW, error = "HTTP 412") =>
  recordRunOutcome(state, { providerScoped: true, error }, now);

describe("opening", () => {
  test("tolerates failures below the threshold without stopping work", () => {
    // A single bad response is not an outage. Stopping the brain on one
    // failure would make a transient blip look identical to a dead account.
    let state = newProviderBreakerState();
    for (let i = 1; i < PROVIDER_BREAKER_THRESHOLD; i++) {
      state = fail(state);
      expect(breakerIsOpen(state, NOW)).toBe(false);
    }
    state = fail(state);
    expect(breakerIsOpen(state, NOW)).toBe(true);
  });

  test("a run that failed on its own content closes it, because the backend answered", () => {
    // The breaker's question is "is the backend reachable", and a request-scope
    // verdict is proof that it is. Counting it would let a run of malformed
    // documents halt a perfectly healthy brain.
    let state = fail(fail());
    expect(state.consecutiveFailures).toBe(2);
    state = recordRunOutcome(state, { providerScoped: false }, NOW);
    expect(state.consecutiveFailures).toBe(0);
    expect(breakerIsOpen(state, NOW)).toBe(false);
  });

  test("a success closes it", () => {
    let state = newProviderBreakerState();
    for (let i = 0; i < PROVIDER_BREAKER_THRESHOLD; i++) state = fail(state);
    expect(breakerIsOpen(state, NOW)).toBe(true);
    state = recordRunOutcome(state, { providerScoped: false }, NOW);
    expect(breakerIsOpen(state, NOW)).toBe(false);
    expect(state.trips).toBe(0);
  });
});

describe("cooldown", () => {
  test("backs off per consecutive trip and stops at the ceiling", () => {
    expect(breakerCooldownMs(1)).toBe(60_000);
    expect(breakerCooldownMs(2)).toBe(120_000);
    expect(breakerCooldownMs(99)).toBe(PROVIDER_BREAKER_MAX_COOLDOWN_MS);
  });

  test("the ceiling stays short enough that a fixed account resumes on its own", () => {
    // The failure mode this guards: an operator tops up, sees nothing happen,
    // and restarts the gateway to force a retry. Fifteen minutes is the promise
    // that they never need to.
    expect(PROVIDER_BREAKER_MAX_COOLDOWN_MS).toBeLessThanOrEqual(15 * 60_000);
  });

  test("closes on its own once the cooldown elapses", () => {
    let state = newProviderBreakerState();
    for (let i = 0; i < PROVIDER_BREAKER_THRESHOLD; i++) state = fail(state);
    expect(breakerIsOpen(state, state.openUntil - 1)).toBe(true);
    expect(breakerIsOpen(state, state.openUntil)).toBe(false);
  });
});

describe("mirroring", () => {
  test("only the open/closed edge is worth a write", () => {
    // Otherwise an outage puts a write on the hot path of every settle.
    const one = fail();
    expect(breakerMirrorChanged(newProviderBreakerState(), one)).toBe(false);
    const tripped = fail(fail(one));
    expect(breakerMirrorChanged(one, tripped)).toBe(true);
    expect(breakerMirrorChanged(tripped, tripped)).toBe(false);
  });
});

describe("a sustained outage", () => {
  /** Failures as they really arrive: the next attempt is the breaker reopening. */
  function outage(rounds: number): { gapsMinutes: number[]; state: ProviderBreakerState } {
    let state = newProviderBreakerState();
    let now = NOW;
    const gapsMinutes: number[] = [];
    for (let i = 0; i < rounds; i++) {
      const before = state.openUntil;
      state = recordRunOutcome(state, { providerScoped: true, error: "HTTP 412" }, now);
      if (state.openUntil === before) continue;
      gapsMinutes.push((state.openUntil - now) / 60_000);
      now = state.openUntil;
    }
    return { gapsMinutes, state };
  }

  test("keeps slowing down, and settles at the ceiling", () => {
    // The cadence an operator actually experiences, and the reason it is
    // asserted here rather than left to arithmetic: the per-run backoff cannot
    // provide it. That ramp is keyed on `attempts`, which a refund resets, so
    // it stays flat at the base delay for exactly the failures this paces.
    // The pacing therefore lives entirely in the breaker, and a change that
    // weakened it would restore a one-per-minute hammer against a dead backend
    // with nothing else to catch it.
    expect(outage(8).gapsMinutes).toEqual([1, 2, 4, 8, 15, 15]);
  });

  test("never shortens the wait while the backend keeps failing", () => {
    const { gapsMinutes } = outage(20);
    const sorted = [...gapsMinutes].sort((a, b) => a - b);
    expect(gapsMinutes).toEqual(sorted);
    expect(gapsMinutes.at(-1)! * 60_000).toBe(PROVIDER_BREAKER_MAX_COOLDOWN_MS);
  });
});
