// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { fleetCommitPlanBody, fleetUpdateRequestBody } from "./admin.js";

describe("fleet exact-commit schemas", () => {
  const commit = "a".repeat(40);

  test("accept a full lowercase commit and optional device selection", () => {
    expect(fleetCommitPlanBody.parse({ commit })).toEqual({ commit });
    expect(fleetUpdateRequestBody.parse({ commit, deviceIds: ["device-fictional"] })).toEqual({
      commit,
      deviceIds: ["device-fictional"],
    });
  });

  test("accept the operator's rewind permission as a boolean only", () => {
    expect(fleetUpdateRequestBody.parse({ allowRewind: true })).toEqual({ allowRewind: true });
    expect(fleetUpdateRequestBody.safeParse({ allowRewind: "yes" }).success).toBe(false);
  });

  test("reject malformed commits and unknown fields", () => {
    expect(fleetCommitPlanBody.safeParse({ commit: "abc" }).success).toBe(false);
    expect(fleetUpdateRequestBody.safeParse({ commit: commit.toUpperCase() }).success).toBe(false);
    expect(fleetUpdateRequestBody.safeParse({ commit, version: "0.5.4" }).success).toBe(false);
  });
});
