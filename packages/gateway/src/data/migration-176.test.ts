// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 176 — a document records which of its source's partitions it came
 * from.
 *
 * There is nothing to carry forward: before this column no source named a
 * partition, so every existing row belongs to the unnamed one. What the
 * migration has to get right is that the default is a value rather than NULL —
 * the unnamed partition is a real partition, claimable by name, and a
 * three-valued column would make every read ask a question the design does not
 * have an answer for.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { addDocumentPartitionKey } from "./migration-176-document-partition-key.js";

describe("a document's partition", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-mig176-"));
    db = new Database(join(dir, "test.db"));
    db.exec(`
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, source_id TEXT NOT NULL,
        external_id TEXT NOT NULL, stream_id TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO documents (id, provider_id, source_id, external_id)
        VALUES ('d1', 'apple', 'apple-notes', 'note-1');
    `);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("every existing row lands in the unnamed partition, not in NULL", () => {
    addDocumentPartitionKey(db);
    const row = db
      .prepare<[], { partition_key: string | null }>("SELECT partition_key FROM documents")
      .get()!;
    expect(row.partition_key).toBe("");
  });

  test("is idempotent over an install that already has the column", () => {
    addDocumentPartitionKey(db);
    db.prepare("UPDATE documents SET partition_key = 'books/home'").run();
    expect(() => addDocumentPartitionKey(db)).not.toThrow();
    expect(
      db.prepare<[], { partition_key: string }>("SELECT partition_key FROM documents").get()!
        .partition_key,
    ).toBe("books/home");
  });

  test("creates the index the partition-scoped absence scan names", () => {
    addDocumentPartitionKey(db);
    const names = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => r.name);
    expect(names).toContain("idx_documents_provider_source_stream_partition");
  });

  test("is registered in the chain, at its own version", () => {
    const entry = MIGRATIONS.find((m) => m.version === 176);
    expect(entry?.up).toBe(addDocumentPartitionKey);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(176);
  });
});
