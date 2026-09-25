// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { pendingSourcePageCodec } from "../json-columns.js";
import { getWipeEpoch } from "./SyncStateRepository.js";
import type { Db } from "../types.js";

export interface PendingSourcePage {
  id: string;
  payload: Record<string, unknown>;
  cursorCommitted: boolean;
}
export interface PreparePendingSourcePage {
  sourceId: string;
  cursorRow: string;
  deviceId: string;
  writeEpoch: number;
  id: string;
  payload: Record<string, unknown>;
}

export function getPendingSourcePage(
  db: Db,
  sourceId: string,
  cursorRow: string,
): PendingSourcePage | null {
  const row = db
    .prepare<
      [string, string],
      {
        page_id: string;
        payload_json: string;
        cursor_committed: number;
      }
    >(
      "SELECT page_id, payload_json, cursor_committed FROM pending_source_pages WHERE source_id = ? AND cursor_row = ?",
    )
    .get(sourceId, cursorRow);
  return row
    ? {
        id: row.page_id,
        payload: pendingSourcePageCodec.parse(row.payload_json),
        cursorCommitted: row.cursor_committed === 1,
      }
    : null;
}

/** A restarted attempt adopts the exact page; it never replaces partial work. */
export function preparePendingSourcePage(
  db: Db,
  args: PreparePendingSourcePage,
): PendingSourcePage | null {
  return db.transaction(() => {
    if (getWipeEpoch(db, args.sourceId, args.cursorRow) !== args.writeEpoch) return null;
    db.prepare(
      `INSERT OR IGNORE INTO pending_source_pages
      (source_id, cursor_row, prepared_by, page_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      args.sourceId,
      args.cursorRow,
      args.deviceId,
      args.id,
      pendingSourcePageCodec.serialize(args.payload),
      Date.now(),
    );
    return getPendingSourcePage(db, args.sourceId, args.cursorRow);
  })();
}

export function acknowledgePendingSourcePage(
  db: Db,
  args: Omit<PreparePendingSourcePage, "payload">,
): boolean {
  return db.transaction(() => {
    if (getWipeEpoch(db, args.sourceId, args.cursorRow) !== args.writeEpoch) return false;
    return (
      db
        .prepare(
          `DELETE FROM pending_source_pages WHERE source_id = ? AND cursor_row = ?
      AND page_id = ? AND cursor_committed = 1`,
        )
        .run(args.sourceId, args.cursorRow, args.id).changes > 0
    );
  })();
}

/** Used by explicit resets, never by claiming a new attempt after a failure. */
export function clearPendingSourcePages(db: Db, sourceId: string, cursorRow?: string): void {
  if (cursorRow === undefined)
    db.prepare("DELETE FROM pending_source_pages WHERE source_id = ?").run(sourceId);
  else
    db.prepare("DELETE FROM pending_source_pages WHERE source_id = ? AND cursor_row = ?").run(
      sourceId,
      cursorRow,
    );
}
