// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeGraph, readKnowledgeArcs } from "./engine-graph.js";
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

describe("bulk arc reads", () => {
  function fixture() {
    // Raw rows for each arc kind; the projection triggers are covered above.
    db.pragma("foreign_keys=OFF");
    const dependency = db.prepare(
      "INSERT INTO knowledge_dependencies VALUES(?,?,?,?,?,?,'\"v1\"')",
    );
    dependency.run("page-a", "c1", "source:doc-1", "doc-1", "source", "support");
    dependency.run("page-b", "c1", "source:doc-1", "doc-1", "source", "support");
    dependency.run("page-c", "c1", "source:doc-1", "doc-1", "source", "context");
    dependency.run("page-d", "c1", "node:page-a", "page-a", "node", "support");
    for (const node of ["page-e", "page-f", "page-g", "page-h"])
      dependency.run(node, "c1", "node:hub", "hub", "node", "support");
    db.prepare("INSERT INTO knowledge_operational_arcs VALUES(?,?)").run("page-a", "task-a");
    const doc = db.prepare("INSERT INTO documents VALUES(?,?,?)");
    doc.run("doc-1", "h1", "Fictional maintenance log");
    doc.run("doc-2", "h2", "Fictional travel notes");
    doc.run("doc-3", "h3", "Fictional recipe");
    db.prepare(
      "INSERT INTO knowledge_source_revisions(document_id,content_hash,updated_at,generation) VALUES('doc-3','h3',1,2)",
    ).run();
    const target = db.prepare("INSERT INTO knowledge_discovery_targets VALUES(?,?,?,1)");
    target.run("doc-1", "h1", "page-z");
    target.run("doc-1", "h0", "page-stale");
    target.run("doc-2", "h2", "page-a");
    target.run("doc-3", "h3", "page-old-generation");
    target.run("doc-3", "h3:knowledge:2", "page-current-generation");
  }
  const inputs = [
    "source:doc-1",
    "source:doc-2",
    "source:doc-3",
    "source:doc-missing",
    "page-a",
    "hub",
    "page-z",
  ];
  function single(graph: KnowledgeGraph, input: string): string[] | null {
    try {
      return graph.arcs(input).map((arc) => arc.dependent);
    } catch (error) {
      expect(error).toMatchObject({ limit: "region" });
      return null;
    }
  }

  it("reads many inputs exactly as it reads each one", () => {
    fixture();
    const graph = new KnowledgeGraph(db, () => 3);
    const read = readKnowledgeArcs(db, [...inputs, "page-a"], 3);
    expect(read.map(([input]) => input).sort()).toEqual([...inputs].sort());
    for (const [input, dependents] of read) expect(dependents, input).toEqual(single(graph, input));
    expect(new Map(read).get("source:doc-1")).toEqual(["page-a", "page-b", "page-z"]);
    expect(new Map(read).get("hub")).toBeNull();
    expect(new Map(read).get("source:doc-3")).toEqual(["page-current-generation"]);
    expect(new Map(read).get("source:doc-2")).toEqual(["page-a"]);
    expect(new Map(read).get("page-a")).toEqual(["page-d", "task-a"]);
    expect(readKnowledgeArcs(db, [], 3)).toEqual([]);
  });

  it("plans from a read, reads other inputs on first use, and throws past the bound", () => {
    fixture();
    const graph = new KnowledgeGraph(db, () => 3);
    const adjacency = graph.adjacency(readKnowledgeArcs(db, ["source:doc-1"], 3));
    db.prepare("DELETE FROM knowledge_dependencies WHERE target_id='doc-1'").run();
    // The read is kept for the pass; an unread input is read when first asked.
    expect(adjacency("source:doc-1")).toEqual(["page-a", "page-b", "page-z"]);
    expect(adjacency("page-a")).toEqual(["page-d", "task-a"]);
    expect(() => adjacency("hub")).toThrow("region");
    expect(() => graph.adjacency()("hub")).toThrow("region");
    expect(() => graph.adjacency(readKnowledgeArcs(db, ["hub"], 3))("hub")).toThrow("region");
    expect(graph.adjacency()("page-nothing")).toEqual([]);
  });

  it("reaches a document only through a discovery target that names it", () => {
    fixture();
    const graph = new KnowledgeGraph(db, () => 8);
    const prepared: string[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      prepared.push(sql);
      return prepare(sql);
    }) as typeof db.prepare);
    graph.page("source:doc-1", "", 9);
    readKnowledgeArcs(db, ["source:doc-1"], 8);
    vi.restoreAllMocks();
    expect(prepared).toHaveLength(2);
    for (const sql of prepared) {
      const plan = db
        .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
        .all(...(sql.includes("json_each") ? ["[]", 9] : ["", "", "", "", "", "", 9]))
        .map((row) => row.detail);
      const targets = plan.findIndex((detail) => /SEARCH t /.test(detail));
      const documents = plan.findIndex((detail) => /SEARCH d /.test(detail));
      expect(targets, plan.join("\n")).toBeGreaterThanOrEqual(0);
      expect(documents, plan.join("\n")).toBeGreaterThan(targets);
    }
  });
});
