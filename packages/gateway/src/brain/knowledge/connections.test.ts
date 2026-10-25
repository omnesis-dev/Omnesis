// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createKnowledgeTables, saveKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { setKnowledgeLink } from "./links.js";
import { readKnowledgeConnections } from "./connections.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY, source_id TEXT, title TEXT, content TEXT, content_hash TEXT)",
  );
  db.prepare("INSERT INTO documents VALUES(?,?,?,?,?)").run(
    "schedule",
    "fixture",
    "Workshop schedule",
    "The workshop opens Friday.",
    "hash",
  );
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());
function page(id: string, ref?: string, version: string | number = "hash") {
  return saveKnowledgeNode(
    db,
    {
      id,
      kind: "wiki",
      title: `Page ${id}`,
      markdown: ref ? `<claim id="opening" refs="${ref}">The workshop opens Friday.</claim>` : "",
      expectedRevision: 0,
      inputVersions: ref ? { [ref]: version } : {},
    },
    1,
  ).node;
}
function related(fromId: string, toId: string) {
  setKnowledgeLink(
    db,
    { fromId, toId, kind: "related_to", fromRevision: 1, toRevision: 1 },
    undefined,
    1,
  );
}
it("shows both dependency directions and organizational links with distinct semantics", () => {
  page("project", "source:schedule");
  page("overview", "wiki:project#claim:opening", 1);
  page("context");
  related("context", "project");
  const edges = readKnowledgeConnections(db, "project").items;
  expect(edges).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        direction: "outgoing",
        dependency: true,
        relationship: "supports",
        node: { id: "source:schedule", kind: "source", title: "Workshop schedule" },
      }),
      expect.objectContaining({
        direction: "incoming",
        dependency: true,
        claimId: "opening",
        targetClaimId: "opening",
        node: expect.objectContaining({ id: "overview" }),
      }),
      expect.objectContaining({
        direction: "incoming",
        dependency: false,
        relationship: "related_to",
        node: expect.objectContaining({ id: "context" }),
      }),
    ]),
  );
});
it("paginates every direction without duplicate edges and binds cursors to their node", () => {
  page("project", "source:schedule");
  page("other");
  related("project", "other");
  related("other", "project");
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const result = readKnowledgeConnections(db, "project", { limit: 1, cursor });
    ids.push(...result.items.map((item) => item.id));
    cursor = result.nextCursor ?? undefined;
    if (cursor)
      expect(() => readKnowledgeConnections(db, "other", { cursor })).toThrow(
        "Invalid connections cursor",
      );
  } while (cursor);
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(3);
  expect(() => readKnowledgeConnections(db, "project", { cursor: "malformed" })).toThrow(
    "Invalid connections cursor",
  );
});
it("does not reveal an erased neighbor and preserves continuation through filtered rows", () => {
  page("project");
  page("hidden", "source:schedule");
  page("visible");
  related("project", "hidden");
  related("project", "visible");
  // The erasure fence lands before the bounded cascade removes the node.
  db.prepare(
    "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','node','hidden','deleted',2)",
  ).run();
  const first = readKnowledgeConnections(db, "project", { limit: 1 });
  expect(first.items).toEqual([]);
  expect(first.nextCursor).not.toBeNull();
  expect(
    readKnowledgeConnections(db, "project", { cursor: first.nextCursor! }).items[0]?.node.id,
  ).toBe("visible");
  expect(() => readKnowledgeConnections(db, "hidden")).toThrow("Knowledge node not found");
});
