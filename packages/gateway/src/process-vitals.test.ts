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

describe("event-loop stall reporting", () => {
  const originalWarn = console.warn;
  afterEach(() => {
    console.warn = originalWarn;
  });

  /**
   * Drive one tick with a chosen loop-delay reading, and optionally with a
   * garbage collection already accumulated into the window.
   */
  function tickWithMaxDelayMs(
    maxMs: number,
    gc?: { count: number; totalMs: number; maxMs: number; kindDetail: number },
  ): string[] {
    const collector = new ProcessVitalsCollector();
    const lines: string[] = [];
    console.warn = (msg: unknown) => {
      lines.push(String(msg));
    };
    try {
      // The histogram is the collector's own; stub the reading rather than
      // trying to block the loop for real inside a test.
      const internals = collector as unknown as {
        eld: { percentile(p: number): number; max: number; reset(): void; disable(): void };
        gcAccum: { count: number; totalMs: number; maxMs: number; maxKind: string };
        tick(): void;
      };
      internals.eld = {
        percentile: () => maxMs * 1e6,
        max: maxMs * 1e6,
        reset: () => undefined,
        disable: () => undefined,
      };
      if (gc) {
        // The kind is named by the same function the gc observer calls, so
        // this covers the mapping and the line assembly together.
        internals.gcAccum = {
          count: gc.count,
          totalMs: gc.totalMs,
          maxMs: gc.maxMs,
          maxKind: gcKindName({ detail: { kind: gc.kindDetail } } as unknown as PerformanceEntry),
        };
      }
      internals.tick();
    } finally {
      console.warn = originalWarn;
      collector.dispose();
    }
    return lines;
  }

  // Detection without attribution is what left the last one unexplained:
  // the samples existed, behind an admin route, and the journal said
  // nothing at all.
  test("writes a stall down, with the memory and GC state to read it by", () => {
    const lines = tickWithMaxDelayMs(4_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("event loop stalled 4000ms");
    expect(lines[0]).toContain("heap=");
    expect(lines[0]).toContain("rss=");
    expect(lines[0]).toMatch(/gc=/);
  });

  test("stays quiet for ordinary scheduling jitter", () => {
    expect(tickWithMaxDelayMs(40)).toHaveLength(0);
  });

  /**
   * V8 reports the collection kind as a bitmask value, and the number alone
   * says nothing to a reader of the journal. A long major collection on a
   * large heap and a string of minor ones are different diagnoses, so the
   * stall line has to name which it saw.
   */
  test("names the worst collection in the window", () => {
    const major = tickWithMaxDelayMs(4_000, {
      count: 3,
      totalMs: 900,
      maxMs: 700,
      kindDetail: 2,
    });
    expect(major[0]).toContain("gc=3 in 900ms, worst 700ms major");

    const minor = tickWithMaxDelayMs(4_000, {
      count: 1,
      totalMs: 20,
      maxMs: 20,
      kindDetail: 1,
    });
    expect(minor[0]).toContain("worst 20ms minor");

    // An unrecognised kind still reads as a word, never a bare number or an
    // empty slot in the middle of the line.
    const odd = tickWithMaxDelayMs(4_000, {
      count: 1,
      totalMs: 5,
      maxMs: 5,
      kindDetail: 999,
    });
    expect(odd[0]).toContain("worst 5ms unknown");
  });
});
