// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/** Name of the index that orders a source's documents by date with their revision. */
export const DOCUMENTS_SOURCE_CREATED_REVISION_INDEX = "idx_documents_source_created_revision";

/** The narrower index this one replaces; a prefix of its key. */
const SUPERSEDED_INDEX = "idx_documents_source_id_created_at";

/**
 * Index documents by `(source_id, source_created_at, id, content_hash)`.
 *
 * On a document row `content_hash` is stored after `content`, so reading it
 * from the row walks — and on an encrypted store decrypts — the content's
 * overflow pages. A read that walks one source's documents in date order and
 * filters each by its revision (the knowledge discovery backlog) paid that walk
 * for every document it passed over, matching or not: about 80 µs a document
 * cold, over a second for a mostly covered mailbox. With the revision in the
 * index the filter reads index pages only, and SQLite defers the row lookup to
 * the rows it returns.
 *
 * It replaces `(source_id, source_created_at)`, whose key is its prefix, so a
 * date-ordered read of one source seeks it exactly as before and the table
 * keeps one index for that order. A document insert maintains it as it did the
 * narrower one; an update maintains it because the upsert assigns
 * `content_hash`.
 */
export function indexDocumentsBySourceCreatedRevision(db: Db): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_SOURCE_CREATED_REVISION_INDEX}
       ON documents(source_id, source_created_at, id, content_hash)`,
  );
  db.exec(`DROP INDEX IF EXISTS ${SUPERSEDED_INDEX}`);
}
