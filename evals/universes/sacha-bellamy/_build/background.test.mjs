// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildBackground } from "./background.mjs";
import { context } from "./shared.mjs";

// Whole serialized fixture snapshots protect values, source/file ordering and
// cross-source copies at the reference date and calendar boundary cases.
it.each([
  ["2026-10-03", "93f2a4608fb7df4a72f37a873e79015e7e50c74ebe2729404ec1918ef6f47f1a"],
  ["2026-12-31", "9d0633c67bd82b986c7b5627f96144845618a4c6d9f9ac3c69dc6fa39eeb6489"],
  ["2027-03-28", "ece4e9dcbc0d97b263b336b57925049efc4e68f11686e30a34c18a2e05bb27c9"],
  ["2028-02-29", "b0a39c504f33a1fac562209cead0991bd108e5acc0c4f8564eca00288e4454f1"],
])("preserves complete background fixture serialization at %s", (asOf, expected) => {
  const serialized = JSON.stringify(buildBackground(context(asOf)));
  expect(createHash("sha256").update(serialized).digest("hex")).toBe(expected);
});
