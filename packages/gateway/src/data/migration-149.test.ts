// SPDX-License-Identifier: AGPL-3.0-or-later

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";

describe("migration 149: persisted replica version policy", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        multi_device_mode TEXT NOT NULL DEFAULT 'exclusive',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO sources
        (id, type, account_id, device_id, multi_device_mode, created_at, updated_at)
      VALUES
        ('fictional-tasks:local', 'fictional-tasks', 'local', 'device-one', 'replicated', 1, 1)
    `);
  });

  afterEach(() => db.close());

  test("adds an idempotent nullable contract without inventing one for legacy rows", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 149)!;
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    expect(db.prepare("SELECT replica_version_policy FROM sources").get()).toEqual({
      replica_version_policy: null,
    });
    expect(() =>
      db.prepare("UPDATE sources SET replica_version_policy = 'source-updated-at'").run(),
    ).not.toThrow();
    expect(() =>
      db.prepare("UPDATE sources SET replica_version_policy = 'arrival-order'").run(),
    ).toThrow(/CHECK constraint/i);
  });
});
