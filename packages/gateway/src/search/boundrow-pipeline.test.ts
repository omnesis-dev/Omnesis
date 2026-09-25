// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { randomUUID } from "node:crypto";
import { describe, test, expect, afterAll } from "vitest";
import Database from "better-sqlite3";
import { createIndexDatabase, EMBEDDING_DIM, upsertChunks } from "../indexer/db.js";
import { canonicalRowKey, type BoundRowResolver } from "../analytics/bound-documents.js";
import { SearchPipeline } from "./pipeline.js";
import { closeTempDb } from "./test-utils.js";

const openDbs: Database.Database[] = [];
afterAll(() => openDbs.forEach(closeTempDb));

function indexWithStravaDoc() {
  const dbPath = `/tmp/omnesis-boundrow-idx-${randomUUID()}.db`;
  const db = createIndexDatabase(dbPath);
  openDbs.push(db);
  upsertChunks(db, [
    {
      id: "chunk-strava",
      documentId: "doc-strava-1",
      chunkIndex: 0,
      content: "Morning trail run ten kilometers along the river",
      embedding: new Float32Array(EMBEDDING_DIM).fill(0),
      sourceId: "strava:athlete1",
      documentType: "activity",
      title: "Morning Run",
      sourceCreatedAt: "2026-03-01T07:00:00Z",
    },
  ]);
  return db;
}

/** Gateway DB carrying the columns hydration reads: metadata + external_id. */
function gatewayDbWithDoc() {
  const db = new Database(`/tmp/omnesis-boundrow-gw-${randomUUID()}.db`);
  openDbs.push(db);
  db.exec(
    `CREATE TABLE documents (id TEXT PRIMARY KEY, external_id TEXT, source_id TEXT, metadata TEXT, stream_id TEXT NOT NULL DEFAULT '')`,
  );
  db.prepare("INSERT INTO documents (id, external_id, source_id, metadata) VALUES (?,?,?,?)").run(
    "doc-strava-1",
    "14269000123",
    "strava:athlete1",
    "{}",
  );
  return db;
}

const resolver: BoundRowResolver = {
  async getBoundDocumentBindings() {
    return new Map([
      [
        "strava",
        [
          {
            tableName: "strava_activities",
            tableDisplayName: "Strava Activities",
            sourceId: "strava:athlete1",
            primaryKey: ["id"],
            columns: ["id", "distance_m"],
            columnTypes: { id: "BIGINT", distance_m: "DOUBLE" },
            spec: { externalIdColumns: ["id"] },
          },
        ],
      ],
    ]);
  },
  async getRowsByKeys(_table, _keyColumns, keyTuples) {
    const out = new Map<string, Record<string, unknown>>();
    for (const t of keyTuples) {
      if (canonicalRowKey(t) === canonicalRowKey(["14269000123"])) {
        out.set(canonicalRowKey(t), { id: 14269000123, distance_m: 10000 });
      }
    }
    return out;
  },
};

describe("search boundRow hydration (#450)", () => {
  test("attaches the co-described analytics row when includeBoundRow is set", async () => {
    const pipeline = new SearchPipeline({ indexDb: indexWithStravaDoc() });
    pipeline.setGatewayDb(gatewayDbWithDoc());
    pipeline.setBoundRowResolver(resolver);

    const res = await pipeline.search({ text: "trail run", includeBoundRow: true });
    const hit = res.results.find((r) => r.documentId === "doc-strava-1");
    expect(hit).toBeDefined();
    expect(hit!.boundRow).toEqual({
      tableName: "strava_activities",
      tableDisplayName: "Strava Activities",
      primaryKey: "14269000123",
      row: { id: 14269000123, distance_m: 10000 },
    });
  });

  test("a stream-keyed binding looks the row up in the document's stream", async () => {
    const lookups: { keyColumns: { name: string }[]; tuples: (string | number)[][] }[] = [];
    const streamResolver: BoundRowResolver = {
      async getBoundDocumentBindings() {
        const bindings = await resolver.getBoundDocumentBindings();
        return new Map(
          [...bindings].map(([type, list]) => [
            type,
            list.map((binding) => ({ ...binding, streamKeyed: true })),
          ]),
        );
      },
      async getRowsByKeys(_table, keyColumns, keyTuples) {
        lookups.push({ keyColumns, tuples: keyTuples });
        return new Map([[canonicalRowKey(keyTuples[0]), { id: 14269000123, distance_m: 10000 }]]);
      },
    };
    const gatewayDb = gatewayDbWithDoc();
    gatewayDb
      .prepare("UPDATE documents SET stream_id = ? WHERE id = ?")
      .run("device-a", "doc-strava-1");
    const pipeline = new SearchPipeline({ indexDb: indexWithStravaDoc() });
    pipeline.setGatewayDb(gatewayDb);
    pipeline.setBoundRowResolver(streamResolver);

    const res = await pipeline.search({ text: "trail run", includeBoundRow: true });
    const hit = res.results.find((r) => r.documentId === "doc-strava-1");
    expect(lookups).toHaveLength(1);
    expect(lookups[0].keyColumns.map((c) => c.name)).toEqual(["id", "_stream_id"]);
    expect(lookups[0].tuples).toEqual([["14269000123", "device-a"]]);
    expect(hit!.boundRow?.primaryKey).toBe("14269000123:device-a");
  });

  test("omits boundRow when includeBoundRow is not set", async () => {
    const pipeline = new SearchPipeline({ indexDb: indexWithStravaDoc() });
    pipeline.setGatewayDb(gatewayDbWithDoc());
    pipeline.setBoundRowResolver(resolver);

    const res = await pipeline.search({ text: "trail run" });
    const hit = res.results.find((r) => r.documentId === "doc-strava-1");
    expect(hit).toBeDefined();
    expect(hit!.boundRow).toBeUndefined();
  });
});
