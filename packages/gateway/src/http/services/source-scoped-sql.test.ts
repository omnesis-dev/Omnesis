// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test } from "vitest";
import { AnalyticsDb } from "../../analytics-db.js";
import { ScopedSqlDeniedError } from "../../analytics/sandbox-tables.js";
import { AnalyticsService } from "./AnalyticsService.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

let directory: string;
let db: AnalyticsDb;
let service: AnalyticsService;
const sourceId = "strava-activities:fixture";
const schema: AnalyticsTableSchema = {
  tableName: "strava_activities",
  displayName: "Fixture activities",
  description: "Invented rows for the provider's enrichment query forms",
  columns: [
    ...["id", "summary_hash", "gear_id", "gear_brand", "gear_model", "gear_name"].map((name) => ({
      name,
      type: "VARCHAR" as const,
      description: name,
      nullable: name !== "id",
    })),
    ...[
      "start_time",
      "detail_fetched_at",
      "social_fetched_at",
      "zones_fetched_at",
      "streams_fetched_at",
    ].map((name) => ({ name, type: "TIMESTAMPTZ" as const, description: name, nullable: true })),
    { name: "zones_unavailable", type: "BOOLEAN", description: "Zones unavailable" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "start_time",
  record: { titleColumns: ["id"], keyColumns: ["id", "start_time"] },
};

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "omnesis-scoped-sql-"));
  db = new AnalyticsDb(join(directory, "analytics.db"));
  await db.open();
  await db.ensureTable(schema, sourceId);
  await db.insertRecords(
    schema.tableName,
    [
      {
        id: "42",
        summary_hash: "fixture-hash",
        gear_id: "gear-one",
        start_time: "2030-01-01T00:00:00Z",
        zones_unavailable: false,
      },
    ],
    ["id"],
  );
  await db.ensureTable({ ...schema, tableName: "other_activities" }, "other:fixture");
  service = new AnalyticsService(db, undefined, false);
});

afterEach(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("the source-scoped service refuses alternate paths to another table and internal ledgers", async () => {
  for (const sql of [
    "SELECT * FROM query_table('other_activities')",
    "SELECT * FROM query('SELECT * FROM other_activities')",
    "DESCRIBE other_activities",
    'SELECT * FROM "OTHER_ACTIVITIES"',
    'SELECT * FROM "MAIN"."OTHER_ACTIVITIES"',
    'SELECT * FROM "INFORMATION_SCHEMA"."TABLES"',
    "SELECT * FROM _analytics_absences",
    "PREPARE peek AS SELECT * FROM other_activities",
    "EXECUTE peek",
    "SELECT 1; SELECT * FROM other_activities",
  ]) {
    await expect(service.sql(sql, undefined, sourceId), sql).rejects.toThrow();
  }
  await expect(
    service.sql("DESCRIBE other_activities", undefined, sourceId),
  ).rejects.toBeInstanceOf(ScopedSqlDeniedError);
  expect((await service.sql("SELECT id FROM strava_activities", undefined, sourceId)).rows).toEqual(
    [["42"]],
  );
});

test("quoted upper-case identifiers bind like DuckDB inside the source scope", async () => {
  expect(
    (await service.sql('SELECT "ID" FROM "STRAVA_ACTIVITIES"', undefined, sourceId)).rows,
  ).toEqual([["42"]]);
  expect(
    (await service.sql('SELECT "ID" FROM "MAIN"."STRAVA_ACTIVITIES"', undefined, sourceId)).rows,
  ).toEqual([["42"]]);
  expect(
    (
      await service.sql(
        'SELECT "ID" FROM "OMNESIS_ANALYTICS"."MAIN"."STRAVA_ACTIVITIES"',
        undefined,
        sourceId,
      )
    ).rows,
  ).toEqual([["42"]]);
});

test("Strava enrichment and athlete-refresh query forms remain executable", async () => {
  // These are the emitted forms in enrichment.ts, activities.ts and
  // athlete-refresh.ts, including tier predicates, row hydration and gear lookup.
  for (const sql of [
    "SELECT id, summary_hash FROM strava_activities WHERE id IN ('42')",
    "SELECT * FROM strava_activities WHERE id IN ('42')",
    "SELECT DISTINCT gear_id FROM strava_activities WHERE gear_id IS NOT NULL",
    "SELECT * FROM strava_activities WHERE gear_id IN ('gear-one') AND (gear_brand IS NULL OR gear_model IS NULL OR gear_name IS NULL)",
    "SELECT count(*) AS n FROM strava_activities WHERE zones_unavailable = TRUE",
    "SELECT * FROM strava_activities WHERE zones_unavailable = TRUE LIMIT 5000",
    ...["detail", "social", "zones", "streams"].flatMap((tier) => {
      const where = `${tier}_fetched_at IS NULL${tier === "zones" ? " AND (zones_unavailable IS NULL OR zones_unavailable = FALSE)" : ""}`;
      return [
        `SELECT * FROM strava_activities WHERE ${where} ORDER BY start_time DESC LIMIT 10`,
        `SELECT count(*) AS n FROM strava_activities WHERE ${where}`,
      ];
    }),
  ]) {
    const result = await service.sql(sql, undefined, sourceId);
    expect(result.columns.length, sql).toBeGreaterThan(0);
  }
});
