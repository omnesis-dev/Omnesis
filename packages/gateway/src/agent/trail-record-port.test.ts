// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Coverage for `createGatewayTrailPort` surfacing `same-entity` bound rows as
 * point-in-time record citations (#757, sub-issue d). Proves the end-to-end
 * wiring against a real AnalyticsDb + SQLite store:
 *   - a record reachable from a seed document appears in the trail with its
 *     identity (recordKey) + redacted snapshot + derived fields, derived the
 *     SAME way `cite_record` derives them (the shared resolve step);
 *   - a document plus its same-entity row dedup to a SINGLE timeline entity
 *     (the document event carries the record; the row is not emitted twice);
 *   - a timeless table's row never becomes a trail record (frozen rule);
 *   - sensitive columns are redacted in the surfaced snapshot.
 *
 * All fixtures are invented (privacy rule).
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { analyticsRowKey } from "@omnesis/core";
import { ProviderId, SourceId } from "@omnesis/types";

import { AnalyticsDb } from "../analytics-db.js";
import { createDatabase } from "../db.js";
import { directWriteGate } from "../write-gate.js";
import { createGatewayTrailPort } from "./ports.js";
import type Database from "better-sqlite3";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";
import type { TrailEvent } from "@omnesis/core";

type Db = Database.Database;

const ANALYTICS_DB = `/tmp/omnesis-test-trail-record-${randomUUID()}.db`;

// A fictional structured source with a 1:1 doc↔row binding + a sensitive
// column and a declared semantic time.
const activitySchema: AnalyticsTableSchema = {
  tableName: "demo_activities",
  displayName: "Demo Activities",
  description: "Fictional activities for tests",
  columns: [
    { name: "id", type: "VARCHAR", description: "Activity id" },
    { name: "name", type: "VARCHAR", description: "Activity name" },
    { name: "distance_km", type: "DOUBLE", description: "Distance (km)" },
    { name: "device_token", type: "VARCHAR", description: "Device token", sensitive: true },
    { name: "start_time", type: "TIMESTAMPTZ", description: "Start time" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["name"],
    keyColumns: ["name", "distance_km", "device_token"],
  },
  boundDocument: { externalIdColumns: ["id"] },
};

// A timeless table (no semantic time) bound to its document — a row from it is
// reachable but is NOT a timeline record citation.
const profileSchema: AnalyticsTableSchema = {
  tableName: "demo_profiles",
  displayName: "Demo Profiles",
  description: "Fictional timeless profile snapshot",
  columns: [
    { name: "id", type: "VARCHAR", description: "Profile id" },
    { name: "nickname", type: "VARCHAR", description: "Nickname" },
  ],
  primaryKey: ["id"],
  semanticTimeColumn: null,
  record: { titleColumns: ["nickname"], keyColumns: ["nickname"] },
  boundDocument: { externalIdColumns: ["id"] },
};

let analytics: AnalyticsDb;
let sqlitePath: string;
let db: Db;

function cleanup(path: string): void {
  for (const suffix of ["", ".wal", "-wal", "-shm", "-journal"]) {
    try {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    } catch {
      /* ignore */
    }
  }
}

/** Insert a document with the given externalId; returns its gateway id. */
async function insertDoc(externalId: string, title: string, createdAt: string): Promise<string> {
  const gate = directWriteGate(db);
  await gate.upsertDocuments([
    {
      providerId: ProviderId("demo"),
      sourceId: SourceId("demo:acct1"),
      externalId,
      title,
      content: "Body",
      contentHash: "h-" + externalId,
      sourceCreatedAt: createdAt,
      sourceUpdatedAt: createdAt,
      metadata: { documentType: "activity" },
    },
  ]);
  const row = db
    .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
    .get(externalId);
  if (!row) throw new Error("expected doc id");
  return row.id;
}

beforeEach(async () => {
  analytics = new AnalyticsDb(ANALYTICS_DB);
  await analytics.open();
  await analytics.ensureTable(activitySchema, "demo:acct1");
  await analytics.ensureTable(profileSchema, "demo:acct1");
  sqlitePath = `/tmp/omnesis-test-trail-record-sqlite-${randomUUID()}.db`;
  db = createDatabase(sqlitePath);
});

afterEach(async () => {
  db.close();
  cleanup(sqlitePath);
  await analytics.close();
  cleanup(ANALYTICS_DB);
});

/** Flatten a trail's events (records are top-level; no nesting here). */
function eventsOf(trail: { events: TrailEvent[] }): TrailEvent[] {
  return trail.events;
}

describe("createGatewayTrailPort — bound-row record surfacing (#757)", () => {
  test("a record reachable from a seed surfaces with identity + snapshot + derived fields", async () => {
    const docId = await insertDoc("act-1", "Morning ride", "2026-05-01T08:30:00.000Z");
    await analytics.insertRecords(
      "demo_activities",
      [
        {
          id: "act-1",
          name: "Morning ride",
          distance_km: 12.5,
          device_token: "secret-xyz",
          start_time: "2026-05-01T08:30:00.000Z",
        },
      ],
      ["id"],
    );

    const trail = await createGatewayTrailPort(db, analytics).build([docId]);
    const events = eventsOf(trail);
    // Doc + its same-entity row dedup to a single timeline entity.
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.doc?.documentId).toBe(docId);
    expect(ev.record).toBeDefined();
    const rec = ev.record!;
    // Identity (recordKey === analyticsRowKey) round-trips.
    expect(rec.recordKey).toBe(analyticsRowKey("demo_activities", "act-1"));
    expect(rec.table).toBe("demo_activities");
    // Derived the SAME way cite_record derives — title from titleColumns.
    expect(rec.title).toBe("Morning ride");
    // The semantic time is the row's stored anchor value. The anchor column is
    // TIMESTAMPTZ, so it denotes one fixed instant: DuckDB renders it with an
    // explicit UTC offset, and it resolves back to the instant inserted
    // whatever zone the reading session happens to be in.
    expect(rec.semanticTime).toBeTruthy();
    expect(new Date(rec.semanticTime).toISOString()).toBe("2026-05-01T08:30:00.000Z");
    expect(rec.boundDocumentId).toBe(docId);
    expect(rec.sourceType).toBe("demo");
    // Snapshot present and key fields labelled by column description.
    expect(rec.snapshot.name).toBe("Morning ride");
    expect(rec.keyFields.find((f) => f.label === "Activity name")?.value).toBe("Morning ride");
    // The deduped event places by the row's semantic time (not the doc's).
    expect(ev.at).toBe(rec.semanticTime);
  });

  test("a document + its same-entity row dedup to a single timeline entity (not two)", async () => {
    const docId = await insertDoc("act-2", "Evening run", "2026-05-02T18:00:00.000Z");
    await analytics.insertRecords(
      "demo_activities",
      [
        {
          id: "act-2",
          name: "Evening run",
          distance_km: 5,
          device_token: "tok",
          start_time: "2026-05-02T18:00:00.000Z",
        },
      ],
      ["id"],
    );

    const events = eventsOf(await createGatewayTrailPort(db, analytics).build([docId]));
    // No standalone record-only event — the row collapsed onto the document.
    expect(events).toHaveLength(1);
    expect(events.filter((e) => !e.doc)).toHaveLength(0);
    expect(events[0]!.record?.recordKey).toBe(analyticsRowKey("demo_activities", "act-2"));
  });

  test("the surfaced record redacts sensitive columns in its snapshot + key fields", async () => {
    const docId = await insertDoc("act-3", "Trail hike", "2026-05-03T07:00:00.000Z");
    await analytics.insertRecords(
      "demo_activities",
      [
        {
          id: "act-3",
          name: "Trail hike",
          distance_km: 9,
          device_token: "super-secret",
          start_time: "2026-05-03T07:00:00.000Z",
        },
      ],
      ["id"],
    );

    const events = eventsOf(await createGatewayTrailPort(db, analytics).build([docId]));
    const rec = events[0]!.record!;
    expect(rec.snapshot.device_token).toBe("<redacted>");
    expect(rec.keyFields.find((f) => f.label === "Device token")?.value).toBe("<redacted>");
    // A non-sensitive column is NOT redacted.
    expect(rec.snapshot.name).toBe("Trail hike");
  });

  test("a row from a timeless table never becomes a trail record", async () => {
    const docId = await insertDoc("prof-1", "Profile", "2026-05-04T10:00:00.000Z");
    await analytics.insertRecords(
      "demo_profiles",
      [{ id: "prof-1", nickname: "Maya Reeves" }],
      ["id"],
    );

    const events = eventsOf(await createGatewayTrailPort(db, analytics).build([docId]));
    // Only the document — the timeless row carries no record and is dropped.
    expect(events).toHaveLength(1);
    expect(events[0]!.doc?.documentId).toBe(docId);
    expect(events[0]!.record).toBeUndefined();
  });

  test("a seed with no bound row produces an ordinary document trail (no record)", async () => {
    // No analytics row inserted for this doc's externalId.
    const docId = await insertDoc("act-9", "Lonely doc", "2026-05-05T12:00:00.000Z");
    const events = eventsOf(await createGatewayTrailPort(db, analytics).build([docId]));
    expect(events).toHaveLength(1);
    expect(events[0]!.record).toBeUndefined();
    // Falls back to the doc's own time when there's no record semantic time.
    expect(events[0]!.at).toBe("2026-05-05T12:00:00.000Z");
  });
});
