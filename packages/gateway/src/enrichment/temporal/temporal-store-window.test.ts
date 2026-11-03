// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPORAL_STATUSES } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { TemporalQueryService } from "./temporal-query-service.js";
import { resolveTemporalRange } from "./temporal-range.js";
import {
  compareKeys,
  readTemporalStoreWindow,
  type RankedTemporalItem,
  type TemporalStoreWindowRequest,
} from "./temporal-store-window.js";
import {
  FIXTURE_WINDOWS,
  FIXTURE_ZONES,
  fixtureScopes,
  seedTemporalFixture,
  type FixtureIds,
} from "./__fixtures__/test-utils.js";
import type { TemporalItem, TemporalQueryInput } from "@omnesis/core";

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function anchoredIn(
  entries: readonly RankedTemporalItem[],
  range: { fromMs: number; toExclusiveMs: number },
): RankedTemporalItem[] {
  return entries
    .filter(
      ({ key }) =>
        (key.startMs >= range.fromMs && key.startMs < range.toExclusiveMs) ||
        (key.endExclusiveMs > range.fromMs && key.endExclusiveMs <= range.toExclusiveMs),
    )
    .sort((left, right) => compareKeys(left.key, right.key));
}

describe("temporal store window", () => {
  let path: string;
  let db: ReturnType<typeof createDatabase>;
  let ids: FixtureIds;

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    ids = seedTemporalFixture(db);
  });

  afterEach(() => {
    db.close();
    cleanup(path);
  });

  const request = (
    input: TemporalQueryInput,
    anchoredOnly: boolean,
  ): TemporalStoreWindowRequest => ({
    input: { ...input, statuses: input.statuses ?? [...TEMPORAL_STATUSES] },
    range: resolveTemporalRange(input),
    after: null,
    limit: 100,
    origins: ["annotation"],
    hideUnworthy: false,
    anchoredOnly,
  });

  it("reads exactly the anchored annotations a full read marks anchored, in every zone and scope", () => {
    let anchored = 0;
    let spanning = 0;
    for (const timeZone of FIXTURE_ZONES) {
      for (const window of FIXTURE_WINDOWS) {
        for (const scope of fixtureScopes(ids)) {
          const input: TemporalQueryInput = { ...window, ...scope, timeZone };
          const full = readTemporalStoreWindow(db, request(input, false));
          const narrow = readTemporalStoreWindow(db, request(input, true));
          const range = resolveTemporalRange(input);
          const expected = anchoredIn(full.ranked, range);
          expect(anchoredIn(narrow.ranked, range), JSON.stringify(input)).toStrictEqual(expected);
          anchored += expected.length;
          spanning += full.ranked.length - expected.length;
        }
      }
    }
    // The fixture exercises both sides: anchored items to keep and spanning
    // ones (the year, the multi-year range, the open-ended row) to leave out.
    expect(anchored).toBeGreaterThan(300);
    expect(spanning).toBeGreaterThan(300);
  });

  it("seeks the anchored annotations through both interval indexes", () => {
    const statements: string[] = [];
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql.includes("FROM temporal_annotations e")) statements.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    readTemporalStoreWindow(db, request({ from: "2026-10-12", timeZone: "UTC" }, true));
    spy.mockRestore();

    expect(statements).toHaveLength(1);
    const sql = statements[0]!;
    const plan = (
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => 0)) as Array<{
        detail: string;
      }>
    ).map((row) => row.detail);
    expect(plan).toContainEqual(expect.stringMatching(/SEARCH .*idx_temporal_annotations_start/));
    expect(plan).toContainEqual(expect.stringMatching(/SEARCH .*idx_temporal_annotations_end/));
    expect(plan.filter((detail) => detail.startsWith("SCAN"))).toEqual([]);
  });

  it("returns from the anchored read the same items a full query marks anchored", async () => {
    const service = new TemporalQueryService(db);
    for (const timeZone of FIXTURE_ZONES) {
      for (const window of FIXTURE_WINDOWS) {
        for (const scope of fixtureScopes(ids)) {
          const input: TemporalQueryInput = {
            ...window,
            ...scope,
            timeZone,
            origins: ["projection", "annotation", "mention"],
          };
          const pages: TemporalItem[] = [];
          let cursor: string | undefined;
          do {
            const page = await service.query({ ...input, cursor, limit: 3 });
            pages.push(...page.items);
            cursor = page.nextCursor;
          } while (cursor);
          const expected = pages.filter((item) => item.anchored).slice(0, 5);
          expect(
            await service.anchoredItems({ ...input, limit: 5 }),
            JSON.stringify(input),
          ).toStrictEqual(expected);
        }
      }
    }
  });
});
