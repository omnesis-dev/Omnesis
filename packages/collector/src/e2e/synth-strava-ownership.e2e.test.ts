// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SyntheticE2EHarness } from "./synth-harness.js";

describe("synthetic Strava uses the real hybrid ownership contract", () => {
  let harness: SyntheticE2EHarness;
  const sourceId = "strava-activities:7000000";

  beforeAll(async () => {
    harness = new SyntheticE2EHarness({ gatewayMode: "synthetic", universe: "e2e-minimal" });
    await harness.start();
  }, 240_000);

  afterAll(async () => {
    await harness?.destroy();
  }, 15_000);

  test("the collector commits activities, owned zone rows and searchable documents together", async () => {
    expect(harness.getSourceIds()).toContain(sourceId);
    await harness.triggerSyncAndWait(sourceId, 60_000);
    expect(harness.getStatus().statuses.find((entry) => entry.sourceId === sourceId)).toMatchObject(
      {
        state: "idle",
      },
    );
    expect(await harness.gatewayJson(`/documents/count/${sourceId}`)).toEqual({ count: 3 });
    for (const [table, owner] of [
      ["strava_activities", "athlete_id"],
      ["strava_activity_zones", "source_athlete_id"],
    ]) {
      const result = await harness.gatewayJson<{ rows: Array<[number, number, number, number]> }>(
        "/analytics/sql",
        {
          method: "POST",
          body: JSON.stringify({
            sql: `SELECT COUNT(*), MIN(${owner}), MAX(${owner}), COUNT(*) FILTER (WHERE ${owner} IS NULL) FROM ${table}`,
          }),
        },
      );
      expect(Number(result.rows[0][0])).toBeGreaterThan(0);
      expect(result.rows[0].slice(1).map(Number)).toEqual([7000000, 7000000, 0]);
    }
    // A completed synthetic cursor is a no-op, not a duplicate second hybrid page.
    await harness.triggerSyncAndWait(sourceId, 60_000);
    expect(await harness.gatewayJson(`/documents/count/${sourceId}`)).toEqual({ count: 3 });
  }, 150_000);
});
