// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect } from "vitest";
import { likeSearchDocuments } from "../../search/like-search.js";
import { createKnowledgeTables, saveKnowledgeNode, purgeKnowledgeBySource } from "./storage.js";
import { directKnowledgeGate } from "./writer.js";
import { listKnowledgeProjectionCleanup } from "./mirror-storage.js";
import { buildKnowledgeDocumentInput, createKnowledgeMirror } from "./mirror.js";
import { renderKnowledgeRootContext } from "./root-context.js";
import { isKnowledgeDocumentReadable } from "./retrieval-fence.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,external_id TEXT,title TEXT,content TEXT,content_hash TEXT,metadata TEXT,source_created_at TEXT)",
  );
  db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)").run(
    "evidence",
    "notes",
    "note",
    "Workshop",
    "Workshop Friday.",
    "v1",
    "{}",
    "2025-01-01",
  );
  createKnowledgeTables(db);
});
afterEach(() => db.close());
function saveRoot() {
  return saveKnowledgeNode(
    db,
    {
      id: "root",
      kind: "root",
      title: "Current orientation",
      markdown: '<claim id="date" refs="source:evidence">Workshop Friday.</claim>',
      expectedRevision: 0,
      inputVersions: { "source:evidence": "v1" },
    },
    100,
  ).node;
}
it("projects stripped synthesis into the normal index document contract with canonical revision metadata", () => {
  const node = saveRoot();
  const projection = buildKnowledgeDocumentInput(node);
  expect(projection.content).toContain("Derived synthesis: root; revision 1; current");
  expect(projection.content).not.toContain("<claim");
  expect(projection.metadata.extra).toMatchObject({
    knowledgeNodeId: "root",
    knowledgeRevision: 1,
  });
  expect(buildKnowledgeDocumentInput(node).contentHash).toBe(projection.contentHash);
});
it("injects compact root context with truthful uncertainty and never exposes a privacy-fenced root", () => {
  expect(renderKnowledgeRootContext(db)).toBe("");
  saveRoot();
  const context = renderKnowledgeRootContext(db);
  expect(context).toContain("untrusted reference context");
  expect(context).toContain("0/1 tagged claims have recorded verification");
  expect(context).not.toContain("<claim");
  expect(renderKnowledgeRootContext(db, 4)).not.toContain("Workshop");
  purgeKnowledgeBySource(db, "evidence", 110);
  expect(renderKnowledgeRootContext(db)).toBe("");
});
it("fences index and corpus copies by their current canonical revision and privacy ancestry", () => {
  const node = saveRoot();
  const projection = buildKnowledgeDocumentInput(node);
  db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)").run(
    "mirror",
    projection.sourceId,
    projection.externalId,
    projection.title,
    projection.content,
    projection.contentHash,
    JSON.stringify(projection.metadata),
    "2025-01-02",
  );
  expect(isKnowledgeDocumentReadable(db, "mirror")).toBe(true);
  expect(
    likeSearchDocuments(db, { query: "Workshop", limit: 10, hiddenSourceIds: [] }).map(
      (row) => row.id,
    ),
  ).toContain("mirror");
  saveKnowledgeNode(
    db,
    {
      id: node.id,
      kind: node.kind,
      title: node.title,
      markdown: node.markdown,
      expectedRevision: 1,
      inputVersions: { "source:evidence": "v1" },
      metadata: { importance: 0.9 },
    },
    110,
  );
  expect(isKnowledgeDocumentReadable(db, "mirror")).toBe(false);
  expect(
    likeSearchDocuments(db, { query: "Workshop", limit: 10, hiddenSourceIds: [] }).map(
      (row) => row.id,
    ),
  ).not.toContain("mirror");
  expect(isKnowledgeDocumentReadable(db, "evidence")).toBe(true);
  purgeKnowledgeBySource(db, "evidence", 120);
  expect(isKnowledgeDocumentReadable(db, "mirror")).toBe(false);
});
it("retains original mirror document IDs until index deletion acknowledges cleanup across a retry", async () => {
  const projection = buildKnowledgeDocumentInput(saveRoot());
  db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)").run(
    "mirror",
    projection.sourceId,
    projection.externalId,
    projection.title,
    projection.content,
    projection.contentHash,
    JSON.stringify(projection.metadata),
    "2025-01-01",
  );
  purgeKnowledgeBySource(db, "evidence", 110);
  expect(listKnowledgeProjectionCleanup(db)).toEqual([{ documentId: "mirror", nodeId: "root" }]);
  const gate = directKnowledgeGate(db);
  const cleanupTimes: number[] = [];
  const writeGate = {
    ...gate,
    "knowledge.queueProjectionCleanup": async (ids: readonly string[], now: number) => {
      cleanupTimes.push(now);
      return gate["knowledge.queueProjectionCleanup"](ids, now);
    },
    upsertDocuments: async () => {
      throw new Error("Unexpected projection write");
    },
    deleteDocuments: async (_provider: string, source: string, ids: readonly string[]) => {
      const removed: string[] = [];
      for (const id of ids) {
        const row = db
          .prepare<
            [string, string],
            { id: string }
          >("SELECT id FROM documents WHERE source_id=? AND external_id=?")
          .get(source, id);
        if (row) {
          removed.push(row.id);
          db.prepare("DELETE FROM documents WHERE id=?").run(row.id);
        }
      }
      return removed;
    },
  };
  const first = createKnowledgeMirror({
    clock: () => 125,
    db,
    writeGate,
    deleteIndexChunks: async () => {
      throw new Error("Index temporarily unavailable");
    },
  });
  await expect(first.remove(["root"])).rejects.toThrow("Index temporarily unavailable");
  expect(cleanupTimes).toEqual([125]);
  expect(db.prepare("SELECT 1 FROM documents WHERE id='mirror'").get()).toBeUndefined();
  expect(listKnowledgeProjectionCleanup(db)[0]?.documentId).toBe("mirror");
  const deleted: string[] = [];
  const restarted = createKnowledgeMirror({
    clock: () => 125,
    db,
    writeGate,
    deleteIndexChunks: async (ids) => {
      deleted.push(...ids);
    },
  });
  expect(await restarted.drainCleanup()).toBe(false);
  expect(deleted).toEqual(["mirror"]);
  expect(listKnowledgeProjectionCleanup(db)).toEqual([]);
});

it("preserves unknown ordinary stale-hit fallback but refuses authoritative removal", () => {
  expect(isKnowledgeDocumentReadable(db, "missing", "notes")).toBe(true);
  expect(isKnowledgeDocumentReadable(db, "missing", "brain-knowledge")).toBe(false);
  purgeKnowledgeBySource(db, "missing", 1);
  expect(isKnowledgeDocumentReadable(db, "missing", "notes")).toBe(false);
  db.exec(
    "CREATE TABLE removed_sources(id TEXT PRIMARY KEY); INSERT INTO removed_sources VALUES('notes')",
  );
  expect(isKnowledgeDocumentReadable(db, "other-missing", "notes")).toBe(false);
  expect(isKnowledgeDocumentReadable(db, "evidence", "notes")).toBe(false);
});
