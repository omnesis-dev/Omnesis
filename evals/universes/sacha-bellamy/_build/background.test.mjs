// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildBackground } from "./background.mjs";
import { context } from "./shared.mjs";

// Whole serialized fixture snapshots protect values, source/file ordering and
// cross-source copies at the reference date and calendar boundary cases.
it.each([
  ["2026-10-03", "490c8116430d6f8e5934d2c6818b9ab5b49361b1e1ed20c21cd2ac5d07dd151a"],
  ["2026-12-31", "1f158f342f023e99dbfcca263a25ee84ac5d3f9c2b00fc15ce18e053b85c294b"],
  ["2027-03-28", "3cb50f45ddd638293e6314e3583b3222e719f5893a82e1ccad4984037b67d76b"],
  ["2028-02-29", "032e7e6d66251314a1f5b99e8de69f2454f8b346828bd7a1347801b8186847c8"],
])("preserves complete background fixture serialization at %s", (asOf, expected) => {
  const serialized = JSON.stringify(buildBackground(context(asOf)));
  expect(createHash("sha256").update(serialized).digest("hex")).toBe(expected);
});
