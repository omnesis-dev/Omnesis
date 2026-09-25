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
import { thingsStateSpec } from "./state.js";
import type { ThingsSyncCursor } from "./types.js";

function recordingInstance(next: ThingsSyncCursor) {
  const seen: (ThingsSyncCursor | null)[] = [];
  const instance: SourceInstance = {
    sync: async (cursor) => {
      seen.push(cursor as ThingsSyncCursor | null);
      return syncPage([], next);
    },
  };
  return { instance, seen };
}

describe("thingsStateSpec via the host decorator", () => {
  test("a first run resolves fresh and writes back an envelope", async () => {
    const { instance } = recordingInstance({ lastModifiedTimestamp: 100 });
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, thingsStateSpec, {
      sourceId: "things:local",
      onResolve: (o) => outcomes.push(o),
    });

    const result = await versioned.sync(null);
    expect(outcomes[0]?.kind).toBe("fresh");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("a settled cursor resumes", async () => {
    const { instance, seen } = recordingInstance({ lastModifiedTimestamp: 200 });
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, thingsStateSpec, {
      sourceId: "things:local",
      onResolve: (o) => outcomes.push(o),
    });

    const first = await versioned.sync(null);
    await versioned.sync(first.cursor);

    expect(outcomes[1]?.kind).toBe("resume");
    expect(seen).toEqual([null, { lastModifiedTimestamp: 200 }]);
  });

  test("a mid-cycle cursor (cycleQueueTotal pinned while hasMore) resumes, not rebootstraps", async () => {
    const { instance } = recordingInstance({ lastModifiedTimestamp: 300 });
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, thingsStateSpec, {
      sourceId: "things:local",
      onResolve: (o) => outcomes.push(o),
    });

    const midCycle = {
      e: 1,
      v: 1,
      state: { lastModifiedTimestamp: 50, cycleQueueTotal: 480 },
    };
    const result = await versioned.sync(
      midCycle as unknown as Parameters<typeof versioned.sync>[0],
    );

    expect(outcomes[0]?.kind).toBe("resume");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });

  test("garbage state rebootstraps rather than parking the source", async () => {
    const { instance } = recordingInstance({ lastModifiedTimestamp: 1 });
    const outcomes: StateOutcome[] = [];
    const versioned = withVersionedState(instance, thingsStateSpec, {
      sourceId: "things:local",
      onResolve: (o) => outcomes.push(o),
    });

    const garbage = { e: 1, v: 1, state: { cycleQueueTotal: "not-a-number" } };
    await versioned.sync(garbage as unknown as Parameters<typeof versioned.sync>[0]);

    expect(outcomes[0]?.kind).toBe("rebootstrap");
  });
});
