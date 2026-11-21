// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
import type { InitialSourceInventory } from "@omnesis/source-sdk";

/** Generic ingestion provenance: initial enumeration is distinct from late live evidence. */
export function createSourceInventoryTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_inventories (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, cursor_row TEXT NOT NULL,
      started_at TEXT NOT NULL, first_received_at INTEGER NOT NULL, observed_at INTEGER NOT NULL, completed_at INTEGER,
      min_source_version INTEGER NOT NULL DEFAULT 0,
      -- When the source had read everything it holds for the account. Null
      -- while it has not, and on an enumeration recorded before this was.
      full_read_at INTEGER,
      UNIQUE(source_id,cursor_row,id)
    );
    CREATE INDEX IF NOT EXISTS source_inventories_scope ON source_inventories(source_id,cursor_row,observed_at DESC);
    CREATE TABLE IF NOT EXISTS source_inventory_documents (
      document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
      inventory_id TEXT NOT NULL REFERENCES source_inventories(id) ON DELETE CASCADE,
      input_revision TEXT NOT NULL, observed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS source_inventory_documents_inventory ON source_inventory_documents(inventory_id,document_id);
    CREATE TRIGGER IF NOT EXISTS source_inventory_live_edit AFTER UPDATE OF content_hash ON documents
      WHEN OLD.content_hash!=NEW.content_hash BEGIN
      DELETE FROM source_inventory_documents WHERE document_id=NEW.id;
    END;
  `);
  // Preserve the first gateway receipt across retries; collector clocks are not admission clocks.
  const columns = db.prepare("PRAGMA table_info(source_inventories)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "first_received_at")) {
    db.exec("ALTER TABLE source_inventories ADD COLUMN first_received_at INTEGER");
  }
  db.exec(
    "UPDATE source_inventories SET first_received_at=observed_at WHERE first_received_at IS NULL",
  );
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='removed_sources'").get())
    db.exec(`CREATE TRIGGER IF NOT EXISTS source_inventory_removed AFTER INSERT ON removed_sources
      BEGIN DELETE FROM source_inventories WHERE source_id=NEW.id; END;`);
}
export function hasSourceInventoryTables(db: Database.Database): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_inventories'")
    .get();
}

/**
 * Called inside each document chunk or final cursor transaction; retries never reopen completion.
 *
 * `sourceVersion` is the version the page was sent at. The inventory keeps the
 * lowest one among its pages, so an enumeration whose host was upgraded part
 * way through is recorded at the version it started with.
 *
 * `fullRead` says the page ends a read of everything the source holds. It
 * defaults to `complete`: the last page of an enumeration from an empty
 * cursor is the whole account, unless the source said it imports older
 * history later. `completed_at` keeps its own meaning either way.
 */
export function recordSourceInventoryPage(
  db: Database.Database,
  sourceId: string,
  cursorRow: string,
  inventory: InitialSourceInventory,
  complete: boolean,
  now: number,
  sourceVersion = 0,
  fullRead = complete,
): void {
  const existing = db
    .prepare<[string], { source_id: string; cursor_row: string; started_at: string }>(
      "SELECT source_id,cursor_row,started_at FROM source_inventories WHERE id=?",
    )
    .get(inventory.id);
  if (
    existing &&
    (existing.source_id !== sourceId ||
      existing.cursor_row !== cursorRow ||
      existing.started_at !== inventory.startedAt)
  )
    throw new Error("Initial inventory identity belongs to another source enumeration");
  db.prepare(
    `INSERT INTO source_inventories(id,source_id,cursor_row,started_at,first_received_at,observed_at,completed_at,min_source_version,full_read_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,
      completed_at=COALESCE(source_inventories.completed_at,excluded.completed_at),
      min_source_version=MIN(source_inventories.min_source_version,excluded.min_source_version),
      full_read_at=COALESCE(source_inventories.full_read_at,excluded.full_read_at)`,
  ).run(
    inventory.id,
    sourceId,
    cursorRow,
    inventory.startedAt,
    now,
    now,
    complete ? now : null,
    sourceVersion,
    complete && fullRead ? now : null,
  );
}

/**
 * Account for a cursor page that carries no enumeration identity: a page of
 * a later cycle.
 *
 * It matters only to a source that imports its history in stages. Its first
 * enumeration ended without having read everything, so the pages that follow
 * are still part of the read: each one lowers the enumeration's version to
 * its own when it is lower, and the page on which the source says it has now
 * read everything (`fullRead`) completes it. An enumeration already marked as
 * a full read is left alone, so this is one indexed row for most pages.
 */
export function recordSourcePageAfterInventory(
  db: Database.Database,
  sourceId: string,
  cursorRow: string,
  page: { sourceVersion: number; fullRead: boolean; now: number },
): void {
  db.prepare(
    `UPDATE source_inventories
        SET min_source_version = MIN(min_source_version, ?),
            full_read_at = CASE WHEN ? THEN ? ELSE NULL END
      WHERE id = (SELECT id FROM source_inventories
                   WHERE source_id = ? AND cursor_row = ?
                   ORDER BY observed_at DESC, id DESC LIMIT 1)
        AND completed_at IS NOT NULL AND full_read_at IS NULL
        AND (min_source_version > ? OR ?)`,
  ).run(
    page.sourceVersion,
    page.fullRead ? 1 : 0,
    page.now,
    sourceId,
    cursorRow,
    page.sourceVersion,
    page.fullRead ? 1 : 0,
  );
}

/** One enumeration of a source by one cursor row, as the readiness of a filter reads it. */
export interface SourceFullRead {
  cursorRow: string;
  /** The lowest source version among the pages of the read. */
  minSourceVersion: number;
  fullReadAt: number;
}

/**
 * For each cursor row of a source, the full read made at the highest
 * version: the answer to "has this host read the whole account at version V
 * or later". A cursor row with no full read is absent.
 */
export function listSourceFullReads(db: Database.Database, sourceId: string): SourceFullRead[] {
  if (!hasSourceInventoryTables(db)) return [];
  return db
    .prepare<[string], SourceFullRead>(
      `SELECT cursor_row AS cursorRow, MAX(min_source_version) AS minSourceVersion,
              MAX(full_read_at) AS fullReadAt
         FROM source_inventories
        WHERE source_id = ? AND full_read_at IS NOT NULL
        GROUP BY cursor_row`,
    )
    .all(sourceId);
}

/** An enumeration of a source that has started and not yet read everything. */
export interface SourceOpenRead {
  cursorRow: string;
  minSourceVersion: number;
}

/** The latest enumeration of each cursor row of a source, when it is not yet a full read. */
export function listSourceOpenReads(db: Database.Database, sourceId: string): SourceOpenRead[] {
  if (!hasSourceInventoryTables(db)) return [];
  return db
    .prepare<[string], SourceOpenRead & { fullReadAt: number | null }>(
      `SELECT i.cursor_row AS cursorRow, i.min_source_version AS minSourceVersion,
              i.full_read_at AS fullReadAt
         FROM source_inventories i
        WHERE i.source_id = ?
          AND i.id = (SELECT latest.id FROM source_inventories latest
                       WHERE latest.source_id = i.source_id AND latest.cursor_row = i.cursor_row
                       ORDER BY latest.observed_at DESC, latest.id DESC LIMIT 1)`,
    )
    .all(sourceId)
    .filter((row) => row.fullReadAt === null)
    .map(({ cursorRow, minSourceVersion }) => ({ cursorRow, minSourceVersion }));
}

/** Only a newly inserted document is inventory. Updating an existing document remains reactive. */
export function recordSourceInventoryDocument(
  db: Database.Database,
  input: { documentId: string; inventoryId: string; revision: string; now: number },
): void {
  db.prepare(
    `INSERT INTO source_inventory_documents(document_id,inventory_id,input_revision,observed_at)
    VALUES(?,?,?,?) ON CONFLICT(document_id) DO NOTHING`,
  ).run(input.documentId, input.inventoryId, input.revision, input.now);
}
export function getInitialSourceInventory(
  db: Database.Database,
  sourceId: string,
  cursorRow = "",
): InitialSourceInventory | undefined {
  if (!hasSourceInventoryTables(db)) return undefined;
  // A newer completed inventory supersedes an abandoned older partial import.
  const row = db
    .prepare<[string, string], InitialSourceInventory & { completedAt: number | null }>(
      `SELECT id,started_at AS startedAt,completed_at AS completedAt FROM source_inventories
      WHERE source_id=? AND cursor_row=? ORDER BY observed_at DESC,id DESC LIMIT 1`,
    )
    .get(sourceId, cursorRow);
  return row && row.completedAt === null ? { id: row.id, startedAt: row.startedAt } : undefined;
}
export function isInventoryRevision(
  db: Database.Database,
  documentId: string,
  revision: string,
): boolean {
  return (
    hasSourceInventoryTables(db) &&
    !!db
      .prepare("SELECT 1 FROM source_inventory_documents WHERE document_id=? AND input_revision=?")
      .get(documentId, revision)
  );
}
