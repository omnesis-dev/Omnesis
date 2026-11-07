// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase } from "../../db.js";
import { MIGRATIONS } from "../../data/migrations.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import {
  DATES_PENDING_AGE_INDEX,
  applyExtractedDates,
  fetchDateExtractionBatch,
} from "./storage.js";
import type { Db } from "../../data/types.js";
import type { DocumentInput } from "@omnesis/types";

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function inventedDoc(n: number): DocumentInput {
  return {
    providerId: "synth-drive" as DocumentInput["providerId"],
    sourceId: "synth-drive" as DocumentInput["sourceId"],
    externalId: `synth-file-${n}`,
    title: `Itinerary draft ${n}`,
    content: `Harbor review on 2026-0${(n % 9) + 1}-1${n % 10} and the ledger after. `.repeat(
      n % 7,
    ),
    contentHash: `synth-hash-${n}`,
    metadata: n % 3 === 0 ? { extra: { threadId: `synth-thread-${n % 4}` } } : {},
    sourceCreatedAt: "2026-03-01T10:00:00.000Z",
    sourceUpdatedAt: "2026-03-01T10:00:00.000Z",
  };
}

/** The batch as one full sort of the pending set would order it. */
function referenceBatch(db: Db, limit: number, maxChars: number, excludeIds: string[]): unknown[] {
  const excluded =
    excludeIds.length > 0 ? `AND id NOT IN (${excludeIds.map(() => "?").join(", ")})` : "";
  return db
    .prepare(
      `SELECT id, title, substr(content, 1, ?) AS content,
              LENGTH(content) AS contentLength,
              COALESCE(json_extract(metadata, '$.dateAnchorDay'),
                       source_updated_at, source_created_at) AS anchorAt,
              json_extract(metadata, '$.addressedToAgent') IS 1 AS addressed,
              source_id || char(0) || COALESCE(
                json_extract(metadata, '$.extra.threadId'),
                json_extract(metadata, '$.extra.conversationId')
              ) AS threadKey
         FROM documents NOT INDEXED
        WHERE dates_extracted_at IS NULL ${excluded}
        ORDER BY ingested_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(maxChars, ...excludeIds, limit)
    .map((raw) => {
      const { addressed, ...row } = raw as Record<string, unknown> & { addressed: number };
      return addressed === 1 ? { ...row, addressed: true } : row;
    });
}

describe("fetchDateExtractionBatch reads a bounded batch", () => {
  let db: Db;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
    upsertDocuments(
      db,
      Array.from({ length: 240 }, (_, n) => inventedDoc(n)),
    );
    // Arrival times with long runs of ties, as one sync page leaves them.
    db.exec(
      `UPDATE documents SET ingested_at = strftime('%Y-%m-%dT%H:%M:%fZ', '2026-04-01', '+' || (rowid % 17) || ' minutes')`,
    );
    const stamped = db
      .prepare<[], { id: string }>("SELECT id FROM documents WHERE rowid % 5 = 0")
      .all()
      .map((r) => ({ id: r.id, dates: [] }));
    applyExtractedDates(db, stamped);
  });
  afterEach(() => {
    db.close();
    cleanupDb(dbPath);
  });

  it("returns exactly the rows a full sort of the pending set returns", () => {
    const pendingIds = db
      .prepare<[], { id: string }>("SELECT id FROM documents WHERE dates_extracted_at IS NULL")
      .all()
      .map((r) => r.id);
    const excludes = [[], pendingIds.slice(0, 9), pendingIds.filter((_, i) => i % 4 === 1)];
    for (const limit of [1, 7, 50, 500]) {
      for (const maxChars of [12, 50_000]) {
        for (const excludeIds of excludes) {
          expect(fetchDateExtractionBatch(db, limit, maxChars, excludeIds)).toEqual(
            referenceBatch(db, limit, maxChars, excludeIds),
          );
        }
      }
    }
  });

  it("walks the pending-age index and never sorts the backlog", () => {
    const statements: string[] = [];
    const spy = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare")
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    fetchDateExtractionBatch(spy, 50, 50_000, ["synth-excluded"]);
    expect(statements).toHaveLength(1);
    const plan = db
      .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${statements[0]}`)
      .all(50_000, "synth-excluded", 50)
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toContain(DATES_PENDING_AGE_INDEX);
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("exists on a fresh database and migration 212 restores it on an upgraded one", () => {
    const indexed = () =>
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(DATES_PENDING_AGE_INDEX) !== undefined;
    expect(indexed()).toBe(true);
    db.exec(`DROP INDEX ${DATES_PENDING_AGE_INDEX}`);
    expect(indexed()).toBe(false);
    const migration = MIGRATIONS.find((m) => m.version === 212)!;
    migration.up(db);
    migration.up(db);
    expect(indexed()).toBe(true);
  });
});
