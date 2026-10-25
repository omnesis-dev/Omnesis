// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AccountId, SCOPE_ADMIN, SCOPE_READ, SourceType } from "@omnesis/types";
import { AnalyticsDb } from "../../../analytics-db.js";
import { createDatabase } from "../../../db.js";
import { createDevice } from "../../../data/repositories/DeviceRepository.js";
import { createSource } from "../../../data/repositories/SourceRepository.js";
import { createToken } from "../../../data/repositories/TokenRepository.js";
import { createServer } from "../../../server.js";
import { directWriteGate } from "../../../write-gate.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

type Db = ReturnType<typeof createDatabase>;

const TYPE = "events-synth";
const schema: AnalyticsTableSchema = {
  tableName: "events_synth_rows",
  displayName: "Events",
  description: "Invented shared rows",
  columns: [
    { name: "id", type: "VARCHAR", description: "Key" },
    { name: "account", type: "VARCHAR", description: "Owner", nullable: true },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["id"], keyColumns: ["id"] },
  sharedDiscriminatorColumn: "account",
};
const legacySchema: AnalyticsTableSchema = {
  ...schema,
  columns: schema.columns.slice(0, 1),
  sharedDiscriminatorColumn: undefined,
};

let db: Db;
let dbPath: string;
let directory: string;
let analyticsDb: AnalyticsDb;
let app: ReturnType<typeof createServer>;
let adminToken: string;
let sourceId: string;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

beforeEach(async () => {
  dbPath = `/tmp/omnesis-legacy-rows-http-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  directory = mkdtempSync(join(tmpdir(), "omnesis-legacy-rows-"));
  analyticsDb = new AnalyticsDb(join(directory, "analytics.db"));
  await analyticsDb.open();
  const cli = createDevice(db, { name: "Fictional CLI", kind: "cli" });
  adminToken = createToken(db, cli.id, [SCOPE_ADMIN, SCOPE_READ]).token;
  const collector = createDevice(db, { name: "Fictional collector", kind: "collector" });
  sourceId = createSource(db, {
    type: SourceType(TYPE),
    accountId: AccountId("first"),
    deviceId: collector.id,
    config: {},
  }).id;
  // Two accounts wrote the table before it recorded its writer; the first then
  // added rows of its own.
  for (const account of ["first", "second"]) {
    await analyticsDb.ingestPage({
      tableName: schema.tableName,
      schema: legacySchema,
      sourceId: `${TYPE}:${account}`,
      records: account === "second" ? [{ id: "legacy-1" }, { id: "legacy-2" }] : [],
    });
  }
  await analyticsDb.ingestPage({
    tableName: schema.tableName,
    schema,
    sourceId,
    records: [{ id: "mine" }],
  });
  app = createServer(db, dbPath, { writeGate: directWriteGate(db), analyticsDb });
});

afterEach(async () => {
  await analyticsDb.close();
  db.close();
  cleanupDb(dbPath);
  rmSync(directory, { recursive: true, force: true });
});

const request = (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

const rows = async () =>
  (await analyticsDb.executeQuery("SELECT id, account FROM events_synth_rows ORDER BY id")).rows;

describe("/admin/sources/:id/legacy-rows", () => {
  test("reports the rows of the source's shared tables that belong to no account", async () => {
    const response = await request(`/admin/sources/${encodeURIComponent(sourceId)}/legacy-rows`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      tables: [{ tableName: schema.tableName, rows: 2, remaining: 2 }],
    });
  });

  test.each(["claim", "drop"] as const)(
    "settles them on the operator's word: %s",
    async (action) => {
      const response = await request(`/admin/sources/${encodeURIComponent(sourceId)}/legacy-rows`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        action,
        tables: [{ tableName: schema.tableName, rows: 2, remaining: 0 }],
      });
      expect(await rows()).toEqual(
        action === "claim"
          ? [
              ["legacy-1", "first"],
              ["legacy-2", "first"],
              ["mine", "first"],
            ]
          : [["mine", "first"]],
      );
      const settled = await request(`/admin/sources/${encodeURIComponent(sourceId)}/legacy-rows`);
      await expect(settled.json()).resolves.toEqual({ tables: [] });
    },
  );

  test("refuses an unknown action, an unknown source, and a gateway without analytics", async () => {
    const malformed = await request(`/admin/sources/${encodeURIComponent(sourceId)}/legacy-rows`, {
      method: "POST",
      body: JSON.stringify({ action: "shred" }),
    });
    expect(malformed.status).toBe(400);
    const unknown = await request(
      `/admin/sources/${encodeURIComponent(`${TYPE}:nobody`)}/legacy-rows`,
    );
    expect(unknown.status).toBe(404);
    expect(await rows()).toHaveLength(3);
    const bare = createServer(db, dbPath, { writeGate: directWriteGate(db) });
    const unavailable = await bare.request(
      `/admin/sources/${encodeURIComponent(sourceId)}/legacy-rows`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(unavailable.status).toBe(503);
  });
});
