// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import {
  deleteSourceWatermark,
  getSourceWatermark,
  listSourceWatermarks,
  upsertSourceWatermark,
} from "./WatermarkRepository.js";

let path: string;
let db: ReturnType<typeof createDatabase>;

beforeEach(() => {
  path = `/tmp/omnesis-watermark-${randomUUID()}.db`;
  db = createDatabase(path);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
});

describe("source watermarks", () => {
  test("persists only a digest of an opaque upstream cut and advances generation", () => {
    upsertSourceWatermark(db, "mail:example", {
      guarantee: "change-cut",
      semanticTimeThrough: "2026-08-01T10:00:00.000Z",
      observedAt: "2026-08-01T10:01:00.000Z",
      upstreamCut: "private-provider-token",
    });
    const first = getSourceWatermark(db, "mail:example")!;
    expect(first.upstream_cut_digest).not.toContain("private-provider-token");
    expect(JSON.stringify(first)).not.toContain("private-provider-token");

    upsertSourceWatermark(db, "mail:example", { guarantee: "observation" });
    const row = getSourceWatermark(db, "mail:example")!;
    expect(row.stream_id).toBe("default");
    expect(row.generation).toBe(2);
    expect(row.upstream_cut_digest).toBeNull();
  });

  test("lists and removes a source's sole V1 coverage record", () => {
    upsertSourceWatermark(db, "one:example", { guarantee: "snapshot" });
    upsertSourceWatermark(db, "two:example", { guarantee: "observation" });
    expect(listSourceWatermarks(db).map((row) => row.source_id)).toEqual([
      "one:example",
      "two:example",
    ]);
    deleteSourceWatermark(db, "one:example");
    expect(getSourceWatermark(db, "one:example")).toBeNull();
  });
});
