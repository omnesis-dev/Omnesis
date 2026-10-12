// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migrations 198 and 199: open loops gain task fields, and the note agent
 * gains its queue.
 *
 * Each fixture opens a database at head, removes what the migration adds,
 * winds `user_version` back and plants rows an older install holds. Upgrading
 * must add the shape, leave existing loops as Brain suggestions awaiting
 * acceptance, and be a no-op when it runs again.
 *
 * All fixture data is invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";

const NOW = Date.parse("2026-09-01T09:00:00.000Z");
const TASK_COLUMNS = [
  "origin",
  "accepted",
  "scheduled_for",
  "proposed_change_json",
  "completion_note",
  "resolved_at",
];
const TASK_INDEXES = ["idx_open_loops_owned_schedule", "idx_open_loops_suggested"];

let directory: string;
let path: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "omnesis-migration-198-"));
  path = join(directory, "store.db");
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function open(): Database.Database {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  return db;
}

function columns(db: Database.Database, table: string): string[] {
  return db
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((row) => row.name);
}

function names(
  db: Database.Database,
  type: "table" | "index",
  wanted: readonly string[],
): string[] {
  return db
    .prepare<[string], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = ? ORDER BY name",
    )
    .all(type)
    .map((row) => row.name)
    .filter((name) => wanted.includes(name));
}

/** Wind back to `version`, with `undo` removing what the later migrations add. */
function seedOlder(version: number, undo: (db: Database.Database) => void): void {
  createDatabase(path).close();
  const db = open();
  try {
    undo(db);
    db.exec(`DELETE FROM schema_migrations WHERE version > ${version}`);
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

function undoNoteAgent(db: Database.Database): void {
  db.exec("DROP TABLE IF EXISTS note_agent_runs");
  db.exec("DROP TABLE IF EXISTS note_agent_meta");
}

function undoTaskFields(db: Database.Database): void {
  for (const index of TASK_INDEXES) db.exec(`DROP INDEX IF EXISTS ${index}`);
  for (const column of TASK_COLUMNS) db.exec(`ALTER TABLE open_loops DROP COLUMN ${column}`);
  db.exec("ALTER TABLE open_loop_ledger DROP COLUMN event_json");
}

describe("migration 198 — open loops become tasks", () => {
  function seedV197(): void {
    seedOlder(197, (db) => {
      undoNoteAgent(db);
      undoTaskFields(db);
      db.prepare(
        `INSERT INTO open_loops (id, created_by_run, state, confidence, importance, title, created_at, last_update)
         VALUES ('loop_open', 'run_seed', 'open', 0.8, 0.6, 'Renew the parking permit', ?, ?),
                ('loop_done', 'run_seed', 'done', 0.7, 0.4, 'Send the venue deposit', ?, ?)`,
      ).run(NOW, NOW, NOW, NOW);
      db.prepare(
        "INSERT INTO open_loop_ledger (loop_id, run_id, at, note) VALUES ('loop_open', 'run_seed', ?, 'Opened from an invented thread')",
      ).run(NOW);
    });
  }

  test("adds the task columns and the ledger event, keeping existing loops as Brain suggestions", () => {
    seedV197();
    const db = open();
    try {
      expect(columns(db, "open_loops")).not.toContain("origin");
      runMigrations(db);
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(columns(db, "open_loops")).toEqual(expect.arrayContaining(TASK_COLUMNS));
      expect(columns(db, "open_loop_ledger")).toContain("event_json");
      expect(names(db, "index", TASK_INDEXES)).toEqual(TASK_INDEXES);
      expect(
        db
          .prepare(
            `SELECT id, state, origin, accepted, scheduled_for, proposed_change_json, completion_note, resolved_at
               FROM open_loops ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "loop_done",
          state: "done",
          origin: "brain",
          accepted: 0,
          scheduled_for: null,
          proposed_change_json: null,
          completion_note: null,
          // A loop resolved before the migration resolved when it last changed.
          resolved_at: NOW,
        },
        {
          id: "loop_open",
          state: "open",
          origin: "brain",
          accepted: 0,
          scheduled_for: null,
          proposed_change_json: null,
          completion_note: null,
          resolved_at: null,
        },
      ]);
      expect(db.prepare("SELECT note, event_json FROM open_loop_ledger").all()).toEqual([
        { note: "Opened from an invented thread", event_json: null },
      ]);
    } finally {
      db.close();
    }
  });

  test("running it again is a no-op", () => {
    seedV197();
    const db = open();
    try {
      runMigrations(db);
      const snapshot = () => ({
        schema: db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
        loops: db.prepare("SELECT * FROM open_loops ORDER BY id").all(),
      });
      const before = snapshot();
      MIGRATIONS.find((m) => m.version === 198)!.up(db);
      expect(snapshot()).toEqual(before);
    } finally {
      db.close();
    }
  });
});

describe("migration 199 — the note agent queue", () => {
  test("creates the queue and its meta table, idempotently", () => {
    seedOlder(198, undoNoteAgent);
    const db = open();
    try {
      expect(names(db, "table", ["note_agent_meta", "note_agent_runs"])).toEqual([]);
      runMigrations(db);
      expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(names(db, "table", ["note_agent_meta", "note_agent_runs"])).toEqual([
        "note_agent_meta",
        "note_agent_runs",
      ]);
      expect(names(db, "index", ["idx_note_agent_runs_due"])).toEqual(["idx_note_agent_runs_due"]);

      const schema = () =>
        db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
      const before = schema();
      MIGRATIONS.find((m) => m.version === 199)!.up(db);
      expect(schema()).toEqual(before);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
