// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import {
  isStateEnvelope,
  syncPage,
  withVersionedState,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { browserHistoryStateSpec } from "./state.js";
import type { BrowserHistoryCursor } from "./types.js";

function recordingInstance(next: BrowserHistoryCursor) {
  const seen: (BrowserHistoryCursor | null)[] = [];
  const instance: SourceInstance = {
    sync: async (cursor) => {
      seen.push(cursor as BrowserHistoryCursor | null);
      return syncPage([], next);
    },
  };
  return { instance, seen };
}

describe("browserHistoryStateSpec via the host decorator", () => {
  test("first run resolves fresh, then resumes from the written-back envelope", async () => {
    const { instance, seen } = recordingInstance({
      phase: "visits",
      lastVisitTime: { Default: 123 },
      visitsProcessed: 10,
      affectedDates: ["2026-09-01"],
    });
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, browserHistoryStateSpec, {
      sourceId: "browser-history:chrome",
      onResolve: (o) => outcomes.push(o),
    });

    const first = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(first.cursor)).toBe(true);

    await versioned.sync(first.cursor);
    expect(outcomes[1]?.kind).toBe("resume");
    expect(seen[1]).toEqual({
      phase: "visits",
      lastVisitTime: { Default: 123 },
      visitsProcessed: 10,
      affectedDates: ["2026-09-01"],
    });
  });

  test("a mid-cycle cursor (phase: search_terms, multiple profiles) resumes, not rebootstraps", async () => {
    const { instance, seen } = recordingInstance({
      phase: "done",
      lastVisitTime: {},
      visitsProcessed: 0,
      affectedDates: [],
    });
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, browserHistoryStateSpec, {
      sourceId: "browser-history:chrome",
      onResolve: (o) => outcomes.push(o),
    });

    const midCycle = {
      e: 1,
      v: 1,
      state: {
        phase: "search_terms",
        lastVisitTime: { Default: 500, "Profile 1": 480 },
        visitsProcessed: 900,
        affectedDates: ["2026-09-01", "2026-09-02"],
      },
    };
    await versioned.sync(midCycle as unknown as Parameters<typeof versioned.sync>[0]);

    expect(outcomes[0]?.kind).toBe("resume");
    expect(seen[0]).toEqual(midCycle.state);
  });

  test("a legacy single-key watermark still decodes as the current shape — no migration exists to run", () => {
    // What a pre-per-profile install wrote: one entry keyed by the plain
    // browserId rather than by profile directory. `sync`'s own fallback
    // (`cur.lastVisitTime[browserId] ?? getInitialTimestamp()`) is what makes
    // this safe to resume from, not a version distinction — the shape here is
    // identical to today's per-profile map.
    const legacy = {
      phase: "visits",
      lastVisitTime: { chrome: 1000 },
      visitsProcessed: 50,
      affectedDates: [],
    };
    expect(browserHistoryStateSpec.decode(legacy)).not.toBeNull();
  });

  test("garbage state rebootstraps rather than parking the source", async () => {
    const { instance } = recordingInstance({
      phase: "visits",
      lastVisitTime: {},
      visitsProcessed: 0,
      affectedDates: [],
    });
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, browserHistoryStateSpec, {
      sourceId: "browser-history:chrome",
      onResolve: (o) => outcomes.push(o),
    });

    const garbage = { e: 1, v: 1, state: { phase: "unknown-phase" } };
    await versioned.sync(garbage as unknown as Parameters<typeof versioned.sync>[0]);

    expect(outcomes[0]?.kind).toBe("rebootstrap");
  });
});
