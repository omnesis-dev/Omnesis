// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { MetricsCollector, type RunnerSnapshotInput } from "./metrics-collector.js";
import type { RunnerKind } from "./types.js";

const originalWarn = console.warn;
afterEach(() => {
  console.warn = originalWarn;
});

function captureWarnings(fn: () => void): string[] {
  const lines: string[] = [];
  console.warn = (msg: unknown) => {
    lines.push(String(msg));
  };
  try {
    fn();
  } finally {
    console.warn = originalWarn;
  }
  return lines;
}

describe("slow-op provenance", () => {
  // A slow io read and the sweep waiting on it are one incident reported
  // twice. Counted as two, a handful of sweeps reads as a flood of roughly
  // twice as many warnings as there were slow operations. The line has to
  // say which of the two it is.
  test("names the dispatching task for nested work", () => {
    const collector = new MetricsCollector(1_000);
    const lines = captureWarnings(() => {
      collector.record(
        "io.peopleCountsChunk",
        200,
        "io",
        0,
        900,
        "realtime",
        "done",
        undefined,
        undefined,
        "backfill.peopleCountsRefresh",
      );
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("slow-op io.peopleCountsChunk");
    expect(lines[0]).toContain("via=backfill.peopleCountsRefresh");
    expect(lines[0]).not.toContain(" root");
  });

  test("marks work dispatched at the top level as the root", () => {
    const collector = new MetricsCollector(1_000);
    const lines = captureWarnings(() => {
      collector.record("backfill.peopleCountsRefresh", 200, "main", 0, 900, "realtime", "done");
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("root");
    expect(lines[0]).not.toContain("via=");
  });

  test("stays quiet for background work, which is expected to wait", () => {
    const collector = new MetricsCollector(1_000);
    const lines = captureWarnings(() => {
      collector.record("backfill.whatever", 200, "main", 0, 5_000, "background", "done");
    });
    expect(lines).toHaveLength(0);
  });
});

describe("per-runner queue-age max", () => {
  const t0 = new Date("2026-05-01T00:00:00.000Z").getTime();

  afterEach(() => {
    vi.useRealTimers();
  });

  function runnerInput(runner: RunnerKind): RunnerSnapshotInput {
    return {
      runner,
      queueDepthByPriority: { user: 0, realtime: 0, background: 0 },
      inFlight: 0,
    };
  }

  // Every other number in the snapshot answers "what happened in the last
  // N seconds". A queue age that never ages out would pin the portal's
  // starvation row red for the life of the process: the first background
  // task released by the 10s anti-starvation floor reports a twelve-second
  // wait, and no calmer minute afterwards could ever show through.
  test("forgets a spike that has aged out of the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const collector = new MetricsCollector(1_000);
    collector.record("backfill.linkApply", 5_000, "writer", 12_000, 20, "background", "done");

    vi.setSystemTime(t0 + 10 * 60_000);
    collector.record("backfill.linkApply", 5_000, "writer", 30, 20, "background", "done");

    const snap = collector.snapshot(300, [runnerInput("writer")], () => null, 0);
    expect(snap.perRunner[0].queueAgeMaxByPriority.background).toBe(30);
  });

  test("keeps the max separate per runner and per priority", () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const collector = new MetricsCollector(1_000);
    collector.record("documents.upsert", 5_000, "writer", 40, 5, "user", "done");
    collector.record("documents.upsert", 5_000, "writer", 90, 5, "user", "done");
    collector.record("backfill.linkApply", 5_000, "writer", 7_000, 5, "background", "done");
    collector.record("search.query", 5_000, "io", 15, 5, "user", "done");

    const snap = collector.snapshot(
      300,
      [runnerInput("writer"), runnerInput("io"), runnerInput("cpu")],
      () => null,
      0,
    );
    const byRunner = new Map(snap.perRunner.map((r) => [r.runner, r.queueAgeMaxByPriority]));
    expect(byRunner.get("writer")).toEqual({ user: 90, realtime: 0, background: 7_000 });
    expect(byRunner.get("io")).toEqual({ user: 15, realtime: 0, background: 0 });
    expect(byRunner.get("cpu")).toEqual({ user: 0, realtime: 0, background: 0 });
  });
});

describe("per-task priority counts", () => {
  const t0 = new Date("2026-05-01T00:00:00.000Z").getTime();

  afterEach(() => {
    vi.useRealTimers();
  });

  function runnerInput(runner: RunnerKind): RunnerSnapshotInput {
    return {
      runner,
      queueDepthByPriority: { user: 0, realtime: 0, background: 0 },
      inFlight: 0,
    };
  }

  // Priority is resolved per execution — an enqueue override, the calling
  // request's ambient priority, or the task's own default — so one task can
  // run at several priorities inside one window. A row that names a single
  // priority for every execution it aggregates cannot say so.
  test("reports every priority a task ran at, with its count", () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const collector = new MetricsCollector(1_000);
    collector.record("db.deleteDocuments", 5_000, "writer", 0, 5, "realtime", "done");
    collector.record("db.deleteDocuments", 5_000, "writer", 0, 5, "user", "done");
    collector.record("db.deleteDocuments", 5_000, "writer", 0, 5, "user", "done");
    collector.record("db.deleteDocuments", 5_000, "writer", 0, 5, "background", "done");

    const snap = collector.snapshot(300, [runnerInput("writer")], () => null, 0);
    const stats = snap.perTask.find((t) => t.name === "db.deleteDocuments");
    expect(stats?.count).toBe(4);
    expect(stats?.countByPriority).toEqual({ user: 2, realtime: 1, background: 1 });
  });

  test("counts only the executions inside the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    const collector = new MetricsCollector(1_000);
    collector.record("db.upsertDocuments", 5_000, "writer", 0, 5, "realtime", "done");

    vi.setSystemTime(t0 + 10 * 60_000);
    collector.record("db.upsertDocuments", 5_000, "writer", 0, 5, "user", "done");

    const snap = collector.snapshot(300, [runnerInput("writer")], () => null, 0);
    const stats = snap.perTask.find((t) => t.name === "db.upsertDocuments");
    expect(stats?.countByPriority).toEqual({ user: 1, realtime: 0, background: 0 });
  });
});
