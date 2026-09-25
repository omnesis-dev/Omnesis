// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 172 — a source row can carry what its source declares about the
 * account.
 *
 * The interesting property is that there is nothing to backfill. Null is the
 * truthful value for every existing row: no source has declared anything yet,
 * and inventing a descriptor from the id is precisely the inference this
 * column exists to remove.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addSourceAccountDescriptor } from "./migration-172-source-account.js";

describe("a source row gains a place for a declared account", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-mig172-"));
    db = new Database(join(dir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const columns = () =>
    (db.prepare("SELECT name FROM pragma_table_info('sources')").all() as { name: string }[]).map(
      (c) => c.name,
    );

  function legacySources(): void {
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        account_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      )
    `);
  }

  test("the column is added, and existing rows keep everything they had", () => {
    legacySources();
    db.prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?)").run(
      "gmail:maya@example.com",
      "gmail",
      "maya@example.com",
      "device-1",
      1,
    );

    addSourceAccountDescriptor(db);

    expect(columns()).toContain("account");
    const row = db.prepare("SELECT * FROM sources WHERE id = ?").get("gmail:maya@example.com") as
      | Record<string, unknown>
      | undefined;
    expect(row?.account_id).toBe("maya@example.com");
    expect(row?.enabled).toBe(1);
  });

  test("an existing row's account is null, because nothing has declared one", () => {
    // Not a gap to fill. Deriving a descriptor from the id would be the same
    // inference the column exists to replace, and it would be indistinguishable
    // afterwards from something a source actually said.
    legacySources();
    db.prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?)").run(
      "things:local",
      "things",
      "local",
      "device-1",
      1,
    );

    addSourceAccountDescriptor(db);

    const row = db.prepare("SELECT account FROM sources WHERE id = ?").get("things:local") as
      | { account: unknown }
      | undefined;
    expect(row?.account).toBeNull();
  });

  test("running it twice changes nothing", () => {
    legacySources();
    addSourceAccountDescriptor(db);
    expect(() => addSourceAccountDescriptor(db)).not.toThrow();
    expect(columns().filter((c) => c === "account")).toHaveLength(1);
  });

  test("an install that already has the column is left alone", () => {
    db.exec(`
      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        account_id TEXT NOT NULL,
        account TEXT,
        device_id TEXT NOT NULL
      )
    `);
    db.prepare("INSERT INTO sources VALUES (?, ?, ?, ?, ?)").run(
      "gmail:maya@example.com",
      "gmail",
      "maya@example.com",
      '{"id":"maya@example.com"}',
      "device-1",
    );

    addSourceAccountDescriptor(db);

    const row = db.prepare("SELECT account FROM sources").get() as { account: string };
    expect(JSON.parse(row.account)).toEqual({ id: "maya@example.com" });
  });

  test("a database with no sources table at all is not an error", () => {
    // The idempotent CREATE carries the column, so a fresh install reaches
    // this migration with nothing to alter.
    expect(() => addSourceAccountDescriptor(db)).not.toThrow();
  });
});
