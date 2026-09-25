// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * The access cleanup sweep collects pending credentials whose authorization
 * request is gone, oldest first. Pending rows are a sliver of the table, so
 * the index covers only them, keyed the way the sweep walks.
 *
 * A database that has not yet reached the access tables has nothing to index;
 * the sweep's query still runs correctly without it, only slower.
 */
export function indexPendingCredentials(db: Db): void {
  const tableExists = db
    .prepare<
      [string],
      { present: number }
    >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("principal_credentials");
  if (!tableExists) return;

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_principal_credentials_pending_created
      ON principal_credentials(created_at, id)
      WHERE status = 'pending'
  `);
}
