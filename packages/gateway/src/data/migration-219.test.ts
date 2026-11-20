// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  bindStorageRetentionPolicy,
  readBoundStorageRetentionPolicies,
  readStorageSourceIncarnation,
} from "../storage/retention-bindings.js";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import { addStorageAuthority } from "./migration-219-storage-authority.js";

it("migration219 preserves existing sources, binds their identity once, and preserves durable trim progress", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE sources(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE removed_sources(id TEXT PRIMARY KEY);
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, description TEXT, run_at INTEGER, duration_ms INTEGER);
      CREATE TABLE snapshot_absence_cascade_outbox(id INTEGER PRIMARY KEY);
      INSERT INTO sources VALUES ('fictional-notes:one', 123);
      PRAGMA user_version = 218`);
    // The v218 fixture exercises this historical step; migration-tail tests
    // replay the complete upgrade chain through the current schema.
    const migrations = MIGRATIONS.filter((migration) => migration.version === 219);
    expect(migrations).toHaveLength(1);
    expect(migrations[0]?.up).toBe(addStorageAuthority);
    runMigrations(db, { migrations });
    expect(db.pragma("user_version", { simple: true })).toBe(219);
    const sourceIncarnation = readStorageSourceIncarnation(db, "fictional-notes:one")!;
    const policy = { sourceId: "fictional-notes:one", maxAgeDays: 365, sourceIncarnation };
    expect(bindStorageRetentionPolicy(db, policy).stale).toBe(false);
    const bound = readBoundStorageRetentionPolicies(db, [policy]);
    db.prepare(
      `INSERT INTO storage_trim_jobs(id,kind,source_id,source_incarnation,before_date,state,
      cursor_date,cursor_id,upper_date,upper_id,revision,deleted,examined,skipped,created_at,updated_at)
      VALUES ('fictional-job','manual',?,?,'2031-01-01T00:00:00.000Z','running',
      '2020-01-02T00:00:00.000Z','doc-second','2020-01-03T00:00:00.000Z','doc-last',1,3,5,2,1,2)`,
    ).run(policy.sourceId, sourceIncarnation);
    addStorageAuthority(db);
    runMigrations(db, { migrations });
    expect(readStorageSourceIncarnation(db, policy.sourceId)).toBe(sourceIncarnation);
    expect(readBoundStorageRetentionPolicies(db, [policy])).toEqual(bound);
    expect(
      db
        .prepare(
          "SELECT state,cursor_id,deleted,examined,skipped FROM storage_trim_jobs WHERE id='fictional-job'",
        )
        .get(),
    ).toEqual({ state: "running", cursor_id: "doc-second", deleted: 3, examined: 5, skipped: 2 });
    expect(db.prepare("SELECT created_at FROM sources WHERE id=?").get(policy.sourceId)).toEqual({
      created_at: 123,
    });
  } finally {
    db.close();
  }
});
