// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { createFreshTestDatabase } from "./fresh-database.js";

type GatewayDb = ReturnType<typeof createDatabase>;

const PRAGMAS = [
  "user_version",
  "journal_mode",
  "foreign_keys",
  "auto_vacuum",
  "page_size",
  "busy_timeout",
  "mmap_size",
  "synchronous",
  "encoding",
  "application_id",
] as const;

function schemaOf(db: GatewayDb): unknown[] {
  return db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all();
}

function pragmasOf(db: GatewayDb): Record<string, unknown> {
  return Object.fromEntries(PRAGMAS.map((name) => [name, db.pragma(name, { simple: true })]));
}

/** Every row of every table, with the time each migration ran left out. */
function rowsOf(db: GatewayDb): Record<string, unknown[]> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .pluck()
    .all() as string[];
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) {
    const query =
      table === "schema_migrations"
        ? "SELECT version, description FROM schema_migrations ORDER BY version"
        : `SELECT * FROM "${table}"`;
    rows[table] = db.prepare(query).raw().all();
  }
  return rows;
}

describe("createFreshTestDatabase", () => {
  let dir: string;
  const open: GatewayDb[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-fresh-db-test-"));
  });

  afterEach(() => {
    for (const db of open.splice(0)) db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function track(db: GatewayDb): GatewayDb {
    open.push(db);
    return db;
  }

  test("matches a database createDatabase builds on a new file", () => {
    const built = track(createDatabase(join(dir, "built.db")));
    const copied = track(createFreshTestDatabase(join(dir, "copied.db")));

    expect(schemaOf(copied)).toEqual(schemaOf(built));
    expect(pragmasOf(copied)).toEqual(pragmasOf(built));
    expect(pragmasOf(copied)).toMatchObject({ journal_mode: "wal", foreign_keys: 1 });
    expect(rowsOf(copied)).toEqual(rowsOf(built));
    expect(copied.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  test("gives every call its own database file", () => {
    const first = track(createFreshTestDatabase(join(dir, "first.db")));
    const second = track(createFreshTestDatabase(join(dir, "second.db")));

    first.exec("CREATE TABLE independence_probe (value TEXT)");
    first.prepare("INSERT INTO independence_probe (value) VALUES ('first')").run();

    const probe = "SELECT COUNT(*) FROM sqlite_master WHERE name = 'independence_probe'";
    expect(first.prepare(probe).pluck().get()).toBe(1);
    expect(second.prepare(probe).pluck().get()).toBe(0);
    expect(existsSync(join(dir, "first.db-wal"))).toBe(true);
  });

  test("refuses a path that already exists", () => {
    const path = join(dir, "existing.db");
    writeFileSync(path, "");

    expect(() => createFreshTestDatabase(path)).toThrow(/EEXIST/);
  });
});
