// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { unlinkSync, existsSync } from "node:fs";
import { DuckDBInstance } from "@duckdb/node-api";
import Database from "better-sqlite3";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ANALYTICS_STREAM_COLUMN } from "@omnesis/source-sdk";
import { AnalyticsDb } from "./analytics-db.js";
import { ANALYTICS_INTERNAL_TABLES } from "./analytics/internal.js";
import type { AnalyticsTableSchema, ColumnType } from "@omnesis/source-sdk";

const TEST_DB = `/tmp/omnesis-test-analytics-${crypto.randomUUID()}.db`;

const testSchema: AnalyticsTableSchema = {
  tableName: "test_metrics",
  displayName: "Test Metrics",
  description: "Test metrics for unit tests",
  columns: [
    { name: "id", type: "VARCHAR", description: "Record ID" },
    { name: "date", type: "DATE", description: "Record date" },
    { name: "metric_type", type: "VARCHAR", description: "Type of metric" },
    { name: "value", type: "DOUBLE", description: "Metric value" },
    { name: "unit", type: "VARCHAR", description: "Unit", nullable: true },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "date",
  record: { titleColumns: ["metric_type"], keyColumns: ["id", "date", "metric_type"] },
  exampleQueries: ["SELECT * FROM test_metrics LIMIT 10"],
};

const projectedCalendarSchema: AnalyticsTableSchema = {
  tableName: "test_calendar_events",
  displayName: "Calendar events",
  description: "Invented calendar events for projection tests",
  columns: [
    { name: "id", type: "VARCHAR", description: "Stable id" },
    { name: "title", type: "VARCHAR", description: "Title", nullable: true },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Start" },
    { name: "end_time", type: "TIMESTAMPTZ", description: "Exclusive end", nullable: true },
    { name: "all_day", type: "BOOLEAN", description: "All day" },
    { name: "eligible", type: "BOOLEAN", description: "Projection eligible" },
    { name: "status", type: "VARCHAR", description: "Status" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "start_time",
  record: { titleColumns: ["title"], keyColumns: ["start_time", "end_time"] },
  boundDocument: { externalIdColumns: ["id"] },
  temporalProjection: {
    slot: "calendar",
    start: "$semanticTime",
    end: "end_time",
    label: "title",
    // A timed row is a booking; an all-day row is an observance.
    kind: { from: "all_day", map: { true: "event" }, default: "appointment" },
    modality: "scheduled",
    status: { from: "status", map: { cancelled: "cancelled" }, default: "active" },
    allDay: "all_day",
    eligibility: "eligible",
  },
};

const sharedProjectedCalendarSchema: AnalyticsTableSchema = {
  ...projectedCalendarSchema,
  tableName: "test_shared_calendar_events",
  columns: [
    projectedCalendarSchema.columns[0],
    {
      name: "source_account",
      type: "VARCHAR",
      description: "Source account discriminator",
    },
    ...projectedCalendarSchema.columns.slice(1),
  ],
  sharedDiscriminatorColumn: "source_account",
};

/**
 * A snapshot's omissions carry a deadline; these tests are about *which* rows a
 * snapshot is entitled to reach, not about how long the deadline is, so they
 * compress it to nothing and then sweep. `snapshotOnlyMarks` below is the test
 * that pins the deadline itself.
 */
const IMMEDIATE_ABSENCE_POLICY = {
  minObservations: 1,
  minAgeMs: 0,
  maxMarksPerSnapshot: 10_000,
};

/** Ingest a page, then delete everything its snapshot has already made due. */
async function ingestAndSweep(
  target: AnalyticsDb,
  page: Parameters<AnalyticsDb["ingestPage"]>[0],
): Promise<{ ingested: number; deleted: number }> {
  const result = await target.ingestPage({ ...page, absencePolicy: IMMEDIATE_ABSENCE_POLICY });
  const due = await target.dueAbsences({
    dueBefore: Date.now() + 1,
    minObservations: 1,
    limit: 10_000,
  });
  const swept = await target.deleteAbsentRecords(due);
  return { ingested: result.ingested, deleted: result.deleted + swept.deleted };
}

let db: AnalyticsDb;

beforeEach(async () => {
  db = new AnalyticsDb(TEST_DB);
  await db.open();
});

afterEach(async () => {
  await db.close();
  try {
    unlinkSync(TEST_DB);
    // DuckDB creates WAL files
    if (existsSync(`${TEST_DB}.wal`)) unlinkSync(`${TEST_DB}.wal`);
  } catch {
    // Ignore cleanup errors
  }
});

describe("the Watch analytics outbox", () => {
  test("commits the stored page and its Watch hand-off atomically", async () => {
    db.enableWatchOutbox(() => true);
    await db.ingestPage({
      tableName: testSchema.tableName,
      schema: testSchema,
      sourceId: "synthetic:account",
      streamId: "device-a",
      records: [
        {
          id: "metric-1",
          date: "2026-03-01",
          metric_type: "invented",
          value: 42,
          unit: null,
        },
      ],
    });

    const batch = await db.readWatchOutbox({ pageSeq: 0, rowOffset: 0 }, 10);
    expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0]).toMatchObject({
      table: "test_metrics",
      sourceId: "synthetic:account",
      backfill: true,
      row: { id: "metric-1", [ANALYTICS_STREAM_COLUMN]: "device-a" },
    });
    expect(batch.rows[0]?.schema.primaryKey).toEqual(["id"]);
  });

  test("rolls the outbox page back when the analytics mutation fails", async () => {
    db.enableWatchOutbox(() => false);
    await expect(
      db.ingestPage({
        tableName: testSchema.tableName,
        schema: testSchema,
        sourceId: "synthetic:account",
        records: [{ id: "metric-1", metric_type: "invented", value: 42, unit: null }],
      }),
    ).rejects.toThrow();

    expect((await db.readWatchOutbox({ pageSeq: 0, rowOffset: 0 }, 10)).rows).toEqual([]);
  });

  test("does not replay a completed tail cursor", async () => {
    db.enableWatchOutbox(() => false);
    await db.ingestPage({
      tableName: testSchema.tableName,
      schema: testSchema,
      sourceId: "synthetic:account",
      records: [
        { id: "metric-tail", date: "2026-03-01", metric_type: "invented", value: 1, unit: null },
      ],
    });
    const first = await db.readWatchOutbox({ pageSeq: 0, rowOffset: 0 }, 10);
    expect(first.rows).toHaveLength(1);
    expect((await db.readWatchOutbox(first.next, 10)).rows).toEqual([]);
  });

  test("chunks provider pages into bounded restart-safe reads", async () => {
    db.enableWatchOutbox(() => false);
    const records = Array.from({ length: 1_012 }, (_, index) => ({
      id: `metric-${index}`,
      date: "2026-03-01",
      metric_type: "invented",
      value: index,
      unit: null,
    }));
    await db.ingestPage({
      tableName: testSchema.tableName,
      schema: testSchema,
      sourceId: "synthetic:account",
      records,
    });

    let cursor = { pageSeq: 0, rowOffset: 0 };
    let read = 0;
    while (true) {
      const batch = await db.readWatchOutbox(cursor, 500);
      read += batch.rows.length;
      cursor = batch.next;
      if (!batch.pending) break;
    }
    expect(read).toBe(1_012);
    expect((await db.readWatchOutbox(cursor, 500)).rows).toEqual([]);
  });

  test("purges retained Watch payloads when their source is removed", async () => {
    db.enableWatchOutbox(() => false);
    await db.ingestPage({
      tableName: testSchema.tableName,
      schema: testSchema,
      sourceId: "synthetic:removed",
      records: [
        { id: "private-row", date: "2026-03-01", metric_type: "invented", value: 1, unit: null },
      ],
    });

    await db.deleteAnalyticsForSource("synthetic:removed");

    expect((await db.readWatchOutbox({ pageSeq: 0, rowOffset: 0 }, 10)).rows).toEqual([]);
  });

  test("purges one removed device stream without removing its sibling", async () => {
    db.enableWatchOutbox(() => false);
    for (const [streamId, id] of [
      ["device-a", "metric-a"],
      ["device-b", "metric-b"],
    ] as const) {
      await db.ingestPage({
        tableName: testSchema.tableName,
        schema: testSchema,
        sourceId: "synthetic:partitioned",
        streamId,
        records: [{ id, date: "2026-03-01", metric_type: "invented", value: 1, unit: null }],
      });
    }

    await db.deleteAnalyticsStream("synthetic:partitioned", "device-a");

    const rows = (await db.readWatchOutbox({ pageSeq: 0, rowOffset: 0 }, 10)).rows;
    expect(rows.map((entry) => entry.row.id)).toEqual(["metric-b"]);
  });

  test("prunes every consumed payload after its grace period", async () => {
    db.enableWatchOutbox(() => false);
    await db.ingestPage({
      tableName: testSchema.tableName,
      schema: testSchema,
      sourceId: "synthetic:account",
      records: [
        { id: "metric-pruned", date: "2026-03-01", metric_type: "invented", value: 1, unit: null },
      ],
    });
    const batch = await db.readWatchOutbox({ pageSeq: 0, rowOffset: 0 }, 10);
    await db.acknowledgeWatchOutbox(batch.next.pageSeq);
    await db.pruneWatchOutbox(batch.next.pageSeq, Date.now() + 1_000);

    expect((await db.readWatchOutbox({ pageSeq: 0, rowOffset: 0 }, 10)).rows).toEqual([]);
    expect((await db.watchOutboxStats({ pageSeq: 0, rowOffset: 0 })).retainedRows).toBe(0);
  });
});

describe("AnalyticsDb", () => {
  test("open and close", () => {
    // Just test that beforeEach/afterEach work
    expect(db).toBeDefined();
  });

  test("ensureTable creates table and catalog entry", async () => {
    await db.ensureTable(testSchema, "test-source:local");

    const catalog = await db.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].tableName).toBe("test_metrics");
    expect(catalog[0].displayName).toBe("Test Metrics");
    expect(catalog[0].sourceId).toBe("test-source:local");
    expect(catalog[0].columns).toHaveLength(5);
    expect(catalog[0].primaryKey).toEqual(["id"]);
  });

  test("catalog round-trips source-owned categorical metadata", async () => {
    const schemaWithDomain: AnalyticsTableSchema = {
      ...testSchema,
      columns: testSchema.columns.map((column) =>
        column.name === "metric_type"
          ? {
              ...column,
              allowedValues: ["motor_speed", "bearing_temperature"],
              valueAliases: {
                motor_speed: ["motor speed"],
                bearing_temperature: ["bearing temperature"],
              },
              categoricalRole: "series" as const,
            }
          : column,
      ),
    };
    await db.ensureTable(schemaWithDomain, "fictional-machine:local");

    const metric = (await db.getCatalog())[0]?.columns.find(({ name }) => name === "metric_type");
    expect(metric).toMatchObject({
      allowedValues: ["motor_speed", "bearing_temperature"],
      valueAliases: {
        motor_speed: ["motor speed"],
        bearing_temperature: ["bearing temperature"],
      },
      categoricalRole: "series",
    });
  });

  test("ensureTable is idempotent", async () => {
    await db.ensureTable(testSchema, "test-source:local");
    await db.ensureTable(testSchema, "test-source:local");

    const catalog = await db.getCatalog();
    expect(catalog).toHaveLength(1);
  });

  test("ensureTable tolerates a pre-#757 schema with no record-citation contract", async () => {
    // A device client built before #757 omits semanticTimeColumn + record. Its
    // rows must still ingest — the table is simply not citation-eligible.
    const legacySchema = {
      tableName: testSchema.tableName,
      displayName: testSchema.displayName,
      description: testSchema.description,
      columns: testSchema.columns,
      primaryKey: testSchema.primaryKey,
      exampleQueries: testSchema.exampleQueries,
    } as unknown as AnalyticsTableSchema;

    await expect(db.ensureTable(legacySchema, "test-source:local")).resolves.not.toThrow();
    const catalog = await db.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].tableName).toBe("test_metrics");
  });

  test("insertRecords inserts rows", async () => {
    await db.ensureTable(testSchema, "test-source:local");

    const count = await db.insertRecords(
      "test_metrics",
      [
        { id: "1", date: "2024-01-01", metric_type: "steps", value: 10000, unit: "count" },
        { id: "2", date: "2024-01-02", metric_type: "steps", value: 8500, unit: "count" },
      ],
      ["id"],
    );

    expect(count).toBe(2);

    const result = await db.executeQuery("SELECT * FROM test_metrics ORDER BY id");
    expect(result.rowCount).toBe(2);
    expect(result.columns).toContain("id");
    expect(result.columns).toContain("value");
  });

  test("insertRecords upserts on conflict", async () => {
    await db.ensureTable(testSchema, "test-source:local");

    await db.insertRecords(
      "test_metrics",
      [{ id: "1", date: "2024-01-01", metric_type: "steps", value: 10000, unit: "count" }],
      ["id"],
    );

    // Upsert with updated value
    await db.insertRecords(
      "test_metrics",
      [{ id: "1", date: "2024-01-01", metric_type: "steps", value: 12000, unit: "count" }],
      ["id"],
    );

    const result = await db.executeQuery("SELECT value FROM test_metrics WHERE id = '1'");
    expect(result.rowCount).toBe(1);
    expect(result.rows[0][0]).toBe(12000);
  });

  test("materializes, updates, and tombstones source-owned projections atomically", async () => {
    const sourceId = "calendar:local";
    const first = {
      id: "evt-1",
      title: "Studio planning",
      start_time: "2026-07-23T09:00:00.000Z",
      end_time: "2026-07-23T10:00:00.000Z",
      all_day: false,
      eligible: true,
      status: "confirmed",
    };
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [first],
      schema: projectedCalendarSchema,
      sourceId,
    });

    let rows = await db.queryTemporalProjections({
      fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
      toMs: Date.parse("2026-07-24T00:00:00.000Z"),
      limit: 10,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: expect.stringMatching(/^tp_/),
      sourceId,
      documentExternalId: "evt-1",
      label: "Studio planning",
      kind: "appointment",
      modality: "scheduled",
      status: "active",
    });
    const stableId = rows[0].id;

    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [{ ...first, title: "Studio planning revised", status: "cancelled" }],
      sourceId,
    });
    rows = await db.queryTemporalProjections({
      fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
      toMs: Date.parse("2026-07-24T00:00:00.000Z"),
      limit: 10,
    });
    expect(rows[0]).toMatchObject({
      id: stableId,
      label: "Studio planning revised",
      status: "cancelled",
    });

    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [],
      sourceId,
      deletedIds: ["evt-1"],
    });
    expect(
      await db.queryTemporalProjections({
        fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
        toMs: Date.parse("2026-07-24T00:00:00.000Z"),
        limit: 10,
      }),
    ).toEqual([]);
  });

  test("rolls a replicated member's tombstone back when the ledger's verdict fails", async () => {
    await db.ingestPage({
      tableName: testSchema.tableName,
      records: [
        {
          id: "kept-after-reset-failure",
          date: "2026-01-12",
          metric_type: "distance",
          value: 4,
          unit: "km",
        },
      ],
      schema: testSchema,
      sourceId: "test-source:local",
    });
    let attempted = false;

    await expect(
      db.ingestPage({
        tableName: testSchema.tableName,
        records: [],
        sourceId: "test-source:local",
        deletedIds: ["kept-after-reset-failure"],
        replica: {
          recordPresence: async () => undefined,
          judgeDeletions: (existingIds) => {
            attempted = true;
            expect(existingIds).toEqual(["kept-after-reset-failure"]);
            return Promise.reject(new Error("synthetic ledger failure"));
          },
        },
      }),
    ).rejects.toThrow("synthetic ledger failure");
    expect(attempted).toBe(true);
    expect(
      (await db.executeQuery("SELECT id FROM test_metrics WHERE id = 'kept-after-reset-failure'"))
        .rows,
    ).toEqual([["kept-after-reset-failure"]]);
  });

  test("scopes shared calendar snapshots and projections to the emitting account", async () => {
    const accountA = "google-calendar:alpha@example.com";
    const accountB = "google-calendar:beta@example.com";
    const event = (
      id: string,
      sourceAccount: string,
      startTime: string,
    ): Record<string, unknown> => ({
      id,
      source_account: sourceAccount,
      title: `Event ${id}`,
      start_time: startTime,
      end_time: new Date(Date.parse(startTime) + 3_600_000).toISOString(),
      all_day: false,
      eligible: true,
      status: "confirmed",
    });

    await ingestAndSweep(db, {
      tableName: sharedProjectedCalendarSchema.tableName,
      records: [event("evt-a", "alpha@example.com", "2026-07-23T09:00:00.000Z")],
      schema: sharedProjectedCalendarSchema,
      sourceId: accountA,
      presentIds: ["evt-a"],
    });
    await ingestAndSweep(db, {
      tableName: sharedProjectedCalendarSchema.tableName,
      records: [event("evt-b", "beta@example.com", "2026-07-23T11:00:00.000Z")],
      schema: sharedProjectedCalendarSchema,
      sourceId: accountB,
      presentIds: ["evt-b"],
    });

    let analyticsRows = await db.executeQuery(
      `SELECT id, source_account
       FROM ${sharedProjectedCalendarSchema.tableName}
       ORDER BY id`,
    );
    expect(analyticsRows.rows).toEqual([
      ["evt-a", "alpha@example.com"],
      ["evt-b", "beta@example.com"],
    ]);
    let projections = await db.queryTemporalProjections({
      fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
      toMs: Date.parse("2026-07-24T00:00:00.000Z"),
      limit: 10,
    });
    expect(projections.map((row) => row.sourceId).sort()).toEqual([accountA, accountB]);

    await ingestAndSweep(db, {
      tableName: sharedProjectedCalendarSchema.tableName,
      records: [],
      schema: sharedProjectedCalendarSchema,
      sourceId: accountA,
      presentIds: [],
    });

    analyticsRows = await db.executeQuery(
      `SELECT id, source_account
       FROM ${sharedProjectedCalendarSchema.tableName}
       ORDER BY id`,
    );
    expect(analyticsRows.rows).toEqual([["evt-b", "beta@example.com"]]);
    projections = await db.queryTemporalProjections({
      fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
      toMs: Date.parse("2026-07-24T00:00:00.000Z"),
      limit: 10,
    });
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      sourceId: accountB,
      documentExternalId: "evt-b",
    });
  });

  test("retires projections when their source contract is removed", async () => {
    const sourceId = "calendar:local";
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [
        {
          id: "evt-retired",
          title: "Retired event",
          start_time: "2026-07-23T09:00:00.000Z",
          end_time: "2026-07-23T10:00:00.000Z",
          all_day: false,
          eligible: true,
          status: "confirmed",
        },
      ],
      schema: projectedCalendarSchema,
      sourceId,
    });

    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [],
      schema: { ...projectedCalendarSchema, temporalProjection: undefined },
      sourceId,
    });

    expect(
      await db.queryTemporalProjections({
        fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
        toMs: Date.parse("2026-07-24T00:00:00.000Z"),
        limit: 10,
      }),
    ).toEqual([]);
    expect(await db.getTemporalProjectionCoverage()).toEqual([]);
    const analyticsRows = await db.executeQuery(
      `SELECT id FROM ${projectedCalendarSchema.tableName}`,
    );
    expect(analyticsRows.rows).toEqual([["evt-retired"]]);
  });

  test("retires old facts before materializing a replacement projection contract", async () => {
    const sourceId = "calendar:local";
    const row = {
      id: "evt-old",
      title: "Old contract event",
      start_time: "2026-07-23T09:00:00.000Z",
      end_time: "2026-07-23T10:00:00.000Z",
      all_day: false,
      eligible: true,
      status: "confirmed",
    };
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [row],
      schema: projectedCalendarSchema,
      sourceId,
    });

    const replacementSchema: AnalyticsTableSchema = {
      ...projectedCalendarSchema,
      temporalProjection: {
        ...projectedCalendarSchema.temporalProjection!,
        slot: "agenda",
        kind: "event",
      },
    };
    await db.ingestPage({
      tableName: replacementSchema.tableName,
      records: [
        {
          ...row,
          id: "evt-new",
          title: "Replacement contract event",
          start_time: "2026-07-23T11:00:00.000Z",
          end_time: "2026-07-23T12:00:00.000Z",
        },
      ],
      schema: replacementSchema,
      sourceId,
    });

    const projections = await db.queryTemporalProjections({
      fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
      toMs: Date.parse("2026-07-24T00:00:00.000Z"),
      limit: 10,
    });
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      documentExternalId: "evt-new",
      slot: "agenda",
      kind: "event",
    });
  });

  test("schema registration advertises coverage without backfilling existing rows", async () => {
    const sourceId = "calendar:local";
    const schemaWithoutProjection = { ...projectedCalendarSchema, temporalProjection: undefined };
    await db.ensureTable(schemaWithoutProjection, sourceId);
    await db.insertRecords(
      projectedCalendarSchema.tableName,
      [
        {
          id: "old-event",
          title: "Historical event",
          start_time: "2026-01-01T09:00:00.000Z",
          end_time: "2026-01-01T10:00:00.000Z",
          all_day: false,
          eligible: true,
          status: "confirmed",
        },
      ],
      ["id"],
    );

    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [],
      schema: projectedCalendarSchema,
      sourceId,
    });

    expect(
      await db.queryTemporalProjections({
        fromMs: Date.parse("2025-01-01T00:00:00.000Z"),
        toMs: Date.parse("2027-01-01T00:00:00.000Z"),
        limit: 10,
      }),
    ).toEqual([]);
    expect(await db.getTemporalProjectionCoverage()).toEqual([
      expect.objectContaining({
        sourceId,
        tableName: projectedCalendarSchema.tableName,
        slots: ["calendar"],
      }),
    ]);
  });

  test("keeps the analytics row when its projection cannot be derived", async () => {
    // A projection is derived metadata about a row. Rejecting the page would
    // leave the sync cursor where it was and stall the source on the same
    // record, which is a far larger failure than the data problem warrants.
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      schema: projectedCalendarSchema,
      sourceId: "calendar:local",
      records: [
        {
          id: "bad-event",
          title: "Ends before it starts",
          start_time: "2026-07-23T10:00:00.000Z",
          end_time: "2026-07-23T09:00:00.000Z",
          all_day: false,
          eligible: true,
          status: "confirmed",
        },
        {
          id: "good-event",
          title: "Quarterly review",
          start_time: "2026-07-24T09:00:00.000Z",
          end_time: "2026-07-24T10:00:00.000Z",
          all_day: false,
          eligible: true,
          status: "confirmed",
        },
      ],
    });

    const rows = await db.executeQuery(
      `SELECT id FROM ${projectedCalendarSchema.tableName} ORDER BY id`,
    );
    expect(rows.rows.flat()).toEqual(["bad-event", "good-event"]);

    // Only the derivable row owns a projection.
    const projected = await db.queryTemporalProjections({
      fromMs: Date.parse("2026-07-01T00:00:00.000Z"),
      toMs: Date.parse("2026-08-01T00:00:00.000Z"),
    });
    expect(projected.map((p) => p.label)).toEqual(["Quarterly review"]);
  });

  test("rejects and rolls back impossible all-day calendar dates", async () => {
    await expect(
      db.ingestPage({
        tableName: projectedCalendarSchema.tableName,
        schema: projectedCalendarSchema,
        sourceId: "calendar:local",
        records: [
          {
            id: "bad-all-day-event",
            title: "Impossible date",
            start_time: "2026-02-31",
            end_time: "2026-03-02",
            all_day: true,
            eligible: true,
            status: "confirmed",
          },
        ],
      }),
    ).rejects.toThrow(/start is not a valid date|timestamp field value out of range/);

    expect(await db.getCatalog()).toEqual([]);
  });

  test("maps kind from all-day-ness and keeps an all-day fact a calendar day", async () => {
    const sourceId = "calendar:local";
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      schema: projectedCalendarSchema,
      sourceId,
      records: [
        {
          id: "evt-timed",
          title: "Quarterly review",
          start_time: "2026-07-23T09:00:00.000Z",
          end_time: "2026-07-23T10:00:00.000Z",
          all_day: false,
          eligible: true,
          status: "confirmed",
        },
        {
          id: "evt-all-day",
          title: "Team offsite",
          start_time: "2026-07-23",
          end_time: "2026-07-25",
          all_day: true,
          eligible: true,
          status: "confirmed",
        },
      ],
    });

    const projections = await db.queryTemporalProjections({
      fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
      toMs: Date.parse("2026-07-26T00:00:00.000Z"),
      limit: 10,
    });
    expect(projections).toHaveLength(2);
    expect(projections[0]).toMatchObject({
      documentExternalId: "evt-all-day",
      kind: "event",
      precision: "day",
      allDay: true,
      startCanonical: "2026-07-23",
      endCanonical: "2026-07-25",
    });
    expect(projections[1]).toMatchObject({
      documentExternalId: "evt-timed",
      kind: "appointment",
      precision: "instant",
      allDay: false,
      startCanonical: "2026-07-23T09:00:00.000Z",
      endCanonical: "2026-07-23T10:00:00.000Z",
    });
  });

  test("stores a fact with no declared end as an empty interval", async () => {
    const sourceId = "calendar:local";
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      schema: projectedCalendarSchema,
      sourceId,
      records: [
        {
          id: "evt-instant",
          title: "Badge scan",
          start_time: "2026-07-23T09:00:00.000Z",
          end_time: null,
          all_day: false,
          eligible: true,
          status: "confirmed",
        },
      ],
    });

    const projections = await db.queryTemporalProjections({
      fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
      toMs: Date.parse("2026-07-24T00:00:00.000Z"),
      limit: 10,
    });
    expect(projections).toHaveLength(1);
    expect(projections[0].startMs).toBe(Date.parse("2026-07-23T09:00:00.000Z"));
    expect(projections[0].endExclusiveMs).toBe(projections[0].startMs);
    expect(projections[0].endCanonical).toBe(projections[0].startCanonical);
  });

  test("declines a projection for a row the eligibility gate rejects", async () => {
    const sourceId = "calendar:local";
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      schema: projectedCalendarSchema,
      sourceId,
      records: [
        {
          id: "evt-master",
          title: "Weekly standup (series)",
          start_time: "2026-07-23T09:00:00.000Z",
          end_time: "2026-07-23T09:15:00.000Z",
          all_day: false,
          eligible: false,
          status: "confirmed",
        },
        {
          id: "evt-occurrence",
          title: "Weekly standup",
          start_time: "2026-07-23T09:00:00.000Z",
          end_time: "2026-07-23T09:15:00.000Z",
          all_day: false,
          eligible: true,
          status: "confirmed",
        },
      ],
    });

    const projections = await db.queryTemporalProjections({
      fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
      toMs: Date.parse("2026-07-24T00:00:00.000Z"),
      limit: 10,
    });
    expect(projections.map((row) => row.documentExternalId)).toEqual(["evt-occurrence"]);

    // The ineligible row is still analytics data — only its projection is declined.
    const analyticsRows = await db.executeQuery(
      `SELECT id FROM ${projectedCalendarSchema.tableName} ORDER BY id`,
    );
    expect(analyticsRows.rows).toEqual([["evt-master"], ["evt-occurrence"]]);
  });

  test("insertRecords handles large batches", async () => {
    await db.ensureTable(testSchema, "test-source:local");

    const records = Array.from({ length: 2500 }, (_, i) => ({
      id: `r-${i}`,
      date: "2024-01-01",
      metric_type: "steps",
      value: i * 100,
      unit: "count",
    }));

    const count = await db.insertRecords("test_metrics", records, ["id"]);
    expect(count).toBe(2500);

    const result = await db.executeQuery("SELECT COUNT(*) FROM test_metrics");
    expect(Number(result.rows[0][0])).toBe(2500);
  });

  test("insertRecords handles nullable columns", async () => {
    await db.ensureTable(testSchema, "test-source:local");

    const count = await db.insertRecords(
      "test_metrics",
      [{ id: "1", date: "2024-01-01", metric_type: "steps", value: 10000, unit: null }],
      ["id"],
    );

    expect(count).toBe(1);
    const result = await db.executeQuery("SELECT unit FROM test_metrics WHERE id = '1'");
    expect(result.rows[0][0]).toBeNull();
  });

  test("deleteRecords removes rows", async () => {
    await db.ensureTable(testSchema, "test-source:local");

    await db.insertRecords(
      "test_metrics",
      [
        { id: "1", date: "2024-01-01", metric_type: "steps", value: 10000, unit: "count" },
        { id: "2", date: "2024-01-02", metric_type: "steps", value: 8500, unit: "count" },
      ],
      ["id"],
    );

    const deleted = await db.deleteRecords("test_metrics", ["1"], "id");
    expect(deleted).toBe(1);

    const result = await db.executeQuery("SELECT COUNT(*) FROM test_metrics");
    expect(Number(result.rows[0][0])).toBe(1);
  });

  test("executeQuery returns columns and rows", async () => {
    await db.ensureTable(testSchema, "test-source:local");
    await db.insertRecords(
      "test_metrics",
      [{ id: "1", date: "2024-01-01", metric_type: "steps", value: 10000, unit: "count" }],
      ["id"],
    );

    const result = await db.executeQuery("SELECT id, value FROM test_metrics");
    expect(result.columns).toEqual(["id", "value"]);
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toEqual(["1", 10000]);
    expect(result.timing).toBeGreaterThanOrEqual(0);
  });

  test("listSourceIdsWithSamplesInRange finds sources with a sample in the half-open range", async () => {
    const sampleSchema = (tableName: string): AnalyticsTableSchema => ({
      tableName,
      displayName: tableName,
      description: "samples",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "day", type: "DATE", description: "sample day" },
        { name: "value", type: "DOUBLE", description: "value" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: "day",
    });

    // Source A: one sample in range, one out — qualifies.
    await db.ensureTable(sampleSchema("samples_a"), "health-a:local");
    await db.insertRecords(
      "samples_a",
      [
        { id: "a1", day: "2026-03-09", value: 1 },
        { id: "a2", day: "2026-03-01", value: 2 },
      ],
      ["id"],
    );
    // Source B: only an out-of-range sample — does not qualify.
    await db.ensureTable(sampleSchema("samples_b"), "bank-b:local");
    await db.insertRecords("samples_b", [{ id: "b1", day: "2026-03-01", value: 3 }], ["id"]);
    // Source C: an in-range row but no semanticTimeColumn — not day-positionable, skipped.
    const legacySchema: AnalyticsTableSchema = {
      tableName: "samples_c",
      displayName: "samples_c",
      description: "samples",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "day", type: "DATE", description: "sample day" },
      ],
      primaryKey: ["id"],
    };
    await db.ensureTable(legacySchema, "notes-c:local");
    await db.insertRecords("samples_c", [{ id: "c1", day: "2026-03-09" }], ["id"]);

    const from = Date.parse("2026-03-09T00:00:00Z");
    const to = Date.parse("2026-03-10T00:00:00Z");
    expect(await db.listSourceIdsWithSamplesInRange(from, to)).toEqual(["health-a:local"]);
    // A window with no samples returns nothing.
    expect(
      await db.listSourceIdsWithSamplesInRange(
        Date.parse("2026-02-01T00:00:00Z"),
        Date.parse("2026-02-02T00:00:00Z"),
      ),
    ).toEqual([]);
  });

  test("quoteIdent: ingest paths reject identifiers that aren't [A-Za-z_][A-Za-z0-9_]*", async () => {
    // Identifier injection via a crafted column name was the original
    // concern — `${col.name}` interpolated raw into CREATE / ALTER /
    // INSERT statements. quoteIdent gates every interpolation, so a
    // malicious schema is rejected before any SQL is built.
    const badSchema: AnalyticsTableSchema = {
      tableName: "good_table",
      displayName: "G",
      description: "G",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        // Backtick + DROP TABLE attempt — the regex in quoteIdent
        // refuses everything outside ASCII alnum / underscore.
        { name: 'bad"; DROP TABLE good_table; --', type: "VARCHAR", description: "x" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id"] },
    };
    await expect(db.ensureTable(badSchema, "test:local")).rejects.toThrow(/Invalid identifier/);

    // Same defence on a malicious table name.
    const badTable: AnalyticsTableSchema = {
      tableName: "evil; DROP TABLE _analytics_catalog; --",
      displayName: "E",
      description: "E",
      columns: [{ name: "id", type: "VARCHAR", description: "id" }],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id"] },
    };
    await expect(db.ensureTable(badTable, "test:local")).rejects.toThrow(/Invalid identifier/);

    // And on insertRecords / deleteRecords, where the table + column
    // come from the catalog or HTTP body but can equally be attacker-
    // controlled if a source descriptor is forged.
    await expect(db.insertRecords('good";DROP TABLE x;--', [{ id: "1" }], ["id"])).rejects.toThrow(
      /Invalid identifier/,
    );

    await expect(
      db.deleteRecords("good_table", ["1"], "id; DROP TABLE good_table"),
    ).rejects.toThrow(/Invalid identifier/);
  });

  test("ensureTable rejects raw SQL fragments in column types before building DDL", async () => {
    const badSchema: AnalyticsTableSchema = {
      tableName: "good_table",
      displayName: "Fixture",
      description: "Fictional analytics rows",
      columns: [
        { name: "id", type: "VARCHAR", description: "Row id" },
        {
          name: "payload",
          type: "VARCHAR); DROP TABLE _analytics_catalog; --" as ColumnType,
          description: "Payload",
        },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id", "payload"] },
    };

    await expect(db.ensureTable(badSchema, "test:local")).rejects.toThrow(
      /unsupported analytics column type/,
    );

    const catalog = await db.getCatalog();
    expect(catalog).toEqual([]);
  });

  test("executeQuery: read-only sandbox rejects DML/DDL at the engine level", async () => {
    // The user-SQL surface routes through a DuckDB instance opened in
    // READ_ONLY mode, so every write attempt is killed by the engine
    // rather than by a string-prefix check. The error string contains
    // "read-only" / "Cannot execute statement" — we just assert the
    // promise rejects (no need to pin the exact wording).
    await expect(
      db.executeQuery(
        "INSERT INTO _analytics_catalog VALUES ('x','x','x','x','{}',0,NULL,NULL,'','')",
      ),
    ).rejects.toThrow();

    await expect(db.executeQuery("DROP TABLE _analytics_catalog")).rejects.toThrow();

    await expect(db.executeQuery("DELETE FROM _analytics_catalog")).rejects.toThrow();

    await expect(
      db.executeQuery("UPDATE _analytics_catalog SET display_name = 'x'"),
    ).rejects.toThrow();

    await expect(db.executeQuery("CREATE TABLE evil (id INT)")).rejects.toThrow();

    await expect(
      db.executeQuery("ALTER TABLE _analytics_catalog ADD COLUMN evil VARCHAR"),
    ).rejects.toThrow();
  });

  test("executeQuery: sandbox blocks ATTACH (cross-store path is gone)", async () => {
    // Cross-store SQL was removed for security: the sandbox sets
    // `enable_external_access=false` instance-wide, which bans ATTACH
    // outright. ATTACH against any path must throw before it ever
    // touches the file system.
    await expect(
      db.executeQuery(`ATTACH '/tmp/does-not-exist.db' AS sqlite (TYPE SQLITE, READ_ONLY)`),
    ).rejects.toThrow();

    await expect(db.executeQuery(`ATTACH '/tmp/does-not-exist.db' AS extra`)).rejects.toThrow();

    // DETACH on the never-attached alias also can't sneak by.
    await expect(db.executeQuery("DETACH sqlite")).rejects.toThrow();
  });

  test("cross-store ATTACH of omnesis.db is rejected — the #200 torn-page race is structurally impossible", async () => {
    // Regression pin for Issue #200. The original bug was that the
    // analytics surface read omnesis.db via DuckDB's `sqlite_scanner`
    // (ATTACH '<omnesis.db>' TYPE SQLITE READ_ONLY). That scanner does
    // not participate in SQLite's file-locking protocol, so a writer
    // committing concurrently could expose a torn page mid-read,
    // surfacing as "database disk image is malformed". The fix removed
    // the cross-store path entirely: the per-query DuckDB reader is
    // opened with enable_external_access=false, which bans ATTACH at
    // the engine level. omnesis.db is now served only by better-sqlite3.
    //
    // Build a *real*, valid omnesis.db-shaped SQLite file (a `documents`
    // table) so the ATTACH targets exactly the kind of file the old
    // scanner read — not a missing path that would reject for unrelated
    // reasons. With the engine flag set, the ATTACH must reject before
    // it ever opens the file, so the torn-page race can never recur.
    const omnesisDbPath = `/tmp/omnesis-test-cross-store-${crypto.randomUUID()}.db`;
    const sqlite = new Database(omnesisDbPath);
    try {
      sqlite.exec("CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT, body TEXT)");
      sqlite
        .prepare("INSERT INTO documents (id, title, body) VALUES (?, ?, ?)")
        .run("doc-1", "Quarterly plan", "Drafted by Maya Reeves");
      sqlite.close();

      await expect(
        db.executeQuery(`ATTACH '${omnesisDbPath}' AS sqlite (TYPE SQLITE, READ_ONLY)`),
      ).rejects.toThrow();
      await expect(
        db.executeQuery(`SELECT * FROM sqlite_scan('${omnesisDbPath}', 'documents')`),
      ).rejects.toThrow();
      await expect(
        db.executeQuery(`CALL sqlite_attach('${omnesisDbPath}', overwrite = false)`),
      ).rejects.toThrow();

      // And the alias never materialized, so the torn-page surface that
      // #200 described simply does not exist.
      const probe = await db.executeQuery(
        "SELECT COUNT(*) AS n FROM information_schema.schemata WHERE catalog_name = 'sqlite'",
      );
      expect(Number(probe.rows[0][0])).toBe(0);
    } finally {
      try {
        sqlite.close();
      } catch {
        /* already closed */
      }
      try {
        unlinkSync(omnesisDbPath);
      } catch {
        /* ignore */
      }
    }
  });

  test("executeQuery: sandbox blocks file-system table-functions", async () => {
    // `enable_external_access=false` also disables read_csv_auto,
    // read_blob, read_text, read_parquet — the entire local-file
    // exfiltration surface a SELECT-shaped query could otherwise
    // tunnel through.
    await expect(db.executeQuery("SELECT * FROM read_csv_auto('/etc/hosts')")).rejects.toThrow();

    await expect(db.executeQuery("SELECT read_blob('/etc/hosts')")).rejects.toThrow();

    await expect(db.executeQuery("SELECT read_text('/etc/hosts')")).rejects.toThrow();
  });

  test("executeQuery: sandbox blocks INSTALL / LOAD of extensions", async () => {
    // Without external access, DuckDB cannot fetch or load extensions,
    // so the auto-load path that backs `sqlite_scanner` is closed.
    await expect(db.executeQuery("INSTALL sqlite")).rejects.toThrow();

    await expect(db.executeQuery("LOAD sqlite")).rejects.toThrow();
  });

  test("executeQuery applies default row limit", async () => {
    await db.ensureTable(testSchema, "test-source:local");

    // Insert a small set and verify limit wrapping works
    const records = Array.from({ length: 20 }, (_, i) => ({
      id: `r-${i}`,
      date: "2024-01-01",
      metric_type: "steps",
      value: i,
      unit: "count",
    }));
    await db.insertRecords("test_metrics", records, ["id"]);

    const result = await db.executeQuery("SELECT * FROM test_metrics", { limit: 5 });
    expect(result.rowCount).toBe(5);
  });

  test("getCatalog returns empty for fresh DB", async () => {
    const catalog = await db.getCatalog();
    expect(catalog).toEqual([]);
  });

  test("an older client ingest cannot erase source-owned categorical metadata", async () => {
    const currentSchema: AnalyticsTableSchema = {
      ...testSchema,
      columns: testSchema.columns.map((column) =>
        column.name === "metric_type"
          ? {
              ...column,
              allowedValues: ["distance", "steps"],
              valueAliases: { distance: ["travel distance"], steps: ["step count"] },
              categoricalRole: "series" as const,
            }
          : column,
      ),
    };
    await db.ensureTable(currentSchema, "test-source:local");
    await db.ensureTable(testSchema, "test-source:local");

    const entry = (await db.getCatalog()).find(({ tableName }) => tableName === "test_metrics");
    const metric = entry?.columns.find(({ name }) => name === "metric_type");
    expect(metric).toMatchObject({
      allowedValues: ["distance", "steps"],
      valueAliases: { distance: ["travel distance"], steps: ["step count"] },
      categoricalRole: "series",
    });
  });

  test("getTableInfo returns null for unknown table", async () => {
    const info = await db.getTableInfo("nonexistent");
    expect(info).toBeNull();
  });

  test("getTableInfo returns schema and sample rows", async () => {
    await db.ensureTable(testSchema, "test-source:local");
    await db.insertRecords(
      "test_metrics",
      [{ id: "1", date: "2024-01-01", metric_type: "steps", value: 10000, unit: "count" }],
      ["id"],
    );

    const info = await db.getTableInfo("test_metrics");
    expect(info).not.toBeNull();
    expect(info!.catalog.tableName).toBe("test_metrics");
    expect(info!.sampleRows).toHaveLength(1);
    expect(info!.sampleColumns).toContain("id");
  });

  test("getRecentRows orders by timestamp column descending", async () => {
    await db.ensureTable(testSchema, "test-source:local");
    await db.insertRecords(
      "test_metrics",
      [
        { id: "old", date: "2024-01-01", metric_type: "steps", value: 1, unit: "count" },
        { id: "new", date: "2024-03-01", metric_type: "steps", value: 3, unit: "count" },
        { id: "mid", date: "2024-02-01", metric_type: "steps", value: 2, unit: "count" },
      ],
      ["id"],
    );

    const recent = await db.getRecentRows("test_metrics", 10);
    expect(recent.columns).toContain("id");
    expect(recent.rows).toHaveLength(3);
    const idIdx = recent.columns.indexOf("id");
    expect(recent.rows[0][idIdx]).toBe("new");
    expect(recent.rows[1][idIdx]).toBe("mid");
    expect(recent.rows[2][idIdx]).toBe("old");
  });

  test("getRecentRows uses a total keyset order across timestamp ties and inserts", async () => {
    await db.ensureTable(testSchema, "test-source:local");
    await db.insertRecords(
      "test_metrics",
      [
        { id: "a", date: "2024-03-01", metric_type: "steps", value: 1, unit: "count" },
        { id: "b", date: "2024-03-01", metric_type: "steps", value: 2, unit: "count" },
        { id: "c", date: "2024-03-01", metric_type: "steps", value: 3, unit: "count" },
      ],
      ["id"],
    );

    const first = await db.getRecentRows("test_metrics", 2);
    const idIndex = first.columns.indexOf("id");
    expect(first.rows.map((row) => row[idIndex])).toEqual(["a", "b"]);

    // One new row sorts before the consumed boundary and one after it.
    // Offset paging would duplicate an earlier row after the leading insert;
    // the keyset continues strictly after b and includes the later insertion.
    await db.insertRecords(
      "test_metrics",
      [
        { id: "00", date: "2024-03-01", metric_type: "steps", value: 0, unit: "count" },
        { id: "bb", date: "2024-03-01", metric_type: "steps", value: 4, unit: "count" },
      ],
      ["id"],
    );
    const second = await db.getRecentRows("test_metrics", 2, first.cursors[1]);
    expect(second.rows.map((row) => row[idIndex])).toEqual(["bb", "c"]);
  });

  test("getRecentRows respects limit and caps at 1000", async () => {
    await db.ensureTable(testSchema, "test-source:local");
    await db.insertRecords(
      "test_metrics",
      [
        { id: "a", date: "2024-01-01", metric_type: "steps", value: 1, unit: "count" },
        { id: "b", date: "2024-02-01", metric_type: "steps", value: 2, unit: "count" },
        { id: "c", date: "2024-03-01", metric_type: "steps", value: 3, unit: "count" },
      ],
      ["id"],
    );

    const one = await db.getRecentRows("test_metrics", 1);
    expect(one.rows).toHaveLength(1);

    const huge = await db.getRecentRows("test_metrics", 99999);
    expect(huge.rows).toHaveLength(3);
  });

  test("getRecentRows works without timestamp column", async () => {
    const schemaNoTime: AnalyticsTableSchema = {
      tableName: "no_time",
      displayName: "No time",
      description: "No time",
      columns: [
        { name: "id", type: "VARCHAR", description: "ID" },
        { name: "label", type: "VARCHAR", description: "Label" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["label"], keyColumns: ["id", "label"] },
    };
    await db.ensureTable(schemaNoTime, "source:x");
    await db.insertRecords(
      "no_time",
      [
        { id: "1", label: "a" },
        { id: "2", label: "b" },
      ],
      ["id"],
    );

    const recent = await db.getRecentRows("no_time", 10);
    expect(recent.rows).toHaveLength(2);
    expect(recent.columns).toEqual(["id", "label"]);
    expect(recent.rows.map((row) => row[0])).toEqual(["1", "2"]);
  });

  test("updateCatalogStats updates record count", async () => {
    await db.ensureTable(testSchema, "test-source:local");
    await db.insertRecords(
      "test_metrics",
      [
        { id: "1", date: "2024-01-01", metric_type: "steps", value: 10000, unit: "count" },
        { id: "2", date: "2024-01-02", metric_type: "steps", value: 8500, unit: "count" },
      ],
      ["id"],
    );

    await db.updateCatalogStats("test_metrics");

    const catalog = await db.getCatalog();
    expect(catalog[0].recordCount).toBe(2);
  });

  test("updateCatalogStats uses the source-declared semantic time column", async () => {
    const schema: AnalyticsTableSchema = {
      tableName: "fictional_multi_time_metrics",
      displayName: "Fictional multi-time metrics",
      description: "Invented measurements with separate ingestion and observation times",
      columns: [
        { name: "id", type: "VARCHAR", description: "Measurement identifier" },
        {
          name: "ingested_at",
          type: "TIMESTAMPTZ",
          description: "When the row was imported",
        },
        {
          name: "observed_at",
          type: "TIMESTAMPTZ",
          description: "When the measurement happened",
        },
        { name: "value", type: "DOUBLE", description: "Measured value" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: "observed_at",
      record: { titleColumns: ["id"], keyColumns: ["id", "observed_at"] },
    };
    await db.ensureTable(schema, "fictional-multi-time:local");
    await db.insertRecords(
      schema.tableName,
      [
        {
          id: "metric-1",
          ingested_at: "2030-01-01T00:00:00.000Z",
          observed_at: "2027-01-10T00:00:00.000Z",
          value: 4,
        },
        {
          id: "metric-2",
          ingested_at: "2020-01-01T00:00:00.000Z",
          observed_at: "2027-01-12T00:00:00.000Z",
          value: 8,
        },
      ],
      ["id"],
    );

    await db.updateCatalogStats(schema.tableName);

    const entry = (await db.getCatalog()).find(
      (candidate) => candidate.tableName === schema.tableName,
    );
    expect(entry).toMatchObject({
      recordCount: 2,
      earliestDate: expect.stringContaining("2027-01-10"),
      latestDate: expect.stringContaining("2027-01-12"),
    });
  });

  test("insertRecords serializes object values for JSON columns", async () => {
    const jsonSchema: AnalyticsTableSchema = {
      tableName: "test_json",
      displayName: "Test JSON",
      description: "Test table with a JSON column",
      columns: [
        { name: "id", type: "VARCHAR", description: "ID" },
        { name: "metadata", type: "JSON", description: "Raw metadata", nullable: true },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id", "metadata"] },
    };

    await db.ensureTable(jsonSchema, "test-source:local");

    const count = await db.insertRecords(
      "test_json",
      [
        { id: "1", metadata: { HKMetadataKeyWasUserEntered: true, note: "weigh-in" } },
        { id: "2", metadata: null },
      ],
      ["id"],
    );

    expect(count).toBe(2);

    const result = await db.executeQuery(
      "SELECT id, metadata->>'note' AS note FROM test_json ORDER BY id",
    );
    expect(result.rowCount).toBe(2);
    expect(result.rows[0][1]).toBe("weigh-in");
    expect(result.rows[1][1]).toBeNull();
  });

  test("insertRecords handles VARCHAR[] array columns", async () => {
    const arraySchema: AnalyticsTableSchema = {
      tableName: "test_tags",
      displayName: "Test Tags",
      description: "Test table with array columns",
      columns: [
        { name: "id", type: "VARCHAR", description: "ID" },
        { name: "tags", type: "VARCHAR[]", description: "Tags" },
        { name: "score", type: "DOUBLE", description: "Score" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id", "score"] },
    };

    await db.ensureTable(arraySchema, "test-source:local");

    const count = await db.insertRecords(
      "test_tags",
      [
        { id: "1", tags: ["alpha", "beta"], score: 9.5 },
        { id: "2", tags: [], score: 3.0 },
        { id: "3", tags: ["gamma"], score: 7.0 },
      ],
      ["id"],
    );

    expect(count).toBe(3);

    const result = await db.executeQuery("SELECT id, tags, score FROM test_tags ORDER BY id");
    expect(result.rowCount).toBe(3);
    // DuckDB returns arrays as native arrays
    expect(result.rows[0][1]).toEqual(["alpha", "beta"]);
    expect(result.rows[1][1]).toEqual([]);
    expect(result.rows[2][1]).toEqual(["gamma"]);
  });

  test("insertRecords upserts rows with VARCHAR[] columns", async () => {
    const arraySchema: AnalyticsTableSchema = {
      tableName: "test_tags_upsert",
      displayName: "Test Tags Upsert",
      description: "Test upsert with arrays",
      columns: [
        { name: "id", type: "VARCHAR", description: "ID" },
        { name: "tags", type: "VARCHAR[]", description: "Tags" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id", "tags"] },
    };

    await db.ensureTable(arraySchema, "test-source:local");

    await db.insertRecords("test_tags_upsert", [{ id: "1", tags: ["a", "b"] }], ["id"]);

    // Upsert with different tags
    await db.insertRecords("test_tags_upsert", [{ id: "1", tags: ["c", "d", "e"] }], ["id"]);

    const result = await db.executeQuery("SELECT tags FROM test_tags_upsert WHERE id = '1'");
    expect(result.rows[0][0]).toEqual(["c", "d", "e"]);
  });

  test("ensureTable evolves schema with new columns", async () => {
    // Create table with initial schema
    await db.ensureTable(testSchema, "test-source:local");

    // Evolve with extra column
    const evolvedSchema: AnalyticsTableSchema = {
      ...testSchema,
      columns: [
        ...testSchema.columns,
        { name: "source", type: "VARCHAR", description: "Data source", nullable: true },
        { name: "tags", type: "VARCHAR[]", description: "Tags", nullable: true },
      ],
    };

    await db.ensureTable(evolvedSchema, "test-source:local");

    // Insert with new columns
    const count = await db.insertRecords(
      "test_metrics",
      [
        {
          id: "evo-1",
          date: "2024-01-01",
          metric_type: "steps",
          value: 5000,
          unit: "count",
          source: "fitbit",
          tags: ["daily"],
        },
      ],
      ["id"],
    );
    expect(count).toBe(1);

    const result = await db.executeQuery(
      "SELECT source, tags FROM test_metrics WHERE id = 'evo-1'",
    );
    expect(result.rows[0][0]).toBe("fitbit");
    expect(result.rows[0][1]).toEqual(["daily"]);
  });

  test("a table can be shared within one source type but not mutated by another", async () => {
    const schema: AnalyticsTableSchema = {
      ...testSchema,
      tableName: "source_owned_schema",
    };

    await db.ensureTable(schema, "alpha:first");
    await expect(db.ensureTable(schema, "alpha:second")).resolves.toBeUndefined();
    await expect(db.ensureTable(schema, "beta:first")).rejects.toThrow(
      /belongs to source type alpha, not beta/,
    );
  });

  test("type-only metadata does not erase a qualified catalog owner", async () => {
    await db.ensureTable(testSchema, "test-source:first");
    await db.ensureTable(testSchema, "test-source");
    expect((await db.getCatalog())[0].sourceId).toBe("test-source:first");
    await db.updateCatalogSourceId(testSchema.tableName, "test-source");
    expect((await db.getCatalog())[0].sourceId).toBe("test-source:first");
    await db.ensureTable(testSchema, "test-source:second");
    expect((await db.getCatalog())[0].sourceId).toBe("test-source");
    await db.ensureTable(testSchema, "test-source:first");
    expect((await db.getCatalog())[0].sourceId).toBe("test-source");
  });

  test("an ambiguous legacy bare owner is not adopted by one account", async () => {
    await db.ensureTable(testSchema, "test-source");
    await db.ensureTable(testSchema, "test-source:first");
    await db.updateCatalogSourceId(testSchema.tableName, "test-source:first");
    expect((await db.getCatalog())[0].sourceId).toBe("test-source");
    await expect(
      db.ingestPage({
        tableName: testSchema.tableName,
        sourceId: "test-source:first",
        records: [],
        deletedIds: ["old-record"],
      }),
    ).rejects.toThrow(/sharedDiscriminatorColumn/);
  });

  test("schema-less sibling ingestion records shared ownership before account removal", async () => {
    const schema: AnalyticsTableSchema = {
      ...testSchema,
      tableName: "schema_less_accounts",
      columns: [
        { name: "id", type: "VARCHAR", description: "Record" },
        { name: "account", type: "VARCHAR", description: "Owner" },
      ],
      sharedDiscriminatorColumn: "account",
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id"] },
    };
    await db.ingestPage({
      tableName: schema.tableName,
      schema,
      sourceId: "test-source:first",
      records: [{ id: "one" }],
    });
    await db.ingestPage({
      tableName: schema.tableName,
      sourceId: "test-source:second",
      records: [{ id: "two" }],
    });
    expect((await db.getCatalog())[0].sourceId).toBe("test-source");
    await expect(
      db.ingestPage({
        tableName: schema.tableName,
        sourceId: "other-source:first",
        records: [{ id: "three" }],
      }),
    ).rejects.toThrow(/source types/);
    await db.deleteAnalyticsForSource("test-source:first");
    expect((await db.executeQuery("SELECT id, account FROM schema_less_accounts")).rows).toEqual([
      ["two", "second"],
    ]);
  });

  test("a pinned old page schema retains the account discriminator and cannot delete its sibling", async () => {
    const current: AnalyticsTableSchema = {
      ...testSchema,
      sharedDiscriminatorColumn: "account",
      columns: [
        ...testSchema.columns,
        { name: "account", type: "VARCHAR", description: "Owning account" },
      ],
    };
    for (const account of ["first", "second"]) {
      await db.ingestPage({
        tableName: current.tableName,
        schema: current,
        sourceId: `test-source:${account}`,
        records: [{ id: account, date: "2024-01-01", metric_type: "steps", value: 1, account }],
      });
    }
    const oldSchema = { ...current, sharedDiscriminatorColumn: undefined };
    await db.ingestPage({
      tableName: current.tableName,
      schema: oldSchema,
      sourceId: "test-source:first",
      records: [],
      deletedIds: ["first", "second"],
    });
    expect((await db.executeQuery("SELECT id FROM test_metrics")).rows).toEqual([["second"]]);
    expect(
      (
        await db.executeQuery(
          "SELECT json_extract_string(schema_json, '$.sharedDiscriminatorColumn') FROM _analytics_catalog WHERE table_name = 'test_metrics'",
        )
      ).rows,
    ).toEqual([["account"]]);
  });

  test("account discriminator replacement is refused before schema mutation", async () => {
    const current: AnalyticsTableSchema = {
      ...testSchema,
      sharedDiscriminatorColumn: "account",
      columns: [
        ...testSchema.columns,
        { name: "account", type: "VARCHAR", description: "Owning account" },
      ],
    };
    await db.ensureTable(current, "test-source:first");
    await expect(
      db.ensureTable(
        {
          ...current,
          sharedDiscriminatorColumn: "actor",
          columns: [
            ...current.columns,
            { name: "actor", type: "VARCHAR", description: "Record actor", nullable: true },
          ],
        },
        "test-source:first",
      ),
    ).rejects.toThrow(/discriminator/i);
    expect(
      (
        await db.executeQuery(
          "SELECT column_name FROM information_schema.columns WHERE table_name='test_metrics' AND column_name='actor'",
        )
      ).rows,
    ).toEqual([]);
  });

  test("old journal records missing a newly declared owner are scoped without changing their payload", async () => {
    const oldRecord = { id: "legacy", date: "2024-01-01", metric_type: "steps", value: 1 };
    await db.ingestPage({
      tableName: testSchema.tableName,
      schema: testSchema,
      sourceId: "test-source:first",
      records: [oldRecord],
    });
    const current: AnalyticsTableSchema = {
      ...testSchema,
      sharedDiscriminatorColumn: "account",
      columns: [
        ...testSchema.columns,
        { name: "account", type: "VARCHAR", description: "Owning account", nullable: true },
      ],
    };
    await db.ensureTable(current, "test-source:first");
    expect((await db.executeQuery("SELECT account FROM test_metrics")).rows).toEqual([["first"]]);
    await db.ensureTable(current, "test-source:second");
    const pendingRecord = { ...oldRecord, id: "pending" };
    await db.ingestPage({
      tableName: testSchema.tableName,
      schema: testSchema,
      sourceId: "test-source:first",
      records: [pendingRecord],
    });
    expect(pendingRecord).not.toHaveProperty("account");
    expect(
      (await db.executeQuery("SELECT account FROM test_metrics WHERE id='pending'")).rows,
    ).toEqual([["first"]]);
  });

  test("a dynamic old schema cannot archive its persisted ownership column", async () => {
    const current: AnalyticsTableSchema = {
      ...testSchema,
      dynamicColumns: true,
      sharedDiscriminatorColumn: "account",
      columns: [
        ...testSchema.columns,
        { name: "account", type: "VARCHAR", description: "Owning account", nullable: true },
      ],
    };
    await db.ensureTable(current, "test-source:first");
    await db.ingestPage({
      tableName: current.tableName,
      schema: { ...testSchema, dynamicColumns: true },
      sourceId: "test-source:first",
      records: [{ id: "legacy", date: "2024-01-01", metric_type: "steps", value: 1 }],
    });
    expect((await db.executeQuery("SELECT account FROM test_metrics")).rows).toEqual([["first"]]);
    await expect(
      db.ensureTable(
        {
          ...current,
          columns: current.columns.map((column) =>
            column.name === "account" ? { ...column, type: "BIGINT" } : column,
          ),
        },
        "test-source:first",
      ),
    ).rejects.toThrow(/discriminator type/);
  });

  test("account ownership uses SQL coercion and rejects null, contradictory owners and sibling key collisions atomically", async () => {
    const schema: AnalyticsTableSchema = {
      ...testSchema,
      sharedDiscriminatorColumn: "account",
      columns: [
        ...testSchema.columns,
        { name: "account", type: "BIGINT", description: "Owning account", nullable: true },
      ],
    };
    const row = { id: "owned", date: "2024-01-01", metric_type: "steps", value: 1, account: 123 };
    await db.ingestPage({
      tableName: schema.tableName,
      schema,
      sourceId: "test-source:123",
      records: [row],
    });
    await db.ingestPage({
      tableName: schema.tableName,
      sourceId: "test-source:123",
      records: [{ id: "owned", value: 2 }],
    });
    for (const account of [null, 456]) {
      await expect(
        db.ingestPage({
          tableName: schema.tableName,
          sourceId: "test-source:123",
          records: [
            { ...row, id: "would-land", account: 123 },
            { ...row, account },
          ],
        }),
      ).rejects.toThrow();
      expect((await db.executeQuery("SELECT id, value FROM test_metrics")).rows).toEqual([
        ["owned", 2],
      ]);
    }
    await expect(
      db.ingestPage({
        tableName: schema.tableName,
        schema,
        sourceId: "test-source:456",
        records: [{ ...row, account: 456 }],
      }),
    ).rejects.toThrow(/primary key belongs to a different source account/);
    expect(
      (await db.executeQuery("SELECT CAST(account AS VARCHAR), value FROM test_metrics")).rows,
    ).toEqual([["123", 2]]);
  });

  test("fixed schemas keep additive columns when an older client schema arrives", async () => {
    const initial: AnalyticsTableSchema = {
      ...testSchema,
      tableName: "fixed_schema_skew",
    };
    const current: AnalyticsTableSchema = {
      ...initial,
      columns: [
        ...initial.columns,
        { name: "profile_label", type: "VARCHAR", description: "Profile", nullable: true },
      ],
    };

    await db.ensureTable(initial, "test-source:local");
    await db.ensureTable(current, "test-source:local");
    await db.ensureTable(initial, "test-source:local");

    const info = await db.executeQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'fixed_schema_skew' ORDER BY column_name",
    );
    expect(info.rows.map((row) => row[0])).toContain("profile_label");
    expect(info.rows.map((row) => row[0])).not.toContain("_archived__profile_label");
    const catalog = (await db.getCatalog()).find(
      (entry) => entry.tableName === "fixed_schema_skew",
    );
    expect(catalog?.columns.map((column) => column.name)).toContain("profile_label");
  });

  // ── diff-and-archive on dynamic column disappearance ────

  test("ensureTable archives dynamic columns that disappear from the new schema", async () => {
    const initial: AnalyticsTableSchema = {
      tableName: "notion_drift",
      displayName: "Notion drift",
      description: "drift test",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "status", type: "VARCHAR", description: "status", nullable: true },
        { name: "priority", type: "VARCHAR", description: "priority", nullable: true },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["status"], keyColumns: ["id", "status", "priority"] },
      dynamicColumns: true,
    };
    await db.ensureTable(initial, "notion:jamesbond");
    await db.insertRecords(
      "notion_drift",
      [
        { id: "p1", status: "Done", priority: "High" },
        { id: "p2", status: "Open", priority: "Low" },
      ],
      ["id"],
    );

    // The user deletes the `status` property in Notion. The schema
    // mapper re-emits the schema without that column.
    const evolved: AnalyticsTableSchema = {
      ...initial,
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "priority", type: "VARCHAR", description: "priority", nullable: true },
      ],
      record: { titleColumns: ["priority"], keyColumns: ["id", "priority"] },
    };
    await db.ensureTable(evolved, "notion:jamesbond");

    // The original column was renamed to `_archived__status`.
    // Historical values survive there.
    const archived = await db.executeQuery(
      "SELECT id, _archived__status FROM notion_drift ORDER BY id",
    );
    expect(archived.columns).toEqual(["id", "_archived__status"]);
    expect(archived.rows).toEqual([
      ["p1", "Done"],
      ["p2", "Open"],
    ]);

    // The live column set no longer carries `status`.
    const info = await db.executeQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'notion_drift' ORDER BY column_name",
    );
    expect(info.rows.map((r) => r[0])).toEqual(["_archived__status", "id", "priority"]);
  });

  test("ensureTable lets a delete-then-re-add land cleanly on the original column slot", async () => {
    const initial: AnalyticsTableSchema = {
      tableName: "notion_readd",
      displayName: "re-add test",
      description: "x",
      dynamicColumns: true,
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "status", type: "VARCHAR", description: "status", nullable: true },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["status"], keyColumns: ["id", "status"] },
    };
    await db.ensureTable(initial, "notion:jamesbond");
    await db.insertRecords("notion_readd", [{ id: "k1", status: "Done" }], ["id"]);

    // Delete: status column is archived.
    await db.ensureTable(
      {
        ...initial,
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      },
      "notion:jamesbond",
    );

    // Re-add: status column reappears on the original slot (not as `status_2`).
    await db.ensureTable(initial, "notion:jamesbond");

    const info = await db.executeQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'notion_readd' ORDER BY column_name",
    );
    const cols = info.rows.map((r) => r[0]);
    expect(cols).toContain("status");
    // The archive that briefly existed during the delete cycle is
    // gone now — the re-added `status` claimed the original slot and
    // there's no `_archived__status` left behind for the same name
    // (the previous archive was preserved through the delete-only
    // pass but DuckDB's `RENAME COLUMN status → _archived__status`
    // doesn't keep a no-op trail when the new schema re-adds the
    // name).
    expect(cols).not.toContain("status_2");

    // The new row writes into the original `status` column.
    await db.insertRecords("notion_readd", [{ id: "k1", status: "Re-added" }], ["id"]);
    const after = await db.executeQuery("SELECT status FROM notion_readd WHERE id = 'k1'");
    expect(after.rows[0][0]).toBe("Re-added");
  });

  test("ensureTable keeps at most one archived copy per column name (older archive dropped)", async () => {
    const initial: AnalyticsTableSchema = {
      tableName: "notion_repeat",
      displayName: "repeat archive",
      description: "x",
      dynamicColumns: true,
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "status", type: "VARCHAR", description: "status", nullable: true },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["status"], keyColumns: ["id", "status"] },
    };
    await db.ensureTable(initial, "notion:jamesbond");
    await db.insertRecords("notion_repeat", [{ id: "r1", status: "First" }], ["id"]);
    // Cycle 1: delete → status becomes _archived__status (holds "First").
    await db.ensureTable(
      {
        ...initial,
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      },
      "notion:jamesbond",
    );
    // Cycle 2: re-add status, write a fresh value.
    await db.ensureTable(initial, "notion:jamesbond");
    await db.insertRecords("notion_repeat", [{ id: "r1", status: "Second" }], ["id"]);
    // Cycle 3: delete again → the prior archive ("First") is dropped
    // first to make room for the newer archive ("Second"), so the
    // archive carries the most-recent value.
    await db.ensureTable(
      {
        ...initial,
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      },
      "notion:jamesbond",
    );

    const archived = await db.executeQuery(
      "SELECT _archived__status FROM notion_repeat WHERE id = 'r1'",
    );
    expect(archived.rows[0][0]).toBe("Second");
  });

  // ── rename detection via sourceColumnId ───────

  test("ensureTable renames columns when sourceColumnId stays but name changes (#318)", async () => {
    const initial: AnalyticsTableSchema = {
      tableName: "notion_rename",
      displayName: "Notion rename test",
      description: "x",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        {
          name: "status",
          type: "VARCHAR",
          description: "status",
          nullable: true,
          sourceColumnId: "notion:prop_status_abc",
        },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["status"], keyColumns: ["id", "status"] },
    };
    await db.ensureTable(initial, "notion:jamesbond");
    await db.insertRecords(
      "notion_rename",
      [
        { id: "p1", status: "Done" },
        { id: "p2", status: "Open" },
      ],
      ["id"],
    );

    // The user renames "Status" → "State" in Notion. The Notion
    // property id stays the same, so the schema mapper emits the
    // same `sourceColumnId` against the new name.
    const renamed: AnalyticsTableSchema = {
      ...initial,
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        {
          name: "state",
          type: "VARCHAR",
          description: "state",
          nullable: true,
          sourceColumnId: "notion:prop_status_abc",
        },
      ],
      record: { titleColumns: ["state"], keyColumns: ["id", "state"] },
    };
    await db.ensureTable(renamed, "notion:jamesbond");

    // The historical data lives under the new name — no archive,
    // no fresh-NULL column.
    const after = await db.executeQuery("SELECT id, state FROM notion_rename ORDER BY id");
    expect(after.columns).toEqual(["id", "state"]);
    expect(after.rows).toEqual([
      ["p1", "Done"],
      ["p2", "Open"],
    ]);

    // No `status` and no `_archived__status` either — rename, not archive.
    const info = await db.executeQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'notion_rename' ORDER BY column_name",
    );
    const cols = info.rows.map((r) => r[0]);
    expect(cols).toEqual(["id", "state"]);
  });

  // ── type-change reconciliation (#233) ───────

  test("ensureTable archives a column whose type changed and re-adds it with the new type", async () => {
    const initial: AnalyticsTableSchema = {
      tableName: "notion_typechange",
      displayName: "type change",
      description: "x",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "score", type: "VARCHAR", description: "score", nullable: true },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["score"], keyColumns: ["id", "score"] },
    };
    await db.ensureTable(initial, "notion:adrien");
    await db.insertRecords(
      "notion_typechange",
      [
        { id: "p1", score: "high" },
        { id: "p2", score: "low" },
      ],
      ["id"],
    );

    // The user switches the Notion "score" property from text to number.
    // A text → number cast on free-form text can't be done losslessly, so
    // the old column is archived and a fresh BIGINT column takes its place.
    const evolved: AnalyticsTableSchema = {
      ...initial,
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "score", type: "BIGINT", description: "score", nullable: true },
      ],
    };
    await db.ensureTable(evolved, "notion:adrien");

    // The live `score` column now has the new type.
    const typeRow = await db.executeQuery(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'notion_typechange' AND column_name = 'score'",
    );
    expect(typeRow.rows[0][0]).toBe("BIGINT");

    // Old text values are preserved out of the way under the archive name.
    const archived = await db.executeQuery(
      "SELECT id, _archived__score FROM notion_typechange ORDER BY id",
    );
    expect(archived.rows).toEqual([
      ["p1", "high"],
      ["p2", "low"],
    ]);

    // The new-typed column accepts new-typed values on the next sync.
    await db.insertRecords("notion_typechange", [{ id: "p1", score: 42 }], ["id"]);
    const after = await db.executeQuery("SELECT score FROM notion_typechange WHERE id = 'p1'");
    expect(Number(after.rows[0][0])).toBe(42);
  });

  test("ensureTable does NOT archive when the type is unchanged across re-sync (incl. TIMESTAMPTZ alias)", async () => {
    const schema: AnalyticsTableSchema = {
      tableName: "notion_stable_types",
      displayName: "stable types",
      description: "x",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "amount", type: "DECIMAL(18,4)", description: "amount", nullable: true },
        // TIMESTAMPTZ renders as `TIMESTAMP WITH TIME ZONE` in
        // information_schema — the canonicalizer must treat them as equal
        // so an idempotent re-sync doesn't spuriously archive the column.
        { name: "seen_at", type: "TIMESTAMPTZ", description: "seen at", nullable: true },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: "seen_at",
      record: { titleColumns: ["id"], keyColumns: ["id", "seen_at", "amount"] },
    };
    await db.ensureTable(schema, "notion:adrien");
    // Re-emit the identical schema (a normal repeat sync).
    await db.ensureTable(schema, "notion:adrien");

    const info = await db.executeQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'notion_stable_types' ORDER BY column_name",
    );
    // No `_archived__*` columns — nothing was treated as a type change.
    expect(info.rows.map((r) => r[0])).toEqual(["amount", "id", "seen_at"]);
  });

  test("ensureTable handles a simultaneous rename + type change on the same sourceColumnId", async () => {
    const initial: AnalyticsTableSchema = {
      tableName: "notion_rename_retype",
      displayName: "rename + retype",
      description: "x",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        {
          name: "count",
          type: "VARCHAR",
          description: "count",
          nullable: true,
          sourceColumnId: "notion:prop_count_xyz",
        },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["count"], keyColumns: ["id", "count"] },
    };
    await db.ensureTable(initial, "notion:adrien");
    await db.insertRecords("notion_rename_retype", [{ id: "p1", count: "seven" }], ["id"]);

    // The property is renamed (count → total) AND its type changes
    // (text → number) in the same Notion edit. Phase 1 renames the column
    // to `total`, then the type-change phase archives the renamed-but-still-
    // text column and re-adds `total` as BIGINT.
    const evolved: AnalyticsTableSchema = {
      ...initial,
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        {
          name: "total",
          type: "BIGINT",
          description: "total",
          nullable: true,
          sourceColumnId: "notion:prop_count_xyz",
        },
      ],
      record: { titleColumns: ["total"], keyColumns: ["id", "total"] },
    };
    await db.ensureTable(evolved, "notion:adrien");

    const typeRow = await db.executeQuery(
      "SELECT data_type FROM information_schema.columns WHERE table_name = 'notion_rename_retype' AND column_name = 'total'",
    );
    expect(typeRow.rows[0][0]).toBe("BIGINT");
    // Old value lives under the archive of the NEW name (rename happened first).
    const archived = await db.executeQuery(
      "SELECT _archived__total FROM notion_rename_retype WHERE id = 'p1'",
    );
    expect(archived.rows[0][0]).toBe("seven");
    // No leftover `count` or `_archived__count`.
    const info = await db.executeQuery(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'notion_rename_retype' ORDER BY column_name",
    );
    const cols = info.rows.map((r) => r[0]);
    expect(cols).not.toContain("count");
    expect(cols).not.toContain("_archived__count");
    expect(cols).toContain("total");
    expect(cols).toContain("_archived__total");
  });

  test("legacy dynamic schemas still archive a deleted source-identified column", async () => {
    const initial: AnalyticsTableSchema = {
      tableName: "notion_delete_only",
      displayName: "delete-only",
      description: "x",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        {
          name: "tags",
          type: "VARCHAR",
          description: "tags",
          nullable: true,
          sourceColumnId: "notion:prop_tags_xyz",
        },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["tags"], keyColumns: ["id", "tags"] },
    };
    await db.ensureTable(initial, "notion:jamesbond");
    const catalogRow = await db.executeQuery(
      "SELECT schema_json FROM _analytics_catalog WHERE table_name = 'notion_delete_only'",
    );
    expect(JSON.parse(String(catalogRow.rows[0]?.[0])).dynamicColumns).toBe(true);
    await db.insertRecords("notion_delete_only", [{ id: "k1", tags: "alpha" }], ["id"]);

    // The user deletes the property — same id no longer present.
    await db.ensureTable(
      {
        ...initial,
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      },
      "notion:jamesbond",
    );

    const archived = await db.executeQuery(
      "SELECT _archived__tags FROM notion_delete_only WHERE id = 'k1'",
    );
    expect(archived.rows[0][0]).toBe("alpha");
  });

  // ── primary-key validator on ensureTable boundary ───────

  test("ensureTable rejects a schema without a primary key", async () => {
    const bad: AnalyticsTableSchema = {
      tableName: "no_pk",
      displayName: "no pk",
      description: "x",
      columns: [{ name: "id", type: "VARCHAR", description: "id" }],
      primaryKey: [],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id"] },
    };
    await expect(db.ensureTable(bad, "test:local")).rejects.toThrow(
      /must declare a non-empty primaryKey/,
    );
  });

  test("ensureTable rejects a schema that declares the reserved stream column", async () => {
    const bad: AnalyticsTableSchema = {
      ...testSchema,
      tableName: "reserved_column",
      columns: [
        ...testSchema.columns,
        { name: "_stream_id", type: "VARCHAR", description: "Not the source's to declare" },
      ],
    };
    await expect(db.ensureTable(bad, "test:local")).rejects.toThrow(
      /reserved for the gateway's device-stream key/,
    );
  });

  test("getTableActivity returns per-day counts", async () => {
    const schema: AnalyticsTableSchema = {
      tableName: "activity_test",
      displayName: "Activity Test",
      description: "activity",
      columns: [
        { name: "id", type: "VARCHAR", description: "id" },
        { name: "start_time", type: "TIMESTAMPTZ", description: "ts" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: "start_time",
      record: { titleColumns: ["id"], keyColumns: ["id", "start_time"] },
    };
    await db.ensureTable(schema, "test:local");
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
    await db.insertRecords(
      "activity_test",
      [
        { id: "a", start_time: now.toISOString() },
        { id: "b", start_time: now.toISOString() },
        { id: "c", start_time: yesterday.toISOString() },
      ],
      ["id"],
    );

    const points = await db.getTableActivity("activity_test", 7);
    expect(points.length).toBe(2);
    // Points sorted ascending — yesterday first
    expect(points[0].count).toBe(1);
    expect(points[1].count).toBe(2);
  });

  test("sandbox: no `sqlite` catalog ever materializes (cross-store ATTACH is gone)", async () => {
    // The cross-store SQLite ATTACH path was removed for security.
    // From the user-SQL surface, the `sqlite` catalog must never be
    // present — no auto-attach, no register hook, no leaked state
    // between queries. `information_schema.schemata` is DuckDB-side
    // and reflects every attached catalog, so a count of 0 here
    // confirms the surface is closed.
    const probe = await db.executeQuery(
      "SELECT COUNT(*) AS n FROM information_schema.schemata WHERE catalog_name = 'sqlite'",
    );
    expect(Number(probe.rows[0][0])).toBe(0);

    // Even a query that *names* `sqlite.main.documents` cannot tunnel
    // an ATTACH past the sandbox — it now fails as a missing catalog.
    await expect(db.executeQuery("SELECT * FROM sqlite.main.documents")).rejects.toThrow();
  });

  test("connection pool: concurrent ingest + reads succeed without serializing", async () => {
    // Single-conn before #192 cleanup serialized every analytics op,
    // so a 22 s screen-time ingest blocked /analytics/catalog polls
    // for the full duration. Pool with N>1 conns must let concurrent
    // calls run in parallel — assert that all results land correctly.
    await db.ensureTable(testSchema, "test:fanout");

    const ingest = (id: string, n: number) =>
      db.insertRecords(
        "test_metrics",
        Array.from({ length: n }, (_, i) => ({
          id: `${id}-${i}`,
          date: "2024-01-01",
          metric_type: id,
          value: i,
          unit: null,
        })),
        ["id"],
      );

    // Fan out: 4 ingests + 4 catalog reads + 4 SQL counts in parallel.
    const ops = await Promise.all([
      ingest("A", 200),
      ingest("B", 200),
      ingest("C", 200),
      ingest("D", 200),
      db.getCatalog(),
      db.getCatalog(),
      db.getCatalog(),
      db.getCatalog(),
      db.executeQuery("SELECT COUNT(*) AS n FROM test_metrics"),
      db.executeQuery("SELECT COUNT(*) AS n FROM test_metrics"),
      db.executeQuery("SELECT COUNT(*) AS n FROM test_metrics"),
      db.executeQuery("SELECT COUNT(*) AS n FROM test_metrics"),
    ]);

    // Each ingest reports its own count.
    expect(ops.slice(0, 4)).toEqual([200, 200, 200, 200]);
    // Catalog calls all return the same registered table.
    for (const cat of ops.slice(4, 8) as Awaited<ReturnType<typeof db.getCatalog>>[]) {
      expect(cat.find((t) => t.tableName === "test_metrics")).toBeDefined();
    }
    // All 800 rows landed regardless of fan-in order.
    const final = await db.executeQuery("SELECT COUNT(*) AS n FROM test_metrics");
    expect(Number(final.rows[0][0])).toBe(800);
  });

  describe("deleteAnalyticsForSource", () => {
    test("drops every table tagged with the source id and removes catalog rows", async () => {
      const schemaA: AnalyticsTableSchema = {
        tableName: "notion_aaa",
        displayName: "Notion A",
        description: "DB A",
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      };
      const schemaB: AnalyticsTableSchema = {
        tableName: "notion_bbb",
        displayName: "Notion B",
        description: "DB B",
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      };
      const schemaC: AnalyticsTableSchema = {
        tableName: "other_zzz",
        displayName: "Other",
        description: "Different source",
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      };

      await db.ensureTable(schemaA, "notion-databases:ws1");
      await db.ensureTable(schemaB, "notion-databases:ws1");
      await db.ensureTable(schemaC, "other-source:foo");

      await db.insertRecords("notion_aaa", [{ id: "1" }], ["id"]);

      const dropped = await db.deleteAnalyticsForSource("notion-databases:ws1");
      expect(dropped.sort()).toEqual(["notion_aaa", "notion_bbb"]);

      // Catalog now only has the unrelated source.
      const catalog = await db.getCatalog();
      expect(catalog.map((c) => c.tableName)).toEqual(["other_zzz"]);

      // The dropped tables really are gone.
      await expect(db.executeQuery("SELECT COUNT(*) FROM notion_aaa")).rejects.toThrow();
    });

    test("returns empty list when no tables match", async () => {
      const dropped = await db.deleteAnalyticsForSource("nothing-here:nope");
      expect(dropped).toEqual([]);
    });

    test("fails closed when a shared table has no source discriminator", async () => {
      // Simulate the scenario where two sources share a table — the catalog
      // is keyed by the bare provider type ("browser-history") rather than
      // the full source id once a second source claims the same table.
      const schema: AnalyticsTableSchema = {
        tableName: "browser_visits_x",
        displayName: "Visits",
        description: "Shared",
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      };
      await db.ensureTable(schema, "browser-history");

      // Omnesis cannot prove which rows belong to this source. Keep the table,
      // but reject cleanup so the removal tombstone remains pending.
      await expect(db.deleteAnalyticsForSource("browser-history:chrome")).rejects.toThrow(
        "sharedDiscriminatorColumn",
      );

      const catalog = await db.getCatalog();
      expect(catalog.map((c) => c.tableName)).toContain("browser_visits_x");
    });

    test("shared table with sharedDiscriminatorColumn: deletes rows for the source's accountId, leaves siblings intact", async () => {
      // Browser-history-style: one shared table, multiple sibling
      // sources discriminated by a `browser` column. Removing
      // browser-history:chrome must clean its rows but leave Safari's
      // rows untouched.
      const schema: AnalyticsTableSchema = {
        tableName: "browser_visits_shared",
        displayName: "Visits",
        description: "Shared",
        columns: [
          { name: "id", type: "VARCHAR", description: "id" },
          { name: "browser", type: "VARCHAR", description: "Discriminator" },
          { name: "url", type: "VARCHAR", description: "URL" },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["url"], keyColumns: ["id", "browser", "url"] },
        sharedDiscriminatorColumn: "browser",
      };
      await db.ensureTable(schema, "browser-history");

      await db.insertRecords(
        "browser_visits_shared",
        [
          { id: "v1", browser: "chrome", url: "https://example.com/1" },
          { id: "v2", browser: "chrome", url: "https://example.com/2" },
          { id: "v3", browser: "safari", url: "https://example.com/3" },
          { id: "v4", browser: "safari", url: "https://example.com/4" },
        ],
        ["id"],
      );

      const dropped = await db.deleteAnalyticsForSource("browser-history:chrome");
      // Shared table — DROPPED list is empty.
      expect(dropped).toEqual([]);

      const result = await db.executeQuery(
        "SELECT id, browser FROM browser_visits_shared ORDER BY id",
      );
      // Chrome rows gone, Safari rows untouched.
      expect(result.rows.map((r) => r[0])).toEqual(["v3", "v4"]);
      expect(result.rows.every((r) => r[1] === "safari")).toBe(true);

      // Catalog row stays — Safari still writes to this table.
      const catalog = await db.getCatalog();
      expect(catalog.map((c) => c.tableName)).toContain("browser_visits_shared");
    });

    test("removing the second sibling drops nothing too — catalog row stays for whatever else was there", async () => {
      // Idempotent / no-op when both sibling sources have already had
      // their rows cleared. The catalog row stays — the only safe path
      // to actually drop a shared table is admin-driven.
      const schema: AnalyticsTableSchema = {
        tableName: "browser_visits_clean",
        displayName: "Visits",
        description: "Shared",
        columns: [
          { name: "id", type: "VARCHAR", description: "id" },
          { name: "browser", type: "VARCHAR", description: "Discriminator" },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["browser"], keyColumns: ["id", "browser"] },
        sharedDiscriminatorColumn: "browser",
      };
      await db.ensureTable(schema, "browser-history");

      // Remove with no rows present — must not throw, must not drop catalog.
      const dropped = await db.deleteAnalyticsForSource("browser-history:chrome");
      expect(dropped).toEqual([]);

      const catalog = await db.getCatalog();
      expect(catalog.map((c) => c.tableName)).toContain("browser_visits_clean");
    });
  });

  describe("close() — async drain", () => {
    test("returns a Promise; subsequent acquireConn rejects with `AnalyticsDb closed`", async () => {
      // Seed at least one row so the catalog is non-empty.
      const schema: AnalyticsTableSchema = {
        tableName: "after_close",
        displayName: "x",
        description: "x",
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      };
      await db.ensureTable(schema, "src:1");

      // close() returns a Promise we can await.
      const p = db.close();
      expect(p).toBeInstanceOf(Promise);
      await p;

      // Post-close calls fail fast with a real error message instead of
      // NPE'ing on a nulled connection (the old close-time foot-gun).
      await expect(db.getCatalog()).rejects.toThrow(/AnalyticsDb closed/);

      // Re-open for afterEach cleanup.
      db = new AnalyticsDb(TEST_DB);
      await db.open();
    });

    test("close() awaits in-flight write before tearing down the pool", async () => {
      // Kick off a long-ish write (large batch) and immediately call
      // close() without awaiting. Both should settle in order.
      const schema: AnalyticsTableSchema = {
        tableName: "drain_test",
        displayName: "x",
        description: "x",
        columns: [
          { name: "id", type: "VARCHAR", description: "id" },
          { name: "v", type: "INTEGER", description: "v" },
        ],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["id"], keyColumns: ["id", "v"] },
      };
      await db.ensureTable(schema, "src:1");
      const records = Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, v: i }));

      const writePromise = db.insertRecords("drain_test", records, ["id"]);
      const closePromise = db.close();

      // Both must resolve; the write either succeeds (drain) or
      // surfaces a clean rejection — either way, the test must not
      // hang and the close must not nuke the conn mid-transaction.
      const [writeOutcome, closeOutcome] = await Promise.allSettled([writePromise, closePromise]);
      expect(closeOutcome.status).toBe("fulfilled");
      // Write either landed (status "fulfilled") or got rejected with a
      // clean message; either is acceptable — the bug we're guarding
      // against is silent corruption / NPE on a nulled conn.
      if (writeOutcome.status === "rejected") {
        expect(String(writeOutcome.reason)).toMatch(/AnalyticsDb closed|closed|connect/i);
      }

      db = new AnalyticsDb(TEST_DB);
      await db.open();
    });
  });

  describe("schema_json corrupt-row handling", () => {
    test("getCatalog skips a row whose schema_json fails to parse, instead of throwing on the first one", async () => {
      // Seed a good row and a corrupt row in the catalog directly. We
      // poke the catalog via SQL since the corruption can't happen via
      // the public API.
      const good: AnalyticsTableSchema = {
        tableName: "good_row",
        displayName: "good",
        description: "good",
        columns: [{ name: "id", type: "VARCHAR", description: "id" }],
        primaryKey: ["id"],
        semanticTimeColumn: null,
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      };
      await db.ensureTable(good, "src:1");

      // Inject a row with bad schema_json. Use the SQL endpoint via
      // executeQuery — but executeQuery blocks DML. Instead, drop into
      // the writer queue manually using the public ingest path: a fresh
      // table with our schema, then mangle. Easiest: insert directly
      // through the test's own DuckDB conn.
      // We use insertRecords on a "synthetic" catalog won't work — the
      // catalog is private. Use a raw connection for this one
      // intentional corruption.
      // Workaround: use the test DB's own AnalyticsDb private method
      // path through a small helper — we already have an open db.
      // Insert the corrupt row via a raw SQL escape hatch in the
      // existing public API. The simplest route is to ensureTable
      // first, then UPDATE the catalog row to break its schema_json.
      // executeQuery refuses DML, so we monkey-patch the closed flag
      // off and run the UPDATE through serializeWrite.
      //
      // Since we can't easily mutate a private field from a test, we
      // settle for a different angle: corrupt the row via DuckDB
      // directly using a second handle on the same file. AnalyticsDb
      // is exclusive on instance creation, but we can pause our own
      // pool, run, resume. Simpler: trust that the parser handles
      // null-shape inputs and just verify the helper behaviour.
      //
      // Final approach: start a fresh AnalyticsDb on a sibling path,
      // mirror the catalog setup, and write a malformed schema_json
      // row through DuckDB's own client API.
      const sibling = `${TEST_DB}.sibling`;
      const sibDb = new AnalyticsDb(sibling);
      await sibDb.open();
      await sibDb.ensureTable(good, "src:1");
      // Corrupt: getPrimaryKey on a table whose row exists but whose
      // schema_json has been mangled returns []; getCatalog skips it.
      // We achieve this by manually re-opening the underlying DuckDB
      // file with the official client and overwriting schema_json.
      const { DuckDBInstance } = await import("@duckdb/node-api");
      // Close our handle so DuckDB releases the file lock.
      await sibDb.close();
      const inst = await DuckDBInstance.create(sibling);
      const conn = await inst.connect();
      await conn.run(
        "UPDATE _analytics_catalog SET schema_json = '{not json' WHERE table_name = 'good_row'",
      );
      conn.closeSync();
      inst.closeSync();
      // Reopen and exercise.
      const reopened = new AnalyticsDb(sibling);
      await reopened.open();
      try {
        const catalog = await reopened.getCatalog();
        // The corrupt row was skipped (and warn-logged); other rows
        // would have been included if we'd seeded any.
        expect(catalog.find((c) => c.tableName === "good_row")).toBeUndefined();
        // getPrimaryKey returns [] (existing fallback contract preserved).
        expect(await reopened.getPrimaryKey("good_row")).toEqual([]);
      } finally {
        await reopened.close();
        try {
          unlinkSync(sibling);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(`${sibling}.wal`);
        } catch {
          /* ignore */
        }
      }
    });
  });

  describe("temporal-projection vocabulary sweep", () => {
    test("ensureTables deletes rows the vocabulary can no longer describe and keeps valid ones", async () => {
      // The CHECK constraint only guards tables created with it. An install
      // whose `_temporal_projections` predates the constraint can hold a
      // retired spelling, and DuckDB cannot add a CHECK to an existing table —
      // so the startup sweep is what reconciles it. Reproduce that shape by
      // replacing the table with an unconstrained copy before seeding.
      const sibling = `${TEST_DB}.sweep`;
      const sourceId = "calendar:local";
      const sibDb = new AnalyticsDb(sibling);
      await sibDb.open();
      await sibDb.ingestPage({
        tableName: projectedCalendarSchema.tableName,
        records: [
          {
            id: "evt-keep",
            title: "Quarterly review",
            start_time: "2026-07-23T09:00:00.000Z",
            end_time: "2026-07-23T10:00:00.000Z",
            all_day: false,
            eligible: true,
            status: "confirmed",
          },
        ],
        schema: projectedCalendarSchema,
        sourceId,
      });
      await sibDb.close();

      const { DuckDBInstance } = await import("@duckdb/node-api");
      const inst = await DuckDBInstance.create(sibling);
      const conn = await inst.connect();
      await conn.run(
        "CREATE TABLE _temporal_projections_legacy AS SELECT * FROM _temporal_projections",
      );
      await conn.run("DROP TABLE _temporal_projections");
      await conn.run("ALTER TABLE _temporal_projections_legacy RENAME TO _temporal_projections");
      await conn.run(`
        INSERT INTO _temporal_projections VALUES (
          'tp_retired', '${sourceId}', '${projectedCalendarSchema.tableName}',
          'evt-retired', 'calendar', 'evt-retired',
          ${Date.parse("2026-07-23T11:00:00.000Z")}, ${Date.parse("2026-07-23T12:00:00.000Z")},
          '2026-07-23T11:00:00.000Z', '2026-07-23T12:00:00.000Z',
          'instant', false, NULL, 'Retired spelling',
          'calendar_event', 'scheduled', 'active',
          NULL, NULL, '2026-07-23T08:00:00.000Z'
        )
      `);
      conn.closeSync();
      inst.closeSync();

      const reopened = new AnalyticsDb(sibling);
      await reopened.open();
      try {
        const rows = await reopened.queryTemporalProjections({
          fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
          toMs: Date.parse("2026-07-24T00:00:00.000Z"),
          limit: 10,
        });
        expect(rows.map((row) => row.id)).not.toContain("tp_retired");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          documentExternalId: "evt-keep",
          label: "Quarterly review",
          kind: "appointment",
        });
      } finally {
        await reopened.close();
        for (const path of [sibling, `${sibling}.wal`]) {
          try {
            unlinkSync(path);
          } catch {
            /* ignore */
          }
        }
      }
    });
  });

  describe("DECIMAL columns", () => {
    // Money rides records as validated decimal strings (never floats);
    // formatValue quotes them and DuckDB casts the literal exactly into
    // the DECIMAL column. Read-back goes through convertDuckDBValue's
    // DuckDBDecimalValue branch, which returns the exact scale-padded
    // string.
    const ledgerSchema: AnalyticsTableSchema = {
      tableName: "test_ledger",
      displayName: "Test Ledger",
      description: "Invented money rows for DECIMAL round-trip tests",
      columns: [
        { name: "id", type: "VARCHAR", description: "Row ID" },
        { name: "booked_on", type: "DATE", description: "Booking date" },
        { name: "amount", type: "DECIMAL(18,4)", description: "Signed amount", nullable: true },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: "booked_on",
      record: { titleColumns: ["id"], keyColumns: ["id", "booked_on", "amount"] },
    };

    const seedLedger = async () => {
      await db.ensureTable(ledgerSchema, "test-source:local");
      await db.insertRecords(
        "test_ledger",
        [
          { id: "t1", booked_on: "2024-03-01", amount: "123.45" },
          { id: "t2", booked_on: "2024-03-02", amount: "-23.40" },
          { id: "t3", booked_on: "2024-03-03", amount: null },
        ],
        ["id"],
      );
    };

    test("ColumnType accepts DECIMAL(p,s)", () => {
      // Type-level assertion: the template-literal member admits
      // "DECIMAL(18,4)" (the canonical no-space spelling — TS's
      // `${number}` placeholder is whitespace-lenient, so a spaced
      // spelling is a convention violation, not a type error).
      const decimal: ColumnType = "DECIMAL(18,4)";
      expect(decimal).toBe("DECIMAL(18,4)");
    });

    test("ensureTable creates the column as DECIMAL(18,4)", async () => {
      await db.ensureTable(ledgerSchema, "test-source:local");

      const info = await db.executeQuery(
        "SELECT data_type FROM information_schema.columns WHERE table_name = 'test_ledger' AND column_name = 'amount'",
      );
      expect(info.rowCount).toBe(1);
      expect(info.rows[0][0]).toBe("DECIMAL(18,4)");
    });

    test("string-carried amounts round-trip as exact scale-padded strings", async () => {
      await seedLedger();

      const result = await db.executeQuery("SELECT amount FROM test_ledger ORDER BY id");
      expect(result.rows.map((r) => r[0])).toEqual(["123.4500", "-23.4000", null]);
    });

    test("SUM over a DECIMAL column is exact", async () => {
      await seedLedger();

      const sum = await db.executeQuery("SELECT SUM(amount) FROM test_ledger");
      expect(sum.rows[0][0]).toBe("100.0500");
    });

    test("decimals inside a DuckDB list convert to exact strings", async () => {
      const result = await db.executeQuery(
        "SELECT [CAST('1.25' AS DECIMAL(18,4)), CAST('-0.50' AS DECIMAL(18,4))] AS amounts",
      );
      expect(result.rows[0][0]).toEqual(["1.2500", "-0.5000"]);
    });
  });
});

describe("AnalyticsDb — device streams", () => {
  const streamSchema: AnalyticsTableSchema = {
    tableName: "stream_metrics",
    displayName: "Stream metrics",
    description: "Per-device rows keyed alike on every device",
    columns: [
      { name: "id", type: "VARCHAR", description: "Row id, the same on every device" },
      { name: "value", type: "INTEGER", description: "Measured value", nullable: true },
    ],
    primaryKey: ["id"],
  };
  const sourceId = "stream-source:local";
  const columnsOf = async () =>
    (
      await db.executeQuery(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'stream_metrics' ORDER BY ordinal_position",
      )
    ).rows.map((row) => String(row[0]));
  const rowsOf = async () =>
    (
      await db.executeQuery(
        "SELECT id, value, _stream_id FROM stream_metrics ORDER BY id, _stream_id",
      )
    ).rows;
  const count = async () =>
    Number((await db.executeQuery("SELECT COUNT(*) FROM stream_metrics")).rows[0]?.[0]);

  test("a table only the empty stream writes to never gains the stream column", async () => {
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-1", value: 1 }],
      schema: streamSchema,
      sourceId,
      streamId: "",
    });
    expect(await columnsOf()).toEqual(["id", "value"]);
  });

  test("the first device stream keys the table by stream; namesake rows coexist and every mutation stays in its stream", async () => {
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-1", value: 1 }],
      schema: streamSchema,
      sourceId,
    });
    // Phone A's page rebuilds the table: the existing row joins the empty stream.
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [
        { id: "r-1", value: 10 },
        { id: "r-2", value: 20 },
      ],
      schema: streamSchema,
      sourceId,
      streamId: "device-a",
    });
    expect(await columnsOf()).toEqual(["id", "value", "_stream_id"]);
    expect(await rowsOf()).toEqual([
      ["r-1", 1, ""],
      ["r-1", 10, "device-a"],
      ["r-2", 20, "device-a"],
    ]);
    // Phone B's namesake rows land beside A's; an upsert updates B's copy only.
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [
        { id: "r-1", value: 100 },
        { id: "r-2", value: 200 },
      ],
      sourceId,
      streamId: "device-b",
    });
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-2", value: 201 }],
      sourceId,
      streamId: "device-b",
    });
    expect(await rowsOf()).toEqual([
      ["r-1", 1, ""],
      ["r-1", 10, "device-a"],
      ["r-1", 100, "device-b"],
      ["r-2", 20, "device-a"],
      ["r-2", 201, "device-b"],
    ]);
    // A's tombstone removes A's r-1 only; B's empty snapshot clears B's stream only.
    const tombstoned = await db.ingestPage({
      tableName: "stream_metrics",
      records: [],
      sourceId,
      deletedIds: ["r-1"],
      streamId: "device-a",
    });
    expect(tombstoned.deleted).toBe(1);
    const cleared = await ingestAndSweep(db, {
      tableName: "stream_metrics",
      records: [],
      sourceId,
      presentIds: [],
      streamId: "device-b",
    });
    expect(cleared.deleted).toBe(2);
    expect(await rowsOf()).toEqual([
      ["r-1", 1, ""],
      ["r-2", 20, "device-a"],
    ]);
    expect(await count()).toBe(2);
  });

  test("a schema that grows a column keeps the stream column", async () => {
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-1", value: 1 }],
      schema: streamSchema,
      sourceId,
      streamId: "device-a",
    });
    const grown: AnalyticsTableSchema = {
      ...streamSchema,
      columns: [
        ...streamSchema.columns,
        { name: "unit", type: "VARCHAR", description: "Unit of the value", nullable: true },
      ],
    };
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-2", value: 2, unit: "ms" }],
      schema: grown,
      sourceId,
      streamId: "device-a",
    });
    expect(await columnsOf()).toEqual(["id", "value", "_stream_id", "unit"]);
    expect(await count()).toBe(2);
  });

  test("bound-document bindings know which tables key by stream", async () => {
    const bound: AnalyticsTableSchema = {
      ...streamSchema,
      tableName: "stream_visits",
      boundDocument: { externalIdColumns: ["id"] },
    };
    await db.ingestPage({
      tableName: "stream_visits",
      records: [{ id: "visit-1", value: 1 }],
      schema: bound,
      sourceId,
    });
    let binding = (await db.getBoundDocumentBindings()).get("stream-source")?.[0];
    expect(binding?.streamKeyed).toBe(false);
    await db.ingestPage({
      tableName: "stream_visits",
      records: [{ id: "visit-1", value: 1 }],
      sourceId,
      streamId: "device-a",
    });
    binding = (await db.getBoundDocumentBindings()).get("stream-source")?.[0];
    expect(binding?.streamKeyed).toBe(true);
  });

  test("the rebuild keeps a column that schema evolution added at its live nullability", async () => {
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-1", value: 1 }],
      schema: streamSchema,
      sourceId,
    });
    // `unit` is declared non-nullable, but evolution adds it nullable and
    // never backfills r-1 — the rebuild must reproduce the table as it is.
    const grown: AnalyticsTableSchema = {
      ...streamSchema,
      columns: [
        ...streamSchema.columns,
        { name: "unit", type: "VARCHAR", description: "Unit of the value" },
      ],
    };
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-2", value: 2, unit: "ms" }],
      schema: grown,
      sourceId,
    });
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-3", value: 3, unit: "ms" }],
      sourceId,
      streamId: "device-a",
    });
    expect(
      (await db.executeQuery("SELECT id, unit, _stream_id FROM stream_metrics ORDER BY id")).rows,
    ).toEqual([
      ["r-1", null, ""],
      ["r-2", "ms", ""],
      ["r-3", "ms", "device-a"],
    ]);
  });

  test("the rebuilt primary key ends with the stream column and the catalog describes the table as it is", async () => {
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-1", value: 1 }],
      schema: streamSchema,
      sourceId,
    });
    const entryOf = async () =>
      (await db.getCatalog()).find((entry) => entry.tableName === "stream_metrics")!;
    let entry = await entryOf();
    expect(entry.streamKeyed).toBe(false);
    expect(entry.primaryKey).toEqual(["id"]);
    expect(entry.columns.map((column) => column.name)).toEqual(["id", "value"]);
    expect((await db.getRecordTableSchema("stream_metrics"))?.streamKeyed).toBe(false);

    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-1", value: 10 }],
      sourceId,
      streamId: "device-a",
    });
    const constraint = await db.executeQuery(
      "SELECT array_to_string(constraint_column_names, ',') FROM duckdb_constraints() WHERE table_name = 'stream_metrics' AND constraint_type = 'PRIMARY KEY'",
    );
    expect(constraint.rows).toEqual([["id,_stream_id"]]);
    entry = await entryOf();
    expect(entry.streamKeyed).toBe(true);
    expect(entry.primaryKey).toEqual(["id", "_stream_id"]);
    expect(entry.columns.map((column) => column.name)).toEqual(["id", "value", "_stream_id"]);
    expect((await db.getRecordTableSchema("stream_metrics"))?.streamKeyed).toBe(true);
  });

  test("recent rows page through two streams' namesake rows without skipping one", async () => {
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-1", value: 1 }],
      schema: streamSchema,
      sourceId,
      streamId: "device-a",
    });
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-1", value: 2 }],
      sourceId,
      streamId: "device-b",
    });
    const first = await db.getRecentRows("stream_metrics", 1);
    expect(first.rows).toHaveLength(1);
    const second = await db.getRecentRows("stream_metrics", 1, first.cursors[0]);
    expect(second.rows).toHaveLength(1);
    const streamAt = first.columns.indexOf("_stream_id");
    expect([first.rows[0][streamAt], second.rows[0][streamAt]].sort()).toEqual([
      "device-a",
      "device-b",
    ]);
  });

  test("insertRecords lands in the empty stream of a stream-keyed table", async () => {
    await db.ingestPage({
      tableName: "stream_metrics",
      records: [{ id: "r-1", value: 1 }],
      schema: streamSchema,
      sourceId,
      streamId: "device-a",
    });
    await db.insertRecords("stream_metrics", [{ id: "r-1", value: 5 }], ["id"]);
    await db.insertRecords("stream_metrics", [{ id: "r-1", value: 6 }], ["id"]);
    expect(await rowsOf()).toEqual([
      ["r-1", 6, ""],
      ["r-1", 1, "device-a"],
    ]);
  });

  test("a catalog created before tables could key by stream gains the flag on open", async () => {
    const legacyPath = `/tmp/omnesis-test-analytics-legacy-${crypto.randomUUID()}.db`;
    try {
      const legacy = new AnalyticsDb(legacyPath);
      await legacy.open();
      await legacy.ingestPage({
        tableName: "stream_metrics",
        records: [{ id: "r-1", value: 1 }],
        schema: streamSchema,
        sourceId,
      });
      await legacy.close();
      // Strip the column the way a catalog written by an older gateway lacks it.
      const raw = await DuckDBInstance.create(legacyPath);
      const conn = await raw.connect();
      await conn.run("ALTER TABLE _analytics_catalog DROP COLUMN stream_keyed");
      conn.closeSync();
      raw.closeSync();

      const upgraded = new AnalyticsDb(legacyPath);
      await upgraded.open();
      try {
        const entryOf = async () =>
          (await upgraded.getCatalog()).find((entry) => entry.tableName === "stream_metrics")!;
        expect((await entryOf()).streamKeyed).toBe(false);
        await upgraded.ingestPage({
          tableName: "stream_metrics",
          records: [{ id: "r-1", value: 10 }],
          sourceId,
          streamId: "device-a",
        });
        expect((await entryOf()).streamKeyed).toBe(true);
        expect(
          (
            await upgraded.executeQuery(
              "SELECT id, value, _stream_id FROM stream_metrics ORDER BY _stream_id",
            )
          ).rows,
        ).toEqual([
          ["r-1", 1, ""],
          ["r-1", 10, "device-a"],
        ]);
      } finally {
        await upgraded.close();
      }
    } finally {
      for (const suffix of ["", ".wal"]) {
        if (existsSync(legacyPath + suffix)) unlinkSync(legacyPath + suffix);
      }
    }
  });

  test("open repairs a false catalog flag when the physical primary key is already stream-keyed", async () => {
    const repairPath = `/tmp/omnesis-test-analytics-stream-repair-${crypto.randomUUID()}.db`;
    try {
      const original = new AnalyticsDb(repairPath);
      await original.open();
      await original.ingestPage({
        tableName: "stream_metrics",
        records: [{ id: "r-1", value: 1 }],
        schema: streamSchema,
        sourceId,
        streamId: "device-a",
      });
      await original.close();

      const raw = await DuckDBInstance.create(repairPath);
      const conn = await raw.connect();
      await conn.run(
        "UPDATE _analytics_catalog SET stream_keyed = false WHERE table_name = 'stream_metrics'",
      );
      conn.closeSync();
      raw.closeSync();

      const repaired = new AnalyticsDb(repairPath);
      await repaired.open();
      try {
        expect((await repaired.getRecordTableSchema("stream_metrics"))?.streamKeyed).toBe(true);
        await repaired.ingestPage({
          tableName: "stream_metrics",
          records: [{ id: "r-2", value: 2 }],
          sourceId,
          streamId: "device-b",
        });
        expect((await repaired.executeQuery("SELECT COUNT(*) FROM stream_metrics")).rows).toEqual([
          [2],
        ]);
      } finally {
        await repaired.close();
      }
    } finally {
      if (existsSync(repairPath)) unlinkSync(repairPath);
      if (existsSync(`${repairPath}.wal`)) unlinkSync(`${repairPath}.wal`);
    }
  });

  test("on a shared table a mutation stays in both its account and its stream", async () => {
    const shared: AnalyticsTableSchema = {
      ...streamSchema,
      tableName: "shared_stream_metrics",
      columns: [
        ...streamSchema.columns,
        { name: "account", type: "VARCHAR", description: "Account discriminator" },
      ],
      sharedDiscriminatorColumn: "account",
    };
    const rows = async () =>
      (
        await db.executeQuery(
          "SELECT id, account, _stream_id FROM shared_stream_metrics ORDER BY account, _stream_id",
        )
      ).rows;
    // Two accounts of one source type share the table; each writes its own
    // row id from two phones, so the namesakes are across phones only.
    for (const account of ["a1", "a2"]) {
      for (const streamId of ["device-a", "device-b"]) {
        await db.ingestPage({
          tableName: shared.tableName,
          records: [{ id: `r-${account}`, value: 1, account }],
          schema: shared,
          sourceId: `stream-source:${account}`,
          streamId,
        });
      }
    }
    expect(await rows()).toHaveLength(4);

    // a2's phone-A tombstone removes a2's phone-A row only.
    const tombstoned = await db.ingestPage({
      tableName: shared.tableName,
      records: [],
      sourceId: "stream-source:a2",
      deletedIds: ["r-a2"],
      streamId: "device-a",
    });
    expect(tombstoned.deleted).toBe(1);
    expect(await rows()).toEqual([
      ["r-a1", "a1", "device-a"],
      ["r-a1", "a1", "device-b"],
      ["r-a2", "a2", "device-b"],
    ]);

    // a1's shared-stream snapshot clears a1's shared stream only, which holds nothing.
    const cleared = await ingestAndSweep(db, {
      tableName: shared.tableName,
      records: [],
      sourceId: "stream-source:a1",
      presentIds: [],
      streamId: "",
    });
    expect(cleared.deleted).toBe(0);
    // a1's phone-B snapshot naming nothing clears a1's phone-B row only.
    const clearedB = await ingestAndSweep(db, {
      tableName: shared.tableName,
      records: [],
      sourceId: "stream-source:a1",
      presentIds: [],
      streamId: "device-b",
    });
    expect(clearedB.deleted).toBe(1);
    expect(await rows()).toEqual([
      ["r-a1", "a1", "device-a"],
      ["r-a2", "a2", "device-b"],
    ]);
  });

  test("a projection derived before the table keyed by stream keeps its key; a device's projection is its own", async () => {
    const schema: AnalyticsTableSchema = {
      ...projectedCalendarSchema,
      tableName: "stream_calendar_events",
    };
    const calendarSource = "calendar:local";
    const row = {
      id: "evt-1",
      title: "Planning",
      start_time: "2026-07-23T09:00:00.000Z",
      end_time: "2026-07-23T10:00:00.000Z",
      all_day: false,
      eligible: true,
      status: "confirmed",
    };
    const window = {
      fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
      toMs: Date.parse("2026-07-24T00:00:00.000Z"),
      limit: 10,
    };
    await db.ingestPage({
      tableName: schema.tableName,
      records: [row],
      schema,
      sourceId: calendarSource,
    });
    const [before] = await db.queryTemporalProjections(window);

    await db.ingestPage({
      tableName: schema.tableName,
      records: [{ ...row, title: "Planning on the phone" }],
      sourceId: calendarSource,
      streamId: "device-a",
    });
    const after = await db.queryTemporalProjections(window);
    expect(after.map((projection) => projection.label).sort()).toEqual([
      "Planning",
      "Planning on the phone",
    ]);
    expect(after.find((projection) => projection.label === "Planning")?.id).toBe(before.id);

    // The shared stream's tombstone removes its projection only.
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId: calendarSource,
      deletedIds: ["evt-1"],
      streamId: "",
    });
    expect(
      (await db.queryTemporalProjections(window)).map((projection) => projection.label),
    ).toEqual(["Planning on the phone"]);

    // Writing the shared row again updates the projection it had, under the same id.
    await db.ingestPage({
      tableName: schema.tableName,
      records: [{ ...row, title: "Planning again" }],
      sourceId: calendarSource,
    });
    const final = await db.queryTemporalProjections(window);
    expect(final.map((projection) => projection.label).sort()).toEqual([
      "Planning again",
      "Planning on the phone",
    ]);
    expect(final.find((projection) => projection.label === "Planning again")?.id).toBe(before.id);
  });
});

describe("AnalyticsDb — stream removal", () => {
  const sourceId = "calendar:local";
  const window = {
    fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
    toMs: Date.parse("2026-07-24T00:00:00.000Z"),
    limit: 20,
  };
  const event = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    title: `Event ${id}`,
    start_time: "2026-07-23T09:00:00.000Z",
    end_time: "2026-07-23T10:00:00.000Z",
    all_day: false,
    eligible: true,
    status: "confirmed",
    ...extra,
  });
  const ingest = (
    streamId: string,
    ids: string[],
    schema = projectedCalendarSchema,
    source = sourceId,
  ) =>
    db.ingestPage({
      tableName: schema.tableName,
      records: ids.map((id) =>
        event(id, schema.sharedDiscriminatorColumn ? { source_account: source.split(":")[1] } : {}),
      ),
      schema,
      sourceId: source,
      streamId,
    });
  const rowsOf = async (table: string) =>
    (await db.executeQuery(`SELECT id, _stream_id FROM ${table} ORDER BY id, _stream_id`)).rows;

  test("removes one stream's rows and projections from an owned table; the siblings, the table and its catalog row stay", async () => {
    await ingest("device-a", ["evt-1", "evt-2"]);
    await ingest("device-b", ["evt-1", "evt-3"]);
    await ingest("", ["evt-0"]);
    expect(await db.queryTemporalProjections(window)).toHaveLength(5);

    const cleaned = await db.deleteAnalyticsStream(sourceId, "device-a");

    expect(cleaned).toEqual([projectedCalendarSchema.tableName]);
    expect(await rowsOf(projectedCalendarSchema.tableName)).toEqual([
      ["evt-0", ""],
      ["evt-1", "device-b"],
      ["evt-3", "device-b"],
    ]);
    const projections = await db.queryTemporalProjections(window);
    expect(projections.map((p) => p.documentExternalId).sort()).toEqual([
      "evt-0",
      "evt-1",
      "evt-3",
    ]);
    const entry = (await db.getCatalog()).find(
      (e) => e.tableName === projectedCalendarSchema.tableName,
    );
    expect(entry?.recordCount).toBe(3);
    expect(entry?.sourceId).toBe(sourceId);
    // The stream writes again into the same table.
    await ingest("device-a", ["evt-9"]);
    expect(await rowsOf(projectedCalendarSchema.tableName)).toHaveLength(4);
  });

  test("scopes a shared table by account and stream: a sibling account's namesake stream is untouched", async () => {
    const accountA = "google-calendar:alpha@example.com";
    const accountB = "google-calendar:beta@example.com";
    const table = sharedProjectedCalendarSchema.tableName;
    await ingest("device-a", ["evt-1"], sharedProjectedCalendarSchema, accountA);
    await ingest("device-b", ["evt-2"], sharedProjectedCalendarSchema, accountA);
    await ingest("device-a", ["evt-3"], sharedProjectedCalendarSchema, accountB);
    expect(await rowsOf(table)).toHaveLength(3);

    expect(await db.deleteAnalyticsStream(accountA, "device-a")).toEqual([table]);

    expect(
      (await db.executeQuery(`SELECT id, source_account, _stream_id FROM ${table} ORDER BY id`))
        .rows,
    ).toEqual([
      ["evt-2", "alpha@example.com", "device-b"],
      ["evt-3", "beta@example.com", "device-a"],
    ]);
    expect(
      (await db.queryTemporalProjections(window)).map((p) => p.documentExternalId).sort(),
    ).toEqual(["evt-2", "evt-3"]);
  });

  test("leaves a stream-keyed table the stream never wrote to alone", async () => {
    await ingest("device-a", ["evt-1"]);
    await ingest("device-b", ["evt-2"], sharedProjectedCalendarSchema);

    expect(await db.deleteAnalyticsStream(sourceId, "device-a")).toEqual([
      projectedCalendarSchema.tableName,
    ]);

    expect(await rowsOf(sharedProjectedCalendarSchema.tableName)).toEqual([["evt-2", "device-b"]]);
    expect(await rowsOf(projectedCalendarSchema.tableName)).toEqual([]);
  });

  test("leaves a table only the empty stream ever wrote to alone", async () => {
    await ingest("", ["evt-0"]);

    expect(await db.deleteAnalyticsStream(sourceId, "device-a")).toEqual([]);

    expect(
      (await db.executeQuery(`SELECT id FROM ${projectedCalendarSchema.tableName}`)).rows,
    ).toEqual([["evt-0"]]);
    expect(await db.queryTemporalProjections(window)).toHaveLength(1);
  });
});

describe("AnalyticsDb — exclusive to partitioned adoption", () => {
  const sourceId = "calendar:fictional";
  const owner = "device-owner";
  const event = (id: string, account?: string): Record<string, unknown> => ({
    id,
    ...(account ? { source_account: account } : {}),
    title: `Event ${id}`,
    start_time: "2026-07-23T09:00:00.000Z",
    end_time: "2026-07-23T10:00:00.000Z",
    all_day: false,
    eligible: true,
    status: "confirmed",
  });

  test("adopts shared rows, absences, observations, and temporal projections into the owner stream", async () => {
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [event("evt-1"), event("evt-2")],
      schema: projectedCalendarSchema,
      sourceId,
    });
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [],
      sourceId,
      presentIds: ["evt-1"],
      observationId: "snapshot-before-adoption",
      absencePolicy: IMMEDIATE_ABSENCE_POLICY,
    });
    expect((await db.getBoundDocumentBindings()).get("calendar")?.[0]?.streamKeyed).toBe(false);

    await db.adoptExclusiveToPartitioned(sourceId, owner);

    expect(
      (
        await db.executeQuery(
          `SELECT id, _stream_id FROM ${projectedCalendarSchema.tableName} ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      ["evt-1", owner],
      ["evt-2", owner],
    ]);
    expect(
      (
        await db.executeQuery(
          "SELECT stream_id FROM _analytics_absences WHERE source_id = $source",
          { params: { source: sourceId } },
        )
      ).rows,
    ).toEqual([[owner]]);
    expect(
      (
        await db.executeQuery(
          "SELECT stream_id FROM _analytics_absence_scopes WHERE source_id = $source",
          { params: { source: sourceId } },
        )
      ).rows,
    ).toEqual([[owner]]);
    expect(
      (
        await db.executeQuery(
          "SELECT stream_id FROM _analytics_absence_observations WHERE source_id = $source",
          { params: { source: sourceId } },
        )
      ).rows,
    ).toEqual([[owner]]);
    const projections = await db.queryTemporalProjections({
      fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
      toMs: Date.parse("2026-07-24T00:00:00.000Z"),
    });
    expect(projections).toHaveLength(2);
    expect(projections.every((projection) => projection.recordKey.includes(owner))).toBe(true);
    expect(new Set(projections.map((projection) => projection.id)).size).toBe(2);
    expect((await db.getBoundDocumentBindings()).get("calendar")?.[0]?.streamKeyed).toBe(true);
    const adoptedProjectionId = projections.find(
      (projection) => projection.documentExternalId === "evt-1",
    )?.id;
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [event("evt-1")],
      sourceId,
      streamId: owner,
    });
    expect(
      (
        await db.queryTemporalProjections({
          fromMs: Date.parse("2026-07-23T00:00:00.000Z"),
          toMs: Date.parse("2026-07-24T00:00:00.000Z"),
        })
      ).find((projection) => projection.documentExternalId === "evt-1")?.id,
    ).toBe(adoptedProjectionId);

    // The owner's first partitioned snapshot reaches the adopted history.
    expect(
      await ingestAndSweep(db, {
        tableName: projectedCalendarSchema.tableName,
        records: [],
        sourceId,
        streamId: owner,
        presentIds: ["evt-1"],
        observationId: "owner-snapshot",
      }),
    ).toMatchObject({ deleted: 1 });
    // An explicit owner tombstone reaches the remaining adopted row too.
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [],
      sourceId,
      streamId: owner,
      deletedIds: ["evt-1"],
    });
    expect(
      (await db.executeQuery(`SELECT COUNT(*) FROM ${projectedCalendarSchema.tableName}`)).rows,
    ).toEqual([[0]]);
  });

  test("uses the shared discriminator so a sibling account remains on the shared stream", async () => {
    const sourceA = "google-calendar:alpha@example.com";
    const sourceB = "google-calendar:beta@example.com";
    await db.ingestPage({
      tableName: sharedProjectedCalendarSchema.tableName,
      records: [event("evt-a", "alpha@example.com")],
      schema: sharedProjectedCalendarSchema,
      sourceId: sourceA,
    });
    await db.ingestPage({
      tableName: sharedProjectedCalendarSchema.tableName,
      records: [event("evt-b", "beta@example.com")],
      schema: sharedProjectedCalendarSchema,
      sourceId: sourceB,
    });
    const delayedAbsence = { minObservations: 2, minAgeMs: 60_000, maxMarksPerSnapshot: 100 };
    await db.ingestPage({
      tableName: sharedProjectedCalendarSchema.tableName,
      records: [],
      sourceId: sourceA,
      presentIds: [],
      observationId: "snapshot-alpha",
      absencePolicy: delayedAbsence,
    });
    await db.ingestPage({
      tableName: sharedProjectedCalendarSchema.tableName,
      records: [],
      sourceId: sourceB,
      presentIds: [],
      observationId: "snapshot-beta",
      absencePolicy: delayedAbsence,
    });

    await db.adoptExclusiveToPartitioned(sourceA, owner);

    expect(
      (
        await db.executeQuery(
          `SELECT id, source_account, _stream_id FROM ${sharedProjectedCalendarSchema.tableName} ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      ["evt-a", "alpha@example.com", owner],
      ["evt-b", "beta@example.com", ""],
    ]);
    for (const ledger of [
      "_analytics_absences",
      "_analytics_absence_scopes",
      "_analytics_absence_observations",
    ]) {
      expect(
        (
          await db.executeQuery(
            `SELECT source_id, stream_id FROM ${ledger}
              WHERE table_name = $table ORDER BY source_id`,
            { params: { table: sharedProjectedCalendarSchema.tableName } },
          )
        ).rows,
      ).toEqual([
        [sourceA, owner],
        [sourceB, ""],
      ]);
    }
    expect(
      (
        await db.executeQuery(
          `SELECT source_id,
                  coalesce(json_extract_string(record_key, '$._stream_id'), '') AS stream_id
             FROM _temporal_projections
            WHERE table_name = $table ORDER BY source_id`,
          { params: { table: sharedProjectedCalendarSchema.tableName } },
        )
      ).rows,
    ).toEqual([
      [sourceA, owner],
      [sourceB, ""],
    ]);
  });

  test("fails closed when the source already has ambiguous mixed streams", async () => {
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [event("evt-owner")],
      schema: projectedCalendarSchema,
      sourceId,
      streamId: owner,
    });
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [event("evt-shared")],
      sourceId,
      streamId: "",
    });

    await expect(db.adoptExclusiveToPartitioned(sourceId, owner)).rejects.toThrow(
      /ambiguous.*streams/i,
    );
    expect(
      (
        await db.executeQuery(
          `SELECT id, _stream_id FROM ${projectedCalendarSchema.tableName} ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      ["evt-owner", owner],
      ["evt-shared", ""],
    ]);
  });

  test("refuses a shared catalog table with no source discriminator", async () => {
    const sourceA = "calendar:account-a";
    const sourceB = "calendar:account-b";
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [event("evt-a")],
      schema: projectedCalendarSchema,
      sourceId: sourceA,
    });
    await db.ingestPage({
      tableName: projectedCalendarSchema.tableName,
      records: [event("evt-b")],
      schema: projectedCalendarSchema,
      sourceId: sourceB,
    });

    await expect(db.adoptExclusiveToPartitioned(sourceA, owner)).rejects.toThrow(
      /sharedDiscriminatorColumn/,
    );
    expect(
      (await db.executeQuery(`SELECT id FROM ${projectedCalendarSchema.tableName} ORDER BY id`))
        .rows,
    ).toEqual([["evt-a"], ["evt-b"]]);
  });

  test("fails closed before rebuilding a table above the configured online admission ceiling", async () => {
    const limitedPath = `/tmp/omnesis-transition-admission-${crypto.randomUUID()}.duckdb`;
    const limited = new AnalyticsDb(limitedPath, { maxInlineStreamRekeyRows: 1 });
    await limited.open();
    try {
      await limited.ingestPage({
        tableName: projectedCalendarSchema.tableName,
        records: [event("evt-1"), event("evt-2")],
        schema: projectedCalendarSchema,
        sourceId,
      });

      await expect(limited.adoptExclusiveToPartitioned(sourceId, owner)).rejects.toThrow(
        /2 rows.*configured online limit of 1/i,
      );
      expect(
        (
          await limited.executeQuery(
            `SELECT id FROM ${projectedCalendarSchema.tableName} ORDER BY id`,
          )
        ).rows,
      ).toEqual([["evt-1"], ["evt-2"]]);
      expect(
        (
          await limited.executeQuery(
            `SELECT COUNT(*) FROM information_schema.columns WHERE table_name = '${projectedCalendarSchema.tableName}' AND column_name = '_stream_id'`,
          )
        ).rows,
      ).toEqual([[0]]);
    } finally {
      await limited.close();
      if (existsSync(limitedPath)) unlinkSync(limitedPath);
      if (existsSync(`${limitedPath}.wal`)) unlinkSync(`${limitedPath}.wal`);
    }
  });

  test("invalidates bound-document bindings after a later table fails adoption", async () => {
    const partialPath = `/tmp/omnesis-transition-partial-${crypto.randomUUID()}.duckdb`;
    const partial = new AnalyticsDb(partialPath);
    await partial.open();
    try {
      const firstSchema = { ...projectedCalendarSchema, tableName: "partial_calendar_alpha" };
      const secondSchema = { ...projectedCalendarSchema, tableName: "partial_calendar_beta" };
      for (const [schema, id] of [
        [firstSchema, "evt-alpha"],
        [secondSchema, "evt-beta"],
      ] as const) {
        await partial.ingestPage({
          tableName: schema.tableName,
          records: [event(id)],
          schema,
          sourceId,
        });
      }
      expect(
        (await partial.getBoundDocumentBindings())
          .get("calendar")
          ?.every((binding) => !binding.streamKeyed),
      ).toBe(true);

      type EnsureStreamScope = (
        ...args: unknown[]
      ) => Promise<{ streamKeyed: boolean; rebuilt: boolean }>;
      const manager = (
        partial as unknown as {
          tables: { ensureStreamScope: EnsureStreamScope };
        }
      ).tables;
      const ensureStreamScope = manager.ensureStreamScope.bind(manager);
      let calls = 0;
      manager.ensureStreamScope = async (...args) => {
        calls += 1;
        if (calls === 2) throw new Error("synthetic second-table adoption failure");
        return ensureStreamScope(...args);
      };

      await expect(partial.adoptExclusiveToPartitioned(sourceId, owner)).rejects.toThrow(
        /synthetic second-table adoption failure/,
      );
      const keyedTable = String(
        (
          await partial.executeQuery(
            "SELECT table_name FROM _analytics_catalog WHERE stream_keyed = true",
          )
        ).rows[0]?.[0],
      );
      expect(
        (await partial.getBoundDocumentBindings())
          .get("calendar")
          ?.find((binding) => binding.tableName === keyedTable)?.streamKeyed,
      ).toBe(true);
    } finally {
      await partial.close();
      if (existsSync(partialPath)) unlinkSync(partialPath);
      if (existsSync(`${partialPath}.wal`)) unlinkSync(`${partialPath}.wal`);
    }
  });

  test("checks each table only inside its bounded adoption writer call", async () => {
    const firstSchema = { ...projectedCalendarSchema, tableName: "bounded_calendar_alpha" };
    const secondSchema = { ...projectedCalendarSchema, tableName: "bounded_calendar_beta" };
    for (const [schema, id] of [
      [firstSchema, "evt-alpha"],
      [secondSchema, "evt-beta"],
    ] as const) {
      await db.ingestPage({
        tableName: schema.tableName,
        records: [event(id)],
        schema,
        sourceId,
      });
    }

    type AssertAdoptionState = (...args: unknown[]) => Promise<void>;
    const manager = (
      db as unknown as {
        tables: { assertAdoptionState: AssertAdoptionState };
      }
    ).tables;
    const assertAdoptionState = manager.assertAdoptionState.bind(manager);
    let checks = 0;
    manager.assertAdoptionState = async (...args) => {
      checks += 1;
      await assertAdoptionState(...args);
    };

    await db.adoptExclusiveToPartitioned(sourceId, owner);

    expect(checks).toBe(2);
  });

  test("admits a table exactly at the configured online ceiling", async () => {
    const limitedPath = `/tmp/omnesis-transition-admission-boundary-${crypto.randomUUID()}.duckdb`;
    const limited = new AnalyticsDb(limitedPath, { maxInlineStreamRekeyRows: 2 });
    await limited.open();
    try {
      await limited.ingestPage({
        tableName: projectedCalendarSchema.tableName,
        records: [event("evt-1"), event("evt-2")],
        schema: projectedCalendarSchema,
        sourceId,
      });

      await expect(limited.adoptExclusiveToPartitioned(sourceId, owner)).resolves.toEqual([
        projectedCalendarSchema.tableName,
      ]);
      expect(
        (
          await limited.executeQuery(
            `SELECT id, _stream_id FROM ${projectedCalendarSchema.tableName} ORDER BY id`,
          )
        ).rows,
      ).toEqual([
        ["evt-1", owner],
        ["evt-2", owner],
      ]);
    } finally {
      await limited.close();
      if (existsSync(limitedPath)) unlinkSync(limitedPath);
      if (existsSync(`${limitedPath}.wal`)) unlinkSync(`${limitedPath}.wal`);
    }
  });
});

describe("AnalyticsDb — internal tables", () => {
  test("every table the plane creates for itself is on the exclusion list", async () => {
    // The CSV export walks the database as a corpus. A bookkeeping table the
    // exclusion list has not heard of leaks into the operator's export, and the
    // only thing that notices is whichever test happens to enumerate tables —
    // which is how `_analytics_absences` first got out. Ask the database what
    // it has instead of trusting the literal.
    await db.ingestPage({
      tableName: testSchema.tableName,
      records: [],
      schema: testSchema,
      sourceId: "fictional:local",
    });
    const rows = await db.executeQuery(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name",
    );
    const internal = rows.rows
      .map((r) => String(r[0]))
      .filter((name) => name.startsWith("_"))
      .sort();
    expect(internal).toEqual([...ANALYTICS_INTERNAL_TABLES].sort());
  });
});

describe("AnalyticsDb — snapshot absence", () => {
  const sourceId = "apple-health:local";
  const schema: AnalyticsTableSchema = {
    ...testSchema,
    tableName: "absence_samples",
    displayName: "Absence samples",
  };

  /** The shipped policy: three corroborating snapshots spanning a day. */
  const POLICY = { minObservations: 3, minAgeMs: 24 * 60 * 60_000, maxMarksPerSnapshot: 10_000 };

  const row = (id: string): Record<string, unknown> => ({
    id,
    date: "2026-07-23",
    metric_type: "steps",
    value: 1200,
    unit: "count",
  });

  async function ids(): Promise<string[]> {
    const result = await db.executeQuery(`SELECT id FROM ${schema.tableName} ORDER BY id`);
    return result.rows.map((r) => String(r[0]));
  }

  beforeEach(async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [row("s-1"), row("s-2"), row("s-3")],
      schema,
      sourceId,
    });
  });

  test("a snapshot that omits rows records their absence and deletes nothing", async () => {
    const result = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: ["s-1"],
      absencePolicy: POLICY,
    });

    expect(result.deleted).toBe(0);
    expect(result.absence).toMatchObject({ marked: 2, absent: 2, stored: 3, snapshot: 1 });
    expect(await ids()).toEqual(["s-1", "s-2", "s-3"]);
    // And nothing is due, so a sweep running right now would take nothing.
    expect(await db.dueAbsences({ dueBefore: Date.now(), minObservations: 3, limit: 100 })).toEqual(
      [],
    );
  });

  test("an empty snapshot from an impoverished read costs a delay, not the table", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: POLICY,
    });
    expect(await ids()).toEqual(["s-1", "s-2", "s-3"]);
  });

  test("a snapshot naming the rows again revokes their absence", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: POLICY,
    });
    const recovered = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: ["s-1", "s-2", "s-3"],
      absencePolicy: POLICY,
    });

    expect(recovered.absence).toMatchObject({ cleared: 3, absent: 0 });
    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 }),
    ).toEqual([]);
  });

  test("an arriving row revokes its pending absence without requiring a new snapshot", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: POLICY,
    });

    await db.ingestPage({
      tableName: schema.tableName,
      records: [row("s-2")],
      sourceId,
    });

    const pending = await db.dueAbsences({
      dueBefore: Date.now() + 1,
      minObservations: 1,
      limit: 100,
    });
    expect(pending.map((absence) => absence.keyValue).sort()).toEqual(["s-1", "s-3"]);
  });

  test("a snapshot planned before an arriving row cannot re-mark that row", async () => {
    const immediate = { ...POLICY, minObservations: 1, minAgeMs: 0 };
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: ["s-1", "s-3"],
      absencePolicy: immediate,
      observationId: "initial-omission",
    });

    const pool = (db as any).pool;
    const tables = (db as any).tables;
    const originalSerialize = pool.serializeWrite.bind(pool);
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let planned!: () => void;
    const planReady = new Promise<void>((resolve) => {
      planned = resolve;
    });
    let intercepted = false;
    pool.serializeWrite = async (fn: () => Promise<unknown>) => {
      if (!intercepted) {
        intercepted = true;
        planned();
        await writerGate;
      }
      return originalSerialize(fn);
    };

    try {
      const stale = tables.reconcileSnapshot({
        sourceId,
        tableName: schema.tableName,
        presentIds: ["s-1", "s-3"],
        absencePolicy: immediate,
        observationId: "stale-omission",
      });
      await planReady;
      await db.ingestPage({ tableName: schema.tableName, records: [row("s-2")], sourceId });
      releaseWriter();
      await expect(stale).resolves.toMatchObject({ marked: 0, cleared: 0 });
    } finally {
      releaseWriter();
      pool.serializeWrite = originalSerialize;
    }

    expect(
      (
        await db.dueAbsences({
          dueBefore: Date.now() + 1,
          minObservations: 1,
          limit: 100,
        })
      ).map((absence) => absence.keyValue),
    ).not.toContain("s-2");
    expect(await ids()).toContain("s-2");

    // The stable id belongs to the old snapshot. Retrying that exact
    // observation after the arrival must not replan its older omission and
    // turn it into evidence against the newer row.
    await expect(
      tables.reconcileSnapshot({
        sourceId,
        tableName: schema.tableName,
        presentIds: ["s-1", "s-3"],
        absencePolicy: immediate,
        observationId: "stale-omission",
      }),
    ).resolves.toMatchObject({ marked: 0, cleared: 0 });
    expect(
      (
        await db.dueAbsences({
          dueBefore: Date.now() + 1,
          minObservations: 1,
          limit: 100,
        })
      ).map((absence) => absence.keyValue),
    ).not.toContain("s-2");
  });

  test("source cleanup tombstones an implicit scope before a stale plan can apply", async () => {
    const pool = (db as any).pool;
    const tables = (db as any).tables;
    // Model an upgraded table that predates the scope ledger: planning sees
    // the implicit 0/0 scope even though the source already has rows.
    await pool.withConn(async ({ conn }: any) => {
      await conn.run(
        `DELETE FROM _analytics_absence_scopes WHERE source_id = '${sourceId}' AND table_name = '${schema.tableName}' AND stream_id = ''`,
      );
    });

    const originalSerialize = pool.serializeWrite.bind(pool);
    let releaseWriter!: () => void;
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let planned!: () => void;
    const planReady = new Promise<void>((resolve) => {
      planned = resolve;
    });
    let intercepted = false;
    pool.serializeWrite = async (fn: () => Promise<unknown>) => {
      if (!intercepted) {
        intercepted = true;
        planned();
        await writerGate;
      }
      return originalSerialize(fn);
    };

    try {
      const stale = tables.reconcileSnapshot({
        sourceId,
        tableName: schema.tableName,
        presentIds: [],
        absencePolicy: POLICY,
        observationId: "before-source-cleanup",
      });
      await planReady;
      await db.deleteAnalyticsForSource(sourceId);
      releaseWriter();
      await expect(stale).resolves.toMatchObject({ marked: 0, cleared: 0 });
    } finally {
      releaseWriter();
      pool.serializeWrite = originalSerialize;
    }

    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 }),
    ).toEqual([]);
    await db.ingestPage({
      tableName: schema.tableName,
      records: [row("s-new")],
      schema,
      sourceId,
    });
    expect(await ids()).toEqual(["s-new"]);
  });

  test("duplicate delivery of one completed snapshot adds no second observation", async () => {
    const noSpacing = { ...POLICY, minAgeMs: 0 };
    const snapshot = {
      tableName: schema.tableName,
      records: [] as Record<string, unknown>[],
      sourceId,
      presentIds: ["s-1"],
      absencePolicy: noSpacing,
      observationId: "epoch-7:attempt-a",
    };
    await db.ingestPage(snapshot);
    await db.ingestPage(snapshot);

    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 2, limit: 100 }),
    ).toEqual([]);

    await db.ingestPage({ ...snapshot, observationId: "epoch-8:attempt-b" });
    expect(
      (
        await db.dueAbsences({
          dueBefore: Date.now() + 1,
          minObservations: 2,
          limit: 100,
        })
      ).map((candidate) => candidate.keyValue),
    ).toEqual(["s-2", "s-3"]);
  });

  test("duplicate delivery cannot consume a second fresh-mark tranche", async () => {
    const snapshot = {
      tableName: schema.tableName,
      records: [] as Record<string, unknown>[],
      sourceId,
      presentIds: [] as string[],
      absencePolicy: { ...POLICY, maxMarksPerSnapshot: 1 },
      observationId: "epoch-9:attempt-c",
    };
    await db.ingestPage(snapshot);
    await db.ingestPage(snapshot);

    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 }),
    ).toHaveLength(1);
  });

  test("a recovery larger than the cap invalidates the whole active scope at once", async () => {
    const extra = Array.from({ length: 202 }, (_, index) => row(`bulk-${index}`));
    await db.ingestPage({
      tableName: schema.tableName,
      records: extra,
      sourceId,
    });
    const allIds = ["s-1", "s-2", "s-3", ...extra.map((entry) => String(entry.id))];
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: { ...POLICY, maxMarksPerSnapshot: allIds.length },
      observationId: "mark-all",
    });
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: { ...POLICY, maxMarksPerSnapshot: allIds.length },
      observationId: "mark-remainder",
    });

    const first = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: allIds,
      absencePolicy: { ...POLICY, maxMarksPerSnapshot: 200 },
      observationId: "recover-1",
    });
    expect(first.absence?.cleared).toBe(allIds.length);
    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 500 }),
    ).toEqual([]);

    const duplicate = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: allIds,
      absencePolicy: { ...POLICY, maxMarksPerSnapshot: 200 },
      observationId: "recover-1",
    });
    expect(duplicate.absence).toMatchObject({ marked: 0, cleared: 0 });
    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 500 }),
    ).toEqual([]);
  });

  test("the ids a snapshot names that the table does not hold are counted", async () => {
    const result = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: ["s-1", "s-2", "s-3", "s-4", "s-5"],
      absencePolicy: POLICY,
    });
    expect(result.absence).toMatchObject({ missing: 2, stored: 3, absent: 0 });
  });

  test("a still-absent row outside the mark cap keeps its deadline", async () => {
    // The absent keys one snapshot reports are capped. Reappearance must be
    // decided against the snapshot itself: a mark that merely fell outside the
    // cap is still absent, and clearing it would hand the deadline back for the
    // wrong reason — the source never said the row was there.
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: POLICY,
    });
    const pending = async () =>
      (await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 }))
        .map((d) => d.keyValue)
        .sort();
    expect(await pending()).toEqual(["s-1", "s-2", "s-3"]);

    // The same empty snapshot again, with room to re-assert only one of them.
    const capped = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: { ...POLICY, maxMarksPerSnapshot: 1 },
    });

    expect(capped.absence).toMatchObject({ cleared: 0, absent: 3, deferred: 2 });
    expect(await pending()).toEqual(["s-1", "s-2", "s-3"]);
  });

  test("a capped snapshot starts the next tranche before revisiting pending rows", async () => {
    const cappedPolicy = { ...POLICY, maxMarksPerSnapshot: 1 };
    const pending = async () =>
      (
        await db.dueAbsences({
          dueBefore: Date.now() + 1,
          minObservations: 1,
          limit: 100,
        })
      )
        .map((d) => d.keyValue)
        .sort();

    const first = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: cappedPolicy,
    });
    expect(first.absence).toMatchObject({ marked: 1, deferred: 2 });
    expect(await pending()).toHaveLength(1);

    // The first mark is too recent to count as another observation. The cap
    // must go to an unmarked omission instead of selecting that row again and
    // making no progress through the table.
    const second = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: cappedPolicy,
    });
    expect(second.absence).toMatchObject({ marked: 1, deferred: 2 });
    expect(await pending()).toHaveLength(2);
  });

  test("a row the snapshot names again is revoked even while others stay absent", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: POLICY,
    });

    const recovered = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: ["s-2"],
      absencePolicy: POLICY,
    });

    expect(recovered.absence).toMatchObject({ cleared: 1, absent: 2 });
    const pending = (
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 })
    ).map((d) => d.keyValue);
    expect(pending.sort()).toEqual(["s-1", "s-3"]);
  });

  test("a page without a policy records nothing rather than deleting on the spot", async () => {
    // A caller that did not state the policy gets the safe reading, never the
    // old one: the snapshot is inert, not authoritative.
    const result = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
    });
    expect(result.deleted).toBe(0);
    expect(result.absence).toBeUndefined();
    expect(await ids()).toEqual(["s-1", "s-2", "s-3"]);
  });

  test("once the deadline is spent the sweep deletes the rows and forgets them", async () => {
    await ingestAndSweep(db, {
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: ["s-1"],
    });
    expect(await ids()).toEqual(["s-1"]);
    // The absences went with the rows, so a second sweep finds nothing.
    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 }),
    ).toEqual([]);
  });

  test("one fan-out absence deletes at most 200 physical rows per writer transaction", async () => {
    const fanoutSchema: AnalyticsTableSchema = {
      ...schema,
      tableName: "absence_fanout_samples",
      columns: [
        { name: "record_id", type: "VARCHAR", description: "Upstream record" },
        { name: "sample_index", type: "BIGINT", description: "Sample index" },
      ],
      primaryKey: ["record_id", "sample_index"],
      semanticTimeColumn: null,
      record: { titleColumns: ["record_id"], keyColumns: ["record_id", "sample_index"] },
    };
    await db.ingestPage({
      tableName: fanoutSchema.tableName,
      records: Array.from({ length: 205 }, (_, sample_index) => ({
        record_id: "record-a",
        sample_index,
      })),
      schema: fanoutSchema,
      sourceId,
    });
    await db.ingestPage({
      tableName: fanoutSchema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      deleteKeyColumn: "record_id",
      absencePolicy: { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 200 },
      observationId: "fanout-missing",
    });
    const due = await db.dueAbsences({
      dueBefore: Date.now() + 1,
      minObservations: 1,
      limit: 10,
    });

    expect(await db.deleteAbsentRecords(due)).toMatchObject({ deleted: 200 });
    expect(
      (await db.executeQuery(`SELECT COUNT(*) FROM ${fanoutSchema.tableName}`)).rows[0]?.[0],
    ).toBe(5);
    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 }),
    ).toHaveLength(1);

    expect(await db.deleteAbsentRecords(due)).toMatchObject({ deleted: 5 });
    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 }),
    ).toEqual([]);
  });

  test("an arriving composite-key row clears its explicit logical-key absence", async () => {
    const fanoutSchema: AnalyticsTableSchema = {
      ...schema,
      tableName: "absence_fanout_recovery",
      columns: [
        { name: "record_id", type: "VARCHAR", description: "Upstream record" },
        { name: "sample_index", type: "BIGINT", description: "Sample index" },
      ],
      primaryKey: ["record_id", "sample_index"],
      semanticTimeColumn: null,
      record: { titleColumns: ["record_id"], keyColumns: ["record_id", "sample_index"] },
    };
    const page = {
      tableName: fanoutSchema.tableName,
      records: [
        { record_id: "record-a", sample_index: 0 },
        { record_id: "record-a", sample_index: 1 },
      ],
      sourceId,
      deleteKeyColumn: "record_id",
    };
    await db.ingestPage({ ...page, schema: fanoutSchema });
    await db.ingestPage({
      tableName: fanoutSchema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      deleteKeyColumn: "record_id",
      absencePolicy: { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 10 },
    });

    await db.ingestPage(page);

    expect(
      (await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 })).map(
        (absence) => absence.keyValue,
      ),
    ).not.toContain("record-a");
  });

  test("a stale sweep candidate cannot delete a cleared and re-marked row", async () => {
    const immediate = { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 100 };
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: ["s-1", "s-2"],
      absencePolicy: immediate,
    });
    const stale = await db.dueAbsences({
      dueBefore: Date.now() + 1,
      minObservations: 1,
      limit: 100,
    });
    expect(stale.map((candidate) => candidate.keyValue)).toEqual(["s-3"]);

    // Recovery clears the old mark, then another omission starts a distinct
    // deadline for the same key. With a zero-age test policy both generations
    // can satisfy the numeric deadline; the mark token is what rejects the ABA.
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: ["s-1", "s-2", "s-3"],
      absencePolicy: immediate,
    });
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: ["s-1", "s-2"],
      absencePolicy: immediate,
    });

    expect(await db.deleteAbsentRecords(stale)).toMatchObject({ deleted: 0 });
    expect(await ids()).toEqual(["s-1", "s-2", "s-3"]);
    expect(
      (
        await db.dueAbsences({
          dueBefore: Date.now() + 1,
          minObservations: 1,
          limit: 100,
        })
      ).map((candidate) => candidate.keyValue),
    ).toEqual(["s-3"]);
  });

  test("an upgraded empty-token mark is still protected from clear/re-mark ABA", async () => {
    const legacyPath = `/tmp/omnesis-test-analytics-absence-legacy-${crypto.randomUUID()}.db`;
    const legacySchema = { ...schema, tableName: "legacy_absence_samples" };
    const immediate = { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 100 };
    try {
      const legacy = new AnalyticsDb(legacyPath);
      await legacy.open();
      await legacy.ingestPage({
        tableName: legacySchema.tableName,
        records: [row("legacy-1")],
        schema: legacySchema,
        sourceId,
      });
      await legacy.ingestPage({
        tableName: legacySchema.tableName,
        records: [],
        sourceId,
        presentIds: [],
        absencePolicy: immediate,
      });
      await legacy.close();

      // This is the shape produced before mark/observation identities existed.
      const raw = await DuckDBInstance.create(legacyPath);
      const conn = await raw.connect();
      await conn.run("DROP INDEX IF EXISTS idx_analytics_absences_due");
      await conn.run("ALTER TABLE _analytics_absences DROP COLUMN mark_id");
      await conn.run("ALTER TABLE _analytics_absences DROP COLUMN last_observation_id");
      conn.closeSync();
      raw.closeSync();

      const upgraded = new AnalyticsDb(legacyPath);
      await upgraded.open();
      try {
        const stale = await upgraded.dueAbsences({
          dueBefore: Date.now() + 1,
          minObservations: 1,
          limit: 10,
        });
        expect(stale[0]?.markId).toBe("");
        await upgraded.ingestPage({
          tableName: legacySchema.tableName,
          records: [],
          sourceId,
          presentIds: ["legacy-1"],
          absencePolicy: immediate,
        });
        await upgraded.ingestPage({
          tableName: legacySchema.tableName,
          records: [],
          sourceId,
          presentIds: [],
          absencePolicy: immediate,
        });

        expect(await upgraded.deleteAbsentRecords(stale)).toMatchObject({ deleted: 0 });
        expect((await upgraded.executeQuery("SELECT id FROM legacy_absence_samples")).rows).toEqual(
          [["legacy-1"]],
        );
      } finally {
        await upgraded.close();
      }
    } finally {
      for (const suffix of ["", ".wal"]) {
        if (existsSync(legacyPath + suffix)) unlinkSync(legacyPath + suffix);
      }
    }
  });

  test("removing the source takes its absences with it", async () => {
    // DuckDB has no cascade, so an absence outlives its row unless it is
    // dropped explicitly — and a source that is gone will never send another
    // snapshot to revoke it. Nothing else would ever prune the row.
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: [],
      absencePolicy: POLICY,
    });
    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 }),
    ).toHaveLength(3);

    await db.deleteAnalyticsForSource(sourceId);

    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 }),
    ).toEqual([]);
  });

  test("removing one device stream takes that stream's absences with it", async () => {
    const streamed = { ...schema, tableName: "absence_stream_samples" };
    for (const streamId of ["device-a", "device-b"]) {
      await db.ingestPage({
        tableName: streamed.tableName,
        records: [row("s-1"), row("s-2")],
        schema: streamed,
        sourceId,
        streamId,
      });
      await db.ingestPage({
        tableName: streamed.tableName,
        records: [],
        sourceId,
        presentIds: [],
        absencePolicy: POLICY,
        streamId,
      });
    }
    const streamsOf = async () =>
      (await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 }))
        .filter((d) => d.tableName === streamed.tableName)
        .map((d) => d.streamId)
        .sort();
    expect(await streamsOf()).toEqual(["device-a", "device-a", "device-b", "device-b"]);

    await db.deleteAnalyticsStream(sourceId, "device-a");

    expect(await streamsOf()).toEqual(["device-b", "device-b"]);
  });

  test("a tombstoned row takes its pending absence with it", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds: ["s-1"],
      absencePolicy: POLICY,
    });
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      deletedIds: ["s-2"],
    });

    expect(await ids()).toEqual(["s-1", "s-3"]);
    const due = await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 100 });
    expect(due.map((d) => d.keyValue)).toEqual(["s-3"]);
  });
});

describe("AnalyticsDb — the replica deletion ledger's seams", () => {
  const sourceId = "apple-health:shared";
  const schema: AnalyticsTableSchema = {
    ...testSchema,
    tableName: "replica_samples",
    displayName: "Replica samples",
  };
  const POLICY = { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 200 };
  const row = (id: string): Record<string, unknown> => ({
    id,
    date: "2026-03-01",
    metric_type: "steps",
    value: 1,
    unit: "count",
  });
  const held = async () =>
    (await db.executeQuery(`SELECT id FROM ${schema.tableName} ORDER BY id`)).rows.map((r) =>
      String(r[0]),
    );
  const observers = async () =>
    Object.fromEntries(
      (
        await db.executeQuery(
          `SELECT key_value, observed_by FROM _analytics_absences WHERE source_id = '${sourceId}' ORDER BY key_value`,
        )
      ).rows.map((r) => [String(r[0]), String(r[1])]),
    );
  const snapshot = (presentIds: string[], observedBy: string | undefined, observationId: string) =>
    db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentIds,
      absencePolicy: POLICY,
      observationId,
      observedBy,
    });
  const hooks = (opts: {
    apply?: (existing: string[]) => string[];
    onPresence?: (keys: string[]) => Promise<void> | void;
  }) => {
    const seen = { existing: [] as string[][], presence: [] as string[][] };
    const replica = {
      recordPresence: async (keys: string[]) => {
        seen.presence.push(keys);
        await opts.onPresence?.(keys);
      },
      judgeDeletions: async (existing: string[]) => {
        seen.existing.push(existing);
        return { apply: opts.apply ? opts.apply(existing) : existing };
      },
    };
    return { replica, seen };
  };

  beforeEach(async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [row("a"), row("b"), row("c")],
      schema,
      sourceId,
    });
  });

  test("a member's snapshot attributes the absences it marks; a later corroboration keeps the last named observer", async () => {
    await snapshot(["a"], "alpha", "obs-1");
    expect(await observers()).toEqual({ b: "alpha", c: "alpha" });
    await snapshot(["a"], "", "obs-2");
    expect(await observers()).toEqual({ b: "alpha", c: "alpha" });
    await snapshot(["a", "c"], "beta", "obs-3");
    expect(await observers()).toEqual({ b: "beta" });
    const due = await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 });
    expect(due.map((d) => [d.keyValue, d.observedBy])).toEqual([["b", "beta"]]);
  });

  test("the sweep's judge keeps a disputed row and drops its absence; a deletion goes through", async () => {
    await snapshot(["a"], "alpha", "obs-1");
    const due = await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 });
    expect(due).toHaveLength(2);
    const asked: string[] = [];
    expect(
      await db.deleteAbsentRecords(due, async (candidate) => {
        asked.push(`${candidate.keyValue}:${candidate.observedBy}`);
        return candidate.keyValue === "b" ? "disputed" : "delete";
      }),
    ).toEqual({ deleted: 1, disputed: 1 });
    expect(asked.sort()).toEqual(["b:alpha", "c:alpha"]);
    expect(await held()).toEqual(["a", "b"]);
    // The disputed row's absence is gone: its deadline starts over next time.
    expect(await observers()).toEqual({});
  });

  test("forgetting an observer leaves the absence, unattributed", async () => {
    await snapshot(["a"], "alpha", "obs-1");
    await snapshot(["a", "b"], "beta", "obs-2");
    expect(await observers()).toEqual({ c: "beta" });
    await db.forgetAbsenceObserver(sourceId, "alpha");
    expect(await observers()).toEqual({ c: "beta" });
    await db.forgetAbsenceObserver(sourceId, "beta");
    expect(await observers()).toEqual({ c: "" });
    await snapshot(["a"], "alpha", "obs-3");
    await db.forgetAbsenceObserver(sourceId);
    expect(await observers()).toEqual({ b: "", c: "" });
  });

  test("a replicated page's tombstones are judged over the rows the table holds, and only the verdict's rows go", async () => {
    await snapshot(["a", "b"], "alpha", "obs-1");
    const { replica, seen } = hooks({ apply: (existing) => existing.filter((id) => id !== "b") });
    expect(
      await db.ingestPage({
        tableName: schema.tableName,
        records: [],
        sourceId,
        deletedIds: ["b", "c", "never-held"],
        replica,
      }),
    ).toMatchObject({ deleted: 1 });
    expect(seen.existing.map((ids) => [...ids].sort())).toEqual([["b", "c"]]);
    expect(await held()).toEqual(["a", "b"]);
    // Only the deleted row's pending absence went with it.
    expect(await observers()).toEqual({});
  });

  test("a page whose tombstones name nothing the table holds asks the ledger nothing", async () => {
    const { replica, seen } = hooks({});
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      deletedIds: ["never-held"],
      replica,
    });
    expect(seen.existing).toEqual([]);
    expect(await held()).toEqual(["a", "b", "c"]);
  });

  test("keys are judged as the wire spells them, whatever the column's type", async () => {
    const intSchema: AnalyticsTableSchema = {
      ...testSchema,
      tableName: "replica_int_keys",
      displayName: "Integer-keyed rows",
      columns: [
        { name: "id", type: "INTEGER", description: "Row id" },
        { name: "value", type: "DOUBLE", description: "Reading" },
      ],
      primaryKey: ["id"],
      semanticTimeColumn: null,
      record: { titleColumns: ["id"], keyColumns: ["id"] },
      exampleQueries: [],
    };
    const { replica, seen } = hooks({});
    await db.ingestPage({
      tableName: intSchema.tableName,
      records: [
        { id: 7, value: 1.5 },
        { id: 8, value: 2.5 },
      ],
      schema: intSchema,
      sourceId,
      replica,
    });
    expect(seen.presence).toEqual([["7", "8"]]);
    expect(
      await db.ingestPage({
        tableName: intSchema.tableName,
        records: [],
        sourceId,
        deletedIds: ["7", "9", "not-a-number"],
        replica,
      }),
    ).toMatchObject({ deleted: 1 });
    expect(seen.existing).toEqual([["7"]]);
    expect(
      (await db.executeQuery(`SELECT id FROM ${intSchema.tableName}`)).rows.map((r) =>
        Number(r[0]),
      ),
    ).toEqual([8]);
  });

  test("a fan-out tombstone is judged once by its key and takes every physical row with it", async () => {
    const fanoutSchema: AnalyticsTableSchema = {
      ...testSchema,
      tableName: "replica_fanout",
      displayName: "Fan-out samples",
      columns: [
        { name: "record_id", type: "VARCHAR", description: "Upstream record" },
        { name: "sample_index", type: "BIGINT", description: "Sample index" },
      ],
      primaryKey: ["record_id", "sample_index"],
      semanticTimeColumn: null,
      record: { titleColumns: ["record_id"], keyColumns: ["record_id", "sample_index"] },
      exampleQueries: [],
    };
    const { replica, seen } = hooks({});
    await db.ingestPage({
      tableName: fanoutSchema.tableName,
      records: [
        { record_id: "r-1", sample_index: 0 },
        { record_id: "r-1", sample_index: 1 },
        { record_id: "r-1", sample_index: 2 },
        { record_id: "r-2", sample_index: 0 },
      ],
      schema: fanoutSchema,
      sourceId,
      deleteKeyColumn: "record_id",
      replica,
    });
    // Presence is claimed by the key the source deletes on, once per record.
    expect(seen.presence).toEqual([["r-1", "r-2"]]);
    expect(
      await db.ingestPage({
        tableName: fanoutSchema.tableName,
        records: [],
        sourceId,
        deletedIds: ["r-1", "r-3"],
        deleteKeyColumn: "record_id",
        replica,
      }),
      // Three rows, one key: the count is what went, and every row of the
      // record the source named goes together.
    ).toMatchObject({ deleted: 3 });
    expect(seen.existing).toEqual([["r-1"]]);
    expect(
      (
        await db.executeQuery(`SELECT record_id, sample_index FROM ${fanoutSchema.tableName}`)
      ).rows.map((row) => [String(row[0]), Number(row[1])]),
    ).toEqual([["r-2", 0]]);
  });

  test("a member's rows are its presence claims, made before the page commits", async () => {
    const { replica, seen } = hooks({
      onPresence: async () => {
        throw new Error("synthetic ledger failure");
      },
    });
    await expect(
      db.ingestPage({
        tableName: schema.tableName,
        records: [row("d"), row("e")],
        sourceId,
        replica,
      }),
    ).rejects.toThrow("synthetic ledger failure");
    expect(seen.presence).toEqual([["d", "e"]]);
    // The page rolled back with the claim it could not make.
    expect(await held()).toEqual(["a", "b", "c"]);
  });
});

/**
 * A table addressed by more than one column.
 *
 * Before the key was declared on the table, a composite-key table could only
 * be deleted from by naming one of its columns — which is right only when the
 * upstream guarantees that column is unique on its own, and silently wrong
 * when it is not. These tests are about the case that guarantee does not
 * cover: two rows that share each half of the key.
 */
describe("AnalyticsDb — typed tuple keys", () => {
  test.each([
    { type: "JSON" as const, value: { fictional: "sample" } },
    { type: "VARCHAR[]" as const, value: ["sample", "other"] },
    { type: "VARCHAR" as const, value: null },
  ])(
    "record-derived $type keys retain supported structured and nullable values",
    async ({ type, value }) => {
      const schema: AnalyticsTableSchema = {
        tableName: "record_key_rows",
        displayName: "Record keys",
        description: "Fictional records",
        columns: [
          { name: "id", type: "VARCHAR", description: "ID" },
          { name: "group_key", type, nullable: true, description: "Group" },
        ],
        primaryKey: ["id"],
        deleteKey: ["group_key"],
        semanticTimeColumn: null,
        record: { titleColumns: ["id"], keyColumns: ["id"] },
      };
      const base = { tableName: schema.tableName, sourceId: "example-records:local" };
      const records = [{ id: "one", group_key: value }];
      await db.ingestPage({ ...base, schema, records });
      await db.ingestPage({
        ...base,
        records: [],
        presentKeys: [],
        absencePolicy: IMMEDIATE_ABSENCE_POLICY,
        observationId: "record-key-empty",
      });
      expect(
        await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 }),
      ).toHaveLength(1);
      await db.ingestPage({ ...base, records });
      expect(
        await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 }),
      ).toHaveLength(0);
      expect((await db.executeQuery(`SELECT id FROM ${schema.tableName}`)).rows).toEqual([["one"]]);
    },
  );

  test("timestamp and floating-point keys survive snapshots, recoveries, and deletes", async () => {
    const schema: AnalyticsTableSchema = {
      tableName: "typed_tuple_rows",
      displayName: "Typed rows",
      description: "Fictional samples",
      columns: [
        { name: "at", type: "TIMESTAMPTZ", description: "Time" },
        { name: "value", type: "DOUBLE", description: "Value" },
      ],
      primaryKey: ["at", "value"],
      semanticTimeColumn: "at",
      record: { titleColumns: ["value"], keyColumns: ["at", "value"] },
    };
    const first = { at: "2026-01-02T14:34:56.123456+02:00", value: 1e-7 };
    const second = { at: "2026-01-03T12:34:56.123456Z", value: 1.2 };
    const base = { tableName: schema.tableName, sourceId: "example-samples:local" };
    await db.ingestPage({ ...base, schema, records: [first, second] });
    await db.ingestPage({
      ...base,
      records: [],
      presentKeys: [first],
      absencePolicy: IMMEDIATE_ABSENCE_POLICY,
      observationId: "typed-first",
    });
    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 }),
    ).toHaveLength(1);
    await db.ingestPage({ ...base, records: [second] });
    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 }),
    ).toHaveLength(0);
    expect(
      await db.ingestPage({
        ...base,
        records: [],
        deletedKeys: [{ ...first, at: "2026-01-02T12:34:56.123456Z" }],
      }),
    ).toMatchObject({ deleted: 1 });
    expect((await db.executeQuery(`SELECT value FROM ${schema.tableName}`)).rows).toEqual([[1.2]]);
    await db.ingestPage({
      ...base,
      records: [],
      presentKeys: [],
      absencePolicy: IMMEDIATE_ABSENCE_POLICY,
      observationId: "typed-empty",
    });
    const due = await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 });
    expect(due).toHaveLength(1);
    expect(await db.deleteAbsentRecords(due)).toMatchObject({ deleted: 1 });
    await db.ingestPage({ ...base, records: [first], streamId: "device-a" });
    await db.ingestPage({ ...base, records: [first], streamId: "device-b" });
    await db.ingestPage({ ...base, records: [first] });
    await db.ingestPage({
      ...base,
      records: [],
      presentKeys: [],
      absencePolicy: IMMEDIATE_ABSENCE_POLICY,
      observationId: "typed-empty-stream",
    });
    const emptyStreamDue = await db.dueAbsences({
      dueBefore: Date.now() + 1,
      minObservations: 1,
      limit: 10,
    });
    expect(emptyStreamDue).toHaveLength(1);
    expect(await db.deleteAbsentRecords(emptyStreamDue)).toMatchObject({ deleted: 1 });
    expect((await db.executeQuery(`SELECT COUNT(*) FROM ${schema.tableName}`)).rows).toEqual([[2]]);
    expect(await db.deleteAnalyticsStream(base.sourceId, "device-a")).toEqual([schema.tableName]);
    expect((await db.executeQuery(`SELECT _stream_id FROM ${schema.tableName}`)).rows).toEqual([
      ["device-b"],
    ]);
  });
});

describe("AnalyticsDb — a table addressed by two columns", () => {
  const sourceId = "example-bank:one";
  const schema: AnalyticsTableSchema = {
    tableName: "tuple_transactions",
    displayName: "Transactions",
    description: "Fictional ledger rows",
    columns: [
      { name: "item_id", type: "VARCHAR", description: "Connection" },
      { name: "txn_id", type: "VARCHAR", description: "Transaction" },
      { name: "amount", type: "DOUBLE", description: "Amount" },
    ],
    primaryKey: ["item_id", "txn_id"],
    // Declared rather than left to default, which is what a migrated source
    // does: it is then the answer, and a page bringing its own column is
    // refused instead of opening a second key space.
    deleteKey: ["item_id", "txn_id"],
    semanticTimeColumn: null,
    record: { titleColumns: ["txn_id"], keyColumns: ["item_id", "txn_id"] },
  };

  const POLICY = { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 1000 };

  async function held(): Promise<string[]> {
    const result = await db.executeQuery(
      `SELECT item_id, txn_id FROM ${schema.tableName} ORDER BY item_id, txn_id`,
    );
    return result.rows.map((row) => `${String(row[0])}/${String(row[1])}`);
  }

  beforeEach(async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [
        { item_id: "i1", txn_id: "t1", amount: 1 },
        { item_id: "i1", txn_id: "t2", amount: 2 },
        { item_id: "i2", txn_id: "t1", amount: 3 },
      ],
      schema,
      sourceId,
    });
  });

  test("a delete names one row, not every row sharing half its key", async () => {
    // `i2/t1` shares its transaction id with `i1/t1` and its connection with
    // nothing. Keyed on `txn_id` alone this delete would take both.
    const result = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      deletedKeys: [{ item_id: "i2", txn_id: "t1" }],
    });

    expect(result.deleted).toBe(1);
    expect(await held()).toEqual(["i1/t1", "i1/t2"]);
  });

  test("a key that names the wrong columns is refused, not applied in part", async () => {
    await expect(
      db.ingestPage({
        tableName: schema.tableName,
        records: [],
        sourceId,
        deletedKeys: [{ txn_id: "t1" }],
      }),
    ).rejects.toThrow(/names \(item_id, txn_id\)/);
    expect(await held()).toEqual(["i1/t1", "i1/t2", "i2/t1"]);
  });

  test("the older single-column spelling cannot address this table at all", async () => {
    // It has no way to say which of the two rows sharing `t1` it means, and
    // guessing is how a sibling connection's row is deleted.
    await expect(
      db.ingestPage({
        tableName: schema.tableName,
        records: [],
        sourceId,
        deletedIds: ["t1"],
        deleteKeyColumn: "txn_id",
      }),
    ).rejects.toThrow(/addressed by \(item_id, txn_id\)/);
    expect(await held()).toEqual(["i1/t1", "i1/t2", "i2/t1"]);
  });

  test("a snapshot omits one row of a shared half and only that row goes", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentKeys: [
        { item_id: "i1", txn_id: "t1" },
        { item_id: "i1", txn_id: "t2" },
      ],
      absencePolicy: POLICY,
      observationId: "obs-1",
    });
    const due = await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 });

    expect(await db.deleteAbsentRecords(due)).toMatchObject({ deleted: 1 });
    expect(await held()).toEqual(["i1/t1", "i1/t2"]);
  });

  test("a row that arrives again clears the absence its own key recorded", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      presentKeys: [{ item_id: "i1", txn_id: "t1" }],
      absencePolicy: POLICY,
      observationId: "obs-1",
    });
    expect(
      (await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 })).length,
    ).toBe(2);

    // The same rows arrive on a later page. An arrival is presence, and it is
    // matched by the same key the absence was recorded under.
    await db.ingestPage({
      tableName: schema.tableName,
      records: [
        { item_id: "i1", txn_id: "t2", amount: 2 },
        { item_id: "i2", txn_id: "t1", amount: 3 },
      ],
      sourceId,
    });

    expect(
      await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 }),
    ).toEqual([]);
    expect(await held()).toEqual(["i1/t1", "i1/t2", "i2/t1"]);
  });
});

/**
 * The ramp for a table whose schema pre-dates the declaration.
 *
 * A producer written before a table could declare its key still names one per
 * page — a phone pushing fan-out rows keyed by their parent record. The first
 * such page fixes the table's key space, and the fixing is what turns a
 * second, different column from a silent second key space into a refusal.
 */
describe("AnalyticsDb — a table that has not declared its key", () => {
  const sourceId = "example-wearable:local";
  const schema: AnalyticsTableSchema = {
    tableName: "adopted_samples",
    displayName: "Samples",
    description: "Fictional fan-out rows",
    columns: [
      { name: "record_id", type: "VARCHAR", description: "Parent record" },
      { name: "sample_index", type: "BIGINT", description: "Sample" },
      { name: "beats", type: "BIGINT", description: "Value" },
    ],
    primaryKey: ["record_id", "sample_index"],
    semanticTimeColumn: null,
    record: { titleColumns: ["record_id"], keyColumns: ["record_id", "sample_index"] },
  };

  beforeEach(async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [
        { record_id: "r-1", sample_index: 0, beats: 60 },
        { record_id: "r-1", sample_index: 1, beats: 61 },
        { record_id: "r-2", sample_index: 0, beats: 70 },
      ],
      schema,
      sourceId,
    });
  });

  test("the first page to name a column addresses the table by it", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      deletedIds: ["r-1"],
      deleteKeyColumn: "record_id",
    });
    const rows = await db.executeQuery(
      `SELECT record_id, sample_index FROM ${schema.tableName} ORDER BY record_id, sample_index`,
    );

    // The whole parent record went, which is what naming it means.
    expect(rows.rows.map((row) => `${String(row[0])}/${Number(row[1])}`)).toEqual(["r-2/0"]);
  });

  test("a page omitting deleteKey uses the persisted key for its own deletes", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      schema: { ...schema, deleteKey: ["record_id"] },
    });
    expect(await db.rowKeyColumns(schema.tableName, schema)).toEqual(["record_id"]);
    const result = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      schema,
      deletedKeys: [{ record_id: "r-1" }],
    });
    expect(result.deleted).toBe(2);
    expect((await db.executeQuery(`SELECT record_id FROM ${schema.tableName}`)).rows).toEqual([
      ["r-2"],
    ]);
  });

  test("a re-pushed schema that omits the key does not erase it", async () => {
    // A client that predates the declaration re-sends this table's schema on
    // every startup. Letting that erase the adopted key would put the table
    // back on its primary key, and every pending absence recorded under the
    // old key space would be discarded on the next snapshot — for as long as
    // the client keeps re-sending.
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      deletedIds: ["r-2"],
      deleteKeyColumn: "record_id",
    });

    await db.ingestPage({ tableName: schema.tableName, records: [], schema, sourceId });

    // Still addressed by the adopted key: a page naming another column is
    // refused, which it would not be if the declaration had gone.
    await expect(
      db.ingestPage({
        tableName: schema.tableName,
        records: [],
        sourceId,
        deletedIds: ["0"],
        deleteKeyColumn: "sample_index",
      }),
    ).rejects.toThrow(/addressed by \(record_id\)/);
  });

  test("and a later page naming a different column is refused", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      deletedIds: ["r-1"],
      deleteKeyColumn: "record_id",
    });

    await expect(
      db.ingestPage({
        tableName: schema.tableName,
        records: [],
        sourceId,
        deletedIds: ["0"],
        deleteKeyColumn: "sample_index",
      }),
    ).rejects.toThrow(/addressed by \(record_id\)/);
  });
});

/**
 * What a delete reports back.
 *
 * The number an operator is shown is the rows that went, and for a table
 * addressed by a group key that is not the number of keys the page named —
 * one activity can carry two hundred samples.
 */
describe("AnalyticsDb — counting what a delete removed", () => {
  const sourceId = "example-tracker:local";
  const schema: AnalyticsTableSchema = {
    tableName: "grouped_samples",
    displayName: "Samples",
    description: "Fictional grouped rows",
    columns: [
      { name: "run_id", type: "VARCHAR", description: "Parent run" },
      { name: "sample_index", type: "BIGINT", description: "Sample" },
    ],
    primaryKey: ["run_id", "sample_index"],
    deleteKey: ["run_id"],
    semanticTimeColumn: null,
    record: { titleColumns: ["run_id"], keyColumns: ["run_id", "sample_index"] },
  };

  test("a group delete counts rows, not the keys the page named", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [
        { run_id: "r-1", sample_index: 0 },
        { run_id: "r-1", sample_index: 1 },
        { run_id: "r-1", sample_index: 2 },
        { run_id: "r-2", sample_index: 0 },
      ],
      schema,
      sourceId,
    });

    const result = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      deletedKeys: [{ run_id: "r-1" }],
    });

    expect(result.deleted).toBe(3);
    const remaining = await db.executeQuery(`SELECT run_id, sample_index FROM ${schema.tableName}`);
    expect(remaining.rows.length).toBe(1);
  });

  test("a key naming nothing removes nothing and says so", async () => {
    await db.ingestPage({
      tableName: schema.tableName,
      records: [{ run_id: "r-3", sample_index: 0 }],
      schema,
      sourceId,
    });

    const result = await db.ingestPage({
      tableName: schema.tableName,
      records: [],
      sourceId,
      deletedKeys: [{ run_id: "r-absent" }],
    });

    expect(result.deleted).toBe(0);
  });
});

/**
 * A table whose declared key changes.
 *
 * Every pending absence records the key space it was written under, because a
 * key means nothing outside the columns it was built from. Left in place, the
 * sweep would delete by a key nobody wrote — matching either no row, or,
 * worse, some row whose different columns happen to encode the same way.
 */
describe("AnalyticsDb — a table addressed a different way than before", () => {
  const sourceId = "example-wearable:local";
  const POLICY = { minObservations: 1, minAgeMs: 0, maxMarksPerSnapshot: 100 };
  const base: AnalyticsTableSchema = {
    tableName: "rekeyed_samples",
    displayName: "Samples",
    description: "Fictional rows",
    columns: [
      { name: "record_id", type: "VARCHAR", description: "Parent record" },
      { name: "sample_index", type: "BIGINT", description: "Sample" },
    ],
    primaryKey: ["record_id", "sample_index"],
    semanticTimeColumn: null,
    record: { titleColumns: ["record_id"], keyColumns: ["record_id", "sample_index"] },
  };

  test("an old-key absence cannot delete or issue a replica verdict after a key change", async () => {
    await db.ingestPage({
      tableName: base.tableName,
      records: [{ record_id: "0", sample_index: 0 }],
      schema: { ...base, deleteKey: ["record_id"] },
      sourceId,
    });
    await db.ingestPage({
      tableName: base.tableName,
      records: [],
      sourceId,
      presentKeys: [],
      absencePolicy: POLICY,
      observationId: "old-key",
    });
    const due = await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 });
    expect(due).toHaveLength(1);
    await db.ingestPage({
      tableName: base.tableName,
      records: [],
      schema: { ...base, deleteKey: ["sample_index"] },
      sourceId,
    });
    let judgments = 0;
    expect(
      await db.deleteAbsentRecords(due, async () => {
        judgments++;
        return "delete";
      }),
    ).toEqual({ deleted: 0, disputed: 0 });
    expect(judgments).toBe(0);
    expect((await db.executeQuery(`SELECT record_id FROM ${base.tableName}`)).rows).toEqual([
      ["0"],
    ]);
  });

  test("marks made under the old key space go, and the next snapshot re-makes them", async () => {
    await db.ingestPage({
      tableName: base.tableName,
      records: [
        { record_id: "r-1", sample_index: 0 },
        { record_id: "r-2", sample_index: 0 },
      ],
      schema: { ...base, deleteKey: ["record_id"] },
      sourceId,
    });
    // A snapshot under the record key marks `r-2` as absent.
    await db.ingestPage({
      tableName: base.tableName,
      records: [],
      sourceId,
      presentKeys: [{ record_id: "r-1" }],
      absencePolicy: POLICY,
      observationId: "rekey-obs-1",
    });
    expect(
      (await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 })).length,
    ).toBe(1);

    // The table is re-declared with its full primary key, so every stored key
    // is in a space that no longer exists.
    await db.ingestPage({
      tableName: base.tableName,
      records: [],
      schema: { ...base, deleteKey: ["record_id", "sample_index"] },
      sourceId,
    });
    await db.ingestPage({
      tableName: base.tableName,
      records: [],
      sourceId,
      presentKeys: [{ record_id: "r-1", sample_index: 0 }],
      absencePolicy: POLICY,
      observationId: "rekey-obs-2",
    });

    // One absence again — the same row, re-marked in the key space that is
    // now current, rather than two marks for one row in two languages.
    const due = await db.dueAbsences({ dueBefore: Date.now() + 1, minObservations: 1, limit: 10 });
    expect(due.length).toBe(1);
    expect(await db.deleteAbsentRecords(due)).toMatchObject({ deleted: 1 });
    const rows = await db.executeQuery(
      `SELECT record_id FROM ${base.tableName} ORDER BY record_id`,
    );
    expect(rows.rows.map((row) => String(row[0]))).toEqual(["r-1"]);
  });
});

describe("AnalyticsDb — internal tables carry no non-unique index", () => {
  // DuckDB's explicit non-unique ART indexes can reach a stored state in which
  // deleting a row through them fails fatally and invalidates the whole store
  // (duckdb/duckdb#23645). A source removal deletes through every internal
  // ledger, so one damaged index took the gateway down.
  async function nonUniqueIndexes(): Promise<string[]> {
    const pool = (db as any).pool;
    let names: string[] = [];
    await pool.withConn(async ({ conn }: any) => {
      const reader = await conn.runAndReadAll(
        `SELECT index_name FROM duckdb_indexes() WHERE NOT is_unique AND NOT is_primary ORDER BY 1`,
      );
      names = (reader.getRows() as unknown[][]).map((row) => String(row[0]));
    });
    return names;
  }

  test("a fresh store creates none", async () => {
    expect(await nonUniqueIndexes()).toEqual([]);
  });

  test("opening a store that still has them drops them", async () => {
    await db.close();
    const raw = await DuckDBInstance.create(TEST_DB);
    const conn = await raw.connect();
    await conn.run(
      `CREATE INDEX idx_analytics_absence_observations_created ON _analytics_absence_observations(created_at)`,
    );
    await conn.run(
      `CREATE INDEX idx_analytics_absences_due ON _analytics_absences(first_absent_at)`,
    );
    await conn.run(
      `CREATE INDEX idx_temporal_projections_window ON _temporal_projections(start_ms, end_exclusive_ms)`,
    );
    await conn.run(
      `CREATE INDEX idx_temporal_projections_source ON _temporal_projections(source_id, table_name)`,
    );
    conn.closeSync();
    raw.closeSync();

    db = new AnalyticsDb(TEST_DB);
    await db.open();

    expect(await nonUniqueIndexes()).toEqual([]);
  });
});
