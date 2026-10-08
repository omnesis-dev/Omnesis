// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { createKnowledgeDecisionTable, recordKnowledgeDecision } from "./decision-storage.js";
import { readPendingKnowledgeWork } from "./pending-work-query.js";

let db: Database.Database;
const group = { reason: "discovery" as const, tier: "routine" as const };
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,title TEXT,metadata TEXT,content_hash TEXT); CREATE TABLE removed_sources(id TEXT PRIMARY KEY)",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  createKnowledgeDecisionTable(db);
});
afterEach(() => db.close());
function work(id: string, readiness: string | null = null, due = 1, kind = "source") {
  if (kind === "source") {
    db.prepare("INSERT INTO documents VALUES(?,'fictional','Archive cabinet guide','{}','v1')").run(
      id,
    );
    db.prepare("INSERT INTO knowledge_source_revisions VALUES(?,'v1',0,1)").run(id);
  } else
    db.prepare(
      "INSERT INTO knowledge_nodes(id,kind,title,markdown,plain_text,revision,meaning_revision,meaning_hash,validity,metadata_json,fields_json,created_at,updated_at) VALUES(?,'wiki','Cabinet organization','text','text',1,1,'hash','current','{}','{}',1,1)",
    ).run(id);
  db.prepare(
    "INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,generation,tier,due_at,created_at,updated_at,status,last_error) VALUES(?,?,?,'discovery','v2',1,2,'routine',?,1,1,'pending',?)",
  ).run(`work-${id}`, id, kind, due, readiness);
}
function decision(id: string, workId: string | null) {
  recordKnowledgeDecision(
    db,
    {
      id,
      purpose: "urgency",
      inputFingerprint: "observed",
      score: 0.5,
      modelId: "scripted",
      latencyMs: 1,
      inputTokens: 1,
      rubricVersion: "fixture",
      nodeId: "source:match",
    },
    1,
  );
  db.prepare("UPDATE knowledge_decisions SET work_id=?,source_revision='v1' WHERE id=?").run(
    workId,
    id,
  );
}
it("filters the exact pending group and current privacy before limit, including content and derivation waits", () => {
  work("hidden", null, 0);
  db.prepare(
    "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES('purge','source','hidden','v1',1)",
  ).run();
  work("wrong-reason", null, 0);
  db.prepare("UPDATE knowledge_work SET reason='change' WHERE subject_id='wrong-reason'").run();
  work("wrong-tier", null, 0);
  db.prepare("UPDATE knowledge_work SET tier='soon' WHERE subject_id='wrong-tier'").run();
  work("batched", null, 0);
  db.prepare("UPDATE knowledge_work SET status='batched' WHERE subject_id='batched'").run();
  work("match", null, 1);
  work("content", "pending_content", 0);
  work("derivation", "derivation", 0);
  expect(readPendingKnowledgeWork(db, { ...group, limit: 1 }).items.map((row) => row.id)).toEqual([
    "work-match",
  ]);
  expect(
    readPendingKnowledgeWork(db, { ...group, readiness: "pending_content" }).items[0]?.id,
  ).toBe("work-content");
  expect(readPendingKnowledgeWork(db, { ...group, readiness: "derivation" }).items[0]?.id).toBe(
    "work-derivation",
  );
});
it("exposes recorded work association without pretending same-node checks caused the current generation", () => {
  work("match");
  decision("linked", "work-match");
  decision("same-node-only", null);
  const row = readPendingKnowledgeWork(db, group).items[0]!;
  expect(row).toMatchObject({
    id: "work-match",
    nodeId: "source:match",
    inputRevision: "v2",
    generation: 2,
    subjectRef: { title: "Archive cabinet guide" },
  });
  expect(row.decisions.items.map((item) => item.id)).toEqual(["linked"]);
  expect(row.decisions.items[0]?.sourceRevision).toBe("v1");
  work("ungated");
  expect(
    readPendingKnowledgeWork(db, group).items.find((item) => item.id === "work-ungated")?.decisions
      .items,
  ).toEqual([]);
});
it("pages deterministic live groups and binds cursors to readiness and tier", () => {
  work("a");
  work("b");
  work("c");
  const first = readPendingKnowledgeWork(db, { ...group, limit: 1 });
  expect(first.items.map((item) => item.id)).toEqual(["work-a"]);
  expect(first.hasMore).toBe(true);
  const second = readPendingKnowledgeWork(db, { ...group, limit: 1, cursor: first.nextCursor! });
  expect(second.items.map((item) => item.id)).toEqual(["work-b"]);
  expect(() =>
    readPendingKnowledgeWork(db, { ...group, readiness: "derivation", cursor: first.nextCursor! }),
  ).toThrow("cursor");
  expect(() =>
    readPendingKnowledgeWork(db, { ...group, tier: "soon", cursor: first.nextCursor! }),
  ).toThrow("cursor");
  expect(() => readPendingKnowledgeWork(db, { ...group, readiness: "x".repeat(1025) })).toThrow(
    "filter",
  );
});
it("hides node privacy ancestors, direct tombstones and removed-source subjects before pagination", () => {
  work("hidden-page", null, 0, "node");
  db.prepare("INSERT INTO knowledge_node_tombstones VALUES('hidden-page',1)").run();
  work("removed-source", null, 0);
  db.prepare("UPDATE documents SET source_id='removed' WHERE id='removed-source'").run();
  db.prepare("INSERT INTO removed_sources VALUES('removed')").run();
  work("visible-page", null, 1, "node");
  expect(readPendingKnowledgeWork(db, { ...group, limit: 1 }).items.map((item) => item.id)).toEqual(
    ["work-visible-page"],
  );
});
it("bounds work pages and associated decision history explicitly", () => {
  work("match");
  for (let i = 0; i < 22; i++) decision(`linked-${i}`, "work-match");
  const row = readPendingKnowledgeWork(db, group).items[0]!;
  expect(row.decisions.items).toHaveLength(20);
  expect(row.decisions.truncated).toBe(true);
  for (let i = 0; i < 52; i++) work(`more-${i}`, null, i + 2);
  const page = readPendingKnowledgeWork(db, { ...group, limit: 100 });
  expect(page.items).toHaveLength(50);
  expect(page.hasMore).toBe(true);
});
