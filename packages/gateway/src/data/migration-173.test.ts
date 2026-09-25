// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 173 — an alias records every source that vouches for it.
 *
 * The property that has to hold on the day of the upgrade is that nothing
 * changes: every existing alias gets exactly one assertion, naming whichever
 * source the old column recorded, so the same removal deletes the same rows.
 * What changes is what happens to the *second* source to assert an identifier,
 * from the next sync onward — and that is tested where the writes happen.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations.js";
import { addPersonAliasAssertions } from "./migration-173-alias-assertions.js";

describe("an alias gains a record of who vouches for it", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omnesis-mig173-"));
    db = new Database(join(dir, "test.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function legacyAliases(): void {
    db.exec(`
      CREATE TABLE person_aliases (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        alias TEXT NOT NULL,
        alias_type TEXT NOT NULL,
        source_id TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  const assertions = () =>
    db
      .prepare("SELECT alias_id, source_id, first_seen, last_seen FROM person_alias_assertions")
      .all() as { alias_id: string; source_id: string; first_seen: string; last_seen: string }[];

  test("takes its place in the list, contiguously", () => {
    expect(MIGRATIONS.filter((m) => m.version === 173)).toHaveLength(1);
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(173);
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("gives every existing alias exactly one assertion, naming what the column said", () => {
    legacyAliases();
    db.prepare(
      "INSERT INTO person_aliases VALUES ('a1', 'p1', 'maya@example.org', 'email', 'gmail:me@example.org', '2026-01-01')",
    ).run();

    addPersonAliasAssertions(db);

    expect(assertions()).toEqual([
      {
        alias_id: "a1",
        source_id: "gmail:me@example.org",
        first_seen: "2026-01-01",
        last_seen: "2026-01-01",
      },
    ]);
  });

  test("carries a null source across as an assertion nothing will ever match", () => {
    // The removal delete never matched a null either, so an unmatchable
    // assertion is the same behaviour by a different route. Inventing a source
    // for it would make the row deletable by something that never asserted it.
    legacyAliases();
    db.prepare(
      "INSERT INTO person_aliases VALUES ('a2', 'p1', '+15550100123', 'phone', NULL, '2026-01-02')",
    ).run();

    addPersonAliasAssertions(db);

    expect(assertions()).toEqual([
      { alias_id: "a2", source_id: "", first_seen: "2026-01-02", last_seen: "2026-01-02" },
    ]);
  });

  test("carries the tags that are not source ids at all, unchanged", () => {
    // `config` and `device:<id>` are written by the self-identity paths. They
    // match no source, so no source removal withdraws them and the operator's
    // own identifiers survive every one.
    legacyAliases();
    db.prepare(
      "INSERT INTO person_aliases VALUES ('a3', 'p1', 'me@example.org', 'email', 'config', '2026-01-03')",
    ).run();

    addPersonAliasAssertions(db);
    expect(assertions().map((a) => a.source_id)).toEqual(["config"]);
  });

  test("runs twice without duplicating what it carried, or undoing what followed", () => {
    legacyAliases();
    db.prepare(
      "INSERT INTO person_aliases VALUES ('a4', 'p1', 'x@example.org', 'email', 's:1', '2026-01-04')",
    ).run();

    addPersonAliasAssertions(db);
    // A sync after the upgrade records that the source saw it again. A second
    // run of the backfill must leave that alone: replacing the row rather than
    // ignoring it would reset the assertion to the day of the migration and
    // lose everything the syncs since have said.
    db.prepare(
      "UPDATE person_alias_assertions SET last_seen = '2026-06-01' WHERE alias_id = 'a4'",
    ).run();

    addPersonAliasAssertions(db);

    expect(assertions()).toEqual([
      { alias_id: "a4", source_id: "s:1", first_seen: "2026-01-04", last_seen: "2026-06-01" },
    ]);
  });

  test("creates the table on an install that has no person graph yet", () => {
    addPersonAliasAssertions(db);
    expect(assertions()).toEqual([]);
  });
});
