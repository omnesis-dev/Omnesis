// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "../types.js";

export interface SourceVersionCount {
  sourceVersion: number;
  count: number;
}

/**
 * How many documents a source holds at each source version, lowest first.
 * Version 0 is the documents stored without one.
 *
 * `streamId` narrows the count to one contributing device's stream of a
 * partitioned source; left out, every stream of the source is counted
 * together. Read from the running counts (`source_version_counts`), so it
 * costs a few rows whatever the source holds and is safe on any thread.
 */
export function countDocumentsBySourceVersion(
  db: Db,
  sourceId: string,
  streamId?: string,
): SourceVersionCount[] {
  if (streamId === undefined) {
    return db
      .prepare<[string], SourceVersionCount>(
        `SELECT source_version AS sourceVersion, SUM(document_count) AS count
           FROM source_version_counts
          WHERE source_id = ?
          GROUP BY source_version
          ORDER BY source_version`,
      )
      .all(sourceId);
  }
  return db
    .prepare<[string, string], SourceVersionCount>(
      `SELECT source_version AS sourceVersion, document_count AS count
         FROM source_version_counts
        WHERE source_id = ? AND stream_id = ?
        ORDER BY source_version`,
    )
    .all(sourceId, streamId);
}
