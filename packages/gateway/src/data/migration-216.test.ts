// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 216 — the source version on every document, cursor row and
 * inventory.
 *
 * Every row an install already holds must read as 0: stored before versions
 * were, which is the one thing 0 means.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import {
  addSourceVersion,
  createDocumentFilterIndexQueue,
  createSourceVersionCounts,
} from "./migration-216-source-version.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_id TEXT NOT NULL,
      stream_id TEXT NOT NULL DEFAULT '',
      UNIQUE(provider_id, source_id, external_id, stream_id)
    );
    CREATE TABLE sync_state (
      source_id TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT '',
      cursor TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (source_id, device_id)
    );
    CREATE TABLE source_inventories (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, cursor_row TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at INTEGER
    );
    INSERT INTO documents (id, provider_id, source_id, external_id)
      VALUES ('d-1', 'fixture-notes', 'fixture-notes:studio', 'note-1');
    INSERT INTO sync_state (source_id) VALUES ('fixture-notes:studio');
    INSERT INTO source_inventories (id, source_id, cursor_row, started_at)
      VALUES ('inventory-1', 'fixture-notes:studio', '', '2027-03-01T09:00:00.000Z');
  `);
});

afterEach(() => db.close());

const columns = (table: string): string[] =>
  (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name);

const counts = (): unknown[] =>
  db
    .prepare(
      `SELECT source_id, stream_id, source_version, document_count FROM source_version_counts
        ORDER BY source_id, stream_id, source_version`,
    )
    .all();

test("is the migration at its slot", () => {
  expect(MIGRATIONS.find((m) => m.version === 216)?.up).toBe(addSourceVersion);
});

test("existing rows read as stored before versions were, and it runs twice", () => {
  addSourceVersion(db);
  addSourceVersion(db);

  expect(db.prepare("SELECT source_version FROM documents").all()).toEqual([{ source_version: 0 }]);
  expect(db.prepare("SELECT source_version FROM sync_state").all()).toEqual([
    { source_version: 0 },
  ]);
  // No page of this inventory was seen with a version, which is not the same
  // as every page of it having carried version 0.
  expect(db.prepare("SELECT min_source_version FROM source_inventories").all()).toEqual([
    { min_source_version: null },
  ]);
  expect(counts()).toEqual([
    {
      source_id: "fixture-notes:studio",
      stream_id: "",
      source_version: 0,
      document_count: 1,
    },
  ]);
  expect(columns("document_filter_index_queue")).toEqual(["document_id"]);
});

test("an install whose inventory table does not exist yet still upgrades", () => {
  db.exec("DROP TABLE source_inventories");

  addSourceVersion(db);

  expect(columns("documents")).toContain("source_version");
});

test("counts the documents already stored, per source and stream, all at version 0", () => {
  db.exec(`
    INSERT INTO documents (id, provider_id, source_id, external_id, stream_id) VALUES
      ('d-2', 'fixture-notes', 'fixture-notes:studio', 'note-2', ''),
      ('d-3', 'fixture-notes', 'fixture-notes:studio', 'note-1', 'phone'),
      ('d-4', 'fixture-tasks', 'fixture-tasks:studio', 'task-1', '');
  `);

  addSourceVersion(db);

  expect(counts()).toEqual([
    { source_id: "fixture-notes:studio", stream_id: "", source_version: 0, document_count: 2 },
    { source_id: "fixture-notes:studio", stream_id: "phone", source_version: 0, document_count: 1 },
    { source_id: "fixture-tasks:studio", stream_id: "", source_version: 0, document_count: 1 },
  ]);
});

test("counts by version when the column was there before the counts were", () => {
  db.exec("ALTER TABLE documents ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    INSERT INTO documents (id, provider_id, source_id, external_id, source_version)
      VALUES ('d-2', 'fixture-notes', 'fixture-notes:studio', 'note-2', 3);
  `);

  addSourceVersion(db);

  expect(counts()).toEqual([
    { source_id: "fixture-notes:studio", stream_id: "", source_version: 0, document_count: 1 },
    { source_id: "fixture-notes:studio", stream_id: "", source_version: 3, document_count: 1 },
  ]);
});

test("keeps counting after it ran: inserts, deletes and a raised version", () => {
  addSourceVersion(db);

  db.exec(`
    INSERT INTO documents (id, provider_id, source_id, external_id, source_version)
      VALUES ('d-2', 'fixture-notes', 'fixture-notes:studio', 'note-2', 1);
    UPDATE documents SET source_version = 1 WHERE id = 'd-1';
  `);
  expect(counts()).toEqual([
    { source_id: "fixture-notes:studio", stream_id: "", source_version: 1, document_count: 2 },
  ]);

  db.exec("DELETE FROM documents");
  expect(counts()).toEqual([]);
});

test("schema setup before the migration creates the queue and leaves the counts to it", () => {
  // Setup runs ahead of migrations on an upgrade, when the column is missing:
  // counts created then would have nothing to be kept from.
  createSourceVersionCounts(db);
  createDocumentFilterIndexQueue(db);

  expect(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'source_version_counts'").get(),
  ).toBeUndefined();
  expect(columns("document_filter_index_queue")).toEqual(["document_id"]);

  addSourceVersion(db);
  expect(counts()).toHaveLength(1);
});

test("a queued document leaves the queue when it is deleted", () => {
  addSourceVersion(db);
  db.prepare("INSERT INTO document_filter_index_queue (document_id) VALUES ('d-1')").run();

  db.prepare("DELETE FROM documents WHERE id = 'd-1'").run();

  expect(db.prepare("SELECT COUNT(*) AS n FROM document_filter_index_queue").get()).toEqual({
    n: 0,
  });
});
