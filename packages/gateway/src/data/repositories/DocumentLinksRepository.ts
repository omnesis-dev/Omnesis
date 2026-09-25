// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";
type Db = Database.Database;

export interface DocumentRefs {
  outbound: OutboundRef[];
  inbound: InboundRef[];
}

export interface OutboundRef {
  linkType: string;
  rawTarget: string;
  normalizedTarget: string;
  targetDocId: string | null;
  targetTitle: string | null;
  targetSourceId: string | null;
  /** `metadata.sourceUrl` of the target — the link its provider
   *  published, populated when the URL resolved to an indexed doc. It is
   *  the openable original, not the canonical `documents.source_url`
   *  used for matching. */
  targetSourceUrl: string | null;
  /** `metadata.appUrl` of the target — native deep link preferred
   *  on mobile over `targetSourceUrl` when present. */
  targetAppUrl: string | null;
}

export interface InboundRef {
  sourceDocId: string;
  sourceTitle: string;
  sourceSourceId: string;
  linkType: string;
  /** `metadata.sourceUrl` of the inbound doc — same purpose as
   *  `OutboundRef.targetSourceUrl` but from the other side of the edge. */
  sourceSourceUrl: string | null;
  /** `metadata.appUrl` of the inbound doc — native deep link preferred
   *  on mobile over `sourceSourceUrl` when present. */
  sourceAppUrl: string | null;
}

/**
 * Get all references for a document (both directions).
 */
export function getDocumentRefs(db: Db, docId: string): DocumentRefs {
  const outboundRows = db
    .prepare<
      [string],
      {
        link_type: string;
        raw_target: string;
        normalized_target: string;
        target_doc_id: string | null;
        target_title: string | null;
        target_source_id: string | null;
        target_source_url: string | null;
        target_app_url: string | null;
      }
    >(
      `SELECT dl.link_type, dl.raw_target, dl.normalized_target, dl.target_doc_id,
              d.title as target_title, d.source_id as target_source_id,
              json_extract(d.metadata, '$.sourceUrl') as target_source_url,
              json_extract(d.metadata, '$.appUrl') as target_app_url
       FROM document_links dl
       LEFT JOIN documents d ON dl.target_doc_id = d.id
       WHERE dl.source_doc_id = ?
       GROUP BY COALESCE(dl.target_doc_id, dl.id)
       ORDER BY MIN(dl.id)`,
    )
    .all(docId);

  const inboundRows = db
    .prepare<
      [string],
      {
        source_doc_id: string;
        source_title: string;
        source_source_id: string;
        source_source_url: string | null;
        source_app_url: string | null;
        link_type: string;
      }
    >(
      `SELECT dl.source_doc_id, d.title as source_title, d.source_id as source_source_id,
              json_extract(d.metadata, '$.sourceUrl') as source_source_url,
              json_extract(d.metadata, '$.appUrl') as source_app_url,
              dl.link_type
       FROM document_links dl
       JOIN documents d ON dl.source_doc_id = d.id
       WHERE dl.target_doc_id = ?
       GROUP BY dl.source_doc_id
       ORDER BY MIN(dl.id)`,
    )
    .all(docId);

  return {
    outbound: outboundRows.map((r) => ({
      linkType: r.link_type,
      rawTarget: r.raw_target,
      normalizedTarget: r.normalized_target,
      targetDocId: r.target_doc_id,
      targetTitle: r.target_title,
      targetSourceId: r.target_source_id,
      targetSourceUrl: r.target_source_url,
      targetAppUrl: r.target_app_url,
    })),
    inbound: inboundRows.map((r) => ({
      sourceDocId: r.source_doc_id,
      sourceTitle: r.source_title,
      sourceSourceId: r.source_source_id,
      sourceSourceUrl: r.source_source_url,
      sourceAppUrl: r.source_app_url,
      linkType: r.link_type,
    })),
  };
}

export function getDocumentRefsPage(
  db: Db,
  docId: string,
  direction: "inbound" | "outbound",
  options: { limit: number; afterSortId?: number },
): { items: Array<InboundRef | OutboundRef>; hasMore: boolean; lastSortId?: number } {
  const probeLimit = options.limit + 1;
  if (direction === "outbound") {
    const rows = db
      .prepare<
        [string, number, number],
        {
          sort_id: number;
          link_type: string;
          raw_target: string;
          normalized_target: string;
          target_doc_id: string | null;
          target_title: string | null;
          target_source_id: string | null;
          target_source_url: string | null;
          target_app_url: string | null;
        }
      >(
        `SELECT MIN(dl.id) AS sort_id, dl.link_type, dl.raw_target, dl.normalized_target,
                dl.target_doc_id, d.title AS target_title, d.source_id AS target_source_id,
                json_extract(d.metadata, '$.sourceUrl') AS target_source_url,
                json_extract(d.metadata, '$.appUrl') AS target_app_url
           FROM document_links dl
           LEFT JOIN documents d ON dl.target_doc_id = d.id
          WHERE dl.source_doc_id = ?
          GROUP BY COALESCE(dl.target_doc_id, dl.id)
         HAVING MIN(dl.id) > ?
          ORDER BY sort_id ASC
          LIMIT ?`,
      )
      .all(docId, options.afterSortId ?? 0, probeLimit);
    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    return {
      items: page.map((r) => ({
        linkType: r.link_type,
        rawTarget: r.raw_target,
        normalizedTarget: r.normalized_target,
        targetDocId: r.target_doc_id,
        targetTitle: r.target_title,
        targetSourceId: r.target_source_id,
        targetSourceUrl: r.target_source_url,
        targetAppUrl: r.target_app_url,
      })),
      hasMore,
      ...(page.at(-1) ? { lastSortId: page.at(-1)!.sort_id } : {}),
    };
  }

  const rows = db
    .prepare<
      [string, number, number],
      {
        sort_id: number;
        source_doc_id: string;
        source_title: string;
        source_source_id: string;
        source_source_url: string | null;
        source_app_url: string | null;
        link_type: string;
      }
    >(
      `SELECT MIN(dl.id) AS sort_id, dl.source_doc_id, d.title AS source_title,
              d.source_id AS source_source_id,
              json_extract(d.metadata, '$.sourceUrl') AS source_source_url,
              json_extract(d.metadata, '$.appUrl') AS source_app_url, dl.link_type
         FROM document_links dl
         JOIN documents d ON dl.source_doc_id = d.id
        WHERE dl.target_doc_id = ?
        GROUP BY dl.source_doc_id
       HAVING MIN(dl.id) > ?
        ORDER BY sort_id ASC
        LIMIT ?`,
    )
    .all(docId, options.afterSortId ?? 0, probeLimit);
  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  return {
    items: page.map((r) => ({
      sourceDocId: r.source_doc_id,
      sourceTitle: r.source_title,
      sourceSourceId: r.source_source_id,
      sourceSourceUrl: r.source_source_url,
      sourceAppUrl: r.source_app_url,
      linkType: r.link_type,
    })),
    hasMore,
    ...(page.at(-1) ? { lastSortId: page.at(-1)!.sort_id } : {}),
  };
}

/** One provenance-annotated edge incident to a document — `omnesis edges show`. */
export interface DocumentEdge {
  direction: "outbound" | "inbound";
  linkType: string;
  /** The other endpoint's document id (null only for an unresolved outbound link). */
  otherDocId: string | null;
  otherTitle: string | null;
  otherSourceId: string | null;
  resolved: boolean;
  provenanceKind: string | null;
  provenanceOrigin: string | null;
  provenanceVersion: string | null;
  declaredAt: string | null;
  metadataJson: string | null;
}

/** A source-declared forward-reference edge still awaiting its target. */
export interface PendingEdgeView {
  linkType: string;
  targetSourceId: string;
  targetExternalId: string;
  provenanceOrigin: string;
  declaredAt: string;
  attemptCount: number;
}

export interface DocumentEdgesView {
  edges: DocumentEdge[];
  pending: PendingEdgeView[];
}

/**
 * Every edge incident to a document, annotated with provenance, plus the
 * source-declared forward references still parked in `pending_edges`. Backs the
 * `omnesis edges show <doc-id>` inspection command.
 */
export function getDocumentEdges(db: Db, docId: string): DocumentEdgesView {
  const outbound = db
    .prepare<
      [string],
      {
        link_type: string;
        target_doc_id: string | null;
        target_title: string | null;
        target_source_id: string | null;
        provenance_kind: string | null;
        provenance_origin: string | null;
        provenance_version: string | null;
        declared_at: string | null;
        metadata_json: string | null;
      }
    >(
      `SELECT dl.link_type, dl.target_doc_id, d.title AS target_title, d.source_id AS target_source_id,
              dl.provenance_kind, dl.provenance_origin, dl.provenance_version, dl.declared_at, dl.metadata_json
         FROM document_links dl
         LEFT JOIN documents d ON dl.target_doc_id = d.id
        WHERE dl.source_doc_id = ?
        ORDER BY dl.id`,
    )
    .all(docId);

  const inbound = db
    .prepare<
      [string],
      {
        link_type: string;
        source_doc_id: string;
        source_title: string;
        source_source_id: string;
        provenance_kind: string | null;
        provenance_origin: string | null;
        provenance_version: string | null;
        declared_at: string | null;
        metadata_json: string | null;
      }
    >(
      `SELECT dl.link_type, dl.source_doc_id, d.title AS source_title, d.source_id AS source_source_id,
              dl.provenance_kind, dl.provenance_origin, dl.provenance_version, dl.declared_at, dl.metadata_json
         FROM document_links dl
         JOIN documents d ON dl.source_doc_id = d.id
        WHERE dl.target_doc_id = ?
        ORDER BY dl.id`,
    )
    .all(docId);

  const pending = db
    .prepare<
      [string],
      {
        link_type: string;
        target_source_id: string;
        target_external_id: string;
        provenance_origin: string;
        declared_at: string;
        attempt_count: number;
      }
    >(
      `SELECT link_type, target_source_id, target_external_id, provenance_origin, declared_at, attempt_count
         FROM pending_edges WHERE source_doc_id = ? ORDER BY id`,
    )
    .all(docId);

  return {
    edges: [
      ...outbound.map(
        (r): DocumentEdge => ({
          direction: "outbound",
          linkType: r.link_type,
          otherDocId: r.target_doc_id,
          otherTitle: r.target_title,
          otherSourceId: r.target_source_id,
          resolved: r.target_doc_id !== null,
          provenanceKind: r.provenance_kind,
          provenanceOrigin: r.provenance_origin,
          provenanceVersion: r.provenance_version,
          declaredAt: r.declared_at,
          metadataJson: r.metadata_json,
        }),
      ),
      ...inbound.map(
        (r): DocumentEdge => ({
          direction: "inbound",
          linkType: r.link_type,
          otherDocId: r.source_doc_id,
          otherTitle: r.source_title,
          otherSourceId: r.source_source_id,
          resolved: true,
          provenanceKind: r.provenance_kind,
          provenanceOrigin: r.provenance_origin,
          provenanceVersion: r.provenance_version,
          declaredAt: r.declared_at,
          metadataJson: r.metadata_json,
        }),
      ),
    ],
    pending: pending.map((r) => ({
      linkType: r.link_type,
      targetSourceId: r.target_source_id,
      targetExternalId: r.target_external_id,
      provenanceOrigin: r.provenance_origin,
      declaredAt: r.declared_at,
      attemptCount: r.attempt_count,
    })),
  };
}

/**
 * Get inbound ref counts for a batch of document IDs.
 */
export function getInboundRefCounts(db: Db, docIds: string[]): Map<string, number> {
  const result = new Map<string, number>();
  if (docIds.length === 0) return result;

  const placeholders = docIds.map(() => "?").join(", ");
  const rows = db
    .prepare<string[], { target_doc_id: string; count: number }>(
      `SELECT target_doc_id, COUNT(*) as count
       FROM document_links
       WHERE target_doc_id IN (${placeholders})
       GROUP BY target_doc_id`,
    )
    .all(...docIds);

  for (const row of rows) {
    result.set(row.target_doc_id, row.count);
  }

  return result;
}
