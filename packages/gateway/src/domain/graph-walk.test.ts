// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../data/schema.js";
import { buildDocumentGraph } from "./DocumentGraphService.js";
import { graphWalk, GraphWalkInputError } from "./graph-walk.js";

type Db = Database.Database;

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

const T = "2025-01-01T00:00:00Z";

function seedDoc(id: string): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'p', ?, ?, ?, 'body', ?, '{}', ?, ?, ?, ?)`,
  ).run(id, `src:${id}`, id, `title-${id}`, `ch-${id}`, T, T, T, T);
}

function seedLink(
  from: string,
  type: string,
  to: string,
  provenanceKind: string | null = null,
): void {
  db.prepare(
    `INSERT INTO document_links (source_doc_id, link_type, raw_target, normalized_target, target_doc_id, resolved_at, created_at, provenance_kind, declared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(from, type, to, to, to, T, T, provenanceKind, T);
}

function seedNearDup(a: string, b: string, jaccard: number): void {
  const [da, dbb] = a < b ? [a, b] : [b, a];
  db.prepare(
    `INSERT INTO near_dup_edges (doc_a, doc_b, algo_version, jaccard, pair_unique_df2, pair_unique_df5, containment_min, gate_family, computed_at)
     VALUES (?, ?, 'v1', ?, 5, 10, 0.9, 'email', 0)`,
  ).run(da, dbb, jaccard);
}

function seedPerson(id: string, name: string): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'test', 0, ?, ?, ?, ?)`,
  ).run(id, name, T, T, T, T);
}

function seedDocPerson(docId: string, personId: string, role: string): void {
  db.prepare(
    `INSERT INTO document_people (document_id, person_id, role, source_id) VALUES (?, ?, ?, ?)`,
  ).run(docId, personId, role, `src:${docId}`);
}

/** A representative neighbourhood: contains + url edges, a near-dup, a person. */
function seedNeighbourhood(): void {
  seedDoc("seed");
  seedDoc("child");
  seedDoc("cited");
  seedDoc("dup");
  seedLink("child", "contains", "seed", "source-declared");
  seedLink("seed", "url", "cited", "content-derived");
  seedNearDup("seed", "dup", 0.85);
  seedPerson("p1", "Maya Reeves");
  seedDocPerson("seed", "p1", "sender");
}

function edgeTypes(g: { edges: { type: string }[] }): string[] {
  return [...new Set(g.edges.map((e) => e.type))].sort();
}
function vertexKinds(g: { vertices: { kind: string }[] }): string[] {
  return [...new Set(g.vertices.map((v) => v.kind))].sort();
}

describe("graphWalk", () => {
  test("with no filters is equivalent to buildDocumentGraph", async () => {
    seedNeighbourhood();
    const direct = buildDocumentGraph(db, ["seed"]);
    const walked = await graphWalk(db, undefined, { start: [{ kind: "document", id: "seed" }] });

    expect(new Set(walked.vertices.map((v) => v.id))).toEqual(
      new Set(direct.vertices.map((v) => v.id)),
    );
    expect(walked.edges.length).toBe(direct.edges.length);
    expect(new Set(walked.edges.map((e) => `${e.from}|${e.to}|${e.type}`))).toEqual(
      new Set(direct.edges.map((e) => `${e.from}|${e.to}|${e.type}`)),
    );
    expect(walked.seeds).toEqual(direct.seeds);
  });

  test("edgeTypes filter restricts traversal to the named types", async () => {
    seedNeighbourhood();
    const g = await graphWalk(db, undefined, {
      start: [{ kind: "document", id: "seed" }],
      edgeTypes: ["contains"],
    });
    expect(edgeTypes(g)).toEqual(["contains"]);
    // url's `cited` doc and the near-dup `dup` are not reachable via contains.
    expect(g.vertices.map((v) => v.id)).toContain("doc:child");
    expect(g.vertices.map((v) => v.id)).not.toContain("doc:cited");
    expect(g.vertices.map((v) => v.id)).not.toContain("doc:dup");
  });

  test("vertexTypes ['document'] drops person vertices and edges", async () => {
    seedNeighbourhood();
    const g = await graphWalk(db, undefined, {
      start: [{ kind: "document", id: "seed" }],
      vertexTypes: ["document"],
    });
    expect(vertexKinds(g)).toEqual(["document"]);
    expect(g.edges.some((e) => e.type === "sender")).toBe(false);
  });

  test("provenanceKinds ['source-declared'] returns only gospel edges", async () => {
    seedNeighbourhood();
    const g = await graphWalk(db, undefined, {
      start: [{ kind: "document", id: "seed" }],
      provenanceKinds: ["source-declared"],
    });
    // contains is source-declared (kept); url is content-derived (dropped);
    // near-duplicate is cross-source-derived (dropped). Person edges are
    // source-declared by type-level default (kept).
    expect(g.edges.some((e) => e.type === "contains")).toBe(true);
    expect(g.edges.some((e) => e.type === "url")).toBe(false);
    expect(g.edges.some((e) => e.type === "near-duplicate")).toBe(false);
    expect(g.edges.some((e) => e.type === "sender")).toBe(true);
  });

  test("provenanceKinds ['content-derived'] keeps url and drops source-declared edges (incl. person)", async () => {
    seedNeighbourhood();
    const g = await graphWalk(db, undefined, {
      start: [{ kind: "document", id: "seed" }],
      provenanceKinds: ["content-derived"],
    });
    expect(g.edges.some((e) => e.type === "url")).toBe(true);
    // contains + person edges are source-declared (type-level default) → dropped.
    expect(g.edges.some((e) => e.type === "contains")).toBe(false);
    expect(g.edges.some((e) => e.type === "sender")).toBe(false);
    expect(g.edges.some((e) => e.type === "near-duplicate")).toBe(false);
  });

  test("minScore drops near-duplicate edges below the threshold", async () => {
    seedNeighbourhood();
    const kept = await graphWalk(db, undefined, {
      start: [{ kind: "document", id: "seed" }],
      minScore: 0.8,
    });
    expect(kept.edges.some((e) => e.type === "near-duplicate")).toBe(true);

    const dropped = await graphWalk(db, undefined, {
      start: [{ kind: "document", id: "seed" }],
      minScore: 0.9,
    });
    expect(dropped.edges.some((e) => e.type === "near-duplicate")).toBe(false);
    // A non-scored edge (url) is unaffected by minScore.
    expect(dropped.edges.some((e) => e.type === "url")).toBe(true);
  });

  test("rejects a non-document seed", async () => {
    seedDoc("seed");
    await expect(
      graphWalk(db, undefined, { start: [{ kind: "person", id: "p1" }] }),
    ).rejects.toBeInstanceOf(GraphWalkInputError);
  });

  test("rejects an empty start", async () => {
    await expect(graphWalk(db, undefined, { start: [] })).rejects.toBeInstanceOf(
      GraphWalkInputError,
    );
  });
});
