// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { gearIdList } from "./sql.js";

describe("gearIdList", () => {
  test("quotes each valid gear id once", () => {
    expect(gearIdList(["b12345", "g67890", "b12345"])).toBe("'b12345', 'g67890'");
  });

  test("leaves out anything that could close its quotes, and anything not a string", () => {
    // The ids are spliced into SQL, since the read handle binds nothing.
    expect(gearIdList(["g1", "g1", "b2'); DROP TABLE strava_gear; --", "g 3", 7, null])).toBe(
      "'g1'",
    );
  });

  test("is empty when no id is valid", () => {
    expect(gearIdList([])).toBe("");
    expect(gearIdList([undefined, "", "x'y"])).toBe("");
  });
});
