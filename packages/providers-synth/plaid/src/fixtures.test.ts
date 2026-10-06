// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { plaidFixtureSettings } from "./fixtures.js";
const base = { transactionsSyncPages: [], accountsGet: {}, investmentsHoldingsGet: {} };
describe("synthetic Plaid settings", () => {
  test("omitted metadata preserves legacy settings", () => {
    expect(plaidFixtureSettings(base)).toEqual({
      institutionName: "Northstar Bank",
      snapshotDay: "2026-05-15",
    });
  });
  test("fixture institution and clock are authoritative except explicit day override", () => {
    const fixture = { ...base, institutionName: "Bank of America", snapshotDay: "2026-10-05" };
    expect(plaidFixtureSettings(fixture)).toEqual({
      institutionName: "Bank of America",
      snapshotDay: "2026-10-05",
    });
    expect(plaidFixtureSettings(fixture, "2026-10-06").snapshotDay).toBe("2026-10-06");
  });
  test.each(["2026-02-30", "invalid", "2026-1-01"])(
    "rejects invalid snapshot day %s",
    (snapshotDay) => {
      expect(() => plaidFixtureSettings({ ...base, snapshotDay })).toThrow("valid YYYY-MM-DD");
    },
  );
});
