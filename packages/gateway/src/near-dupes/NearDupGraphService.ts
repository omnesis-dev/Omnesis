// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { readActiveAlgoVersion } from "./meta.js";
import type { Db } from "../data/types.js";
import type { NearDupEdgeDto, NearDupEdgesResponse } from "./types.js";

/**
 * Read side — used by `GET /documents/:id/near-dupes`. Runs on the
 * gateway main thread's read-only handle (no compute / writer hop)
 * so it never queues behind background work. The
 * `idx_near_dup_edges_a` + `idx_near_dup_edges_b` composite indexes
 * make this an O(log n) lookup.
 */

export interface GetNearDupesOptions {
  limit?: number;
  /** Encoded cursor from a prior response. Null/undefined = start at the top. */
  cursor?: string | null;
}

export interface ParsedCursor {
  /** Jaccard floor for the next page (we paginate jaccard DESC then doc_id ASC). */
  jaccard: number;
  otherDocId: string;
}

export function parseCursor(raw: string | null | undefined): ParsedCursor | null {
  if (!raw) return null;
  const idx = raw.indexOf("|");
  if (idx <= 0) return null;
  const docId = raw.slice(0, idx);
  const j = Number(raw.slice(idx + 1));
  if (!Number.isFinite(j)) return null;
  return { jaccard: j, otherDocId: docId };
}

export function encodeCursor(c: ParsedCursor): string {
  return `${c.otherDocId}|${c.jaccard}`;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface EdgeRow {
  other_id: string;
  jaccard: number;
  pair_unique_df2: number;
  pair_unique_df5: number;
  containment_min: number;
  gate_family: string;
}

/**
 * Fetch up to `limit` near-dup edges for a document, joined with the
 * `documents` table for title / source_id / document type. Results
 * are sorted by `jaccard DESC, other_id ASC`.
 *
 * Pagination is cursor-based on `(jaccard, other_id)` so equal-jaccard
 * pairs sort deterministically and the cursor never duplicates rows.
 */
export function getNearDupEdges(
  db: Db,
  docId: string,
  options: GetNearDupesOptions = {},
): NearDupEdgesResponse {
  const limit = Math.min(MAX_LIMIT, Math.max(1, options.limit ?? DEFAULT_LIMIT));
  const algoVersion = readActiveAlgoVersion(db);
  if (!algoVersion) return { edges: [], nextCursor: null };

  const cursor = parseCursor(options.cursor);
  // Pull `limit + 1` to know whether there's a next page.
  const fetchN = limit + 1;

  const baseSql = `
    SELECT CASE WHEN doc_a = ? THEN doc_b ELSE doc_a END AS other_id,
           jaccard, pair_unique_df2, pair_unique_df5, containment_min, gate_family
      FROM near_dup_edges
     WHERE algo_version = ?
       AND (doc_a = ? OR doc_b = ?)
  `;
  const orderAndLimit = ` ORDER BY jaccard DESC, other_id ASC LIMIT ?`;

  let rows: EdgeRow[];
  if (cursor) {
    const sql =
      baseSql +
      ` AND (jaccard < ? OR (jaccard = ? AND
              (CASE WHEN doc_a = ? THEN doc_b ELSE doc_a END) > ?))` +
      orderAndLimit;
    rows = db
      .prepare<unknown[], EdgeRow>(sql)
      .all(
        docId,
        algoVersion,
        docId,
        docId,
        cursor.jaccard,
        cursor.jaccard,
        docId,
        cursor.otherDocId,
        fetchN,
      );
  } else {
    rows = db
      .prepare<unknown[], EdgeRow>(baseSql + orderAndLimit)
      .all(docId, algoVersion, docId, docId, fetchN);
  }

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;

  if (trimmed.length === 0) return { edges: [], nextCursor: null };

  // Resolve other-doc metadata (title / source_id / type) in one query.
  const otherIds = trimmed.map((r) => r.other_id);
  const placeholders = otherIds.map(() => "?").join(",");
  const docRows = db
    .prepare<
      unknown[],
      {
        id: string;
        title: string;
        source_id: string;
        document_type: string | null;
        source_url: string | null;
        app_url: string | null;
      }
    >(
      `SELECT id, title, source_id,
              json_extract(metadata, '$.sourceUrl') AS source_url,
              json_extract(metadata, '$.documentType') AS document_type,
              json_extract(metadata, '$.appUrl') AS app_url
         FROM documents
        WHERE id IN (${placeholders})`,
    )
    .all(...otherIds);
  const docMeta = new Map<
    string,
    {
      title: string;
      sourceId: string;
      docType: string;
      sourceUrl: string | null;
      appUrl: string | null;
    }
  >();
  for (const r of docRows) {
    docMeta.set(r.id, {
      title: r.title,
      sourceId: r.source_id,
      docType: r.document_type ?? "document",
      sourceUrl: r.source_url,
      appUrl: r.app_url,
    });
  }

  const edges: NearDupEdgeDto[] = [];
  for (const r of trimmed) {
    const meta = docMeta.get(r.other_id);
    if (!meta) continue; // doc was deleted; FK cascade will eventually clean the edge
    edges.push({
      otherDocId: r.other_id,
      otherTitle: meta.title,
      otherSourceId: meta.sourceId,
      otherDocType: meta.docType,
      otherSourceUrl: meta.sourceUrl,
      otherAppUrl: meta.appUrl,
      jaccard: r.jaccard,
      pairUniqueDf2: r.pair_unique_df2,
      pairUniqueDf5: r.pair_unique_df5,
      containmentMin: r.containment_min,
      gateFamily: r.gate_family,
    });
  }

  const last = trimmed[trimmed.length - 1];
  const nextCursor = hasMore
    ? encodeCursor({ jaccard: last.jaccard, otherDocId: last.other_id })
    : null;

  return { edges, nextCursor };
}
