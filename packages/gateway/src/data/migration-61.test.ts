// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runSchemaSetup } from "./schema.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  db.pragma("foreign_keys = ON");
});

afterEach(() => db.close());

describe("migration 61 - privacy reviewer health index", () => {
  test("adds the answer task review-time index to an existing v60 database", () => {
    runSchemaSetup(db);
    db.exec("DROP INDEX idx_answer_tasks_created_at");
    db.pragma("user_version = 60");

    runMigrations(db);

    expect(
      db
        .prepare<
          [],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_answer_tasks_created_at'")
        .get(),
    ).toEqual({ name: "idx_answer_tasks_created_at" });
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  test("is idempotent", () => {
    runSchemaSetup(db);
    const migration = MIGRATIONS.find((entry) => entry.version === 61);
    if (!migration) throw new Error("migration 61 not found");

    expect(() => {
      migration.up(db);
      migration.up(db);
    }).not.toThrow();
  });
});
