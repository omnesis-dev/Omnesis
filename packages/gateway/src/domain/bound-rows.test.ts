// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import {
  analyticsRowKey,
  SAME_ENTITY_EDGE_TYPE,
  type DocumentGraph,
  type GraphVertex,
} from "@omnesis/core";
import { canonicalRowKey, type BoundDocumentBinding } from "../analytics/bound-documents.js";
import { attachBoundRows, type BoundRowResolver } from "./DocumentGraphService.js";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents (id TEXT PRIMARY KEY, external_id TEXT, source_id TEXT, stream_id TEXT NOT NULL DEFAULT '')",
  );
  return db;
}

function docVertex(id: string, sourceId = "strava:athlete1"): GraphVertex {
  return { id: `doc:${id}`, kind: "document", depth: 0, documentId: id, sourceId, title: id };
}

function emptyGraph(vertices: GraphVertex[]): DocumentGraph {
  return {
    seeds: vertices.map((v) => v.id),
    vertices,
    edges: [],
    truncated: false,
    stats: { visited: vertices.length, fanoutCapHits: 0, maxDepthReached: 0, elapsedMs: 0 },
  };
}

const stravaBinding: BoundDocumentBinding = {
  tableName: "strava_activities",
  tableDisplayName: "Strava Activities",
  sourceId: "strava:athlete1",
  primaryKey: ["id"],
  columns: ["id", "distance_m"],
  columnTypes: { id: "BIGINT", distance_m: "DOUBLE" },
  spec: { externalIdColumns: ["id"] },
};

/** Fake resolver backed by an in-memory table keyed the same way getRowsByKeys keys. */
function resolver(table: Record<string, Record<string, unknown>>): BoundRowResolver {
  const rows = new Map(Object.entries(table));
  return {
    async getBoundDocumentBindings() {
      return new Map([["strava", [stravaBinding]]]);
    },
    async getRowsByKeys(_tableName, _keyColumns, keyTuples) {
      const out = new Map<string, Record<string, unknown>>();
      for (const t of keyTuples) {
        const k = canonicalRowKey(t);
        const found = rows.get(k);
        if (found) out.set(k, found);
      }
      return out;
    },
  };
}

describe("attachBoundRows", () => {
  it("synthesizes a same-entity edge + analytics-row vertex for a bound document", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO documents (id, external_id, source_id) VALUES (?,?,?)").run(
      "d1",
      "14269000123",
      "strava:athlete1",
    );
    const graph = emptyGraph([docVertex("d1")]);

    await attachBoundRows(
      db,
      resolver({ [canonicalRowKey(["14269000123"])]: { id: 14269000123, distance_m: 10000 } }),
      graph,
    );

    const rowVid = analyticsRowKey("strava_activities", "14269000123");
    const rowV = graph.vertices.find((v) => v.id === rowVid);
    expect(rowV?.kind).toBe("analytics-row");
    expect(rowV?.tableName).toBe("strava_activities");
    expect(rowV?.tableDisplayName).toBe("Strava Activities");
    expect(rowV?.rowPrimaryKey).toBe("14269000123");
    // Structured PK columns drive the portal "open in SQL" deep link.
    expect(rowV?.rowPrimaryKeyColumns).toEqual([
      { name: "id", value: "14269000123", castType: "BIGINT" },
    ]);
    expect(rowV?.depth).toBe(1);
    expect(rowV?.row).toMatchObject({ distance_m: 10000 });
    expect(graph.edges).toContainEqual({
      from: "doc:d1",
      to: rowVid,
      type: SAME_ENTITY_EDGE_TYPE,
      directed: false,
    });
  });

  it("attaches nothing when the bound row doesn't exist (self-healing)", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO documents (id, external_id, source_id) VALUES (?,?,?)").run(
      "d1",
      "999",
      "strava:athlete1",
    );
    const graph = emptyGraph([docVertex("d1")]);

    await attachBoundRows(db, resolver({}), graph);

    expect(graph.vertices).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it("does not bind documents from a source without a binding", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO documents (id, external_id, source_id) VALUES (?,?,?)").run(
      "d1",
      "x",
      "gmail:me@example.com",
    );
    const graph = emptyGraph([docVertex("d1", "gmail:me@example.com")]);

    await attachBoundRows(db, resolver({ [canonicalRowKey(["x"])]: { id: 1 } }), graph);

    expect(graph.vertices).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });

  it("no-ops when there are no bindings at all", async () => {
    const db = makeDb();
    const graph = emptyGraph([docVertex("d1")]);
    const noBindings: BoundRowResolver = {
      async getBoundDocumentBindings() {
        return new Map();
      },
      async getRowsByKeys() {
        return new Map();
      },
    };
    await attachBoundRows(db, noBindings, graph);
    expect(graph.edges).toHaveLength(0);
  });
});
