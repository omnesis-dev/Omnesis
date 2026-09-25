// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import SqliteDatabase from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { createNotificationQueueTables } from "../push/queue.js";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

const migration = MIGRATIONS.find((candidate) => candidate.version === 156)!;

function legacyDatabase(): Db {
  const db = new SqliteDatabase(":memory:") as unknown as Db;
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE devices (id TEXT PRIMARY KEY, revoked_at INTEGER);
    CREATE TABLE sources (id TEXT PRIMARY KEY);
    CREATE TABLE source_devices (
      source_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      PRIMARY KEY (source_id, device_id)
    );
    CREATE TABLE mobile_permission_health (
      source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      checked_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      valid_until INTEGER NOT NULL,
      aggregate_state TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      episode_id TEXT,
      episode_reason TEXT,
      episode_driver_ids_json TEXT NOT NULL DEFAULT '[]',
      episode_started_at INTEGER,
      last_notified_at INTEGER,
      notify_count INTEGER NOT NULL DEFAULT 0,
      reservation_token TEXT,
      reserved_until INTEGER
    );
    ALTER TABLE mobile_permission_health
      ADD COLUMN validity_anchored INTEGER NOT NULL DEFAULT 0;
    INSERT INTO devices VALUES ('phone-kept', NULL), ('phone-detached', NULL), ('phone-revoked', 50);
    INSERT INTO sources VALUES ('kept:local'), ('detached:local'), ('revoked:local');
    INSERT INTO source_devices VALUES ('kept:local', 'phone-kept'), ('revoked:local', 'phone-revoked');
    INSERT INTO mobile_permission_health
      (source_id, device_id, checked_at, received_at, valid_until, aggregate_state,
       capabilities_json, episode_id, episode_reason, episode_driver_ids_json,
       validity_anchored)
    VALUES
      ('kept:local', 'phone-kept', 10, 11, 20, 'permission-degraded',
       '[{"capability":"calendar","state":"denied"}]', 'episode-kept', 'known',
       '["calendar"]', 1),
      ('detached:local', 'phone-detached', 10, 11, 20, 'healthy', '[]', NULL, NULL, '[]', 1),
      ('revoked:local', 'phone-revoked', 10, 11, 20, 'healthy', '[]', NULL, NULL, '[]', 1);
  `);
  createNotificationQueueTables(db);
  db.exec(`
    INSERT INTO notifications
      (id, kind, target_id, route_data, title, body, collapse_id, created_at, expires_at)
    VALUES
      ('legacy-warning', 'source-permission', 'kept:local', NULL, 'Old', 'Old',
       'source-permission:0123456789abcdefabcd:fedcba9876543210fedc', 1, 100),
      ('new-warning', 'source-permission', 'kept:local', NULL, 'New', 'New',
       'source-permission:0123456789abcdefabcd:m:01234567:0123456789ab', 1, 100),
      ('new-stale-warning', 'source-permission', 'kept:local', NULL, 'New stale', 'New stale',
       'source-permission:0123456789abcdefabcd:stale:0123456789ab', 1, 100);
    INSERT INTO notification_deliveries
      (id, notification_id, device_id, state, lease_token, leased_until,
       wake_state, wake_lease_token, wake_leased_until, wake_next_attempt_at)
    VALUES
      ('legacy-delivery', 'legacy-warning', 'phone-kept', 'leased', 'legacy-lease', 50,
       'leased', 'legacy-wake-lease', 50, 25),
      ('new-delivery', 'new-warning', 'phone-kept', 'pending', NULL, NULL,
       'pending', NULL, NULL, 25),
      ('new-stale-delivery', 'new-stale-warning', 'phone-kept', 'pending', NULL, NULL,
       'pending', NULL, NULL, 25);
  `);
  return db;
}

describe("migration 156", () => {
  test("preserves active members, drops zombies, and rekeys reports per device", () => {
    const db = legacyDatabase();
    try {
      migration.up(db);

      expect(
        db
          .prepare<
            [],
            {
              source_id: string;
              device_id: string;
              aggregate_state: string;
              capabilities_json: string;
              episode_id: string | null;
              episode_reason: string | null;
              episode_driver_ids_json: string;
              validity_anchored: number;
            }
          >(
            `SELECT source_id, device_id, aggregate_state, capabilities_json,
                    episode_id, episode_reason, episode_driver_ids_json, validity_anchored
               FROM mobile_permission_health`,
          )
          .all(),
      ).toEqual([
        {
          source_id: "kept:local",
          device_id: "phone-kept",
          aggregate_state: "permission-degraded",
          capabilities_json: '[{"capability":"calendar","state":"denied"}]',
          episode_id: "episode-kept",
          episode_reason: "known",
          episode_driver_ids_json: '["calendar"]',
          validity_anchored: 1,
        },
      ]);
      expect(
        db
          .prepare<
            [],
            { name: string; pk: number }
          >("SELECT name, pk FROM pragma_table_info('mobile_permission_health') WHERE pk > 0 ORDER BY pk")
          .all(),
      ).toEqual([
        { name: "source_id", pk: 1 },
        { name: "device_id", pk: 2 },
      ]);

      db.exec(`
        INSERT INTO devices VALUES ('phone-second', NULL);
        INSERT INTO source_devices VALUES ('kept:local', 'phone-second');
        INSERT INTO mobile_permission_health
          (source_id, device_id, checked_at, received_at, valid_until, aggregate_state, capabilities_json)
        VALUES ('kept:local', 'phone-second', 1, 2, 3, 'healthy', '[]');
      `);
      expect(
        db
          .prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM mobile_permission_health")
          .get(),
      ).toEqual({ count: 2 });
      expect(() =>
        db
          .prepare(
            `INSERT INTO mobile_permission_health
             (source_id, device_id, checked_at, received_at, valid_until, aggregate_state, capabilities_json)
           VALUES ('kept:local', 'phone-second', 4, 5, 6, 'healthy', '[]')`,
          )
          .run(),
      ).toThrow();
      db.exec("DROP INDEX idx_mobile_permission_health_device");
      expect(() => migration.up(db)).not.toThrow();
      expect(
        db
          .prepare<
            [],
            {
              id: string;
              state: string;
              lease_token: string | null;
              wake_state: string;
              wake_lease_token: string | null;
              wake_leased_until: number | null;
              wake_next_attempt_at: number | null;
            }
          >(
            `SELECT id, state, lease_token, wake_state, wake_lease_token,
                    wake_leased_until, wake_next_attempt_at
               FROM notification_deliveries ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "legacy-delivery",
          state: "superseded",
          lease_token: null,
          wake_state: "terminal",
          wake_lease_token: null,
          wake_leased_until: null,
          wake_next_attempt_at: null,
        },
        {
          id: "new-delivery",
          state: "pending",
          lease_token: null,
          wake_state: "pending",
          wake_lease_token: null,
          wake_leased_until: null,
          wake_next_attempt_at: 25,
        },
        {
          id: "new-stale-delivery",
          state: "pending",
          lease_token: null,
          wake_state: "pending",
          wake_lease_token: null,
          wake_leased_until: null,
          wake_next_attempt_at: 25,
        },
      ]);
      expect(
        db
          .prepare<[], { name: string }>("PRAGMA index_list('mobile_permission_health')")
          .all()
          .map((row) => row.name),
      ).toContain("idx_mobile_permission_health_device");
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
