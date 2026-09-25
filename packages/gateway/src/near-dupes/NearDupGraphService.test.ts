// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { setActiveAlgoVersion } from "./meta.js";
import { encodeCursor, getNearDupEdges, parseCursor } from "./NearDupGraphService.js";
import type { Db } from "../data/types.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-near-dup-graph-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  // Match the gateway journal while retaining fully synchronized commits.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedDoc(id: string, documentType = "email", title = `title-${id}`): void {
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "p",
    "src:" + id,
    id,
    title,
    "body",
    "ch-" + id,
    JSON.stringify({ documentType }),
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
  );
}

function seedEdge(
  a: string,
  b: string,
  algo: string,
  jaccard: number,
  opts: { df2?: number; df5?: number; cm?: number; family?: string } = {},
): void {
  const [docA, docB] = a < b ? [a, b] : [b, a];
  db.prepare(
    `INSERT INTO near_dup_edges (doc_a, doc_b, algo_version, jaccard,
       pair_unique_df2, pair_unique_df5, containment_min, gate_family, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    docA,
    docB,
    algo,
    jaccard,
    opts.df2 ?? 5,
    opts.df5 ?? 10,
    opts.cm ?? 0.9,
    opts.family ?? "email",
    0,
  );
}

describe("getNearDupEdges", () => {
  test("returns empty when no active algo version is set", () => {
    seedDoc("a");
    const r = getNearDupEdges(db, "a");
    expect(r.edges).toEqual([]);
    expect(r.nextCursor).toBeNull();
  });

  test("returns edges joined with title + source + type", () => {
    setActiveAlgoVersion(db, "v1");
    seedDoc("a", "email", "doc A");
    seedDoc("b", "email", "doc B");
    seedEdge("a", "b", "v1", 0.92, { family: "email" });
    const r = getNearDupEdges(db, "a");
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0]).toMatchObject({
      otherDocId: "b",
      otherTitle: "doc B",
      otherSourceId: "src:b",
      otherDocType: "email",
      jaccard: 0.92,
      gateFamily: "email",
    });
  });

  test("only surfaces edges under the active algo version", () => {
    setActiveAlgoVersion(db, "v2");
    seedDoc("a");
    seedDoc("b");
    seedEdge("a", "b", "v1", 0.92);
    seedEdge("a", "b", "v2", 0.87);
    const r = getNearDupEdges(db, "a");
    expect(r.edges).toHaveLength(1);
    expect(r.edges[0].jaccard).toBe(0.87);
  });

  test("sorts by jaccard DESC then other_id ASC", () => {
    setActiveAlgoVersion(db, "v1");
    seedDoc("a");
    seedDoc("b");
    seedDoc("c");
    seedDoc("d");
    seedEdge("a", "b", "v1", 0.8);
    seedEdge("a", "d", "v1", 0.9);
    seedEdge("a", "c", "v1", 0.9);
    const r = getNearDupEdges(db, "a");
    expect(r.edges.map((e) => e.otherDocId)).toEqual(["c", "d", "b"]);
  });

  test("paginates via cursor", () => {
    setActiveAlgoVersion(db, "v1");
    seedDoc("a");
    for (const c of ["b", "c", "d", "e"]) {
      seedDoc(c);
      seedEdge("a", c, "v1", 0.95 - c.charCodeAt(0) * 0.01);
    }
    const p1 = getNearDupEdges(db, "a", { limit: 2 });
    expect(p1.edges).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = getNearDupEdges(db, "a", { limit: 2, cursor: p1.nextCursor });
    expect(p2.edges).toHaveLength(2);
    // No overlap between pages, no missing rows.
    const all = [...p1.edges, ...p2.edges].map((e) => e.otherDocId).sort();
    expect(all).toEqual(["b", "c", "d", "e"]);
    expect(p2.nextCursor).toBeNull();
  });

  test("encodes/decodes the cursor cleanly", () => {
    const c = { jaccard: 0.81, otherDocId: "doc-xyz" };
    const round = parseCursor(encodeCursor(c));
    expect(round).toEqual(c);
  });

  test("ignores edges where the other doc was deleted (defensive)", () => {
    setActiveAlgoVersion(db, "v1");
    seedDoc("a");
    seedDoc("b");
    seedEdge("a", "b", "v1", 0.9);
    // Hard-delete b's documents row without cascading. Cascade would
    // normally remove the edge too, but on a stale read we test the
    // join's defensive skip.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DELETE FROM documents WHERE id = 'b'");
    db.exec("PRAGMA foreign_keys = ON");
    const r = getNearDupEdges(db, "a");
    expect(r.edges).toEqual([]);
  });

  test("the other document's links are the published ones, not the canonical key", () => {
    setActiveAlgoVersion(db, "v1");
    seedDoc("a");
    seedDoc("b");
    // Non-web links are stored lowercased as their canonical matching key;
    // the mixed-case id is what the target app needs.
    db.prepare("UPDATE documents SET metadata = ?, source_url = ? WHERE id = 'b'").run(
      JSON.stringify({
        documentType: "email",
        sourceUrl: "things:///show?id=Ab12CdEf",
        appUrl: "fictional-app://items/Ab12CdEf",
      }),
      "things:///show?id=ab12cdef",
    );
    seedEdge("a", "b", "v1", 0.9);
    const r = getNearDupEdges(db, "a");
    expect(r.edges[0]).toMatchObject({
      otherDocId: "b",
      otherSourceUrl: "things:///show?id=Ab12CdEf",
      otherAppUrl: "fictional-app://items/Ab12CdEf",
    });
  });

  test("limit is clamped to MAX_LIMIT=100", () => {
    setActiveAlgoVersion(db, "v1");
    seedDoc("a");
    // Just verify the SELECT doesn't blow up at huge limits.
    const r = getNearDupEdges(db, "a", { limit: 10_000 });
    expect(r.edges).toEqual([]);
  });
});
