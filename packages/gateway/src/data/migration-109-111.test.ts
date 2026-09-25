// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '{}',
      paired_at INTEGER NOT NULL,
      last_seen_at INTEGER,
      self_emails TEXT NOT NULL DEFAULT '[]',
      self_phones TEXT NOT NULL DEFAULT '[]',
      apns_device_token TEXT,
      apns_environment TEXT,
      apns_bundle_id TEXT,
      apns_token_updated_at INTEGER,
      fcm_registration_token TEXT,
      fcm_token_updated_at INTEGER
    );
    CREATE TABLE tokens (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      scopes TEXT NOT NULL
    )
  `);
});

afterEach(() => db.close());

describe("push queue migrations", () => {
  test("migration 109 adds device transport columns idempotently", () => {
    db.exec(`
      INSERT INTO devices (id, name, kind, paired_at)
      VALUES ('phone', 'Fictional phone', 'ios', 1), ('cli', 'Fictional CLI', 'cli', 1);
      INSERT INTO tokens (id, device_id, scopes)
      VALUES ('phone-token', 'phone', '["admin","read"]'), ('cli-token', 'cli', '["admin"]')
    `);
    const migration = MIGRATIONS.find((candidate) => candidate.version === 109)!;
    migration.up(db);
    migration.up(db);
    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining(["push_transport", "relay_url", "relay_credential"]),
    );
    expect(
      db
        .prepare<[string], { scopes: string }>("SELECT scopes FROM tokens WHERE id = ?")
        .get("phone-token")?.scopes,
    ).toBe('["admin","read","push:claim"]');
    expect(
      db
        .prepare<[string], { scopes: string }>("SELECT scopes FROM tokens WHERE id = ?")
        .get("cli-token")?.scopes,
    ).toBe('["admin"]');
  });

  test("migration 110 creates the content and per-device delivery tables idempotently", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 110)!;
    migration.up(db);
    migration.up(db);
    const tables = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["notifications", "notification_deliveries"]));
    const notificationColumns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('notifications')")
      .all()
      .map((row) => row.name);
    expect(notificationColumns).toEqual([
      "id",
      "kind",
      "target_id",
      "title",
      "body",
      "collapse_id",
      "created_at",
      "expires_at",
    ]);
    expect(
      db
        .prepare<[], { name: string }>(
          "SELECT name FROM pragma_table_info('notification_deliveries')",
        )
        .all()
        .map((row) => row.name),
    ).toEqual(
      expect.arrayContaining([
        "id",
        "notification_id",
        "device_id",
        "state",
        "lease_token",
        "leased_until",
        "claimed_at",
        "delivered_at",
      ]),
    );
  });

  test("migration 111 adds phone delivery-health columns idempotently", () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 111)!;
    migration.up(db);
    migration.up(db);
    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
      .all()
      .map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "notification_delivery_health",
        "notification_delivery_health_updated_at",
      ]),
    );
  });

  test("migration 112 adds typed route storage idempotently", () => {
    db.exec(`
      CREATE TABLE notifications (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, collapse_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    const migration = MIGRATIONS.find((candidate) => candidate.version === 112)!;
    migration.up(db);
    migration.up(db);
    const columns = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('notifications')")
      .all()
      .map((row) => row.name);
    expect(columns).toContain("route_data");
  });

  test("an already-v111 queue upgrades to v112 without losing pending content", () => {
    MIGRATIONS.find((candidate) => candidate.version === 110)!.up(db);
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        description TEXT NOT NULL,
        run_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL
      );
      INSERT INTO notifications
        (id, kind, target_id, title, body, collapse_id, created_at, expires_at)
      VALUES
        ('notification-1', 'brief', 'brief-fictional', 'Fictional brief',
         'Invented summary.', 'brief-fictional', 1000, 2000);
      PRAGMA user_version = 111;
    `);

    runMigrations(db);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(
      db
        .prepare<
          [],
          { route_data: string | null; body: string }
        >("SELECT route_data, body FROM notifications WHERE id = 'notification-1'")
        .get(),
    ).toEqual({ route_data: null, body: "Invented summary." });
  });

  test("migration 116 adds retry leasing without losing pending deliveries", () => {
    MIGRATIONS.find((candidate) => candidate.version === 110)!.up(db);
    db.exec(`
      INSERT INTO devices (id, name, kind, paired_at)
      VALUES ('phone-retry', 'Fictional retry phone', 'ios', 1);
      INSERT INTO notifications
        (id, kind, target_id, title, body, collapse_id, created_at, expires_at)
      VALUES
        ('notification-retry', 'brief', 'brief-fictional', 'Fictional brief',
         'Invented summary.', 'brief-fictional', 1000, 2000);
      INSERT INTO notification_deliveries (id, notification_id, device_id, state)
      VALUES ('delivery-retry', 'notification-retry', 'phone-retry', 'pending');
    `);
    const migration = MIGRATIONS.find((candidate) => candidate.version === 116)!;
    migration.up(db);
    migration.up(db);

    expect(
      db
        .prepare<
          [],
          { wake_state: string; wake_attempt_count: number; wake_next_attempt_at: number }
        >(
          `SELECT wake_state, wake_attempt_count, wake_next_attempt_at
             FROM notification_deliveries
            WHERE id = 'delivery-retry'`,
        )
        .get(),
    ).toEqual({ wake_state: "pending", wake_attempt_count: 0, wake_next_attempt_at: 0 });
    const indexes = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notification_deliveries'",
      )
      .all()
      .map((row) => row.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        "idx_notification_deliveries_wake_token",
        "idx_notification_deliveries_wake_due",
      ]),
    );
  });
});
