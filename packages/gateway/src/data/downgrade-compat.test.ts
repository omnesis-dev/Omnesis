// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LATEST_SCHEMA_VERSION, runDowngradeCompatCheck, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import {
  beginSyncAttempt,
  getWipeEpoch,
  setSyncState,
} from "./repositories/SyncStateRepository.js";
import type { Db } from "./types.js";

/** Open a fresh in-memory DB with the full current schema and advance its user_version. */
function openDb(): Db {
  const db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
  runMigrations(db);
  return db;
}

/** Simulate what a binary at `version` would stamp on cursor write. */
function writeCursorAtVersion(db: Db, sourceId: string, version: number): void {
  db.prepare(
    `INSERT INTO sync_state (source_id, cursor, minimum_gateway_version)
     VALUES (?, '{"page":1}', ?)
     ON CONFLICT(source_id, device_id) DO UPDATE SET
       cursor = excluded.cursor,
       minimum_gateway_version = excluded.minimum_gateway_version`,
  ).run(sourceId, version);
}

/** Force the DB's user_version to simulate a binary at an older schema version. */
function setDbVersion(db: Db, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

let db: Db;

beforeEach(() => {
  db = openDb();
});

afterEach(() => {
  db.close();
});

describe("runDowngradeCompatCheck", () => {
  test("no-ops when dbVersion === LATEST_SCHEMA_VERSION (same version)", () => {
    // DB is at head, binary is at head — nothing to do.
    const before = db.prepare<[], { cursor: string }>("SELECT cursor FROM sync_state").all();
    runDowngradeCompatCheck(db);
    const after = db.prepare<[], { cursor: string }>("SELECT cursor FROM sync_state").all();
    expect(after).toEqual(before);
  });

  test("no-ops when dbVersion < LATEST_SCHEMA_VERSION (upgrade path)", () => {
    // Simulates a DB that is behind head — the upgrade path; runMigrations handles it.
    setDbVersion(db, LATEST_SCHEMA_VERSION - 1);
    const before = db.prepare<[], { cursor: string }>("SELECT cursor FROM sync_state").all();
    runDowngradeCompatCheck(db);
    const after = db.prepare<[], { cursor: string }>("SELECT cursor FROM sync_state").all();
    expect(after).toEqual(before);
  });

  test("no-ops when downgrade detected but no sources are incompatible", () => {
    // Sources written at version <= binary's version are safe.
    writeCursorAtVersion(db, "gmail:alice@example.com", LATEST_SCHEMA_VERSION - 1);
    writeCursorAtVersion(db, "apple-notes:default", 0);
    // Simulate the DB having been written by a binary 2 versions ahead of us.
    setDbVersion(db, LATEST_SCHEMA_VERSION + 2);

    runDowngradeCompatCheck(db);

    const rows = db
      .prepare<
        [],
        { source_id: string; cursor: string }
      >("SELECT source_id, cursor FROM sync_state")
      .all();
    // Both sources are untouched (minimum_gateway_version <= LATEST_SCHEMA_VERSION).
    for (const row of rows) {
      expect(row.cursor).toBe('{"page":1}');
    }
  });

  test("resets incompatible sources and leaves compatible sources untouched", () => {
    const incompatibleId = "gmail:alice@example.com";
    const compatibleId = "apple-notes:default";
    const futureVersion = LATEST_SCHEMA_VERSION + 5;

    writeCursorAtVersion(db, incompatibleId, futureVersion);
    writeCursorAtVersion(db, compatibleId, LATEST_SCHEMA_VERSION - 1);

    // Simulate the DB being at a version ahead of us.
    setDbVersion(db, futureVersion);

    runDowngradeCompatCheck(db);

    const incompatible = db
      .prepare<
        [string],
        { cursor: string; minimum_gateway_version: number }
      >("SELECT cursor, minimum_gateway_version FROM sync_state WHERE source_id = ?")
      .get(incompatibleId)!;
    expect(incompatible.cursor).toBe("{}");
    expect(incompatible.minimum_gateway_version).toBe(0);

    const compatible = db
      .prepare<
        [string],
        { cursor: string; minimum_gateway_version: number }
      >("SELECT cursor, minimum_gateway_version FROM sync_state WHERE source_id = ?")
      .get(compatibleId)!;
    expect(compatible.cursor).toBe('{"page":1}');
    expect(compatible.minimum_gateway_version).toBe(LATEST_SCHEMA_VERSION - 1);
  });

  test("bumps wipe epoch for each reset source", () => {
    const sourceId = "gmail:alice@example.com";
    const futureVersion = LATEST_SCHEMA_VERSION + 3;

    writeCursorAtVersion(db, sourceId, futureVersion);
    const epochBefore = getWipeEpoch(db, sourceId);

    setDbVersion(db, futureVersion);
    runDowngradeCompatCheck(db);

    const epochAfter = getWipeEpoch(db, sourceId);
    expect(epochAfter).toBe(epochBefore + 1);
  });

  test("a reset revokes every member row's claim, not only the shared row", () => {
    const sourceId = "gmail:alice@example.com";
    const futureVersion = LATEST_SCHEMA_VERSION + 3;

    writeCursorAtVersion(db, sourceId, futureVersion);
    const memberClaim = beginSyncAttempt(db, sourceId, "device-a");
    const sharedBefore = getWipeEpoch(db, sourceId);

    setDbVersion(db, futureVersion);
    runDowngradeCompatCheck(db);

    expect(getWipeEpoch(db, sourceId)).toBe(sharedBefore + 1);
    expect(getWipeEpoch(db, sourceId, "device-a")).toBe(memberClaim + 1);
  });

  test("is idempotent — second call is a no-op after the first reset", () => {
    const sourceId = "notion:workspace1";
    const futureVersion = LATEST_SCHEMA_VERSION + 2;

    writeCursorAtVersion(db, sourceId, futureVersion);
    setDbVersion(db, futureVersion);

    runDowngradeCompatCheck(db);
    const epochAfterFirst = getWipeEpoch(db, sourceId);

    // Reset minimum_gateway_version was set to 0, so the second call sees no
    // incompatible sources even though dbVersion is still > LATEST_SCHEMA_VERSION.
    runDowngradeCompatCheck(db);
    const epochAfterSecond = getWipeEpoch(db, sourceId);

    expect(epochAfterSecond).toBe(epochAfterFirst);
  });

  test("handles missing minimum_gateway_version column gracefully (pre-v29 DB)", () => {
    // Simulate a DB that pre-dates migration 29 by dropping the column.
    // SQLite doesn't support DROP COLUMN in older versions, so we recreate the
    // table without it to mimic a DB from before this feature existed.
    db.exec(`
      CREATE TABLE sync_state_old AS SELECT
        source_id, cursor, last_synced_at, icon, label, url_patterns,
        last_error, errored_at, bg_color, accent_color, content_retention, consent_expires_at
      FROM sync_state
    `);
    db.exec("DROP TABLE sync_state");
    db.exec("ALTER TABLE sync_state_old RENAME TO sync_state");

    // Insert a row without the column.
    db.prepare("INSERT INTO sync_state (source_id, cursor) VALUES (?, '{\"page\":1}')").run(
      "gmail:alice@example.com",
    );

    // Simulate downgrade scenario.
    setDbVersion(db, LATEST_SCHEMA_VERSION + 5);

    // Should not throw — graceful degradation.
    expect(() => runDowngradeCompatCheck(db)).not.toThrow();

    // The cursor row must be untouched (the check skipped).
    const row = db
      .prepare<[string], { cursor: string }>("SELECT cursor FROM sync_state WHERE source_id = ?")
      .get("gmail:alice@example.com")!;
    expect(row.cursor).toBe('{"page":1}');
  });
});

describe("setSyncState stamps minimum_gateway_version", () => {
  test("stamps LATEST_SCHEMA_VERSION on every successful cursor write", () => {
    setSyncState(db, "gmail:alice@example.com", { page: 1 });

    const row = db
      .prepare<
        [string],
        { minimum_gateway_version: number }
      >("SELECT minimum_gateway_version FROM sync_state WHERE source_id = ?")
      .get("gmail:alice@example.com")!;
    expect(row.minimum_gateway_version).toBe(LATEST_SCHEMA_VERSION);
  });

  test("updates minimum_gateway_version on subsequent writes", () => {
    // Manually seed an older version to confirm it gets overwritten.
    writeCursorAtVersion(db, "gmail:alice@example.com", LATEST_SCHEMA_VERSION - 1);

    setSyncState(db, "gmail:alice@example.com", { page: 2 });

    const row = db
      .prepare<
        [string],
        { minimum_gateway_version: number }
      >("SELECT minimum_gateway_version FROM sync_state WHERE source_id = ?")
      .get("gmail:alice@example.com")!;
    expect(row.minimum_gateway_version).toBe(LATEST_SCHEMA_VERSION);
  });
});
