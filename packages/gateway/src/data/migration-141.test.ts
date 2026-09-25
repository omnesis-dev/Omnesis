// SPDX-License-Identifier: AGPL-3.0-or-later

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";

describe("migration 141: source mode transition journal", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE devices (id TEXT PRIMARY KEY);
      CREATE TABLE sources (id TEXT PRIMARY KEY);
      CREATE TABLE documents (source_id TEXT, stream_id TEXT);
      CREATE TABLE removed_documents (source_id TEXT, stream_id TEXT);
      CREATE TABLE document_absences (source_id TEXT, stream_id TEXT);
      CREATE TABLE document_absence_scopes (source_id TEXT, stream_id TEXT);
      CREATE TABLE document_absence_observations (source_id TEXT, stream_id TEXT);
      CREATE TABLE snapshot_absence_deletions (source_id TEXT, stream_id TEXT);
      CREATE TABLE sync_state (source_id TEXT, device_id TEXT);
      INSERT INTO devices (id) VALUES ('00000000-0000-4000-8000-000000000001');
      INSERT INTO sources (id) VALUES ('notes');
    `);
  });

  afterEach(() => db.close());

  test("creates an idempotent constrained journal tied to the live source", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 141)!;
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND (name LIKE 'idx_%_source_stream' OR name LIKE 'idx_%_source_nonshared_%') ORDER BY name",
        )
        .all(),
    ).toHaveLength(13);
    db.prepare(
      `INSERT INTO source_mode_transitions
         (source_id, from_mode, to_mode, owner_device_id, prepared_at)
       VALUES ('notes', 'exclusive', 'partitioned', ?, 1)`,
    ).run("00000000-0000-4000-8000-000000000001");
    expect(
      db.prepare("SELECT source_id, from_mode, to_mode FROM source_mode_transitions").all(),
    ).toEqual([{ source_id: "notes", from_mode: "exclusive", to_mode: "partitioned" }]);
    expect(() => db.prepare("UPDATE source_mode_transitions SET to_mode = 'fanout'").run()).toThrow(
      /CHECK constraint/i,
    );
    db.prepare("DELETE FROM sources WHERE id = 'notes'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM source_mode_transitions").get()).toEqual({ n: 0 });
  });
});
