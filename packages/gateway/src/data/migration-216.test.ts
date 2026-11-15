// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import {
  DOCUMENTS_ID_TYPE_INDEX,
  indexDocumentsByIdAndType,
} from "./migration-216-documents-id-type-index.js";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.exec(`CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
  )`);
  db.prepare("INSERT INTO documents (id, content, metadata) VALUES (?, ?, ?)").run(
    "doc-1",
    "Quarterly budget review notes",
    JSON.stringify({ documentType: "email" }),
  );
  db.prepare("INSERT INTO documents (id, content) VALUES (?, ?)").run("doc-2", "Untyped");
});

afterEach(() => db.close());

test("indexes documents by id and type on an existing table, idempotently", () => {
  indexDocumentsByIdAndType(db);
  indexDocumentsByIdAndType(db);

  const columns = db
    .prepare<[string], { cid: number; name: string | null }>(
      "SELECT cid, name FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno",
    )
    .all(DOCUMENTS_ID_TYPE_INDEX);
  // The second key is an expression: SQLite reports it as column -2.
  expect(columns).toEqual([
    { cid: 0, name: "id" },
    { cid: -2, name: null },
  ]);

  const sql = `SELECT json_extract(metadata, '$.documentType') AS type
     FROM documents INDEXED BY ${DOCUMENTS_ID_TYPE_INDEX} WHERE id = ?`;
  expect(
    db
      .prepare<[string], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all("doc-1")
      .map((row) => row.detail),
  ).toEqual([`SEARCH documents USING COVERING INDEX ${DOCUMENTS_ID_TYPE_INDEX} (id=?)`]);
  expect(db.prepare<[string], { type: string | null }>(sql).get("doc-1")).toEqual({
    type: "email",
  });
  expect(db.prepare<[string], { type: string | null }>(sql).get("doc-2")).toEqual({ type: null });
});

test("is registered as migration 216", () => {
  const step = MIGRATIONS.find((m) => m.version === 216);
  expect(step?.up).toBe(indexDocumentsByIdAndType);
});
