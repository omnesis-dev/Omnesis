// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Document-id restriction for index-DB candidate queries.
 *
 * The search pipeline restricts BM25 and recency-browse candidates to a
 * resolved `document_id` set (a `from:`/`with:` person filter, or a
 * `source:` browse). That set is unbounded: a filter on a very high-volume
 * person or source can resolve to tens of thousands of documents.
 *
 * SQLite caps bound parameters at SQLITE_MAX_VARIABLE_NUMBER (32766 in the
 * better-sqlite3 build). An inline `document_id IN (?, ?, …)` list whose
 * length exceeds that cap throws "too many SQL variables" and 500s the
 * search. This helper keeps the inline list for the common small
 * case and stages large sets into a per-connection TEMP table instead,
 * binding zero variables for the id set.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;

/**
 * Above this many ids, restrict via a TEMP table + subquery instead of an
 * inline `IN (?, ?, …)` list. Sits well under SQLite's 32766-variable cap
 * so the query's other bound params (MATCH text, metadata filters, LIMIT)
 * always fit alongside an inline list at or below the threshold.
 */
export const INLINE_DOCID_LIMIT = 10000;

export interface DocIdRestriction {
  /** SQL fragment to splice into the WHERE clause: a leading ` AND …`, or `""`. */
  clause: string;
  /** Bound params the clause contributes — empty for the temp-table path. */
  params: readonly string[];
}

/**
 * Build a `<column> IN (…)` restriction for a possibly-large document-id set
 * and run `body` with it, without overflowing SQLite's bound-variable limit.
 *
 * - `documentIds === undefined` → no restriction (empty clause).
 * - An *empty* set → a `1=0` clause that matches nothing (the allowed set is
 *   zero documents). Callers typically short-circuit this case for speed, but
 *   defending here keeps the contract safe — an inline `IN ()` is invalid SQL.
 * - A set at or below {@link INLINE_DOCID_LIMIT} is inlined as `IN (?, …)`,
 *   preserving the query plan the common case has always used.
 * - A larger set is staged into a per-connection TEMP table and matched via
 *   `IN (SELECT id FROM …)`, which binds no variables for the ids.
 *
 * `column` is spliced into SQL unescaped: it MUST be a trusted, code-supplied
 * column identifier (e.g. `"c.document_id"`), never derived from user input.
 *
 * `body` MUST run synchronously and finish using the restriction before it
 * returns: the temp table is dropped in a `finally`. better-sqlite3 is
 * synchronous, so no other query can interleave and observe the temp table.
 */
export function withDocIdRestriction<T>(
  db: Db,
  column: string,
  documentIds: readonly string[] | undefined,
  body: (restriction: DocIdRestriction) => T,
): T {
  if (documentIds !== undefined && documentIds.length === 0) {
    return body({ clause: " AND 1=0", params: [] });
  }
  if (documentIds === undefined || documentIds.length <= INLINE_DOCID_LIMIT) {
    const clause = documentIds ? ` AND ${column} IN (${documentIds.map(() => "?").join(",")})` : "";
    return body({ clause, params: documentIds ?? [] });
  }

  db.exec("CREATE TEMP TABLE IF NOT EXISTS docid_filter (id TEXT PRIMARY KEY)");
  db.exec("DELETE FROM docid_filter");
  const insert = db.prepare<[string]>("INSERT OR IGNORE INTO docid_filter (id) VALUES (?)");
  const insertAll = db.transaction((ids: readonly string[]) => {
    for (const id of ids) insert.run(id);
  });
  insertAll(documentIds);
  try {
    return body({ clause: ` AND ${column} IN (SELECT id FROM docid_filter)`, params: [] });
  } finally {
    db.exec("DROP TABLE IF EXISTS docid_filter");
  }
}
