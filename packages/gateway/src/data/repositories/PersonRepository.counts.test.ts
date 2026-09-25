// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../schema.js";
import { runMigrations } from "../migrations.js";
import { getPersonInteractionCountsByChannel } from "./PersonRepository.js";

type Db = Database.Database;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: Db;

beforeEach(() => {
  db = new Database(":memory:");
  runSchemaSetup(db);
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

const NOW = "2026-01-01T00:00:00Z";

/** Insert a person row with sensible defaults. */
function insertPerson(id: string, opts: { mergedInto?: string } = {}): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, merged_into, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `Name ${id}`, opts.mergedInto ?? null, "test", 0, NOW, NOW, NOW, NOW);
}

/** Insert a document row carrying `documentType` in its metadata blob. */
function insertDocumentTyped(id: string, documentType: string): void {
  const metadata = JSON.stringify({ documentType });
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "prov", "src", id, "", "", `h-${id}`, metadata, NOW, NOW, NOW, NOW);
}

/** Link a person to a document. */
function linkDocPerson(documentId: string, personId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, ?)`,
  ).run(documentId, personId, "participant", "src");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getPersonInteractionCountsByChannel merge-class rollup", () => {
  test("counts roll up across a multi-level merge chain A→B→C", () => {
    // A merges into B, B merges into C; querying canonical C must reach A.
    insertPerson("person-c");
    insertPerson("person-b", { mergedInto: "person-c" });
    insertPerson("person-a", { mergedInto: "person-b" });

    insertDocumentTyped("doc-a", "email");
    insertDocumentTyped("doc-b", "email");
    insertDocumentTyped("doc-c", "email");
    linkDocPerson("doc-a", "person-a");
    linkDocPerson("doc-b", "person-b");
    linkDocPerson("doc-c", "person-c");

    expect(getPersonInteractionCountsByChannel(db, "person-c")).toEqual({ email: 3 });
  });

  test("single-hop rollup attributes a loser's doc to the canonical", () => {
    insertPerson("canon");
    insertPerson("loser", { mergedInto: "canon" });

    insertDocumentTyped("doc-canon", "email");
    insertDocumentTyped("doc-loser", "email");
    linkDocPerson("doc-canon", "canon");
    linkDocPerson("doc-loser", "loser");

    expect(getPersonInteractionCountsByChannel(db, "canon")).toEqual({ email: 2 });
  });

  test("channels split across email / chat / meeting", () => {
    insertPerson("p1");

    insertDocumentTyped("e1", "email");
    insertDocumentTyped("e2", "email");
    insertDocumentTyped("c1", "conversation");
    insertDocumentTyped("m1", "event");
    for (const id of ["e1", "e2", "c1", "m1"]) linkDocPerson(id, "p1");

    expect(getPersonInteractionCountsByChannel(db, "p1")).toEqual({
      email: 2,
      chat: 1,
      meeting: 1,
    });
  });

  test("an unmerged person returns only its own docs", () => {
    insertPerson("p1");
    insertPerson("p2");

    insertDocumentTyped("d1", "email");
    insertDocumentTyped("d2", "email");
    linkDocPerson("d1", "p1");
    linkDocPerson("d2", "p2");

    expect(getPersonInteractionCountsByChannel(db, "p1")).toEqual({ email: 1 });
  });

  test("a doc linked to both canonical and loser is DISTINCT-collapsed to 1", () => {
    insertPerson("canon");
    insertPerson("loser", { mergedInto: "canon" });

    insertDocumentTyped("shared", "email");
    linkDocPerson("shared", "canon");
    linkDocPerson("shared", "loser");

    expect(getPersonInteractionCountsByChannel(db, "canon")).toEqual({ email: 1 });
  });
});
