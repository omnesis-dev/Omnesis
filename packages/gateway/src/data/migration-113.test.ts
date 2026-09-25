// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

const migration = MIGRATIONS.find((candidate) => candidate.version === 114)!;

describe("migration 114", () => {
  test("adds and backfills episode cause metadata idempotently", () => {
    const db = new Database(":memory:") as unknown as Db;
    db.exec(`
      CREATE TABLE devices (id TEXT PRIMARY KEY);
      CREATE TABLE sources (id TEXT PRIMARY KEY, device_id TEXT REFERENCES devices(id));
      CREATE TABLE mobile_permission_health (
        source_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, checked_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL, valid_until INTEGER NOT NULL, aggregate_state TEXT NOT NULL,
        capabilities_json TEXT NOT NULL, episode_id TEXT, episode_started_at INTEGER,
        last_notified_at INTEGER, notify_count INTEGER NOT NULL DEFAULT 0,
        reservation_token TEXT, reserved_until INTEGER
      );
      INSERT INTO mobile_permission_health VALUES (
        'fictional-mobile:local', '00000000-0000-4000-8000-000000000001', 1, 1, 2,
        'background-access-missing',
        '[{"id":"background","label":"Background","state":"background-access-missing","requirement":"required","impact":"Stops.","remediation":"Enable it.","repairAction":"open-system-settings"}]',
        'episode-1', 1, NULL, 0, NULL, NULL
      );
    `);

    expect(() => migration.up(db)).not.toThrow();
    expect(() => migration.up(db)).not.toThrow();
    expect(
      db
        .prepare("SELECT episode_reason, episode_driver_ids_json FROM mobile_permission_health")
        .get(),
    ).toEqual({ episode_reason: "known", episode_driver_ids_json: '["background"]' });
    db.close();
  });
});
