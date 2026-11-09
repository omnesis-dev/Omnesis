// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../db.js";
import { upsertDocuments } from "./DocumentRepository.js";
import {
  computeSourceStatsRow,
  refreshSourceStatsRow,
  upsertSourceStatsRow,
} from "./SourceStatsRepository.js";
import type { Db } from "../types.js";
import type { DocumentInput } from "@omnesis/types";

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function inventedDoc(sourceId: string, n: number): DocumentInput {
  const extra =
    n % 4 === 0 ? { unitCount: n % 13 } : n % 4 === 1 ? { messageCount: (n % 5) + 1 } : {};
  return {
    providerId: "synth-mail" as DocumentInput["providerId"],
    sourceId: sourceId as DocumentInput["sourceId"],
    externalId: `synth-${sourceId}-${n}`,
    title: `Quarterly review ${n} ${"é".repeat(n % 3)}`,
    content: `Budget line ${n} for the summit. `.repeat((n % 11) + 1),
    contentHash: `synth-hash-${n}`,
    metadata: { extra },
    sourceCreatedAt: new Date(
      Date.UTC(2020, 0, 1) + ((n * 7919) % 1000) * 86_400_000,
    ).toISOString(),
    sourceUpdatedAt: "2026-02-01T10:00:00.000Z",
  };
}

/** The aggregation as one statement over the whole source. */
function reference(db: Db, sourceId: string) {
  return db
    .prepare(
      `SELECT COUNT(*) AS count,
              MIN(source_created_at) AS earliest,
              MAX(source_created_at) AS latest,
              COALESCE(SUM(LENGTH(content) + LENGTH(title) + LENGTH(metadata)), 0) AS dataSize,
              SUM(COALESCE(json_extract(metadata, '$.extra.unitCount'),
                           json_extract(metadata, '$.extra.messageCount'))) AS totalUnits
         FROM documents WHERE source_id = ?`,
    )
    .get(sourceId);
}

describe("computeSourceStatsRow reads a source in chunks", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
    const docs: DocumentInput[] = [];
    for (let n = 0; n < 230; n++) docs.push(inventedDoc(n % 3 === 0 ? "synth-b" : "synth-a", n));
    upsertDocuments(db, docs);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("gives the single-statement result whatever the chunk size", () => {
    for (const sourceId of ["synth-a", "synth-b", "synth-missing"]) {
      const expected = reference(db, sourceId);
      for (const chunkRows of [1, 2, 7, 64, 153, 154, 155, 10_000]) {
        const {
          capturedVersion: _v,
          capturedDocCount: _c,
          provisional: _p,
          ...agg
        } = computeSourceStatsRow(db, sourceId, chunkRows);
        expect(agg).toEqual(expected);
      }
    }
  });

  it("orders text minimum and maximum as SQLite does", () => {
    db.exec(
      `UPDATE documents SET source_created_at = CASE rowid % 3
         WHEN 0 THEN '2026-01-01T00:00:00.000Z' || char(57344)
         WHEN 1 THEN '2026-01-01T00:00:00.000Z' || char(128512)
         ELSE '2025-12-31T23:59:59.999Z' END
       WHERE source_id = 'synth-a'`,
    );
    const expected = reference(db, "synth-a");
    for (const chunkRows of [1, 3, 10_000]) {
      const agg = computeSourceStatsRow(db, "synth-a", chunkRows);
      expect([agg.earliest, agg.latest]).toEqual([
        (expected as { earliest: string }).earliest,
        (expected as { latest: string }).latest,
      ]);
    }
  });

  it("is never stored over a write that landed between its chunks", () => {
    const agg = computeSourceStatsRow(db, "synth-a", 5);
    upsertDocuments(db, [inventedDoc("synth-a", 10_001)]);
    upsertSourceStatsRow(db, "synth-a", agg);
    const row = db
      .prepare<[string], { doc_count: number; needs_refresh: number }>(
        "SELECT doc_count, needs_refresh FROM source_stats WHERE source_id = ?",
      )
      .get("synth-a")!;
    expect(row.needs_refresh).toBe(1);
    expect(row.doc_count).toBe((reference(db, "synth-a") as { count: number }).count);
  });

  it("leaves a chunked result without a version to check marked for another pass", () => {
    db.exec("DELETE FROM source_stats WHERE source_id = 'synth-a'");
    const chunked = computeSourceStatsRow(db, "synth-a", 5);
    expect(chunked.provisional).toBe(true);
    upsertSourceStatsRow(db, "synth-a", chunked);
    const needsRefresh = () =>
      db
        .prepare<[string], { needs_refresh: number }>(
          "SELECT needs_refresh FROM source_stats WHERE source_id = ?",
        )
        .get("synth-a")!.needs_refresh;
    expect(needsRefresh()).toBe(1);

    const versioned = computeSourceStatsRow(db, "synth-a", 5);
    expect(versioned.provisional).toBeUndefined();
    upsertSourceStatsRow(db, "synth-a", versioned);
    expect(needsRefresh()).toBe(0);

    db.exec("DELETE FROM source_stats WHERE source_id = 'synth-a'");
    expect(computeSourceStatsRow(db, "synth-a", 10_000).provisional).toBeUndefined();
    refreshSourceStatsRow(db, "synth-a");
    expect(needsRefresh()).toBe(0);
  });
});
