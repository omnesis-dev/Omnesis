// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { ScanTracker } from "../../background-jobs/trackers.js";
import { SchedulerQueueFullError } from "../types.js";
import {
  occRefreshTask,
  runBackfillTick,
  sweepAccumulateTask,
  type SweepAccumulateTaskConfig,
} from "./backfill-helpers.js";

const log = createLogger("test:backfill-helpers");

describe("runBackfillTick", () => {
  test("forwards a successful body's IdleResult", async () => {
    const out = await runBackfillTick("t", log, async () => ({ idle: false }));
    expect(out).toEqual({ kind: "done", value: { idle: false } });
  });

  test("idle=true is preserved", async () => {
    const out = await runBackfillTick("t", log, async () => ({ idle: true }));
    expect(out).toEqual({ kind: "done", value: { idle: true } });
  });

  test("backpressure → idle=true (next tick will retry)", async () => {
    const out = await runBackfillTick("t", log, async () => {
      throw new SchedulerQueueFullError("writer queue full");
    });
    expect(out).toEqual({ kind: "done", value: { idle: true } });
  });

  test("non-backpressure error → swallows + idle=true", async () => {
    const out = await runBackfillTick("t", log, async () => {
      throw new Error("boom");
    });
    expect(out).toEqual({ kind: "done", value: { idle: true } });
  });
});

describe("occRefreshTask", () => {
  function makeConfig(over?: Partial<Parameters<typeof occRefreshTask>[0]>) {
    const tracker = new ScanTracker();
    return {
      tracker,
      cfg: {
        name: "test.occ",
        log,
        periodMs: 1_000,
        idlePeriodMs: 60_000,
        startDelayMs: 0,
        tracker,
        readMeta: async () => ({ dirtyVersion: 0, lastAppliedVersion: 0 }),
        computeSnapshot: async () => ({ value: "snap" }),
        applySnapshot: async () => ({ affected: 0 }),
        logSummary: () => undefined,
        ...over,
      },
    };
  }

  test("clean → caught up: no compute, no apply, idle=true, sweep stamped", async () => {
    const compute = vi.fn();
    const apply = vi.fn();
    const { tracker, cfg } = makeConfig({
      computeSnapshot: compute,
      applySnapshot: apply,
    });
    const task = occRefreshTask(cfg);
    const result = await task.run();
    expect(result).toEqual({ kind: "done", value: { idle: true } });
    expect(compute).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    // Sweep was stamped (so observers can tell the loop is alive).
    const obs1 = tracker.observe();
    expect(obs1.kind).toBe("scan");
    if (obs1.kind === "scan") {
      expect(obs1.lastSweepCompletedAt).toBeGreaterThan(0);
    }
  });

  test("dirty → compute + apply + summary; idle=false", async () => {
    const compute = vi.fn(async () => ({ rows: [1, 2, 3] }));
    const apply = vi.fn(async () => ({ affected: 2, checked: 3 }));
    const summary = vi.fn();
    const { tracker, cfg } = makeConfig({
      readMeta: async () => ({ dirtyVersion: 5, lastAppliedVersion: 3 }),
      computeSnapshot: compute,
      applySnapshot: apply,
      logSummary: summary,
    });
    const task = occRefreshTask(cfg);
    const result = await task.run();
    expect(result).toEqual({ kind: "done", value: { idle: false } });
    expect(compute).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith({ rows: [1, 2, 3] });
    expect(summary).toHaveBeenCalledOnce();
    // Tracker should reflect a completed sweep with affected/checked.
    const obs = tracker.observe();
    expect(obs.kind).toBe("scan");
    if (obs.kind === "scan") {
      expect(obs.lastSweepCompletedAt).toBeGreaterThan(0);
      expect(obs.itemsCheckedLastSweep).toBe(3);
      expect(obs.itemsAffectedLastSweep).toBe(2);
    }
  });

  test("preStep work keeps the tick active even when OCC says idle", async () => {
    const preStep = vi.fn(async () => true);
    const compute = vi.fn();
    const { cfg } = makeConfig({
      preStep,
      computeSnapshot: compute,
    });
    const task = occRefreshTask(cfg);
    const result = await task.run();
    expect(preStep).toHaveBeenCalledOnce();
    // OCC says idle, but preStep did work → stay active so the next
    // tick fires sooner.
    expect(result).toEqual({ kind: "done", value: { idle: false } });
    // No compute because OCC was clean.
    expect(compute).not.toHaveBeenCalled();
  });

  test("preStep no-op + OCC clean → idle=true", async () => {
    const preStep = vi.fn(async () => false);
    const { cfg } = makeConfig({ preStep });
    const task = occRefreshTask(cfg);
    const result = await task.run();
    expect(result).toEqual({ kind: "done", value: { idle: true } });
  });

  test("backpressure during apply → idle=true (handled by runBackfillTick)", async () => {
    const apply = vi.fn(async () => {
      throw new SchedulerQueueFullError("writer queue full");
    });
    const { cfg } = makeConfig({
      readMeta: async () => ({ dirtyVersion: 5, lastAppliedVersion: 3 }),
      applySnapshot: apply,
    });
    const task = occRefreshTask(cfg);
    const result = await task.run();
    expect(result).toEqual({ kind: "done", value: { idle: true } });
  });
});

// ── sweepAccumulateTask ─────────────────────────────────────────────

describe("sweepAccumulateTask", () => {
  /** Minimal config builder; override individual callbacks per test. */
  function makeSweepConfig(over?: Partial<SweepAccumulateTaskConfig<string, string[]>>) {
    const tracker = new ScanTracker();
    const cfg: SweepAccumulateTaskConfig<string, string[]> = {
      name: "test.sweep",
      log,
      periodMs: 500,
      idlePeriodMs: 30_000,
      startDelayMs: 0,
      tracker,
      shouldStartSweep: async () => true,
      initSweep: async () => [],
      fetchChunk: async () => ({ rows: [], nextCursor: null }),
      mergeChunk: (acc, rows) => acc.push(...rows),
      applyResult: async () => ({ affected: 0 }),
      logSummary: () => undefined,
      ...over,
    };
    return { tracker, cfg };
  }

  test("shouldStartSweep returns false — idle without starting, tracker records completed", async () => {
    const shouldStartSweep = vi.fn(async () => false);
    const initSweep = vi.fn(async () => []);
    const fetchChunk = vi.fn();
    const applyResult = vi.fn();
    const { tracker, cfg } = makeSweepConfig({
      shouldStartSweep,
      initSweep,
      fetchChunk,
      applyResult,
    });

    const task = sweepAccumulateTask(cfg);
    const result = await task.run();

    expect(result).toEqual({ kind: "done", value: { idle: true, successful: true } });
    expect(shouldStartSweep).toHaveBeenCalledOnce();
    expect(initSweep).not.toHaveBeenCalled();
    expect(fetchChunk).not.toHaveBeenCalled();
    expect(applyResult).not.toHaveBeenCalled();

    // Tracker stamped as completed so observers see the loop is alive.
    const obs = tracker.observe();
    expect(obs.kind).toBe("scan");
    if (obs.kind === "scan") {
      expect(obs.lastSweepCompletedAt).toBeGreaterThan(0);
    }
  });

  test("single-chunk sweep — fetch returns nextCursor=null immediately, apply fires", async () => {
    const applyResult = vi.fn(async () => ({ affected: 2, checked: 5 }));
    const logSummary = vi.fn();
    const mergeChunk = vi.fn((acc: string[], rows: string[]) => acc.push(...rows));
    const { tracker, cfg } = makeSweepConfig({
      fetchChunk: async () => ({ rows: ["a", "b"], nextCursor: null }),
      mergeChunk,
      applyResult,
      logSummary,
    });

    const task = sweepAccumulateTask(cfg);
    const result = await task.run();

    expect(result).toEqual({ kind: "done", value: { idle: true, successful: true } });
    expect(mergeChunk).toHaveBeenCalledOnce();
    expect(mergeChunk).toHaveBeenCalledWith(expect.any(Array), ["a", "b"]);
    expect(applyResult).toHaveBeenCalledOnce();
    // The accumulator passed to applyResult should contain the merged rows.
    expect(applyResult).toHaveBeenCalledWith(["a", "b"]);
    expect(logSummary).toHaveBeenCalledOnce();

    // Tracker reflects a completed sweep with stats.
    const obs = tracker.observe();
    expect(obs.kind).toBe("scan");
    if (obs.kind === "scan") {
      expect(obs.lastSweepCompletedAt).toBeGreaterThan(0);
      expect(obs.itemsCheckedLastSweep).toBe(5);
      expect(obs.itemsAffectedLastSweep).toBe(2);
    }
  });

  test("multi-tick sweep — 3 chunks before completion", async () => {
    let callCount = 0;
    const chunks: Array<{ rows: string[]; nextCursor: string | null }> = [
      { rows: ["a"], nextCursor: "c1" },
      { rows: ["b"], nextCursor: "c2" },
      { rows: ["c"], nextCursor: null },
    ];
    const fetchChunk = vi.fn(async () => chunks[callCount++]!);
    const mergeChunk = vi.fn((acc: string[], rows: string[]) => acc.push(...rows));
    const applyResult = vi.fn(async () => ({ affected: 3, checked: 3 }));
    const logSummary = vi.fn();
    const { cfg } = makeSweepConfig({
      fetchChunk,
      mergeChunk,
      applyResult,
      logSummary,
    });

    const task = sweepAccumulateTask(cfg);

    // Tick 1: fetches chunk 0, cursor advances to "c1" → not idle.
    const r1 = await task.run();
    expect(r1).toEqual({ kind: "done", value: { idle: false, successful: true } });
    expect(fetchChunk).toHaveBeenCalledTimes(1);
    expect(fetchChunk).toHaveBeenLastCalledWith(null); // first call: cursor is null
    expect(mergeChunk).toHaveBeenCalledTimes(1);
    expect(applyResult).not.toHaveBeenCalled();

    // Tick 2: fetches chunk 1, cursor advances to "c2" → not idle.
    const r2 = await task.run();
    expect(r2).toEqual({ kind: "done", value: { idle: false, successful: true } });
    expect(fetchChunk).toHaveBeenCalledTimes(2);
    expect(fetchChunk).toHaveBeenLastCalledWith("c1");
    expect(mergeChunk).toHaveBeenCalledTimes(2);
    expect(applyResult).not.toHaveBeenCalled();

    // Tick 3: fetches chunk 2, nextCursor=null → apply fires, idle.
    const r3 = await task.run();
    expect(r3).toEqual({ kind: "done", value: { idle: true, successful: true } });
    expect(fetchChunk).toHaveBeenCalledTimes(3);
    expect(fetchChunk).toHaveBeenLastCalledWith("c2");
    expect(mergeChunk).toHaveBeenCalledTimes(3);
    expect(applyResult).toHaveBeenCalledOnce();
    expect(applyResult).toHaveBeenCalledWith(["a", "b", "c"]);
    expect(logSummary).toHaveBeenCalledOnce();
  });

  test("empty sweep — fetchChunk returns empty rows, apply still fires", async () => {
    const applyResult = vi.fn(async () => ({ affected: 0 }));
    const mergeChunk = vi.fn((acc: string[], rows: string[]) => acc.push(...rows));
    const logSummary = vi.fn();
    const { cfg } = makeSweepConfig({
      fetchChunk: async () => ({ rows: [], nextCursor: null }),
      mergeChunk,
      applyResult,
      logSummary,
    });

    const task = sweepAccumulateTask(cfg);
    const result = await task.run();

    expect(result).toEqual({ kind: "done", value: { idle: true, successful: true } });
    // mergeChunk is still called (with an empty array).
    expect(mergeChunk).toHaveBeenCalledOnce();
    expect(mergeChunk).toHaveBeenCalledWith([], []);
    // applyResult fires with the empty accumulator.
    expect(applyResult).toHaveBeenCalledOnce();
    expect(applyResult).toHaveBeenCalledWith([]);
    expect(logSummary).toHaveBeenCalledOnce();
  });

  test("backpressure mid-sweep — state reset, next tick starts fresh sweep", async () => {
    const fetchChunk = vi.fn(async (cursor: string | null) => {
      if (cursor === null) return { rows: ["a"], nextCursor: "c1" };
      if (cursor === "c1") return { rows: ["b"], nextCursor: null };
      throw new Error("unexpected cursor");
    });
    const mergeChunk = vi.fn((acc: string[], rows: string[]) => acc.push(...rows));

    let applyCallCount = 0;
    const applyResult = vi.fn(async (acc: string[]) => {
      applyCallCount++;
      if (applyCallCount === 1) {
        throw new SchedulerQueueFullError("writer queue full");
      }
      return { affected: acc.length };
    });
    const logSummary = vi.fn();
    const shouldStartSweep = vi.fn(async () => true);
    const initSweep = vi.fn(async () => [] as string[]);
    const { cfg } = makeSweepConfig({
      shouldStartSweep,
      initSweep,
      fetchChunk,
      mergeChunk,
      applyResult,
      logSummary,
    });

    const task = sweepAccumulateTask(cfg);

    // Tick 1: fetch chunk 0 (cursor=null → "c1"), not idle.
    const r1 = await task.run();
    expect(r1).toEqual({ kind: "done", value: { idle: false, successful: true } });
    expect(initSweep).toHaveBeenCalledOnce();

    // Tick 2: fetch chunk 1 (cursor="c1" → null), apply throws
    // backpressure. Sweep state is reset BEFORE the apply call so the
    // stale accumulator is discarded — prevents double-counting on retry.
    const r2 = await task.run();
    expect(r2).toEqual({ kind: "done", value: { idle: true } });
    expect(applyResult).toHaveBeenCalledOnce();

    // Tick 3: sweep state was reset, so shouldStartSweep + initSweep
    // are called again (fresh sweep). The new sweep starts from
    // cursor=null with a clean accumulator.
    const r3 = await task.run();
    expect(shouldStartSweep).toHaveBeenCalledTimes(2);
    expect(initSweep).toHaveBeenCalledTimes(2);
    expect(fetchChunk).toHaveBeenCalledTimes(3);
    expect(r3).toEqual({ kind: "done", value: { idle: false, successful: true } });
  });

  test("task metadata is set correctly from config", () => {
    const { cfg } = makeSweepConfig({
      name: "my.sweep",
      periodMs: 123,
      idlePeriodMs: 456,
      startDelayMs: 789,
    });
    const task = sweepAccumulateTask(cfg);
    expect(task.name).toBe("my.sweep");
    expect(task.periodMs).toBe(123);
    expect(task.idlePeriodMs).toBe(456);
    expect(task.startDelayMs).toBe(789);
    expect(task.runner).toBe("main");
    expect(task.priority).toBe("background");
    expect(task.initialArgs).toBeUndefined();
  });

  test("isIdle correctly identifies idle results", () => {
    const { cfg } = makeSweepConfig();
    const task = sweepAccumulateTask(cfg);
    expect(task.isIdle?.({ idle: true })).toBe(true);
    expect(task.isIdle?.({ idle: false })).toBe(false);
  });

  test("tracker records sweepStarted when a new sweep begins", async () => {
    // Two-chunk sweep so we can observe the tracker mid-sweep.
    let callCount = 0;
    const fetchChunk = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return { rows: ["x"], nextCursor: "c1" };
      return { rows: ["y"], nextCursor: null };
    });
    const { tracker, cfg } = makeSweepConfig({ fetchChunk });

    const task = sweepAccumulateTask(cfg);

    // Before any tick, coverage is 1 (default).
    expect(tracker.observe()).toMatchObject({ coverage: 1 });

    // Tick 1: sweep starts → tracker.recordSweepStarted() sets coverage=0.
    await task.run();
    const obs1 = tracker.observe();
    expect(obs1.kind).toBe("scan");
    if (obs1.kind === "scan") {
      expect(obs1.coverage).toBe(0);
    }

    // Tick 2: sweep completes → tracker.recordSweepCompleted() sets coverage=1.
    await task.run();
    const obs2 = tracker.observe();
    expect(obs2.kind).toBe("scan");
    if (obs2.kind === "scan") {
      expect(obs2.coverage).toBe(1);
    }
  });
});
