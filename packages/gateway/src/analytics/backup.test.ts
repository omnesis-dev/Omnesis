// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Coverage for the DuckDB online-backup path (#57):
 * `AnalyticsDb.backupTo` → `AnalyticsConnectionPool.backupTo` (ATTACH +
 * COPY FROM DATABASE + DETACH through the live pool, serialized with
 * other writes).
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
import { AnalyticsDb } from "../analytics-db.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const DIR = `/tmp/omnesis-test-analytics-backup-${randomUUID()}`;
const SRC = join(DIR, "analytics.db");
const DEST = join(DIR, "copy", "analytics.db");

const testSchema: AnalyticsTableSchema = {
  tableName: "test_metrics",
  displayName: "Test Metrics",
  description: "Test metrics for backup tests",
  columns: [
    { name: "id", type: "VARCHAR", description: "Record ID" },
    { name: "metric_type", type: "VARCHAR", description: "Type of metric" },
    { name: "value", type: "DOUBLE", description: "Metric value" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["metric_type"], keyColumns: ["id", "metric_type"] },
};

let db: AnalyticsDb;

beforeEach(async () => {
  mkdirSync(join(DIR, "copy"), { recursive: true });
  db = new AnalyticsDb(SRC);
  await db.open();
});

afterEach(async () => {
  await db.close();
  rmSync(DIR, { recursive: true, force: true });
});

describe("AnalyticsDb.backupTo", () => {
  test("produces an openable copy carrying schema and rows; source stays live", async () => {
    await db.ensureTable(testSchema, "test-source:local");
    await db.insertRecords(
      "test_metrics",
      [
        { id: "r1", metric_type: "steps", value: 10000 },
        { id: "r2", metric_type: "steps", value: 8500 },
      ],
      ["id"],
    );

    await db.backupTo(DEST);
    expect(existsSync(DEST)).toBe(true);

    // The copy opens as a standalone DuckDB database with the data intact.
    const inst = await DuckDBInstance.create(DEST, { access_mode: "READ_ONLY" });
    try {
      const conn = await inst.connect();
      try {
        const reader = await conn.runAndReadAll("SELECT id, value FROM test_metrics ORDER BY id");
        const rows = reader.getRows() as unknown[][];
        expect(rows.length).toBe(2);
        expect(String(rows[0][0])).toBe("r1");
        expect(Number(rows[0][1])).toBe(10000);
        // The catalog table travels with the copy too.
        const cat = await conn.runAndReadAll("SELECT table_name FROM _analytics_catalog");
        expect((cat.getRows() as unknown[][]).map((r) => String(r[0]))).toContain("test_metrics");
      } finally {
        conn.closeSync();
      }
    } finally {
      inst.closeSync();
    }

    // The live database is still writable after the backup.
    const inserted = await db.insertRecords(
      "test_metrics",
      [{ id: "r3", metric_type: "steps", value: 4200 }],
      ["id"],
    );
    expect(inserted).toBe(1);
  });
});
