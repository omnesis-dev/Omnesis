// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cross-document graph walker. Materialises the subgraph around one
 * or more seed documents into a `DocumentGraph` (the schema lives in
 * `@omnesis/core/graph`). Backs three consumers: the portal graph-debug
 * page and graph card, the `/documents/:id/trail` event timeline, and
 * the agent's trace_connections tool.
 *
 * Walks the graph type-agnostically: every row in `document_links`,
 * `near_dup_edges`, and `document_people` is followed, regardless of
 * `link_type` / role. The edge sources are declared once in the
 * `EDGE_EXPANDERS` registry below, so a new edge category is one entry
 * there rather than another bespoke traversal block — and a writer that
 * introduces an unlisted `link_type` still traverses (the `type` field
 * on each edge is just the underlying column value; `GraphEdgeType` names
 * the documented closed set without gating runtime traversal on it).
 *
 * Multi-seed walks register every seed at depth 0 and BFS proceeds from
 * all of them at once; vertices and edges discovered from multiple
 * seeds collapse naturally because the de-dup keys are by vertex id and
 * (from, to, type), not by walk-of-origin. The seeds may produce
 * disjoint subgraphs (no edge between them) and that's fine — the
 * renderer just shows multiple clusters.
 *
 * Both documents AND canonical people are vertices. People are
 * dereferenced through `merged_into` so the equivalence class shows up
 * as a single vertex.
 *
 * **People are terminal.** When the BFS expansion of a document
 * encounters a person, that person is registered as a vertex and the
 * connecting role-labelled edge is recorded — but the walk does NOT
 * hop through the person to discover OTHER documents that person is
 * on. The walker only fans out along document↔document edges; people
 * are leaves. A document seen from two different starting docs will
 * still produce two edges to the same person vertex because each
 * source document carries its own role-labelled edge to it.
 *
 * BFS bounded by `depth` (1–15, default 10) and `fanoutCap` (default 50
 * per direction per category, to keep email-thread-style fully-connected
 * components from exploding). `maxVertices` is a final safety net
 * (default 600) — when hit, the walk stops cleanly and `truncated` is
 * set so the caller knows the graph is incomplete.
 */

import {
  NEAR_DUPLICATE_EDGE_TYPE,
  SAME_ENTITY_EDGE_TYPE,
  analyticsRowKey,
  parseSourceKey,
  graphEdgeProvenance,
  assertNever,
  type GraphVertexKind,
  type GraphVertex,
  type GraphEdge,
  type GraphEdgeType,
  type GraphEdgeProvenanceKind,
  type GraphWalkFilters,
  type DocumentGraph,
  type BuildDocumentGraphOptions,
} from "@omnesis/core";
import { getUrlTraversalHubSources } from "../url-graph-roles.js";
import { sourcePrefixPredicate } from "../data/source-addressing.js";
import {
  canonicalRowKey,
  reconstructRowKey,
  type BoundDocumentBinding,
  type BoundRowResolver,
} from "../analytics/bound-documents.js";
import { boundedWalk, type Expansion, type WalkNeighbor } from "./graph-engine/bounded-walk.js";

// Re-exported so existing consumers keep importing it from the walker module.
export type { BoundRowResolver };
import type { ColumnType } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";

type Db = Database.Database;

// The graph vertex / edge / walk DTOs (`GraphVertex`, `GraphEdge`,
// `DocumentGraph`, `BuildDocumentGraphOptions`) and the edge-type
// vocabulary (`GraphEdgeType`, `NEAR_DUPLICATE_EDGE_TYPE`) live in
// `@omnesis/core/graph` — the single schema both this producer and every
// consumer (routes, agent tool, portal) share. This module is the
// producer: it walks SQLite and materialises a `DocumentGraph`.

export type { DocumentGraph, BuildDocumentGraphOptions };

// ─── Internal row shapes ──────────────────────────────────────────────────

interface DocRow {
  id: string;
  title: string;
  source_id: string;
  source_url: string | null;
  source_created_at: string;
  document_type: string | null;
  mime_type: string | null;
  app_url: string | null;
}

interface PersonRow {
  id: string;
  canonical_name: string;
  is_self: number;
}

interface OutboundLinkRow {
  link_type: string;
  target_doc_id: string;
  provenance_kind: string | null;
}

interface InboundLinkRow {
  source_doc_id: string;
  link_type: string;
  provenance_kind: string | null;
}

interface NearDupRow {
  other_id: string;
  jaccard: number;
}

interface DocPersonRow {
  /** Already canonical-dereferenced via the JOIN below. */
  canonical_id: string;
  role: string;
}

// ─── Defaults / clamps ────────────────────────────────────────────────────

const DEFAULT_DEPTH = 10;
const MIN_DEPTH = 1;
const MAX_DEPTH = 15;

const DEFAULT_FANOUT_CAP = 50;
const MIN_FANOUT_CAP = 1;
const MAX_FANOUT_CAP = 500;

const DEFAULT_MAX_VERTICES = 600;
const MIN_MAX_VERTICES = 10;
const MAX_MAX_VERTICES = 2000;

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(value)));
}

// ─── Vertex key helpers ───────────────────────────────────────────────────

function docKey(documentId: string): string {
  return `doc:${documentId}`;
}

function personKey(personId: string): string {
  return `person:${personId}`;
}

// ─── Service ──────────────────────────────────────────────────────────────

/**
 * Build the subgraph around one or more seed documents.
 *
 * Throws `Error("seed not found: <id>")` if any seed document does not
 * exist; the route layer maps that to a 404. Throws `Error("no seeds
 * supplied")` for an empty input array.
 */
export function buildDocumentGraph(
  db: Db,
  seedDocIds: string[],
  opts: BuildDocumentGraphOptions = {},
): DocumentGraph {
  const startedAt = Date.now();
  const depth = clamp(opts.depth ?? DEFAULT_DEPTH, MIN_DEPTH, MAX_DEPTH);
  const fanoutCap = clamp(opts.fanoutCap ?? DEFAULT_FANOUT_CAP, MIN_FANOUT_CAP, MAX_FANOUT_CAP);
  const maxVertices = clamp(
    opts.maxVertices ?? DEFAULT_MAX_VERTICES,
    MIN_MAX_VERTICES,
    MAX_MAX_VERTICES,
  );
  const filters = opts.filters ?? {};

  if (seedDocIds.length === 0) throw new Error("no seeds supplied");

  // Resolve every seed up front, preserving input order. Throw the
  // first missing id so the caller can report which one is bad. We
  // tolerate the same id appearing more than once — duplicates collapse
  // naturally into one vertex below.
  const seedRows: DocRow[] = [];
  const seenSeedIds = new Set<string>();
  for (const id of seedDocIds) {
    const row = loadDocRow(db, id);
    if (!row) throw new Error(`seed not found: ${id}`);
    if (seenSeedIds.has(row.id)) continue;
    seenSeedIds.add(row.id);
    seedRows.push(row);
  }

  // Prepared statements — reused across BFS iterations so we're not
  // re-parsing SQL per vertex. Active for the duration of this call.
  const stmts = prepare(db);

  const seedVertices = seedRows.map((row) => vertexFromDoc(row, 0));

  // The traversal itself is the shared `boundedWalk` driver; this module
  // supplies only what is document-specific: which vertices expand (documents
  // only — people are terminal), how a document's neighbours are fetched
  // (`expandDocument`), and the edge de-dup identity (`edgeDedupKey`).
  const walk = boundedWalk<GraphVertex, GraphEdge>({
    seeds: seedVertices,
    canExpand: (v) => v.kind === "document",
    expand: (v) => expandDocument(db, stmts, v, fanoutCap, filters),
    maxDepth: depth,
    maxVertices,
    edgeKey: edgeDedupKey,
  });

  return {
    seeds: seedVertices.map((v) => v.id),
    vertices: Array.from(walk.vertices.values()),
    edges: walk.edges,
    truncated: walk.truncated,
    stats: {
      visited: walk.stats.visited,
      fanoutCapHits: walk.stats.capHits,
      maxDepthReached: walk.stats.maxDepthReached,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

// ─── Expansion (one BFS step) ─────────────────────────────────────────────

type Stmts = ReturnType<typeof prepare>;

/** One neighbour an expander yields for a document. */
interface NeighborRow {
  /** Document id or canonical person id of the neighbour. */
  id: string;
  /** Edge label — `document_links.link_type`, `"near-duplicate"`, or role. */
  type: GraphEdgeType;
  /** Present on near-duplicate edges. */
  jaccard?: number;
  /**
   * Per-row provenance for the `provenanceKinds` filter (#430). Set from
   * `document_links.provenance_kind` when stored; the filter falls back to the
   * type-level default for rows / edge sources that don't carry one.
   */
  provenance?: GraphEdgeProvenanceKind;
}

/**
 * One edge source the walker fans out along. Each expander owns a single
 * category of edge — its table, its direction, whether the neighbour is a
 * document or a (terminal) person — so the generic loop below treats all
 * of them uniformly. Adding an edge category is adding one entry here,
 * not another hand-rolled block.
 */
interface EdgeExpander {
  /** Diagnostic label; also the fanout-cap accounting unit. */
  category: string;
  /** Vertex kind on the far end of every edge this expander yields. */
  neighborKind: GraphVertexKind;
  /** Direction recorded on the edge. */
  directed: boolean;
  /**
   * Edge orientation: when true the current document is the `from`
   * endpoint and the neighbour the `to`. Inbound links set this false —
   * the neighbour is the source. Irrelevant for undirected edges, where
   * `pushEdge` normalises endpoint order anyway.
   */
  fromIsSelf: boolean;
  /**
   * When true the neighbour is registered + linked but never enqueued for
   * its own expansion. People are terminal: a document discovers them,
   * but the walk doesn't hop through a person to reach other documents.
   */
  terminal: boolean;
  /** Fetch every neighbour row for `docId` (before the fanout cap). */
  fetch(stmts: Stmts, docId: string): NeighborRow[];
}

const EDGE_EXPANDERS: EdgeExpander[] = [
  {
    // Outbound document_links → directed edges to resolved targets.
    // `target_doc_id IS NOT NULL` (in the SQL) because an unresolved URL
    // link has no vertex to walk to. The hub params filter out `url`
    // edges whose target sits in a URL-hub source (see prepare()).
    category: "outbound-link",
    neighborKind: "document",
    directed: true,
    fromIsSelf: true,
    terminal: false,
    fetch: (stmts, docId) =>
      (stmts.outboundLinks.all(docId, ...stmts.hubParams) as OutboundLinkRow[]).map((r) => ({
        id: r.target_doc_id,
        // The column is the authoritative value; `GraphEdgeType` is the
        // documented closed set. A future writer's unknown link_type
        // still traverses — the union is a label, not a runtime gate.
        type: r.link_type as GraphEdgeType,
        provenance: (r.provenance_kind as GraphEdgeProvenanceKind | null) ?? undefined,
      })),
  },
  {
    // Inbound document_links → directed edges from the source document.
    category: "inbound-link",
    neighborKind: "document",
    directed: true,
    fromIsSelf: false,
    terminal: false,
    fetch: (stmts, docId) =>
      (stmts.inboundLinks.all(docId, ...stmts.hubParams) as InboundLinkRow[]).map((r) => ({
        id: r.source_doc_id,
        type: r.link_type as GraphEdgeType,
        provenance: (r.provenance_kind as GraphEdgeProvenanceKind | null) ?? undefined,
      })),
  },
  {
    // Near-duplicate edges (symmetric — no direction).
    category: "near-duplicate",
    neighborKind: "document",
    directed: false,
    fromIsSelf: true,
    terminal: false,
    fetch: (stmts, docId) =>
      (stmts.nearDup.all(docId, docId, docId) as NearDupRow[]).map((r) => ({
        id: r.other_id,
        type: NEAR_DUPLICATE_EDGE_TYPE,
        jaccard: r.jaccard,
      })),
  },
  {
    // People on this document, dereferenced through merged_into. Terminal:
    // a second document sharing the person rediscovers them and adds its
    // own role-labelled edge.
    category: "person",
    neighborKind: "person",
    directed: false,
    fromIsSelf: true,
    terminal: true,
    fetch: (stmts, docId) =>
      (stmts.docPeople.all(docId) as DocPersonRow[]).map((r) => ({
        id: r.canonical_id,
        type: r.role as GraphEdgeType,
      })),
  },
];

/** Whether the optional walk filters object actually constrains anything. */
function hasEdgeFilters(filters: GraphWalkFilters): boolean {
  return Boolean(filters.edgeTypes || filters.provenanceKinds || filters.minScore !== undefined);
}

/**
 * Whether a fetched neighbour edge passes the active filters. An edge's
 * provenance is its per-row `provenance` (from `document_links.provenance_kind`)
 * when stored, else the type-level default. `minScore` only constrains scored
 * edges (near-duplicate jaccard); unscored edges always pass it.
 */
function keepEdgeRow(row: NeighborRow, filters: GraphWalkFilters): boolean {
  if (filters.edgeTypes && !filters.edgeTypes.includes(row.type)) return false;
  if (filters.provenanceKinds) {
    const prov = row.provenance ?? graphEdgeProvenance(row.type);
    if (!prov || !filters.provenanceKinds.includes(prov)) return false;
  }
  if (
    filters.minScore !== undefined &&
    row.jaccard !== undefined &&
    row.jaccard < filters.minScore
  ) {
    return false;
  }
  return true;
}

/**
 * Fan out one document vertex along every edge source and return its
 * neighbours + the fanout-cap-hit count — a pure step the `boundedWalk` driver
 * consumes (the driver owns de-dup, registration, and enqueueing).
 *
 * The expansion is driven entirely by `EDGE_EXPANDERS`; this loop knows
 * nothing about specific edge types or tables. Optional `filters`
 * narrow what is traversed — applied BEFORE the per-category fanout cap so a
 * capped category keeps the newest members of the FILTERED set. With no
 * filters the behaviour is byte-identical to the unfiltered walk.
 */
function expandDocument(
  db: Db,
  stmts: Stmts,
  vertex: GraphVertex,
  fanoutCap: number,
  filters: GraphWalkFilters,
): Expansion<GraphVertex, GraphEdge> {
  const docId = vertex.documentId!;
  const nextDepth = vertex.depth + 1;
  let capHits = 0;
  const neighbors: WalkNeighbor<GraphVertex, GraphEdge>[] = [];
  const edgeFiltersActive = hasEdgeFilters(filters);

  for (const expander of EDGE_EXPANDERS) {
    // vertexTypes: drop a whole edge source whose neighbour kind is filtered
    // out (e.g. ["document"] skips the person expander — people never appear).
    if (filters.vertexTypes && !filters.vertexTypes.includes(expander.neighborKind)) continue;
    const fetched = expander.fetch(stmts, docId);
    const rows = edgeFiltersActive ? fetched.filter((r) => keepEdgeRow(r, filters)) : fetched;
    if (rows.length > fanoutCap) capHits++;
    for (const row of rows.slice(0, fanoutCap)) {
      let neighbor: GraphVertex | null;
      switch (expander.neighborKind) {
        case "document":
          neighbor = buildDocVertex(db, row.id, nextDepth);
          break;
        case "person":
          neighbor = buildPersonVertex(db, row.id, nextDepth);
          break;
        case "analytics-row":
          // Analytics-row vertices are never reached by the BFS — they are
          // attached post-walk by `attachBoundRows` (#450). An EDGE_EXPANDERS
          // entry declaring this kind is a programming error.
          throw new Error("analytics-row neighbours are not expanded during BFS");
        default:
          return assertNever(expander.neighborKind);
      }
      if (!neighbor) continue;

      const edge: GraphEdge = {
        from: expander.fromIsSelf ? vertex.id : neighbor.id,
        to: expander.fromIsSelf ? neighbor.id : vertex.id,
        type: row.type,
        directed: expander.directed,
      };
      if (row.jaccard !== undefined) edge.jaccard = row.jaccard;
      neighbors.push({ vertex: neighbor, edge, terminal: expander.terminal });
    }
  }

  return { capHits, neighbors };
}

/** Load a document row and project it to a vertex, or null if missing. */
function buildDocVertex(db: Db, id: string, depth: number): GraphVertex | null {
  const row = loadDocRow(db, id);
  return row ? vertexFromDoc(row, depth) : null;
}

/** Load a canonical person row and project it to a vertex, or null. */
function buildPersonVertex(db: Db, id: string, depth: number): GraphVertex | null {
  const row = loadPersonRow(db, id);
  return row ? vertexFromPerson(row, depth) : null;
}

// ─── Loaders ──────────────────────────────────────────────────────────────

function loadDocRow(db: Db, id: string): DocRow | null {
  const row = db
    .prepare<[string], DocRow>(
      // The published links, documentType and mimeType are surfaced from
      // the metadata JSON blob; SQLite's json_extract returns NULL when a
      // field is absent, which the consumer normalises to undefined.
      `SELECT id, title, source_id, source_created_at,
              json_extract(metadata, '$.sourceUrl') AS source_url,
              json_extract(metadata, '$.documentType') AS document_type,
              json_extract(metadata, '$.extra.mimeType') AS mime_type,
              json_extract(metadata, '$.appUrl') AS app_url
       FROM documents
       WHERE id = ?`,
    )
    .get(id);
  return row ?? null;
}

function loadPersonRow(db: Db, id: string): PersonRow | null {
  // Caller already dereferenced merged_into via the doc_people JOIN, so
  // `id` is the canonical id. Defensive: confirm merged_into IS NULL so
  // a stale id can't smuggle in a non-canonical person.
  const row = db
    .prepare<[string], PersonRow>(
      `SELECT id, canonical_name, is_self
       FROM people
       WHERE id = ? AND merged_into IS NULL`,
    )
    .get(id);
  return row ?? null;
}

function vertexFromDoc(row: DocRow, depth: number): GraphVertex {
  return {
    id: docKey(row.id),
    kind: "document",
    depth,
    documentId: row.id,
    title: row.title,
    sourceId: row.source_id,
    sourceUrl: row.source_url ?? undefined,
    appUrl: row.app_url ?? undefined,
    sourceCreatedAt: row.source_created_at,
    documentType: row.document_type ?? undefined,
    mimeType: row.mime_type ?? undefined,
  };
}

function vertexFromPerson(row: PersonRow, depth: number): GraphVertex {
  return {
    id: personKey(row.id),
    kind: "person",
    depth,
    personId: row.id,
    canonicalName: row.canonical_name,
    isSelf: !!row.is_self,
  };
}

// ─── Prepared statements ──────────────────────────────────────────────────

function prepare(db: Db) {
  // `url`-typed edges whose other endpoint sits in a hub source are
  // dropped from BFS expansion. These sources accumulate referential
  // (rather than structural) edges and blow up the neighbourhood
  // through them — 592 vertices for a single seed in the regression
  // that motivated this filter. Structural URL edges between real
  // sources (Gmail → Drive, WhatsApp → Drive, …) stay; we only filter
  // when the OTHER end is a URL hub. See
  // concepts/people-and-reference-graphs.md.
  //
  // The hub set is read from the process registry at prepare time:
  // built-in entries plus whatever the collector last pushed via
  // POST /admin/url-graph-roles (mirrors the per-source `urlHub: true`
  // flag on `defineSource`). Empty registry → no filter, the SQL
  // collapses to a plain `source_doc_id = ?` lookup.
  const hubs = Array.from(getUrlTraversalHubSources());
  // hubParams is appended to every .all() call that uses the filtered
  // statements, in the same order the clause binds them.
  const hubPredicate = sourcePrefixPredicate("d.source_id", hubs);
  const hubParams: string[] = hubs.length > 0 ? hubPredicate.params : [];
  const hubFilterSql =
    hubs.length > 0 ? ` AND NOT (dl.link_type = 'url' AND (${hubPredicate.sql}))` : "";
  return {
    hubParams,
    // Ordered newest-neighbour-first (by the linked document's source time),
    // so when the per-category fanout cap slices a large component — a
    // 200-message thread, a doc cited dozens of times — it keeps the most
    // RECENT members rather than the earliest-ingested ones. This matters for
    // "what's the latest" questions: the cap must not drop the newest reply in
    // favour of the oldest. `dl.id` breaks ties deterministically.
    outboundLinks: db.prepare(
      `SELECT dl.id, dl.link_type, dl.target_doc_id, dl.provenance_kind
       FROM document_links dl
       JOIN documents d ON d.id = dl.target_doc_id
       WHERE dl.source_doc_id = ?
         AND dl.target_doc_id IS NOT NULL${hubFilterSql}
       ORDER BY d.source_created_at DESC, dl.id`,
    ),
    inboundLinks: db.prepare(
      `SELECT dl.source_doc_id, dl.link_type, dl.provenance_kind
       FROM document_links dl
       JOIN documents d ON d.id = dl.source_doc_id
       WHERE dl.target_doc_id = ?${hubFilterSql}
       ORDER BY d.source_created_at DESC, dl.id`,
    ),
    nearDup: db.prepare(
      // Pick the "other" endpoint of every near-dup edge involving the
      // queried doc. CHECK(doc_a < doc_b) at the schema level means we
      // need an OR-clause across both columns.
      `SELECT CASE WHEN doc_a = ? THEN doc_b ELSE doc_a END AS other_id, jaccard
       FROM near_dup_edges
       WHERE doc_a = ? OR doc_b = ?
       ORDER BY jaccard DESC`,
    ),
    docPeople: db.prepare(
      // Dereference dp.person_id to its canonical via merged_into. The
      // pattern is the same as `getDocumentPeople` in
      // DocumentPeopleRepository — keep them in sync if that one
      // evolves.
      `SELECT DISTINCT canonical.id AS canonical_id, dp.role
       FROM document_people dp
       JOIN people p ON p.id = dp.person_id
       JOIN people canonical
         ON canonical.id = COALESCE(p.merged_into, p.id)
        AND canonical.merged_into IS NULL
       WHERE dp.document_id = ?
       ORDER BY canonical.id, dp.role`,
    ),
  };
}

// ─── One-hop expansion: the shared adjacency primitive ──────────────

/**
 * One document neighbour reached by a single graph hop. Carries just enough
 * of the document to build a compact `DocRef` (no body) plus the edge that
 * connects it to the seed, so the agent both sees *what* the neighbour is and
 * *how* it relates. The shaping into a wire `DocRef` / breadcrumb is the
 * agent-port's job (`packages/gateway/src/agent/ports.ts`) — this layer stays
 * a pure graph concern.
 */
export interface OneHopNeighbor {
  documentId: string;
  /** The graph edge type connecting the seed to this neighbour. */
  edgeType: GraphEdgeType;
  /**
   * How the seed relates to the neighbour: `outbound` (seed → neighbour),
   * `inbound` (neighbour → seed) for directed `document_links`, or `peer`
   * for symmetric edges (near-duplicate).
   */
  direction: "outbound" | "inbound" | "peer";
  title?: string;
  sourceId?: string;
  sourceUrl?: string;
  appUrl?: string;
  documentType?: string;
  mimeType?: string;
  sourceCreatedAt?: string;
}

export interface ExpandOneHopOptions {
  /** Max neighbours returned after ranking. Default 8, clamped to [1, 24]. */
  fanout?: number;
}

/** Result of a one-hop expansion. */
export interface OneHopExpansion {
  /** The bounded, ranked neighbour set (most-structural-first, newest-within-type). */
  neighbors: OneHopNeighbor[];
  /**
   * True when the document has MORE 1-hop neighbours than were returned —
   * a per-category cap or the final fanout slice dropped some. The agent
   * port surfaces this so the model knows the set is a recency-ordered
   * sample, not the whole neighbourhood (run `trace_connections` for the rest).
   */
  truncated: boolean;
}

export const ONE_HOP_DEFAULT_FANOUT = 8;
const ONE_HOP_MAX_FANOUT = 24;
/**
 * Per-edge-category cap handed to the BFS. Kept far below the walk's own
 * default (50) so a 200-message thread or a hub document is throttled to a
 * handful of its most-relevant edges before ranking ever runs. With ≤4
 * categories this also bounds the depth-1 frontier to ~24 vertices.
 */
const ONE_HOP_PER_CATEGORY_CAP = 6;
/** Global vertex ceiling for the depth-1 walk (seed + a bounded frontier). */
const ONE_HOP_MAX_VERTICES = 48;

/**
 * Ranking of edge types, surfaced-first. Structural, source-declared edges
 * (an attachment, the calendar event behind an email, a thread reply) carry
 * the most adjacency signal; content-derived URL links and llm-authored
 * citations carry the least. Person edges never reach this ranking — they are
 * terminal in the walk and a person is not a document neighbour anyway, which
 * is exactly what keeps a spouse/manager super-node from dragging unrelated
 * documents into a one-hop expansion.
 */
const EDGE_TYPE_RANK: Partial<Record<GraphEdgeType, number>> = {
  contains: 0,
  "calendar-event": 1,
  "replies-to": 2,
  "part-of-thread": 3,
  references: 4,
  succeeds: 5,
  accompanies: 6,
  [SAME_ENTITY_EDGE_TYPE]: 7,
  "duplicate-content": 8,
  "same-resource": 8,
  [NEAR_DUPLICATE_EDGE_TYPE]: 9,
  url: 10,
  // Citation provenance has low adjacency signal and follows structural edges.
  cited: 11,
};
const ONE_HOP_UNKNOWN_RANK = 12;

function edgeTypeRank(type: GraphEdgeType): number {
  return EDGE_TYPE_RANK[type] ?? ONE_HOP_UNKNOWN_RANK;
}

/**
 * Bounded depth-1 expansion around a single document — the one shared 1-hop
 * walker behind both `fetch_document(includeNeighbors)` and the top-hit
 * search breadcrumb. Returns at most `fanout` *document* neighbours,
 * ranked most-structural-first, never people and never the seed itself, plus a
 * `truncated` flag set when the document has more neighbours than were
 * returned.
 *
 * Implemented as the existing BFS run at depth 1 with tight caps, so it
 * inherits every hub-avoidance guard the full walk already has — the url-hub
 * source filter, the per-category fanout cap, the global vertex ceiling — for
 * free, and can never drift from `EDGE_EXPANDERS`. Because the per-category cap
 * keeps the most-recent members (the link queries order by neighbour recency),
 * a capped long thread surfaces its newest replies, not its oldest. A missing
 * seed yields an empty result rather than throwing: a caller that already holds
 * the document shouldn't get an exception if a race deleted it underneath them.
 */
export function expandOneHop(
  db: Db,
  documentId: string,
  opts: ExpandOneHopOptions = {},
): OneHopExpansion {
  const fanout = clamp(opts.fanout ?? ONE_HOP_DEFAULT_FANOUT, 1, ONE_HOP_MAX_FANOUT);

  let graph: DocumentGraph;
  try {
    graph = buildDocumentGraph(db, [documentId], {
      depth: 1,
      fanoutCap: ONE_HOP_PER_CATEGORY_CAP,
      maxVertices: ONE_HOP_MAX_VERTICES,
    });
  } catch {
    return { neighbors: [], truncated: false };
  }

  const seedVid = docKey(documentId);
  const vertexById = new Map(graph.vertices.map((v) => [v.id, v] as const));

  // At depth 1 only the seed expands, so every edge is incident to the seed
  // and names exactly one neighbour. Collapse parallel edges to one record
  // per neighbour, keeping the highest-priority (lowest-rank) edge.
  interface Pick {
    vid: string;
    type: GraphEdgeType;
    direction: OneHopNeighbor["direction"];
  }
  const byNeighbor = new Map<string, Pick>();
  for (const edge of graph.edges) {
    let vid: string;
    let direction: OneHopNeighbor["direction"];
    if (edge.from === seedVid) {
      vid = edge.to;
      direction = edge.directed ? "outbound" : "peer";
    } else if (edge.to === seedVid) {
      vid = edge.from;
      direction = edge.directed ? "inbound" : "peer";
    } else {
      continue; // defensive: no non-seed-incident edges exist at depth 1
    }
    const vertex = vertexById.get(vid);
    // Only document neighbours become DocRefs: people are terminal (and not
    // documents), analytics rows are never reached by this synchronous walk.
    if (!vertex || vertex.kind !== "document" || !vertex.documentId) continue;
    const existing = byNeighbor.get(vid);
    if (!existing || edgeTypeRank(edge.type) < edgeTypeRank(existing.type)) {
      byNeighbor.set(vid, { vid, type: edge.type, direction });
    }
  }

  const neighbors: OneHopNeighbor[] = [];
  for (const { vid, type, direction } of byNeighbor.values()) {
    const v = vertexById.get(vid)!;
    neighbors.push({
      documentId: v.documentId!,
      edgeType: type,
      direction,
      title: v.title,
      sourceId: v.sourceId,
      sourceUrl: v.sourceUrl,
      appUrl: v.appUrl,
      documentType: v.documentType,
      mimeType: v.mimeType,
      sourceCreatedAt: v.sourceCreatedAt,
    });
  }

  // Rank most-structural-first; break ties by recency (newer ISO first) so a
  // same-type cluster surfaces its latest member and the order is stable.
  neighbors.sort((a, b) => {
    const r = edgeTypeRank(a.edgeType) - edgeTypeRank(b.edgeType);
    if (r !== 0) return r;
    const ta = a.sourceCreatedAt ?? "";
    const tb = b.sourceCreatedAt ?? "";
    if (ta !== tb) return ta < tb ? 1 : -1;
    return a.documentId < b.documentId ? -1 : 1;
  });

  // Truncated when the BFS hit a per-category cap (more edges than the cap in
  // some category) OR more distinct neighbours were found than `fanout` keeps.
  const truncated = graph.truncated || neighbors.length > fanout;
  return { neighbors: neighbors.slice(0, fanout), truncated };
}

// ─── Cross-store: attach bound analytics rows (#450) ──────────────────────────

export interface AttachBoundRowsOptions {
  /** Hard cap on total vertices; shares the BFS default (600). */
  maxVertices?: number;
  /** Explicit column projection for the row payload; overrides the default. */
  rowProjection?: string[];
  /** Default-projection width when `rowProjection` is unset. Default 12. */
  maxRowColumns?: number;
}

const DEFAULT_ROW_COLUMNS = 12;

/**
 * Second phase of the cross-store walk (#450): for every document vertex whose
 * source declares a `boundDocument`, synthesize the `same-entity` edge to its
 * co-described DuckDB row and attach that row as an `analytics-row` vertex.
 *
 * The structural edge needs only the document's `externalId` + the binding
 * (no DuckDB), but the row's existence and projected payload need one batched
 * DuckDB lookup per table — so this runs as an async pass over the
 * already-built (synchronous) graph rather than inside the BFS. A missing row
 * attaches nothing: the synthesized edge self-heals (there is no FK between the
 * stores, and a row deleted since the doc landed simply yields no edge).
 * Mutates `graph` in place.
 */
export async function attachBoundRows(
  db: Db,
  resolver: BoundRowResolver,
  graph: DocumentGraph,
  opts: AttachBoundRowsOptions = {},
): Promise<void> {
  const bindings = await resolver.getBoundDocumentBindings();
  if (bindings.size === 0) return;

  const docVertices = graph.vertices.filter((v) => v.kind === "document" && v.documentId);
  if (docVertices.length === 0) return;

  const idents = loadDocIdentities(
    db,
    docVertices.map((v) => v.documentId!),
  );

  interface Candidate {
    rowVid: string;
    fromVid: string;
    depth: number;
    binding: BoundDocumentBinding;
    keyValues: string[];
    keyColumns: { name: string; castType?: ColumnType }[];
  }
  const byTable = new Map<string, Candidate[]>();

  for (const v of docVertices) {
    const ident = idents.get(v.documentId!);
    if (!ident) continue;
    const sourceType = parseSourceKey(ident.sourceId).sourceType;
    const tableBindings = bindings.get(sourceType);
    if (!tableBindings) continue;
    for (const binding of tableBindings) {
      const key = reconstructRowKey(ident, binding);
      if (!key) continue;
      const candidate: Candidate = {
        rowVid: analyticsRowKey(binding.tableName, key.pkString),
        fromVid: v.id,
        depth: v.depth + 1,
        binding,
        keyValues: key.keyValues,
        keyColumns: key.keyColumns,
      };
      const list = byTable.get(binding.tableName);
      if (list) list.push(candidate);
      else byTable.set(binding.tableName, [candidate]);
    }
  }
  if (byTable.size === 0) return;

  const maxVertices = clamp(
    opts.maxVertices ?? DEFAULT_MAX_VERTICES,
    MIN_MAX_VERTICES,
    MAX_MAX_VERTICES,
  );
  const existingVids = new Set(graph.vertices.map((v) => v.id));
  const seenEdges = new Set(graph.edges.map((e) => edgeDedupKey(e)));

  for (const [tableName, candidates] of byTable) {
    const binding = candidates[0].binding;
    const keyColumns = candidates[0].keyColumns;
    const projection =
      opts.rowProjection ?? binding.columns.slice(0, opts.maxRowColumns ?? DEFAULT_ROW_COLUMNS);
    const tuples = candidates.map((c) => c.keyValues);
    const rows = await resolver.getRowsByKeys(tableName, keyColumns, tuples, { projection });

    for (const c of candidates) {
      const row = rows.get(canonicalRowKey(c.keyValues));
      if (!row) continue; // no row → no edge (self-healing)

      if (!existingVids.has(c.rowVid)) {
        if (graph.vertices.length >= maxVertices) {
          graph.truncated = true;
          continue;
        }
        graph.vertices.push({
          id: c.rowVid,
          kind: "analytics-row",
          depth: c.depth,
          tableName,
          tableDisplayName: binding.tableDisplayName,
          rowPrimaryKey: c.keyValues.join(":"),
          rowPrimaryKeyColumns: c.keyColumns.map((kc, i) => ({
            name: kc.name,
            value: c.keyValues[i],
            castType: kc.castType,
          })),
          rowSourceId: binding.sourceId,
          row,
        });
        existingVids.add(c.rowVid);
      }

      const edge: GraphEdge = {
        from: c.fromVid,
        to: c.rowVid,
        type: SAME_ENTITY_EDGE_TYPE,
        directed: false,
      };
      const ek = edgeDedupKey(edge);
      if (!seenEdges.has(ek)) {
        seenEdges.add(ek);
        graph.edges.push(edge);
      }
    }
  }
}

/**
 * Convenience wrapper: run the synchronous BFS, then attach bound analytics
 * rows. Callers that don't need cross-store edges keep calling
 * `buildDocumentGraph` directly (unchanged, sync).
 */
export async function buildDocumentGraphWithBoundRows(
  db: Db,
  resolver: BoundRowResolver,
  seedDocIds: string[],
  opts: BuildDocumentGraphOptions = {},
): Promise<DocumentGraph> {
  const graph = buildDocumentGraph(db, seedDocIds, opts);
  await attachBoundRows(db, resolver, graph, { maxVertices: opts.maxVertices });
  return graph;
}

/** Edge identity matching the BFS de-dup convention (directed vs symmetric). */
function edgeDedupKey(edge: GraphEdge): string {
  return edge.directed
    ? `D|${edge.from}→${edge.to}|${edge.type}`
    : `U|${[edge.from, edge.to].sort().join("↔")}|${edge.type}`;
}

interface DocIdentity {
  externalId: string;
  sourceId: string;
  /** The document's device stream (`""` = the source's one stream). */
  streamId: string;
}

/** Batch-load `(external_id, source_id)` for a set of document ids. */
function loadDocIdentities(db: Db, ids: string[]): Map<string, DocIdentity> {
  const out = new Map<string, DocIdentity>();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<
        string[],
        { id: string; external_id: string | null; source_id: string; stream_id: string }
      >(`SELECT id, external_id, source_id, stream_id FROM documents WHERE id IN (${placeholders})`)
      .all(...chunk);
    for (const r of rows) {
      if (r.external_id == null) continue;
      out.set(r.id, { externalId: r.external_id, sourceId: r.source_id, streamId: r.stream_id });
    }
  }
  return out;
}
