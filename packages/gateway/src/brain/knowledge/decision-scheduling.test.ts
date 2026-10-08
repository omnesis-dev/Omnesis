// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { createBriefsStorageTables } from "../storage/schema.js";
import { pruneActivityRetentionBatch } from "../../activity-retention/store.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { createKnowledgeDecisionTable, recordKnowledgeDecision } from "./decision-storage.js";
import { knowledgeDecisionErasureGeneration } from "./decision-debug.js";
import { judgeKnowledge } from "./decision.js";
import { enqueueKnowledgeWork } from "./work.js";
import {
  listKnowledgeDecisionsForBatch,
  listKnowledgeDecisionAudit,
  readKnowledgeDecisionAudit,
} from "./decision-query.js";
let db: Database.Database;
const policy = {
  immediateThreshold: 0.8,
  soonThreshold: 0.4,
  soonDelayMs: 100,
  routineDelayMs: 600,
};
const state = {
  documentId: "source-a",
  title: "Workshop plan",
  content: "The reserved session starts tomorrow.",
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT,content_hash TEXT,content TEXT,title TEXT)",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  createKnowledgeDecisionTable(db);
  db.prepare(
    "INSERT INTO documents VALUES('source-a','fixture','v1',?,'Workshop planning note')",
  ).run(state.content);
});
afterEach(() => db.close());
async function judge(id: string, available = true) {
  const decision: DecisionCapability = {
    modelId: "scripted",
    dispose() {},
    async decide() {
      return {
        model: "scripted",
        answers: { urgency: { type: "score", score: 1 } },
        inputTokens: 17,
      };
    },
  };
  return judgeKnowledge(
    {
      getDecision: () => (available ? decision : null),
      log: createLogger("test:urgency-audit"),
      recordSpend: async () => {},
      record: async (entry) => recordKnowledgeDecision(db, { ...entry, id: entry.id! }, 10),
    },
    "urgency",
    state,
    {
      id,
      nodeId: "source:source-a",
      urgencyCapture: {
        sourceId: "source-a",
        inputRevision: "v1",
        policy,
        erasureGeneration: knowledgeDecisionErasureGeneration(db),
      },
    },
  );
}
const work = {
  id: "work-requested",
  subjectId: "source-a",
  subjectKind: "source" as const,
  reason: "change" as const,
  inputRevision: "v1",
  tier: "soon" as const,
  dueAt: 110,
};
it("captures actual judgment, atomically links coalesced work and keeps heavy snapshots off list and batch responses", async () => {
  expect(await judge("decision-a")).toBe(0.5);
  enqueueKnowledgeWork(db, { ...work, id: "work-existing", tier: "immediate", dueAt: 5 }, 1);
  const actual = enqueueKnowledgeWork(
    db,
    { ...work, urgencyDecision: { id: "decision-a", anchorAt: 10 } },
    10,
  );
  expect(actual.id).toBe("work-existing");
  db.prepare("UPDATE knowledge_work SET batch_id='batch-a' WHERE id=?").run(actual.id);
  const batch = listKnowledgeDecisionsForBatch(db, "batch-a");
  expect(batch.items).toHaveLength(1);
  expect(batch.items[0]).toMatchObject({
    workId: "work-existing",
    scheduling: {
      status: "scheduled",
      proposed: { tier: "soon", dueAt: 110 },
      applied: { tier: "immediate", dueAt: 5 },
    },
  });
  expect(JSON.stringify(batch)).not.toContain(state.content);
  expect(JSON.stringify(listKnowledgeDecisionAudit(db, 10))).not.toContain(state.content);
  expect(readKnowledgeDecisionAudit(db, "decision-a").input).toMatchObject({
    availability: "available",
    request: { model: "scripted", state, questions: { urgency: { type: "score" } } },
    response: { answers: { urgency: { score: 1 } } },
  });
});
it("retains a truthful unscheduled judgment when enqueue loses its source revision race", async () => {
  await judge("decision-a");
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='source-a'").run();
  expect(() =>
    enqueueKnowledgeWork(db, { ...work, urgencyDecision: { id: "decision-a", anchorAt: 10 } }, 10),
  ).toThrow("obsolete");
  expect(readKnowledgeDecisionAudit(db, "decision-a")).toMatchObject({
    workId: null,
    scheduling: { status: "unscheduled" },
    input: { availability: "available" },
  });
});
it("records missing-backend fallbackSoon without pretending that a request or model answer exists", async () => {
  expect(await judge("decision-none", false)).toBeNull();
  enqueueKnowledgeWork(db, { ...work, urgencyDecision: { id: "decision-none", anchorAt: 10 } }, 10);
  expect(readKnowledgeDecisionAudit(db, "decision-none")).toMatchObject({
    score: null,
    modelId: "unavailable",
    scheduling: { fallbackSoon: true, applied: { tier: "soon", dueAt: 110 } },
    input: { availability: "unavailable", request: null, response: null },
  });
});
it("prunes sensitive snapshots with the existing bounded activity retention while keeping scheduling metadata", async () => {
  await judge("decision-a");
  await judge("decision-b");
  const first = pruneActivityRetentionBatch(db, "cognitionDecisions", 20, 1);
  expect(first).toMatchObject({ deleted: 1, hasMore: true });
  expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_decision_inputs").get()).toEqual({
    count: 1,
  });
  pruneActivityRetentionBatch(db, "cognitionDecisions", 20, 1);
  expect(readKnowledgeDecisionAudit(db, "decision-a").input.availability).toBe("unavailable");
  expect(listKnowledgeDecisionAudit(db, 10)).toHaveLength(2);
});
