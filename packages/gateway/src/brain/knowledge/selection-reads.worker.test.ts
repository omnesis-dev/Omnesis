// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The knowledge engine's tick selections, run on the real io worker against a
 * temp database: each returns exactly what the same read returns on a direct
 * handle, so moving a selection off the main event loop changes nothing the
 * engine decides.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { Scheduler } from "../../scheduler/scheduler.js";
import { IoTaskRunner } from "../../scheduler/runners/io.js";
import { ioGateFromScheduler } from "../../scheduler/io-ops.js";
import { resolveBrainSettings } from "../config.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { KNOWLEDGE_DISCOVERY_POLICY, recordKnowledgeCoverage } from "./discovery.js";
import { directKnowledgeSelectionReads, type KnowledgeSelectionReads } from "./selection-reads.js";
import { readKnowledgeSourceRevision } from "./source-revision.js";
import { saveKnowledgeNode } from "./storage.js";
import { convertKnowledgeOwner } from "./owner-adapters.js";
import { enqueueKnowledgeWork } from "./work.js";
import type Database from "better-sqlite3";

const WORKER_URL = new URL("../../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../../workers/register-tsx.mjs", import.meta.url).href;
const cfg = resolveBrainSettings().knowledge;
const reviewNow = Date.parse("2027-03-10T12:00:00Z");

let dbPath: string;
let db: Database.Database;
let scheduler: Scheduler;
let worker: KnowledgeSelectionReads;
let direct: KnowledgeSelectionReads;

function seed(): void {
  for (const id of ["capacity", "roster", "agenda"])
    db.prepare(
      `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,source_created_at,source_updated_at,ingested_at,updated_at)
      VALUES(?,'fixture','fixture-notes',?,'Observatory allocation','The observation team has six places.','body-v1','2026-02-01','2026-02-01','2026-02-01','2026-02-01')`,
    ).run(id, id);
  const coverage = (id: string, status: "considered" | "deferred") =>
    recordKnowledgeCoverage(
      db,
      {
        subjectId: id,
        inputRevision: readKnowledgeSourceRevision(db, id)!,
        phase: "organization",
        policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
        status,
        reconsiderAt: status === "deferred" ? 2 : undefined,
      },
      1,
    );
  coverage("capacity", "considered");
  coverage("roster", "considered");
  coverage("agenda", "deferred");
  saveKnowledgeNode(
    db,
    {
      id: "page",
      kind: "wiki",
      title: "Workshop plan",
      markdown: "Room booking and the speaker list.",
      expectedRevision: 0,
      inputVersions: {},
      metadata: { nextReviewAt: reviewNow - 1 },
    },
    reviewNow - 1000,
  );
}

beforeEach(async () => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath) as unknown as Database.Database;
  seed();
  direct = directKnowledgeSelectionReads(db);
  scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  worker = ioGateFromScheduler(scheduler);
});

afterEach(async () => {
  await scheduler.dispose();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

it("selects the same organization admissions on the worker as on the handle", async () => {
  const options = { now: 10, limit: 10, retryMs: 1, excludedSources: [] };
  const expected = await direct.knowledgeOrganizationAdmissions(options);
  expect(expected).toEqual([expect.objectContaining({ kind: "coverage", id: "agenda" })]);
  expect(await worker.knowledgeOrganizationAdmissions(options)).toEqual(expected);
});

it("selects the same organization cohort, and returns the subject tally, on the worker", async () => {
  const options = {
    now: 100,
    intervalMs: 100,
    retryMs: 500,
    subjectIntervalMs: 60_000,
    skipSubjects: ["loop-passed-over"],
    skipFingerprints: ["fingerprint-passed-over"],
  };
  const expected = await direct.knowledgeOrganizationCohort(options);
  expect(Object.keys(expected.selection?.sourceVersions ?? {}).sort()).toEqual([
    "capacity",
    "roster",
  ]);
  expect(expected.tally.evaluated).toBe(true);
  expect(await worker.knowledgeOrganizationCohort(options)).toEqual(expected);
});

it("passes over a selection by its fingerprint on the worker as on the handle", async () => {
  const options = { now: 100, intervalMs: 100, retryMs: 500 };
  const { selection } = await direct.knowledgeOrganizationCohort(options);
  const skipped = { ...options, skipFingerprints: [selection!.inputFingerprint] };
  expect((await direct.knowledgeOrganizationCohort(skipped)).selection).toBeNull();
  expect((await worker.knowledgeOrganizationCohort(skipped)).selection).toBeNull();
});

it("selects the same due reviews on the worker as on the handle", async () => {
  const options = {
    now: reviewNow,
    limit: cfg.maxReviewsPerTick,
    soonDelayMs: cfg.soonDelayMs,
    routineDelayMs: cfg.routineDelayMs,
    maxReviewIntervalMs: cfg.maxReviewIntervalMs,
    checkpointLeadMs: cfg.checkpointLeadMs,
  };
  const expected = await direct.knowledgeDueReviews(options);
  expect(expected).toEqual([{ id: "page", policy_review: 0, proof_policy_review: 0 }]);
  expect(await worker.knowledgeDueReviews(options)).toEqual(expected);
});

it("nominates a loop for outcome-policy revalidation on the worker as on the handle", async () => {
  createOpenLoop(
    db,
    {
      id: "loop",
      createdByRun: "run",
      title: "Confirm the venue",
      state: "open",
      importance: 0.4,
      confidence: 0.8,
    },
    reviewNow - 1000,
  );
  convertKnowledgeOwner(db, "loop", "loop", reviewNow - 1000);
  // Not due by time: only the outcome policy can make it due.
  db.prepare("UPDATE knowledge_nodes SET metadata_json=? WHERE id='loop'").run(
    JSON.stringify({ nextReviewAt: reviewNow + cfg.maxReviewIntervalMs }),
  );
  const options = {
    now: reviewNow,
    limit: cfg.maxReviewsPerTick,
    soonDelayMs: cfg.soonDelayMs,
    routineDelayMs: cfg.routineDelayMs,
    maxReviewIntervalMs: cfg.maxReviewIntervalMs,
    checkpointLeadMs: cfg.checkpointLeadMs,
  };
  const withoutPolicy = await direct.knowledgeDueReviews(options);
  expect(withoutPolicy.map((row) => row.id)).not.toContain("loop");
  const withPolicy = { ...options, outcomePolicy: "enforce:scripted" };
  const expected = await direct.knowledgeDueReviews(withPolicy);
  expect(expected).toContainEqual({ id: "loop", policy_review: 1, proof_policy_review: 0 });
  expect(await worker.knowledgeDueReviews(withPolicy)).toEqual(expected);
});

it("leaves a source excluded from the Brain out of every selection on the worker", async () => {
  db.prepare("UPDATE documents SET source_id='fixture-private' WHERE id='capacity'").run();
  db.prepare("UPDATE documents SET source_id='fixture-private' WHERE id='agenda'").run();
  const excludedSources = ["fixture-private"];
  const admissions = { now: 10, limit: 10, retryMs: 1, excludedSources };
  expect(await worker.knowledgeOrganizationAdmissions(admissions)).toEqual([]);
  expect(
    await worker.knowledgeOrganizationAdmissions({ ...admissions, excludedSources: [] }),
  ).toEqual([expect.objectContaining({ id: "agenda" })]);
  const cohort = { now: 100, intervalMs: 100, retryMs: 500, excludedSources };
  expect((await worker.knowledgeOrganizationCohort(cohort)).selection).toBeNull();
  expect(await worker.knowledgeOrganizationCohort(cohort)).toEqual(
    await direct.knowledgeOrganizationCohort(cohort),
  );
});

function pendingSourceWork(id: string): void {
  enqueueKnowledgeWork(
    db,
    {
      id: `work-${id}`,
      subjectId: id,
      subjectKind: "source",
      reason: "change",
      inputRevision: readKnowledgeSourceRevision(db, id)!,
      tier: "routine",
      dueAt: 5,
    },
    1,
  );
}

it("finds the same stale pending work on the worker as on the handle", async () => {
  pendingSourceWork("capacity");
  pendingSourceWork("roster");
  db.prepare("UPDATE documents SET content_hash='body-v2' WHERE id='capacity'").run();
  const expected = await direct.knowledgeStaleWork(512);
  expect(expected).toEqual(["work-capacity"]);
  expect(await worker.knowledgeStaleWork(512)).toEqual(expected);
});

it("finds pending work from an excluded source on the worker as on the handle", async () => {
  pendingSourceWork("roster");
  for (const excluded of [["fixture-notes"], ["fixture"], ["fixture-other"], []]) {
    const expected = await direct.knowledgeHasExcludedWork(excluded);
    expect(await worker.knowledgeHasExcludedWork(excluded), excluded.join()).toBe(expected);
  }
  expect(await worker.knowledgeHasExcludedWork(["fixture-notes"])).toBe(true);
  expect(await worker.knowledgeHasExcludedWork(["fixture-other"])).toBe(false);
});

it("reads the same planning arcs on the worker as on the handle", async () => {
  db.prepare("INSERT INTO knowledge_discovery_targets VALUES('roster',?,'page',1)").run(
    readKnowledgeSourceRevision(db, "roster"),
  );
  const inputs = ["source:roster", "source:capacity", "page"];
  const expected = await direct.knowledgeArcs(inputs, cfg.maxVisitedPerSeed);
  expect(new Map(expected).get("source:roster")).toEqual(["page"]);
  expect(await worker.knowledgeArcs(inputs, cfg.maxVisitedPerSeed)).toEqual(expected);
  expect(await worker.knowledgeArcs(inputs, 0)).toEqual(await direct.knowledgeArcs(inputs, 0));
});

it("reads the same discovery backlog on the worker as on the handle", async () => {
  pendingSourceWork("roster");
  for (const options of [
    { phase: "organization" as const, limit: 10, now: 10 },
    { phase: "organization" as const, limit: 10, now: 10, sourceId: "fixture-notes" },
    { phase: "interpretation" as const, limit: 1, now: 10, direction: "oldest-first" as const },
    { phase: "organization" as const, limit: 10, now: 10, notBefore: "2026-03-01" },
  ]) {
    const expected = await direct.knowledgeDiscoveryBacklog(options);
    expect(await worker.knowledgeDiscoveryBacklog(options)).toEqual(expected);
  }
  expect(
    (await worker.knowledgeDiscoveryBacklog({ phase: "organization", limit: 10, now: 10 })).map(
      (doc) => doc.id,
    ),
  ).toEqual(["agenda"]);
});
