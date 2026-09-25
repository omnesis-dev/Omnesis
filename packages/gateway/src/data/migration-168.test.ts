// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { createDeviceDoctorRunsTable } from "./repositories/DeviceDoctorRunRepository.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE devices (id TEXT PRIMARY KEY)");
});

afterEach(() => db.close());

test("creates the device doctor run table with its state and device constraints idempotently", () => {
  createDeviceDoctorRunsTable(db);
  createDeviceDoctorRunsTable(db);

  expect(
    db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('device_doctor_runs')")
      .all()
      .map((column) => column.name),
  ).toEqual([
    "device_id",
    "run_id",
    "state",
    "requested_at",
    "started_at",
    "deadline_at",
    "completed_at",
    "detail",
    "report_json",
  ]);

  expect(() =>
    db
      .prepare(
        `INSERT INTO device_doctor_runs (device_id, run_id, state, requested_at)
         VALUES ('missing', 'run-1', 'pending', '2026-01-01T00:00:00.000Z')`,
      )
      .run(),
  ).toThrow(/FOREIGN KEY/);

  db.prepare("INSERT INTO devices (id) VALUES ('device-1')").run();
  expect(() =>
    db
      .prepare(
        `INSERT INTO device_doctor_runs (device_id, run_id, state, requested_at)
         VALUES ('device-1', 'run-1', 'unknown', '2026-01-01T00:00:00.000Z')`,
      )
      .run(),
  ).toThrow(/CHECK constraint/);

  db.prepare(
    `INSERT INTO device_doctor_runs (device_id, run_id, state, requested_at)
     VALUES ('device-1', 'run-1', 'pending', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.prepare("DELETE FROM devices WHERE id = 'device-1'").run();
  expect(db.prepare("SELECT COUNT(*) AS count FROM device_doctor_runs").get()).toEqual({
    count: 0,
  });
});
