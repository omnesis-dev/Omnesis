// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildBackground } from "./background.mjs";
import { context } from "./shared.mjs";

// Whole serialized fixture snapshots protect values, source/file ordering and
// cross-source copies at the reference date and calendar boundary cases.
it.each([
  ["2026-10-03", "9a32a3ea74a89e36020f42ab7ecb980f9d53e5f416340acaf4db4a9d0f59a2f0"],
  ["2026-12-31", "c4be78ade6cb29d3dc15af7354c2f9c1ad7a7c7149236c5580fcf10334e8ae4d"],
  ["2027-03-28", "043f0b14220b25a61db354a4bea069cdbfcef20538cad594b0fbfa2ebadc390b"],
  ["2028-02-29", "fdf7e083604bcc97e3ccec86c35c226aa95e95f1ab9bf534b927266b336ae884"],
])("preserves complete background fixture serialization at %s", (asOf, expected) => {
  const serialized = JSON.stringify(buildBackground(context(asOf)));
  expect(createHash("sha256").update(serialized).digest("hex")).toBe(expected);
});
