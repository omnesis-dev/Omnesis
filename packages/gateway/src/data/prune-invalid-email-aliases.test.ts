// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 28: prune email aliases whose domain ends in a non-existent TLD —
 * parser artifacts. Seeds well-formed addresses (kept) alongside glued-suffix
 * corruptions (removed), asserts only the corrupt ones go, then re-runs for
 * idempotency.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "./schema.js";
import { pruneInvalidEmailAliases } from "./prune-invalid-email-aliases.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
});

afterEach(() => {
  db.close();
});

function person(id: string, name: string): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, 'test', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name);
}

function alias(personId: string, aliasType: string, value: string): void {
  db.prepare(
    `INSERT INTO person_aliases (id, person_id, alias, alias_type, created_at)
     VALUES (?, ?, ?, ?, '2026-01-01')`,
  ).run(randomUUID(), personId, value, aliasType);
}

describe("pruneInvalidEmailAliases", () => {
  test("removes only the invalid-TLD email aliases", () => {
    const p = randomUUID();
    person(p, "Maya Reeves");
    alias(p, "email", "maya.reeves@example.com"); // valid → kept
    alias(p, "email", "maya@northstar.example"); // reserved TLD → kept
    alias(p, "name", "Maya Quinn"); // a name alias — not an email, never touched
    alias(p, "email", "23mayareeves@gmail.comreeves.maya"); // glued artifact → removed
    alias(p, "email", "contact@studio.invalidsuffix"); // non-existent TLD → removed

    const removed = pruneInvalidEmailAliases(db);
    expect(removed).toBe(2);

    const remaining = db
      .prepare<[], { alias: string }>("SELECT alias FROM person_aliases ORDER BY alias")
      .all()
      .map((r) => r.alias);
    expect(remaining).toEqual([
      "Maya Quinn", // capital-M name sorts before the lowercase email locals
      "maya.reeves@example.com",
      "maya@northstar.example",
    ]);
  });

  test("is idempotent — a second run removes nothing", () => {
    const p = randomUUID();
    person(p, "Jamie Lopez");
    alias(p, "email", "jamie@example.org");
    alias(p, "email", "jamie@example.org.bogustld");

    expect(pruneInvalidEmailAliases(db)).toBe(1);
    expect(pruneInvalidEmailAliases(db)).toBe(0);
  });
});
