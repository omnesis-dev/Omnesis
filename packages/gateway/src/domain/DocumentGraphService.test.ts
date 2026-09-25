// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { resetUrlGraphRoles, setUrlGraphRoles } from "../url-graph-roles.js";
import { buildDocumentGraph, expandOneHop } from "./DocumentGraphService.js";
import type { Db } from "../data/types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-doc-graph-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  // Match the gateway journal while retaining fully synchronized commits.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  runSchemaSetup(db);
  runMigrations(db);
  // Process-level url-hub registry: `web` is a gateway built-in;
  // chrome-bookmarks / browser-history are collector-declared,
  // derived from each source's `urlHub: true` field. Seed the collector
  // layer so the hub-filter test exercises the built-in and the
  // collector-declared branches in one go.
  setUrlGraphRoles("test", ["chrome-bookmarks", "browser-history"], [], []);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  resetUrlGraphRoles();
});

// ─── Seeding helpers ──────────────────────────────────────────────────────

function seedDoc(
  id: string,
  sourceId = `src:${id}`,
  title = `title-${id}`,
  createdAt = "2025-01-01T00:00:00Z",
): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "p",
    sourceId,
    id,
    title,
    "body",
    `ch-${id}`,
    JSON.stringify({ sourceUrl: `https://example.test/${id}` }),
    createdAt,
    createdAt,
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    // The canonical matching key differs from the published link, so the
    // vertex tests below prove clients receive the openable original.
    `https://example.test/canonical/${id}`,
  );
}

function seedLink(sourceDocId: string, linkType: string, targetDocId: string | null): void {
  db.prepare(
    `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target,
        target_doc_id, resolved_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourceDocId,
    linkType,
    targetDocId ?? `unresolved-${Math.random()}`,
    targetDocId ?? `unresolved-${Math.random()}`,
    targetDocId,
    targetDocId ? "2025-01-01T00:00:00Z" : null,
    "2025-01-01T00:00:00Z",
  );
}

function seedNearDupEdge(a: string, b: string, jaccard = 0.9): void {
  const [docA, docB] = a < b ? [a, b] : [b, a];
  db.prepare(
    `INSERT INTO near_dup_edges (doc_a, doc_b, algo_version, jaccard,
       pair_unique_df2, pair_unique_df5, containment_min, gate_family, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(docA, docB, "v1", jaccard, 5, 10, 0.9, "email", 0);
}

function seedPerson(
  id: string,
  name: string,
  opts: { isSelf?: boolean; mergedInto?: string } = {},
): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, merged_into,
        first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    "test",
    opts.isSelf ? 1 : 0,
    opts.mergedInto ?? null,
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
  );
}

function seedDocPerson(docId: string, personId: string, role: string): void {
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, ?)`,
  ).run(docId, personId, role, `src:${docId}`);
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("buildDocumentGraph", () => {
  test("returns just the seed when the document has no edges", () => {
    seedDoc("a");
    const g = buildDocumentGraph(db, ["a"]);
    expect(g.seeds).toEqual(["doc:a"]);
    expect(g.vertices).toHaveLength(1);
    expect(g.vertices[0]).toMatchObject({ id: "doc:a", kind: "document", depth: 0 });
    expect(g.edges).toEqual([]);
    expect(g.truncated).toBe(false);
  });

  test("throws when the seed document does not exist", () => {
    expect(() => buildDocumentGraph(db, ["missing"])).toThrow(/seed not found: missing/);
  });

  test("throws when called with an empty seeds array", () => {
    expect(() => buildDocumentGraph(db, [])).toThrow(/no seeds/);
  });

  test("throws when ANY seed is missing in a multi-seed call", () => {
    seedDoc("a");
    expect(() => buildDocumentGraph(db, ["a", "missing"])).toThrow(/seed not found: missing/);
  });

  test("walks outbound document_links as directed edges", () => {
    seedDoc("a");
    seedDoc("b");
    seedLink("a", "contains", "b");
    const g = buildDocumentGraph(db, ["a"]);
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "doc:b"]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({
      from: "doc:a",
      to: "doc:b",
      type: "contains",
      directed: true,
    });
  });

  test("walks inbound document_links as directed edges (arrow points TO the seed)", () => {
    seedDoc("a");
    seedDoc("parent");
    seedLink("parent", "part-of-thread", "a");
    const g = buildDocumentGraph(db, ["a"]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({
      from: "doc:parent",
      to: "doc:a",
      type: "part-of-thread",
      directed: true,
    });
  });

  test("skips unresolved (NULL target_doc_id) outbound links", () => {
    seedDoc("a");
    seedLink("a", "url", null);
    const g = buildDocumentGraph(db, ["a"]);
    expect(g.vertices).toHaveLength(1);
    expect(g.edges).toEqual([]);
  });

  test("skips `url` edges where the other endpoint is from a URL-hub source", () => {
    // web / chrome-bookmarks / browser-history are
    // URL-link hubs that accumulate referential edges with no structural
    // story. Letting BFS pivot through them explodes the neighbourhood.
    // Structural URL edges between real sources still walk; only the
    // hub-source endpoints get filtered out.
    seedDoc("seed", "gmail:self");
    seedDoc("page", "web"); // bare source id
    seedDoc("bookmark", "chrome-bookmarks:default"); // accounted source id
    seedDoc("history", "browser-history:safari"); // accounted source id
    seedDoc("drive", "google-drive:self"); // real source
    seedLink("seed", "url", "page"); // outbound url → hub: SKIP
    seedLink("seed", "url", "bookmark"); // outbound url → hub: SKIP
    seedLink("seed", "url", "drive"); // outbound url → real: KEEP
    seedLink("page", "url", "seed"); // inbound url ← hub: SKIP
    seedLink("history", "url", "seed"); // inbound url ← hub: SKIP
    const g = buildDocumentGraph(db, ["seed"]);
    // Only the structural URL edge to Drive walks; every hub-source
    // edge (in + out) is dropped.
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:drive", "doc:seed"]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({
      from: "doc:seed",
      to: "doc:drive",
      type: "url",
      directed: true,
    });
  });

  test("hub set is read from the registry — an arbitrary source becomes a hub when added", () => {
    // Lock in the dynamic dispatch: nothing about the SQL knows about
    // specific source names — whatever `setUrlGraphRoles` puts in the
    // registry is what gets filtered. This is the property that lets
    // a new bookmark-style source ship without editing this file.
    setUrlGraphRoles("test", ["my-custom-hub"], [], []);
    seedDoc("seed", "gmail:self");
    seedDoc("custom", "my-custom-hub:acct"); // newly declared hub
    seedDoc("page", "web"); // gateway built-in hub
    seedDoc("real", "gmail:other"); // not a hub
    seedLink("seed", "url", "custom"); // SKIP — collector-declared
    seedLink("seed", "url", "page"); // SKIP — built-in
    seedLink("seed", "url", "real"); // KEEP
    const g = buildDocumentGraph(db, ["seed"]);
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:real", "doc:seed"]);
  });

  test("collector-declared layer cleared still leaves the `web` built-in hub", () => {
    // Reset the collector-declared layer (no collector push has happened).
    // The gateway built-in (`web`) still filters; a non-hub `url` edge
    // walks normally. Guards the empty-collector-declared branch.
    resetUrlGraphRoles();
    seedDoc("seed", "gmail:self");
    seedDoc("other", "gmail:other");
    seedLink("seed", "url", "other");
    const g = buildDocumentGraph(db, ["seed"]);
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:other", "doc:seed"]);
  });

  test("walks near-duplicate edges as undirected, carrying jaccard", () => {
    seedDoc("a");
    seedDoc("b");
    seedNearDupEdge("a", "b", 0.87);
    const g = buildDocumentGraph(db, ["a"]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({
      type: "near-duplicate",
      directed: false,
      jaccard: 0.87,
    });
    expect([g.edges[0]!.from, g.edges[0]!.to].sort()).toEqual(["doc:a", "doc:b"]);
  });

  test("walks document_people as person vertices, role becomes the edge type", () => {
    seedDoc("a");
    seedPerson("p1", "Alice");
    seedDocPerson("a", "p1", "sender");
    const g = buildDocumentGraph(db, ["a"]);
    expect(g.vertices.find((v) => v.kind === "person")).toMatchObject({
      id: "person:p1",
      kind: "person",
      personId: "p1",
      canonicalName: "Alice",
      isSelf: false,
    });
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ type: "sender", directed: false });
  });

  test("dereferences merged person to canonical so equivalents collapse to one vertex", () => {
    seedDoc("a");
    seedPerson("canon", "Alice");
    seedPerson("loser", "A. Z.", { mergedInto: "canon" });
    seedDocPerson("a", "canon", "sender");
    seedDocPerson("a", "loser", "recipient");
    const g = buildDocumentGraph(db, ["a"]);
    const personVertices = g.vertices.filter((v) => v.kind === "person");
    expect(personVertices).toHaveLength(1);
    expect(personVertices[0]!.personId).toBe("canon");
    // Both original roles surface as separate edges to the canonical.
    const roles = g.edges
      .filter((e) => e.to === "person:canon" || e.from === "person:canon")
      .map((e) => e.type);
    expect(roles.sort()).toEqual(["recipient", "sender"]);
  });

  test("people are terminal — the walker does NOT hop through a person to other docs", () => {
    // Topology: a — sender — p — recipient — b. The only connection
    // between the two docs is through the person. People are terminal,
    // so the walk should stop at p and never reach b.
    seedDoc("a");
    seedDoc("b");
    seedPerson("p", "Alice");
    seedDocPerson("a", "p", "sender");
    seedDocPerson("b", "p", "recipient");
    const g = buildDocumentGraph(db, ["a"], { depth: 5 });
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "person:p"]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ type: "sender" });
  });

  test("a person reachable from two discovered docs gets one vertex + two role edges", () => {
    // a — sender — p, plus a — attachment → b — recipient — p.
    // From seed a we discover p (terminal) AND walk a→b via the
    // attachment. Expanding b discovers p again — same vertex, new
    // edge. Final: 3 vertices, 3 edges.
    seedDoc("a");
    seedDoc("b");
    seedPerson("p", "Alice");
    seedDocPerson("a", "p", "sender");
    seedDocPerson("b", "p", "recipient");
    seedLink("a", "contains", "b");
    const g = buildDocumentGraph(db, ["a"], { depth: 5 });
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "doc:b", "person:p"]);
    expect(g.edges).toHaveLength(3);
    const types = g.edges.map((e) => e.type).sort();
    expect(types).toEqual(["contains", "recipient", "sender"]);
  });

  test("type-agnostic: an unfamiliar link_type still surfaces as an edge", () => {
    // Adding a new edge type in the future should not need code changes
    // in the walker — the type string flows straight through.
    seedDoc("a");
    seedDoc("b");
    seedLink("a", "future-edge-type-xyz", "b");
    const g = buildDocumentGraph(db, ["a"]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]!.type).toBe("future-edge-type-xyz");
  });

  test("respects depth — vertices at the frontier are included but not expanded", () => {
    // a → b → c. depth=1 reaches b but does not expand b.
    seedDoc("a");
    seedDoc("b");
    seedDoc("c");
    seedLink("a", "contains", "b");
    seedLink("b", "contains", "c");
    const g = buildDocumentGraph(db, ["a"], { depth: 1 });
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "doc:b"]);
    expect(g.edges).toHaveLength(1);
    // b is at the frontier; vertex was discovered at depth 1.
    expect(g.vertices.find((v) => v.id === "doc:b")!.depth).toBe(1);
  });

  test("default depth is 10", () => {
    // Chain a→b→c→...→k (10 hops). depth defaults to 10 → reach k.
    const chain = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];
    for (const id of chain) seedDoc(id);
    for (let i = 0; i < chain.length - 1; i++) {
      seedLink(chain[i]!, "contains", chain[i + 1]!);
    }
    const g = buildDocumentGraph(db, ["a"]);
    expect(g.vertices.map((v) => v.id).sort()).toEqual(chain.map((id) => `doc:${id}`).sort());
  });

  test("fanout cap collapses huge components and sets truncated=true", () => {
    // a has 100 outbound attachments. fanoutCap=5 → 5 walked, truncated.
    seedDoc("a");
    for (let i = 0; i < 100; i++) {
      const id = `b${i}`;
      seedDoc(id);
      seedLink("a", "contains", id);
    }
    const g = buildDocumentGraph(db, ["a"], { fanoutCap: 5 });
    const docCount = g.vertices.filter((v) => v.kind === "document").length;
    expect(docCount).toBe(1 + 5); // seed + 5 fanout
    expect(g.truncated).toBe(true);
    expect(g.stats.fanoutCapHits).toBeGreaterThanOrEqual(1);
  });

  test("global maxVertices cap stops the walk cleanly", () => {
    // Linear chain longer than the cap.
    const chain = Array.from({ length: 30 }, (_, i) => `n${i}`);
    for (const id of chain) seedDoc(id);
    for (let i = 0; i < chain.length - 1; i++) {
      seedLink(chain[i]!, "contains", chain[i + 1]!);
    }
    const g = buildDocumentGraph(db, [chain[0]!], {
      depth: 15,
      maxVertices: 10,
    });
    expect(g.vertices.length).toBeLessThanOrEqual(10);
    expect(g.truncated).toBe(true);
  });

  test("dedupes edges encountered from both endpoints", () => {
    // a—near-dup—b. Walked from a → finds b. b then expands and finds
    // the same edge back. Should not double-report.
    seedDoc("a");
    seedDoc("b");
    seedNearDupEdge("a", "b", 0.9);
    const g = buildDocumentGraph(db, ["a"], { depth: 3 });
    expect(g.edges).toHaveLength(1);
  });

  test("terminates on a directed cycle (a→b→c→a) — vertex dedup prevents re-expansion", () => {
    seedDoc("a");
    seedDoc("b");
    seedDoc("c");
    seedLink("a", "contains", "b");
    seedLink("b", "contains", "c");
    seedLink("c", "contains", "a");
    const g = buildDocumentGraph(db, ["a"], { depth: 10 });
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "doc:b", "doc:c"]);
    // Three distinct directed edges, one per cycle hop. The closing
    // c→a edge is registered exactly once (not duplicated by the
    // inbound discovery from a's side).
    expect(g.edges).toHaveLength(3);
    const edgeKeys = g.edges.map((e) => `${e.from}→${e.to}`).sort();
    expect(edgeKeys).toEqual(["doc:a→doc:b", "doc:b→doc:c", "doc:c→doc:a"]);
  });

  test("terminates on a person↔doc cycle through merged equivalence class", () => {
    // a has person p, who is also on b, which links back to a. The
    // walker should close the cycle without re-expanding any vertex.
    seedDoc("a");
    seedDoc("b");
    seedPerson("p", "Alice");
    seedDocPerson("a", "p", "sender");
    seedDocPerson("b", "p", "recipient");
    seedLink("b", "contains", "a");
    const g = buildDocumentGraph(db, ["a"], { depth: 10 });
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "doc:b", "person:p"]);
    // Two role edges (a—p sender, b—p recipient) + one directed link
    // edge (b→a attachment). All three are present exactly once.
    expect(g.edges).toHaveLength(3);
  });

  test("handles a self-loop without infinite recursion", () => {
    seedDoc("a");
    seedLink("a", "contains", "a");
    const g = buildDocumentGraph(db, ["a"], { depth: 10 });
    expect(g.vertices).toHaveLength(1);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({ from: "doc:a", to: "doc:a", type: "contains" });
  });

  test("dedupes the same directed edge seen from both endpoints during BFS", () => {
    // a—attachment—>b. At depth 2 we expand a (find outbound a→b) AND
    // then b (find inbound a→b). The walker must collapse those two
    // discoveries to a single edge row.
    seedDoc("a");
    seedDoc("b");
    seedLink("a", "contains", "b");
    const g = buildDocumentGraph(db, ["a"], { depth: 3 });
    expect(g.edges).toHaveLength(1);
  });

  test("clamps depth out-of-range to [1, 15]", () => {
    seedDoc("a");
    seedDoc("b");
    seedLink("a", "contains", "b");

    const tooLow = buildDocumentGraph(db, ["a"], { depth: 0 });
    expect(tooLow.vertices.length).toBeGreaterThanOrEqual(2);

    const tooHigh = buildDocumentGraph(db, ["a"], { depth: 9999 });
    expect(tooHigh.vertices.length).toBeGreaterThanOrEqual(2);
  });

  test("vertices carry depth = BFS distance from the seed", () => {
    seedDoc("a");
    seedDoc("b");
    seedDoc("c");
    seedLink("a", "contains", "b");
    seedLink("b", "contains", "c");
    const g = buildDocumentGraph(db, ["a"], { depth: 5 });
    const v = (id: string) => g.vertices.find((x) => x.id === id)!;
    expect(v("doc:a").depth).toBe(0);
    expect(v("doc:b").depth).toBe(1);
    expect(v("doc:c").depth).toBe(2);
  });

  test("document vertex carries title, sourceId, sourceUrl", () => {
    seedDoc("a", "gmail:me@x.com", "Q3 deck");
    const g = buildDocumentGraph(db, ["a"]);
    expect(g.vertices[0]).toMatchObject({
      title: "Q3 deck",
      sourceId: "gmail:me@x.com",
      sourceUrl: "https://example.test/a",
    });
  });

  test("returns elapsedMs and other stats", () => {
    seedDoc("a");
    const g = buildDocumentGraph(db, ["a"]);
    expect(g.stats.visited).toBe(1);
    expect(g.stats.maxDepthReached).toBe(0);
    expect(g.stats.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  // ─── Multi-seed walks ──────────────────────────────────────────────────

  test("two disjoint seeds produce both clusters in one graph", () => {
    // a is alone in its cluster; b—attachment—c lives in a separate
    // cluster. Seeding from both gives 3 docs, 1 edge, no edge between
    // the clusters.
    seedDoc("a");
    seedDoc("b");
    seedDoc("c");
    seedLink("b", "contains", "c");
    const g = buildDocumentGraph(db, ["a", "b"]);
    expect(g.seeds).toEqual(["doc:a", "doc:b"]);
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "doc:b", "doc:c"]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({
      from: "doc:b",
      to: "doc:c",
      type: "contains",
    });
  });

  test("two seeds connected through a shared neighbour merge into one cluster", () => {
    // a—attachment—c and b—attachment—c. Both seeds reach c; c appears
    // exactly once and both edges are emitted.
    seedDoc("a");
    seedDoc("b");
    seedDoc("c");
    seedLink("a", "contains", "c");
    seedLink("b", "contains", "c");
    const g = buildDocumentGraph(db, ["a", "b"]);
    expect(g.seeds).toEqual(["doc:a", "doc:b"]);
    expect(g.vertices.map((v) => v.id).sort()).toEqual(["doc:a", "doc:b", "doc:c"]);
    expect(g.edges).toHaveLength(2);
    const edgeKeys = g.edges.map((e) => `${e.from}→${e.to}`).sort();
    expect(edgeKeys).toEqual(["doc:a→doc:c", "doc:b→doc:c"]);
  });

  test("both seeds are registered at depth 0", () => {
    seedDoc("a");
    seedDoc("b");
    const g = buildDocumentGraph(db, ["a", "b"]);
    const byId = new Map(g.vertices.map((v) => [v.id, v]));
    expect(byId.get("doc:a")!.depth).toBe(0);
    expect(byId.get("doc:b")!.depth).toBe(0);
  });

  test("preserves seed input order in result.seeds", () => {
    seedDoc("a");
    seedDoc("b");
    seedDoc("c");
    const g = buildDocumentGraph(db, ["c", "a", "b"]);
    expect(g.seeds).toEqual(["doc:c", "doc:a", "doc:b"]);
  });

  test("duplicate seed ids collapse to one vertex but keep input order", () => {
    seedDoc("a");
    seedDoc("b");
    const g = buildDocumentGraph(db, ["a", "b", "a"]);
    // Vertex set has each doc once; the seeds array dedupes too.
    expect(g.seeds).toEqual(["doc:a", "doc:b"]);
    expect(g.vertices.filter((v) => v.id === "doc:a")).toHaveLength(1);
  });

  test("three-seed walk reaches every adjacent neighbour", () => {
    // Three disjoint clusters: a—att—a2, b—att—b2, c—att—c2.
    for (const id of ["a", "a2", "b", "b2", "c", "c2"]) seedDoc(id);
    seedLink("a", "contains", "a2");
    seedLink("b", "contains", "b2");
    seedLink("c", "contains", "c2");
    const g = buildDocumentGraph(db, ["a", "b", "c"]);
    expect(g.vertices.map((v) => v.id).sort()).toEqual([
      "doc:a",
      "doc:a2",
      "doc:b",
      "doc:b2",
      "doc:c",
      "doc:c2",
    ]);
    expect(g.edges).toHaveLength(3);
  });
});

// ─── expandOneHop: the shared 1-hop adjacency primitive ──────────────────────

describe("expandOneHop", () => {
  test("returns an empty list for a document with no edges", () => {
    seedDoc("lonely");
    expect(expandOneHop(db, "lonely").neighbors).toEqual([]);
  });

  test("returns [] (not a throw) when the seed does not exist", () => {
    expect(expandOneHop(db, "ghost").neighbors).toEqual([]);
  });

  test("ranks neighbours most-structural-first: attachment → thread → near-dup → url", () => {
    seedDoc("seed");
    seedDoc("att");
    seedDoc("reply");
    seedDoc("dup");
    seedDoc("link");
    seedLink("seed", "contains", "att");
    seedLink("seed", "part-of-thread", "reply");
    seedNearDupEdge("seed", "dup", 0.9);
    seedLink("seed", "url", "link");

    const { neighbors: n } = expandOneHop(db, "seed");
    expect(n.map((x) => x.documentId)).toEqual(["att", "reply", "dup", "link"]);
    expect(n.map((x) => x.edgeType)).toEqual([
      "contains",
      "part-of-thread",
      "near-duplicate",
      "url",
    ]);
  });

  test("labels direction: outbound / inbound for directed links, peer for near-dup", () => {
    seedDoc("seed");
    seedDoc("child");
    seedDoc("parent");
    seedDoc("twin");
    seedLink("seed", "contains", "child"); // seed → child: outbound
    seedLink("parent", "part-of-thread", "seed"); // parent → seed: inbound
    seedNearDupEdge("seed", "twin", 0.8); // symmetric: peer

    const byId = new Map(expandOneHop(db, "seed").neighbors.map((x) => [x.documentId, x]));
    expect(byId.get("child")?.direction).toBe("outbound");
    expect(byId.get("parent")?.direction).toBe("inbound");
    expect(byId.get("twin")?.direction).toBe("peer");
  });

  test("excludes people — a person is terminal, never a document neighbour (super-node guard)", () => {
    // The whole reason a spouse / manager doc can't drag in unrelated
    // documents: people are never traversed through, and never surface as
    // a one-hop neighbour.
    seedDoc("note");
    seedPerson("p1", "Maya Reeves");
    seedDocPerson("note", "p1", "sender");
    expect(expandOneHop(db, "note").neighbors).toEqual([]);
  });

  test("collapses parallel edges to one neighbour, keeping the highest-priority edge", () => {
    // `both` is reachable as BOTH an attachment and a near-duplicate;
    // the attachment (more structural) wins and the neighbour appears once.
    seedDoc("seed");
    seedDoc("both");
    seedLink("seed", "contains", "both");
    seedNearDupEdge("seed", "both", 0.7);

    const { neighbors: n } = expandOneHop(db, "seed");
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ documentId: "both", edgeType: "contains" });
  });

  test("throttles a mega-cluster: 10 same-type neighbours are capped well below 10", () => {
    // A 200-message thread or a hub document must not flood a one-hop
    // expansion. The per-category BFS cap holds the frontier to a handful
    // regardless of the requested fanout.
    seedDoc("hub");
    for (let i = 0; i < 10; i++) {
      seedDoc(`att${i}`);
      seedLink("hub", "contains", `att${i}`);
    }
    const { neighbors: all, truncated } = expandOneHop(db, "hub");
    expect(all.length).toBeLessThanOrEqual(6);
    expect(all.length).toBeGreaterThan(0);
    // 10 neighbours but ≤6 returned → the agent must be told there is more.
    expect(truncated).toBe(true);
  });

  test("honours the fanout option, slicing after ranking", () => {
    seedDoc("seed");
    seedDoc("att");
    seedDoc("reply");
    seedDoc("dup");
    seedLink("seed", "contains", "att");
    seedLink("seed", "part-of-thread", "reply");
    seedNearDupEdge("seed", "dup", 0.9);

    const { neighbors: n } = expandOneHop(db, "seed", { fanout: 2 });
    expect(n).toHaveLength(2);
    // The two kept are the two most-structural (attachment, thread).
    expect(n.map((x) => x.documentId)).toEqual(["att", "reply"]);
  });

  test("inherits the url-hub filter — a url edge to a hub source never surfaces", () => {
    seedDoc("seed", "gmail:self");
    seedDoc("hubdoc", "browser-history:safari");
    seedLink("seed", "url", "hubdoc");
    expect(expandOneHop(db, "seed").neighbors).toEqual([]);
  });

  test("carries the neighbour's presentation fields for DocRef shaping", () => {
    seedDoc("seed");
    seedDoc("att", "google-drive:self", "Q4 deck.pdf");
    seedLink("seed", "contains", "att");
    const {
      neighbors: [n],
    } = expandOneHop(db, "seed");
    expect(n).toMatchObject({
      documentId: "att",
      title: "Q4 deck.pdf",
      sourceId: "google-drive:self",
      sourceUrl: "https://example.test/att",
    });
  });

  test("breaks same-edge-type ties by recency — newest sourceCreatedAt first", () => {
    seedDoc("seed");
    // Three attachments of the SAME edge type, distinct created-at times.
    seedDoc("att-old", "src:att-old", "title-att-old", "2025-01-01T00:00:00Z");
    seedDoc("att-new", "src:att-new", "title-att-new", "2025-03-01T00:00:00Z");
    seedDoc("att-mid", "src:att-mid", "title-att-mid", "2025-02-01T00:00:00Z");
    seedLink("seed", "contains", "att-old");
    seedLink("seed", "contains", "att-new");
    seedLink("seed", "contains", "att-mid");

    const { neighbors: n } = expandOneHop(db, "seed");
    expect(n.map((x) => x.documentId)).toEqual(["att-new", "att-mid", "att-old"]);
  });

  test("falls back to documentId order when type and timestamp both tie", () => {
    seedDoc("seed");
    seedDoc("att-b", "src:att-b", "title-att-b", "2025-05-05T00:00:00Z");
    seedDoc("att-a", "src:att-a", "title-att-a", "2025-05-05T00:00:00Z");
    seedLink("seed", "contains", "att-b");
    seedLink("seed", "contains", "att-a");

    const { neighbors: n } = expandOneHop(db, "seed");
    expect(n.map((x) => x.documentId)).toEqual(["att-a", "att-b"]);
  });

  test("when a thread exceeds the per-category cap, keeps the NEWEST members, not the oldest", () => {
    // The flat-sale failure in miniature: a long thread whose latest
    // message must not be dropped by the cap in favour of earlier-ingested
    // ones. The cap orders by neighbour recency, so the newest survive.
    seedDoc("hub");
    for (let i = 1; i <= 12; i++) {
      const day = String(i).padStart(2, "0");
      seedDoc(`msg-${day}`, "gmail:self", `msg ${day}`, `2025-06-${day}T00:00:00Z`);
      seedLink("hub", "part-of-thread", `msg-${day}`);
    }
    const { neighbors, truncated } = expandOneHop(db, "hub", { fanout: 8 });
    expect(truncated).toBe(true); // 12 members, only the cap's worth returned
    const ids = neighbors.map((x) => x.documentId);
    expect(ids[0]).toBe("msg-12"); // newest first
    expect(ids).toContain("msg-12"); // the latest reply survives the cap
    expect(ids).not.toContain("msg-01"); // the oldest is the one dropped
  });

  test("truncated is false when every neighbour fits", () => {
    seedDoc("seed");
    seedDoc("att");
    seedLink("seed", "contains", "att");
    const { neighbors, truncated } = expandOneHop(db, "seed");
    expect(neighbors).toHaveLength(1);
    expect(truncated).toBe(false);
  });
});
