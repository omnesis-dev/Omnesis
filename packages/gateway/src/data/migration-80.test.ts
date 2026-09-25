// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 80 adds `source_document_profiles`, the durable store of what each
 * source type's documents can be asked about.
 *
 * The ordering hazard is the same one every additive migration faces here:
 * `runSchemaSetup` runs the current DDL on every boot BEFORE migrations, so an
 * upgrading install reaches this migration with the table already created. The
 * migration must therefore be a no-op on an existing table and must never
 * discard rows — this suite drives the real boot order rather than calling
 * `up()` in isolation, and checks that a profile written on the upgraded
 * install round-trips through the repository.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { runSchemaSetup } from "./schema.js";
import { MIGRATIONS, runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import {
  getSourceDocumentProfile,
  listSourceDocumentProfiles,
  upsertSourceDocumentProfiles,
} from "./repositories/SourceDocumentProfileRepository.js";
import type { SourceDocumentProfileEntry } from "./repositories/SourceDocumentProfileRepository.js";
import type { Db } from "./types.js";

let db: Db;

const mailbox: SourceDocumentProfileEntry = {
  sourceType: "mailbox",
  profile: {
    documentTypes: ["email"],
    personRoles: ["sender", "recipient"],
    metadataFields: [
      {
        path: "tags",
        type: "string-array",
        description: "Labels the mailbox applies to a message.",
        canonicalValues: ["receipts", "travel"],
        valueAliases: { receipts: ["receipt"] },
      },
    ],
  },
};

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});
afterEach(() => db.close());

function tableExists(d: Db, table: string): boolean {
  return (
    d
      .prepare<
        [string],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table) !== undefined
  );
}

/**
 * Recreate a genuine pre-80 DB: head-shape `runSchemaSetup` creates the table,
 * so drop it again, seed an unrelated row that the upgrade must not disturb,
 * and pin the version back.
 */
function seedPre80(): void {
  runSchemaSetup(db);
  db.exec("DROP TABLE source_document_profiles");
  db.prepare(
    `INSERT INTO sync_state (source_id, cursor, last_synced_at)
     VALUES ('mailbox:owner@example.com', '{}', '2026-01-01T00:00:00.000Z')`,
  ).run();
  db.pragma("user_version = 79");
}

describe("migration 80 — durable source document profiles", () => {
  test("the migration slot exists and the head advanced to it", () => {
    expect(MIGRATIONS.find((m) => m.version === 80)).toBeDefined();
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(80);
  });

  test("upgrading a pre-80 DB yields a working store, with prior rows untouched", () => {
    seedPre80();
    expect(tableExists(db, "source_document_profiles")).toBe(false);

    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });

    expect(tableExists(db, "source_document_profiles")).toBe(true);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);

    // The data assertion: a profile published against the upgraded install
    // round-trips whole, so the compiler can read the declaration it needs.
    upsertSourceDocumentProfiles(db, [mailbox], 1000);
    expect(getSourceDocumentProfile(db, "mailbox")).toEqual(mailbox.profile);

    const syncRow = db.prepare<[], { source_id: string }>("SELECT source_id FROM sync_state").get();
    expect(syncRow?.source_id).toBe("mailbox:owner@example.com");
  });

  test("the boot order does not discard rows written by the previous boot", () => {
    // The real second-boot sequence: the DDL runs again over a populated
    // table, then migrations replay. A published profile must survive both.
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    upsertSourceDocumentProfiles(db, [mailbox], 1000);

    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });

    expect(listSourceDocumentProfiles(db)).toEqual([mailbox]);
  });

  test("replaying the migration over a populated table is a no-op", () => {
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    upsertSourceDocumentProfiles(db, [mailbox], 1000);

    const migration = MIGRATIONS.find((m) => m.version === 80);
    expect(migration).toBeDefined();
    expect(() => migration!.up(db)).not.toThrow();
    expect(getSourceDocumentProfile(db, "mailbox")).toEqual(mailbox.profile);
  });

  test("a fresh install lands on the same table shape as an upgraded one", () => {
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    const fresh = db
      .prepare<[], { name: string }>(
        "SELECT name FROM pragma_table_info('source_document_profiles')",
      )
      .all()
      .map((r) => r.name);
    expect(fresh).toEqual(["source_type", "profile_json", "published_at"]);

    const upgraded = new Database(":memory:") as unknown as Db;
    try {
      runSchemaSetup(upgraded);
      upgraded.exec("DROP TABLE source_document_profiles");
      upgraded.pragma("user_version = 79");
      runSchemaSetup(upgraded);
      runMigrations(upgraded, { log: createLogger("test") });
      expect(
        upgraded
          .prepare<[], { name: string }>(
            "SELECT name FROM pragma_table_info('source_document_profiles')",
          )
          .all()
          .map((r) => r.name),
      ).toEqual(fresh);
    } finally {
      upgraded.close();
    }
  });
});
