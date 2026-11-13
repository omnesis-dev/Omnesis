// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * Migration 219 — an enumeration records when its source had read everything.
 *
 * `source_inventories.completed_at` is set by the last page of the cycle that
 * started from an empty cursor. For a source that imports its history in
 * stages that page is not the end of the account: older history arrives in
 * later cycles. `full_read_at` is set when the source has read everything it
 * holds, which is the same page for most sources and a later one for those.
 *
 * Existing rows keep NULL: nothing recorded before says whether the
 * enumeration was the whole account, and the one reader of the column asks
 * for a full read at a source version no earlier enumeration was made at.
 */
export function addInventoryFullRead(db: Db): void {
  const columns = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('source_inventories')")
    .all();
  if (columns.length === 0 || columns.some((column) => column.name === "full_read_at")) return;
  db.exec("ALTER TABLE source_inventories ADD COLUMN full_read_at INTEGER");
}
