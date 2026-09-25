// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
import definition from "./index.js";

test("synthetic Obsidian keeps its discovered account without real vault identity resolution", async () => {
  expect(definition.resolveAccountId).toBeUndefined();
  expect(
    (await definition.discover?.())?.map((account) =>
      typeof account === "string" ? account : account.id,
    ),
  ).toEqual(["Personal"]);
});
