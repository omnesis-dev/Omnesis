// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `backfill.statsRefresh` picks one dirty source per tick. This exercises which
 * one it picks, against stub gates — the scheduler wiring itself is covered by
 * `scheduler.test.ts`.
 */

import { describe, expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { QueueTracker } from "../../background-jobs/trackers.js";
import { sourceStatsRefreshTask } from "./backfill-tasks.js";
import type { IoGate } from "../io-ops.js";
import type { WriteGate } from "../../write-gate.js";

/** The options the task takes, read off the task itself rather than a type the module keeps private. */
type BackfillTaskOptsInternal = Parameters<typeof sourceStatsRefreshTask>[0];

const log = createLogger("test:stats-refresh");

function build(dirty: string[]) {
  const computed: string[] = [];
  const ioGate = {
    dirtyStatsSourceIds: async () => [...dirty],
    sourceStatsRow: async (sourceId: string) => {
      computed.push(sourceId);
      return {
        count: 1,
        earliest: null,
        latest: null,
        dataSize: 0,
        totalUnits: 7,
        capturedVersion: 1,
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
    statsRefreshIntervalMs: 1_000_000,
    trackers: { sourceStatsRefresh: new QueueTracker({ initialRemaining: 0 }) },
  } as unknown as BackfillTaskOptsInternal);
  return { task, computed };
}

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

  test("it reports idle when nothing is dirty", async () => {
    const { task, computed } = build([]);
    const outcome = await task.run(undefined, {
      signal: new AbortController().signal,
    } as never);
    expect(computed).toEqual([]);
    expect(outcome.kind === "done" && outcome.value.idle).toBe(true);
  });
});
