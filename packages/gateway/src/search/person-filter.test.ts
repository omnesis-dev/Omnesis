// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Unit tests for `resolvePersonDocIds` — the role→docId SQL that the
 * person-filter pushdown (`from:`/`to:`/`with:`) depends on. The positive
 * path (a person resolves to a non-empty, role-scoped, DISTINCT docId set)
 * is the load-bearing half of person filters and was previously exercised
 * only via the pipeline's "zero docs" emptiness assertion.
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
type Db = Database.Database;
import { resolvePersonDocIds } from "./person-filter.js";
import { parseQuery } from "./query-parser.js";

let db: Db;
let dbPath: string;

/**
 * Minimal gateway DB with just `document_people` — the only table
 * `resolvePersonDocIds` reads. Same shape used by the pipeline tests.
 */
beforeEach(() => {
  dbPath = `/tmp/omnesis-person-filter-${randomUUID()}.db`;
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE document_people (
      document_id TEXT NOT NULL,
      person_id TEXT NOT NULL,
      role TEXT NOT NULL,
      source_id TEXT,
      PRIMARY KEY (document_id, person_id, role)
    );
    CREATE TABLE people (
      id TEXT PRIMARY KEY,
      merged_into TEXT
    );
  `);
});

afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(dbPath + suffix, { force: true });
  }
});

function link(documentId: string, personId: string, role: string): void {
  // Every linked person exists in `people`; absent an explicit merge it is
  // its own canonical (merged_into NULL), matching the production invariant
  // that document_people.person_id always references a people row.
  db.prepare("INSERT OR IGNORE INTO people (id, merged_into) VALUES (?, NULL)").run(personId);
  db.prepare("INSERT INTO document_people (document_id, person_id, role) VALUES (?, ?, ?)").run(
    documentId,
    personId,
    role,
  );
}

/** Mark `loserId` as logically merged into `canonicalId`. */
function merge(loserId: string, canonicalId: string): void {
  db.prepare("INSERT OR IGNORE INTO people (id, merged_into) VALUES (?, NULL)").run(canonicalId);
  db.prepare("INSERT OR REPLACE INTO people (id, merged_into) VALUES (?, ?)").run(
    loserId,
    canonicalId,
  );
}

describe("resolvePersonDocIds", () => {
  test("from:-style roles return sender/author/owner docs; to:-style return a different set", () => {
    // Maya is the sender on doc-1 and author on doc-2; Jamie is the
    // recipient on doc-1 and doc-3.
    const maya = "person-maya";
    const jamie = "person-jamie";
    link("doc-1", maya, "sender");
    link("doc-2", maya, "author");
    link("doc-1", jamie, "recipient");
    link("doc-3", jamie, "recipient");

    const fromDocs = resolvePersonDocIds(db, [maya], ["sender", "author", "owner"]).sort();
    expect(fromDocs).toEqual(["doc-1", "doc-2"]);

    const toDocs = resolvePersonDocIds(db, [jamie], ["recipient"]).sort();
    expect(toDocs).toEqual(["doc-1", "doc-3"]);
  });

  test("to: resolves recipient and attendee docs, never participant docs", () => {
    const jamie = "person-jamie";
    // Jamie is addressed on doc-mail, invited to doc-event, and merely
    // present in the doc-chat conversation.
    link("doc-mail", jamie, "recipient");
    link("doc-event", jamie, "attendee");
    link("doc-chat", jamie, "participant");

    const [toFilter] = parseQuery("to:jamie").filters.personFilters!;
    const toDocs = resolvePersonDocIds(db, [jamie], toFilter.roles).sort();
    expect(toDocs).toEqual(["doc-event", "doc-mail"]);
  });

  test("role filter excludes docs where the person appears in a non-matching role", () => {
    const maya = "person-maya";
    // Maya is a sender on doc-1 but only a recipient on doc-2.
    link("doc-1", maya, "sender");
    link("doc-2", maya, "recipient");

    // A `from:` query (sender/author/owner) must NOT surface doc-2.
    const fromDocs = resolvePersonDocIds(db, [maya], ["sender", "author", "owner"]);
    expect(fromDocs).toEqual(["doc-1"]);
  });

  test("DISTINCT collapses a doc the person touches in multiple matching roles", () => {
    const maya = "person-maya";
    // Maya is BOTH sender and author on the same doc.
    link("doc-1", maya, "sender");
    link("doc-1", maya, "author");

    const docs = resolvePersonDocIds(db, [maya], ["sender", "author", "owner"]);
    expect(docs).toEqual(["doc-1"]);
  });

  test("multiple person ids are OR'd within one clause", () => {
    const maya = "person-maya";
    const jamie = "person-jamie";
    link("doc-1", maya, "sender");
    link("doc-2", jamie, "sender");

    const docs = resolvePersonDocIds(db, [maya, jamie], ["sender"]).sort();
    expect(docs).toEqual(["doc-1", "doc-2"]);
  });

  test("no roles → any role matches (with: semantics)", () => {
    const maya = "person-maya";
    link("doc-1", maya, "sender");
    link("doc-2", maya, "recipient");
    link("doc-3", maya, "mentioned");

    const docs = resolvePersonDocIds(db, [maya]).sort();
    expect(docs).toEqual(["doc-1", "doc-2", "doc-3"]);
  });

  test("empty personIds short-circuits to []", () => {
    expect(resolvePersonDocIds(db, [], ["sender"])).toEqual([]);
  });
});

describe("resolvePersonDocIds merge-equivalence expansion", () => {
  // Merges are logical: document_people rows keep pointing at the original
  // (now merged-away) sub-entity, while callers resolve the query alias to
  // the canonical id. The resolver must bridge that gap.
  const canonical = "person-maya";
  const loserChat = "person-m"; // chat-only sub-entity, merged into Maya
  const loserEmail = "person-maya-reeves"; // email entity, also merged in

  test("a canonical surfaces documents attached to a merged-away sub-entity", () => {
    // The chat thread is linked to the loser; one calendar doc to the
    // canonical directly. Querying the canonical must return BOTH.
    link("doc-chat", loserChat, "participant");
    link("doc-calendar", canonical, "participant");
    merge(loserChat, canonical);

    const docs = resolvePersonDocIds(db, [canonical]).sort();
    expect(docs).toEqual(["doc-calendar", "doc-chat"]);
  });

  test("documents from multiple merged losers all roll up onto the canonical", () => {
    link("doc-chat", loserChat, "participant");
    link("doc-email", loserEmail, "sender");
    merge(loserChat, canonical);
    merge(loserEmail, canonical);

    const docs = resolvePersonDocIds(db, [canonical]).sort();
    expect(docs).toEqual(["doc-chat", "doc-email"]);
  });

  test("multi-level merge chains roll up onto the root canonical", () => {
    // A→B→C: docs attached to the deepest member (A) must still surface
    // when querying the root canonical (C). A one-hop expansion would drop
    // doc-a; the recursive walk keeps it.
    link("doc-a", "person-a", "participant");
    link("doc-b", "person-b", "participant");
    link("doc-c", "person-c", "participant");
    merge("person-b", "person-c"); // B → C
    merge("person-a", "person-b"); // A → B (chain not yet flattened)

    const docs = resolvePersonDocIds(db, ["person-c"]).sort();
    expect(docs).toEqual(["doc-a", "doc-b", "doc-c"]);
  });

  test("role filter still applies across the merged class", () => {
    // The loser is a sender on doc-1 but only a recipient on doc-2; a
    // `from:` query against the canonical must surface doc-1 only.
    link("doc-1", loserChat, "sender");
    link("doc-2", loserChat, "recipient");
    merge(loserChat, canonical);

    const fromDocs = resolvePersonDocIds(db, [canonical], ["sender", "author", "owner"]);
    expect(fromDocs).toEqual(["doc-1"]);
  });

  test("a document the canonical and a loser both touch is collapsed by DISTINCT", () => {
    link("doc-shared", canonical, "participant");
    link("doc-shared", loserChat, "participant");
    merge(loserChat, canonical);

    expect(resolvePersonDocIds(db, [canonical])).toEqual(["doc-shared"]);
  });

  test("an unmerged person still resolves to exactly its own documents", () => {
    // Regression guard: the expansion must not pull in unrelated docs when
    // there are no losers pointing at the queried id.
    const other = "person-jamie";
    link("doc-1", canonical, "sender");
    link("doc-2", other, "sender");

    expect(resolvePersonDocIds(db, [canonical], ["sender"])).toEqual(["doc-1"]);
  });
});
