// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 216 — the source version of a published profile, and a source's
 * resync cost.
 *
 * Both columns land on tables that already hold rows. A stored profile takes
 * version 0, which is what a publication without a version counts as, so the
 * next publish from any collector replaces it exactly as before.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { addSourceVersionDeclarations } from "./migration-216-source-version-declarations.js";
import {
  getStoredSourceDocumentProfile,
  upsertSourceDocumentProfiles,
} from "./repositories/SourceDocumentProfileRepository.js";
import {
  getSourceResyncCost,
  setSourceFamilyMeta,
} from "./repositories/SourceFamilyMetaRepository.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE source_document_profiles (
      source_type TEXT PRIMARY KEY,
      profile_json TEXT NOT NULL,
      published_at INTEGER NOT NULL
    );
    CREATE TABLE source_family_meta (
      source_type TEXT PRIMARY KEY,
      icon TEXT,
      label TEXT,
      bg_color TEXT,
      accent_color TEXT,
      updated_at TEXT NOT NULL
    );
    INSERT INTO source_document_profiles VALUES ('mailbox', '{"documentTypes":["email"]}', 1000);
    INSERT INTO source_family_meta (source_type, label, updated_at)
      VALUES ('mailbox', 'Mailbox', '2026-01-01T00:00:00.000Z');
  `);
});

afterEach(() => db.close());

test("is the migration at its slot", () => {
  expect(MIGRATIONS.find((m) => m.version === 216)?.up).toBe(addSourceVersionDeclarations);
});

test("existing rows keep their data and gain empty declarations, and it runs twice", () => {
  addSourceVersionDeclarations(db);
  addSourceVersionDeclarations(db);

  expect(db.prepare("SELECT * FROM source_document_profiles").all()).toEqual([
    {
      source_type: "mailbox",
      profile_json: '{"documentTypes":["email"]}',
      published_at: 1000,
      output_revision: 0,
    },
  ]);
  expect(
    db.prepare("SELECT source_type, label, resync_cost FROM source_family_meta").all(),
  ).toEqual([{ source_type: "mailbox", label: "Mailbox", resync_cost: null }]);
});

test("a profile stored before the migration is replaced by a collector that sends no version", () => {
  addSourceVersionDeclarations(db);

  upsertSourceDocumentProfiles(
    db,
    [{ sourceType: "mailbox", profile: { documentTypes: ["email", "attachment"] } }],
    2000,
  );

  expect(getStoredSourceDocumentProfile(db, "mailbox")).toEqual({
    profile: { documentTypes: ["email", "attachment"] },
    outputRevision: 0,
  });
});

test("a family that predates the migration takes a resync cost without losing its label", () => {
  addSourceVersionDeclarations(db);
  expect(getSourceResyncCost(db, "mailbox")).toBeNull();

  setSourceFamilyMeta(db, "mailbox", { resyncCost: "This reads every message again." });

  expect(getSourceResyncCost(db, "mailbox")).toBe("This reads every message again.");
  expect(db.prepare("SELECT label FROM source_family_meta").get()).toEqual({ label: "Mailbox" });
});
