// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The generic bounded breadth-first graph walker — the one traversal engine
 * behind both the raw document graph (`DocumentGraphService`) and the cognitive
 * graph (`CognitiveGraphService`). It owns only the domain-agnostic mechanics:
 * the frontier queue, depth / vertex-count bounding, vertex + edge de-dup, and
 * truncation accounting. It knows nothing about what a vertex *is* or which
 * edges connect them — a caller supplies vertices (with a stable `id` and the
 * `depth` at which each was discovered), an `expand` step that fetches a
 * vertex's neighbours (already fanout-capped and filtered by the domain), and
 * an `edgeKey` that defines edge identity.
 *
 * Keeping the algorithm here means the two graphs share one provably-correct
 * BFS — the caps, the terminal-vertex handling, the de-dup keys — while their
 * vertex/edge *types* stay completely separate. That separation is load-bearing
 * for render-safety: cognitive vertex kinds live only in the cognitive module
 * and can never leak into the closed `DocumentGraph` / `TrailEvent` wire schema,
 * because this driver never names either concrete type.
 */

/** Minimum a walked vertex must expose: a stable id and its discovery depth. */
export interface WalkVertex {
  readonly id: string;
  readonly depth: number;
}

/** One neighbour discovered while expanding a vertex. */
export interface WalkNeighbor<V extends WalkVertex, E> {
  /** The neighbour vertex, already built with `depth = parent.depth + 1`. */
  readonly vertex: V;
  /** The edge connecting the pair (the domain fixes the from/to orientation). */
  readonly edge: E;
  /**
   * When true the neighbour is registered + linked but never enqueued for its
   * own expansion — a leaf. (People are terminal in the document graph; hub
   * kinds are terminal in the cognitive graph.)
   */
  readonly terminal: boolean;
}

/** What `expand` returns for one vertex. */
export interface Expansion<V extends WalkVertex, E> {
  /** How many fanout categories hit their per-category cap (truncation signal). */
  readonly capHits: number;
  readonly neighbors: ReadonlyArray<WalkNeighbor<V, E>>;
}

export interface BoundedWalkParams<V extends WalkVertex, E> {
  /** Depth-0 vertices. De-duped by id; registered unconditionally (no cap). */
  readonly seeds: ReadonlyArray<V>;
  /**
   * Anchor filter: whether a dequeued vertex may expand. This is where a graph
   * declares which vertex kinds fan out (documents only, for the raw graph) —
   * the rest are terminal even if reached.
   */
  readonly canExpand: (vertex: V) => boolean;
  /** Domain expansion: fetch, filter, per-category cap, and build neighbours. */
  readonly expand: (vertex: V) => Expansion<V, E>;
  /** Frontier depth: a vertex discovered at `depth >= maxDepth` is not expanded. */
  readonly maxDepth: number;
  /** Hard vertex ceiling; when hit the walk stops cleanly and truncates. */
  readonly maxVertices: number;
  /** Stable edge identity (must honour directed vs undirected de-dup). */
  readonly edgeKey: (edge: E) => string;
}

export interface BoundedWalkResult<V extends WalkVertex, E> {
  readonly vertices: Map<string, V>;
  readonly edges: E[];
  readonly truncated: boolean;
  readonly stats: {
    readonly visited: number;
    readonly capHits: number;
    readonly maxDepthReached: number;
  };
}

/**
 * Run the bounded BFS. Every seed is registered at depth 0 and the frontier
 * proceeds from all of them at once; vertices/edges discovered from multiple
 * seeds collapse via the id / `edgeKey` de-dup. A neighbour is registered only
 * if newly seen AND the vertex cap is not yet full — but its edge is recorded
 * regardless, so a capped-out frontier still shows *how* it connects. Only
 * newly-registered, non-terminal neighbours are enqueued.
 */
export function boundedWalk<V extends WalkVertex, E>(
  params: BoundedWalkParams<V, E>,
): BoundedWalkResult<V, E> {
  const { seeds, canExpand, expand, maxDepth, maxVertices, edgeKey } = params;

  const vertices = new Map<string, V>();
  const edges: E[] = [];
  const seenEdges = new Set<string>();
  const queue: V[] = [];
  let capHits = 0;
  let maxDepthReached = 0;

  for (const seed of seeds) {
    if (vertices.has(seed.id)) continue;
    vertices.set(seed.id, seed);
    queue.push(seed);
  }

  const pushEdge = (edge: E): void => {
    const k = edgeKey(edge);
    if (seenEdges.has(k)) return;
    seenEdges.add(k);
    edges.push(edge);
  };

  while (queue.length > 0) {
    const vertex = queue.shift()!;
    if (vertex.depth > maxDepthReached) maxDepthReached = vertex.depth;
    if (vertex.depth >= maxDepth) continue; // discovered at the frontier; don't expand
    if (vertices.size >= maxVertices) continue;
    if (!canExpand(vertex)) continue;

    const { capHits: hits, neighbors } = expand(vertex);
    capHits += hits;
    for (const neighbor of neighbors) {
      const isNew = !vertices.has(neighbor.vertex.id) && vertices.size < maxVertices;
      if (isNew) vertices.set(neighbor.vertex.id, neighbor.vertex);
      pushEdge(neighbor.edge);
      if (isNew && !neighbor.terminal) queue.push(neighbor.vertex);
    }
  }

  const truncated = capHits > 0 || vertices.size >= maxVertices;
  return {
    vertices,
    edges,
    truncated,
    stats: { visited: vertices.size, capHits, maxDepthReached },
  };
}
