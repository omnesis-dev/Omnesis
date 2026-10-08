// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createKnowledgeTables,
  getKnowledgeDependencies,
  getKnowledgeNode,
  saveKnowledgeNode,
} from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { knowledgeOrganizationVersion } from "./organization-context.js";
import { listKnowledgeLinks, setKnowledgeLink, type KnowledgeLinkKind } from "./links.js";
import type { KnowledgeNodeKind } from "./types.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,content TEXT,content_hash TEXT)",
  );
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());
function node(id: string, kind: KnowledgeNodeKind = "wiki") {
  return saveKnowledgeNode(
    db,
    {
      id,
      kind,
      title: id,
      markdown: "",
      inputVersions: {},
      expectedRevision: 0,
      ...(kind === "loop" ? { canonicalFields: { state: "open" } } : {}),
    },
    1,
  ).node;
}
function link(fromId: string, toId: string, kind: KnowledgeLinkKind) {
  setKnowledgeLink(db, { fromId, toId, kind, fromRevision: 1, toRevision: 1 });
}
describe("synthesis organization links", () => {
  it("organizes separate outcomes under context without creating evidence or closing the parent", () => {
    node("project");
    node("parent", "loop");
    node("child", "loop");
    link("child", "parent", "part_of");
    link("parent", "project", "belongs_to_project");
    link("child", "project", "belongs_to_project");
    expect(listKnowledgeLinks(db, "project")).toHaveLength(2);
    expect(getKnowledgeDependencies(db, "parent")).toEqual([]);
    expect(getKnowledgeDependencies(db, "child")).toEqual([]);
    expect(getKnowledgeNode(db, "parent")?.canonicalFields.state).toBe("open");
  });
  it("supports page hierarchies while rejecting mixed task/page decomposition and cycles", () => {
    node("project");
    node("chapter");
    node("task", "loop");
    link("chapter", "project", "part_of");
    expect(() => link("project", "chapter", "part_of")).toThrow(/cycle/);
    expect(() => link("task", "project", "part_of")).toThrow(/decomposition/);
    expect(() => link("project", "task", "belongs_to_project")).toThrow(/wiki/);
    expect(() => link("chapter", "chapter", "related_to")).toThrow(/itself/);
  });
  it("allows reciprocal navigation but keeps supersession acyclic", () => {
    node("first");
    node("second");
    link("first", "second", "related_to");
    link("second", "first", "related_to");
    link("first", "second", "supersedes");
    expect(() => link("second", "first", "supersedes")).toThrow(/cycle/);
    expect(getKnowledgeDependencies(db, "first")).toEqual([]);
  });
  it("fences stale endpoint revisions and permits explicit removal", () => {
    node("first");
    node("second");
    link("first", "second", "related_to");
    saveKnowledgeNode(
      db,
      {
        id: "first",
        kind: "wiki",
        title: "Revised context",
        markdown: "",
        expectedRevision: 1,
        inputVersions: {},
      },
      2,
    );
    expect(() => link("first", "second", "related_to")).toThrow(/changed/);
    setKnowledgeLink(db, {
      fromId: "first",
      toId: "second",
      kind: "related_to",
      fromRevision: 2,
      toRevision: 1,
      remove: true,
    });
    expect(listKnowledgeLinks(db, "second")).toEqual([]);
  });
});

it("durably coalesces parent review only for actual hierarchical mutations, including removal", () => {
  node("parent");
  node("child-a");
  node("child-b");
  const initial = knowledgeOrganizationVersion(db, "parent");
  const childInitial = knowledgeOrganizationVersion(db, "child-a");
  link("child-a", "parent", "part_of");
  const linked = knowledgeOrganizationVersion(db, "parent");
  expect(linked).not.toBe(initial);
  expect(knowledgeOrganizationVersion(db, "child-a")).not.toBe(childInitial);
  expect(
    db.prepare("SELECT reason,status FROM knowledge_work WHERE subject_id='child-a'").get(),
  ).toEqual({ reason: "review", status: "pending" });
  const work = db
    .prepare("SELECT id,reason,status FROM knowledge_work WHERE subject_id='parent'")
    .get();
  expect(work).toMatchObject({ reason: "review", status: "pending" });
  link("child-a", "parent", "part_of");
  expect(
    db.prepare("SELECT id,reason,status FROM knowledge_work WHERE subject_id='parent'").all(),
  ).toEqual([work]);
  link("child-b", "parent", "belongs_to_project");
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM knowledge_work WHERE subject_id='parent'").get(),
  ).toEqual({ n: 1 });
  db.prepare("UPDATE knowledge_work SET status='batched' WHERE subject_id='parent'").run();
  setKnowledgeLink(db, {
    fromId: "child-a",
    toId: "parent",
    kind: "part_of",
    fromRevision: 1,
    toRevision: 1,
    remove: true,
  });
  expect(
    db.prepare("SELECT status FROM knowledge_work WHERE subject_id='parent' ORDER BY status").all(),
  ).toEqual([{ status: "batched" }, { status: "pending" }]);
  const before = db.prepare("SELECT COUNT(*) AS n FROM knowledge_work").get();
  setKnowledgeLink(db, {
    fromId: "child-a",
    toId: "parent",
    kind: "part_of",
    fromRevision: 1,
    toRevision: 1,
    remove: true,
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_work").get()).toEqual(before);
  expect(getKnowledgeNode(db, "parent")?.revision).toBe(1);
  expect(getKnowledgeDependencies(db, "parent")).toEqual([]);
});

it("changes organization context when a child becomes privacy-hidden or is deleted", () => {
  node("parent");
  node("child");
  link("child", "parent", "part_of");
  const before = knowledgeOrganizationVersion(db, "parent");
  db.prepare("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('child',1)").run();
  expect(knowledgeOrganizationVersion(db, "parent")).not.toBe(before);
  expect(listKnowledgeLinks(db, "parent")).toEqual([]);
  db.prepare("DELETE FROM knowledge_nodes WHERE id='child'").run();
  expect(knowledgeOrganizationVersion(db, "parent")).not.toBe(before);
});
