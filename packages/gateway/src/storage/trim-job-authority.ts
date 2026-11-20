// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/** Writer admission shares the same source incarnation and active-job boundary as deletion. */
export function readActiveStorageTrimCutoff(
  db: Database.Database,
  sourceId: string,
): string | null {
  return (
    db
      .prepare<[string], { before_date: string | null }>(
        `SELECT MAX(j.before_date) AS before_date FROM storage_trim_jobs j
       JOIN storage_source_incarnations i ON i.source_id = j.source_id AND i.incarnation = j.source_incarnation
       JOIN sources s ON s.id = j.source_id
      WHERE j.source_id = ? AND j.kind = 'manual' AND j.state IN ('queued', 'running')`,
      )
      .get(sourceId)?.before_date ?? null
  );
}
