// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beforeEach, describe, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ fixture: {} as Record<string, unknown> }));
vi.mock("@omnesis/providers-synth-common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/providers-synth-common")>()),
  loadActiveUniverse: () => ({}),
  loadSourceFixtureJson: () => state.fixture,
}));
beforeEach(() => {
  vi.resetModules();
  state.fixture = {
    accountId: "fictional-ios",
    device: "Fictional phone",
    sourceApp: "Health",
    body: [{ metric: "weight", slug: "weight", unit: "kg", values: [70, 71] }],
    activity: [],
    vitals: [],
    nutrition: [],
    environment: [],
    sleep: [],
    mindful: [],
    workouts: [],
  };
});
describe("synthetic health dates", () => {
  test("legacy metrics and default moods preserve their fixed dates", async () => {
    const fixtures = await import("./fixtures.js");
    expect(fixtures.bodyRecords()[0]?.start_time).toBe("2025-09-01T09:00:00.000Z");
    expect(fixtures.moodRecords()[0]?.start_time).toBe("2025-09-07T18:00:00.000Z");
  });
  test("custom start day spans a year boundary and uses explicit moods", async () => {
    state.fixture.startDay = "2026-12-31";
    state.fixture.moods = [
      {
        kind: "dailyMood",
        valence: 0.3,
        labels: ["calm"],
        associations: ["hobbies"],
        date: "2027-01-01",
        hour: 20,
      },
    ];
    const fixtures = await import("./fixtures.js");
    expect(fixtures.bodyRecords().map((row) => row.start_time)).toEqual([
      "2026-12-31T09:00:00.000Z",
      "2027-01-01T09:00:00.000Z",
    ]);
    expect(fixtures.moodRecords()).toMatchObject([
      { start_time: "2027-01-01T20:00:00.000Z", valence: 0.3 },
    ]);
  });
  test.each(["2026-02-30", "invalid", "2026-1-01"])(
    "rejects invalid start day %s",
    async (startDay) => {
      state.fixture.startDay = startDay;
      const fixtures = await import("./fixtures.js");
      expect(() => fixtures.bodyRecords()).toThrow("valid YYYY-MM-DD");
    },
  );
  test("explicit empty moods do not manufacture mood data", async () => {
    state.fixture.moods = [];
    expect((await import("./fixtures.js")).moodRecords()).toEqual([]);
  });
});
