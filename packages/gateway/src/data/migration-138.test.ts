// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 138 introduces the pending-absence ledger and the audit trail for
 * the deletions it eventually authorises. Two properties matter beyond "the
 * tables exist": the migrated shape must equal the head shape a fresh install
 * gets from `runSchemaSetup`, or an upgraded install would behave differently
 * from a new one; and the foreign key must actually cascade, because that is
 * the only thing preventing an absence from outliving its document.
 */

import SqliteDatabase from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

const migration = MIGRATIONS.find((candidate) => candidate.version === 138)!;

/** The tables an install of any age must end up with. */
const TABLES = [
  "document_absences",
  "document_absence_observations",
  "document_absence_scopes",
  "snapshot_absence_cascade_outbox",
  "snapshot_absence_deletions",
];

/**
 * Objects migration 138 owns; later migrations may add indexes or columns to
 * these tables, which is why the shape below is compared column by column and
 * the upgraded database replays every later step before the comparison.
 */
const MIGRATION_OBJECTS = new Set([
  ...TABLES,
  "idx_document_absence_observations_created",
  "idx_document_absences_scope",
  "idx_snapshot_absence_deletions_at",
]);

function definitionsOf(db: Db): Record<string, string> {
  const rows = db
    .prepare<
      [],
      { name: string; type: string; sql: string }
    >("SELECT name, type, sql FROM sqlite_master WHERE tbl_name IN ('document_absences', 'document_absence_observations', 'document_absence_scopes', 'snapshot_absence_cascade_outbox', 'snapshot_absence_deletions') AND sql IS NOT NULL ORDER BY name")
    .all();
  // A column added by `ALTER TABLE` is spelled differently in `sqlite_master`
  // from the same column in a fresh CREATE, so tables compare by their column
  // catalogue; indexes still compare by their SQL.
  const columns = (table: string) =>
    db
      .prepare<
        [string],
        { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
      >('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)')
      .all(table)
      .map(
        (c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value ?? "∅"} pk=${c.pk}`,
      )
      .join("; ");
  return Object.fromEntries(
    rows
      .filter((row) => MIGRATION_OBJECTS.has(row.name))
      .map((row) => [
        row.name,
        row.type === "table" ? columns(row.name) : row.sql.replace(/\s+/g, " ").trim(),
      ]),
  );
}

/** The steps that shape these tables, in order: 138 creates them, 151 widens one. */
const SHAPING_MIGRATIONS = [138, 151];

function upgradeFrom138(db: Db): void {
  for (const version of SHAPING_MIGRATIONS) {
    MIGRATIONS.find((candidate) => candidate.version === version)!.up(db);
  }
}

describe("migration 138", () => {
  test("an install that predates the absence ledger gains it, idempotently", () => {
    const db = new SqliteDatabase(":memory:") as unknown as Db;
    // The one table the ledger references. An install at v136 has it.
    db.exec(
      "CREATE TABLE documents (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL, stream_id TEXT NOT NULL DEFAULT '')",
    );

    migration.up(db);
    for (const table of TABLES) {
      expect(
        db
          .prepare<
            [string],
            { name: string }
          >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table)?.name,
      ).toBe(table);
    }

    // Replaying is a no-op — a partially-migrated database must reach the same
    // place as one that ran the step once.
    const before = definitionsOf(db);
    migration.up(db);
    expect(definitionsOf(db)).toEqual(before);
  });

  test("the migrated shape equals the shape a fresh install is created with", () => {
    const migrated = new SqliteDatabase(":memory:") as unknown as Db;
    migrated.exec(
      "CREATE TABLE documents (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, source_id TEXT NOT NULL, external_id TEXT NOT NULL, stream_id TEXT NOT NULL DEFAULT '')",
    );
    upgradeFrom138(migrated);

    const fresh = new SqliteDatabase(":memory:") as unknown as Db;
    runSchemaSetup(fresh);

    expect(definitionsOf(migrated)).toEqual(definitionsOf(fresh));
  });

  test("an absence cannot outlive the document it was recorded against", () => {
    const db = new SqliteDatabase(":memory:") as unknown as Db;
    runSchemaSetup(db);
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc-1', 'apple', 'apple-notes', 'note-1', 'A note', 'body', 'h1',
               '2026-01-05T09:00:00.000Z', '2026-01-05T09:00:00.000Z',
               '2026-01-05T09:00:00.000Z', '2026-01-05T09:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO document_absences
         (document_id, provider_id, source_id, stream_id, external_id,
          first_absent_at, last_absent_at, observations)
       VALUES ('doc-1', 'apple', 'apple-notes', '', 'note-1', 1, 1, 1)`,
    ).run();

    db.prepare("DELETE FROM documents WHERE id = 'doc-1'").run();

    expect(
      db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_absences").get()!.n,
    ).toBe(0);
  });

  test("the scope-generation index is what the sweep's due query seeks", () => {
    const db = new SqliteDatabase(":memory:") as unknown as Db;
    runSchemaSetup(db);
    const plan = db
      .prepare<[], { detail: string }>(
        `EXPLAIN QUERY PLAN
         SELECT a.document_id
           FROM document_absence_scopes AS s
           CROSS JOIN document_absences AS a INDEXED BY idx_document_absences_scope
          WHERE a.provider_id = s.provider_id AND a.source_id = s.source_id
            AND a.stream_id = s.stream_id AND a.generation = s.generation
            AND a.first_absent_at <= 0 AND a.observations >= 0
          ORDER BY a.first_absent_at LIMIT 1`,
      )
      .all()
      .map((r) => r.detail)
      .join(" ");
    expect(plan).toContain("idx_document_absences_scope");
    expect(plan).not.toContain("SCAN a");
  });
});
