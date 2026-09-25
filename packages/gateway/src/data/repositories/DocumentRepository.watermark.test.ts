// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { getSourceWatermark } from "./WatermarkRepository.js";
import { deleteAllBySource, upsertWithCursor } from "./DocumentRepository.js";

let path: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  path = `/tmp/omnesis-document-watermark-${randomUUID()}.db`;
  db = createDatabase(path);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});

describe("upsertWithCursor source watermark", () => {
  test("commits terminal coverage with the cursor and rejects it with a stale wipe epoch", () => {
    const sourceId = "example:source";
    const first = upsertWithCursor(db, {
      providerId: "example",
      sourceId,
      cursor: { page: 1 },
      hasMore: false,
      wipeEpoch: 0,
      watermark: { guarantee: "change-cut", upstreamCut: "cut-1" },
    });
    expect(first.rejected).toBeUndefined();
    expect(getSourceWatermark(db, sourceId)?.generation).toBe(1);

    deleteAllBySource(db, sourceId);
    const rejected = upsertWithCursor(db, {
      providerId: "example",
      sourceId,
      cursor: { page: 2 },
      hasMore: false,
      wipeEpoch: 0,
      watermark: { guarantee: "change-cut", upstreamCut: "cut-2" },
    });
    expect(rejected.rejected).toBe(true);
    expect(getSourceWatermark(db, sourceId)).toBeNull();
  });

  test("does not promote a partial page even if an older client sends a claim", () => {
    upsertWithCursor(db, {
      providerId: "example",
      sourceId: "example:partial",
      cursor: { page: 1 },
      hasMore: true,
      watermark: { guarantee: "snapshot" },
    });
    expect(getSourceWatermark(db, "example:partial")).toBeNull();
  });
});
