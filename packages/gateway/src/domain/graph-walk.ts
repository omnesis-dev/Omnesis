// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `graph.walk()` — the unified, typed graph-traversal primitive.
 *
 * One entry point for every neighbourhood walk: a caller names start vertices
 * by `VertexRef`, optionally constrains the traversal (edge types, vertex
 * kinds, edge provenance, near-duplicate score), and gets back the same
 * `DocumentGraph` the portal, trail, and agent already consume. It is a thin
 * typed shell over `buildDocumentGraph` (the BFS engine, which owns every stop
 * condition — depth / fanout / vertex clamps, people-terminal, url-hub filter,
 * recency ordering, dedup) plus the cross-store `attachBoundRows` pass. The
 * filters narrow what the engine traverses; with none supplied the walk is
 * byte-identical to a direct `buildDocumentGraph` call, so the existing
 * consumers can route through here without behaviour change.
 *
 * v1 seeds are documents. Person and analytics-row seeds are reserved (the BFS
 * engine only expands documents; people are terminal); they are rejected with a
 * clear error rather than silently mis-walked.
 */

import {
  buildDocumentGraph,
  buildDocumentGraphWithBoundRows,
  type BoundRowResolver,
} from "./DocumentGraphService.js";
import type {
  DocumentGraph,
  GraphEdgeProvenanceKind,
  GraphEdgeType,
  GraphVertexKind,
} from "@omnesis/core";
import type Database from "better-sqlite3";

type Db = Database.Database;

/** A reference to a graph vertex by kind + id. */
export interface VertexRef {
  kind: GraphVertexKind;
  /** documentId for `document`; (other kinds reserved for a future version). */
  id: string;
}

export interface GraphWalkRequest {
  /** Seed vertices. v1: every ref must be `kind: "document"`. */
  start: VertexRef[];
  /** Only traverse these edge types (default: all). */
  edgeTypes?: GraphEdgeType[];
  /** Only register / expand these vertex kinds (default: all). */
  vertexTypes?: GraphVertexKind[];
  /** Max hops from a seed — the BFS depth. Clamped to [1, 15], default 10. */
  maxHops?: number;
  /** Hard cap on total vertices. Clamped to [10, 2000], default 600. */
  maxResults?: number;
  /** Per-category per-vertex fanout cap. Clamped to [1, 500], default 50. */
  fanoutCap?: number;
  /** Only traverse edges of these provenance kinds. */
  provenanceKinds?: GraphEdgeProvenanceKind[];
  /** Minimum near-duplicate jaccard for scored edges. */
  minScore?: number;
  /**
   * Attach cross-store `same-entity` edges + `analytics-row` vertices.
   * Requires a `BoundRowResolver`. Ignored when `vertexTypes` excludes
   * `analytics-row`.
   */
  includeBoundRows?: boolean;
}

/** Thrown for an unsupported seed kind; the route maps it to a 400. */
export class GraphWalkInputError extends Error {}

/**
 * Walk the graph from the requested seeds under the requested filters. Async
 * because the optional bound-rows pass does a DuckDB lookup; without it the
 * work is synchronous SQLite BFS.
 */
export async function graphWalk(
  db: Db,
  resolver: BoundRowResolver | undefined,
  req: GraphWalkRequest,
): Promise<DocumentGraph> {
  if (!req.start || req.start.length === 0) {
    throw new GraphWalkInputError("graph.walk: no start vertices supplied");
  }
  const nonDoc = req.start.find((r) => r.kind !== "document");
  if (nonDoc) {
    throw new GraphWalkInputError(
      `graph.walk: v1 supports document seeds only (got "${nonDoc.kind}")`,
    );
  }
  const seedDocIds = req.start.map((r) => r.id);

  const opts = {
    depth: req.maxHops,
    maxVertices: req.maxResults,
    fanoutCap: req.fanoutCap,
    filters: {
      edgeTypes: req.edgeTypes,
      vertexTypes: req.vertexTypes,
      provenanceKinds: req.provenanceKinds,
      minScore: req.minScore,
    },
  };

  // Only run the cross-store pass when asked AND analytics rows aren't filtered
  // out — otherwise a plain synchronous BFS is enough.
  const wantBoundRows =
    req.includeBoundRows === true &&
    resolver !== undefined &&
    (!req.vertexTypes || req.vertexTypes.includes("analytics-row"));

  if (wantBoundRows) {
    return buildDocumentGraphWithBoundRows(db, resolver!, seedDocIds, opts);
  }
  return buildDocumentGraph(db, seedDocIds, opts);
}
