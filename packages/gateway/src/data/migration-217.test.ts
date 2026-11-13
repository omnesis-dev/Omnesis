// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 217 — revocation sticks, and each device records its sign-in.
 *
 * The new columns are NULL on existing rows (they joined before the sign-in
 * was recorded), and every device already revoked has its key remembered, so
 * revoking before the upgrade holds that key just like revoking after it.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { addStickyDeviceRevocation } from "./migration-217-sticky-revocation.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-mig217-"));
  db = new Database(join(dir, "test.db"));
  db.exec(`
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, revoked_at INTEGER, enrollment_public_key TEXT
    );
    CREATE TABLE device_pairings (pairing_code TEXT PRIMARY KEY, kind TEXT NOT NULL);
    INSERT INTO devices VALUES ('live', 'ios', NULL, 'key-live');
    INSERT INTO devices VALUES ('revoked-ios', 'ios', 300, 'key-shared');
    INSERT INTO devices VALUES ('revoked-cli', 'cli', 200, 'key-shared');
    INSERT INTO devices VALUES ('revoked-qr', 'cli', 100, NULL);
    INSERT INTO device_pairings VALUES ('ABCDEF0123', 'cli');
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("is the migration at its slot", () => {
  expect(MIGRATIONS.find((m) => m.version === 217)?.up).toBe(addStickyDeviceRevocation);
});

test("adds empty sign-in columns, remembers the keys of revoked devices only, and runs twice", () => {
  addStickyDeviceRevocation(db);
  addStickyDeviceRevocation(db);
  expect(db.prepare("SELECT id, enrollment_sign_in_id FROM devices ORDER BY id").all()).toEqual([
    { id: "live", enrollment_sign_in_id: null },
    { id: "revoked-cli", enrollment_sign_in_id: null },
    { id: "revoked-ios", enrollment_sign_in_id: null },
    { id: "revoked-qr", enrollment_sign_in_id: null },
  ]);
  expect(db.prepare("SELECT * FROM device_pairings").get()).toEqual({
    pairing_code: "ABCDEF0123",
    kind: "cli",
    enrollment_sign_in_id: null,
  });
  expect(db.prepare("SELECT * FROM revoked_device_keys").all()).toEqual([
    { public_key: "key-shared", revoked_at: 200 },
  ]);
});
