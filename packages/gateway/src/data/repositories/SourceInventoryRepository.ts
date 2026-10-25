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

/** Called inside each document chunk or final cursor transaction; retries never reopen completion. */
export function recordSourceInventoryPage(
  db: Database.Database,
  sourceId: string,
  cursorRow: string,
  inventory: InitialSourceInventory,
  complete: boolean,
  now: number,
): void {
  const existing = db
    .prepare<
      [string],
      { source_id: string; cursor_row: string; started_at: string }
    >("SELECT source_id,cursor_row,started_at FROM source_inventories WHERE id=?")
    .get(inventory.id);
  if (
    existing &&
    (existing.source_id !== sourceId ||
      existing.cursor_row !== cursorRow ||
      existing.started_at !== inventory.startedAt)
  )
    throw new Error("Initial inventory identity belongs to another source enumeration");
  db.prepare(
    `INSERT INTO source_inventories(id,source_id,cursor_row,started_at,first_received_at,observed_at,completed_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET observed_at=excluded.observed_at,
      completed_at=COALESCE(source_inventories.completed_at,excluded.completed_at)`,
  ).run(inventory.id, sourceId, cursorRow, inventory.startedAt, now, now, complete ? now : null);
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
