// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
import { collapseDuplicateClusters } from "./graph-collapse-duplicates.js";
import { describe, expect, it } from "vitest";

type Vertex = {
  id: string;
  kind: "document" | "person";
  depth: number;
  documentId?: string;
  title?: string;
  sourceId?: string;
  sourceUrl?: string;
  personId?: string;
  canonicalName?: string;
};

type Edge = {
  from: string;
  to: string;
  type: string;
  directed: boolean;
  jaccard?: number;
};

type Graph = {
  seeds: string[];
  vertices: Vertex[];
  edges: Edge[];
  truncated: boolean;
  stats: { visited: number; fanoutCapHits: number; maxDepthReached: number; elapsedMs: number };
};

function doc(id: string, depth = 0, title = `T-${id}`): Vertex {
  return {
    id: `doc:${id}`,
    kind: "document",
    depth,
    documentId: id,
    title,
    sourceId: `src:${id}`,
    sourceUrl: `https://x/${id}`,
  };
}
function person(id: string, depth = 1): Vertex {
  return {
    id: `person:${id}`,
    kind: "person",
    depth,
    personId: id,
    canonicalName: `Name-${id}`,
  };
}
function edge(from: string, to: string, type: string, directed = true, extra: Partial<Edge> = {}): Edge {
  return { from, to, type, directed, ...extra };
}
function graph(seedDocId: string, vertices: Vertex[], edges: Edge[]): Graph {
  return {
    seeds: [`doc:${seedDocId}`],
    vertices,
    edges,
    truncated: false,
    stats: { visited: vertices.length, fanoutCapHits: 0, maxDepthReached: 0, elapsedMs: 0 },
  };
}

const r = collapseDuplicateClusters as (g: Graph) => Graph;

describe("collapseDuplicateClusters", () => {
  it("leaves a singleton graph untouched", () => {
    const g = graph("a", [doc("a")], []);
    const out = r(g);
    expect(out.vertices).toHaveLength(1);
    expect(out.edges).toEqual([]);
    expect(out.seeds).toEqual(["doc:a"]);
  });

  it("merges a duplicate-content pair into one vertex", () => {
    const g = graph(
      "a",
      [doc("a"), doc("b", 1)],
      [edge("doc:a", "doc:b", "duplicate-content", true)],
    );
    const out = r(g);
    expect(out.vertices).toHaveLength(1);
    expect(out.vertices[0].id).toBe("doc:a"); // seed wins as rep
    expect(out.vertices[0].mergedDocuments).toBeTruthy();
    expect(out.vertices[0].mergedDocuments.map((m) => m.documentId).sort()).toEqual(["a", "b"]);
    expect(out.edges).toEqual([]); // internal cluster edge dropped
  });

  it("merges via near-duplicate edges too", () => {
    const g = graph(
      "a",
      [doc("a"), doc("b", 1)],
      [edge("doc:a", "doc:b", "near-duplicate", false, { jaccard: 0.9 })],
    );
    const out = r(g);
    expect(out.vertices).toHaveLength(1);
    expect(out.edges).toEqual([]);
  });

  it("does NOT merge across a non-collapsible edge type", () => {
    // attachment links two docs but they aren't duplicates.
    const g = graph(
      "a",
      [doc("a"), doc("b", 1)],
      [edge("doc:a", "doc:b", "contains", true)],
    );
    const out = r(g);
    expect(out.vertices).toHaveLength(2);
    expect(out.edges).toHaveLength(1);
  });

  it("collapses a transitive cluster (a-b, b-c) into one vertex", () => {
    const g = graph(
      "a",
      [doc("a"), doc("b", 1), doc("c", 1)],
      [
        edge("doc:a", "doc:b", "duplicate-content", true),
        edge("doc:b", "doc:c", "duplicate-content", true),
      ],
    );
    const out = r(g);
    expect(out.vertices).toHaveLength(1);
    expect(out.vertices[0].id).toBe("doc:a");
    expect(out.vertices[0].mergedDocuments.map((m) => m.documentId).sort()).toEqual(["a", "b", "c"]);
  });

  it("re-points external edges from a cluster member onto the rep", () => {
    // Topology: a — duplicate-content — b, plus b — attachment → c.
    // After collapse, the attachment edge should appear from rep (a) to c.
    const g = graph(
      "a",
      [doc("a"), doc("b", 1), doc("c", 2)],
      [
        edge("doc:a", "doc:b", "duplicate-content", true),
        edge("doc:b", "doc:c", "contains", true),
      ],
    );
    const out = r(g);
    expect(out.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "doc:c"]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ from: "doc:a", to: "doc:c", type: "contains" });
  });

  it("re-points person edges onto the rep and dedupes by type", () => {
    // a ≡ b ≡ c (all duplicates). Each connects to person p with the
    // same role 'sender'. After collapse there's one rep and one edge.
    const g = graph(
      "a",
      [doc("a"), doc("b", 1), doc("c", 1), person("p")],
      [
        edge("doc:a", "doc:b", "duplicate-content", true),
        edge("doc:b", "doc:c", "duplicate-content", true),
        edge("doc:a", "person:p", "sender", false),
        edge("doc:b", "person:p", "sender", false),
        edge("doc:c", "person:p", "sender", false),
      ],
    );
    const out = r(g);
    expect(out.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "person:p"]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ type: "sender", from: "doc:a", to: "person:p" });
  });

  it("keeps person edges separate when they carry different roles", () => {
    const g = graph(
      "a",
      [doc("a"), doc("b", 1), person("p")],
      [
        edge("doc:a", "doc:b", "duplicate-content", true),
        edge("doc:a", "person:p", "sender", false),
        edge("doc:b", "person:p", "recipient", false),
      ],
    );
    const out = r(g);
    expect(out.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "person:p"]);
    expect(out.edges).toHaveLength(2);
    const types = out.edges.map((e) => e.type).sort();
    expect(types).toEqual(["recipient", "sender"]);
  });

  it("re-points the seed when the seed gets merged into a different rep", () => {
    // Force the rep to NOT be the seed by making 'b' the minimum-depth
    // member. Easiest way: seed is at depth 0 by definition (it always
    // wins), so we test the OTHER path — seed not in the cluster.
    const g = graph(
      "a",
      [doc("a"), doc("b", 1), doc("c", 1)],
      [
        edge("doc:a", "doc:b", "contains", true),
        edge("doc:b", "doc:c", "duplicate-content", true),
      ],
    );
    const out = r(g);
    // Seed 'a' is unmerged; rep for {b, c} is the lex-min, which is 'b'.
    expect(out.seeds).toEqual(["doc:a"]);
    expect(out.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "doc:b"]);
    const repB = out.vertices.find((v) => v.id === "doc:b")!;
    expect(repB.mergedDocuments.map((m) => m.documentId).sort()).toEqual(["b", "c"]);
  });

  it("two distinct duplicate clusters stay distinct", () => {
    const g = graph(
      "a",
      [doc("a"), doc("b", 1), doc("c", 1), doc("d", 2)],
      [
        edge("doc:a", "doc:b", "duplicate-content", true),
        edge("doc:c", "doc:d", "duplicate-content", true),
        edge("doc:a", "doc:c", "contains", true),
      ],
    );
    const out = r(g);
    expect(out.vertices).toHaveLength(2);
    expect(out.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "doc:c"]);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ from: "doc:a", to: "doc:c", type: "contains" });
  });

  it("the seed is preferred as the representative when present in a cluster", () => {
    const g = graph(
      "a",
      [doc("a", 0), doc("b", 1), doc("c", 1)],
      [
        edge("doc:b", "doc:c", "duplicate-content", true),
        edge("doc:a", "doc:b", "duplicate-content", true),
      ],
    );
    const out = r(g);
    expect(out.vertices).toHaveLength(1);
    expect(out.vertices[0].id).toBe("doc:a");
    expect(out.seeds).toEqual(["doc:a"]);
  });

  it("a single-member 'cluster' (no duplicates) does not get mergedDocuments", () => {
    const g = graph(
      "a",
      [doc("a"), doc("b", 1)],
      [edge("doc:a", "doc:b", "contains", true)],
    );
    const out = r(g);
    for (const v of out.vertices) {
      expect((v as any).mergedDocuments).toBeUndefined();
    }
  });
});
