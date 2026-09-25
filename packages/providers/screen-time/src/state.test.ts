// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import {
  RefusedSourceStateError,
  isStateEnvelope,
  resolveSourceState,
  syncPage,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { screenTimeStateSpec } from "./state.js";
import type { ScreenTimeSyncCursor } from "./types.js";

function recordingInstance(next: ScreenTimeSyncCursor) {
  const seen: (ScreenTimeSyncCursor | null)[] = [];
  const instance: SourceInstance = {
    sync: async (cursor) => {
      seen.push(cursor as ScreenTimeSyncCursor | null);
      return syncPage([], next);
    },
  };
  return { instance, seen };
}

describe("screenTimeStateSpec via the host decorator", () => {
  test.each([
    { lastCreationDate: "invalid" },
    { phase: "unknown" },
    { sessionsProcessed: "invalid" },
    { affectedDates: [42] },
    { lastPk: "invalid" },
    { lastPk: null },
  ])("refuses corrupt legacy fields instead of manufacturing a first-run cursor: %j", (invalid) => {
    const state = {
      phase: "sessions",
      lastCreationDate: 750,
      sessionsProcessed: 300,
      affectedDates: ["2026-08-30"],
      ...invalid,
    };
    expect(resolveSourceState(screenTimeStateSpec, state).kind).toBe("refused");
    expect(resolveSourceState(screenTimeStateSpec, { e: 1, v: 1, state }).kind).toBe("refused");
  });

  test("first run resolves fresh, then resumes from the written-back envelope", async () => {
    const { instance, seen } = recordingInstance({
      phase: "sessions",
      lastCreationDate: 100,
      lastPk: 5,
      sessionsProcessed: 3,
      affectedDates: ["2026-09-01"],
    });
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, screenTimeStateSpec, {
      sourceId: "screen-time:local",
      onResolve: (o) => outcomes.push(o),
    });

    const first = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(first.cursor)).toBe(true);

    await versioned.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(seen[1]).toEqual({
      phase: "sessions",
      lastCreationDate: 100,
      lastPk: 5,
      sessionsProcessed: 3,
      affectedDates: ["2026-09-01"],
    });
  });

  test("a mid-cycle cursor (phase: daily, mid-bootstrap) resumes, not rebootstraps", async () => {
    const { instance, seen } = recordingInstance({
      phase: "done",
      lastCreationDate: 900,
      lastPk: 12,
      sessionsProcessed: 40,
      affectedDates: [],
    });
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, screenTimeStateSpec, {
      sourceId: "screen-time:local",
      onResolve: (o) => outcomes.push(o),
    });

    const midCycle = {
      e: 1,
      v: 2,
      state: {
        phase: "daily",
        lastCreationDate: 500,
        lastPk: 9,
        sessionsProcessed: 20,
        affectedDates: ["2026-09-01", "2026-09-02"],
      },
    };
    await versioned.sync(midCycle as unknown as Parameters<typeof versioned.sync>[0]);

    expect(outcomes[0]?.kind).toBe("resume");
    expect(seen[0]).toEqual(midCycle.state);
  });

  test("a cursor from before the composite (creationDate, pk) tiebreaker migrates forward", async () => {
    const { instance, seen } = recordingInstance({
      phase: "sessions",
      lastCreationDate: 1000,
      lastPk: 1,
      sessionsProcessed: 1,
      affectedDates: [],
    });
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, screenTimeStateSpec, {
      sourceId: "screen-time:local",
      onResolve: (o) => outcomes.push(o),
    });

    // What was persisted before `lastPk` existed: no envelope, no tiebreaker.
    const legacyCursor = {
      phase: "sessions",
      lastCreationDate: 750,
      sessionsProcessed: 300,
      affectedDates: ["2026-08-30"],
    };
    const result = await versioned.sync(
      legacyCursor as unknown as Parameters<typeof versioned.sync>[0],
    );

    expect(outcomes[0]?.kind).toBe("migrated");
    // The source is handed a `lastPk` floor of 0, not the raw legacy value.
    expect(seen[0]).toEqual({
      phase: "sessions",
      lastCreationDate: 750,
      lastPk: 0,
      sessionsProcessed: 300,
      affectedDates: ["2026-08-30"],
    });
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("an unreadable cursor stops the source instead of silently re-bootstrapping", async () => {
    const { instance, seen } = recordingInstance({
      phase: "sessions",
      lastCreationDate: 0,
      lastPk: 0,
      sessionsProcessed: 0,
      affectedDates: [],
    });
    const onRefuse = vi.fn();
    const versioned = withVersionedState(instance, screenTimeStateSpec, {
      sourceId: "screen-time:local",
      onRefuse,
    });

    const garbage = { e: 1, v: 2, state: { phase: "sessions" } };
    await expect(
      versioned.sync(garbage as unknown as Parameters<typeof versioned.sync>[0]),
    ).rejects.toThrow(RefusedSourceStateError);

    // The source never ran, so knowledgeC.db's current rolling window was
    // never mistaken for the whole history.
    expect(seen).toEqual([]);
    expect(onRefuse).toHaveBeenCalledOnce();
  });
});
