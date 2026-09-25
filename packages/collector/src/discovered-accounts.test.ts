// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { brandDiscoveredAccounts } from "./discovered-accounts.js";

describe("branding what discovery returned", () => {
  test("a bare id and a descriptor both come back as descriptors", () => {
    expect(brandDiscoveredAccounts(["work", { id: "personal", label: "Personal" }])).toEqual([
      { id: "work" },
      { id: "personal", label: "Personal" },
    ]);
  });

  test("an account this host cannot address is skipped, and the rest survive", () => {
    // A browser profile titled with a space is the shape that does this. The
    // whole list arrives at once, so refusing the batch over one unusable
    // entry takes every configured source of that type down with it — and the
    // host then reads as "this source is not available here" rather than "one
    // profile cannot be named".
    expect(
      brandDiscoveredAccounts([
        "profile-one",
        { id: "Profile 2", label: "Second profile" },
        "profile-three",
      ]),
    ).toEqual([{ id: "profile-one" }, { id: "profile-three" }]);
  });

  test("every account being unaddressable is an empty list, never a throw", () => {
    expect(brandDiscoveredAccounts(["Profile 2", "Profile 3"])).toEqual([]);
  });
});
