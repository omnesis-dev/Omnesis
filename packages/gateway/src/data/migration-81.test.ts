// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 81 is a tombstone.
 *
 * Two independently-developed lines of work each created
 * `source_document_profiles`, and both reached the chain. Version 79 does the
 * work; 80 would repeat idempotent DDL while reading, to anyone scanning the
 * list, as a distinct schema change that never happened.
 *
 * The slot cannot simply be deleted. Migrations are append-only and replayed in
 * sequence, so removing one leaves a hole an install several versions behind
 * would fall through. What a tombstone owes its reader is therefore a proof
 * that it is inert: it must not disturb the state 79 established, and it must
 * not stop the chain from reaching the head this binary expects.
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { MIGRATIONS, runMigrations, LATEST_SCHEMA_VERSION } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import {
  getSourceDocumentProfile,
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

describe("migration 81 (tombstone)", () => {
  test("declares itself retired and leaves the store 79 built untouched", () => {
    const migration = MIGRATIONS.find((m) => m.version === 81);
    expect(migration).toBeDefined();
    expect(migration!.description).toMatch(/tombstone/i);

    runSchemaSetup(db);
    runMigrations(db);

    // The state the tombstone must not disturb.
    upsertSourceDocumentProfiles(db, [mailbox], 1000);
    expect(getSourceDocumentProfile(db, "mailbox")).toEqual(mailbox.profile);

    expect(() => migration!.up(db)).not.toThrow();
    expect(getSourceDocumentProfile(db, "mailbox")).toEqual(mailbox.profile);
  });

  test("keeps the chain contiguous across the retired slot", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toContain(79);
    expect(versions).toContain(80);
    expect(versions).toContain(81);

    // An install stopped just before the retired slot must still reach the head
    // rather than halting on it.
    runSchemaSetup(db);
    db.exec("PRAGMA user_version = 80");
    runMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });
});
