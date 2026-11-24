// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/** Forgotten identities remain only as provenance for retained source streams. */
export function addDeviceRetirement(db: Database.Database): void {
  if (
    !db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sync_state')")
      .all()
      .some((column) => column.name === "last_error_device_id")
  ) {
    db.exec("ALTER TABLE sync_state ADD COLUMN last_error_device_id TEXT");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS forgotten_devices (
      device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      forgotten_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_device_archives (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES forgotten_devices(device_id),
      archived_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS idx_source_device_archives_device
      ON source_device_archives(device_id);
  `);
}
