// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { assertKnowledgeSaveIdentity, assertKnowledgeSavePreflight } from "./save-preflight.js";
import { createKnowledgeTables, saveKnowledgeNode } from "./storage.js";
import type { SaveKnowledgeNodeInput } from "./types.js";

let db: Database.Database;
const input: SaveKnowledgeNodeInput = {
  id: "guide",
  kind: "wiki",
  title: "Garden reference",
  markdown: '<claim id="soil" refs="source:manual">Use loose soil.</claim>',
  expectedRevision: 0,
  inputVersions: { "source:manual": "v1" },
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
  db.prepare("INSERT INTO documents VALUES('manual','Use loose soil.','v1')").run();
  createKnowledgeTables(db);
  saveKnowledgeNode(db, input, 1);
});
afterEach(() => db.close());

it.each(["missing", "erasing", "tombstoned", "withdrawn"])(
  "does not distinguish %s targets through identity admission",
  (state) => {
    if (state === "missing") db.prepare("DELETE FROM knowledge_nodes WHERE id='guide'").run();
    else if (state === "erasing")
      db.prepare(
        "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','node','guide','deleted',2)",
      ).run();
    else if (state === "tombstoned")
      db.prepare("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('guide',2)").run();
    else
      db.prepare("UPDATE knowledge_nodes SET fields_json=? WHERE id='guide'").run(
        JSON.stringify({ withdrawn: true }),
      );
    for (const expectedRevision of [1, 99]) {
      expect(() => assertKnowledgeSaveIdentity(db, { ...input, expectedRevision })).toThrowError(
        expect.objectContaining({
          code: "reference_invalid",
          message: "Synthesis page is unavailable",
        }),
      );
    }
  },
);
it("keeps a page whose cited source was deleted open for repair", () => {
  db.prepare(
    "INSERT INTO knowledge_source_revisions(document_id,content_hash,deleted,updated_at) VALUES('manual','v1',1,2)",
  ).run();
  expect(() => assertKnowledgeSaveIdentity(db, { ...input, expectedRevision: 1 })).not.toThrow();
});
it("preserves the revision fence for visible nodes and permits a new identity", () => {
  expect(() => assertKnowledgeSaveIdentity(db, { ...input, expectedRevision: 99 })).toThrowError(
    expect.objectContaining({ code: "revision_conflict" }),
  );
  expect(assertKnowledgeSaveIdentity(db, { ...input, id: "new-guide" })).toBeUndefined();
});

it.each(["wiki", "root"] as const)(
  "refuses malformed %s headings at admission and writer without changing the page",
  (kind) => {
    const proposed = {
      ...input,
      id: "new-page",
      kind,
      markdown: '<claim id="soil" refs="source:manual"><## Soil\n\nUse loose soil.</claim>',
    };
    for (const save of [
      () => assertKnowledgeSavePreflight(db, proposed),
      () => saveKnowledgeNode(db, proposed, 2),
    ]) {
      expect(save).toThrow(/malformed markdown heading/i);
      expect(db.prepare("SELECT 1 FROM knowledge_nodes WHERE id='new-page'").get()).toBeUndefined();
    }
    expect(db.prepare("SELECT revision FROM knowledge_nodes WHERE id='guide'").get()).toEqual({
      revision: 1,
    });
  },
);
