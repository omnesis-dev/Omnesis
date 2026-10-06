// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { tableWrites } from "@omnesis/source-sdk";
import { SourceId, ProviderId } from "@omnesis/types";
const state = vi.hoisted(() => ({ fixture: [] as unknown }));
vi.mock("@omnesis/providers-synth-common", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omnesis/providers-synth-common")>()),
  loadSourceFixtureJson: () => state.fixture,
  loadActiveUniverse: () => ({}),
}));
import source, { groupDays, loadSegments, mapRecord } from "./index.js";
const row = {
  id: "walk-1",
  type: "walking" as const,
  startTime: "2026-10-03T12:00:00Z",
  endTime: "2026-10-03T12:30:00Z",
  confidence: "high" as const,
};
describe("synthetic motion", () => {
  test("bootstrap co-emits real-schema duration and complete daily document", async () => {
    state.fixture = [row];
    const instance = await source.create!({
      sourceId: SourceId("activity-segments:synthetic"),
      providerId: ProviderId("activity-segments:synthetic"),
      accountId: "synthetic",
    } as never);
    const first = await instance.syncStructured!(null);
    expect(tableWrites(first.analytics)[0]?.records).toMatchObject([
      { id: "walk-1", account_id: "synthetic", duration_seconds: 1800 },
    ]);
    expect(first.documents).toHaveLength(1);
    expect(first.documents?.[0]?.metadata.rollingAggregate).toBe(true);
    expect(
      tableWrites((await instance.syncStructured!(first.cursor)).analytics)[0]?.records,
    ).toEqual([]);
  });
  test("midnight crossings split documents but do not double-count analytics rows", () => {
    const start = new Date(2026, 9, 3, 23, 50);
    const end = new Date(2026, 9, 4, 0, 10);
    const segment = { ...row, startTime: start.toISOString(), endTime: end.toISOString() };
    expect(groupDays([segment])).toHaveLength(2);
    expect(
      groupDays([segment])
        .flatMap((day) => day.segments)
        .reduce((sum, item) => sum + Number(mapRecord(item, "synthetic").duration_seconds), 0),
    ).toBe(1200);
  });
  test("negative durations and repeated segment ids are refused", () => {
    state.fixture = [{ ...row, endTime: row.startTime }];
    expect(loadSegments).toThrow();
    state.fixture = [row, row];
    expect(loadSegments).toThrow("repeats a segment id");
  });
});
