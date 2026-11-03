// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createBriefsStorageTables } from "../storage/schema.js";
import { resolveBrainSettings } from "../config.js";
import { outcomeRecordPolicyKey } from "../record-check/rubric.js";
import { createKnowledgeTables, saveKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { KnowledgeService } from "./service.js";
import { KnowledgeUpkeep } from "./engine-upkeep.js";
import { KnowledgeOrganization } from "./engine-organization.js";
import { newSubjectCohortTally } from "./organization-cohorts.js";
import { directKnowledgeGate } from "./writer.js";
import type { KnowledgeSelectionReads } from "./selection-reads.js";
import type { KnowledgeEngineDeps } from "./engine.js";

const now = Date.parse("2027-03-10T12:00:00Z");
const settings = resolveBrainSettings();
const cfg = settings.knowledge;
const log = createLogger("test:selection-reads");
let db: Database.Database;
let reads: {
  [K in keyof KnowledgeSelectionReads]: ReturnType<typeof vi.fn>;
};
let deps: KnowledgeEngineDeps;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  // Due on the handle, so only the port decides whether it is reviewed.
  saveKnowledgeNode(
    db,
    {
      id: "page",
      kind: "wiki",
      title: "Workshop plan",
      markdown: "Room booking and the speaker list.",
      expectedRevision: 0,
      inputVersions: {},
      metadata: { nextReviewAt: now - 1 },
    },
    now - 1000,
  );
  reads = {
    knowledgeOrganizationAdmissions: vi.fn(() => Promise.resolve([])),
    knowledgeOrganizationCohort: vi.fn(() =>
      Promise.resolve({ selection: null, tally: newSubjectCohortTally() }),
    ),
    knowledgeDueReviews: vi.fn(() => Promise.resolve([])),
    knowledgeStaleWork: vi.fn(() => Promise.resolve([])),
    knowledgeHasExcludedWork: vi.fn(() => Promise.resolve(false)),
    knowledgeArcs: vi.fn(() => Promise.resolve([])),
    knowledgeDiscoveryBacklog: vi.fn(() => Promise.resolve([])),
    knowledgePlanningWork: vi.fn(() => Promise.resolve([])),
    knowledgeRecoverableBatches: vi.fn(() => Promise.resolve([])),
    knowledgeDecisionPayloadSubjects: vi.fn(() => Promise.resolve(null)),
  };
  const writeGate = directKnowledgeGate(db);
  const base = { db, writeGate, clock: () => now, log, getSettings: () => settings };
  deps = {
    ...base,
    service: new KnowledgeService(base),
    decisions: { getDecision: () => null, log, recordSpend: () => Promise.resolve() },
    selectionReads: reads as unknown as KnowledgeSelectionReads,
  } as unknown as KnowledgeEngineDeps;
});
afterEach(() => db.close());

const reviewWork = () =>
  db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all();

it("reviews only the nodes the selection port returns", async () => {
  let id = 0;
  const upkeep = new KnowledgeUpkeep(deps, () => `kw-${++id}`);
  await upkeep.reviews();
  expect(reads.knowledgeDueReviews).toHaveBeenCalledWith({
    now,
    limit: cfg.maxReviewsPerTick,
    soonDelayMs: cfg.soonDelayMs,
    routineDelayMs: cfg.routineDelayMs,
    maxReviewIntervalMs: cfg.maxReviewIntervalMs,
    checkpointLeadMs: cfg.checkpointLeadMs,
  });
  expect(reviewWork()).toEqual([]);

  reads.knowledgeDueReviews.mockResolvedValueOnce([
    { id: "page", policy_review: 0, proof_policy_review: 1 },
  ]);
  await upkeep.reviews();
  expect(reviewWork()).toEqual([{ subject_id: "page" }]);
});

it("admits organization work from the selection port", async () => {
  await new KnowledgeUpkeep(deps, () => "kw").organization();
  expect(reads.knowledgeOrganizationAdmissions).toHaveBeenCalledWith({
    now,
    limit: cfg.maxReviewsPerTick,
    retryMs: cfg.maxReviewIntervalMs,
    initialDelayMs: cfg.soonDelayMs,
    excludedSources: settings.excludedSources,
  });
});

it("asks the selection port for a cohort, passing over keys as plain lists", async () => {
  const organization = new KnowledgeOrganization({
    deps,
    id: (prefix) => `${prefix}_1`,
    frontier: () => null,
    arcs: () => [],
    roots: () => new Set(),
    source: () => null,
  });
  expect(await organization.plan()).toBe(0);
  expect(reads.knowledgeOrganizationCohort).toHaveBeenCalledTimes(1);
  expect(reads.knowledgeOrganizationCohort.mock.calls[0]![0]).toMatchObject({
    now,
    skipSubjects: [],
    skipFingerprints: [],
  });
});

it("asks for outcome-policy revalidation only when record checks are enforced with a decision model", async () => {
  const enforced = resolveBrainSettings({ annotations: { recordCheck: "enforce" } });
  const decision = { modelId: "scripted", dispose() {}, decide: vi.fn() };
  const upkeep = new KnowledgeUpkeep(
    {
      ...deps,
      getSettings: () => enforced,
      decisions: { ...deps.decisions, getDecision: () => decision },
    } as unknown as KnowledgeEngineDeps,
    () => "kw",
  );
  await upkeep.reviews();
  expect(reads.knowledgeDueReviews.mock.calls[0]![0]).toMatchObject({
    outcomePolicy: outcomeRecordPolicyKey("enforce", "scripted"),
  });
});

it("recovers only the batches the selection port returns", async () => {
  const batch = (id: string) =>
    db
      .prepare(
        `INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,revision,created_at,updated_at)
         VALUES(?,?,'fixture','routine','pending',1,?,?)`,
      )
      .run(id, `run-${id}`, now - 2000, now - 2000);
  batch("orphan");
  const status = () =>
    db.prepare<[], { status: string }>("SELECT status FROM knowledge_batches").get()!.status;
  const upkeep = new KnowledgeUpkeep(deps, () => "kw");

  // The batch's run is missing, which the handle would recover; the port says nothing is.
  await upkeep.recover();
  expect(reads.knowledgeRecoverableBatches).toHaveBeenCalledWith({
    maxAttempts: 5,
    claimedBefore: now - 60 * 60_000,
    limit: cfg.maxSeeds,
  });
  expect(status()).toBe("pending");

  reads.knowledgeRecoverableBatches.mockResolvedValueOnce([
    { id: "orphan", runId: "run-orphan", failed: 0, dead: 0 },
  ]);
  await upkeep.recover();
  expect(status()).toBe("abandoned");
});
