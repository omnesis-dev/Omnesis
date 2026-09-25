// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The virtual clock: settable now, capability narrowing, and the
 * boot-time env opt-in (unset/anything-else => no clock, the production
 * fallback path).
 */

import { describe, expect, test } from "vitest";
import { asMutableClock, createMutableClock, resolveBriefsVirtualClock } from "./virtual-clock.js";
import { systemClock } from "./storage/types.js";

describe("createMutableClock", () => {
  test("reads the set instant, forward or backward", () => {
    const clock = createMutableClock(1_000);
    expect(clock()).toBe(1_000);
    clock.set(5_000);
    expect(clock()).toBe(5_000);
    clock.set(2_000); // a restarted replay may rewind
    expect(clock()).toBe(2_000);
  });

  test("defaults to wall now and rejects non-finite instants", () => {
    const before = Date.now();
    const clock = createMutableClock();
    expect(clock()).toBeGreaterThanOrEqual(before);
    expect(() => clock.set(Number.NaN)).toThrow(/finite/);
  });
});

describe("asMutableClock", () => {
  test("narrows a mutable clock and rejects the system clock", () => {
    const clock = createMutableClock(7);
    expect(asMutableClock(clock)).toBe(clock);
    expect(asMutableClock(systemClock)).toBeNull();
    expect(asMutableClock(undefined)).toBeNull();
  });
});

describe("resolveBriefsVirtualClock", () => {
  test("only OMNESIS_BRIEFS_VIRTUAL_CLOCK=1 opts in", () => {
    expect(resolveBriefsVirtualClock({})).toBeNull();
    expect(resolveBriefsVirtualClock({ OMNESIS_BRIEFS_VIRTUAL_CLOCK: "0" })).toBeNull();
    expect(resolveBriefsVirtualClock({ OMNESIS_BRIEFS_VIRTUAL_CLOCK: "true" })).toBeNull();
    const clock = resolveBriefsVirtualClock({ OMNESIS_BRIEFS_VIRTUAL_CLOCK: "1" });
    expect(clock).not.toBeNull();
    expect(clock!.virtual).toBe(true);
  });
});
