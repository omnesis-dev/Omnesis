// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/**
 * Migration 176 — a document records which of its source's partitions it came
 * from.
 *
 * A snapshot is all-or-nothing today: a source that could not read one of its
 * address books withholds the whole enumeration, so deletions in the books it
 * *did* read go undetected for as long as the broken one stays broken. A
 * per-partition claim fixes that, but only if the gateway can tell which of
 * its documents are in the claimed partition — which is what this column is
 * for.
 *
 * `''` for every existing row, and for every source with one backing store,
 * which is almost all of them. That is the right default rather than NULL: an
 * unnamed partition is a real partition that a plain `presentExternalIds`
 * snapshot claims in full, so the two forms meet in one code path instead of
 * needing a three-valued check at every read.
 *
 * Not part of the unique key. A note moved between notebooks is the same note,
 * so the next upsert simply overwrites the key — and a document that moves out
 * of a claimed partition into a gapped one stops being swept rather than being
 * deleted for having left.
 */
export function addDocumentPartitionKey(db: Db): void {
  const hasColumn = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('documents')")
    .all()
    .some((row) => row.name === "partition_key");
  if (!hasColumn) {
    db.exec(`ALTER TABLE documents ADD COLUMN partition_key TEXT NOT NULL DEFAULT ''`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_documents_provider_source_stream_partition
      ON documents(provider_id, source_id, stream_id, partition_key, id)
  `);
}
