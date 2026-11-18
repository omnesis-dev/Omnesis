// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { bytesBeforeMonthCutoff, storageSources } from "./storage-data.js";

test("joins accounting by source and month and distributes only measured lexical allocation", () => {
  const rows = storageSources({
    logical: { sources: [
      { sourceId: "archive:one", payloadBytes: 60, months: [
        { month: "2020-01", payloadBytes: 30 }, { month: "unknown", payloadBytes: 30 },
      ] },
    ] },
    index: { lexicalBytes: 100, sources: [
      { sourceId: "archive:one", month: "2020-01", textBytes: 10, embeddingBytes: 20 },
      { sourceId: "archive:two", month: "2020-02", textBytes: 30, embeddingBytes: 40 },
    ] },
  });
  expect(rows).toEqual([
    { sourceId: "archive:two", documentBytes: 0, vectorBytes: 40, lexicalBytes: 105, lexicalPartial: false, bytes: 145,
      months: [{ month: "2020-02", bytes: 145 }] },
    { sourceId: "archive:one", documentBytes: 60, vectorBytes: 20, lexicalBytes: 35, lexicalPartial: false, bytes: 115,
      months: [{ month: "2020-01", bytes: 85 }, { month: "unknown", bytes: 30 }] },
  ]);
  expect(bytesBeforeMonthCutoff(rows[1].months, "2020-01-20")).toBe(0);
  expect(bytesBeforeMonthCutoff(rows[1].months, "2020-02-01")).toBe(85);
});

test("keeps unavailable measurements distinct from zero and retains sources with a policy", () => {
  expect(storageSources({
    retention: [{ sourceId: "archive:one" }],
  })).toEqual([
    { sourceId: "archive:one", documentBytes: null, vectorBytes: null, lexicalBytes: null, lexicalPartial: false, bytes: 0, months: [] },
  ]);
});

test("includes measured indexed text when lexical allocation is unavailable", () => {
  const [row] = storageSources({index: {lexicalBytes: null, sources: [
    {sourceId: "archive:one", month: "2020-01", textBytes: 15, embeddingBytes: 20},
  ]}});
  expect(row).toMatchObject({documentBytes: null, lexicalBytes: 15, lexicalPartial: true, bytes: 35});
});
