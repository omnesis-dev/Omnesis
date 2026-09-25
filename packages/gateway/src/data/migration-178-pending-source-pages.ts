// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

export function addPendingSourcePages(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS pending_source_pages (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    cursor_row TEXT NOT NULL,
    prepared_by TEXT NOT NULL,
    page_id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    cursor_committed INTEGER NOT NULL DEFAULT 0 CHECK (cursor_committed IN (0, 1)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (source_id, cursor_row)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS pending_source_page_observations (
    page_id TEXT NOT NULL REFERENCES pending_source_pages(page_id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    matured_keys TEXT NOT NULL,
    PRIMARY KEY (page_id, ordinal)
  )`);
}
