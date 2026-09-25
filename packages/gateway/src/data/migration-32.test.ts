// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 32: back-fill `self_emails` / `self_phones` on the `devices` table.
 *
 * The regression this guards: the device owner's self identifiers (#282) were
 * only ever declared inline in `runSchemaSetup`'s `CREATE TABLE IF NOT EXISTS
 * devices`, which is a no-op on an already-existing `devices` table. The
 * sibling `device_pairings` columns got an ALTER migration (v18); the `devices`
 * table never did. So an install whose `devices` table predates #282 carried it
 * forward WITHOUT these columns — and `DEVICE_SELECT_COLS` selects them on every
 * `getDevice`/`listDevices`, throwing `no such column: self_emails` on a core,
 * always-hit path.
 *
 * This exercises that exact existing-DB path — a `devices` table missing the
 * columns, pinned at v31 — through `createDatabase`'s `runSchemaSetup` +
 * `runMigrations`, and asserts both a clean upgrade AND that the repository read
 * path (which is what actually crashed) works afterwards.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { runSchemaSetup } from "./schema.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import { listDevices } from "./repositories/DeviceRepository.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});

afterEach(() => {
  db.close();
});

describe("migration 32 — existing-DB upgrade", () => {
  test("back-fills self columns when devices predates #282 and stays readable via the repository", () => {
    // Build the full current schema, then DROP the self columns to recreate a
    // genuine pre-#282 `devices` (apns columns still present, self columns not),
    // pinned at v31 — the exact live shape that threw `no such column`.
    runSchemaSetup(db);
    db.exec("ALTER TABLE devices DROP COLUMN self_emails");
    db.exec("ALTER TABLE devices DROP COLUMN self_phones");
    db.exec(
      `INSERT INTO devices (id, name, kind, capabilities, paired_at)
         VALUES ('11111111-1111-4111-8111-111111111111', 'maya-laptop', 'cli', '{}', 1700000000000)`,
    );
    db.pragma("user_version = 31");

    // Reading through DEVICE_SELECT_COLS on the pre-migration shape is the
    // exact failure mode: the column the SELECT references does not exist yet.
    expect(() => listDevices(db)).toThrow(/self_emails/);

    // runSchemaSetup runs first (its CREATE IF NOT EXISTS is a no-op on the
    // existing table — it must NOT be what adds the columns), then the
    // migrations back-fill them. This is exactly the live boot order.
    expect(() => {
      runSchemaSetup(db);
      runMigrations(db, { log: createLogger("test") });
    }).not.toThrow();

    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
      .all()
      .map((r) => r.name);
    expect(cols).toContain("self_emails");
    expect(cols).toContain("self_phones");

    // The actual regression: the repository read path no longer throws, and the
    // pre-existing row is born with empty self info.
    const devices = listDevices(db);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      name: "maya-laptop",
      selfEmails: [],
      selfPhones: [],
    });

    // runMigrations always replays through to the latest version; assert
    // against the constant so a later migration doesn't break this test.
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("is a no-op on a fresh DB whose devices table already has the columns", () => {
    runSchemaSetup(db);
    db.pragma("user_version = 31");
    expect(() => runMigrations(db, { log: createLogger("test") })).not.toThrow();
    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('devices')")
      .all()
      .map((r) => r.name);
    // Exactly one of each — the pragma guard prevented a duplicate ALTER.
    expect(cols.filter((c) => c === "self_emails")).toHaveLength(1);
    expect(cols.filter((c) => c === "self_phones")).toHaveLength(1);
  });
});
