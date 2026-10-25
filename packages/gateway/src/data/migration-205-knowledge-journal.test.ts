// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { compactKnowledgeJournal } from "./migration-205-knowledge-journal.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  // The journal as migration 193 created it: no index on entity_id.
  db.exec(`CREATE TABLE knowledge_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
    revision TEXT NOT NULL, at INTEGER NOT NULL)`);
  const put = db.prepare(
    "INSERT INTO knowledge_changes(kind,entity_id,revision,at) VALUES('source_changed',?,?,1)",
  );
  for (const [entity, revision] of [
    ["doc_a", "v1"],
    ["doc_b", "v1"],
    ["doc_a", "v2:knowledge:1"],
    ["doc_a", "v3:knowledge:2"],
  ])
    put.run(entity, revision);
});
afterEach(() => db.close());

it("keeps each source's newest journal entry and indexes the journal by source", () => {
  db.transaction(() => compactKnowledgeJournal(db))();
  expect(
    db.prepare("SELECT seq, entity_id, revision FROM knowledge_changes ORDER BY seq").all(),
  ).toEqual([
    { seq: 2, entity_id: "doc_b", revision: "v1" },
    { seq: 4, entity_id: "doc_a", revision: "v3:knowledge:2" },
  ]);
  expect(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='knowledge_changes'")
      .all(),
  ).toEqual([{ name: "knowledge_changes_entity" }]);
});

it("is idempotent", () => {
  compactKnowledgeJournal(db);
  compactKnowledgeJournal(db);
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_changes").get()).toEqual({ n: 2 });
});
