// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Omnesis graph schema — the single, authoritative vocabulary for
 * what a *vertex* and an *edge* are in the cross-document graph the
 * gateway maintains, and how every materialised walk of that graph is
 * shaped.
 *
 * Before this module the vocabulary was scattered. The `document_links`
 * edge kinds lived in `link-extractor.ts`; the person-mention edge kinds
 * were the `PersonRole` union in `@omnesis/types`; the near-duplicate
 * edge was a bare `"near-duplicate"` string literal repeated in the
 * gateway; and the agent-citation kind (`"cited"`) was a lone constant
 * that wasn't even a member of the `LinkType` union it belonged to.
 * Nothing named the set as a whole, and nothing classified an edge's
 * direction, storage, or provenance in one place.
 *
 * This module is that one place. It is pure data + pure functions — no
 * database, no I/O — so every layer (the walker that produces a graph,
 * the routes and agent tools that consume it) speaks the same types.
 *
 * Scope note: this describes the graph *as it exists today*. The two
 * vertex kinds are the two the walker materialises (`document`,
 * `person`); the edge set is exactly what current writers persist. New
 * vertex / edge kinds discussed in the knowledge-graph-v2 series
 * (content identities, near-duplicate clusters, annotations) are
 * deliberately absent — they are added here when the behaviour that
 * produces them lands, not before.
 */

import { PERSON_ROLES, type PersonRole } from "./document.js";
import type { LinkType } from "./link-extractor.js";
import type { ColumnType } from "./structured-source.js";
import type { TrailRecord } from "./agent-protocol.js";

// ─── Vertices ───────────────────────────────────────────────────────────────

/**
 * The kinds of vertex the graph contains. A `document` vertex is a row in
 * `documents`; a `person` vertex is a *canonical* row in `people` (merge
 * losers are dereferenced through `merged_into` before they ever appear as a
 * vertex); an `analytics-row` vertex is a row in a DuckDB analytics table,
 * identified by `(tableName, primaryKey)` and reached via the synthesized
 * `same-entity` edge from its co-described document.
 */
export type GraphVertexKind = "document" | "person" | "analytics-row";

/**
 * A vertex in a materialised graph walk. The `kind` discriminates which
 * group of optional fields is populated: document vertices carry the
 * presentation fields a timeline / graph renderer needs; person vertices
 * carry the canonical identity. The walker is the producer; routes, the
 * agent trace_connections tool, and the portal are consumers.
 */
export interface GraphVertex {
  /**
   * Stable id: `doc:<documentId>`, `person:<canonicalPersonId>`, or
   * `row:<tableName>:<primaryKey>` (see `analyticsRowKey`). The primary-key
   * component is percent-encoded so composite-key separators can't collide
   * with the `:` delimiter.
   */
  id: string;
  kind: GraphVertexKind;
  /** BFS distance from the seed. The seed has depth 0. */
  depth: number;

  // Document-only fields (present iff kind === "document").
  documentId?: string;
  title?: string;
  sourceId?: string;
  /** External URL for the document, when the source published one. */
  sourceUrl?: string;
  /** Native-app deep link preferred on mobile clients. */
  appUrl?: string;
  /**
   * ISO timestamp of when the document came into being on its source
   * (e.g. when the email was sent, when the file was created, when the
   * event was scheduled). Used by the portal timeline view to order
   * events; source-agnostic — every source supplies it.
   */
  sourceCreatedAt?: string;
  /**
   * Generic document type from `metadata.documentType` — "email",
   * "file", "attachment", "event", "message", etc. The closed set is
   * `KNOWN_DOCUMENT_TYPES`.
   */
  documentType?: string;
  /**
   * MIME type as recorded by the source at ingest time. Primary input to
   * file-type iconography; absent for sources that don't publish one.
   */
  mimeType?: string;

  // Person-only fields (present iff kind === "person").
  personId?: string;
  canonicalName?: string;
  isSelf?: boolean;

  // Analytics-row-only fields (present iff kind === "analytics-row").
  /** DuckDB table the row lives in. */
  tableName?: string;
  /** Human-readable table name from the analytics catalog, when known. */
  tableDisplayName?: string;
  /**
   * The row's primary-key value(s) joined by `:` in `primaryKey` column order
   * — the addressing half of the `(tableName, primaryKey)` identity. A single
   * stable string so it round-trips through the vertex id.
   */
  rowPrimaryKey?: string;
  /**
   * The row's primary-key columns as structured `(name, value)` pairs in
   * primary-key order — the *addressable* form of `rowPrimaryKey` (which is
   * the `:`-joined display/identity form). A consumer that needs to fetch the
   * exact row — the portal "open in SQL" deep link off a `same-entity` edge —
   * builds its `WHERE` clause from this. Values are strings (sourced from the
   * document's `externalId`); `castType` is the column's declared DuckDB type,
   * so the consumer knows whether to quote the literal.
   */
  rowPrimaryKeyColumns?: { name: string; value: string; castType?: ColumnType }[];
  /** Source id that owns the row (the analytics catalog `source_id`). */
  rowSourceId?: string;
  /**
   * A bounded projection of the row's columns for display — never the full
   * row (analytics rows can be wide). Which columns appear is the walker's
   * choice (a headline subset); absent when the row hasn't been hydrated.
   */
  row?: Record<string, unknown>;
  /**
   * The fully-derived, client-ready record citation for this row,
   * computed gateway-side from the table's declared record-display contract
   * (title / key fields / semantic time / redacted snapshot / bound document).
   * Set only for an `analytics-row` vertex the trail walk resolved as a
   * point-in-time record; absent for a timeless row or any non-`trace_connections`
   * walk (the spatial graph routes don't need it). The timeline builder reads
   * this to surface the row as a `TrailEvent.record` and to place it by its
   * semantic time.
   */
  record?: TrailRecord;
}

/**
 * Build the stable vertex id for an analytics row. The primary-key value is
 * percent-encoded so a composite key's `:` separators (or any other
 * character) can't collide with the `row:<table>:` delimiter or with the
 * `(from, to, type)` de-dup key the walker forms over edges.
 */
export function analyticsRowKey(tableName: string, primaryKey: string): string {
  return `row:${tableName}:${encodeURIComponent(primaryKey)}`;
}

/**
 * A stable, platform-neutral reference to a single analytics row — the
 * identity half of a record citation. It names the row's `table` and
 * the typed primary-key columns that address it, plus the `recordKey`
 * (`analyticsRowKey(table, pkValues.join(":"))`) that consumers use as a
 * dedup id. Producers (the `run_sql` row identity, the `trace_connections` bound
 * row) and consumers (the `cite_record` tool, the clients) speak this one
 * shape.
 *
 * `primaryKeyColumns` mirrors `GraphVertex.rowPrimaryKeyColumns` (the
 * `same-entity` bound-row identity), so both surfaces round-trip through the
 * same `analyticsRowKey`.
 */
export interface RecordReference {
  /** DuckDB table the row lives in. */
  table: string;
  /**
   * `analyticsRowKey(table, primaryKeyColumns.map(c => c.value).join(":"))` —
   * the stable id used to dedup a record across surfaces.
   */
  recordKey: string;
  /**
   * The row's primary-key columns as `(name, value)` pairs in declared
   * primary-key order. `castType` is the column's declared DuckDB type, so a
   * consumer rebuilding the row's `WHERE` clause knows whether to quote the
   * literal.
   */
  primaryKeyColumns: { name: string; value: string; castType?: ColumnType }[];
}

/**
 * Build a {@link RecordReference} from a table and its ordered primary-key
 * columns. Centralises the `pkValues.join(":")` → `analyticsRowKey` derivation
 * so every producer mints an identical `recordKey` for the same row.
 */
export function recordReference(
  table: string,
  primaryKeyColumns: { name: string; value: string; castType?: ColumnType }[],
): RecordReference {
  const pkString = primaryKeyColumns.map((c) => c.value).join(":");
  return { table, recordKey: analyticsRowKey(table, pkString), primaryKeyColumns };
}

/**
 * Parse an `analyticsRowKey` back into its `(table, primaryKey)` parts —
 * the inverse of {@link analyticsRowKey}. The primary-key value is
 * percent-decoded. Returns `null` for any string that is not a well-formed
 * `row:<table>:<encodedPk>` key. Lets a consumer verify a `recordKey`
 * round-trips to the same `(table, pk)` the producer addressed.
 */
export function parseAnalyticsRowKey(
  recordKey: string,
): { table: string; primaryKey: string } | null {
  if (!recordKey.startsWith("row:")) return null;
  const rest = recordKey.slice("row:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const table = rest.slice(0, sep);
  const encodedPk = rest.slice(sep + 1);
  try {
    return { table, primaryKey: decodeURIComponent(encodedPk) };
  } catch {
    return null;
  }
}

// ─── Edges ────────────────────────────────────────────────────────────────────

/**
 * The near-duplicate edge type. Lives in its own table (`near_dup_edges`)
 * rather than `document_links`, so it is a standalone constant rather
 * than a `LinkType` member.
 */
export const NEAR_DUPLICATE_EDGE_TYPE = "near-duplicate";
export type NearDuplicateEdgeType = typeof NEAR_DUPLICATE_EDGE_TYPE;

/**
 * The `same-entity` edge type — a document and the DuckDB analytics row that
 * co-describe the same logical thing (a Strava activity doc ↔ its
 * `strava_activities` row). Deliberately NOT a `document_links.link_type`:
 * for the 1:1 `boundDocument` case it is SYNTHESIZED at walk time from the
 * source's binding (zero persisted rows, storage `"synthesized"`), so it
 * cannot live in a table whose endpoints are FK-bound to `documents(id)`.
 * Modeled as a standalone constant like `NEAR_DUPLICATE_EDGE_TYPE`.
 *
 * Provenance is `source-declared` for the boundDocument case (the source
 * asserts the binding). The same type also covers future cross-source row↔doc
 * / row↔row matches (an Apple Health workout ↔ a Strava activity) which are
 * `cross-source-derived` and persisted — so provenance is NOT determined by
 * type alone; a per-edge provenance takes precedence when present.
 */
export const SAME_ENTITY_EDGE_TYPE = "same-entity";
export type SameEntityEdgeType = typeof SAME_ENTITY_EDGE_TYPE;

/**
 * Every edge type that can appear in the graph today, as one closed
 * union:
 *
 *  - `LinkType` — rows in `document_links` (url, references, contains,
 *    part-of-thread, replies-to, succeeds, accompanies, bookmarks, visited,
 *    calendar-event, shares-phone, duplicate-content, same-resource, cited).
 *  - `NearDuplicateEdgeType` — symmetric similarity edges in
 *    `near_dup_edges`.
 *  - `PersonRole` — a document↔person edge whose label is the role the
 *    person plays on the document (sender, attendee, …). The walker has
 *    always used the role string as the edge type; this preserves that.
 *
 * The walker stays structurally type-agnostic at runtime (it traverses a
 * `document_links.link_type` value even if a future writer adds one not
 * listed here), so this union documents the closed set rather than
 * gating traversal on it.
 */
export type GraphEdgeType = LinkType | NearDuplicateEdgeType | SameEntityEdgeType | PersonRole;

/**
 * Where an edge's provenance comes from. Mirrors the four-kind taxonomy
 * the knowledge-graph-v2 series settles on so that, when a
 * per-row `provenance_kind` column eventually lands, the stored value
 * slots into this same vocabulary with no consumer churn.
 *
 *  - `source-declared` — the source asserted the relationship via a
 *    metadata field it controls (thread id, parent id, iCal UID) or the
 *    structured person mentions it attaches.
 *  - `content-derived` — Omnesis parsed it out of the document's content
 *    (a URL found in the body).
 *  - `cross-source-derived` — Omnesis computed it by comparing documents
 *    across sources (canonical-URL identity, exact extracted-content hash
 *    match, near-duplicate similarity).
 *  - `llm-derived` — an agent authored it (a citation from an `/answer`
 *    conversation).
 *
 * Today an edge's provenance is fully determined by its type, so
 * `graphEdgeProvenance()` is a pure lookup. When a per-row column is
 * added, a row-level lookup takes precedence over this type-level
 * default; the function signature is unchanged and consumers don't move.
 */
export type GraphEdgeProvenanceKind =
  | "source-declared"
  | "content-derived"
  | "cross-source-derived"
  | "llm-derived";

/**
 * Where a given edge type lives. `"synthesized"` edges are not persisted at
 * all — they are recomputed on every walk from a declarative binding (the
 * `same-entity` boundDocument edge).
 */
export type GraphEdgeStorage =
  | "document_links"
  | "near_dup_edges"
  | "document_people"
  | "synthesized";

/** The pair of vertex kinds an edge connects. */
export type GraphEdgeEndpoints = "document-document" | "document-person" | "document-analytics-row";

/**
 * The structural and provenance facts about one edge type — the schema
 * row for an edge. Consumers that need to classify an edge (filter a
 * walk by provenance, decide whether to draw an arrow, know which table
 * to query) read these rather than re-deriving the knowledge inline.
 */
export interface GraphEdgeDescriptor {
  type: GraphEdgeType;
  storage: GraphEdgeStorage;
  /**
   * Whether the edge carries a meaningful direction. `document_links`
   * rows are stored source→target and render with an arrow; near-dup and
   * person edges are symmetric. (`duplicate-content` and `same-resource`
   * are semantically symmetric but stored as directed `document_links` rows,
   * so they are reported `directed: true` to match their storage.)
   */
  directed: boolean;
  endpoints: GraphEdgeEndpoints;
  provenance: GraphEdgeProvenanceKind;
}

/**
 * Provenance for every `document_links.link_type` value. A `Record` over
 * `LinkType` so that adding a link type to the union forces a provenance
 * classification here at compile time — the set can't silently drift.
 */
const LINK_EDGE_PROVENANCE: Record<LinkType, GraphEdgeProvenanceKind> = {
  url: "content-derived",
  "shares-phone": "content-derived",
  references: "source-declared",
  contains: "source-declared",
  "part-of-thread": "source-declared",
  "replies-to": "source-declared",
  succeeds: "source-declared",
  accompanies: "source-declared",
  bookmarks: "source-declared",
  visited: "source-declared",
  "calendar-event": "source-declared",
  "duplicate-content": "cross-source-derived",
  "same-resource": "cross-source-derived",
  cited: "llm-derived",
};

function buildDescriptors(): Map<GraphEdgeType, GraphEdgeDescriptor> {
  const out = new Map<GraphEdgeType, GraphEdgeDescriptor>();
  for (const type of Object.keys(LINK_EDGE_PROVENANCE) as LinkType[]) {
    out.set(type, {
      type,
      storage: "document_links",
      directed: true,
      endpoints: "document-document",
      provenance: LINK_EDGE_PROVENANCE[type],
    });
  }
  out.set(NEAR_DUPLICATE_EDGE_TYPE, {
    type: NEAR_DUPLICATE_EDGE_TYPE,
    storage: "near_dup_edges",
    directed: false,
    endpoints: "document-document",
    provenance: "cross-source-derived",
  });
  out.set(SAME_ENTITY_EDGE_TYPE, {
    type: SAME_ENTITY_EDGE_TYPE,
    // Synthesized at walk time from a source's `boundDocument` — never stored.
    storage: "synthesized",
    // A document and its co-describing row are peer representations, not a
    // parent/child; render without an arrow.
    directed: false,
    endpoints: "document-analytics-row",
    // Type-level default: the boundDocument case is the source asserting the
    // binding. Cross-source-derived same-entity edges (future) carry their own
    // per-edge provenance, which a row-level lookup overrides.
    provenance: "source-declared",
  });
  for (const role of PERSON_ROLES) {
    out.set(role, {
      type: role,
      storage: "document_people",
      directed: false,
      endpoints: "document-person",
      provenance: "source-declared",
    });
  }
  return out;
}

const DESCRIPTORS = buildDescriptors();

/** Every edge type in the documented closed set, in a stable order. */
export const GRAPH_EDGE_TYPES: readonly GraphEdgeType[] = Array.from(DESCRIPTORS.keys());

/** Every edge descriptor — e.g. for a registry, a docs table, or tests. */
export function graphEdgeDescriptors(): GraphEdgeDescriptor[] {
  return Array.from(DESCRIPTORS.values());
}

/**
 * Descriptor for a known edge type, or `undefined` for a string outside
 * the documented set. Callers that must classify an arbitrary
 * `document_links.link_type` should handle `undefined` — the walker, for
 * one, traverses such edges structurally and never needs a descriptor.
 */
export function graphEdgeDescriptor(type: string): GraphEdgeDescriptor | undefined {
  return DESCRIPTORS.get(type as GraphEdgeType);
}

/**
 * Provenance for a known edge type, or `undefined` for an unknown one.
 * See `GraphEdgeProvenanceKind` for the forward-compatibility note.
 */
export function graphEdgeProvenance(type: string): GraphEdgeProvenanceKind | undefined {
  return DESCRIPTORS.get(type as GraphEdgeType)?.provenance;
}

/** Narrow an arbitrary string to a documented `GraphEdgeType`. */
export function isGraphEdgeType(type: string): type is GraphEdgeType {
  return DESCRIPTORS.has(type as GraphEdgeType);
}

// ─── Materialised walk ────────────────────────────────────────────────────────

/**
 * An edge in a materialised graph walk. `type` is the underlying edge
 * label — the row's `document_links.link_type`, `"near-duplicate"` for a
 * `near_dup_edges` row, or the `role` for a `document_people` row.
 */
export interface GraphEdge {
  /** `id` of the source vertex. */
  from: string;
  /** `id` of the destination vertex. */
  to: string;
  type: GraphEdgeType;
  /**
   * True when the edge has a meaningful direction (`document_links` rows
   * are source→target). False for symmetric edges (near-duplicate,
   * person↔document). UIs render an arrow iff directed.
   */
  directed: boolean;
  /** Present on near-duplicate edges so the renderer can show overlap. */
  jaccard?: number;
}

/**
 * A subgraph materialised by walking out from one or more seed
 * documents. Produced by the gateway's graph walker; consumed by the
 * `/documents/:id/graph` + `/documents/:id/trail` routes, the agent
 * trace_connections tool, and the portal.
 */
export interface DocumentGraph {
  /**
   * Vertex ids of every seed the walk started from, in the caller's
   * input order. Each entry is always present in `vertices`.
   */
  seeds: string[];
  vertices: GraphVertex[];
  edges: GraphEdge[];
  /**
   * True when at least one expansion hit a fanout cap OR the global
   * vertex cap — the graph is then a sample of the neighbourhood, not an
   * exhaustive walk.
   */
  truncated: boolean;
  stats: {
    visited: number;
    fanoutCapHits: number;
    maxDepthReached: number;
    elapsedMs: number;
  };
}

/**
 * Optional filters that narrow what the walk traverses. Each is applied
 * during expansion, BEFORE the per-category fanout cap — so a capped category
 * keeps the most-recent members of the FILTERED set, preserving the
 * "newest-first within the allowed edges" contract. All are opt-in: an absent
 * filter means "no restriction", and the walk behaves exactly as before.
 */
export interface GraphWalkFilters {
  /** Only traverse edges whose type is in this set. */
  edgeTypes?: GraphEdgeType[];
  /** Only register / expand vertices of these kinds (people / rows can be dropped). */
  vertexTypes?: GraphVertexKind[];
  /**
   * Only traverse edges of these provenance kinds — `["source-declared"]`
   * returns only gospel edges, ignoring content-/cross-source-/llm-derived
   * ones. An edge's provenance is its per-row `provenance_kind` when present,
   * else the type-level default from `graphEdgeProvenance`.
   */
  provenanceKinds?: GraphEdgeProvenanceKind[];
  /** Minimum score for scored edges (near-duplicate jaccard). */
  minScore?: number;
}

export interface BuildDocumentGraphOptions {
  /** Max BFS depth, clamped to [1, 15]. Default 10. */
  depth?: number;
  /**
   * Per-vertex per-category fanout cap, clamped to [1, 500]. Default 50.
   * "Category" means each edge source the walker fans out along (outbound
   * links, inbound links, near-duplicates, document_people), capped
   * independently.
   */
  fanoutCap?: number;
  /** Global vertex cap, clamped to [10, 2000]. Default 600. */
  maxVertices?: number;
  /** Optional traversal filters. Absent = unfiltered (legacy behaviour). */
  filters?: GraphWalkFilters;
}
