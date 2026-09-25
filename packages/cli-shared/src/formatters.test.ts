// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTimeAgoMs } from "./formatters.js";

describe("formatTimeAgoMs", () => {
  // Pin the clock so the X-units calculations are deterministic across CI
  // and the laptop's wall clock. `Date.now()` returns a fixed epoch within
  // each test; the helper computes a difference, so the absolute value
  // doesn't matter as long as it's stable.
  const NOW = new Date("2026-05-08T12:00:00Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders sub-minute deltas as Xs ago", () => {
    expect(formatTimeAgoMs(NOW - 5_000)).toBe("5s ago");
    expect(formatTimeAgoMs(NOW - 59_999)).toBe("59s ago");
  });

  it("renders sub-hour deltas as Xm ago", () => {
    expect(formatTimeAgoMs(NOW - 60_000)).toBe("1m ago");
    expect(formatTimeAgoMs(NOW - 30 * 60_000)).toBe("30m ago");
  });

  it("renders sub-day deltas as Xh ago", () => {
    expect(formatTimeAgoMs(NOW - 60 * 60_000)).toBe("1h ago");
    expect(formatTimeAgoMs(NOW - 23 * 60 * 60_000)).toBe("23h ago");
  });

  it("renders >24h deltas as Xd ago by default", () => {
    expect(formatTimeAgoMs(NOW - 24 * 60 * 60_000)).toBe("1d ago");
    expect(formatTimeAgoMs(NOW - 7 * 24 * 60 * 60_000)).toBe("7d ago");
  });

  it("renders >24h deltas as ISO date when longFormat=iso-date", () => {
    expect(formatTimeAgoMs(NOW - 7 * 24 * 60 * 60_000, { longFormat: "iso-date" })).toBe(
      "2026-05-01",
    );
  });

  it("returns the never label for null / undefined / 0", () => {
    expect(formatTimeAgoMs(null)).toBe("never");
    expect(formatTimeAgoMs(undefined)).toBe("never");
    expect(formatTimeAgoMs(0)).toBe("never");
    expect(formatTimeAgoMs(null, { neverLabel: "—" })).toBe("—");
  });
});
