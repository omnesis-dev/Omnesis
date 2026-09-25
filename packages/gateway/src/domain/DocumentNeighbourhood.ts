// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A document's established position in the reference graph, read for handing
 * to a reasoning run as prior context.
 *
 * The graph already records, deterministically, how a document relates to the
 * rest of the corpus: the same file attached elsewhere, the thread it belongs
 * to, the calendar event it refers to, the documents that mention it. A run
 * that is given a bare document id has to rediscover all of that through tool
 * calls, stochastically, every time — and mostly doesn't bother.
 *
 * The read is capped per edge type and reports the true total, so a caller can
 * state what it withheld rather than silently truncating. That distinction is
 * the point: a document with 38 duplicate-content edges must cost a handful of
 * lines and an accurate count, not 38 lines.
 *
 * Only *resolved* edges are returned. An unresolved link points at something
 * outside the corpus, and its raw target is already in the document's own body,
 * so listing it would spend context restating the text the reader can see.
 */

import type Database from "better-sqlite3";

type Db = Database.Database;

/** One neighbouring document, as the graph relates it to the subject. */
export interface NeighbourEdge {
  /** Edge type as stored (`duplicate-content`, `thread`, `calendar-event`, …). */
  readonly linkType: string;
  /** Whether the subject points at the neighbour, or the neighbour at it. */
  readonly direction: "outbound" | "inbound";
  readonly docId: string;
  readonly title: string | null;
  readonly documentType: string | null;
  readonly sourceId: string;
  /** Neighbour's source timestamp (ISO), for ordering and display. */
  readonly sourceCreatedAt: string;
}

/** Edges of one type, capped, with the count that existed before capping. */
interface NeighbourGroup {
  readonly linkType: string;
  readonly edges: readonly NeighbourEdge[];
  /** Total resolved edges of this type, including those beyond the cap. */
  readonly total: number;
}

export interface DocumentNeighbourhood {
  readonly groups: readonly NeighbourGroup[];
  /** Total resolved edges across every type, including those beyond caps. */
  readonly total: number;
}

/** Default per-type cap. Enough to show the shape without flooding a prompt. */
const DEFAULT_NEIGHBOUR_CAP_PER_TYPE = 5;

/**
 * Ceiling on the link types one read will fetch neighbours for. A document
 * relates through a handful of types; this bounds the per-type queries below
 * for a pathological row, and the types dropped are the sparsest ones (the
 * selection is ordered densest-first).
 */
const MAX_LINK_TYPES = 12;

interface EdgeRow {
  link_type: string;
  doc_id: string;
  title: string | null;
  document_type: string | null;
  source_id: string;
  source_created_at: string;
}

/**
 * Newest neighbour first, then by id so the selection is stable across reads
 * of the same graph — a prompt that reshuffles between runs would make two
 * otherwise-identical runs incomparable.
 */
const ORDER = "d.source_created_at DESC, d.id ASC";

/**
 * Neighbours of ONE link type, capped.
 *
 * Scoping the limit to a single type is what keeps `shown` and `total`
 * honest together. A shared limit across all types would let one dense
 * relationship consume the whole budget, and a sparse type the run actually
 * needed would render as "0 shown" against a nonzero total — indistinguishable,
 * to the reader, from having been capped for length.
 */
function edgeQuery(direction: "outbound" | "inbound"): string {
  const [match, join] =
    direction === "outbound"
      ? ["l.source_doc_id = ?", "l.target_doc_id"]
      : ["l.target_doc_id = ?", "l.source_doc_id"];
  return `SELECT l.link_type,
                 d.id            AS doc_id,
                 d.title         AS title,
                 json_extract(d.metadata, '$.documentType') AS document_type,
                 d.source_id     AS source_id,
                 d.source_created_at AS source_created_at
            FROM document_links l
            JOIN documents d ON d.id = ${join}
           WHERE ${match} AND l.link_type = ? AND l.target_doc_id IS NOT NULL AND ${join} != ?
           ORDER BY ${ORDER}
           LIMIT ?`;
}

/** Exact per-(type, direction) totals, uncapped — what the caps are measured against. */
function edgeTotals(db: Db, docId: string, direction: "outbound" | "inbound"): Map<string, number> {
  const [match, other] =
    direction === "outbound"
      ? ["l.source_doc_id = ?", "l.target_doc_id"]
      : ["l.target_doc_id = ?", "l.source_doc_id"];
  const rows = db
    .prepare<[string, string], { link_type: string; n: number }>(
      `SELECT l.link_type, COUNT(*) AS n
         FROM document_links l
        WHERE ${match} AND l.target_doc_id IS NOT NULL AND ${other} != ?
        GROUP BY l.link_type`,
    )
    .all(docId, docId);
  return new Map(rows.map((r) => [r.link_type, r.n]));
}

/**
 * Read `docId`'s resolved graph neighbourhood, grouped by edge type and capped
 * at `capPerType` entries per type.
 *
 * Self-edges are excluded: a document that links to itself says nothing about
 * its neighbourhood, and the duplicate-content writer already skips the subject
 * — this is defence for edge types that don't.
 */
export function readDocumentNeighbourhood(
  db: Db,
  docId: string,
  opts: { capPerType?: number } = {},
): DocumentNeighbourhood {
  const cap = Math.max(0, opts.capPerType ?? DEFAULT_NEIGHBOUR_CAP_PER_TYPE);

  // Exact totals first: they decide which types are worth fetching, and they
  // are what the caps are reported against.
  const totals = new Map<string, number>();
  for (const direction of ["outbound", "inbound"] as const) {
    for (const [linkType, n] of edgeTotals(db, docId, direction)) {
      totals.set(linkType, (totals.get(linkType) ?? 0) + n);
    }
  }
  // Densest relationship first: what a document is most connected through is
  // the most likely thing a run needs to know about it.
  // Types beyond the ceiling are dropped from `groups` but stay counted in
  // `total`, so the caller's "N further edges withheld" line still accounts
  // for them even though their type is not named.
  const ranked = [...totals.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_LINK_TYPES);

  const groups: NeighbourGroup[] = [];
  for (const [linkType, total] of ranked) {
    const edges: NeighbourEdge[] = [];
    for (const direction of ["outbound", "inbound"] as const) {
      const rows = db
        .prepare<[string, string, string, number], EdgeRow>(edgeQuery(direction))
        .all(docId, linkType, docId, cap);
      for (const row of rows) {
        edges.push({
          linkType: row.link_type,
          direction,
          docId: row.doc_id,
          title: row.title,
          documentType: row.document_type,
          sourceId: row.source_id,
          sourceCreatedAt: row.source_created_at,
        });
      }
    }
    // A reciprocal pair (A→B and B→A of the same type) is one neighbour, not
    // two. Nothing in the schema forbids both rows existing, and rendering the
    // document twice would read as two separate relationships.
    const seen = new Set<string>();
    const unique = edges.filter((e) => (seen.has(e.docId) ? false : (seen.add(e.docId), true)));
    edges.length = 0;
    edges.push(...unique);
    // Both directions were capped independently; re-rank the union and cap
    // once more so the group honours `capPerType` exactly.
    edges.sort(
      (a, b) =>
        b.sourceCreatedAt.localeCompare(a.sourceCreatedAt) || a.docId.localeCompare(b.docId),
    );
    groups.push({ linkType, edges: edges.slice(0, cap), total });
  }

  return { groups, total: [...totals.values()].reduce((sum, n) => sum + n, 0) };
}
