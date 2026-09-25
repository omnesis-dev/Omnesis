// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 21: collapse accumulated ghost portal devices onto one canonical
 * row. Simulates an install where blank-named browser logins minted a fresh
 * `portal-<8hex>` device per redeem, then runs the migration and asserts the
 * duplicates fold onto a single "portal" row (survivor = most-recently-used
 * token) while custom-named portal devices and other kinds are untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "./schema.js";
import { runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

function seedDevice(id: string, name: string, kind: string, pairedAt: number): void {
  db.prepare(
    `INSERT INTO devices (id, name, kind, capabilities, paired_at)
     VALUES (?, ?, ?, '{}', ?)`,
  ).run(id, name, kind, pairedAt);
}

function seedToken(id: string, deviceId: string, lastUsedAt: number | null): void {
  db.prepare(
    `INSERT INTO tokens (id, device_id, token_hash, scopes, name, created_at, last_used_at)
     VALUES (?, ?, ?, '["admin"]', NULL, ?, ?)`,
  ).run(id, deviceId, `hash-${id}`, 1000, lastUsedAt);
}

function deviceNames(): string[] {
  return db
    .prepare<[], { name: string; kind: string }>("SELECT name, kind FROM devices ORDER BY name")
    .all()
    .map((r) => r.name);
}

function tokenCountFor(deviceId: string): number {
  return (
    db
      .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM tokens WHERE device_id = ?")
      .get(deviceId)?.c ?? 0
  );
}

/**
 * Reset to the pre-21 head and run the migration runner. Migration 21 (the
 * subject of this test) collapses the ghost portal devices; any later steps in
 * the sequence are no-ops on this fixture, so the assertions below isolate the
 * 21 behavior while the runner still advances `user_version` to head.
 */
function runMigration21(): void {
  db.exec("PRAGMA user_version = 20");
  runMigrations(db);
}

describe("migration 21 — collapse ghost portal devices", () => {
  test("folds auto-named portal duplicates onto one canonical row", () => {
    // Three auto-named portal ghosts; the survivor is the one whose token was
    // used most recently (portal-aaaaaaaa).
    seedDevice("d-bare", "portal", "portal", 100);
    seedToken("t-bare", "d-bare", 1100);
    seedDevice("d-a", "portal-aaaaaaaa", "portal", 200);
    seedToken("t-a", "d-a", 1300); // most recent → survivor
    seedDevice("d-b", "portal-bbbbbbbb", "portal", 300);
    seedToken("t-b", "d-b", 1200);

    // A deliberately-named portal device and an unrelated kind: both untouched.
    seedDevice("d-kiosk", "my-kiosk", "portal", 400);
    seedToken("t-kiosk", "d-kiosk", 1400);
    seedDevice("d-cli", "bootstrap", "cli", 500);
    seedToken("t-cli", "d-cli", 1500);

    runMigration21();

    // Survivor keeps its row, renamed to the canonical "portal"; the other two
    // auto-named rows are gone.
    expect(
      db.prepare("SELECT id FROM devices WHERE name = 'portal-aaaaaaaa'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT id FROM devices WHERE name = 'portal-bbbbbbbb'").get(),
    ).toBeUndefined();
    const survivor = db
      .prepare<
        [],
        { id: string; name: string }
      >("SELECT id, name FROM devices WHERE kind = 'portal' AND name = 'portal'")
      .get();
    expect(survivor?.id).toBe("d-a");

    // All three ghost tokens now hang off the survivor.
    expect(tokenCountFor("d-a")).toBe(3);

    // Custom-named portal device + the cli device survive intact.
    expect(deviceNames()).toEqual(["bootstrap", "my-kiosk", "portal"]);
    expect(tokenCountFor("d-kiosk")).toBe(1);
    expect(tokenCountFor("d-cli")).toBe(1);

    // runMigrations applies the whole tail (21 + every later migration), so the
    // head reaches the current LATEST — not 21 specifically.
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      LATEST_SCHEMA_VERSION,
    );
  });

  test("is a no-op when only one portal device exists", () => {
    seedDevice("d-a", "portal", "portal", 100);
    seedToken("t-a", "d-a", 1100);

    runMigration21();

    expect(deviceNames()).toEqual(["portal"]);
    expect(tokenCountFor("d-a")).toBe(1);
  });

  test("second run changes nothing (idempotent)", () => {
    seedDevice("d-a", "portal-aaaaaaaa", "portal", 200);
    seedToken("t-a", "d-a", 1300);
    seedDevice("d-b", "portal-bbbbbbbb", "portal", 300);
    seedToken("t-b", "d-b", 1200);

    runMigration21();
    const after1 = { names: deviceNames(), survivorTokens: tokenCountFor("d-a") };

    // Re-running the runner is a no-op: the live version is already at head.
    runMigrations(db);
    expect(deviceNames()).toEqual(after1.names);
    expect(tokenCountFor("d-a")).toBe(after1.survivorTokens);
    expect(after1.names).toEqual(["portal"]);
    expect(after1.survivorTokens).toBe(2);
  });
});
