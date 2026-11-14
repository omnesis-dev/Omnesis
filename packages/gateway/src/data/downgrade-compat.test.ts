// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CURSOR_COMPAT_SCHEMA_VERSION,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  runDowngradeCompatCheck,
  runMigrations,
} from "./migrations.js";
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

/** The same for a member device's own cursor row. */
function writeMemberCursorAtVersion(
  db: Db,
  sourceId: string,
  deviceId: string,
  version: number,
): void {
  db.prepare(
    `INSERT INTO sync_state (source_id, device_id, cursor, minimum_gateway_version)
     VALUES (?, ?, '{"page":2}', ?)
     ON CONFLICT(source_id, device_id) DO UPDATE SET
       cursor = excluded.cursor,
       minimum_gateway_version = excluded.minimum_gateway_version`,
  ).run(sourceId, deviceId, version);
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
      .prepare<[], { source_id: string; cursor: string }>(
        "SELECT source_id, cursor FROM sync_state",
      )
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
      .prepare<[string], { cursor: string; minimum_gateway_version: number }>(
        "SELECT cursor, minimum_gateway_version FROM sync_state WHERE source_id = ?",
      )
      .get(incompatibleId)!;
    expect(incompatible.cursor).toBe("{}");
    expect(incompatible.minimum_gateway_version).toBe(0);

    const compatible = db
      .prepare<[string], { cursor: string; minimum_gateway_version: number }>(
        "SELECT cursor, minimum_gateway_version FROM sync_state WHERE source_id = ?",
      )
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
  test("stamps the cursor-compatibility version, not the schema head", () => {
    setSyncState(db, "gmail:alice@example.com", { page: 1 });

    const row = db
      .prepare<[string], { minimum_gateway_version: number }>(
        "SELECT minimum_gateway_version FROM sync_state WHERE source_id = ?",
      )
      .get("gmail:alice@example.com")!;
    expect(row.minimum_gateway_version).toBe(CURSOR_COMPAT_SCHEMA_VERSION);
    expect(row.minimum_gateway_version).toBeLessThan(LATEST_SCHEMA_VERSION);
  });

  test("restamps on subsequent writes", () => {
    // A row an older build stamped with its schema head is lowered on its next write.
    writeCursorAtVersion(db, "gmail:alice@example.com", LATEST_SCHEMA_VERSION - 1);

    setSyncState(db, "gmail:alice@example.com", { page: 2 });

    const row = db
      .prepare<[string], { minimum_gateway_version: number }>(
        "SELECT minimum_gateway_version FROM sync_state WHERE source_id = ?",
      )
      .get("gmail:alice@example.com")!;
    expect(row.minimum_gateway_version).toBe(CURSOR_COMPAT_SCHEMA_VERSION);
  });

  test("stamps a member's own cursor row the same way as the shared row", () => {
    setSyncState(db, "example-notes:shared", { page: 1 });
    setSyncState(
      db,
      "example-notes:shared",
      { page: 4 },
      undefined,
      undefined,
      false,
      undefined,
      "device-a",
    );
    setSyncState(
      db,
      "example-notes:shared",
      { page: 7 },
      undefined,
      undefined,
      false,
      undefined,
      "device-b",
    );

    expect(
      db
        .prepare<[], { device_id: string; minimum_gateway_version: number }>(
          "SELECT device_id, minimum_gateway_version FROM sync_state ORDER BY device_id",
        )
        .all(),
    ).toEqual([
      { device_id: "", minimum_gateway_version: CURSOR_COMPAT_SCHEMA_VERSION },
      { device_id: "device-a", minimum_gateway_version: CURSOR_COMPAT_SCHEMA_VERSION },
      { device_id: "device-b", minimum_gateway_version: CURSOR_COMPAT_SCHEMA_VERSION },
    ]);
  });
});

describe("a downgrade across migrations that leave cursors alone", () => {
  /**
   * The binary under test plays the older gateway: the database was written by
   * a build whose head is ahead of it, and every cursor row carries what that
   * build stamps — the cursor-compatibility version, which this binary is at or
   * past. Any binary between that version and the newer head is in the same
   * position, because the check compares each stamp with its own head.
   */
  test("keeps every cursor, shared and per member, byte for byte, with no epoch bumped", () => {
    const sourceId = "example-notes:shared";
    setSyncState(db, "gmail:alice@example.com", { historyId: "981", page: 12 });
    setSyncState(db, sourceId, { page: 1 });
    const memberEpoch = beginSyncAttempt(db, sourceId, "device-a");
    setSyncState(db, sourceId, { page: 4 }, undefined, undefined, false, memberEpoch, "device-a");
    const read = () =>
      db
        .prepare<[], { source_id: string; device_id: string; cursor: string; v: number }>(
          `SELECT source_id, device_id, cursor, minimum_gateway_version AS v
             FROM sync_state ORDER BY source_id, device_id`,
        )
        .all();
    const before = read();
    const epochs = () =>
      db.prepare("SELECT source_id, device_id, epoch FROM source_wipe_epoch ORDER BY 1, 2").all();
    const epochsBefore = epochs();

    setDbVersion(db, LATEST_SCHEMA_VERSION + 4);
    runDowngradeCompatCheck(db);

    expect(read()).toEqual(before);
    expect(epochs()).toEqual(epochsBefore);
  });

  test("still resets a source when one member's cursor needs a newer schema", () => {
    const sourceId = "example-notes:shared";
    setSyncState(db, sourceId, { page: 1 });
    writeMemberCursorAtVersion(db, sourceId, "device-a", LATEST_SCHEMA_VERSION + 2);
    const sharedEpoch = getWipeEpoch(db, sourceId);

    setDbVersion(db, LATEST_SCHEMA_VERSION + 2);
    runDowngradeCompatCheck(db);

    expect(
      db
        .prepare<[string], { device_id: string; cursor: string; v: number }>(
          `SELECT device_id, cursor, minimum_gateway_version AS v
             FROM sync_state WHERE source_id = ? ORDER BY device_id`,
        )
        .all(sourceId),
    ).toEqual([
      { device_id: "", cursor: "{}", v: 0 },
      { device_id: "device-a", cursor: "{}", v: 0 },
    ]);
    expect(getWipeEpoch(db, sourceId)).toBe(sharedEpoch + 1);
  });
});

/**
 * Which migrations change how a stored cursor is interpreted.
 *
 * Deciding is part of adding a migration. Flag it
 * (`invalidatesSourceCursors: true`) when a gateway built before it would
 * resume wrongly from a cursor row written after it: the migration changes
 * which `sync_state` row holds a device's cursor, what part of a source a
 * cursor row covers, or what other stored state must accompany a cursor for it
 * to be valid. A new table, column or index elsewhere, a backfill, or a change
 * to a cursor row's display metadata or error fields is not that. Over-flagging
 * costs a downgrade across it a resync; under-flagging lets an older gateway
 * resume from a cursor it misreads. When unsure, flag it and say why at the
 * flag.
 */
describe("the cursor-compatibility version", () => {
  /** Every migration through this version has been decided on. */
  const REVIEWED_THROUGH = 217;
  const FLAGGED = [131, 133, 134, 139, 141, 146, 178];

  test("every migration has been decided on", () => {
    expect(
      LATEST_SCHEMA_VERSION,
      "a migration was added: decide whether it changes how stored cursors are interpreted " +
        "(see the comment above this describe), flag it if so, then raise REVIEWED_THROUGH",
    ).toBe(REVIEWED_THROUGH);
  });

  test("is the highest flagged migration", () => {
    expect(MIGRATIONS.filter((m) => m.invalidatesSourceCursors).map((m) => m.version)).toEqual(
      FLAGGED,
    );
    expect(CURSOR_COMPAT_SCHEMA_VERSION).toBe(Math.max(...FLAGGED));
  });

  test("is no newer than any published release that carries the downgrade check", () => {
    // Every published release's head is at or past it, so moving back to any
    // of them keeps every source's sync position. The oldest is v0.5.11.
    expect(CURSOR_COMPAT_SCHEMA_VERSION).toBeLessThanOrEqual(181);
  });
});

describe("migration 211", () => {
  /** Put the database back to the step before 211, as an install at 210 holds it. */
  function atSchema210(): void {
    db.prepare("DELETE FROM schema_migrations WHERE version >= 211").run();
    setDbVersion(db, 210);
  }

  test("lowers head stamps to the cursor-compatibility version and leaves everything else", () => {
    atSchema210();
    const plant = db.prepare(
      `INSERT INTO sync_state (source_id, device_id, cursor, last_synced_at, minimum_gateway_version)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ?)`,
    );
    plant.run("gmail:alice@example.com", "", '{"historyId":"981"}', 210);
    plant.run("example-notes:shared", "", "{}", 0);
    plant.run("example-notes:shared", "device-a", '{"page":4}', 206);
    plant.run("example-notes:shared", "device-b", '{"page":9}', 181);
    plant.run("example-files:local", "", '{"page":2}', 150);
    plant.run("example-files:local", "device-c", '{"page":3}', 0);
    db.prepare(
      "INSERT INTO source_wipe_epoch (source_id, device_id, epoch) VALUES ('example-notes:shared', 'device-a', 3)",
    ).run();
    const rest = () =>
      db
        .prepare(
          `SELECT source_id, device_id, cursor, last_synced_at
             FROM sync_state ORDER BY source_id, device_id`,
        )
        .all();
    const restBefore = rest();
    const epochs = () => db.prepare("SELECT * FROM source_wipe_epoch ORDER BY 1, 2").all();
    const epochsBefore = epochs();

    runMigrations(db);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(
      db
        .prepare<[], { source_id: string; device_id: string; v: number }>(
          `SELECT source_id, device_id, minimum_gateway_version AS v
             FROM sync_state ORDER BY source_id, device_id`,
        )
        .all()
        .map((r) => [r.source_id, r.device_id, r.v]),
    ).toEqual([
      // Stamps at or below the compatibility version, and the 0 of a reset
      // row, are already what they should be.
      ["example-files:local", "", 150],
      ["example-files:local", "device-c", 0],
      ["example-notes:shared", "", 0],
      ["example-notes:shared", "device-a", CURSOR_COMPAT_SCHEMA_VERSION],
      ["example-notes:shared", "device-b", CURSOR_COMPAT_SCHEMA_VERSION],
      ["gmail:alice@example.com", "", CURSOR_COMPAT_SCHEMA_VERSION],
    ]);
    // Cursor bytes, sync times and write epochs are untouched.
    expect(rest()).toEqual(restBefore);
    expect(epochs()).toEqual(epochsBefore);

    // A second open finds nothing left to lower.
    atSchema210();
    const snapshot = db.prepare("SELECT * FROM sync_state ORDER BY 1, 2").all();
    runMigrations(db);
    expect(db.prepare("SELECT * FROM sync_state ORDER BY 1, 2").all()).toEqual(snapshot);
  });
});
