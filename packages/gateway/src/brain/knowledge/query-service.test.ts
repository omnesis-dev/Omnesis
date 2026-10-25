// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { createKnowledgeTables, saveKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { KnowledgeQueryService } from "./query-service.js";

it("returns thirty history entries plus the predecessor needed for the oldest displayed diff", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
    createKnowledgeTables(db);
    createKnowledgeWorkTables(db);
    for (let revision = 0; revision < 35; revision++)
      saveKnowledgeNode(
        db,
        {
          id: "wiki_reference",
          kind: "wiki",
          title: "Workshop reference",
          expectedRevision: revision,
          inputVersions: {},
          markdown: `<claim id="intro" refs="">Draft ${revision + 1}.</claim>`,
        },
        revision + 1,
      );
    const query = new KnowledgeQueryService(db);
    const history = query.history("wiki_reference");
    expect(history).toHaveLength(31);
    expect(history[0]!.revision).toBe(35);
    expect(history[29]!.previousRevision).toBe(history[30]!.revision);
    expect(history[30]!.revision).toBe(5);
    expect(query.history("wiki_reference", 3).map((item) => item.revision)).toEqual([2, 1]);
    db.prepare(
      "INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('wiki_reference',40)",
    ).run();
    expect(() => query.history("wiki_reference")).toThrow("not found");
  } finally {
    db.close();
  }
});
