// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `backfill.statsRefresh` picks one dirty source per tick. This exercises which
 * one it picks, against stub gates — the scheduler wiring itself is covered by
 * `scheduler.test.ts`.
 */

import { describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { QueueTracker } from "../../background-jobs/trackers.js";
import { sourceStatsRefreshTask } from "./backfill-tasks.js";
import type { IoGate } from "../io-ops.js";
import type { WriteGate } from "../../write-gate.js";

/** The options the task takes, read off the task itself rather than a type the module keeps private. */
type BackfillTaskOptsInternal = Parameters<typeof sourceStatsRefreshTask>[0];

const log = createLogger("test:stats-refresh");

function build(dirty: string[], scanMs: Record<string, number> = {}) {
  const computed: string[] = [];
  const ioGate = {
    dirtyStatsSourceIds: async () => [...dirty],
    sourceStatsRow: async (sourceId: string) => {
      computed.push(sourceId);
      const ms = scanMs[sourceId];
      if (ms) vi.setSystemTime(Date.now() + ms);
      return {
        count: 1,
        earliest: null,
        latest: null,
        dataSize: 0,
        totalUnits: 7,
        capturedVersion: 1,
        capturedDocCount: 1,
      };
    },
  } as unknown as IoGate;
  const writeGate = {
    upsertSourceStatsRow: async () => undefined,
  } as unknown as WriteGate;
  const task = sourceStatsRefreshTask({
    writeGate,
    ioGate,
    log,
    statsRefreshIntervalMs: 30_000,
    trackers: { sourceStatsRefresh: new QueueTracker({ initialRemaining: 0 }) },
  } as unknown as BackfillTaskOptsInternal);
  return { task, computed };
}

const tick = () => ({ signal: new AbortController().signal }) as never;

describe("backfill.statsRefresh — which dirty source gets the turn", () => {
  test("a source that never clears does not starve the ones behind it", async () => {
    // The aggregation commits only if nothing wrote to that source while it
    // ran, so a source still ingesting loses that race on every tick. Taking
    // the head of the list each time then parks the task on that one source
    // forever: everything behind it keeps `total_units` null, and a client
    // falls back to the document count — a different number on any source
    // whose documents aggregate, which is how two clients end up disagreeing.
    const { task, computed } = build(["busy", "idle-a", "idle-b"]);

    await task.run(undefined, { signal: new AbortController().signal } as never);
    await task.run(undefined, { signal: new AbortController().signal } as never);
    await task.run(undefined, { signal: new AbortController().signal } as never);

    expect(new Set(computed), "every dirty source got a turn").toEqual(
      new Set(["busy", "idle-a", "idle-b"]),
    );
  });

  // A source that is always ingesting is dirty again after every sync, and
  // its scan reads every one of its documents. Scanned on every tick, a large
  // one held a read worker for minutes out of every few minutes; it now waits
  // out a cooldown in proportion to its last scan, while small sources behind
  // it keep their turns.
  test("a source whose scan is long waits out a cooldown before it is scanned again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const { task, computed } = build(["large", "small"], { large: 120_000 });

      await task.run(undefined, tick());
      await task.run(undefined, tick());
      expect(computed).toEqual(["large", "small"]);

      // Within the large source's cooldown only the small one gets turns.
      vi.setSystemTime(Date.now() + 60_000);
      await task.run(undefined, tick());
      vi.setSystemTime(Date.now() + 60_000);
      await task.run(undefined, tick());
      expect(computed).toEqual(["large", "small", "small", "small"]);

      // Past twenty times its scan, the large source is due again.
      vi.setSystemTime(Date.now() + 20 * 120_000);
      await task.run(undefined, tick());
      await task.run(undefined, tick());
      expect(computed.slice(4)).toEqual(expect.arrayContaining(["large"]));
    } finally {
      vi.useRealTimers();
    }
  });

  test("it reports idle while every dirty source is cooling down", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const { task, computed } = build(["large"], { large: 120_000 });
      await task.run(undefined, tick());
      const outcome = await task.run(undefined, tick());
      expect(computed).toEqual(["large"]);
      expect(outcome.kind === "done" && outcome.value.idle).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("it reports idle when nothing is dirty", async () => {
    const { task, computed } = build([]);
    const outcome = await task.run(undefined, {
      signal: new AbortController().signal,
    } as never);
    expect(computed).toEqual([]);
    expect(outcome.kind === "done" && outcome.value.idle).toBe(true);
  });
});
