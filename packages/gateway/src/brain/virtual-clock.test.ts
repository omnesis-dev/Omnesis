// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The virtual clock: settable now, capability narrowing, and the
 * boot-time env opt-in (unset/anything-else => no clock, the production
 * fallback path).
 */

import { describe, expect, test, vi } from "vitest";
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
  test.each(["0", "-1234", "123456789", "-8640000000000000", "8640000000000000"])(
    "starts an opted-in clock at its explicit instant %s before any setter runs",
    (initial) => {
      const env = {
        OMNESIS_BRIEFS_VIRTUAL_CLOCK: "1",
        OMNESIS_BRIEFS_VIRTUAL_CLOCK_INITIAL_MS: initial,
      };
      const clock = resolveBriefsVirtualClock(env)!;
      expect(clock()).toBe(Number(initial));
      expect(clock.virtual).toBe(true);
      expect(env.OMNESIS_BRIEFS_VIRTUAL_CLOCK_INITIAL_MS).toBe(initial);
    },
  );

  test.each(["", " ", "NaN", "Infinity", "bad", "8640000000000001", "-8640000000000001"])(
    "refuses invalid opted-in initial time %j",
    (initial) => {
      expect(() =>
        resolveBriefsVirtualClock({
          OMNESIS_BRIEFS_VIRTUAL_CLOCK: "1",
          OMNESIS_BRIEFS_VIRTUAL_CLOCK_INITIAL_MS: initial,
        }),
      ).toThrow(/INITIAL_MS.*valid unix-ms instant/u);
    },
  );

  test.each([undefined, "0", "true"])(
    "ignores initial-time metadata without virtual opt-in %s and preserves wall time",
    (optIn) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(123_456);
      try {
        expect(
          resolveBriefsVirtualClock({
            OMNESIS_BRIEFS_VIRTUAL_CLOCK: optIn,
            OMNESIS_BRIEFS_VIRTUAL_CLOCK_INITIAL_MS: "not an instant",
          }),
        ).toBeNull();
        expect(systemClock()).toBe(123_456);
        expect(resolveBriefsVirtualClock({ OMNESIS_BRIEFS_VIRTUAL_CLOCK: "1" })!()).toBe(123_456);
      } finally {
        now.mockRestore();
      }
    },
  );

  test("only OMNESIS_BRIEFS_VIRTUAL_CLOCK=1 opts in", () => {
    expect(resolveBriefsVirtualClock({})).toBeNull();
    expect(resolveBriefsVirtualClock({ OMNESIS_BRIEFS_VIRTUAL_CLOCK: "0" })).toBeNull();
    expect(resolveBriefsVirtualClock({ OMNESIS_BRIEFS_VIRTUAL_CLOCK: "true" })).toBeNull();
    const clock = resolveBriefsVirtualClock({ OMNESIS_BRIEFS_VIRTUAL_CLOCK: "1" });
    expect(clock).not.toBeNull();
    expect(clock!.virtual).toBe(true);
  });
});
