// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createObservation } from "../storage/observations.js";
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
import { isHistoricalKnowledgeOwner } from "./owner-maintenance.js";

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
it.each(["live", "shipped", "dropped", "expired"] as const)(
  "preserves a %s observation unrewritten and excludes it from active reviews",
  async (state) => {
    createObservation(
      db,
      {
        id: "observation",
        createdByRun: "run",
        summary: "Workshop update",
        why: "A past update",
        ...(state === "expired" ? { relevantUntil: now - 1 } : {}),
      },
      now - cfg.maxReviewIntervalMs * 2,
    );
    if (state === "shipped" || state === "dropped")
      db.prepare("UPDATE observations SET state=? WHERE id='observation'").run(state);
    const node = convertKnowledgeOwner(db, "observation", "observation", now).node;
    expect(isHistoricalKnowledgeOwner(db, node, now)).toBe(true);
    expect(node.metadata.activity).toBe(state === "live" ? "active" : "historical");
    await upkeep(2).reviews();
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_work").get()).toEqual({ n: 0 });
    expect(getKnowledgeNode(db, "observation")?.markdown).toBe(node.markdown);
  },
);

it("does not let repeated fresh wiki verification postpone its whole-page review backstop", async () => {
  const created = now - cfg.maxReviewIntervalMs * 2;
  const node = page("edited-wiki", created);
  for (const verifiedAt of [now - 1000, now - 1, now]) {
    db.prepare("UPDATE knowledge_nodes SET metadata_json=? WHERE id=?").run(
      JSON.stringify({ lastVerifiedAt: verifiedAt, nextReviewAt: null }),
      node.id,
    );
    const signals = knowledgeReviewSignals(db, getKnowledgeNode(db, node.id)!, now);
    expect(signals.lastMeaningfulReviewAt).toBe(created);
    expect(decideKnowledgeReview(signals, 0, cfg)).toMatchObject({
      decision: "now",
      reason: "fairness_or_checkpoint",
    });
  }
  // Exercise the SQL nomination too: stale nextReviewAt is deliberately absent.
  await upkeep(0).reviews();
  expect(db.prepare("SELECT subject_id,reason FROM knowledge_work").all()).toEqual([
    { subject_id: node.id, reason: "review" },
  ]);
});

it("advances the wiki clock only for a completed whole review and preserves loop verification timing", async () => {
  const created = now - cfg.maxReviewIntervalMs * 2;
  const node = page("reviewed-wiki", created);
  db.prepare("UPDATE knowledge_nodes SET metadata_json=? WHERE id=?").run(
    JSON.stringify({ lastVerifiedAt: now, lastReviewedAt: now - 10, nextReviewAt: null }),
    node.id,
  );
  const wikiSignals = knowledgeReviewSignals(db, getKnowledgeNode(db, node.id)!, now);
  expect(wikiSignals.lastMeaningfulReviewAt).toBe(now - 10);
  expect(decideKnowledgeReview(wikiSignals, 0, cfg).nextReviewAt).toBe(
    now - 10 + cfg.maxReviewIntervalMs,
  );
  createOpenLoop(
    db,
    {
      id: "verified-loop",
      createdByRun: "run",
      title: "Inspect workshop equipment",
      state: "open",
      importance: 0.1,
      confidence: 0.8,
    },
    created,
  );
  convertKnowledgeOwner(db, "loop", "verified-loop", created);
  db.prepare("UPDATE knowledge_nodes SET metadata_json=? WHERE id='verified-loop'").run(
    JSON.stringify({ lastVerifiedAt: now - 1, lastReviewedAt: created, nextReviewAt: null }),
  );
  const loopSignals = knowledgeReviewSignals(db, getKnowledgeNode(db, "verified-loop")!, now);
  expect(loopSignals.lastMeaningfulReviewAt).toBe(now - 1);
  expect(decideKnowledgeReview(loopSignals, 0, cfg).nextReviewAt).toBe(
    now - 1 + cfg.maxReviewIntervalMs,
  );
  await upkeep(0).reviews();
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_work").get()).toEqual({ n: 0 });
});

it("nominates substantial editorial growth despite a dormant schedule and recent proof verification", async () => {
  const reviewed = now - cfg.routineDelayMs - 1;
  const baseline = page("grown", reviewed);
  saveKnowledgeNode(
    db,
    {
      id: baseline.id,
      kind: "wiki",
      title: baseline.title,
      markdown: "Legacy context with additional independently established constraints and changes.",
      expectedRevision: baseline.revision,
      inputVersions: {},
      metadata: {
        lastReviewedAt: reviewed,
        lastVerifiedAt: now,
        nextReviewAt: now + cfg.maxReviewIntervalMs,
      },
    },
    reviewed + 1,
  );
  let packet: unknown;
  await upkeep(2, (state) => {
    packet = state;
  }).reviews();
  expect(packet).toMatchObject({ editorial: { baselineRevision: 1, substantialGrowth: true } });
  expect(getKnowledgeNode(db, baseline.id)?.metadata).toMatchObject({
    reviewDecision: "now",
    reviewReason: "decision_review",
  });
  expect(db.prepare("SELECT subject_id,reason FROM knowledge_work").all()).toEqual([
    { subject_id: baseline.id, reason: "review" },
  ]);
});

it("keeps gate deferral authoritative for growth and an unchanged recently reviewed wiki", () => {
  const reviewed = now - 1;
  const baseline = page("recent", reviewed);
  db.prepare("UPDATE knowledge_nodes SET metadata_json=? WHERE id=?").run(
    JSON.stringify({ lastReviewedAt: reviewed }),
    baseline.id,
  );
  const unchanged = knowledgeReviewSignals(db, getKnowledgeNode(db, baseline.id)!, now);
  expect(unchanged.editorial?.substantialGrowth).toBe(false);
  expect(decideKnowledgeReview(unchanged, 0, cfg).nextReviewAt).toBe(
    reviewed + cfg.maxReviewIntervalMs,
  );
  saveKnowledgeNode(
    db,
    {
      id: baseline.id,
      kind: "wiki",
      title: baseline.title,
      markdown:
        "Legacy context with enough expanded supporting account to warrant editorial consolidation.",
      expectedRevision: baseline.revision,
      inputVersions: {},
      metadata: { lastReviewedAt: reviewed },
    },
    now,
  );
  const grown = knowledgeReviewSignals(db, getKnowledgeNode(db, baseline.id)!, now);
  expect(decideKnowledgeReview(grown, 0, cfg)).toMatchObject({
    decision: "dormant",
    nextReviewAt: reviewed + cfg.maxReviewIntervalMs,
  });
});

it("does not rejudge unchanged growth on every upkeep tick after a low gate score", async () => {
  const reviewed = now - cfg.routineDelayMs - 1;
  const baseline = page("declined-growth", reviewed);
  saveKnowledgeNode(
    db,
    {
      id: baseline.id,
      kind: "wiki",
      title: baseline.title,
      markdown: "Legacy context plus a much larger supporting account of scope and constraints.",
      expectedRevision: baseline.revision,
      inputVersions: {},
      metadata: { lastReviewedAt: reviewed, nextReviewAt: now + cfg.maxReviewIntervalMs },
    },
    reviewed + 1,
  );
  let calls = 0;
  const worker = upkeep(0, () => {
    calls++;
  });
  await worker.reviews();
  await worker.reviews();
  expect(calls).toBe(1);
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_work").get()).toEqual({ n: 0 });
  expect(getKnowledgeNode(db, baseline.id)?.metadata).toMatchObject({
    reviewDecision: "dormant",
    reviewDecidedAt: now,
    nextReviewAt: reviewed + cfg.maxReviewIntervalMs,
  });
});

it("tolerates a wiki removed after review nomination without inventing editorial signals", () => {
  const node = page("removed", now - 1);
  node.metadata.lastReviewedAt = now - 1;
  db.prepare("DELETE FROM knowledge_nodes WHERE id=?").run(node.id);
  expect(knowledgeReviewSignals(db, node, now).editorial).toBeNull();
});
