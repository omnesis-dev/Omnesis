// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { analyticsIngestBody } from "./analytics.js";
import { setSyncStateBody, upsertWithCursorBody } from "./documents.js";

test.each([
  ["documents-partition-claims", upsertWithCursorBody],
  ["analytics-tuple-keys", analyticsIngestBody],
  ["source-account-family", setSyncStateBody],
] as const)("%s is accepted without silently stripping contract fields", (name, schema) => {
  const value = JSON.parse(
    readFileSync(new URL(`../../../../../wire-fixtures/${name}.json`, import.meta.url), "utf8"),
  );
  expect(schema.parse(value)).toEqual(value);
});
