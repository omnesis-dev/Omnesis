// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { resolveSourceState } from "@omnesis/source-sdk";
import { immichStateSpec } from "./state.js";
import type { ImmichCursor } from "./types.js";

const settled: ImmichCursor = {
  phase: "incremental",
  syncedUpTo: "2026-06-02T00:00:00.000Z",
  lastSnapshotAt: "2026-06-02T00:00:00.000Z",
};
const midSweep: ImmichCursor = {
  phase: "snapshot",
  page: 3,
  windowEnd: "2026-06-03T00:00:00.000Z",
  syncedUpTo: "2026-06-02T00:00:00.000Z",
  snapshot: { ids: { assets: ["x", "y"] } },
  sweepIssues: [
    { code: "partial-read", scope: "partition", kind: "permission", count: 1, message: "m" },
  ],
};
const recheck: ImmichCursor = {
  phase: "incremental",
  page: 1,
  windowEnd: "2026-06-03T00:00:00.000Z",
  syncedUpTo: "2026-06-02T00:00:00.000Z",
  recheck: true,
};

describe("immichStateSpec", () => {
  it.each([
    ["settled", settled],
    ["mid-sweep", midSweep],
    ["window recheck", recheck],
    ["first page of a backfill", { phase: "backfill" } as ImmichCursor],
  ])("reads back a %s cursor", (_label, cursor) => {
    expect(immichStateSpec.decode(JSON.parse(JSON.stringify(cursor)))).toEqual(cursor);
  });

  it.each([
    ["no phase", { syncedUpTo: "2026-06-02T00:00:00.000Z" }],
    ["an unknown phase", { phase: "sideways" }],
    ["a page without its window", { phase: "backfill", page: 2 }],
    [
      "a page that is not a page",
      { phase: "backfill", page: 0, windowEnd: "2026-06-03T00:00:00.000Z" },
    ],
    ["a date that is not a date", { phase: "incremental", syncedUpTo: "yesterday" }],
    ["a recheck outside a sweep", { phase: "incremental", recheck: true }],
    ["a recheck of a full sweep", { ...midSweep, recheck: true }],
    ["an issue that is not one", { ...midSweep, sweepIssues: [{ scope: "source", message: "m" }] }],
    ["an array", []],
  ])("refuses %s", (_label, value) => {
    expect(immichStateSpec.decode(value)).toBeNull();
  });

  it("resumes an installed envelope and rebootstraps an unreadable one", () => {
    expect(resolveSourceState(immichStateSpec, { e: 1, v: 1, state: midSweep })).toMatchObject({
      kind: "resume",
      state: midSweep,
    });
    expect(resolveSourceState(immichStateSpec, null)).toEqual({ kind: "fresh" });
    expect(
      resolveSourceState(immichStateSpec, { e: 1, v: 1, state: { phase: "nope" } }),
    ).toMatchObject({
      kind: "rebootstrap",
    });
  });
});
