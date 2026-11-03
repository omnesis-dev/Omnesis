// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, it, expect, afterEach, vi, beforeEach, test } from "vitest";
import { gcKindName, ProcessVitalsCollector } from "./process-vitals.js";

describe("ProcessVitalsCollector", () => {
  let collector: ProcessVitalsCollector;

  beforeEach(() => {
    vi.useFakeTimers();
    collector = new ProcessVitalsCollector();
  });

  afterEach(() => {
    collector.dispose();
    vi.useRealTimers();
  });

  it("starts and produces samples after ticks", () => {
    collector.start();
    vi.advanceTimersByTime(3_000);
    const snap = collector.snapshot(10);
    expect(snap.windowSeconds).toBe(10);
    expect(snap.eventLoop.samples.length).toBeGreaterThanOrEqual(1);
    expect(snap.cpu.samples.length).toBeGreaterThanOrEqual(1);
    expect(snap.memory.samples.length).toBeGreaterThanOrEqual(1);
    expect(snap.gc.samples.length).toBeGreaterThanOrEqual(1);
  });

  it("snapshot filters by window", () => {
    collector.start();
    vi.advanceTimersByTime(5_000);

    const narrow = collector.snapshot(2);
    const wide = collector.snapshot(10);
    expect(wide.cpu.samples.length).toBeGreaterThanOrEqual(narrow.cpu.samples.length);
  });

  it("exposes current sample", () => {
    collector.start();
    vi.advanceTimersByTime(1_000);
    const snap = collector.snapshot(10);
    expect(snap.eventLoop.current).not.toBeNull();
    expect(snap.cpu.current).not.toBeNull();
    expect(snap.memory.current).not.toBeNull();
    expect(snap.gc.current).not.toBeNull();
  });

  it("cpu sample has expected fields", () => {
    collector.start();
    vi.advanceTimersByTime(1_000);
    const snap = collector.snapshot(10);
    const cpu = snap.cpu.current!;
    expect(typeof cpu.userPct).toBe("number");
    expect(typeof cpu.systemPct).toBe("number");
    expect(typeof cpu.totalPct).toBe("number");
    expect(cpu.totalPct).toBeCloseTo(cpu.userPct + cpu.systemPct, 5);
  });

  it("memory sample has expected fields", () => {
    collector.start();
    vi.advanceTimersByTime(1_000);
    const mem = collector.snapshot(10).memory.current!;
    expect(mem.rssBytes).toBeGreaterThan(0);
    expect(mem.heapUsedBytes).toBeGreaterThan(0);
    expect(mem.heapTotalBytes).toBeGreaterThanOrEqual(mem.heapUsedBytes);
  });

  it("start is idempotent", () => {
    collector.start();
    collector.start();
    vi.advanceTimersByTime(2_000);
    const snap = collector.snapshot(10);
    expect(snap.cpu.samples.length).toBeLessThanOrEqual(3);
  });

  it("dispose stops sampling", () => {
    collector.start();
    vi.advanceTimersByTime(2_000);
    collector.dispose();
    vi.advanceTimersByTime(5_000);
    const snap = collector.snapshot(10);
    expect(snap.cpu.samples.length).toBeLessThanOrEqual(3);
  });

  it("returns samples in ascending ts order after the ring wraps", () => {
    collector.start();
    // RING_SIZE is 600 (10 min @ 1 Hz). Advance past a full wrap so the
    // backing array's physical slot 0 is no longer the oldest sample.
    vi.advanceTimersByTime(700_000);
    // Window wide enough to cover the entire (now full) ring.
    const snap = collector.snapshot(1200);

    expect(snap.cpu.samples.length).toBeGreaterThan(600 / 2);
    for (const stream of [
      snap.cpu.samples,
      snap.eventLoop.samples,
      snap.memory.samples,
      snap.gc.samples,
    ]) {
      for (let i = 1; i < stream.length; i++) {
        expect(stream[i].ts).toBeGreaterThanOrEqual(stream[i - 1].ts);
      }
    }
  });

  it("generatedAt is a valid ISO string", () => {
    collector.start();
    vi.advanceTimersByTime(1_000);
    const snap = collector.snapshot(10);
    expect(new Date(snap.generatedAt).toISOString()).toBe(snap.generatedAt);
  });
});

describe("garbage collection during a span", () => {
  /** Feed collections straight into the ring the GC observer fills. */
  function collectorWith(
    events: Array<{ ts: number; durationMs: number; kind: string }>,
  ): ProcessVitalsCollector {
    const collector = new ProcessVitalsCollector();
    const internals = collector as unknown as { gcEvents: { push(e: unknown): void } };
    for (const e of events) internals.gcEvents.push(e);
    return collector;
  }

  test("sums the collections that overlap the span and names the worst", () => {
    const collector = collectorWith([
      { ts: 1_000, durationMs: 5, kind: "minor" }, // before the span
      { ts: 9_990, durationMs: 20, kind: "minor" }, // straddles its start
      { ts: 10_500, durationMs: 700, kind: "major" },
      { ts: 12_000, durationMs: 9, kind: "minor" }, // after it
    ]);
    try {
      expect(collector.gcBetween(10_000, 11_500)).toEqual({
        count: 2,
        totalMs: 720,
        maxMs: 700,
        maxKind: "major",
      });
      expect(collector.gcBetween(20_000, 21_000)).toBeNull();
    } finally {
      collector.dispose();
    }
  });

  /**
   * V8 reports the collection kind as a bitmask value, and the number alone
   * says nothing to a reader of the journal. A long major collection on a
   * large heap and a string of minor ones are different diagnoses.
   */
  test("names V8's collection kinds", () => {
    const named = (kind: number) => gcKindName({ detail: { kind } } as unknown as PerformanceEntry);
    expect(named(1)).toBe("minor");
    expect(named(2)).toBe("major");
    expect(named(4)).toBe("incremental");
    expect(named(8)).toBe("weakcb");
    expect(named(999)).toBe("unknown");
  });
});
