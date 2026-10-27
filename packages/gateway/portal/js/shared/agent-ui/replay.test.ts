// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
// @ts-expect-error — browser JavaScript presentation module.
import { replayRotation } from "./replay.js";

describe("external presentation time", () => {
  const at = (timeMs: number, count = 3) => replayRotation({ timeMs, startAtMs: 0, resultAtMs: 1000, dismissAtMs: 3000 }, count, 350, 300);
  it("seeks backwards without retaining a dismissed state", () => {
    expect(at(3400).phase).toBe("gone");
    expect(at(800)).toEqual({ phase: "live", currentIndex: null, fade: 0 });
    expect(at(1350)).toEqual({ phase: "live", currentIndex: 0, fade: 0 });
    expect(at(3150)).toEqual({ phase: "dismissing", currentIndex: 2, fade: 0.5 });
    expect(at(1350)).toEqual({ phase: "live", currentIndex: 0, fade: 0 });
  });
  it("keeps empty and failed results on a dismissible lifecycle", () => {
    expect(at(3100, 0).currentIndex).toBeNull();
    expect(at(3400, 0).phase).toBe("gone");
  });
  it("rejects invalid clocks", () => {
    expect(() => at(NaN)).toThrow("Invalid replay timing");
    expect(() => at(1000, -1)).toThrow("Invalid replay timing");
  });
});
