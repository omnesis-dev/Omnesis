// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 214 — how a device joined by signing in.
 *
 * Every column it adds is NULL on existing rows, and NULL is what keeps an
 * existing device and an unredeemed code under the rules they were made by: no
 * enrollment record, adoption by install id as before.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { addDeviceEnrollment } from "./migration-214-device-enrollment.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-mig214-"));
  db = new Database(join(dir, "test.db"));
  db.exec(`
    CREATE TABLE devices (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE device_pairings (pairing_code TEXT PRIMARY KEY, kind TEXT NOT NULL);
    CREATE TABLE tokens (id TEXT PRIMARY KEY, device_id TEXT NOT NULL);
    INSERT INTO devices VALUES ('d1', 'phone', 'ios');
    INSERT INTO device_pairings VALUES ('ABCDEF0123', 'cli');
    INSERT INTO tokens VALUES ('t1', 'd1');
  `);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("is the migration at its slot", () => {
  expect(MIGRATIONS.find((m) => m.version === 214)?.up).toBe(addDeviceEnrollment);
});

test("adds empty columns and runs twice", () => {
  addDeviceEnrollment(db);
  addDeviceEnrollment(db);
  expect(db.prepare("SELECT * FROM devices").get()).toEqual({
    id: "d1",
    name: "phone",
    kind: "ios",
    enrollment_public_key: null,
    enrollment_method: null,
    enrollment_sign_in: null,
    enrolled_at: null,
  });
  expect(db.prepare("SELECT * FROM device_pairings").get()).toEqual({
    pairing_code: "ABCDEF0123",
    kind: "cli",
    enrollment_public_key: null,
    enrollment_method: null,
    enrollment_sign_in: null,
  });
  expect(db.prepare("SELECT rotated_from FROM tokens").get()).toEqual({ rotated_from: null });
});

test("one device key names one device of a kind", () => {
  addDeviceEnrollment(db);
  db.exec(`
    INSERT INTO devices (id, name, kind, enrollment_public_key) VALUES ('d2', 'a', 'ios', 'k');
    INSERT INTO devices (id, name, kind, enrollment_public_key) VALUES ('d3', 'b', 'cli', 'k');
  `);
  expect(() =>
    db.exec(
      "INSERT INTO devices (id, name, kind, enrollment_public_key) VALUES ('d4', 'c', 'ios', 'k')",
    ),
  ).toThrow(/UNIQUE/);
});
