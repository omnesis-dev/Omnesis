// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { sourcesRefreshIntervalMs } from "../lib/sources-poll.js";

const settledSource = { id: "mail-1", removing: false, syncStatus: { state: "synced" } };
const settledIndex = {
  state: "running",
  totalGatewayDocs: 120,
  totalIndexed: 118,
  totalIndexErrors: 2,
  indexVersions: { active: { version: 2 }, building: null },
  lexicalIndex: { activeVersion: 3, targetVersion: 3, retiring: false, building: null },
};
const settled = { sources: [settledSource], indexStats: settledIndex, busy: {} };

describe("sourcesRefreshIntervalMs", () => {
  test("polls slowly once every source and the index have settled", () => {
    expect(sourcesRefreshIntervalMs(settled)).toBe(15_000);
    expect(sourcesRefreshIntervalMs({ sources: [], indexStats: null, busy: {} })).toBe(15_000);
  });

  test.each([
    ["a source is syncing", { sources: [{ ...settledSource, syncStatus: { state: "syncing" } }] }],
    ["a source is being removed", { sources: [{ ...settledSource, removing: true, syncStatus: null }] }],
    ["an action is running on a source", { busy: { "mail-1": "sync" } }],
    ["the indexer is starting", { indexStats: { ...settledIndex, state: "spawning" } }],
    ["documents are waiting to be indexed", { indexStats: { ...settledIndex, totalIndexed: 100 } }],
    [
      "a new index version is building",
      { indexStats: { ...settledIndex, indexVersions: { active: { version: 2 }, building: { version: 3 } } } },
    ],
    [
      "the keyword index is rebuilding",
      { indexStats: { ...settledIndex, lexicalIndex: { ...settledIndex.lexicalIndex, building: { version: 4 } } } },
    ],
  ])("polls every 2 seconds while %s", (_label, change) => {
    expect(sourcesRefreshIntervalMs({ ...settled, ...change })).toBe(2000);
  });
});
