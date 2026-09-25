// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";

import { MIGRATIONS } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

const PRE_181_DEVICES = `CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '{}',
  paired_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  install_id TEXT,
  self_emails TEXT NOT NULL DEFAULT '[]',
  self_phones TEXT NOT NULL DEFAULT '[]'
)`;

const PRE_181_PAIRINGS = `CREATE TABLE device_pairings (
  pairing_code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

function columns(table = "devices"): string[] {
  return db
    .prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map((r) => r.name);
}

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
  db.exec(PRE_181_DEVICES);
  db.exec(PRE_181_PAIRINGS);
});

afterEach(() => db.close());

test("migration 181 adds a nullable access_level_id to devices and pairings, idempotently", () => {
  const migration = MIGRATIONS.find((m) => m.version === 181);
  expect(migration).toBeDefined();

  // A row paired before the migration reads as on no level, with no back-fill.
  db.prepare(
    "INSERT INTO devices (id, name, kind, paired_at) VALUES ('d1', 'old-cli', 'cli', 1)",
  ).run();
  expect(columns()).not.toContain("access_level_id");
  migration!.up(db);
  expect(columns()).toContain("access_level_id");
  expect(() => migration!.up(db)).not.toThrow();
  expect(columns().filter((c) => c === "access_level_id")).toHaveLength(1);
  expect(columns("device_pairings").filter((c) => c === "access_level_id")).toHaveLength(1);

  const read = () =>
    db
      .prepare<
        [string],
        { access_level_id: string | null }
      >("SELECT access_level_id FROM devices WHERE id = ?")
      .get("d1")?.access_level_id;
  expect(read()).toBeNull();
  db.prepare("UPDATE devices SET access_level_id = ? WHERE id = ?").run("level-1", "d1");
  expect(read()).toBe("level-1");
});
