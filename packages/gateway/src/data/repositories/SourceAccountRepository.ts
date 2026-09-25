// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AccountDescriptor } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";

/**
 * Refresh descriptive identity only; never rename, create, or re-home a source.
 *
 * The stamp is epoch milliseconds, the clock every other writer of this row
 * keeps and the number `/admin/sources` hands its clients, which decode it as
 * a 64-bit integer. SQLite stores what a binding holds rather than what the
 * column declares, so a text timestamp would not fail here: it would leave a
 * row no client can decode and no numeric comparison can order.
 */
export function setSourceAccount(
  db: Database.Database,
  sourceId: string,
  account: AccountDescriptor,
): void {
  const serialized = JSON.stringify(account);
  db.prepare(
    `UPDATE sources SET account = ?, updated_at = ?
     WHERE id = ? AND account_id = ? AND account IS NOT ?
       AND NOT EXISTS (SELECT 1 FROM removed_sources WHERE id = ?)`,
  ).run(serialized, Date.now(), sourceId, account.id, serialized, sourceId);
}
