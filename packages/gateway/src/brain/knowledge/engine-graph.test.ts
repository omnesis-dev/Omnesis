// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { KnowledgeGraph } from "./engine-graph.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { saveKnowledgeNode } from "./storage.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY, content_hash TEXT,content TEXT)");
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());

function loop(id: string, blockers: string[]) {
  saveKnowledgeNode(
    db,
    { id, kind: "wiki", title: id, markdown: "", inputVersions: {}, expectedRevision: 0 },
    1,
  );
  // Fixture canonical-state mutation exercises the SQL projection's actual triggers.
  db.prepare("UPDATE knowledge_nodes SET kind='loop',fields_json=? WHERE id=?").run(
    JSON.stringify({ blockedBy: blockers }),
    id,
  );
}

it("projects canonical blocker changes, pages high fanout, and cleans deletion", () => {
  loop("task-a", ["blocker"]);
  loop("task-b", ["blocker"]);
  loop("task-c", ["blocker"]);
  const graph = new KnowledgeGraph(db, () => 2);
  expect(() => graph.arcs("blocker")).toThrow("region");
  expect(graph.page("blocker", "", 2).map((x) => x.dependent)).toEqual(["task-a", "task-b"]);
  expect(graph.page("blocker", "task-b", 2).map((x) => x.dependent)).toEqual(["task-c"]);
  db.prepare("UPDATE knowledge_nodes SET fields_json=? WHERE id='task-b'").run(
    JSON.stringify({ blockedBy: ["other"] }),
  );
  expect(graph.arcs("blocker").map((x) => x.dependent)).toEqual(["task-a", "task-c"]);
  expect(graph.arcs("other").map((x) => x.dependent)).toEqual(["task-b"]);
  db.prepare("DELETE FROM knowledge_nodes WHERE id='task-a'").run();
  expect(graph.arcs("blocker").map((x) => x.dependent)).toEqual(["task-c"]);
});
