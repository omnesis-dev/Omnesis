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
    "INSERT INTO knowledge_changes(kind,entity_id,revision,at) VALUES(?,?,?,1)",
  );
  for (const [kind, entity, revision] of [
    ["source_changed", "doc_a", "v1"],
    ["source_changed", "doc_b", "v1"],
    ["source_evidence_changed", "doc_a", "v2:knowledge:1"],
    ["source_changed", "doc_a", "v3:knowledge:2"],
    // A page's change and then its invalidation are separate obligations.
    ["node_changed", "page_a", "1"],
    ["node_invalidated", "page_a", "1"],
  ])
    put.run(kind, entity, revision);
});
afterEach(() => db.close());

it("keeps each source's newest journal entry, every node entry, and indexes the journal", () => {
  db.transaction(() => compactKnowledgeJournal(db))();
  expect(
    db.prepare("SELECT seq, kind, entity_id, revision FROM knowledge_changes ORDER BY seq").all(),
  ).toEqual([
    { seq: 2, kind: "source_changed", entity_id: "doc_b", revision: "v1" },
    { seq: 4, kind: "source_changed", entity_id: "doc_a", revision: "v3:knowledge:2" },
    { seq: 5, kind: "node_changed", entity_id: "page_a", revision: "1" },
    { seq: 6, kind: "node_invalidated", entity_id: "page_a", revision: "1" },
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
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_changes").get()).toEqual({ n: 4 });
});
