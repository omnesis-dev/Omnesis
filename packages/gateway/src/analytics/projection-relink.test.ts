// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { AnalyticsDb } from "../analytics-db.js";
import {
  createTemporalAnnotationTables,
  relinkTemporalAnnotationProjections,
} from "../enrichment/temporal-annotations/storage.js";
import { createTemporalProjectionRelinker } from "./projection-relink.js";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

const accountA = "calendar:maya@example.com";
const accountB = "calendar:maya.reeves@example.org";
const window = {
  fromMs: Date.parse("2026-09-14T00:00:00.000Z"),
  toMs: Date.parse("2026-09-16T00:00:00.000Z"),
  limit: 10,
};

const idKeyed: AnalyticsTableSchema = {
  tableName: "test_relinked_calendar_events",
  displayName: "Calendar events",
  description: "Invented calendar events for relink tests",
  columns: [
    { name: "id", type: "VARCHAR", description: "Stable id" },
    { name: "source_account", type: "VARCHAR", description: "Account" },
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
  sharedDiscriminatorColumn: "source_account",
  temporalProjection: {
    slot: "calendar",
    start: "$semanticTime",
    end: "end_time",
    label: "title",
    kind: { from: "all_day", map: { true: "event" }, default: "appointment" },
    modality: "scheduled",
    status: { from: "status", map: { cancelled: "cancelled" }, default: "active" },
    allDay: "all_day",
    eligibility: "eligible",
  },
};
const accountKeyed: AnalyticsTableSchema = {
  ...idKeyed,
  primaryKey: ["source_account", "id"],
  deleteKey: ["id"],
  boundDocument: { externalIdColumns: ["id"], sourceKeyColumns: ["source_account"] },
};

const event = (id: string, sourceAccount: string, day = 14) => ({
  id,
  source_account: sourceAccount,
  title: "Quarterly planning",
  start_time: `2026-09-${day}T15:00:00.000Z`,
  end_time: `2026-09-${day}T16:00:00.000Z`,
  all_day: false,
  eligible: true,
  status: "confirmed",
});

const log = createLogger("test:projection-relink");
let path: string;
let analytics: AnalyticsDb;
let sqlite: Database.Database;

function annotate(id: string, projectionId: string): void {
  sqlite
    .prepare(
      `INSERT INTO temporal_annotations
         (id, interval_start_ms, interval_end_ms, precision, sentence, created_by_run, created_at, updated_at)
       VALUES (?, 0, 0, 'day', 'The planning offsite.', 'run-1', 0, 0)`,
    )
    .run(id);
  sqlite
    .prepare(
      "INSERT INTO temporal_annotation_projections (annotation_id, projection_id) VALUES (?, ?)",
    )
    .run(id, projectionId);
}

const links = () =>
  sqlite
    .prepare(
      "SELECT annotation_id, projection_id FROM temporal_annotation_projections ORDER BY annotation_id",
    )
    .all() as Array<{ annotation_id: string; projection_id: string }>;

const relinker = () =>
  createTemporalProjectionRelinker({
    ledger: analytics,
    relink: (moves) => Promise.resolve(relinkTemporalAnnotationProjections(sqlite, moves)),
    log,
  });

/** Two id-keyed projections, each linked by one annotation; returns their ids by row id. */
async function seedLinkedProjections(): Promise<Map<string, string>> {
  await analytics.ingestPage({
    tableName: idKeyed.tableName,
    schema: idKeyed,
    sourceId: accountA,
    records: [event("team:evt-1", "maya@example.com"), event("team:evt-2", "maya@example.com", 15)],
  });
  const before = new Map(
    (await analytics.queryTemporalProjections(window)).map((row) => [
      row.documentExternalId!,
      row.id,
    ]),
  );
  annotate("ta-1", before.get("team:evt-1")!);
  annotate("ta-2", before.get("team:evt-2")!);
  return before;
}

async function projectionIds(): Promise<Map<string, string>> {
  return new Map(
    (await analytics.queryTemporalProjections(window)).map((row) => [
      row.documentExternalId!,
      row.id,
    ]),
  );
}

beforeEach(async () => {
  path = `/tmp/omnesis-test-relink-${crypto.randomUUID()}.db`;
  analytics = new AnalyticsDb(path);
  await analytics.open();
  sqlite = new Database(":memory:");
  createTemporalAnnotationTables(sqlite);
});

afterEach(async () => {
  await analytics.close();
  sqlite.close();
  for (const file of [path, `${path}.wal`]) if (existsSync(file)) unlinkSync(file);
});

describe("annotation links follow a projection rekey", () => {
  test("a widened key moves each annotation link to its projection's new id", async () => {
    const before = await seedLinkedProjections();
    let notified = 0;
    analytics.onTemporalProjectionsMoved(() => {
      notified += 1;
    });

    await analytics.ensureTable(accountKeyed, accountB);
    expect(notified).toBe(1);
    const after = await projectionIds();
    expect(after.get("team:evt-1")).not.toBe(before.get("team:evt-1"));

    expect(await relinker().drain()).toBe(2);
    expect(links()).toEqual([
      { annotation_id: "ta-1", projection_id: after.get("team:evt-1") },
      { annotation_id: "ta-2", projection_id: after.get("team:evt-2") },
    ]);
    expect(await analytics.nextTemporalProjectionMoves()).toBeNull();

    await analytics.ensureTable(accountKeyed, accountA);
    expect(notified).toBe(1);
  });

  test("a crash before the links followed is finished by the next drain, after a restart", async () => {
    await seedLinkedProjections();
    await analytics.ensureTable(accountKeyed, accountB);
    await analytics.close();
    analytics = new AnalyticsDb(path);
    await analytics.open();

    const after = await projectionIds();
    await relinker().drain();
    expect(links().map((link) => link.projection_id)).toEqual([
      after.get("team:evt-1"),
      after.get("team:evt-2"),
    ]);
  });

  test("a crash after the links followed but before the ledger settled replays harmlessly", async () => {
    await seedLinkedProjections();
    await analytics.ensureTable(accountKeyed, accountB);
    const pending = await analytics.nextTemporalProjectionMoves();
    expect(pending?.moves).toHaveLength(2);
    relinkTemporalAnnotationProjections(sqlite, pending!.moves);
    const relinked = links();

    expect(await relinker().drain()).toBe(0);
    expect(links()).toEqual(relinked);
    expect(await analytics.nextTemporalProjectionMoves()).toBeNull();
  });

  test("moves are applied oldest generation first, so a chain lands on its last id", () => {
    annotate("ta-1", "tp_a");
    expect(
      relinkTemporalAnnotationProjections(sqlite, [
        { from: "tp_a", to: "tp_b" },
        { from: "tp_b", to: "tp_c" },
      ]),
    ).toBe(2);
    expect(links()).toEqual([{ annotation_id: "ta-1", projection_id: "tp_c" }]);
  });

  test("a link already naming the new id keeps one row", () => {
    annotate("ta-1", "tp_a");
    sqlite
      .prepare(
        "INSERT INTO temporal_annotation_projections (annotation_id, projection_id) VALUES (?, ?)",
      )
      .run("ta-1", "tp_b");
    relinkTemporalAnnotationProjections(sqlite, [{ from: "tp_a", to: "tp_b" }]);
    expect(links()).toEqual([{ annotation_id: "ta-1", projection_id: "tp_b" }]);
  });
});
