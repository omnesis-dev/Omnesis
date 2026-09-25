// SPDX-License-Identifier: AGPL-3.0-or-later
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";

describe("migration 139: persist source multi-device mode", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        kind TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '{}',
        paired_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => db.close());

  test("backfills the last valid announcement from non-revoked devices", () => {
    const insertDevice = db.prepare(
      `INSERT INTO devices
         (id, name, kind, capabilities, paired_at, last_seen_at, revoked_at)
       VALUES (?, ?, 'collector', ?, ?, ?, ?)`,
    );
    insertDevice.run(
      "older",
      "older",
      JSON.stringify({
        multiDeviceModes: { "fictional-notes": "handoff", "fictional-calendar": "handoff" },
      }),
      1,
      10,
      null,
    );
    insertDevice.run(
      "newer",
      "newer",
      JSON.stringify({
        multiDeviceModes: {
          "fictional-notes": "replicated",
          "fictional-calendar": "not-a-mode",
        },
      }),
      2,
      20,
      null,
    );
    insertDevice.run(
      "revoked",
      "revoked",
      JSON.stringify({ multiDeviceModes: { "fictional-notes": "partitioned" } }),
      3,
      30,
      30,
    );
    insertDevice.run("malformed", "malformed", "{", 4, 40, null);

    const insertSource = db.prepare(
      `INSERT INTO sources
         (id, type, account_id, device_id, config, enabled, created_at, updated_at)
       VALUES (?, ?, 'local', 'older', '{}', 1, 1, 1)`,
    );
    insertSource.run("notes", "fictional-notes");
    insertSource.run("calendar", "fictional-calendar");
    insertSource.run("unannounced", "fictional-files");

    const migration = MIGRATIONS.find((candidate) => candidate.version === 139);
    expect(migration).toBeDefined();
    migration!.up(db);

    const modes = db
      .prepare<
        [],
        { id: string; multi_device_mode: string }
      >("SELECT id, multi_device_mode FROM sources ORDER BY id")
      .all();
    expect(modes).toEqual([
      { id: "calendar", multi_device_mode: "handoff" },
      { id: "notes", multi_device_mode: "replicated" },
      { id: "unannounced", multi_device_mode: "exclusive" },
    ]);
  });

  test("is idempotent and rejects invalid stored modes", () => {
    db.prepare(
      `INSERT INTO sources
         (id, type, account_id, device_id, config, enabled, created_at, updated_at)
       VALUES ('notes', 'fictional-notes', 'local', 'device', '{}', 1, 1, 1)`,
    ).run();

    const migration = MIGRATIONS.find((candidate) => candidate.version === 139)!;
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(() =>
      db.prepare("UPDATE sources SET multi_device_mode = 'fanout' WHERE id = 'notes'").run(),
    ).toThrow(/CHECK constraint/i);
  });
});
