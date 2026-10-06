// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createBrief } from "../storage/briefs.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { resolveBrainSettings } from "../config.js";
import { createKnowledgeTables, getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { convertKnowledgeOwner } from "./owner-adapters.js";
import { KnowledgeService } from "./service.js";
import { KnowledgeUpkeep } from "./engine-upkeep.js";
import { scheduleKnowledgeReview } from "./work-lifecycle.js";
import { directKnowledgeGate } from "./writer.js";
import { decideKnowledgeReview, knowledgeReviewSignals } from "./review-policy.js";
import { isHistoricalKnowledgeBrief } from "./owner-maintenance.js";

let db: Database.Database;
const now = Date.parse("2027-03-10T12:00:00Z");
const settings = resolveBrainSettings();
const cfg = settings.knowledge;
const log = createLogger("test:review-policy");
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
});
afterEach(() => db.close());
function page(id = "page", at = now) {
  return saveKnowledgeNode(
    db,
    {
      id,
      kind: "wiki",
      title: "Workshop plan",
      markdown: "Legacy context",
      expectedRevision: 0,
      inputVersions: {},
      metadata: { nextReviewAt: now - 1 },
    },
    at,
  ).node;
}
function upkeep(score: number | null, inspect?: (state: unknown) => void) {
  let id = 0;
  const decisions: DecisionCapability = {
    modelId: "scripted",
    dispose() {},
    async decide(request) {
      inspect?.(request.state);
      return { model: "scripted", answers: { review: { type: "score", score: score ?? NaN } } };
    },
  };
  const writeGate = directKnowledgeGate(db);
  const deps = { db, writeGate, clock: () => now, log, getSettings: () => settings };
  return new KnowledgeUpkeep(
    {
      ...deps,
      service: new KnowledgeService(deps),
      decisions: {
        getDecision: () => (score === null ? null : decisions),
        log,
        recordSpend: async () => {},
      },
    },
    () => `review-${++id}`,
  );
}
it("uses canonical loop importance/deadline despite unrelated wiki metadata and safeguards its checkpoint", async () => {
  createOpenLoop(
    db,
    {
      id: "loop",
      createdByRun: "run",
      title: "Confirm venue",
      state: "open",
      importance: 0.95,
      confidence: 0.8,
      deadline: { type: "by", date: new Date(now + 1000).toISOString() },
    },
    now,
  );
  convertKnowledgeOwner(db, "loop", "loop", now);
  db.prepare("UPDATE knowledge_nodes SET metadata_json=? WHERE id='loop'").run(
    JSON.stringify({ importance: 0.01, nextReviewAt: now + cfg.maxReviewIntervalMs * 10 }),
  );
  let packet: unknown;
  await upkeep(0, (state) => {
    packet = state;
  }).reviews();
  expect(getKnowledgeNode(db, "loop")?.metadata).toMatchObject({
    reviewDecision: "now",
    reviewReason: "fairness_or_checkpoint",
    reviewDecidedAt: now,
    nextReviewAt: now,
  });
  expect(packet).toMatchObject({
    importance: 0.95,
    deadlineAt: now + 1000,
    canonicalState: "open",
  });
  expect(db.prepare("SELECT reason FROM knowledge_work WHERE subject_id='loop'").get()).toEqual({
    reason: "review",
  });
});
it("nominates important canonical loops earlier without inventing a wiki checkpoint", async () => {
  const created = now - cfg.soonDelayMs - 1;
  createOpenLoop(
    db,
    {
      id: "important",
      createdByRun: "run",
      title: "Confirm access",
      state: "open",
      importance: 0.95,
      confidence: 0.8,
    },
    created,
  );
  convertKnowledgeOwner(db, "loop", "important", created);
  await upkeep(2).reviews();
  expect(db.prepare("SELECT subject_id FROM knowledge_work").all()).toEqual([
    { subject_id: "important" },
  ]);
});
it("persists dormant and bounded defer decisions without moving meaningful verification age", async () => {
  const node = page();
  await upkeep(0).reviews();
  expect(getKnowledgeNode(db, node.id)?.metadata).toMatchObject({
    reviewDecision: "dormant",
    reviewDecidedAt: now,
    nextReviewAt: now + cfg.maxReviewIntervalMs,
  });
  db.prepare(
    "UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.nextReviewAt',?) WHERE id=?",
  ).run(now - 1, node.id);
  await upkeep(1).reviews();
  expect(getKnowledgeNode(db, node.id)?.metadata).toMatchObject({
    reviewDecision: "defer",
    nextReviewAt: now + Math.max(60000, cfg.routineDelayMs),
  });
  expect(getKnowledgeNode(db, node.id)?.metadata.lastVerifiedAt).toBeUndefined();
});
it.each([
  [0, "dormant"],
  [0.249, "dormant"],
  [0.25, "defer"],
  [0.5, "defer"],
  [0.749, "defer"],
  [0.75, "now"],
  [1, "now"],
] as const)("maps normalized ordered review score %s to %s", (score, decision) => {
  const signals = knowledgeReviewSignals(db, page(), now);
  expect(decideKnowledgeReview(signals, score, cfg).decision).toBe(decision);
});
it("commits immediate scheduling metadata and work atomically under the node revision", () => {
  const node = page();
  const input = {
    id: node.id,
    expectedRevision: node.revision,
    nextReviewAt: now,
    decision: "now" as const,
    reason: "decision_unavailable",
  };
  expect(() =>
    scheduleKnowledgeReview(db, { ...input, expectedRevision: 0, workId: "review" }, now),
  ).toThrow("Review candidate changed");
  expect(() => scheduleKnowledgeReview(db, input, now)).toThrow("work identity");
  expect(getKnowledgeNode(db, node.id)?.metadata.reviewDecision).toBeUndefined();
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_work").get()).toEqual({ n: 0 });
  scheduleKnowledgeReview(db, { ...input, workId: "review" }, now);
  expect(getKnowledgeNode(db, node.id)?.metadata).toMatchObject({
    reviewDecision: "now",
    reviewReason: "decision_unavailable",
    reviewDecidedAt: now,
  });
  expect(db.prepare("SELECT reason,due_at FROM knowledge_work WHERE id='review'").get()).toEqual({
    reason: "review",
    due_at: now,
  });
});
it("forces the maximum-interval backstop and falls back to review on unavailable judgement", async () => {
  const old = page("old", now - cfg.maxReviewIntervalMs);
  const signals = knowledgeReviewSignals(db, old, now);
  expect(decideKnowledgeReview(signals, 0, cfg)).toMatchObject({
    decision: "now",
    reason: "fairness_or_checkpoint",
  });
  page("uncertain");
  await upkeep(null).reviews();
  expect(db.prepare("SELECT subject_id FROM knowledge_work ORDER BY subject_id").all()).toEqual([
    { subject_id: "old" },
    { subject_id: "uncertain" },
  ]);
});
it.each(["dismissed_acknowledged", "dismissed_snoozed", "retired", "expired"])(
  "preserves %s brief snapshots and excludes them from active reviews",
  async (state) => {
    createBrief(
      db,
      {
        id: "brief",
        createdByRun: "run",
        kind: "info",
        title: "Workshop update",
        description: "A past update",
        confidence: 0.8,
        urgency: 0.2,
        ...(state === "expired" ? { relevantUntil: now - 1 } : {}),
      },
      now - cfg.maxReviewIntervalMs * 2,
    );
    if (state !== "expired") db.prepare("UPDATE briefs SET state=? WHERE id='brief'").run(state);
    const node = convertKnowledgeOwner(db, "brief", "brief", now).node;
    expect(isHistoricalKnowledgeBrief(db, node, now)).toBe(true);
    expect(node.metadata.activity).toBe("historical");
    await upkeep(2).reviews();
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_work").get()).toEqual({ n: 0 });
    expect(getKnowledgeNode(db, "brief")?.markdown).toBe(node.markdown);
  },
);
