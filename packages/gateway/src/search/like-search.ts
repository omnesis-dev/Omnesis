// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Legacy `content LIKE '%q%'` document search (GET /documents/search).
 *
 * A leading-wildcard full-table scan over `documents.content` — unindexable by
 * construction, O(corpus) per call. It predates the hybrid `/search` pipeline
 * and stays only for the handful of low-traffic callers that still hit it. The
 * pure read lives here so it can run on the read-worker pool (see
 * `io.likeSearchDocuments`) instead of freezing the main event loop.
 *
 * `hiddenSourceIds` is computed on the main thread (it reads the source
 * registry) and passed in, so this function stays a pure `db` read.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

export interface LikeSearchArgs {
  query: string;
  /** Restrict to these source ids (the `sources` query param, split). */
  sourceIds?: string[];
  /** System sources hidden from general search — always excluded. */
  hiddenSourceIds: string[];
  limit: number;
}

export interface LikeSearchRow {
  id: string;
  title: string;
  source_id: string;
  source_created_at: string;
}

export function likeSearchDocuments(db: Db, args: LikeSearchArgs): LikeSearchRow[] {
  let sql = `SELECT id, title, source_id, source_created_at
      FROM documents
      WHERE content LIKE ?`;
  const params: (string | number)[] = [`%${args.query}%`];

  // Present iff the caller passed a (truthy) `sources` param — the route splits
  // it before calling, so an array here is always non-empty (mirrors the legacy
  // `if (sourceIds)` guard byte-for-byte).
  if (args.sourceIds) {
    const placeholders = args.sourceIds.map(() => "?").join(",");
    sql += ` AND source_id IN (${placeholders})`;
    params.push(...args.sourceIds);
  }

  if (args.hiddenSourceIds.length > 0) {
    sql += ` AND source_id NOT IN (${args.hiddenSourceIds.map(() => "?").join(",")})`;
    params.push(...args.hiddenSourceIds);
  }

  sql += ` ORDER BY source_created_at DESC LIMIT ?`;
  params.push(args.limit);

  return db.prepare(sql).all(...params) as LikeSearchRow[];
}
