// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { ProviderId, SourceId } from "@omnesis/types";
import {
  isStateEnvelope,
  withVersionedState,
  RefusedSourceStateError,
  type SourceInstance,
  type StateOutcome,
} from "@omnesis/source-sdk";
import { StravaActivitiesSource } from "./activities.js";
import { stravaActivitiesStateSpec } from "./state.js";
import type { StravaActivitiesCursor, StravaSummaryActivity } from "./types.js";
import type { ListActivitiesParams } from "./client.js";

const providerId = ProviderId("strava:42");
const sourceId = SourceId("strava-activities:42");

function makeActivity(id: number, startDateIso: string): StravaSummaryActivity {
  return {
    id,
    athlete: { id: 42 },
    name: `Activity ${id}`,
    distance: 5000,
    moving_time: 1800,
    elapsed_time: 1850,
    total_elevation_gain: 50,
    type: "Run",
    sport_type: "Run",
    start_date: startDateIso,
    start_date_local: startDateIso.replace("Z", ""),
    has_heartrate: false,
    kudos_count: 0,
    comment_count: 0,
    athlete_count: 1,
    trainer: false,
    commute: false,
    manual: false,
    private: false,
  };
}

/** Mock client that replays one canned page from `listActivities`. */
class MockClient {
  constructor(private pages: StravaSummaryActivity[][]) {}
  listActivities(_params: ListActivitiesParams): Promise<StravaSummaryActivity[]> {
    return Promise.resolve(this.pages.shift() ?? []);
  }
  getAthleteDetail(): Promise<never> {
    throw new Error("getAthleteDetail not expected");
  }
  getTokens(): never {
    throw new Error("getTokens not expected");
  }
}

function versionedInstance(client: MockClient): SourceInstance {
  const source = new StravaActivitiesSource(
    client as never,
    sourceId,
    providerId,
    undefined,
    undefined,
    undefined,
    undefined,
  );
  const instance: SourceInstance = {
    sync: () => {
      throw new Error("sync not expected — this source is structured-only");
    },
    syncStructured: (cursor) => source.syncStructured(cursor as StravaActivitiesCursor | null),
  };
  const outcomes: StateOutcome[] = [];
  const versioned = withVersionedState(instance, stravaActivitiesStateSpec, {
    sourceId: "strava-activities:42",
    onResolve: (outcome) => outcomes.push(outcome),
  });
  return Object.assign(versioned, { outcomes: () => outcomes });
}

describe("strava-activities declared state", () => {
  test("preserves the bounded detail acknowledgement queue and refuses malformed entries", () => {
    const legacy = { phase: "detail-backfill" };
    expect(stravaActivitiesStateSpec.decode(legacy)).toEqual(legacy);
    const current = { ...legacy, pendingDetailStamps: ["101", "102"] };
    expect(stravaActivitiesStateSpec.decode(current)).toEqual(current);
    for (const pendingDetailStamps of [null, "101", [101]]) {
      expect(stravaActivitiesStateSpec.decode({ ...legacy, pendingDetailStamps })).toBeNull();
    }
  });
  test.each([null, "101", [101], ["101", {}]])(
    "refuses malformed pending social stamps %j",
    async (pendingSocialStamps) => {
      const instance = versionedInstance(new MockClient([]));
      await expect(
        instance.syncStructured!({ phase: "incremental", pendingSocialStamps }),
      ).rejects.toThrow(RefusedSourceStateError);
    },
  );
  test("preserves a valid pending social stamp queue", () => {
    const stored = { phase: "incremental", pendingSocialStamps: ["101", "102"] };
    expect(stravaActivitiesStateSpec.decode(stored)).toEqual(stored);
  });
  test("resumes a mid-`snapshot-rewalk` cursor, not just a settled one", async () => {
    // A partial page: the rewalk is two pages in and has accumulated ids from
    // both, but has not yet reached a short page. `decode` must accept this —
    // not only the settled `incremental` shape — or every partial page would
    // be reclassified as legacy and re-migrated on the next page.
    const midCycleCursor: StravaActivitiesCursor = {
      phase: "snapshot-rewalk",
      snapshotBefore: 1_700_000_000,
      snapshotPage: 3,
      snapshotIds: ["101", "102", "103"],
      lastActivityTimestamp: 1_699_999_000,
    };

    // A full page (PAGE_SIZE = 100) keeps the rewalk from ending on this call,
    // so the source's own cursor stays in `snapshot-rewalk` — proving the
    // resumed run actually continued the phase rather than merely tolerating
    // its shape.
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeActivity(200 + i, "2024-01-01T00:00:00Z"),
    );
    const client = new MockClient([fullPage]);
    const instance = versionedInstance(client) as SourceInstance & {
      outcomes: () => StateOutcome[];
    };

    const result = await instance.syncStructured!(midCycleCursor);

    expect(instance.outcomes()[0]?.kind).toBe("resume");
    expect(isStateEnvelope(result.cursor)).toBe(true);
    const envelope = result.cursor as unknown as { state: StravaActivitiesCursor };
    expect(envelope.state.phase).toBe("snapshot-rewalk");
  });

  test("refuses rather than silently restarting when the phase is one this build no longer recognises", async () => {
    // Stands in for a retired or renamed phase from an older release —
    // exactly the case that used to return `null` from the source's own
    // validator and read as "no bookmark", triggering the full-account
    // re-enrichment `state.ts` documents.
    const retiredPhaseCursor = { phase: "gear-refresh" };

    const client = new MockClient([]);
    const instance = versionedInstance(client) as SourceInstance & {
      outcomes: () => StateOutcome[];
    };

    await expect(
      instance.syncStructured!(retiredPhaseCursor as unknown as StravaActivitiesCursor),
    ).rejects.toThrow(RefusedSourceStateError);
    expect(instance.outcomes()[0]?.kind).toBe("refused");
  });

  test("round-trips a settled `incremental` cursor as an envelope", async () => {
    const settledCursor: StravaActivitiesCursor = {
      phase: "incremental",
      lastActivityTimestamp: 1_700_000_000,
    };
    const client = new MockClient([[]]);
    const instance = versionedInstance(client) as SourceInstance & {
      outcomes: () => StateOutcome[];
    };

    const result = await instance.syncStructured!(settledCursor);

    expect(instance.outcomes()[0]?.kind).toBe("resume");
    expect(isStateEnvelope(result.cursor)).toBe(true);
  });
});
