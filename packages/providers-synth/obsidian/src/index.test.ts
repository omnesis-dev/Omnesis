// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import definition from "./index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("synthetic Obsidian keeps its discovered account without real vault identity resolution", async () => {
  // Pre-discovered mode, so the answer never depends on a pair marker some
  // earlier synthetic run left in this machine's config directory.
  vi.stubEnv("OMNESIS_SYNTH_PRE_DISCOVERED", "1");
  expect(definition.resolveAccountId).toBeUndefined();
  expect(
    (await definition.discover?.())?.map((account) =>
      typeof account === "string" ? account : account.id,
    ),
  ).toEqual(["Personal"]);
});
