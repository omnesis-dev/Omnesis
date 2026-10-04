// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  DOCUMENTS_SOURCE_EXTERNAL_ID_INDEX,
  indexDocumentsBySourceExternalId,
} from "./migration-187-documents-source-external-index.js";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  // A documents table that predates streams: the index must not need them.
  db.exec(`CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    UNIQUE(provider_id, source_id, external_id)
  )`);
  db.exec("CREATE INDEX idx_documents_source_id ON documents(source_id)");
});

afterEach(() => db.close());

function indexColumns(): string[] {
  return db
    .prepare<[string], { name: string }>("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
    .all(DOCUMENTS_SOURCE_EXTERNAL_ID_INDEX)
    .map((row) => row.name);
}

test("indexes documents by source and external id, idempotently", () => {
  indexDocumentsBySourceExternalId(db);
  indexDocumentsBySourceExternalId(db);

  expect(indexColumns()).toEqual(["source_id", "external_id"]);
  const plan = db
    .prepare<
      [string, string],
      { detail: string }
    >("EXPLAIN QUERY PLAN SELECT id FROM documents WHERE source_id = ? AND external_id = ?")
    .all("web", "https://example.com/");
  expect(plan.map((row) => row.detail)).toEqual([
    `SEARCH documents USING INDEX ${DOCUMENTS_SOURCE_EXTERNAL_ID_INDEX} (source_id=? AND external_id=?)`,
  ]);
});

test("is registered as migration 187", () => {
  const step = MIGRATIONS.find((m) => m.version === 187);
  expect(step?.up).toBe(indexDocumentsBySourceExternalId);
});
