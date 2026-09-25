// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Trackers — verify the four progress shapes report what they should
 * after typical update sequences.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { QueueTracker, ScanTracker, StatelessTracker, WatermarkTracker } from "./trackers.js";

describe("QueueTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
  });

  it("starts with the initial remaining value", () => {
    const t = new QueueTracker({ initialRemaining: 100 });
    const obs = t.observe();
    expect(obs.kind).toBe("queue");
    if (obs.kind !== "queue") throw new Error("type narrow");
    expect(obs.remaining).toBe(100);
    expect(obs.processedSinceBoot).toBe(0);
    expect(obs.rateLastMin).toBe(0);
  });

  it("decrements remaining on recordTick and accumulates processedSinceBoot", () => {
    const t = new QueueTracker({ initialRemaining: 100 });
    t.recordTick(5);
    t.recordTick(7);
    const obs = t.observe();
    if (obs.kind !== "queue") throw new Error("type narrow");
    expect(obs.remaining).toBe(88);
    expect(obs.processedSinceBoot).toBe(12);
  });

  it("clamps remaining to zero when more is processed than was queued", () => {
    const t = new QueueTracker({ initialRemaining: 5 });
    t.recordTick(20);
    const obs = t.observe();
    if (obs.kind !== "queue") throw new Error("type narrow");
    expect(obs.remaining).toBe(0);
    expect(obs.processedSinceBoot).toBe(20);
  });

  it("ignores negative or non-finite tick counts", () => {
    const t = new QueueTracker({ initialRemaining: 50 });
    t.recordTick(-3);
    t.recordTick(NaN);
    const obs = t.observe();
    if (obs.kind !== "queue") throw new Error("type narrow");
    expect(obs.remaining).toBe(50);
    expect(obs.processedSinceBoot).toBe(0);
  });

  it("setRemaining replaces the in-memory count and stamps groundTruthAt", () => {
    const t = new QueueTracker({ initialRemaining: 0 });
    t.recordTick(5); // would underflow to 0, but doesn't matter
    t.setRemaining(123);
    const obs = t.observe();
    if (obs.kind !== "queue") throw new Error("type narrow");
    expect(obs.remaining).toBe(123);
    expect(obs.groundTruthAt).toBeGreaterThan(0);
  });

  it("recordItemsAdded bumps remaining without affecting processedSinceBoot", () => {
    const t = new QueueTracker({ initialRemaining: 10 });
    t.recordItemsAdded(7);
    const obs = t.observe();
    if (obs.kind !== "queue") throw new Error("type narrow");
    expect(obs.remaining).toBe(17);
    expect(obs.processedSinceBoot).toBe(0);
  });

  it("computes rate per second over the rolling window", () => {
    const t = new QueueTracker({
      initialRemaining: 1000,
      rateWindowMs: 60_000,
    });
    // 10 docs/tick × 6 ticks evenly spread over 60s = 1 doc/sec
    for (let i = 0; i < 6; i++) {
      t.recordTick(10);
      vi.advanceTimersByTime(10_000);
    }
    const obs = t.observe();
    if (obs.kind !== "queue") throw new Error("type narrow");
    // 60 docs / 60s = 1.0/s. Allow ±0.01 for floating-point.
    expect(obs.rateLastMin).toBeGreaterThan(0.9);
    expect(obs.rateLastMin).toBeLessThan(1.1);
  });

  it("evicts samples older than the rate window", () => {
    const t = new QueueTracker({ initialRemaining: 1000, rateWindowMs: 60_000 });
    t.recordTick(100);
    vi.advanceTimersByTime(120_000);
    const obs = t.observe();
    if (obs.kind !== "queue") throw new Error("type narrow");
    // Old sample is gone; rate should be 0.
    expect(obs.rateLastMin).toBe(0);
  });
});

describe("WatermarkTracker", () => {
  it("starts with empty cursor", () => {
    const t = new WatermarkTracker();
    const obs = t.observe();
    expect(obs.kind).toBe("watermark");
    if (obs.kind !== "watermark") throw new Error("type narrow");
    expect(obs.cursor).toBe("");
    expect(obs.lagDocs).toBeUndefined();
    expect(obs.lagSec).toBeUndefined();
  });

  it("setWatermark updates cursor + lag", () => {
    const t = new WatermarkTracker();
    t.setWatermark("2026-04-30T00:00:00Z", 42, 5);
    const obs = t.observe();
    if (obs.kind !== "watermark") throw new Error("type narrow");
    expect(obs.cursor).toBe("2026-04-30T00:00:00Z");
    expect(obs.lagDocs).toBe(42);
    expect(obs.lagSec).toBe(5);
  });
});

describe("ScanTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:00Z"));
  });

  it("starts with full coverage and no completion timestamp", () => {
    const t = new ScanTracker();
    const obs = t.observe();
    expect(obs.kind).toBe("scan");
    if (obs.kind !== "scan") throw new Error("type narrow");
    expect(obs.coverage).toBe(1);
    expect(obs.lastSweepCompletedAt).toBeUndefined();
  });

  it("recordSweepStarted resets coverage to 0", () => {
    const t = new ScanTracker();
    t.recordSweepStarted();
    const obs = t.observe();
    if (obs.kind !== "scan") throw new Error("type narrow");
    expect(obs.coverage).toBe(0);
  });

  it("recordSweepCompleted snaps to 1 and stamps the timestamp", () => {
    const t = new ScanTracker();
    t.recordSweepStarted();
    t.recordSweepCompleted({ checked: 100, affected: 5 });
    const obs = t.observe();
    if (obs.kind !== "scan") throw new Error("type narrow");
    expect(obs.coverage).toBe(1);
    expect(obs.lastSweepCompletedAt).toBe(Date.now());
    expect(obs.itemsCheckedLastSweep).toBe(100);
    expect(obs.itemsAffectedLastSweep).toBe(5);
  });

  it("recordSweepProgress clamps to [0,1]", () => {
    const t = new ScanTracker();
    t.recordSweepProgress(2);
    expect((t.observe() as { coverage: number }).coverage).toBe(1);
    t.recordSweepProgress(-0.5);
    expect((t.observe() as { coverage: number }).coverage).toBe(0);
    t.recordSweepProgress(0.42);
    expect((t.observe() as { coverage: number }).coverage).toBe(0.42);
  });
});

describe("StatelessTracker", () => {
  it("always returns kind=stateless", () => {
    const t = new StatelessTracker();
    expect(t.observe()).toEqual({ kind: "stateless" });
  });
});
