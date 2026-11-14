// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

type Db = Database.Database;

/** The openable links and file type a search result shows, from its document's metadata. */
export interface SearchResultLinks {
  id: string;
  source_url: string | null;
  app_url: string | null;
  mime_type: string | null;
}

/**
 * Where a search reads its results' links. The gateway passes its read
 * worker: `metadata` sits after `content` in a document's row, so reading it
 * walks every overflow page of the document's text, and a few long documents
 * among the results hold the thread for a second or more.
 */
export interface SearchResultLinkReads {
  searchResultLinks(documentIds: readonly string[]): Promise<SearchResultLinks[]>;
}

/**
 * The links (`sourceUrl`, `appUrl`) and `mimeType` of the given documents, in
 * one query. The denormalized `chunks` table carries no `appUrl`, and its
 * `source_url` can hold the canonical form used for link matching (lowercased
 * deep links, Gmail's `#message/` key), which is not a link a client can open.
 * A document without a row is left out.
 */
export function readSearchResultLinks(db: Db, documentIds: readonly string[]): SearchResultLinks[] {
  if (documentIds.length === 0) return [];
  const placeholders = documentIds.map(() => "?").join(",");
  return db
    .prepare<string[], SearchResultLinks>(
      `SELECT id,
              json_extract(metadata, '$.sourceUrl') AS source_url,
              json_extract(metadata, '$.appUrl') AS app_url,
              json_extract(metadata, '$.extra.mimeType') AS mime_type
       FROM documents WHERE id IN (${placeholders})`,
    )
    .all(...documentIds);
}
