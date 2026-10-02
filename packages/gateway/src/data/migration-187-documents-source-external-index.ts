// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/** Name of the index that serves `WHERE source_id = ? AND external_id = ?`. */
export const DOCUMENTS_SOURCE_EXTERNAL_ID_INDEX = "idx_documents_source_external_id";

/**
 * Index documents by `(source_id, external_id)`.
 *
 * A declared edge names its endpoints by source and external id, and every
 * endpoint is resolved inside the writer transaction that ingests the
 * declaring page. The unique key leads with `provider_id` and the other
 * `source_id` indexes stop at the source, so without this index each lookup
 * walks every document of the target source: a browser-history page that
 * declares a thousand visits toward the `web` source reads that whole source
 * a thousand times while holding the writer. With it, a lookup reads a few
 * pages whatever the size of the source.
 *
 * `stream_id` is deliberately not a key column: one external id has at most
 * one row per stream, so ordering that handful needs no index, and leaving
 * the column out lets schema setup create the index on a table that predates
 * streams.
 */
export function indexDocumentsBySourceExternalId(db: Db): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_SOURCE_EXTERNAL_ID_INDEX} ON documents(source_id, external_id)`,
  );
}
