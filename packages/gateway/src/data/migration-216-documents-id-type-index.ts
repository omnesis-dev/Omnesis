// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { Db } from "./types.js";

/** Name of the index that answers a document's type from its id alone. */
export const DOCUMENTS_ID_TYPE_INDEX = "idx_documents_id_document_type";

/**
 * Index documents by id together with `metadata.documentType`.
 *
 * A document's type lives inside its `metadata` JSON, and `metadata` sits
 * after `content` in the row. Reading it from the table walks every overflow
 * page of the document's content, decrypting each one on an encrypted store,
 * so asking for the types of a person's documents costs as much as reading
 * their whole text. A person with a large share of the corpus, such as the
 * owner, makes that a full read of the corpus.
 *
 * This index stores the type beside the id, so a read that names the index
 * gets the type without touching the row. SQLite does not pick an expression
 * index as covering on its own, so readers name it with `INDEXED BY`.
 *
 * The expression is already evaluated for every row by the partial indexes on
 * `documentType`, so it adds no new way for a write to fail.
 */
export function indexDocumentsByIdAndType(db: Db): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_ID_TYPE_INDEX}
       ON documents(id, json_extract(metadata, '$.documentType'))`,
  );
}
