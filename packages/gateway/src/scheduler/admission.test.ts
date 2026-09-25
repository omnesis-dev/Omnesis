// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AdmissionController, type AdmissionSink } from "./admission.js";

function makeSink() {
  const calls: Array<{ paused: boolean }> = [];
  let pumps = 0;
  const sink: AdmissionSink = {
    setAdmissionPaused: (paused) => calls.push({ paused }),
    pumpBackground: () => {
      pumps += 1;
    },
  };
  return {
    sink,
    calls,
    get pumps() {
      return pumps;
    },
    get paused() {
      return calls.length ? calls[calls.length - 1].paused : false;
    },
  };
}

describe("AdmissionController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("engages on the first hold and releases on the last (refcounted)", () => {
    const s = makeSink();
    const c = new AdmissionController(s.sink, {
      enabled: true,
      maxHoldMs: 1500,
      pumpIntervalMs: 900,
    });

    const a = c.begin();
    expect(s.paused).toBe(true);
    expect(c.activeHolds()).toBe(1);

    const b = c.begin();
    expect(c.activeHolds()).toBe(2);
    // Still one engage call — pause is edge-triggered, not per-hold.
    expect(s.calls.filter((x) => x.paused).length).toBe(1);

    a.release();
    expect(s.paused).toBe(true); // still held by b
    expect(c.activeHolds()).toBe(1);

    b.release();
    expect(s.paused).toBe(false);
    expect(c.activeHolds()).toBe(0);
  });

  it("auto-releases a hold at maxHoldMs so a long request can't pin the pause", () => {
    const s = makeSink();
    const c = new AdmissionController(s.sink, {
      enabled: true,
      maxHoldMs: 1500,
      pumpIntervalMs: 900,
    });

    const hold = c.begin();
    expect(s.paused).toBe(true);

    vi.advanceTimersByTime(1500);
    expect(s.paused).toBe(false);
    expect(c.activeHolds()).toBe(0);

    // A late explicit release is a harmless no-op (no negative count, no re-toggle).
    hold.release();
    expect(c.activeHolds()).toBe(0);
    expect(s.calls.filter((x) => !x.paused).length).toBe(1);
  });

  it("pumps background at the interval while engaged, and stops on release", () => {
    const s = makeSink();
    const c = new AdmissionController(s.sink, {
      enabled: true,
      maxHoldMs: 10_000,
      pumpIntervalMs: 900,
    });

    const hold = c.begin();
    vi.advanceTimersByTime(900 * 3);
    expect(s.pumps).toBe(3);

    hold.release();
    const before = s.pumps;
    vi.advanceTimersByTime(900 * 5);
    expect(s.pumps).toBe(before); // pump stopped
  });

  it("is a no-op when disabled", () => {
    const s = makeSink();
    const c = new AdmissionController(s.sink, {
      enabled: false,
      maxHoldMs: 1500,
      pumpIntervalMs: 900,
    });
    const hold = c.begin();
    expect(s.calls).toHaveLength(0);
    expect(c.activeHolds()).toBe(0);
    hold.release();
    expect(s.calls).toHaveLength(0);
  });

  it("dispose stops the pump and resets the count", () => {
    const s = makeSink();
    const c = new AdmissionController(s.sink, {
      enabled: true,
      maxHoldMs: 10_000,
      pumpIntervalMs: 900,
    });
    c.begin();
    c.dispose();
    const before = s.pumps;
    vi.advanceTimersByTime(900 * 4);
    expect(s.pumps).toBe(before);
    expect(c.activeHolds()).toBe(0);
  });
});
