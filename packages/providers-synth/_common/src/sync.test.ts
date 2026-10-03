// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, test, vi } from "vitest";
import { SourceId, ProviderId } from "@omnesis/types";
import { pageFromFixture, syncFromFixture } from "./sync.js";

afterEach(() => vi.unstubAllEnvs());

describe("synthetic page admission", () => {
  test("legacy default emits five entries and advances its cursor", () => {
    vi.stubEnv("OMNESIS_SYNTH_BATCH_SIZE", undefined);
    expect(pageFromFixture([0, 1, 2, 3, 4, 5], null)).toMatchObject({
      batch: [0, 1, 2, 3, 4],
      newCursor: { offset: 5 },
      hasMore: true,
    });
  });
  test.each(["1", "500"])("bounded override %s preserves final snapshots", (raw) => {
    vi.stubEnv("OMNESIS_SYNTH_BATCH_SIZE", raw);
    const entries = Array.from({ length: 501 }, (_, i) => i);
    const map = (id: number) => ({
      sourceId: SourceId("gmail:fiction@example.com"),
      providerId: ProviderId("google:fiction@example.com"),
      externalId: String(id),
      title: String(id),
      content: String(id),
      contentHash: String(id),
      metadata: {},
      sourceCreatedAt: "2026-10-03T00:00:00Z",
      sourceUpdatedAt: "2026-10-03T00:00:00Z",
    });
    let cursor = null;
    let result;
    do {
      result = syncFromFixture(entries, cursor, map);
      cursor = result.cursor;
    } while (result.hasMore);
    expect(result.presentExternalIds).toEqual(entries.map(String));
    expect(cursor).toMatchObject({ offset: 501 });
  });
  test.each(["", "0", "501", "-1", "1.5", "NaN", "5x", " 5", "05"])(
    "rejects invalid override %s",
    (raw) => {
      vi.stubEnv("OMNESIS_SYNTH_BATCH_SIZE", raw);
      expect(() => pageFromFixture([1], null)).toThrow("1 to 500");
    },
  );
  test("explicit caller page size wins even over an invalid environment override", () => {
    vi.stubEnv("OMNESIS_SYNTH_BATCH_SIZE", "invalid");
    expect(pageFromFixture([1, 2, 3], null, 2).batch).toEqual([1, 2]);
  });
});
