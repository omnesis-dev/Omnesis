// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  assertKnowledgeReconciliation,
  installKnowledgeReconciliationTriggers,
  type KnowledgeCollection,
} from "./reconciliation.js";

it.each<[KnowledgeCollection, string]>([
  ["wiki", 'knowledge_list({kind:"wiki"})'],
  ["loop", "open_loop_search"],
  ["brief", "brief_list"],
  ["doc_annotation", "annotation_search({docId:targetDocumentId})"],
  ["person_annotation", "annotation_search({personId:targetPersonId})"],
  ["temporal", "temporal_query"],
])("names the actual reconciliation read for stale %s receipts", (collection, tool) => {
  const db = new Database(":memory:");
  try {
    installKnowledgeReconciliationTriggers(db);
    db.prepare("UPDATE knowledge_reconciliation_revisions SET revision=1 WHERE collection=?").run(
      collection,
    );
    expect(() => assertKnowledgeReconciliation(db, { collection, revision: 0 })).toThrow(
      expect.objectContaining({
        code: "revision_conflict",
        message: expect.stringContaining(tool),
      }),
    );
    expect(() => assertKnowledgeReconciliation(db, { collection, revision: 1 })).not.toThrow();
  } finally {
    db.close();
  }
});
