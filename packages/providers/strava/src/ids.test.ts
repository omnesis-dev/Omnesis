// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { parseStravaJson, stravaId } from "./ids.js";
import { activityIdList, ownedBy } from "./sql.js";

describe("exact Strava IDs", () => {
  test("keeps installed numeric IDs unchanged, even when id_str is present", () => {
    expect(
      parseStravaJson(
        '{"id":4242,"id_str":"4242","athlete":{"id":77,"id_str":"77"},"distance":1234.5}',
      ),
    ).toEqual({ id: 4242, id_str: "4242", athlete: { id: 77, id_str: "77" }, distance: 1234.5 });
    expect(stravaId(4242n)).toBe(4242);
    expect(stravaId("4242")).toBe(4242);
  });

  test("prefers id_str and preserves nested references without a string companion", () => {
    expect(
      parseStravaJson(
        '{"id":9007199254740992,"id_str":"9007199254740993","athlete":{"id":9223372036854775807,"id_str":"9223372036854775807"},"laps":[{"activity":{"id":9007199254740993}}],"activity_id":9007199254740993}',
      ),
    ).toEqual({
      id: "9007199254740993",
      id_str: "9007199254740993",
      athlete: { id: "9223372036854775807", id_str: "9223372036854775807" },
      laps: [{ activity: { id: "9007199254740993" } }],
      activity_id: "9007199254740993",
    });
    expect(stravaId(9223372036854775807n)).toBe("9223372036854775807");
  });

  test("never builds SQL from rounded or malformed identifiers", () => {
    for (const value of [
      9007199254740992,
      NaN,
      Infinity,
      -1,
      0,
      "1); DROP TABLE x",
      "1e20",
      "1.5",
      "",
      null,
    ]) {
      expect(() => stravaId(value)).toThrow();
      expect(activityIdList([value])).toBe("");
    }
    expect(ownedBy("9223372036854775807")).toBe("athlete_id = 9223372036854775807");
    expect(activityIdList([42, "9007199254740993", 9223372036854775807n])).toBe(
      "42, 9007199254740993, 9223372036854775807",
    );
  });
});
