// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Remove orphaned `source_stats` rows — materialized per-source aggregates for
 * a source that no longer has any documents.
 *
 * `source_stats` is maintained incrementally: the backfill worker recomputes a
 * row only when its source is marked dirty, and `listDirtyStatsSourceIds`
 * unions in source ids that appear in `documents` without a stats row. Neither
 * path ever deletes a row, so when every document of a source disappears
 * through a one-time re-home or source removal, its `source_stats` row lingers
 * with a stale non-zero `doc_count`.
 *
 * That stale count inflates `totalGatewayDocs` on `/index/stats` (the sum of
 * every `source_stats.doc_count`), which manufactures a phantom indexing
 * backlog and a bogus multi-hour ETA, and leaves the retired source showing as
 * a ghost row in the status views.
 *
 * The prune is general (no source-name literals) and conservative: it deletes a
 * row only when the row claims documents (`doc_count > 0`) yet the `documents`
 * table holds none for that source. A legitimately empty source carries
 * `doc_count = 0` and is left untouched. Idempotent — a replay finds no
 * orphans.
 */

import type { Db } from "./types.js";

/** Returns the number of orphaned `source_stats` rows removed. */
export function pruneOrphanSourceStats(db: Db): number {
  return db
    .prepare(
      `DELETE FROM source_stats
        WHERE doc_count > 0
          AND source_id NOT IN (SELECT DISTINCT source_id FROM documents)`,
    )
    .run().changes;
}
