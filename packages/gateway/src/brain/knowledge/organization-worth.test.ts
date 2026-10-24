// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { discoveryDecisionState, knowledgeRubricVersion } from "./decision.js";
import { createKnowledgeDecisionTable, recordKnowledgeDecision } from "./decision-storage.js";
import {
  currentDiscoveryVerdict,
  lowWorthOrganizationSources,
  type OrganizationWorthSource,
} from "./organization-worth.js";
import { knowledgeHash } from "./storage-validation.js";
import type { KnowledgeEngineDeps } from "./engine.js";

const log = createLogger("organization-worth-test");

/** Invented sources across status streams, plus one that is not routine. */
const SOURCES: Record<string, OrganizationWorthSource> = {
  parcel: source("Parcel update: out for delivery", "Your parcel left the local depot."),
  uptime: source("Monitor recovered: status page", "The status page responded again."),
  card: source("Card ending 0042: purchase approved", "A purchase of 12.40 was approved."),
  build: source("Build #88 passed", "Workflow nightly for atlas-web passed."),
  lease: source(
    "Lease renewal signed",
    "Both parties signed the flat lease renewal for another year.",
  ),
};
function source(title: string, content: string): OrganizationWorthSource {
  return {
    title,
    content,
    sourceRevision: `rev-${title.length}`,
    sourceCreatedAt: "2026-03-02T09:00:00Z",
    sourceUpdatedAt: null,
  };
}
const versions = Object.fromEntries(
  Object.entries(SOURCES).map(([id, s]) => [id, s.sourceRevision]),
);

let db: Database.Database;
let decide: ReturnType<typeof vi.fn>;
let deps: KnowledgeEngineDeps;
let decisionAvailable = true;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT,source_id TEXT)",
  );
  createBriefsStorageTables(db);
  createKnowledgeDecisionTable(db);
  decisionAvailable = true;
  // The scripted model scores only the lease as worth organizing.
  decide = vi.fn(async (request: { state: { source: { title: string } } }) => ({
    model: "scripted",
    answers: {
      discovery: { type: "score", score: request.state.source.title.startsWith("Lease") ? 2 : 0 },
    },
  }));
  const decision = { modelId: "scripted", dispose() {}, decide } as unknown as DecisionCapability;
  deps = {
    db,
    log,
    clock: () => 1000,
    getSettings: () => resolveBrainSettings(),
    decisions: {
      getDecision: () => (decisionAvailable ? decision : null),
      log,
      recordSpend: async () => {},
      record: async (entry: Parameters<typeof recordKnowledgeDecision>[1]) =>
        recordKnowledgeDecision(db, { ...entry, id: `kd_${Math.random()}` }, 1000),
    },
  } as unknown as KnowledgeEngineDeps;
});
afterEach(() => db.close());

const lookup = (id: string) => SOURCES[id] ?? null;
const record = (id: string, score: number, rubricVersion: string) =>
  recordKnowledgeDecision(
    db,
    {
      id: `kd_${id}_${rubricVersion}`,
      purpose: "discovery",
      inputFingerprint: knowledgeHash(discoveryDecisionState(SOURCES[id]!)),
      rubricVersion,
      score,
      modelId: "scripted",
      latencyMs: 1,
      inputTokens: 1,
      nodeId: `source:${id}`,
    },
    500,
  );

it("judges members without a current-rubric verdict once and withdraws the low-worth ones", async () => {
  // A verdict under an older rubric does not count: the member is judged again.
  record("build", 1, "knowledge-discovery-value-v1");
  expect(await lowWorthOrganizationSources(deps, versions, lookup)).toEqual({
    parcel: versions.parcel,
    uptime: versions.uptime,
    card: versions.card,
    build: versions.build,
  });
  expect(decide).toHaveBeenCalledTimes(5);
  // Every judgement is in the ledger under the current rubric.
  const ledger = db
    .prepare(
      "SELECT node_id AS nodeId,score,rubric_version AS rubric FROM knowledge_decisions WHERE rubric_version=? ORDER BY node_id",
    )
    .all(knowledgeRubricVersion("discovery"));
  expect(ledger).toEqual(
    ["build", "card", "lease", "parcel", "uptime"].map((id) => ({
      nodeId: `source:${id}`,
      score: id === "lease" ? 1 : 0,
      rubric: knowledgeRubricVersion("discovery"),
    })),
  );
  // A recorded current verdict is reused rather than asked again.
  decide.mockClear();
  expect(Object.keys(await lowWorthOrganizationSources(deps, versions, lookup)).sort()).toEqual([
    "build",
    "card",
    "parcel",
    "uptime",
  ]);
  expect(decide).not.toHaveBeenCalled();
  expect(currentDiscoveryVerdict(db, "lease", SOURCES.lease!)).toBe(1);
});

it("keeps every member when no decision model is assigned, without writing the ledger", async () => {
  decisionAvailable = false;
  expect(await lowWorthOrganizationSources(deps, versions, lookup)).toEqual({});
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_decisions").get()).toEqual({ n: 0 });
});

it("keeps a member whose source changed or is unreadable", async () => {
  expect(
    await lowWorthOrganizationSources(deps, { parcel: "older-revision", gone: "rev-1" }, lookup),
  ).toEqual({});
  expect(decide).not.toHaveBeenCalled();
});

it("keeps a member when the judgement is unavailable", async () => {
  decide.mockRejectedValue(new Error("decision outage"));
  expect(await lowWorthOrganizationSources(deps, { parcel: versions.parcel! }, lookup)).toEqual({});
});
