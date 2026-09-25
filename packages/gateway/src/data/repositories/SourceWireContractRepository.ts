// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { beginSyncAttempt, listCursorRows } from "./SyncStateRepository.js";
import type Database from "better-sqlite3";

export function sourceWireFloor(db: Database.Database, sourceId: string): number {
  return (
    db
      .prepare<
        [string],
        { minimum_version: number }
      >("SELECT minimum_version FROM source_wire_contracts WHERE source_id = ?")
      .get(sourceId)?.minimum_version ?? 0
  );
}

/** Pin adoption and fence every existing attempt without changing its bookmark. */
export function promoteSourceWireContract(
  db: Database.Database,
  sourceId: string,
  version: number,
): void {
  db.transaction(() => {
    if (sourceWireFloor(db, sourceId) >= version) return;
    db.prepare(
      `INSERT INTO source_wire_contracts (source_id, minimum_version) VALUES (?, ?)
      ON CONFLICT(source_id) DO UPDATE SET minimum_version = excluded.minimum_version`,
    ).run(sourceId, version);
    for (const row of listCursorRows(db, sourceId)) beginSyncAttempt(db, sourceId, row);
  })();
}
