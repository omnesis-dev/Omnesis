// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createKnowledgeDecisionDebugTables,
  knowledgeDecisionErasureGeneration,
  recordKnowledgeDecisionPayload,
  readKnowledgeDecisionDebug,
  associateKnowledgeUrgency,
} from "./decision-debug.js";
import type { KnowledgeWork } from "./work.js";
let db: Database.Database;
const policy = {
  immediateThreshold: 0.8,
  soonThreshold: 0.4,
  soonDelayMs: 100,
  routineDelayMs: 600,
};
const request = {
  model: "scripted",
  state: {
    documentId: "doc",
    title: "Workshop access",
    content: "Your reserved entry slot starts tomorrow.",
  },
  questions: {
    urgency: {
      type: "score",
      instructions: "Judge the consequence of waiting.",
      criteria: ["Routine", "Soon", "Immediate"],
    },
  },
};
const payload = {
  requestJson: JSON.stringify(request),
  responseJson: JSON.stringify({
    model: "scripted",
    answers: { urgency: { type: "score", score: 1.4 } },
  }),
};
function capture() {
  return {
    sourceId: "doc",
    inputRevision: "v1",
    policy,
    erasureGeneration: knowledgeDecisionErasureGeneration(db),
  };
}
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,content_hash TEXT);
  CREATE TABLE removed_sources(id TEXT PRIMARY KEY);
  CREATE TABLE knowledge_source_revisions(document_id TEXT PRIMARY KEY,deleted INTEGER);
  CREATE TABLE knowledge_cascade_jobs(kind TEXT,target_kind TEXT,target_id TEXT);
  CREATE TABLE knowledge_decisions(id TEXT PRIMARY KEY,purpose TEXT,node_id TEXT,source_revision TEXT,score REAL,scheduling_json TEXT,work_id TEXT);
  INSERT INTO documents VALUES('doc','fixture','v1');
  INSERT INTO knowledge_source_revisions VALUES('doc',0);`);
  createKnowledgeDecisionDebugTables(db);
});
afterEach(() => db.close());
it("retains exact captured request and result after ordinary source changes without reconstructing historical input", () => {
  recordKnowledgeDecisionPayload(db, "decision", capture(), payload);
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='doc'").run();
  expect(readKnowledgeDecisionDebug(db, "decision")).toEqual({
    availability: "available",
    error: null,
    request,
    response: JSON.parse(payload.responseJson),
  });
  expect(readKnowledgeDecisionDebug(db, "historical")).toEqual({
    availability: "unavailable",
    error: null,
    request: null,
    response: null,
  });
});
it.each(["delete", "tombstone", "purge", "source-removal"] as const)(
  "physically erases captured bodies on %s and refuses late insertion",
  (kind) => {
    const before = capture();
    recordKnowledgeDecisionPayload(db, "decision", before, payload);
    if (kind === "delete") db.prepare("DELETE FROM documents WHERE id='doc'").run();
    if (kind === "tombstone")
      db.prepare("UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='doc'").run();
    if (kind === "purge")
      db.prepare("INSERT INTO knowledge_cascade_jobs VALUES('purge','source','doc')").run();
    if (kind === "source-removal")
      db.prepare("INSERT INTO removed_sources VALUES('fixture')").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_decision_inputs").get()).toEqual({
      count: 0,
    });
    recordKnowledgeDecisionPayload(db, "late", before, payload);
    expect(readKnowledgeDecisionDebug(db, "late").availability).toBe("unavailable");
  },
);
it("does not resurrect pre-deletion input after same-ID same-version recreation", () => {
  const before = capture();
  db.prepare("DELETE FROM documents WHERE id='doc'").run();
  db.prepare("INSERT INTO documents VALUES('doc','fixture','v1')").run();
  recordKnowledgeDecisionPayload(db, "late", before, payload);
  expect(readKnowledgeDecisionDebug(db, "late").availability).toBe("unavailable");
  recordKnowledgeDecisionPayload(db, "fresh", capture(), payload);
  expect(readKnowledgeDecisionDebug(db, "fresh").availability).toBe("available");
});
it("reports oversized exact input as unavailable rather than exposing a silently partial snapshot", () => {
  recordKnowledgeDecisionPayload(db, "large", capture(), {
    ...payload,
    requestJson: "x".repeat(131073),
  });
  expect(readKnowledgeDecisionDebug(db, "large")).toEqual({
    availability: "oversized",
    error: null,
    request: null,
    response: null,
  });
});
it("associates the actual coalesced work and distinguishes proposed policy schedule from retained earlier deadline", () => {
  db.prepare(
    "INSERT INTO knowledge_decisions VALUES('decision','urgency','source:doc','v1',NULL,?,NULL)",
  ).run(JSON.stringify({ policy, status: "unscheduled" }));
  const input = {
    id: "requested",
    subjectId: "doc",
    subjectKind: "source" as const,
    reason: "change" as const,
    inputRevision: "v1",
    tier: "soon" as const,
    dueAt: 110,
    urgencyDecision: { id: "decision", anchorAt: 10 },
  };
  const actual: KnowledgeWork = {
    ...input,
    id: "existing",
    tier: "immediate",
    dueAt: 5,
    inputChangedAt: 1,
    generation: 1,
    createdAt: 1,
    updatedAt: 10,
    status: "pending",
    batchId: null,
    attempts: 0,
  };
  associateKnowledgeUrgency(db, input, actual);
  const row = db
    .prepare<
      [],
      { work_id: string; scheduling_json: string }
    >("SELECT work_id,scheduling_json FROM knowledge_decisions")
    .get()!;
  expect(row.work_id).toBe("existing");
  expect(JSON.parse(row.scheduling_json)).toMatchObject({
    policy,
    status: "scheduled",
    anchorAt: 10,
    proposed: { tier: "soon", dueAt: 110 },
    applied: { tier: "immediate", dueAt: 5 },
    fallbackSoon: true,
    explicitOverride: false,
  });
  expect(() => associateKnowledgeUrgency(db, { ...input, inputRevision: "other" }, actual)).toThrow(
    "does not match",
  );
});
