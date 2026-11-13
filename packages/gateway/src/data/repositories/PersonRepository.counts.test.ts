// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runSchemaSetup } from "../schema.js";
import { runMigrations } from "../migrations.js";
import { DOCUMENTS_ID_TYPE_INDEX } from "../migration-216-documents-id-type-index.js";
import {
  PERSON_CHANNEL_COUNTS_SQL,
  getPersonInteractionCountsByChannel,
} from "./PersonRepository.js";

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
function insertDocumentTyped(id: string, documentType: string | undefined, content = ""): void {
  const metadata = JSON.stringify(documentType === undefined ? {} : { documentType });
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, "prov", "src", id, "", content, `h-${id}`, metadata, NOW, NOW, NOW, NOW);
}

/** Link a person to a document. */
function linkDocPerson(documentId: string, personId: string, role = "participant"): void {
  db.prepare(
    `INSERT OR IGNORE INTO document_people (document_id, person_id, role, source_id)
     VALUES (?, ?, ?, ?)`,
  ).run(documentId, personId, role, "src");
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

/**
 * The plain join, which reads each linked document's row for its type: the
 * reference the index read must agree with.
 */
const ROW_READ_REFERENCE_SQL = `WITH RECURSIVE merge_class(id) AS (
     SELECT id FROM people WHERE id = ?
     UNION
     SELECT p.id FROM people p JOIN merge_class mc ON p.merged_into = mc.id
   )
   SELECT json_extract(d.metadata, '$.documentType') AS document_type,
          COUNT(DISTINCT d.id) AS n
   FROM document_people dp
   JOIN documents d ON d.id = dp.document_id
   WHERE dp.person_id IN (SELECT id FROM merge_class)
   GROUP BY document_type`;

function rawCounts(
  sql: string,
  personId: string,
): Array<{ document_type: string | null; n: number }> {
  return db
    .prepare<[string], { document_type: string | null; n: number }>(sql)
    .all(personId)
    .sort((a, b) => String(a.document_type).localeCompare(String(b.document_type)));
}

describe("getPersonInteractionCountsByChannel reads types from the index", () => {
  test("returns the same per-type counts as reading every row", () => {
    // A merge chain, a doc shared across the class under two roles, documents
    // with no type and with a type outside the three channels, and documents
    // linked only to someone else.
    insertPerson("canon");
    insertPerson("mid", { mergedInto: "canon" });
    insertPerson("leaf", { mergedInto: "mid" });
    insertPerson("stranger");
    const types = ["email", "conversation", "event", "note", undefined];
    for (let i = 0; i < 40; i++) {
      insertDocumentTyped(`d${i}`, types[i % types.length], "x".repeat(i * 300));
      linkDocPerson(`d${i}`, ["canon", "mid", "leaf", "stranger"][i % 4]!);
    }
    linkDocPerson("d0", "mid", "sender");
    linkDocPerson("d0", "leaf", "recipient");
    linkDocPerson("d3", "canon", "sender");

    for (const person of ["canon", "mid", "leaf", "stranger", "nobody"]) {
      expect(rawCounts(PERSON_CHANNEL_COUNTS_SQL, person)).toEqual(
        rawCounts(ROW_READ_REFERENCE_SQL, person),
      );
    }
    expect(rawCounts(PERSON_CHANNEL_COUNTS_SQL, "canon").length).toBeGreaterThan(3);
  });

  test("a person with no documents has no channels", () => {
    insertPerson("p1");
    expect(getPersonInteractionCountsByChannel(db, "p1")).toEqual({});
    expect(getPersonInteractionCountsByChannel(db, "missing")).toEqual({});
  });

  test("reads each document's type from the covering index, never the row", () => {
    const plan = db
      .prepare<[string], { detail: string }>(`EXPLAIN QUERY PLAN ${PERSON_CHANNEL_COUNTS_SQL}`)
      .all("p1")
      .map((row) => row.detail);
    expect(plan).toContain(`SEARCH d USING COVERING INDEX ${DOCUMENTS_ID_TYPE_INDEX} (id=?)`);
    expect(plan.filter((detail) => /\b(SCAN|SEARCH) d\b/.test(detail))).toHaveLength(1);
    expect(plan).toContain("SEARCH dp USING INDEX idx_document_people_person_source (person_id=?)");
  });
});
