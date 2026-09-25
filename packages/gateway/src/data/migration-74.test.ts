// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 74 brings stored temporal rows onto the current vocabulary and the
 * current interval invariant.
 *
 * Two hazards, both silent if the migration is wrong. A row still spelling a
 * retired kind would be filtered by a name no client sends any more, so it
 * would simply stop appearing. And a fact with no duration used to be padded
 * to one millisecond, which every consumer computing a duration reads as 1 ms
 * rather than 0 — the padding has to come off, but only from the rows that
 * carried it, never from a genuinely one-millisecond span.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations.js";

let db: Database.Database;

const migration74 = MIGRATIONS.find((m) => m.version === 74)!;

beforeEach(() => {
  db = new Database(":memory:");
});

afterEach(() => db.close());

/**
 * The two tables as they stood before this migration: no vocabulary CHECK on
 * annotations, a strictly-positive interval CHECK on document projections.
 */
function seedLegacyTables(): void {
  db.exec(`
    CREATE TABLE documents (id TEXT PRIMARY KEY);
    CREATE TABLE document_temporal_projections (
      id TEXT PRIMARY KEY CHECK (id LIKE 'tp_%'),
      source_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      document_external_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_exclusive_ms INTEGER NOT NULL CHECK (end_exclusive_ms > start_ms),
      start_canonical TEXT NOT NULL,
      end_canonical TEXT NOT NULL,
      precision TEXT NOT NULL CHECK (precision IN ('instant', 'day')),
      all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
      time_zone TEXT,
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('visit', 'calendar_event', 'event', 'deadline', 'reminder', 'expiry', 'episode')),
      modality TEXT NOT NULL,
      status TEXT NOT NULL,
      source_updated_at TEXT,
      projected_at TEXT NOT NULL,
      UNIQUE(document_id, slot)
    );
    CREATE TABLE temporal_annotations (
      id TEXT PRIMARY KEY,
      interval_start_ms INTEGER NOT NULL,
      interval_end_ms INTEGER NOT NULL,
      granularity TEXT NOT NULL,
      canonical TEXT,
      sentence TEXT NOT NULL,
      kind TEXT,
      created_by_run TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      invalidated_at INTEGER,
      thread_conversation_id TEXT
    );
    CREATE TABLE sync_state (source_id TEXT PRIMARY KEY, last_synced_at TEXT);
    CREATE INDEX idx_document_temporal_projections_window
      ON document_temporal_projections(start_ms, end_exclusive_ms);
    CREATE INDEX idx_document_temporal_projections_source
      ON document_temporal_projections(source_id, slot);
  `);
  db.prepare("INSERT INTO documents (id) VALUES ('doc_1'), ('doc_2'), ('doc_3')").run();

  const insert = db.prepare(
    `INSERT INTO document_temporal_projections (
       id, source_id, document_id, document_external_id, slot,
       start_ms, end_exclusive_ms, start_canonical, end_canonical,
       precision, all_day, time_zone, label, kind, modality, status,
       source_updated_at, projected_at
     ) VALUES (?, 'mail:inbox', ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'scheduled', 'active', NULL, '2026-07-01T00:00:00.000Z')`,
  );
  // A padded instantaneous fact carrying a retired kind.
  insert.run(
    "tp_padded",
    "doc_1",
    "ext_1",
    1_700_000_000_000,
    1_700_000_000_001,
    "2026-07-02T00:00:00.000Z",
    "2026-07-02T00:00:00.001Z",
    "instant",
    0,
    "Policy review",
    "calendar_event",
  );
  // A genuine span, which must survive untouched.
  insert.run(
    "tp_span",
    "doc_2",
    "ext_2",
    1_700_000_000_000,
    1_700_000_000_000 + 3_600_000,
    "2026-07-02T00:00:00.000Z",
    "2026-07-02T01:00:00.000Z",
    "instant",
    0,
    "Quarterly planning",
    "event",
  );
  // An all-day span, whose end is the exclusive next day.
  insert.run(
    "tp_day",
    "doc_3",
    "ext_3",
    1_700_000_000_000,
    1_700_086_400_000,
    "2026-07-02",
    "2026-07-03",
    "day",
    1,
    "Studio closed",
    "calendar_event",
  );

  const annotate = db.prepare(
    `INSERT INTO temporal_annotations
       (id, interval_start_ms, interval_end_ms, granularity, canonical, sentence, kind,
        created_by_run, created_at, updated_at)
     VALUES (?, 1, 2, 'day', '2026-07-02', ?, ?, 'run_1', 1, 1)`,
  );
  annotate.run("ta_retired", "A long stretch of work.", "episodic");
  annotate.run("ta_kept", "The renewal decision is due.", "deadline");
  annotate.run("ta_unclassified", "Something happened.", null);
}

describe("migration 74", () => {
  it("resolves retired kind spellings in both stores", () => {
    seedLegacyTables();
    migration74.up(db);

    const kinds = db
      .prepare("SELECT id, kind FROM document_temporal_projections ORDER BY id")
      .all() as Array<{ id: string; kind: string }>;
    expect(kinds).toEqual([
      { id: "tp_day", kind: "appointment" },
      { id: "tp_padded", kind: "appointment" },
      { id: "tp_span", kind: "event" },
    ]);

    const annotations = db
      .prepare("SELECT id, kind FROM temporal_annotations ORDER BY id")
      .all() as Array<{ id: string; kind: string | null }>;
    expect(annotations).toEqual([
      { id: "ta_kept", kind: "deadline" },
      { id: "ta_retired", kind: "episode" },
      // An unclassified annotation is not corruption — the author recorded
      // what a time means without classifying its nature.
      { id: "ta_unclassified", kind: null },
    ]);
  });

  it("collapses the padding on instantaneous facts and leaves real spans alone", () => {
    seedLegacyTables();
    migration74.up(db);

    const rows = db
      .prepare(
        `SELECT id, start_ms, end_exclusive_ms, start_canonical, end_canonical
         FROM document_temporal_projections ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      start_ms: number;
      end_exclusive_ms: number;
      start_canonical: string;
      end_canonical: string;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));

    const padded = byId.get("tp_padded")!;
    expect(padded.end_exclusive_ms - padded.start_ms).toBe(0);
    expect(padded.end_canonical).toBe(padded.start_canonical);

    const span = byId.get("tp_span")!;
    expect(span.end_exclusive_ms - span.start_ms).toBe(3_600_000);
    expect(span.end_canonical).toBe("2026-07-02T01:00:00.000Z");

    const day = byId.get("tp_day")!;
    expect(day.end_exclusive_ms - day.start_ms).toBe(86_400_000);
    expect(day.end_canonical).toBe("2026-07-03");
  });

  it("leaves the rebuilt table accepting an empty interval and refusing a foreign kind", () => {
    seedLegacyTables();
    migration74.up(db);

    const insert = (id: string, kind: string, endMs: number): void => {
      db.prepare(
        `INSERT INTO document_temporal_projections (
           id, source_id, document_id, document_external_id, slot,
           start_ms, end_exclusive_ms, start_canonical, end_canonical,
           precision, all_day, time_zone, label, kind, modality, status,
           source_updated_at, projected_at
         ) VALUES (?, 'mail:inbox', 'doc_1', ?, ?, 100, ?, 'a', 'b', 'instant', 0, NULL,
                   'l', ?, 'scheduled', 'active', NULL, 'p')`,
      ).run(id, id, id, endMs, kind);
    };

    // A point in time is now representable.
    expect(() => insert("tp_zero", "event", 100)).not.toThrow();
    // A kind outside the vocabulary is not — including the spellings this
    // migration just retired, so a stale writer cannot reintroduce them.
    expect(() => insert("tp_bad", "calendar_event", 200)).toThrow(/CHECK/i);
    expect(() => insert("tp_worse", "meeting", 200)).toThrow(/CHECK/i);
    // An end before its start remains impossible.
    expect(() => insert("tp_reversed", "event", 99)).toThrow(/CHECK/i);
  });

  it("leaves the rebuilt table indexed for window and source lookups", () => {
    seedLegacyTables();
    migration74.up(db);

    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'document_temporal_projections'
           AND name LIKE 'idx_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual([
      "idx_document_temporal_projections_source",
      "idx_document_temporal_projections_window",
    ]);
  });

  it("is safe to replay", () => {
    seedLegacyTables();
    migration74.up(db);
    const first = db
      .prepare(
        "SELECT id, kind, start_ms, end_exclusive_ms FROM document_temporal_projections ORDER BY id",
      )
      .all();

    migration74.up(db);
    const second = db
      .prepare(
        "SELECT id, kind, start_ms, end_exclusive_ms FROM document_temporal_projections ORDER BY id",
      )
      .all();

    expect(second).toEqual(first);
  });

  it("does nothing when the temporal tables were never created", () => {
    db.exec("CREATE TABLE documents (id TEXT PRIMARY KEY)");
    expect(() => migration74.up(db)).not.toThrow();
  });
});
