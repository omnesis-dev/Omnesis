// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

function hasTable(db: Db, table: string): boolean {
  return !!db
    .prepare<[string], { found: number }>(
      "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).some(
    (row) => row.name === column,
  );
}

/**
 * A running count of each source's documents per stream and source version.
 *
 * "How many documents does this account hold at each version" is asked every
 * time a client shows what a resync would reach, and counting it from the
 * documents costs one index entry per document of the account: tens of
 * milliseconds on a large mailbox, for a number a handful of rows can hold.
 * Triggers keep the count exact on every path that inserts, deletes or re-keys
 * a document, so no write path has to remember it and no reader has to trust
 * an estimate. A count that reaches zero removes its row.
 *
 * Needs `documents.source_version`, which schema setup may run ahead of on an
 * upgrade; it is then left to the migration that adds the column.
 */
export function createSourceVersionCounts(db: Db): void {
  if (!hasColumn(db, "documents", "source_version")) return;
  const key = (row: "OLD" | "NEW"): string =>
    `source_id = ${row}.source_id AND stream_id = ${row}.stream_id AND source_version = ${row}.source_version`;
  const add = `
    INSERT INTO source_version_counts (source_id, stream_id, source_version, document_count)
    VALUES (NEW.source_id, NEW.stream_id, NEW.source_version, 1)
    ON CONFLICT(source_id, stream_id, source_version)
      DO UPDATE SET document_count = document_count + 1;`;
  const remove = `
    UPDATE source_version_counts SET document_count = document_count - 1 WHERE ${key("OLD")};
    DELETE FROM source_version_counts WHERE ${key("OLD")} AND document_count <= 0;`;
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_version_counts (
      source_id TEXT NOT NULL,
      stream_id TEXT NOT NULL,
      source_version INTEGER NOT NULL,
      document_count INTEGER NOT NULL,
      PRIMARY KEY (source_id, stream_id, source_version)
    ) WITHOUT ROWID;
    CREATE TRIGGER IF NOT EXISTS source_version_counts_insert AFTER INSERT ON documents BEGIN${add}
    END;
    CREATE TRIGGER IF NOT EXISTS source_version_counts_delete AFTER DELETE ON documents BEGIN${remove}
    END;
    CREATE TRIGGER IF NOT EXISTS source_version_counts_move
      AFTER UPDATE OF source_id, stream_id, source_version ON documents
      WHEN OLD.source_id != NEW.source_id OR OLD.stream_id != NEW.stream_id
        OR OLD.source_version != NEW.source_version
    BEGIN${remove}${add}
    END;
  `);
}

/**
 * The queue of documents whose source version rose while everything else
 * about them stayed the same. Such a change leaves `updated_at` alone, so the
 * indexer's clock never shows it; anything that keeps its own copy of a
 * document's version learns about it from here instead.
 */
export function createDocumentFilterIndexQueue(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_filter_index_queue (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `);
}

/**
 * Migration 216 — every document records the version of the source that wrote
 * it.
 *
 * A source declares a version of its own output, starting at 1 and only ever
 * rising, and its host sends it with every sync page. `documents.source_version`
 * keeps the highest version a document was written or re-read at; 0, the value
 * of every existing row, means it was stored before versions were, or by a
 * host that sends none.
 *
 * `sync_state.source_version` is the version of the last page committed on
 * that cursor row, and `source_inventories.min_source_version` the lowest
 * version among the pages of one enumeration from an empty cursor, so "this
 * host has read the whole source at version V or later" is a property of a
 * completed inventory rather than a scan of its documents. An enumeration
 * recorded before this ran reads 0, finished or not: none of the pages it
 * already took carried a version.
 *
 * Nothing here is proportional to the document table except the first fill of
 * the per-version counts, and on an upgrade that reads one existing index: the
 * column was added a statement earlier, so every document is at version 0 and
 * the fill is a count of documents per source and stream.
 */
export function addSourceVersion(db: Db): void {
  const documentsHadVersion = hasColumn(db, "documents", "source_version");
  if (!documentsHadVersion) {
    db.exec("ALTER TABLE documents ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, "sync_state", "source_version")) {
    db.exec("ALTER TABLE sync_state ADD COLUMN source_version INTEGER NOT NULL DEFAULT 0");
  }
  if (
    hasTable(db, "source_inventories") &&
    !hasColumn(db, "source_inventories", "min_source_version")
  ) {
    db.exec(
      "ALTER TABLE source_inventories ADD COLUMN min_source_version INTEGER NOT NULL DEFAULT 0",
    );
  }
  const hadCounts = hasTable(db, "source_version_counts");
  createSourceVersionCounts(db);
  if (!hadCounts) {
    db.exec(
      documentsHadVersion
        ? `INSERT INTO source_version_counts (source_id, stream_id, source_version, document_count)
           SELECT source_id, stream_id, source_version, COUNT(*) FROM documents
            GROUP BY source_id, stream_id, source_version`
        : `INSERT INTO source_version_counts (source_id, stream_id, source_version, document_count)
           SELECT source_id, stream_id, 0, COUNT(*) FROM documents
            GROUP BY source_id, stream_id`,
    );
  }
  createDocumentFilterIndexQueue(db);
}
