// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect } from "vitest";
import { boundedWalk, type WalkNeighbor } from "./bounded-walk.js";

// A tiny synthetic graph so the driver can be tested with zero I/O: an
// adjacency map of id -> outgoing (neighbourId, terminal) edges.
interface V {
  id: string;
  depth: number;
}
interface E {
  from: string;
  to: string;
}
const edgeKey = (e: E): string => `${e.from}->${e.to}`;

/** Build an `expand` over a fixed adjacency map; every reachable id is a vertex. */
function expanderOver(adj: Record<string, Array<{ to: string; terminal?: boolean }>>, cap = 100) {
  return (v: V) => {
    const out = adj[v.id] ?? [];
    const capHits = out.length > cap ? 1 : 0;
    const neighbors: WalkNeighbor<V, E>[] = out.slice(0, cap).map((n) => ({
      vertex: { id: n.to, depth: v.depth + 1 },
      edge: { from: v.id, to: n.to },
      terminal: n.terminal ?? false,
    }));
    return { capHits, neighbors };
  };
}

describe("boundedWalk", () => {
  test("BFS reaches the transitive closure within the depth bound", () => {
    const adj = { a: [{ to: "b" }], b: [{ to: "c" }], c: [{ to: "d" }] };
    const r = boundedWalk<V, E>({
      seeds: [{ id: "a", depth: 0 }],
      canExpand: () => true,
      expand: expanderOver(adj),
      maxDepth: 2,
      maxVertices: 100,
      edgeKey,
    });
    // depth 0:a expands->b(1); b expands->c(2); c is at frontier (depth 2 >= maxDepth) so d never appears.
    expect([...r.vertices.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(r.stats.maxDepthReached).toBe(2);
    expect(r.truncated).toBe(false);
  });

  test("terminal neighbours are registered + linked but never expanded", () => {
    const adj = { a: [{ to: "p", terminal: true }], p: [{ to: "secret" }] };
    const r = boundedWalk<V, E>({
      seeds: [{ id: "a", depth: 0 }],
      canExpand: () => true,
      expand: expanderOver(adj),
      maxDepth: 10,
      maxVertices: 100,
      edgeKey,
    });
    expect([...r.vertices.keys()].sort()).toEqual(["a", "p"]); // secret unreachable through terminal p
    expect(r.edges).toEqual([{ from: "a", to: "p" }]);
  });

  test("canExpand=false makes a kind terminal even when reached", () => {
    const adj = { a: [{ to: "b" }], b: [{ to: "c" }] };
    const r = boundedWalk<V, E>({
      seeds: [{ id: "a", depth: 0 }],
      canExpand: (v) => v.id !== "b", // b is reached but refuses to expand
      expand: expanderOver(adj),
      maxDepth: 10,
      maxVertices: 100,
      edgeKey,
    });
    expect([...r.vertices.keys()].sort()).toEqual(["a", "b"]); // c never discovered
  });

  test("maxVertices caps registration but the connecting edge is still recorded", () => {
    const adj = { a: [{ to: "b" }, { to: "c" }, { to: "d" }] };
    const r = boundedWalk<V, E>({
      seeds: [{ id: "a", depth: 0 }],
      canExpand: () => true,
      expand: expanderOver(adj),
      maxDepth: 10,
      maxVertices: 2, // room for a + one neighbour only
      edgeKey,
    });
    expect(r.vertices.size).toBe(2); // a + b
    // edges to c and d are still pushed even though those vertices didn't register
    expect(r.edges.map((e) => e.to).sort()).toEqual(["b", "c", "d"]);
    expect(r.truncated).toBe(true);
  });

  test("edges de-dup by edgeKey; multi-seed subgraphs collapse on shared vertices", () => {
    const adj = { a: [{ to: "x" }], b: [{ to: "x" }] };
    const r = boundedWalk<V, E>({
      seeds: [
        { id: "a", depth: 0 },
        { id: "b", depth: 0 },
        { id: "a", depth: 0 }, // duplicate seed collapses
      ],
      canExpand: () => true,
      expand: expanderOver(adj),
      maxDepth: 10,
      maxVertices: 100,
      edgeKey,
    });
    expect([...r.vertices.keys()].sort()).toEqual(["a", "b", "x"]);
    expect(r.edges).toEqual([
      { from: "a", to: "x" },
      { from: "b", to: "x" },
    ]);
  });

  test("capHits from expand roll up into truncated", () => {
    const adj = { a: [{ to: "b" }, { to: "c" }] };
    const r = boundedWalk<V, E>({
      seeds: [{ id: "a", depth: 0 }],
      canExpand: () => true,
      expand: expanderOver(adj, 1), // cap 1 -> a has 2 out -> capHit
      maxDepth: 10,
      maxVertices: 100,
      edgeKey,
    });
    expect(r.stats.capHits).toBe(1);
    expect(r.truncated).toBe(true);
    expect([...r.vertices.keys()].sort()).toEqual(["a", "b"]); // only first neighbour kept
  });
});
