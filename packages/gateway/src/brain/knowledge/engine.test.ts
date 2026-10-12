// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { CognitionRunDriver } from "../run-driver.js";
import { FsCognitionTranscriptStore } from "../transcripts.js";
import { ANNOTATION_CONTEXT_VERIFIER } from "../annotation-verification.js";
import { outcomeProposal } from "../record-check/outcome-context.js";
import { outcomeRecordPolicyKey } from "../record-check/rubric.js";
import { captureOutcomeWriteFence } from "../storage/outcome-write-fence.js";
import {
  createSourceInventoryTables,
  recordSourceInventoryPage,
  recordSourceInventoryDocument,
} from "../../data/repositories/SourceInventoryRepository.js";
import { DERIVATION_STAGES } from "../../domain/DocumentDerivation.js";
import { createTemporalAnnotationTables } from "../../enrichment/temporal-annotations/storage.js";
import {
  createObservation,
  getObservation,
  transitionObservation,
} from "../storage/observations.js";
import { createAnnotationStorageTables } from "../storage/annotations.js";
import { createPersonAnnotationStorageTables } from "../storage/person-annotations.js";
import { retireLoop } from "../storage/retired-loops.js";
import { createOpenLoop, updateOpenLoop, getOpenLoop } from "../storage/open-loops.js";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { OMNESIS_CHAT_SOURCE_ID } from "../../sources/omnesis-chat/ids.js";
import { writerHandlers } from "../../scheduler/writer-handlers.js";
import { makeOutcomeAssessment, recordOutcomeAssessmentAttempt } from "./outcome-assessment.js";
import { convertKnowledgeOwner } from "./owner-adapters.js";
import { installKnowledgeOwnerTriggers } from "./owner-triggers.js";
import { createKnowledgeSourceTriggers } from "./source-triggers.js";
import { createKnowledgeDecisionTable, recordKnowledgeDecision } from "./decision-storage.js";
import { readKnowledgeDecisionAudit } from "./decision-query.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { directKnowledgeGate } from "./writer.js";
import { captureKnowledgeCanonicalFence } from "./canonical-fence.js";
import { setKnowledgeLink } from "./links.js";
import { CONTEXTUAL_VERIFIER } from "./claim-context.js";
import { KnowledgeService } from "./service.js";
import { buildKnowledgeTools } from "./tools.js";
import { KnowledgeEngine, type KnowledgeEngineDeps } from "./engine.js";
import { fitKnowledgeFrontierItem, knowledgeFrontierPreflight } from "./engine-frontier.js";
import {
  KNOWLEDGE_DISCOVERY_POLICY,
  recordKnowledgeCoverage,
  proposeKnowledgeCandidate,
} from "./discovery.js";
import { listKnowledgeFrontier, createKnowledgeBatch, enqueueKnowledgeWork } from "./work.js";
import {
  advanceKnowledgeCascade,
  getKnowledgeNode,
  recordKnowledgeSourceChange,
  purgeKnowledgeNode,
  saveKnowledgeNode,
} from "./storage.js";

let db: Database.Database, engine: KnowledgeEngine, service: KnowledgeService;
let writeGate: ReturnType<typeof directKnowledgeGate>;
let now: number, serial: number, score: number, decisions: number;
let settings: ReturnType<typeof resolveBrainSettings>;
let decisionStates: unknown[];
let publishedRetrievalBoundary: string | null;
const log = createLogger("test:knowledge-engine");

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    `CREATE TABLE documents(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,content_hash TEXT NOT NULL,content TEXT NOT NULL,title TEXT NOT NULL,source_created_at TEXT,source_updated_at TEXT)`,
  );
  createBriefsStorageTables(db);
  createTemporalAnnotationTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  now = Date.parse("2027-01-11T08:00:00Z");
  serial = 0;
  score = 0.9;
  decisions = 0;
  decisionStates = [];
  publishedRetrievalBoundary = null;
  settings = resolveBrainSettings({ bootstrap: { enabled: false } });
  writeGate = directKnowledgeGate(db);
  service = new KnowledgeService({
    db,
    writeGate,
    getSettings: () => settings,
    clock: () => now,
    log,
  });
  const decision: DecisionCapability = {
    modelId: "scripted",
    dispose() {},
    async decide(request) {
      decisions++;
      decisionStates.push(request.state);
      return {
        model: "scripted",
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [
            key,
            { type: "score" as const, score: score * 2 },
          ]),
        ),
      };
    },
  };
  const deps = {
    db,
    writeGate,
    service,
    getSettings: () => settings,
    clock: () => now,
    log,
    idGen: () => String(++serial),
    publishedRetrievalBoundary: () => publishedRetrievalBoundary,
    decisions: { getDecision: () => decision, log, recordSpend: async () => {} },
  } satisfies KnowledgeEngineDeps;
  engine = new KnowledgeEngine(deps);
});
afterEach(() => db.close());

function source(id = "input", hash = "v1", content = "The workshop begins Friday.", at = now) {
  db.prepare(
    `INSERT INTO documents VALUES(?,'fictional',?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content_hash=excluded.content_hash,content=excluded.content,source_updated_at=excluded.source_updated_at`,
  ).run(id, hash, content, id, new Date(at).toISOString(), new Date(at).toISOString());
  recordKnowledgeSourceChange(db, { documentId: id, contentHash: hash }, now);
  advanceKnowledgeCascade(db, 100, now);
}
function batchFor(subjectId: string): { id: string; runId: string } {
  return db
    .prepare<
      [string],
      { id: string; runId: string }
    >(`SELECT b.id,b.run_id AS runId FROM knowledge_batches b JOIN knowledge_work w ON w.batch_id=b.id WHERE w.subject_id=? AND b.status IN ('pending','running') ORDER BY b.created_at DESC,b.id DESC LIMIT 1`)
    .get(subjectId)!;
}
async function wiki(id = "project", ref = "source:input", text = "The workshop begins Friday.") {
  const version = service.reference(ref).revision;
  return service.save({
    id,
    kind: "wiki",
    title: id,
    markdown: `<claim id="fact" refs="${ref}">${text}</claim>`,
    expectedRevision: 0,
    inputVersions: { [ref]: version },
  });
}

describe("knowledge coordinator", () => {
  it("settles a completed batch before backend resolution or new-source adoption", async () => {
    source();
    await engine.tick();
    const batch = batchFor("input");
    const offered = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    await engine.completeSource(
      batch.id,
      batch.runId,
      offered.id,
      offered.inputFingerprint,
      false,
      ["interpretation", "organization"],
      [],
    );
    expect(await engine.next(batch.id, batch.runId)).toMatchObject({ done: true });
    // New evidence belongs to its own obligation, not the completed batch's receipt.
    source("input", "v2");
    enqueueKnowledgeWork(
      db,
      {
        id: "later-source-work",
        subjectId: "input",
        subjectKind: "source",
        reason: "change",
        inputRevision: String(service.reference("source:input").revision),
        tier: "routine",
        dueAt: now,
      },
      now,
    );
    const before = db.prepare("SELECT * FROM knowledge_work ORDER BY id").all();
    const advance = vi.spyOn(writeGate, "knowledge.advanceCascade");
    const resolveBackend = vi.fn(() => {
      throw new Error("Terminal work must not resolve a model");
    });
    const dir = mkdtempSync(join(tmpdir(), "omnesis-terminal-run-"));
    try {
      const driver = new CognitionRunDriver({
        resolveBackend,
        log,
        transcripts: new FsCognitionTranscriptStore(dir),
        preflight: async (run) => knowledgeFrontierPreflight(await engine.next(batch.id, run.id)),
      });
      expect(
        await driver.execute({
          id: batch.runId,
          kind: "synthesis",
          attempts: 2,
          payload: { focus: "knowledge-maintenance", batchId: batch.id },
          payloadJson: JSON.stringify({ focus: "knowledge-maintenance", batchId: batch.id }),
        }),
      ).toMatchObject({ ok: true, modelId: null, usage: null });
      expect(
        await driver.execute({
          id: "wrong-owner",
          kind: "synthesis",
          attempts: 1,
          payload: { focus: "knowledge-maintenance", batchId: batch.id },
          payloadJson: JSON.stringify({ focus: "knowledge-maintenance", batchId: batch.id }),
        }),
      ).toMatchObject({ ok: false, modelId: null, usage: null });
      expect(resolveBackend).not.toHaveBeenCalled();
      expect(advance).not.toHaveBeenCalled();
      expect(db.prepare("SELECT * FROM knowledge_work ORDER BY id").all()).toEqual(before);
      expect(
        db.prepare("SELECT status FROM knowledge_work WHERE id='later-source-work'").get(),
      ).toEqual({ status: "pending" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settles a covered offered source with empty phases without losing dependent repair", async () => {
    source();
    await wiki();
    for (const phase of ["interpretation", "organization"] as const)
      recordKnowledgeCoverage(
        db,
        {
          subjectId: "input",
          inputRevision: "v1",
          phase,
          policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
          status: "considered",
        },
        now,
      );
    const coverage = db.prepare("SELECT * FROM knowledge_discovery_coverage ORDER BY phase").all();
    await engine.tick();
    const batch = batchFor("input");
    const offered = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    expect(offered.completionRequirements).toEqual({ requiredPhases: [] });
    const complete = buildKnowledgeTools(service, {
      runId: batch.runId,
      batchId: batch.id,
      engine,
    }).find((tool) => tool.name === "knowledge_discovery_complete")!;
    expect(
      await complete.invoke(
        { id: offered.id, inputFingerprint: "wrong", phases: [] },
        { sessionId: "test", messageId: "test" },
      ),
    ).toMatchObject({ kind: "error" });
    expect(
      await complete.invoke(
        { id: offered.id, inputFingerprint: offered.inputFingerprint, phases: [] },
        { sessionId: "test", messageId: "test" },
      ),
    ).toMatchObject({ kind: "structured" });
    expect(db.prepare("SELECT * FROM knowledge_discovery_coverage ORDER BY phase").all()).toEqual(
      coverage,
    );
    expect((await engine.next(batch.id, batch.runId)).items).toContainEqual(
      expect.objectContaining({ id: "project" }),
    );
  });

  it("bounds large frontier responses and requires explicit full-page fetches", async () => {
    settings = { ...settings, knowledge: { ...settings.knowledge, maxFrontierChars: 4096 } };
    saveKnowledgeNode(
      db,
      {
        id: "large",
        kind: "wiki",
        title: "Large planning context",
        markdown: "A long fictional planning note. ".repeat(1000),
        expectedRevision: 0,
        inputVersions: {},
        metadata: { nextReviewAt: now },
      },
      now,
    );
    db.exec("DELETE FROM knowledge_changes");
    await engine.tick();
    const batch = batchFor("large");
    const view = await engine.next(batch.id, batch.runId);
    expect(JSON.stringify(view).length).toBeLessThanOrEqual(4096);
    expect(view.items[0]).toMatchObject({
      id: "large",
      maintenanceGoal: "wiki_curation",
      maintenanceTask: expect.stringContaining("even in an organization batch"),
      fetchRequired: { id: "large", kind: "wiki" },
      inputVersionsOmitted: true,
      inputVersions: {},
    });
    expect(view.items[0]?.node).toBeUndefined();
    expect(service.fetch("large", true)!.markdown.length).toBeGreaterThan(4096);
    expect(listKnowledgeFrontier(db, batch.id)[0]?.status).toBe("offered");
    expect((await engine.next(batch.id, batch.runId)).done).toBe(false);
  });

  it("holds routine work until due, then offers the real source revision", async () => {
    score = 0.1;
    source();
    expect((await engine.tick()).enqueued).toBe(0);
    const pending = db
      .prepare("SELECT due_at FROM knowledge_work WHERE subject_id='input'")
      .get() as { due_at: number };
    expect(pending.due_at).toBe(now + settings.knowledge.routineDelayMs);
    now = pending.due_at;
    score = 0.9;
    await engine.tick();
    const batch = batchFor("input");
    expect(batch).toBeDefined();
    const view = await engine.next(batch.id, batch.runId);
    expect(view.items[0]?.source).toMatchObject({ id: "input", contentHash: "v1" });
  });

  it("does not bootstrap historic unlinked evidence without operator start", async () => {
    source("historic", "old", "An archived proposal.", now - 40 * 86400000);
    // Existing migration corpus has no new-ingestion journal obligation.
    db.prepare("DELETE FROM knowledge_changes").run();
    await engine.tick();
    expect(
      db.prepare("SELECT 1 FROM knowledge_work WHERE subject_id='historic'").get(),
    ).toBeUndefined();
    settings = { ...settings, bootstrap: { ...settings.bootstrap, enabled: true } };
    await engine.tick();
    expect(
      db.prepare("SELECT 1 FROM knowledge_work WHERE subject_id='historic'").get(),
    ).toBeUndefined();
    db.prepare(
      "INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)",
    ).run(String(now));
    await engine.tick();
    expect(batchFor("historic")).toBeDefined();
  });

  it("admits history independently of live backlog and rotates quieter sources", async () => {
    settings = {
      ...settings,
      bootstrap: { ...settings.bootstrap, enabled: true, batchSize: 1 },
      knowledge: { ...settings.knowledge, bootstrapBatchSize: 1, maxSeeds: 1 },
    };
    db.prepare(
      "INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)",
    ).run(String(now));
    for (const id of ["a-new", "a-old", "z-quiet"])
      source(id, "v1", "Archived fictional note", now - 40 * 86400000);
    db.exec("DELETE FROM knowledge_changes");
    db.prepare("UPDATE documents SET source_id=? WHERE id=?").run("alpha", "a-new");
    db.prepare("UPDATE documents SET source_id=?,source_created_at=? WHERE id=?").run(
      "alpha",
      new Date(now - 50 * 86400000).toISOString(),
      "a-old",
    );
    db.prepare("UPDATE documents SET source_id=? WHERE id=?").run("zeta", "z-quiet");
    source("live");
    await engine.tick();
    await engine.tick();
    await engine.tick();
    const admitted = db
      .prepare("SELECT subject_id FROM knowledge_work WHERE reason='discovery' ORDER BY subject_id")
      .all();
    expect(admitted).toEqual([{ subject_id: "a-new" }, { subject_id: "z-quiet" }]);
  });

  it.each(["fresh", "upgrade"] as const)(
    "fills one source's authorized batch without edit debounce on a %s database",
    async (mode) => {
      settings = resolveBrainSettings({
        bootstrap: {
          enabled: true,
          batchSize: 8,
          maxRuns: 50,
          maxRunsPerDay: 50,
          backlogTarget: 4,
        },
        knowledge: { bootstrapBatchSize: 4 },
      });
      db.prepare(
        "INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)",
      ).run(String(now));
      for (let index = 0; index < 7; index++)
        source(
          `archive-${index}`,
          "v1",
          "Archived workshop record.",
          now - (40 + index) * 86400000,
        );
      if (mode === "upgrade") {
        source("considered", "v1", "Previously considered workshop record.");
        recordKnowledgeCoverage(
          db,
          {
            subjectId: "considered",
            inputRevision: "v1",
            phase: "organization",
            policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
            status: "considered",
          },
          now,
        );
      }
      db.exec("DELETE FROM knowledge_changes");
      await engine.tick();
      const rows = () =>
        db
          .prepare(
            "SELECT subject_id,tier,due_at FROM knowledge_work WHERE reason='discovery' ORDER BY subject_id",
          )
          .all();
      expect(rows()).toEqual(
        Array.from({ length: 4 }, (_, index) => ({
          subject_id: `archive-${index}`,
          tier: "routine",
          due_at: now,
        })),
      );
      expect(settings.knowledge.routineDelayMs).toBeGreaterThan(0);
      expect(
        db.prepare("SELECT SUM(count) AS count FROM knowledge_historical_admissions").get(),
      ).toEqual({ count: 4 });
      await engine.tick();
      expect(rows()).toHaveLength(4); // Pending/batched work still occupies its backlog allowance.
    },
  );

  it("fills spare historical capacity in rounds without starving a quiet source", async () => {
    settings = resolveBrainSettings({
      bootstrap: { enabled: true, batchSize: 4, maxRuns: 50, maxRunsPerDay: 50, backlogTarget: 20 },
      knowledge: { bootstrapBatchSize: 4 },
    });
    db.prepare(
      "INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)",
    ).run(String(now));
    for (let index = 0; index < 6; index++) {
      source(`prolific-${index}`, "v1", "Archived workshop record.", now - (40 + index) * 86400000);
      db.prepare("UPDATE documents SET source_id='alpha' WHERE id=?").run(`prolific-${index}`);
    }
    source("quiet", "v1", "Archived workshop record.", now - 80 * 86400000);
    db.prepare("UPDATE documents SET source_id='zeta' WHERE id='quiet'").run();
    db.exec("DELETE FROM knowledge_changes");
    await engine.tick();
    expect(
      db
        .prepare(
          "SELECT subject_id FROM knowledge_work WHERE reason='discovery' ORDER BY subject_id",
        )
        .all(),
    ).toEqual([
      { subject_id: "prolific-0" },
      { subject_id: "prolific-1" },
      { subject_id: "prolific-2" },
      { subject_id: "quiet" },
    ]);
  });

  it.each(["maxRuns", "maxRunsPerDay", "batchSize"] as const)(
    "honors historical %s while filling a prolific source",
    async (bound) => {
      settings = resolveBrainSettings({
        bootstrap: {
          enabled: true,
          maxRuns: 50,
          maxRunsPerDay: 50,
          backlogTarget: 50,
          batchSize: 8,
          [bound]: 2,
        },
        knowledge: { bootstrapBatchSize: 8 },
      });
      db.prepare(
        "INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)",
      ).run(String(now));
      for (let index = 0; index < 5; index++)
        source(`bounded-${index}`, "v1", "Archived workshop record.", now - 40 * 86400000);
      db.exec("DELETE FROM knowledge_changes");
      await engine.tick();
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM knowledge_work WHERE reason='discovery'").get(),
      ).toEqual({ count: 2 });
      if (bound !== "batchSize") {
        await engine.tick();
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM knowledge_work WHERE reason='discovery'").get(),
        ).toEqual({ count: 2 });
      }
    },
  );

  it("does not fill historical capacity outside its active hours", async () => {
    const localHour = new Date(now).getHours();
    const hour = (offset: number) => `${String((localHour + offset) % 24).padStart(2, "0")}:00`;
    settings = resolveBrainSettings({
      bootstrap: { enabled: true, activeHours: { from: hour(1), to: hour(2) } },
    });
    db.prepare(
      "INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)",
    ).run(String(now));
    for (let index = 0; index < 4; index++)
      source(`closed-${index}`, "v1", "Archived workshop record.", now - 40 * 86400000);
    db.exec("DELETE FROM knowledge_changes");
    await engine.tick();
    expect(
      db.prepare("SELECT 1 FROM knowledge_work WHERE reason='discovery'").get(),
    ).toBeUndefined();
  });

  it("admits only history dated within its horizon, by the document's own date", async () => {
    settings = resolveBrainSettings({
      bootstrap: {
        enabled: true,
        batchSize: 10,
        maxRuns: 50,
        maxRunsPerDay: 50,
        backlogTarget: 20,
      },
      knowledge: { bootstrapBatchSize: 10 },
    });
    expect(settings.bootstrap.horizonMs).toBe(90 * 86400000);
    db.prepare(
      "INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)",
    ).run(String(now));
    for (const [id, days] of [
      ["within-30", 30],
      ["within-89", 89],
      ["beyond-91", 91],
      ["beyond-400", 400],
    ] as const)
      source(id, "v1", "Archived workshop record.", now - days * 86400000);
    db.exec("DELETE FROM knowledge_changes");
    const admitted = () =>
      db
        .prepare(
          "SELECT subject_id FROM knowledge_work WHERE reason='discovery' ORDER BY subject_id",
        )
        .all();
    await engine.tick();
    await engine.tick();
    expect(admitted()).toEqual([{ subject_id: "within-30" }, { subject_id: "within-89" }]);
    // Raising the horizon is live: the next pass reaches further back.
    settings = resolveBrainSettings({
      bootstrap: {
        enabled: true,
        batchSize: 10,
        maxRuns: 50,
        maxRunsPerDay: 50,
        backlogTarget: 20,
        horizon: "1y",
      },
      knowledge: { bootstrapBatchSize: 10 },
    });
    await engine.tick();
    expect(admitted()).toEqual([
      { subject_id: "beyond-91" },
      { subject_id: "within-30" },
      { subject_id: "within-89" },
    ]);
  });

  it("retires pending historical work the horizon excludes, even while admission is paused", async () => {
    settings = resolveBrainSettings({ bootstrap: { enabled: false, horizon: "60d" } });
    source("aged-out", "v1", "Archived workshop record.", now - 75 * 86400000);
    source("in-scope", "v1", "Archived workshop record.", now - 20 * 86400000);
    source("live-edit", "v1", "Archived workshop record.", now - 75 * 86400000);
    db.exec("DELETE FROM knowledge_changes");
    for (const [id, reason] of [
      ["aged-out", "discovery"],
      ["in-scope", "discovery"],
      ["live-edit", "change"],
    ] as const)
      await writeGate["knowledge.enqueue"](
        {
          id: `kw-${id}`,
          subjectId: id,
          subjectKind: "source",
          reason,
          inputRevision: "v1",
          tier: "routine",
          dueAt: now + 86400000,
        },
        now,
      );
    const counted = db
      .prepare<
        [],
        { count: number }
      >("SELECT SUM(count) AS count FROM knowledge_historical_admissions")
      .get()!.count;
    await engine.tick();
    await engine.tick();
    expect(
      db.prepare("SELECT subject_id,reason FROM knowledge_work ORDER BY subject_id").all(),
    ).toEqual([
      { subject_id: "in-scope", reason: "discovery" },
      // Reactive work is never historical admission, whatever its date.
      { subject_id: "live-edit", reason: "change" },
    ]);
    // Retirement does not refund admission already counted against the caps.
    expect(
      db.prepare("SELECT SUM(count) AS count FROM knowledge_historical_admissions").get(),
    ).toEqual({ count: counted });
  });

  it("fills a same-source historical daily allowance without advancing semantic time", async () => {
    settings = resolveBrainSettings({
      bootstrap: { enabled: true, maxRunsPerDay: 2, maxRuns: 50, backlogTarget: 2, batchSize: 10 },
      knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
      derivationBarrier: "0s",
    });
    db.prepare(
      "INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)",
    ).run(String(now));
    for (let i = 1; i <= 4; i++)
      source(`history-${i}`, "same-version", "Archived workshop record", now - i * 86400000);
    db.exec("DELETE FROM knowledge_changes");
    const instant = now;
    for (let pass = 0; pass < 12; pass++) {
      await engine.tick();
      for (const row of db
        .prepare<
          [],
          { subject_id: string }
        >("SELECT subject_id FROM knowledge_work WHERE reason='discovery' AND status='batched'")
        .all()) {
        const batch = batchFor(row.subject_id);
        const offered = (await engine.next(batch.id, batch.runId)).items[0];
        if (offered?.source) {
          await engine.completeSource(batch.id, batch.runId, offered.id, offered.inputFingerprint);
          expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
        }
      }
    }
    expect(now).toBe(instant);
    expect(
      db
        .prepare(
          "SELECT subject_id,status FROM knowledge_work WHERE reason='discovery' ORDER BY subject_id",
        )
        .all(),
    ).toEqual([
      { subject_id: "history-1", status: "completed" },
      { subject_id: "history-2", status: "completed" },
    ]);
    expect(db.prepare("SELECT count FROM knowledge_historical_admissions").get()).toEqual({
      count: 2,
    });
  });

  it("reconsiders due organization even when the discovery gate scores it low", async () => {
    source("revisit");
    db.exec("DELETE FROM knowledge_changes");
    recordKnowledgeCoverage(
      db,
      {
        subjectId: "revisit",
        inputRevision: "v1",
        phase: "organization",
        policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
        status: "gated",
        reconsiderAt: now,
      },
      now - 1000,
    );
    score = 0;
    await engine.tick();
    const batch = batchFor("revisit");
    const view = await engine.next(batch.id, batch.runId);
    expect(view.items).toEqual([expect.objectContaining({ id: "source:revisit", review: true })]);
    expect(
      db
        .prepare(
          "SELECT reconsider_at FROM knowledge_discovery_coverage WHERE subject_id='revisit'",
        )
        .get(),
    ).toEqual({ reconsider_at: now + settings.knowledge.maxReviewIntervalMs });
  });

  it("revisits legacy gated coverage with no explicit reconsideration timestamp", async () => {
    source("legacy-gated");
    db.exec("DELETE FROM knowledge_changes");
    recordKnowledgeCoverage(
      db,
      {
        subjectId: "legacy-gated",
        inputRevision: "v1",
        phase: "organization",
        policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
        status: "gated",
      },
      now - settings.knowledge.maxReviewIntervalMs - 1,
    );
    expect(
      db
        .prepare(
          "SELECT reconsider_at FROM knowledge_discovery_coverage WHERE subject_id='legacy-gated'",
        )
        .get(),
    ).toEqual({ reconsider_at: null });
    score = 0;
    await engine.tick();
    const batch = batchFor("legacy-gated");
    expect((await engine.next(batch.id, batch.runId)).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "source:legacy-gated", review: true }),
      ]),
    );
  });

  it("discovers newly arriving historical evidence even with bootstrap disabled", async () => {
    source("late", "old", "An archived proposal arrived today.", now - 400 * 86400000);
    await engine.tick();
    expect(batchFor("late")).toBeDefined();
  });

  it("offers invalidated temporal evidence even when the discovery gate says irrelevant", async () => {
    source();
    await engine.tick();
    db.prepare(
      `INSERT INTO temporal_annotations(id,interval_start_ms,interval_end_ms,precision,sentence,created_by_run,created_at,updated_at,invalidated_at,invalidation_cause)
      VALUES('casualty',1,2,'day','An obsolete workshop time.','prior',1,1,2,'content_change')`,
    ).run();
    db.prepare("INSERT INTO temporal_annotation_documents VALUES('casualty','input')").run();
    score = 0.1;
    const batch = batchFor("input");
    const view = await engine.next(batch.id, batch.runId);
    expect(view.done).toBe(false);
    expect(view.items[0]?.source?.id).toBe("input");
  });

  it("signals bounded continuation after refreshing root orientation with a one-node frontier", async () => {
    settings = { ...settings, knowledge: { ...settings.knowledge, maxFrontierNodes: 1 } };
    source();
    await wiki("project");
    await engine.tick();
    const root = db
      .prepare<[], { id: string }>("SELECT id FROM knowledge_nodes WHERE kind='root'")
      .get()!;
    const batch = batchFor(root.id);
    expect(batch).toBeDefined();
    await service.save({
      id: "project",
      kind: "wiki",
      title: "project",
      markdown: '<claim id="fact" refs="source:input">The workshop takes place Friday.</claim>',
      expectedRevision: getKnowledgeNode(db, "project")!.revision,
      inputVersions: { "source:input": "v1" },
    });
    const before = now;
    expect(await engine.next(batch.id, batch.runId)).toMatchObject({
      done: false,
      items: [],
      continuation: true,
    });
    const next = await engine.next(batch.id, batch.runId);
    expect(next.items.map((item) => item.id)).toEqual([root.id]);
    expect(now).toBe(before);
  });

  it("distinguishes a fully gated frontier continuation from genuinely waiting for content", async () => {
    settings = { ...settings, knowledge: { ...settings.knowledge, maxFrontierNodes: 1 } };
    source();
    await engine.tick();
    const batch = batchFor("input");
    engine.deps.contentPending = () => new Set(["input"]);
    const waiting = await engine.next(batch.id, batch.runId);
    expect(waiting).toMatchObject({ done: false, items: [] });
    expect(waiting.continuation).toBeUndefined();
    engine.deps.contentPending = () => new Set();
    score = 0;
    expect(await engine.next(batch.id, batch.runId)).toMatchObject({
      done: false,
      items: [],
      continuation: true,
    });
    expect(await engine.next(batch.id, batch.runId)).toMatchObject({ done: true, items: [] });
  });

  it("holds provisional content without model calls and releases immediately when ready", async () => {
    let pending = true;
    engine.deps.contentPending = () => (pending ? new Set(["input"]) : new Set());
    source();
    await engine.tick();
    expect(decisions).toBe(0);
    expect(batchFor("input")).toBeUndefined();
    expect(
      db.prepare("SELECT last_error FROM knowledge_work WHERE subject_id='input'").get(),
    ).toEqual({ last_error: "pending_content" });
    pending = false;
    now += 1;
    await engine.tick();
    expect(batchFor("input")).toBeDefined();
  });

  it("waits only for enabled derivation stages and releases when their stamps arrive", async () => {
    source();
    db.exec(
      "ALTER TABLE documents ADD COLUMN links_extracted_at TEXT; ALTER TABLE documents ADD COLUMN people_resolved_at TEXT; ALTER TABLE documents ADD COLUMN dates_extracted_at TEXT;",
    );
    engine.deps.activeDerivationStages = () =>
      DERIVATION_STAGES.filter((stage) => stage.id === "dates");
    await engine.tick();
    expect(batchFor("input")).toBeUndefined();
    db.prepare("UPDATE documents SET dates_extracted_at=? WHERE id='input'").run(
      new Date(now).toISOString(),
    );
    await engine.tick();
    expect(batchFor("input")).toBeDefined();
  });

  it("releases missing content at its bounded ceiling instead of waiting forever", async () => {
    engine.deps.contentPending = () => new Set(["input"]);
    source();
    await engine.tick();
    expect(batchFor("input")).toBeUndefined();
    now += settings.pendingContentBarrierMs;
    await engine.tick();
    expect(batchFor("input")).toBeDefined();
  });

  it("gives a newly provisional revision its own readiness ceiling in an older active batch", async () => {
    source();
    await engine.tick();
    const batch = batchFor("input");
    now += settings.pendingContentBarrierMs + 1;
    engine.deps.contentPending = () => new Set(["input"]);
    source("input", "v2", "Interim content awaiting completion.");
    await engine.tick();
    const waiting = await engine.next(batch.id, batch.runId);
    expect(waiting).toMatchObject({ done: false, items: [] });
    engine.deps.contentPending = () => new Set();
    now++;
    await engine.tick();
    const ready = await engine.next(batch.id, batch.runId);
    expect(ready.items[0]?.source?.contentHash).toBe("v2");
  });

  it("reconciles canonical blockers even when a separately cited claim remains unchanged", async () => {
    source();
    for (const id of ["blocker", "dependent"]) {
      createOpenLoop(
        db,
        {
          id,
          createdByRun: "fixture",
          title: id,
          description: "Workshop planning",
          confidence: 0.9,
          importance: 0.5,
          docs: ["input"],
          blockedBy: id === "dependent" ? ["blocker"] : [],
        },
        now,
      );
      convertKnowledgeOwner(db, "loop", id, now);
    }
    const blocker = getKnowledgeNode(db, "blocker")!;
    const parentInput = {
      id: blocker.id,
      ownerId: blocker.ownerId!,
      kind: "loop" as const,
      title: blocker.title,
      markdown: '<claim id="stable" refs="source:input">The workshop begins Friday.</claim>',
      inputVersions: { "source:input": "v1" },
    };
    saveKnowledgeNode(db, { ...parentInput, expectedRevision: blocker.revision }, now);
    const ref = "loop:blocker#claim:stable";
    const unchangedClaimVersion = service.reference(ref).revision;
    const dependent = getKnowledgeNode(db, "dependent")!;
    saveKnowledgeNode(
      db,
      {
        id: dependent.id,
        ownerId: dependent.ownerId!,
        kind: "loop",
        title: dependent.title,
        markdown: `<claim id="timing" refs="${ref}">The workshop begins Friday.</claim>`,
        inputVersions: { [ref]: unchangedClaimVersion },
        expectedRevision: dependent.revision,
      },
      now,
    );
    db.exec("DELETE FROM knowledge_changes");
    updateOpenLoop(db, "blocker", { state: "done" }, now);
    saveKnowledgeNode(
      db,
      {
        ...parentInput,
        expectedRevision: getKnowledgeNode(db, "blocker")!.revision,
        canonicalFields: { ...getKnowledgeNode(db, "blocker")!.canonicalFields, state: "done" },
      },
      now,
    );
    expect(service.reference(ref).revision).toBe(unchangedClaimVersion);
    expect(getKnowledgeNode(db, "dependent")!.validity).toBe("current");
    await engine.tick();
    expect(
      db.prepare("SELECT subject_id,reason FROM knowledge_work WHERE subject_id='dependent'").get(),
    ).toEqual({ subject_id: "dependent", reason: "change" });
  });

  it("reviews a surviving loop after its blocker is deleted without declaring it unblocked", async () => {
    source("blocker-evidence");
    source("dependent-evidence");
    for (const id of ["blocker", "dependent"]) {
      createOpenLoop(
        db,
        {
          id,
          createdByRun: "fixture",
          title: id,
          description: "Workshop planning",
          confidence: 0.9,
          importance: 0.5,
          docs: [`${id}-evidence`],
          blockedBy: id === "dependent" ? ["blocker"] : [],
        },
        now,
      );
      convertKnowledgeOwner(db, "loop", id, now);
    }
    db.exec("DELETE FROM knowledge_changes");
    purgeKnowledgeNode(db, "blocker", now);
    expect(getKnowledgeNode(db, "blocker")).toBeNull();
    expect(getKnowledgeNode(db, "dependent")!.canonicalFields.blockedBy).toEqual(["blocker"]);
    await engine.tick();
    expect(
      db.prepare("SELECT subject_id,reason FROM knowledge_work WHERE subject_id='dependent'").get(),
    ).toEqual({ subject_id: "dependent", reason: "change" });
    expect(getKnowledgeNode(db, "dependent")!.canonicalFields).toMatchObject({
      blockedBy: ["blocker"],
      state: "open",
    });
    expect(
      db.prepare("SELECT 1 FROM knowledge_work WHERE subject_id='blocker'").get(),
    ).toBeUndefined();
  });

  it("pages high fanout intake durably without acknowledging unadmitted dependents", async () => {
    source();
    await wiki("parent");
    for (let n = 0; n < 5; n++) await wiki(`child-${n}`, "wiki:parent#claim:fact");
    db.prepare("DELETE FROM knowledge_changes").run();
    const parent = getKnowledgeNode(db, "parent")!;
    await service.save({
      id: "parent",
      kind: "wiki",
      title: "parent",
      markdown: '<claim id="fact" refs="source:input">The workshop begins Saturday.</claim>',
      expectedRevision: parent.revision,
      inputVersions: { "source:input": "v1" },
    });
    settings = { ...settings, knowledge: { ...settings.knowledge, discoveryBatchSize: 2 } };
    // Saving the parent synchronously invalidates children and journals those
    // invalidations before its own node_changed event. Each tick admits only two
    // journal entries, so first drain those bookkeeping events, without assuming
    // the parent change is at the head of the queue.
    for (let tick = 0; tick < 4; tick++) {
      expect(await engine.tick()).toMatchObject({ cascading: false });
      if (db.prepare("SELECT 1 FROM knowledge_work WHERE subject_id LIKE 'child-%'").get()) break;
    }
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM knowledge_work WHERE subject_id LIKE 'child-%'").get(),
    ).toEqual({ n: 2 });
    expect(
      db.prepare("SELECT 1 FROM knowledge_changes WHERE entity_id='parent'").get(),
    ).toBeDefined();
    await engine.tick();
    await engine.tick();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM knowledge_work WHERE subject_id LIKE 'child-%'").get(),
    ).toEqual({ n: 5 });
    expect(
      db.prepare("SELECT 1 FROM knowledge_changes WHERE entity_id='parent'").get(),
    ).toBeUndefined();
  });

  it("presents bounded source chunks without losing shared batch work", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `chunk-${i}`);
    for (const id of ids) source(id);
    const refs = ids.map((id) => `source:${id}`);
    await service.save({
      id: "shared-chunks",
      kind: "wiki",
      title: "Workshop",
      markdown: `<claim id="fact" refs="${refs.join(" ")}">The workshop begins Friday.</claim>`,
      expectedRevision: 0,
      inputVersions: Object.fromEntries(refs.map((ref) => [ref, service.reference(ref).revision])),
    });
    await engine.tick();
    const batch = batchFor(ids[0]!);
    expect(new Set(ids.map((id) => batchFor(id).id))).toEqual(new Set([batch.id]));
    const first = await engine.next(batch.id, batch.runId);
    expect(first.items.filter((item) => item.source)).toHaveLength(8);
    const completed = new Set<string>();
    for (const item of first.items.filter((item) => item.source)) {
      await engine.completeSource(batch.id, batch.runId, item.id, item.inputFingerprint);
      completed.add(item.id);
    }
    const next = await engine.next(batch.id, batch.runId);
    const remaining = next.items.filter((item) => item.source);
    expect(remaining).toHaveLength(2);
    for (const item of remaining) expect(completed.has(item.id)).toBe(false);
    expect(new Set([...completed, ...remaining.map((item) => item.id)])).toEqual(new Set(refs));
  });

  it("coalesces queued future evidence sharing a downstream page with urgent evidence", async () => {
    source("a");
    source("b");
    await wiki("shared", "source:a");
    const prior = getKnowledgeNode(db, "shared")!;
    await service.save({
      id: "shared",
      kind: "wiki",
      title: "shared",
      markdown: '<claim id="fact" refs="source:a source:b">The workshop begins Friday.</claim>',
      expectedRevision: prior.revision,
      inputVersions: { "source:a": "v1", "source:b": "v1" },
    });
    await engine.deps.writeGate["knowledge.enqueue"](
      {
        id: "future",
        subjectId: "b",
        subjectKind: "source",
        reason: "change",
        inputRevision: "v1",
        tier: "routine",
        dueAt: now + settings.knowledge.routineDelayMs,
      },
      now,
    );
    await engine.tick();
    expect(batchFor("a").id).toBe(batchFor("b").id);
  });

  it("replaces a stale offered input version before allowing completion", async () => {
    source();
    await engine.tick();
    const batch = batchFor("input");
    const first = (await engine.next(batch.id, batch.runId)).items[0]!;
    source("input", "v2", "The workshop begins Saturday.");
    await expect(
      engine.completeSource(batch.id, batch.runId, first.id, first.inputFingerprint),
    ).rejects.toThrow("inputs changed");
    const second = (await engine.next(batch.id, batch.runId)).items[0]!;
    expect(second.inputFingerprint).not.toBe(first.inputFingerprint);
    expect(second.source!.contentHash).toBe("v2");
    await engine.completeSource(batch.id, batch.runId, second.id, second.inputFingerprint);
    expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
    expect(
      db
        .prepare(
          "SELECT DISTINCT input_revision FROM knowledge_discovery_coverage WHERE subject_id='input'",
        )
        .all(),
    ).toEqual([{ input_revision: second.source!.sourceRevision }]);
  });

  it.each([0.1, 0.5, 0.9])(
    "judges complete long sources before offering paid work (score %s)",
    async (verdict) => {
      const content =
        "Fictional observatory instrument notes. ".repeat(1500) +
        "Final observation: lens replacement requested.";
      expect(content.length).toBeGreaterThan(50_000);
      source("long-complete", "v1", content);
      await engine.tick();
      score = verdict;
      decisionStates = [];
      const batch = batchFor("long-complete");
      const frontier = await engine.next(batch.id, batch.runId);
      expect(decisionStates).toContainEqual(
        expect.objectContaining({ source: expect.objectContaining({ content }) }),
      );
      if (verdict < 0.25) {
        expect(frontier.items).toEqual([]);
        expect(frontier.done).toBe(true);
        expect(
          db
            .prepare(
              "SELECT status FROM knowledge_discovery_coverage WHERE subject_id='long-complete' AND phase='interpretation'",
            )
            .get(),
        ).toEqual({ status: "gated" });
      } else expect(frontier.items[0]?.id).toBe("source:long-complete");
    },
  );

  it("admits over-budget sources with a durable explicit unpaid bypass", async () => {
    createKnowledgeDecisionTable(db);
    source("oversized", "v1", "界".repeat(50_000));
    await engine.tick();
    engine.deps.decisions.record = async (entry) =>
      recordKnowledgeDecision(db, { ...entry, id: "oversized-decision" }, now);
    const before = decisions;
    const batch = batchFor("oversized");
    const frontier = await engine.next(batch.id, batch.runId);
    expect(frontier.items[0]?.id).toBe("source:oversized");
    expect(decisions).toBe(before);
    const saved = db
      .prepare(
        "SELECT score,input_tokens,bypass_json FROM knowledge_decisions WHERE id='oversized-decision'",
      )
      .get() as { score: null; input_tokens: number; bypass_json: string };
    expect(saved.score).toBeNull();
    expect(saved.input_tokens).toBe(0);
    expect(JSON.parse(saved.bypass_json)).toMatchObject({
      reason: "request_budget_exceeded",
      budgetBytes: 131072,
    });
  });

  it("sends source discovery its complete evidence once without sibling bodies or opaque versions", async () => {
    createKnowledgeDecisionTable(db);
    source("focused", "opaque-v1", "Unique meaningful content to inspect.");
    source("sibling", "opaque-v2", "Unrelated sibling content.");
    await engine.tick();
    const record = vi.fn();
    engine.deps.decisions.record = record;
    const before = decisionStates.length;
    const batch = batchFor("focused");
    await engine.next(batch.id, batch.runId);
    const state = decisionStates
      .slice(before)
      .find((state) => (state as { source?: { title: string } }).source?.title === "focused");
    expect(state).toEqual({
      source: {
        title: "focused",
        content: "Unique meaningful content to inspect.",
        sourceCreatedAt: new Date(now).toISOString(),
        sourceUpdatedAt: new Date(now).toISOString(),
      },
    });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "discovery",
        runId: batch.runId,
        batchId: batch.id,
        nodeId: "source:focused",
        threshold: 0.25,
        payloadCapture: expect.objectContaining({ subjects: [{ kind: "source", id: "focused" }] }),
        payload: expect.objectContaining({
          requestJson: expect.any(String),
          responseJson: expect.any(String),
          error: null,
        }),
      }),
    );
    const serialized = JSON.stringify(state);
    expect(serialized.split("Unique meaningful content to inspect.")).toHaveLength(2);
    expect(serialized).not.toContain("Unrelated sibling content");
    expect(serialized).not.toContain("opaque-v1");
  });

  it.each(["oversize", "uncertain", "candidate", "saturated-candidates", "linked", "target"])(
    "offers %s sources instead of discarding their context",
    async (mode) => {
      source(
        "protected",
        "v1",
        mode === "oversize"
          ? "Routine status. ".repeat(10000) + "A new commitment follows."
          : "A potentially useful note.",
      );
      if (mode === "candidate")
        proposeKnowledgeCandidate(
          db,
          {
            id: "protected-candidate",
            identityKey: "protected-context",
            title: "Protected context",
            scope: "An unresolved synthesis decision",
            evidenceVersions: { protected: "v1" },
          },
          now,
        );
      if (mode === "saturated-candidates") {
        for (let i = 0; i < 129; i++)
          proposeKnowledgeCandidate(
            db,
            {
              id: `bounded-candidate-${i}`,
              identityKey: `bounded-${i}`,
              title: "Bounded context",
              scope: "A previous proposal",
              evidenceVersions: { protected: "v1" },
            },
            now,
          );
        db.exec("UPDATE knowledge_candidates SET status='dismissed'");
      }
      if (mode === "linked")
        await wiki("connected", "source:protected", "A potentially useful note.");
      if (mode === "target") {
        source("other");
        await wiki("selected", "source:other");
        db.prepare(
          "INSERT INTO knowledge_discovery_targets(source_id,source_revision,node_id,created_at) VALUES('protected','v1','selected',?)",
        ).run(now);
      }
      await engine.tick();
      score = mode === "uncertain" ? 0.5 : 0;
      const before = decisionStates.length;
      const batch = batchFor("protected");
      const view = await engine.next(batch.id, batch.runId);
      expect(view.items.some((item) => item.id === "source:protected")).toBe(true);
      expect(
        db.prepare("SELECT 1 FROM knowledge_discovery_coverage WHERE subject_id='protected'").get(),
      ).toBeUndefined();
      const sourceJudgements = decisionStates
        .slice(before)
        .filter((state) => (state as { source?: { title: string } }).source?.title === "protected");
      expect(sourceJudgements).toHaveLength(mode === "uncertain" ? 1 : 0);
    },
  );

  it("rechecks connections atomically when a low-value judgement reaches the writer", async () => {
    source();
    await engine.tick();
    score = 0;
    const settle = writeGate["knowledge.settleFrontier"];
    vi.spyOn(writeGate, "knowledge.settleFrontier").mockImplementationOnce(async (input, at) => {
      proposeKnowledgeCandidate(
        db,
        {
          id: "racing-candidate",
          identityKey: "racing-context",
          title: "New context",
          scope: "A pending interpretation",
          evidenceVersions: { input: "v1" },
        },
        now,
      );
      return settle(input, at);
    });
    const batch = batchFor("input");
    await expect(engine.next(batch.id, batch.runId)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    expect(
      db.prepare("SELECT 1 FROM knowledge_discovery_coverage WHERE subject_id='input'").get(),
    ).toBeUndefined();
    expect((await engine.next(batch.id, batch.runId)).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "source:input" })]),
    );
  });

  it("gates irrelevant discovery without creating false synthesis or losing coverage", async () => {
    source();
    await engine.tick();
    score = 0.1;
    const batch = batchFor("input");
    expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
    expect(listKnowledgeFrontier(db, batch.id).map((row) => row.status)).toEqual(["skipped"]);
    expect(
      db.prepare("SELECT status FROM knowledge_discovery_coverage WHERE subject_id='input'").all(),
    ).toEqual([{ status: "gated" }, { status: "gated" }]);
    expect(db.prepare("SELECT 1 FROM knowledge_nodes WHERE kind='wiki'").get()).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT DISTINCT reconsider_at FROM knowledge_discovery_coverage WHERE subject_id='input'",
        )
        .all(),
    ).toEqual([{ reconsider_at: now + settings.knowledge.maxReviewIntervalMs }]);
    now += settings.knowledge.maxReviewIntervalMs + 1;
    await engine.tick();
    const revisit = batchFor("input");
    expect((await engine.next(revisit.id, revisit.runId)).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "source:input", review: true })]),
    );
  });

  it("jointly organizes considered disjoint sources and requires a versioned final disposition", async () => {
    for (const id of ["cohort-a", "cohort-b"]) {
      source(id);
      recordKnowledgeCoverage(
        db,
        {
          subjectId: id,
          inputRevision: "v1",
          phase: "organization",
          policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
          status: "considered",
        },
        now,
      );
    }
    db.exec("DELETE FROM knowledge_changes");
    await engine.tick();
    const batch = batchFor("cohort-a");
    expect(batchFor("cohort-b").id).toBe(batch.id);
    const view = await engine.next(batch.id, batch.runId);
    expect(view.organization?.sourceIds).toEqual(["cohort-a", "cohort-b"]);
    const completion = {
      id: view.organization!.id,
      batchId: batch.id,
      runId: batch.runId,
      inputFingerprint: view.organization!.inputFingerprint,
      outcome: "no_page" as const,
      reasonCode: "insufficient_shared_context" as const,
      retryAt: now + settings.knowledge.maxReviewIntervalMs,
    };
    await expect(
      directKnowledgeGate(db)["knowledge.completeOrganization"](completion, now),
    ).rejects.toMatchObject({ code: "claim_invalid" });
    for (const item of view.items)
      await engine.completeSource(batch.id, batch.runId, item.id, item.inputFingerprint);
    const ready = await engine.next(batch.id, batch.runId);
    expect(ready).toMatchObject({ done: false, organization: { readyToComplete: true } });
    await directKnowledgeGate(db)["knowledge.completeOrganization"](completion, now);
    expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_dependencies").get()).toEqual({ n: 0 });
    now += settings.knowledge.routineDelayMs;
    await engine.tick();
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_organization_cohorts").get()).toEqual({
      n: 1,
    });
  });

  it("advances initial joint review backlog before the routine repeat delay", async () => {
    for (let i = 0; i < 10; i++) {
      const id = `joint-backlog-${i}`;
      source(id);
      recordKnowledgeCoverage(
        db,
        {
          subjectId: id,
          inputRevision: "v1",
          phase: "organization",
          policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
          status: "considered",
        },
        now,
      );
    }
    db.exec("DELETE FROM knowledge_changes");
    const startedAt = now;
    for (const [index, expectedSize] of [8, 2].entries()) {
      await engine.tick();
      const batch = batchFor(`joint-backlog-${index * 8}`);
      let view = await engine.next(batch.id, batch.runId);
      expect(view.organization?.sourceIds).toHaveLength(expectedSize);
      for (const item of view.items)
        await engine.completeSource(batch.id, batch.runId, item.id, item.inputFingerprint);
      view = await engine.next(batch.id, batch.runId);
      expect(view.organization?.readyToComplete).toBe(true);
      await directKnowledgeGate(db)["knowledge.completeOrganization"](
        {
          id: view.organization!.id,
          batchId: batch.id,
          runId: batch.runId,
          inputFingerprint: view.organization!.inputFingerprint,
          outcome: "no_page",
          reasonCode: "insufficient_shared_context",
          retryAt: now + settings.knowledge.maxReviewIntervalMs,
        },
        now,
      );
      expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
      now += 60000;
    }
    expect(now - startedAt).toBeLessThan(settings.knowledge.routineDelayMs);
    await engine.tick();
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_organization_cohorts").get()).toEqual({
      n: 2,
    });
  });

  it("interrupts a joint organization snapshot when its evidence changes without completing coverage", async () => {
    for (const id of ["cohort-a", "cohort-b"]) {
      source(id);
      recordKnowledgeCoverage(
        db,
        {
          subjectId: id,
          inputRevision: "v1",
          phase: "organization",
          policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
          status: "considered",
        },
        now,
      );
    }
    db.exec("DELETE FROM knowledge_changes");
    await engine.tick();
    const batch = batchFor("cohort-a");
    await engine.next(batch.id, batch.runId);
    source("cohort-a", "v2", "A changed fixture note.");
    expect(await engine.next(batch.id, batch.runId)).toMatchObject({
      done: true,
      interrupted: true,
    });
    expect(
      db.prepare("SELECT status,outcome_json AS outcome FROM knowledge_organization_cohorts").get(),
    ).toMatchObject({ status: "abandoned", outcome: null });
  });

  it("does not silently finish a pending organization run after privacy cleanup erases its cohort", async () => {
    for (const id of ["cohort-a", "cohort-b"]) {
      source(id);
      recordKnowledgeCoverage(
        db,
        {
          subjectId: id,
          inputRevision: "v1",
          phase: "organization",
          policyVersion: KNOWLEDGE_DISCOVERY_POLICY,
          status: "considered",
        },
        now,
      );
    }
    db.exec("DELETE FROM knowledge_changes");
    await engine.tick();
    const batch = batchFor("cohort-a");
    const offered = await engine.next(batch.id, batch.runId);
    for (const item of offered.items)
      await engine.completeSource(batch.id, batch.runId, item.id, item.inputFingerprint);
    const cascade = engine.deps.writeGate["knowledge.advanceCascade"];
    vi.spyOn(engine.deps.writeGate, "knowledge.advanceCascade").mockImplementationOnce(
      async (...args) => {
        const result = await cascade(...args);
        // Privacy cleanup can run after the frontier's initial snapshot check.
        db.prepare("DELETE FROM knowledge_organization_cohorts WHERE batch_id=?").run(batch.id);
        return result;
      },
    );
    expect(await engine.next(batch.id, batch.runId)).toMatchObject({
      done: true,
      interrupted: true,
    });
    expect(db.prepare("SELECT status FROM knowledge_batches WHERE id=?").get(batch.id)).toEqual({
      status: "abandoned",
    });
  });

  it("coalesces newly published wiki orientation at the configured soon tier", async () => {
    settings.knowledge.soonDelayMs = 120000;
    const savePage = (id: string, kind: "root" | "wiki", revision = 0) =>
      saveKnowledgeNode(
        db,
        {
          id,
          kind,
          title: id,
          markdown: `Planning context revision ${revision + 1}.`,
          expectedRevision: revision,
          inputVersions: {},
        },
        now,
      );
    savePage("overview", "root");
    savePage("project", "wiki");
    // Intake must recognize publication even if another edit already landed.
    savePage("project", "wiki", 1);
    const publishedAt = now;
    await engine.tick();
    const pending = () =>
      db
        .prepare(
          "SELECT tier,due_at FROM knowledge_work WHERE subject_id='overview' AND reason='root' AND status='pending'",
        )
        .all();
    expect(pending()).toEqual([{ tier: "soon", due_at: publishedAt + 120000 }]);
    now += 1000;
    savePage("another-project", "wiki");
    await engine.tick();
    expect(pending()).toEqual([{ tier: "soon", due_at: publishedAt + 120000 }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_batches").get()).toEqual({ n: 0 });
  });

  it("ordinary wiki edits retain routine root orientation scheduling", async () => {
    saveKnowledgeNode(
      db,
      {
        id: "overview",
        kind: "root",
        title: "Overview",
        markdown: "Earlier context.",
        expectedRevision: 0,
        inputVersions: {},
      },
      now,
    );
    saveKnowledgeNode(
      db,
      {
        id: "project",
        kind: "wiki",
        title: "Project",
        markdown: "Earlier planning context.",
        expectedRevision: 0,
        inputVersions: {},
      },
      now,
    );
    await engine.tick();
    // Settle the already-enqueued publication obligation before a later edit.
    db.exec("UPDATE knowledge_work SET status='completed' WHERE subject_id='overview'");
    saveKnowledgeNode(
      db,
      {
        id: "project",
        kind: "wiki",
        title: "Project",
        markdown: "Revised planning context.",
        expectedRevision: 1,
        inputVersions: {},
      },
      now,
    );
    await engine.tick();
    expect(
      db
        .prepare(
          "SELECT tier,due_at FROM knowledge_work WHERE subject_id='overview' AND reason='root' AND status='pending'",
        )
        .all(),
    ).toEqual([{ tier: "routine", due_at: now + settings.knowledge.routineDelayMs }]);
  });

  it("fails open when root orientation has truncated prose", async () => {
    saveKnowledgeNode(
      db,
      {
        id: "root-existing",
        kind: "root",
        title: "Current context",
        markdown: "Earlier context.",
        expectedRevision: 0,
        inputVersions: {},
      },
      now,
    );
    source();
    await wiki("long-context", "source:input", "A fictional contextual sentence. ".repeat(80));
    await engine.tick();
    now += settings.knowledge.routineDelayMs;
    await engine.tick();
    const batch = batchFor("root-existing");
    score = 0;
    const before = decisions;
    const view = await engine.next(batch.id, batch.runId);
    expect(view.items[0]).toMatchObject({
      node: { kind: "root" },
      maintenanceGoal: "root_orientation",
      review: false,
    });
    expect(decisions).toBe(before);
  });

  it("supplies readable synthesis context to a populated root impact decision", async () => {
    createKnowledgeDecisionTable(db);
    saveKnowledgeNode(
      db,
      {
        id: "root-existing",
        kind: "root",
        title: "Current context",
        markdown: "Earlier context.",
        expectedRevision: 0,
        inputVersions: {},
      },
      now,
    );
    source();
    await wiki();
    await engine.tick();
    now += settings.knowledge.routineDelayMs;
    await engine.tick();
    const batch = batchFor("root-existing");
    const record = vi.fn();
    engine.deps.decisions.record = record;
    await engine.next(batch.id, batch.runId);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "impact",
        runId: batch.runId,
        batchId: batch.id,
        nodeId: "root-existing",
        threshold: 0.25,
        payloadCapture: expect.objectContaining({
          subjects: expect.arrayContaining([
            { kind: "node", id: "root-existing" },
            { kind: "node", id: "project" },
            { kind: "source", id: "input" },
          ]),
        }),
        payload: expect.objectContaining({
          requestJson: expect.any(String),
          responseJson: expect.any(String),
          error: null,
        }),
      }),
    );
    expect(decisionStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: expect.objectContaining({ kind: "root" }),
          orientation: expect.arrayContaining([
            expect.objectContaining({ id: "project", plainText: "The workshop begins Friday." }),
          ]),
        }),
      ]),
    );
  });

  it("keeps the root in a separate run and offers bounded orientation", async () => {
    source();
    await wiki();
    await engine.tick();
    const root = db
      .prepare<[], { id: string }>("SELECT id FROM knowledge_nodes WHERE kind='root'")
      .get()!;
    const batch = batchFor(root.id);
    expect(batch.id).not.toBe(batchFor("input").id);
    // Initial orientation is deliberate work, even with a low impact verdict.
    score = 0;
    const before = decisions;
    const view = await engine.next(batch.id, batch.runId);
    expect(decisions).toBe(before);
    expect(
      JSON.parse(
        db
          .prepare<
            [string],
            { payload_json: string }
          >("SELECT payload_json FROM cognition_runs WHERE id=?")
          .get(batch.runId)!.payload_json,
      ),
    ).toMatchObject({ schedulingClass: "initial-root" });
    // Existing pending batches from before the scheduling class are upgraded.
    db.prepare(
      "UPDATE cognition_runs SET payload_json=json_remove(payload_json,'$.schedulingClass') WHERE id=?",
    ).run(batch.runId);
    await directKnowledgeGate(db)["knowledge.classifyInitialRootBatches"](root.id);
    expect(
      JSON.parse(
        db
          .prepare<
            [string],
            { payload_json: string }
          >("SELECT payload_json FROM cognition_runs WHERE id=?")
          .get(batch.runId)!.payload_json,
      ),
    ).toMatchObject({ schedulingClass: "initial-root" });
    expect(view.items[0]!.maintenanceGoal).toBe("root_orientation");
    expect(view.items[0]!.orientation?.map((node) => node.id)).toContain("project");
    expect(view.items[0]!.node!.plainText).toBe("");
    const compact = fitKnowledgeFrontierItem(
      {
        ...view.items[0]!,
        node: { ...view.items[0]!.node!, markdown: "Long orientation. ".repeat(1000) },
      },
      1800,
      true,
    );
    expect(compact).toMatchObject({
      maintenanceGoal: "root_orientation",
      fetchRequired: { kind: "root" },
    });
    expect(compact?.node).toBeUndefined();
  });

  it("keeps independent project repairs separate and coordinates their new claim versions in the root", async () => {
    service.deps.getEntailmentVerifier = async () => ({
      verify: async () => ({ label: "entailment", probability: 1 }),
      dispose() {},
    });
    source("source-a", "a-v1", "The ceramics session is on Monday.");
    source("source-b", "b-v1", "The astronomy session is on Tuesday.");
    await wiki("project-a", "source:source-a", "The ceramics session is on Monday.");
    await wiki("project-b", "source:source-b", "The astronomy session is on Tuesday.");
    const rootRefs = ["wiki:project-a#claim:fact", "wiki:project-b#claim:fact"];
    const originalVersions = Object.fromEntries(
      rootRefs.map((ref) => [ref, service.reference(ref).revision]),
    );
    await service.save({
      id: "overview",
      kind: "root",
      title: "Current projects",
      markdown:
        '<claim id="ceramics" refs="wiki:project-a#claim:fact">The [ceramics session](wiki:project-a) is on Monday.</claim>\n<claim id="astronomy" refs="wiki:project-b#claim:fact">The [astronomy session](wiki:project-b) is on Tuesday.</claim>',
      expectedRevision: 0,
      inputVersions: originalVersions,
    });
    // Only the two revised sources drive this maintenance cycle.
    db.prepare("DELETE FROM knowledge_changes").run();
    now++;
    source("source-a", "a-v2", "The ceramics session is on Thursday.");
    source("source-b", "b-v2", "The astronomy session is on Saturday.");
    await engine.tick();
    const a = batchFor("source-a"),
      b = batchFor("source-b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.id).not.toBe(b.id);
    for (const [batch, own, other] of [
      [a, "project-a", "project-b"],
      [b, "project-b", "project-a"],
    ] as const) {
      const region = db
        .prepare<[string], { node_id: string }>(
          "SELECT node_id FROM knowledge_batch_regions WHERE batch_id=?",
        )
        .all(batch.id)
        .map((row) => row.node_id);
      expect(region).toContain(own);
      expect(region).not.toContain(other);
      expect(region).not.toContain("overview");
    }
    for (const [batch, project, sourceId, hash, text] of [
      [a, "project-a", "source-a", "a-v2", "The ceramics session is on Thursday."],
      [b, "project-b", "source-b", "b-v2", "The astronomy session is on Saturday."],
    ] as const) {
      const evidence = (await engine.next(batch.id, batch.runId)).items.find(
        (item) => item.id === `source:${sourceId}`,
      )!;
      expect(evidence.source?.contentHash).toBe(hash);
      await engine.completeSource(batch.id, batch.runId, evidence.id, evidence.inputFingerprint);
      const repair = (await engine.next(batch.id, batch.runId)).items.find(
        (item) => item.id === project,
      )!;
      expect(repair.pendingClaimIds).toEqual(["fact"]);
      await engine.saveNode(
        batch.id,
        batch.runId,
        project,
        repair.inputFingerprint,
        {
          id: project,
          kind: "wiki",
          title: project,
          markdown: `<claim id="fact" refs="source:${sourceId}">${text}</claim>`,
          expectedRevision: repair.node!.revision,
          inputVersions: { [`source:${sourceId}`]: evidence.source!.sourceRevision },
        },
        repair.pendingClaimIds,
      );
      expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
    }
    await engine.tick();
    expect(batchFor("overview")).toBeUndefined();
    const scheduledRoot = db
      .prepare<
        [],
        { due_at: number }
      >("SELECT due_at FROM knowledge_work WHERE subject_id='overview' AND status='pending' AND reason='root'")
      .get()!;
    expect(scheduledRoot.due_at).toBe(now + settings.knowledge.routineDelayMs);
    now = scheduledRoot.due_at;
    await engine.tick();
    const rootBatch = batchFor("overview");
    expect(rootBatch).toBeDefined();
    expect([a.id, b.id]).not.toContain(rootBatch.id);
    const root = (await engine.next(rootBatch.id, rootBatch.runId)).items.find(
      (item) => item.id === "overview",
    )!;
    expect(root.orientation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "project-a",
          plainText: "The ceramics session is on Thursday.",
        }),
        expect.objectContaining({
          id: "project-b",
          plainText: "The astronomy session is on Saturday.",
        }),
      ]),
    );
    expect([...root.pendingClaimIds!].sort()).toEqual(["astronomy", "ceramics"]);
    const versions = Object.fromEntries(
      rootRefs.map((ref) => [ref, service.reference(ref).revision]),
    );
    for (const ref of rootRefs) {
      // Claim meaning versions identify the page revision that changed that claim;
      // intervening invalidation edits need not produce contiguous claim versions.
      expect(versions[ref]).toBeGreaterThan(originalVersions[ref] as number);
      expect(root.inputVersions[ref]).toBe(versions[ref]);
    }
    await engine.saveNode(
      rootBatch.id,
      rootBatch.runId,
      "overview",
      root.inputFingerprint,
      {
        id: "overview",
        kind: "root",
        title: "Current projects",
        markdown:
          '<claim id="ceramics" refs="wiki:project-a#claim:fact">The [ceramics session](wiki:project-a) is on Thursday.</claim>\n<claim id="astronomy" refs="wiki:project-b#claim:fact">The [astronomy session](wiki:project-b) is on Saturday.</claim>',
        expectedRevision: root.node!.revision,
        inputVersions: versions,
      },
      root.pendingClaimIds,
    );
    expect((await engine.next(rootBatch.id, rootBatch.runId)).done).toBe(true);
    expect(getKnowledgeNode(db, "overview")?.validity).toBe("current");
    expect(service.reference("wiki:overview#claim:ceramics").verified).toBe(true);
    expect(service.reference("wiki:overview#claim:astronomy").verified).toBe(true);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM knowledge_batches WHERE id IN (?,?,?) AND status='completed'",
        )
        .get(a.id, b.id, rootBatch.id),
    ).toEqual({ n: 3 });
    // The completed repairs make both sources eligible for a separate joint
    // organization pass. It must not be confused with either project repair.
    const pending = db
      .prepare<[], { id: string; cohortId: string | null }>(
        `SELECT b.id,c.id AS cohortId FROM knowledge_batches b
      LEFT JOIN knowledge_organization_cohorts c ON c.batch_id=b.id
      WHERE b.status IN ('pending','running')`,
      )
      .all();
    expect(pending).toEqual([{ id: expect.any(String), cohortId: expect.any(String) }]);
    expect([a.id, b.id, rootBatch.id]).not.toContain(pending[0]!.id);
    expect(
      db
        .prepare(
          "SELECT source_id AS id,content_hash AS revision FROM knowledge_organization_members WHERE cohort_id=? ORDER BY source_id",
        )
        .all(pending[0]!.cohortId),
    ).toEqual([
      { id: "source-a", revision: "a-v2:knowledge:1" },
      { id: "source-b", revision: "b-v2:knowledge:1" },
    ]);
  });

  it("discovers new evidence for an existing page without requiring a pre-existing edge", async () => {
    source("original");
    await wiki("project", "source:original");
    // Existing canonical context is the setup; only the new arrival drives this run.
    db.prepare("DELETE FROM knowledge_changes").run();
    source("new-evidence", "v1", "The workshop now begins Saturday.");
    await engine.tick();
    const batch = batchFor("new-evidence");
    const first = (await engine.next(batch.id, batch.runId)).items[0]!;
    await engine.completeSource(
      batch.id,
      batch.runId,
      first.id,
      first.inputFingerprint,
      false,
      undefined,
      ["project"],
    );
    const repair = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "project",
    )!;
    expect(repair).toBeDefined();
    expect(repair.inputVersions["source:new-evidence"]).toBe("v1");
    // A successor has no predecessor transcript, but retains its batch inputs.
    const successorRunId = "continuation-run";
    db.prepare("UPDATE knowledge_batches SET run_id=? WHERE id=?").run(successorRunId, batch.id);
    expect(() => engine.maintenanceInputs(batch.id, batch.runId, "project")).toThrow(/owned/);
    batch.runId = successorRunId;
    const resumed = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "project",
    )!;
    expect(resumed.inputVersions["source:new-evidence"]).toBe("v1");
    const collected: Record<string, string | number> = {};
    let after: string | undefined;
    do {
      const page = engine.maintenanceInputs(batch.id, batch.runId, "project", after, 1);
      expect(page.inputFingerprint).toBe(resumed.inputFingerprint);
      expect(Object.keys(page.inputVersions)).toHaveLength(1);
      Object.assign(collected, page.inputVersions);
      after = page.nextAfter;
    } while (after);
    expect(collected).toEqual(resumed.inputVersions);
    expect(() => engine.maintenanceInputs(batch.id, batch.runId, "unoffered")).toThrow(/offered/);
    expect(() => engine.maintenanceInputs(batch.id, batch.runId, "project", undefined, 33)).toThrow(
      /limit/,
    );
    await engine.saveNode(
      batch.id,
      batch.runId,
      repair.id,
      repair.inputFingerprint,
      {
        id: "project",
        kind: "wiki",
        title: "project",
        markdown:
          '<claim id="fact" refs="source:new-evidence">The workshop now begins Saturday.</claim>',
        expectedRevision: repair.node!.revision,
        inputVersions: { "source:new-evidence": "v1" },
      },
      repair.pendingClaimIds,
    );
    expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
    expect(getKnowledgeNode(db, "project")!.plainText).toContain("Saturday");
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM knowledge_nodes WHERE kind='wiki'").get(),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT source_revision,node_id FROM knowledge_discovery_targets WHERE source_id='new-evidence'",
        )
        .get(),
    ).toEqual({ source_revision: "v1", node_id: "project" });
  });

  it("materializes fresh owner targets and reviews their claims before completing discovery", async () => {
    source();
    await engine.tick();
    const batch = batchFor("input");
    const offered = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    createOpenLoop(
      db,
      {
        id: "fresh-loop",
        createdByRun: batch.runId,
        title: "Prepare the workshop",
        description: "The workshop begins Friday.",
        confidence: 0.8,
        importance: 0.5,
        docs: ["input"],
      },
      now,
    );
    expect(getKnowledgeNode(db, "fresh-loop")).toBeNull();
    await engine.completeSource(
      batch.id,
      batch.runId,
      offered.id,
      offered.inputFingerprint,
      false,
      ["interpretation", "organization", "conversion"],
      ["fresh-loop"],
    );
    expect(getKnowledgeNode(db, "fresh-loop")?.ownerId).toBe("fresh-loop");
    expect(listKnowledgeFrontier(db, batch.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "fresh-loop", status: "pending", depth: 1 }),
      ]),
    );
    // Explicit repair targets have already been selected by the synthesis agent;
    // a low impact score must not discard their initial claim-grounding pass.
    score = 0;
    const repair = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "fresh-loop",
    )!;
    expect(repair).toBeDefined();
    expect(repair.pendingClaimIds).toContain("legacy");
    await engine.saveNode(
      batch.id,
      batch.runId,
      repair.id,
      repair.inputFingerprint,
      {
        id: repair.id,
        ownerId: repair.id,
        kind: "loop",
        title: repair.node!.title,
        markdown: '<claim id="schedule" refs="source:input">The workshop begins Friday.</claim>',
        expectedRevision: repair.node!.revision,
        inputVersions: { "source:input": "v1" },
      },
      repair.pendingClaimIds,
    );
    expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
    expect(getKnowledgeNode(db, "fresh-loop")?.markdown).toContain('id="schedule"');
    expect(getKnowledgeNode(db, "fresh-loop")?.markdown).not.toContain('id="legacy"');
  });

  it("rolls back owner materialization and leaves source discovery offered when any target is unavailable", async () => {
    source();
    await engine.tick();
    const batch = batchFor("input");
    const offered = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    createOpenLoop(
      db,
      {
        id: "fresh-loop",
        createdByRun: batch.runId,
        title: "Prepare the workshop",
        confidence: 0.8,
        importance: 0.5,
        docs: ["input"],
      },
      now,
    );
    await expect(
      engine.completeSource(
        batch.id,
        batch.runId,
        offered.id,
        offered.inputFingerprint,
        false,
        ["interpretation", "organization", "conversion"],
        ["fresh-loop", "missing-owner"],
      ),
    ).rejects.toThrow("Discovery target is not available");
    expect(getKnowledgeNode(db, "fresh-loop")).toBeNull();
    expect(db.prepare("SELECT 1 FROM knowledge_discovery_targets").all()).toEqual([]);
    expect(
      db.prepare("SELECT 1 FROM knowledge_discovery_coverage WHERE subject_id='input'").all(),
    ).toEqual([]);
    expect(listKnowledgeFrontier(db, batch.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: offered.id, status: "offered" })]),
    );
  });

  it.each([
    ["doc_annotation", false],
    ["doc_annotation", true],
    ["person_annotation", false],
    ["person_annotation", true],
  ] as const)(
    "rejects inactive %s repair targets even before owner sync (materialized=%s)",
    async (kind, materialized) => {
      createAnnotationStorageTables(db);
      createPersonAnnotationStorageTables(db);
      source();
      await engine.tick();
      const batch = batchFor("input");
      const offered = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
      const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
      const subject = kind === "doc_annotation" ? "doc_id" : "person_id";
      db.prepare(
        `INSERT INTO ${table}(id,${subject},claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).run(
        "inactive-note",
        "input",
        "schedule",
        "The workshop begins Friday.",
        "input",
        "The workshop begins Friday.",
        0.7,
        batch.runId,
        now,
      );
      if (materialized) convertKnowledgeOwner(db, kind, "inactive-note", now);
      db.prepare(`UPDATE ${table} SET invalidated_at=? WHERE id='inactive-note'`).run(now);
      await expect(
        engine.completeSource(
          batch.id,
          batch.runId,
          offered.id,
          offered.inputFingerprint,
          false,
          undefined,
          ["inactive-note"],
        ),
      ).rejects.toThrow("annotation is inactive");
      expect(db.prepare("SELECT 1 FROM knowledge_discovery_targets").all()).toEqual([]);
      expect(
        db.prepare("SELECT 1 FROM knowledge_discovery_coverage WHERE subject_id='input'").all(),
      ).toEqual([]);
      expect(!!getKnowledgeNode(db, "inactive-note")).toBe(materialized);
      expect(listKnowledgeFrontier(db, batch.id)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: offered.id, status: "offered" }),
        ]),
      );
    },
  );

  it("promotes a queued full batch for overlapping urgent evidence without clearing backoff", async () => {
    settings.knowledge.maxSeeds = 1;
    source();
    await engine.tick();
    const batch = batchFor("input");
    db.prepare("UPDATE knowledge_batches SET tier='routine' WHERE id=?").run(batch.id);
    db.prepare("UPDATE cognition_runs SET next_attempt_at=? WHERE id=?").run(
      now + 60000,
      batch.runId,
    );
    const promotion = vi.spyOn(writeGate, "knowledge.promoteBlockingBatches");
    source("input", "v2");
    await engine.tick();
    expect(promotion).toHaveBeenCalledTimes(1);
    expect(promotion.mock.calls[0]![0].work).toEqual({
      id: expect.any(String),
      generation: expect.any(Number),
      inputRevision: service.reference("source:input").revision,
    });
    expect(Array.isArray(promotion.mock.calls[0]![0].work)).toBe(false);
    expect(db.prepare("SELECT tier FROM knowledge_batches WHERE id=?").get(batch.id)).toEqual({
      tier: "immediate",
    });
    expect(
      db.prepare("SELECT next_attempt_at FROM cognition_runs WHERE id=?").get(batch.runId),
    ).toEqual({ next_attempt_at: now + 60000 });
    expect(
      db
        .prepare("SELECT status FROM knowledge_work WHERE subject_id='input' AND input_revision=?")
        .get(service.reference("source:input").revision),
    ).toEqual({ status: "pending" });
  });

  it("requeues newly discovered overlap durably instead of racing an active region", async () => {
    source("new");
    source("known");
    await wiki("shared", "source:known");
    await engine.tick();
    const first = batchFor("new");
    const second = batchFor("known");
    expect(first.id).not.toBe(second.id);
    const offered = (await engine.next(first.id, first.runId)).items.find((item) => item.source)!;
    await engine.completeSource(
      first.id,
      first.runId,
      offered.id,
      offered.inputFingerprint,
      false,
      ["interpretation", "organization"],
      ["shared"],
    );
    expect(await engine.next(first.id, first.runId)).toMatchObject({
      done: true,
      interrupted: true,
    });
    expect(
      db.prepare("SELECT node_id FROM knowledge_discovery_targets WHERE source_id='new'").get(),
    ).toEqual({ node_id: "shared" });
    const next = await engine.next(second.id, second.runId);
    expect(next.items.map((item) => item.source?.id).sort()).toEqual(["known", "new"]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM knowledge_batches WHERE status IN ('pending','running') AND id IN (?,?)",
        )
        .get(first.id, second.id),
    ).toEqual({ n: 1 });
  });

  it("recovers a terminal agent run, releases reservations and preserves retry work", async () => {
    source();
    await engine.tick();
    const old = batchFor("input");
    db.prepare("UPDATE cognition_runs SET status='failed' WHERE id=?").run(old.runId);
    await engine.tick();
    expect(db.prepare("SELECT status FROM knowledge_batches WHERE id=?").get(old.id)).toEqual({
      status: "abandoned",
    });
    const pending = db
      .prepare(
        "SELECT input_revision,due_at FROM knowledge_work WHERE subject_id='input' AND status='pending'",
      )
      .get() as { input_revision: string; due_at: number };
    expect(pending).toMatchObject({
      input_revision: "v1",
      due_at: now + settings.knowledge.soonDelayMs,
    });
    expect(await engine.next(old.id, old.runId)).toMatchObject({ done: true, interrupted: true });
  });

  it("reviews an approaching checkpoint despite a distant model-proposed review date", async () => {
    createKnowledgeDecisionTable(db);
    const record = vi.fn();
    engine.deps.decisions.record = record;
    saveKnowledgeNode(
      db,
      {
        id: "checkpoint",
        kind: "wiki",
        title: "Workshop planning",
        markdown: "Planning context",
        expectedRevision: 0,
        inputVersions: {},
        metadata: { nextReviewAt: now + 100 * 86400000, checkpointAt: now + 1000 },
      },
      now,
    );
    score = 0.1;
    await engine.tick();
    expect(batchFor("checkpoint")).toBeDefined();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "review",
        nodeId: "checkpoint",
        payloadCapture: expect.objectContaining({ subjects: [{ kind: "node", id: "checkpoint" }] }),
        payload: expect.objectContaining({
          requestJson: expect.any(String),
          responseJson: expect.any(String),
          error: null,
        }),
      }),
    );
  });

  it("records unchanged verified reviews separately from entailment and consumes their deadline", async () => {
    source();
    const created = now - settings.knowledge.maxReviewIntervalMs - 1;
    saveKnowledgeNode(
      db,
      {
        id: "reviewed",
        kind: "wiki",
        title: "Workshop",
        markdown: '<claim id="fact" refs="source:input">The workshop begins Friday.</claim>',
        expectedRevision: 0,
        inputVersions: { "source:input": "v1" },
        metadata: { lastVerifiedAt: created, nextReviewAt: now - 1, checkpointAt: now + 1000 },
      },
      created,
    );
    // The trusted storage seam stands in for an already verified historical page.
    db.prepare(
      "UPDATE knowledge_claims SET verification='verified',verifier=? WHERE node_id='reviewed'",
    ).run(CONTEXTUAL_VERIFIER);
    db.exec("DELETE FROM knowledge_changes");
    await engine.tick();
    const batch = batchFor("reviewed");
    const offered = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "reviewed",
    )!;
    expect(offered).toMatchObject({
      maintenanceGoal: "wiki_curation",
      maintenanceTask: expect.stringContaining("Keep the page unchanged when it is already useful"),
    });
    await engine.saveNode(
      batch.id,
      batch.runId,
      offered.id,
      offered.inputFingerprint,
      {
        id: offered.id,
        kind: "wiki",
        title: offered.node!.title,
        markdown: offered.node!.markdown,
        expectedRevision: offered.node!.revision,
        inputVersions: { "source:input": "v1" },
      },
      offered.pendingClaimIds,
      {
        batchId: batch.id,
        runId: batch.runId,
        placementLibrary: { collection: "wiki", revision: 0 },
      },
      { status: "standalone", reason: "Self-contained workshop reference." },
    );
    await engine.next(batch.id, batch.runId);
    expect(getKnowledgeNode(db, "reviewed")!.metadata).toMatchObject({
      lastReviewedAt: now,
      lastVerifiedAt: created,
      nextReviewAt: null,
    });
    now += Math.max(60_000, settings.knowledge.soonDelayMs);
    await engine.tick();
    expect(batchFor("reviewed")).toBeUndefined();
  });

  it("backs off completed unverified reviews without resetting verification age", async () => {
    source();
    const markdown =
      '<claim id="unverified" refs="source:input">The workshop begins Friday.</claim>';
    saveKnowledgeNode(
      db,
      {
        id: "overdue",
        kind: "wiki",
        title: "Overdue context",
        markdown,
        expectedRevision: 0,
        inputVersions: { "source:input": "v1" },
      },
      now - settings.knowledge.maxReviewIntervalMs - 1,
    );
    db.prepare("DELETE FROM knowledge_changes").run();
    await engine.tick();
    const batch = batchFor("overdue");
    const offered = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "overdue",
    )!;
    await engine.saveNode(
      batch.id,
      batch.runId,
      offered.id,
      offered.inputFingerprint,
      {
        id: "overdue",
        kind: "wiki",
        title: "Overdue context",
        markdown,
        expectedRevision: offered.node!.revision,
        inputVersions: { "source:input": "v1" },
      },
      offered.pendingClaimIds,
      {
        batchId: batch.id,
        runId: batch.runId,
        placementLibrary: { collection: "wiki", revision: 0 },
      },
      { status: "standalone", reason: "Self-contained workshop reference." },
    );
    expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
    const verification = getKnowledgeNode(db, "overdue")!.metadata.lastVerifiedAt;
    await engine.tick();
    expect(batchFor("overdue")).toBeUndefined();
    expect(getKnowledgeNode(db, "overdue")!.metadata.lastVerifiedAt).toBe(verification);
    now += Math.max(60_000, settings.knowledge.soonDelayMs);
    await engine.tick();
    expect(batchFor("overdue")).toBeDefined();
  });

  it("does not return saved prose if privacy deletion lands while settlement yields", async () => {
    source();
    await wiki("project");
    await engine.tick();
    const batch = batchFor("input");
    const first = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    await engine.completeSource(batch.id, batch.runId, first.id, first.inputFingerprint);
    const offered = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "project",
    )!;
    const settle = engine.deps.writeGate["knowledge.settleFrontier"];
    vi.spyOn(engine.deps.writeGate, "knowledge.settleFrontier").mockImplementation(
      async (...args) => {
        const result = await settle(...args);
        purgeKnowledgeNode(db, "project", now);
        return result;
      },
    );
    await expect(
      engine.saveNode(
        batch.id,
        batch.runId,
        offered.id,
        offered.inputFingerprint,
        {
          id: "project",
          kind: "wiki",
          title: "project",
          markdown: '<claim id="fact" refs="source:input">The workshop begins Friday.</claim>',
          expectedRevision: offered.node!.revision,
          inputVersions: { "source:input": "v1" },
        },
        offered.pendingClaimIds,
      ),
    ).rejects.toMatchObject({ code: "reference_invalid" });
    expect(getKnowledgeNode(db, "project")).toBeNull();
  });

  it("rejects a synthesis write when its batch is abandoned during verification", async () => {
    source();
    await wiki("project");
    await engine.tick();
    const batch = batchFor("input");
    const first = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    await engine.completeSource(batch.id, batch.runId, first.id, first.inputFingerprint);
    const offered = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "project",
    )!;
    service.deps.getEntailmentVerifier = async () => {
      await engine.deps.writeGate["knowledge.abandonBatch"](
        { batchId: batch.id, notBefore: now },
        now,
      );
      return null;
    };
    await expect(
      engine.saveNode(
        batch.id,
        batch.runId,
        offered.id,
        offered.inputFingerprint,
        {
          id: "project",
          kind: "wiki",
          title: "project",
          markdown: '<claim id="fact" refs="source:input">A late write.</claim>',
          expectedRevision: offered.node!.revision,
          inputVersions: { "source:input": "v1" },
        },
        offered.pendingClaimIds,
      ),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(getKnowledgeNode(db, "project")!.revision).toBe(offered.node!.revision);
  });

  it("reserves the source frontier namespace from synthesis identities", async () => {
    await expect(
      service.save({
        id: "source:ambiguous",
        kind: "wiki",
        title: "Context",
        markdown: '<claim id="fact" refs="">A fictional note.</claim>',
        expectedRevision: 0,
        inputVersions: {},
      }),
    ).rejects.toThrow("Invalid node identity");
  });

  it("does not repair a consumer of an unchanged claim when another claim changes", async () => {
    source("a");
    source("b");
    const markdown =
      '<claim id="changing" refs="source:a">Friday workshop.</claim> <claim id="stable" refs="source:b">Bring a camera.</claim>';
    await service.save({
      id: "parent",
      kind: "wiki",
      title: "Workshop",
      markdown,
      expectedRevision: 0,
      inputVersions: { "source:a": "v1", "source:b": "v1" },
    });
    await wiki("child", "wiki:parent#claim:stable", "Bring a camera.");
    const childRevision = getKnowledgeNode(db, "child")!.revision;
    db.prepare("DELETE FROM knowledge_changes").run();
    source("a", "v2", "Saturday workshop.");
    await engine.tick();
    const batch = batchFor("a");
    const first = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    await engine.completeSource(batch.id, batch.runId, first.id, first.inputFingerprint);
    const offered = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "parent",
    )!;
    await engine.saveNode(
      batch.id,
      batch.runId,
      offered.id,
      offered.inputFingerprint,
      {
        id: "parent",
        kind: "wiki",
        title: "Workshop",
        markdown: markdown.replace("Friday", "Saturday"),
        expectedRevision: offered.node!.revision,
        inputVersions: { "source:a": service.reference("source:a").revision, "source:b": "v1" },
      },
      offered.pendingClaimIds,
    );
    expect(listKnowledgeFrontier(db, batch.id).some((item) => item.nodeId === "child")).toBe(false);
    expect(getKnowledgeNode(db, "child")).toMatchObject({
      revision: childRevision,
      validity: "current",
    });
  });

  it("repairs synthesis after A→B→A even when restored evidence already has coverage", async () => {
    source("input", "v1", "The workshop begins Friday.");
    await wiki("project");
    const revisions = [
      ["v1", "Friday"],
      ["v2", "Saturday"],
      ["v1", "Friday"],
    ] as const;
    for (const [step, [version, day]] of revisions.entries()) {
      if (step > 0) {
        now++;
        source("input", version, `The workshop begins ${day}.`);
      }
      await engine.tick();
      const batch = batchFor("input");
      expect(batch, `restored ${version} must still maintain existing synthesis`).toBeDefined();
      const discovery = (await engine.next(batch.id, batch.runId)).items.find(
        (item) => item.source,
      )!;
      await engine.completeSource(batch.id, batch.runId, discovery.id, discovery.inputFingerprint);
      const repair = (await engine.next(batch.id, batch.runId)).items.find(
        (item) => item.id === "project",
      )!;
      expect(repair).toBeDefined();
      await engine.saveNode(
        batch.id,
        batch.runId,
        repair.id,
        repair.inputFingerprint,
        {
          id: "project",
          kind: "wiki",
          title: "project",
          markdown: `<claim id="fact" refs="source:input">The workshop begins ${day}.</claim>`,
          expectedRevision: repair.node!.revision,
          inputVersions: { "source:input": discovery.source!.sourceRevision },
        },
        repair.pendingClaimIds,
      );
      expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
      expect(getKnowledgeNode(db, "project")).toMatchObject({
        validity: "current",
        plainText: `The workshop begins ${day}.`,
      });
    }
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM knowledge_work WHERE subject_id='input' AND status='completed'",
        )
        .get(),
    ).toEqual({ count: 3 });
  });

  it("stops propagation after unchanged repair and keeps downstream meaning usable", async () => {
    source();
    await wiki("parent");
    await wiki("child", "wiki:parent#claim:fact");
    await engine.tick();
    // Finish initial source interpretation before introducing a support-only revision.
    let batch = batchFor("input");
    let offered = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    await engine.completeSource(batch.id, batch.runId, offered.id, offered.inputFingerprint);
    let parent = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "parent",
    )!;
    await engine.saveNode(
      batch.id,
      batch.runId,
      parent.id,
      parent.inputFingerprint,
      {
        id: "parent",
        kind: "wiki",
        title: "parent",
        markdown: '<claim id="fact" refs="source:input">The workshop begins Friday.</claim>',
        expectedRevision: parent.node!.revision,
        inputVersions: { "source:input": "v1" },
      },
      parent.pendingClaimIds,
    );
    await engine.next(batch.id, batch.runId);
    source("input", "v2");
    now++;
    await engine.tick();
    batch = batchFor("input");
    offered = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    await engine.completeSource(batch.id, batch.runId, offered.id, offered.inputFingerprint);
    parent = (await engine.next(batch.id, batch.runId)).items.find((item) => item.id === "parent")!;
    const saved = await engine.saveNode(
      batch.id,
      batch.runId,
      parent.id,
      parent.inputFingerprint,
      {
        id: "parent",
        kind: "wiki",
        title: "parent",
        markdown: '<claim id="fact" refs="source:input">The workshop begins Friday.</claim>',
        expectedRevision: parent.node!.revision,
        inputVersions: { "source:input": service.reference("source:input").revision },
      },
      parent.pendingClaimIds,
    );
    expect(saved.meaningChanged).toBe(false);
    expect(listKnowledgeFrontier(db, batch.id).some((item) => item.nodeId === "child")).toBe(false);
    expect(getKnowledgeNode(db, "child")!.validity).toBe("current");
  });
});

it("repairs explicit authored-source dependents without opening source discovery", async () => {
  createKnowledgeSourceTriggers(db);
  db.prepare(
    "INSERT INTO documents(id,source_id,content_hash,content,title) VALUES('chat',?,'v1','Fictional plan','Planning conversation')",
  ).run(OMNESIS_CHAT_SOURCE_ID);
  saveKnowledgeNode(
    db,
    {
      id: "cited-project",
      kind: "wiki",
      title: "Project",
      markdown: '<claim id="plan" refs="source:chat">Fictional plan</claim>',
      expectedRevision: 0,
      inputVersions: { "source:chat": "v1" },
    },
    now,
  );
  db.prepare(
    "UPDATE documents SET content_hash='v2',content='Revised fictional plan' WHERE id='chat'",
  ).run();
  await engine.tick();
  expect(
    db
      .prepare(
        "SELECT 1 FROM knowledge_work WHERE subject_kind='node' AND subject_id='cited-project' AND reason='change'",
      )
      .get(),
  ).toBeDefined();
  expect(
    db.prepare("SELECT 1 FROM knowledge_work WHERE subject_kind='source'").get(),
  ).toBeUndefined();
  expect(
    db.prepare("SELECT 1 FROM knowledge_discovery_coverage WHERE subject_id='chat'").get(),
  ).toBeUndefined();
});

describe("explicit initial inventory admission", () => {
  const inventory = {
    id: "12345678-1234-4234-8234-123456789012",
    startedAt: "2027-01-11T08:00:00.000Z",
  };
  function inventorySource(id: string, at: number) {
    source(id, "v1", "Invented workshop history.", at);
    recordSourceInventoryPage(db, "fictional", "", inventory, false, now);
    recordSourceInventoryDocument(db, {
      documentId: id,
      inventoryId: inventory.id,
      revision: "v1",
      now,
    });
  }
  it("admits recent inventory newest-first while old inventory waits for historical consent", async () => {
    createSourceInventoryTables(db);
    inventorySource("old", now - 60 * 86_400_000);
    inventorySource("recent-older", now - 10 * 86_400_000);
    inventorySource("recent-newer", now - 86_400_000);
    await engine.tick();
    expect(
      db
        .prepare(
          "SELECT subject_id,reason,tier,due_at FROM knowledge_work WHERE subject_kind='source'",
        )
        .all(),
    ).toEqual([{ subject_id: "recent-newer", reason: "change", tier: "routine", due_at: now }]);
    await engine.tick();
    expect(
      db
        .prepare(
          "SELECT subject_id FROM knowledge_work WHERE subject_kind='source' ORDER BY subject_id",
        )
        .all(),
    ).toEqual([{ subject_id: "recent-newer" }, { subject_id: "recent-older" }]);
    settings = resolveBrainSettings({ bootstrap: { enabled: true, maxRuns: 1, maxRunsPerDay: 1 } });
    db.prepare(
      "INSERT INTO cognition_engine_state(key,value) VALUES('bootstrap_started_at',?)",
    ).run(String(now));
    await engine.tick();
    expect(db.prepare("SELECT reason FROM knowledge_work WHERE subject_id='old'").get()).toEqual({
      reason: "discovery",
    });
    expect(
      db.prepare("SELECT SUM(count) AS count FROM knowledge_historical_admissions").get(),
    ).toEqual({ count: 1 });
  });
  it("does not admit recent inventory dated before the history horizon", async () => {
    createSourceInventoryTables(db);
    settings = resolveBrainSettings({ bootstrap: { enabled: false, horizon: "7d" } });
    inventorySource("inside", now - 2 * 86_400_000);
    inventorySource("beyond", now - 10 * 86_400_000);
    await engine.tick();
    await engine.tick();
    expect(
      db.prepare("SELECT subject_id FROM knowledge_work WHERE subject_kind='source'").all(),
    ).toEqual([{ subject_id: "inside" }]);
  });
  it("keeps old late arrivals and edits reactive while an initial import remains partial", async () => {
    createSourceInventoryTables(db);
    inventorySource("old", Date.parse("2020-01-01T00:00:00Z"));
    source("late", "v1", "A newly received old letter.", Date.parse("2020-01-01T00:00:00Z"));
    source("old", "v2", "A new correction to older evidence.", Date.parse("2020-01-01T00:00:00Z"));
    await engine.tick();
    expect(
      db
        .prepare(
          "SELECT subject_id,reason FROM knowledge_work WHERE subject_kind='source' ORDER BY subject_id",
        )
        .all(),
    ).toEqual([
      { subject_id: "late", reason: "change" },
      { subject_id: "old", reason: "change" },
    ]);
    // Real late arrivals and subsequent revisions still use the scripted urgency judge.
    expect(decisionStates).toEqual([
      expect.objectContaining({
        documentId: "old",
        content: "A new correction to older evidence.",
      }),
      expect.objectContaining({ documentId: "late", content: "A newly received old letter." }),
      expect.objectContaining({
        documentId: "old",
        content: "A new correction to older evidence.",
      }),
    ]);
    expect(
      db
        .prepare("SELECT DISTINCT tier,due_at FROM knowledge_work WHERE subject_kind='source'")
        .all(),
    ).toEqual([{ tier: "immediate", due_at: now }]);
  });
  it("anchors recent admission to gateway receipt despite collector clock skew and later retries", async () => {
    createSourceInventoryTables(db);
    const skewed = { ...inventory, startedAt: "2099-01-01T00:00:00.000Z" };
    recordSourceInventoryPage(db, "fictional", "", skewed, false, now);
    source("recent-skew", "v1", "Fictional recent planning.", now - 86_400_000);
    source("old-skew", "v1", "Fictional historical planning.", now - 60 * 86_400_000);
    for (const documentId of ["recent-skew", "old-skew"])
      recordSourceInventoryDocument(db, {
        documentId,
        inventoryId: skewed.id,
        revision: "v1",
        now,
      });
    recordSourceInventoryPage(db, "fictional", "", skewed, false, now + 90 * 86_400_000);
    await engine.tick();
    expect(
      db.prepare("SELECT subject_id FROM knowledge_work WHERE subject_kind='source'").all(),
    ).toEqual([{ subject_id: "recent-skew" }]);
    expect(db.prepare("SELECT first_received_at FROM source_inventories").get()).toEqual({
      first_received_at: now,
    });
  });
  it("uses the configured recent window without swallowing older imports", async () => {
    createSourceInventoryTables(db);
    settings = resolveBrainSettings({
      bootstrap: { enabled: false },
      knowledge: { recentWindowDays: 1 },
    });
    inventorySource("two-days-old", now - 2 * 86_400_000);
    await engine.tick();
    expect(
      db.prepare("SELECT 1 FROM knowledge_work WHERE subject_kind='source'").get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_inventory_documents").get()).toEqual({
      count: 1,
    });
  });
});

it("keeps untouched eligible claims pending after a partial page save", async () => {
  source();
  const markdown =
    '<claim id="first" refs="source:input">The workshop is on Friday.</claim>\n<claim id="second" refs="source:input">Venue provisional.</claim>';
  await service.save({
    id: "partial",
    kind: "wiki",
    title: "Partial review",
    markdown,
    expectedRevision: 0,
    inputVersions: { "source:input": "v1" },
    metadata: { nextReviewAt: now },
  });
  db.exec("DELETE FROM knowledge_changes");
  await engine.tick();
  const batch = batchFor("partial");
  const first = (await engine.next(batch.id, batch.runId)).items.find(
    (item) => item.id === "partial",
  )!;
  expect(first.pendingClaimIds).toEqual(["first", "second"]);
  const changed = markdown.replace("The workshop is on Friday.", "The workshop is on Saturday.");
  await engine.saveNode(
    batch.id,
    batch.runId,
    first.id,
    first.inputFingerprint,
    {
      id: "partial",
      kind: "wiki",
      title: "Partial review",
      markdown: changed,
      expectedRevision: first.node!.revision,
      inputVersions: { "source:input": "v1" },
    },
    [],
  );
  const next = await engine.next(batch.id, batch.runId);
  expect(next.done).toBe(false);
  const second = next.items.find((item) => item.id === "partial")!;
  expect(second.pendingClaimIds).toEqual(["second"]);
  expect(second.node!.claims.find((claim) => claim.id === "second")!.verification).toBe("stale");
  await engine.saveNode(
    batch.id,
    batch.runId,
    second.id,
    second.inputFingerprint,
    {
      id: "partial",
      kind: "wiki",
      title: "Partial review",
      markdown: changed,
      expectedRevision: second.node!.revision,
      inputVersions: { "source:input": "v1" },
    },
    ["second"],
    {
      batchId: batch.id,
      runId: batch.runId,
      placementLibrary: { collection: "wiki", revision: 0 },
    },
    { status: "standalone", reason: "Self-contained workshop reference." },
  );
  expect((await engine.next(batch.id, batch.runId)).done).toBe(true);
  expect(
    db
      .prepare(
        "SELECT claim_id,status FROM knowledge_claim_outcomes WHERE batch_id=? AND input_fingerprint=? ORDER BY claim_id",
      )
      .all(batch.id, first.inputFingerprint),
  ).toEqual([
    { claim_id: "first", status: "changed" },
    { claim_id: "second", status: "deferred" },
  ]);
  expect(
    db
      .prepare(
        "SELECT status FROM knowledge_claim_outcomes WHERE batch_id=? AND input_fingerprint=? AND claim_id='second'",
      )
      .get(batch.id, second.inputFingerprint),
  ).toEqual({ status: "unchanged" });
});

it("never offers an observation for repair when its evidence changes, and leaves it unrewritten", async () => {
  source();
  createObservation(
    db,
    {
      id: "past-observation",
      createdByRun: "fixture",
      summary: "The workshop is on Friday.",
      citations: ["input"],
    },
    now,
  );
  convertKnowledgeOwner(db, "observation", "past-observation", now);
  await service.save({
    id: "past-observation",
    ownerId: "past-observation",
    kind: "observation",
    title: "The workshop is on Friday.",
    markdown: '<claim id="fact" refs="source:input">The workshop is on Friday.</claim>',
    expectedRevision: 1,
    inputVersions: { "source:input": "v1" },
  });
  await wiki("durable", "source:input", "The workshop is on Friday.");
  transitionObservation(db, "past-observation", { state: "shipped" }, now);
  const snapshot = getObservation(db, "past-observation")!;
  db.exec("DELETE FROM knowledge_changes");
  source("input", "v2", "The workshop is on Saturday.");
  await engine.tick();
  const batch = batchFor("input");
  const discovery = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
  await engine.completeSource(batch.id, batch.runId, discovery.id, discovery.inputFingerprint);
  const offered = await engine.next(batch.id, batch.runId);
  expect(offered.items.map((item) => item.id)).toContain("durable");
  expect(offered.items.map((item) => item.id)).not.toContain("past-observation");
  expect(getObservation(db, "past-observation")).toEqual(snapshot);
  expect(getKnowledgeNode(db, "past-observation")?.markdown).toBe(
    '<claim id="fact" refs="source:input">The workshop is on Friday.</claim>',
  );
});

describe("durable discovery input context", () => {
  it.each(["changed", "withdrawn"] as const)(
    "rejects uncited discovery context %s while the verifier is paused",
    async (change) => {
      source("original");
      await wiki("project", "source:original");
      db.prepare("DELETE FROM knowledge_changes").run();
      source("selected");
      await engine.tick();
      const batch = batchFor("selected");
      const first = (await engine.next(batch.id, batch.runId)).items.find(
        (item) => item.id === "source:selected",
      )!;
      await engine.completeSource(
        batch.id,
        batch.runId,
        first.id,
        first.inputFingerprint,
        false,
        undefined,
        ["project"],
      );
      const offered = (await engine.next(batch.id, batch.runId)).items.find(
        (item) => item.id === "project",
      )!;
      expect(offered.inputVersions["source:selected"]).toBe("v1");
      const before = getKnowledgeNode(db, "project");
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      service.deps.getEntailmentVerifier = async () => ({
        verify: async () => {
          enter();
          await paused;
          return { label: "entailment", probability: 1 };
        },
        dispose() {},
      });
      const saving = engine.saveNode(
        batch.id,
        batch.runId,
        "project",
        offered.inputFingerprint,
        {
          id: "project",
          kind: "wiki",
          title: "Project",
          markdown: '<claim id="fact" refs="source:original">The workshop begins Friday.</claim>',
          expectedRevision: offered.node!.revision,
          // The newly selected context is deliberately absent from all citations.
          inputVersions: { "source:original": "v1" },
        },
        offered.pendingClaimIds,
      );
      await entered;
      if (change === "changed")
        db.exec("UPDATE documents SET content_hash='v2' WHERE id='selected'");
      else db.exec("UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='selected'");
      const rejected = expect(saving).rejects.toMatchObject({ code: "revision_conflict" });
      release();
      await rejected;
      expect(getKnowledgeNode(db, "project")).toEqual(before);
      expect(
        listKnowledgeFrontier(db, batch.id).find(
          (item) => item.nodeId === "project" && item.inputFingerprint === offered.inputFingerprint,
        )?.status,
      ).toBe("offered");
    },
  );

  it.each(["changed", "deleted", "removed"] as const)(
    "refuses an offered snapshot after a selected source is %s",
    async (change) => {
      source("original");
      await wiki("project", "source:original");
      db.prepare("DELETE FROM knowledge_changes").run();
      source("selected");
      await engine.tick();
      const batch = batchFor("selected");
      const first = (await engine.next(batch.id, batch.runId)).items.find(
        (item) => item.id === "source:selected",
      )!;
      await engine.completeSource(
        batch.id,
        batch.runId,
        first.id,
        first.inputFingerprint,
        false,
        undefined,
        ["project"],
      );
      const offered = (await engine.next(batch.id, batch.runId)).items.find(
        (item) => item.id === "project",
      )!;
      expect(offered.inputVersions["source:selected"]).toBe("v1");
      if (change === "changed")
        db.prepare("UPDATE documents SET content_hash='v2' WHERE id='selected'").run();
      else if (change === "deleted")
        db.prepare(
          "UPDATE knowledge_source_revisions SET deleted=1 WHERE document_id='selected'",
        ).run();
      else {
        db.exec("CREATE TABLE removed_sources(id TEXT PRIMARY KEY)");
        db.prepare("INSERT INTO removed_sources VALUES('fictional')").run();
      }
      expect(() => engine.maintenanceInputs(batch.id, batch.runId, "project")).toThrow(
        /inputs changed/,
      );
    },
  );

  it("does not offer dormant discovery selections outside the current batch", async () => {
    source("original");
    await wiki("project", "source:original");
    source("dormant");
    db.prepare("INSERT INTO knowledge_discovery_targets VALUES('dormant','v1','project',?)").run(
      now,
    );
    db.prepare("DELETE FROM knowledge_changes").run();
    source("selected");
    await engine.tick();
    const batch = batchFor("selected");
    const first = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "source:selected",
    )!;
    await engine.completeSource(
      batch.id,
      batch.runId,
      first.id,
      first.inputFingerprint,
      false,
      undefined,
      ["project"],
    );
    const repair = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "project",
    )!;
    expect(repair.inputVersions["source:selected"]).toBe("v1");
    expect(repair.inputVersions["source:dormant"]).toBeUndefined();
    expect(service.fetch("project", true)!.markdown).not.toContain("selected");
  });
});

it("refreshes changed parent topology and retains a successor review when a link changes during verification", async () => {
  source();
  await wiki("parent");
  await wiki("child");
  db.exec("DELETE FROM knowledge_changes");
  setKnowledgeLink(
    db,
    { fromId: "child", toId: "parent", kind: "part_of", fromRevision: 1, toRevision: 1 },
    undefined,
    now,
  );
  await engine.tick();
  const batch = batchFor("parent");
  expect(batch).toBeDefined();
  const first = (await engine.next(batch.id, batch.runId)).items.find(
    (item) => item.id === "parent",
  )!;
  expect(first.review).toBe(true);
  expect(first.inputVersions["organization:parent"]).toEqual(expect.any(String));
  let mutated = false;
  service.deps.getEntailmentVerifier = async () => ({
    async verify() {
      if (!mutated) {
        mutated = true;
        setKnowledgeLink(
          db,
          {
            fromId: "child",
            toId: "parent",
            kind: "part_of",
            fromRevision: 1,
            toRevision: 1,
            remove: true,
          },
          undefined,
          now,
        );
      }
      return { label: "entailment" as const, probability: 1 };
    },
    dispose() {},
  });
  const proposal = (item: typeof first) => ({
    id: "parent",
    kind: "wiki" as const,
    title: "parent",
    markdown: item.node!.markdown,
    expectedRevision: item.node!.revision,
    inputVersions: item.inputVersions,
  });
  await expect(
    engine.saveNode(
      batch.id,
      batch.runId,
      "parent",
      first.inputFingerprint,
      proposal(first),
      first.pendingClaimIds,
    ),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(getKnowledgeNode(db, "parent")?.revision).toBe(1);
  expect(
    db
      .prepare(
        "SELECT 1 FROM knowledge_work WHERE subject_id='parent' AND reason='review' AND status='pending'",
      )
      .get(),
  ).toBeDefined();
  const refreshed = (await engine.next(batch.id, batch.runId)).items.find(
    (item) => item.id === "parent",
  )!;
  expect(refreshed.inputFingerprint).not.toBe(first.inputFingerprint);
  await engine.saveNode(
    batch.id,
    batch.runId,
    "parent",
    refreshed.inputFingerprint,
    proposal(refreshed),
    refreshed.pendingClaimIds,
    {
      batchId: batch.id,
      runId: batch.runId,
      placementLibrary: { collection: "wiki", revision: 0 },
    },
    { status: "standalone", reason: "Self-contained workshop reference." },
  );
  expect(getKnowledgeNode(db, "parent")?.revision).toBe(2);
  expect(getKnowledgeNode(db, "parent")?.markdown).toContain('refs="source:input"');
});

it.each([
  { available: true, coalesce: false },
  { available: false, coalesce: false },
  { available: true, coalesce: true },
])(
  "records source urgency through engine intake ($available, coalesce=$coalesce)",
  async ({ available, coalesce }) => {
    createKnowledgeDecisionTable(db);
    source("urgency-source", "v1", "The reserved workshop starts tomorrow.");
    if (coalesce)
      await writeGate["knowledge.enqueue"](
        {
          id: "earlier-work",
          subjectId: "urgency-source",
          subjectKind: "source",
          reason: "change",
          inputRevision: "v1",
          tier: "immediate",
          dueAt: now - 1,
        },
        now - 1,
      );
    const decision: DecisionCapability = {
      modelId: "scripted",
      dispose() {},
      async decide(request) {
        return {
          model: "scripted",
          answers: Object.fromEntries(
            Object.keys(request.questions).map((key) => [
              key,
              { type: "score" as const, score: 1 },
            ]),
          ),
        };
      },
    };
    engine = new KnowledgeEngine({
      db,
      writeGate,
      service,
      getSettings: () => settings,
      clock: () => now,
      log,
      idGen: () => String(++serial),
      decisions: {
        getDecision: () => (available ? decision : null),
        log,
        recordSpend: async () => {},
        record: async (entry) =>
          recordKnowledgeDecision(db, { ...entry, id: entry.id ?? `audit_${++serial}` }, now),
      },
    });
    await engine.tick();
    const row = db
      .prepare<
        [],
        { id: string; workId: string }
      >("SELECT id,work_id AS workId FROM knowledge_decisions WHERE purpose='urgency'")
      .get()!;
    expect(row.workId).toBeTruthy();
    expect(readKnowledgeDecisionAudit(db, row.id)).toMatchObject({
      score: available ? 0.5 : null,
      scheduling: {
        status: "scheduled",
        applied: { tier: coalesce ? "immediate" : "soon" },
        fallbackSoon: !available,
      },
      input: available
        ? {
            availability: "available",
            request: {
              state: {
                documentId: "urgency-source",
                content: "The reserved workshop starts tomorrow.",
              },
            },
          }
        : { availability: "unavailable", request: null, response: null },
    });
    if (coalesce) expect(row.workId).toBe("earlier-work");
  },
);

it.each([
  ["doc_annotation", "none"],
  ["person_annotation", "none"],
  ["doc_annotation", "reactivated"],
  ["person_annotation", "reactivated"],
  ["doc_annotation", "revised"],
  ["person_annotation", "revised"],
] as const)(
  "settles historical %s with dependent traversal and an atomic lifecycle fence (race=%s)",
  async (kind, race) => {
    createAnnotationStorageTables(db);
    createPersonAnnotationStorageTables(db);
    source();
    const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
    const subject = kind === "doc_annotation" ? "doc_id" : "person_id";
    db.prepare(
      `INSERT INTO ${table}(id,${subject},claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).run(
      "retired-note",
      "input",
      "schedule",
      "The workshop begins Friday.",
      "input",
      "The workshop begins Friday.",
      0.8,
      "fixture",
      now,
    );
    convertKnowledgeOwner(db, kind, "retired-note", now);
    await service.save({
      id: "retired-note",
      ownerId: "retired-note",
      kind,
      title: "schedule",
      markdown: '<claim id="fact" refs="source:input">The workshop begins Friday.</claim>',
      expectedRevision: 1,
      inputVersions: { "source:input": "v1" },
    });
    await wiki("dependent", "annotation:retired-note#claim:fact");
    db.prepare(
      `UPDATE ${table} SET invalidated_at=?,superseded_by='replacement' WHERE id='retired-note'`,
    ).run(now);
    const ownerBefore = db.prepare(`SELECT * FROM ${table} WHERE id='retired-note'`).get();
    db.exec("DELETE FROM knowledge_changes");
    source("input", "v2", "The workshop begins Saturday.");
    await engine.tick();
    const batch = batchFor("input");
    const discovery = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    await engine.completeSource(batch.id, batch.runId, discovery.id, discovery.inputFingerprint);
    if (race !== "none") {
      const settle = writeGate["knowledge.settleFrontier"];
      vi.spyOn(writeGate, "knowledge.settleFrontier").mockImplementation(async (input, at) => {
        if (input.historicalOwnerRevision !== undefined) {
          if (race === "reactivated")
            db.prepare(
              `UPDATE ${table} SET invalidated_at=NULL,superseded_by=NULL WHERE id='retired-note'`,
            ).run();
          else
            db.prepare(
              "UPDATE knowledge_nodes SET revision=revision+1 WHERE id='retired-note'",
            ).run();
        }
        return settle(input, at);
      });
      await expect(engine.next(batch.id, batch.runId)).rejects.toThrow("lifecycle changed");
      expect(
        listKnowledgeFrontier(db, batch.id).find((item) => item.nodeId === "retired-note")?.status,
      ).not.toBe("skipped");
      return;
    }
    const offered = await engine.next(batch.id, batch.runId);
    expect(offered.items.map((item) => item.id)).toContain("dependent");
    expect(offered.items.map((item) => item.id)).not.toContain("retired-note");
    expect(
      listKnowledgeFrontier(db, batch.id).find((item) => item.nodeId === "retired-note")?.status,
    ).toBe("skipped");
    expect(db.prepare(`SELECT * FROM ${table} WHERE id='retired-note'`).get()).toEqual(ownerBefore);
    expect(service.reference("annotation:retired-note#claim:fact")).toMatchObject({
      stale: true,
      verified: false,
    });
  },
);

it("does not let historical annotations consume the bounded review nomination window", async () => {
  createAnnotationStorageTables(db);
  source();
  db.prepare(
    `INSERT INTO doc_annotations(id,doc_id,claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at,invalidated_at)
    VALUES('a-retired','input','schedule','The workshop begins Friday.','input','The workshop begins Friday.',0.8,'fixture',?,?)`,
  ).run(now, now);
  convertKnowledgeOwner(db, "doc_annotation", "a-retired", now);
  await wiki("z-live");
  db.prepare(
    "UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.nextReviewAt',?) WHERE id IN ('a-retired','z-live')",
  ).run(now - 1);
  db.exec("DELETE FROM knowledge_changes");
  settings = { ...settings, knowledge: { ...settings.knowledge, maxReviewsPerTick: 1 } };
  await engine.tick();
  expect(db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all()).toEqual([
    { subject_id: "z-live" },
  ]);
});

it.each([false, true])(
  "settles an archived loop with dependents and refuses concurrent restoration (race=%s)",
  async (race) => {
    source();
    const loop = createOpenLoop(
      db,
      {
        id: "archived-task",
        createdByRun: "fixture",
        title: "Prepare the workshop",
        description: "The workshop begins Friday.",
        docs: ["input"],
        confidence: 0.8,
        importance: 0.4,
      },
      now,
    );
    convertKnowledgeOwner(db, "loop", loop.id, now);
    await service.save({
      id: loop.id,
      ownerId: loop.id,
      kind: "loop",
      title: loop.title,
      markdown: '<claim id="fact" refs="source:input">The workshop begins Friday.</claim>',
      expectedRevision: 1,
      inputVersions: { "source:input": "v1" },
    });
    await wiki("dependent", "loop:archived-task#claim:fact");
    retireLoop(db, loop, "done", now);
    db.prepare("DELETE FROM open_loops WHERE id=?").run(loop.id);
    const historical = db.prepare("SELECT * FROM retired_loops WHERE id=?").get(loop.id);
    db.exec("DELETE FROM knowledge_changes");
    source("input", "v2", "The workshop begins Saturday.");
    await engine.tick();
    const batch = batchFor("input");
    const discovery = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    await engine.completeSource(batch.id, batch.runId, discovery.id, discovery.inputFingerprint);
    if (race) {
      const settle = writeGate["knowledge.settleFrontier"];
      vi.spyOn(writeGate, "knowledge.settleFrontier").mockImplementation(async (input, at) => {
        if (input.historicalOwnerRevision !== undefined)
          createOpenLoop(db, { ...loop, createdByRun: "restore" }, now);
        return settle(input, at);
      });
      await expect(engine.next(batch.id, batch.runId)).rejects.toThrow("lifecycle changed");
      expect(
        listKnowledgeFrontier(db, batch.id).find((item) => item.nodeId === loop.id)?.status,
      ).not.toBe("skipped");
    } else {
      const offered = await engine.next(batch.id, batch.runId);
      expect(offered.items.map((item) => item.id)).toContain("dependent");
      expect(offered.items.map((item) => item.id)).not.toContain(loop.id);
      expect(
        listKnowledgeFrontier(db, batch.id).find((item) => item.nodeId === loop.id)?.status,
      ).toBe("skipped");
      expect(db.prepare("SELECT * FROM retired_loops WHERE id=?").get(loop.id)).toEqual(historical);
    }
  },
);

it("excludes archived loops before the bounded review nomination window", async () => {
  source();
  const loop = createOpenLoop(
    db,
    {
      id: "a-archived",
      createdByRun: "fixture",
      title: "Prepare supplies",
      docs: ["input"],
      confidence: 0.8,
      importance: 0.4,
    },
    now,
  );
  convertKnowledgeOwner(db, "loop", loop.id, now);
  retireLoop(db, loop, "done", now);
  db.prepare("DELETE FROM open_loops WHERE id=?").run(loop.id);
  await wiki("z-live");
  db.prepare(
    "UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.nextReviewAt',?) WHERE id IN ('a-archived','z-live')",
  ).run(now - 1);
  db.exec("DELETE FROM knowledge_changes");
  settings = { ...settings, knowledge: { ...settings.knowledge, maxReviewsPerTick: 1 } };
  await engine.tick();
  expect(db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all()).toEqual([
    { subject_id: "z-live" },
  ]);
});

it("keeps incomplete-search source coverage and releases its reconsideration only after publication", async () => {
  source();
  await engine.tick();
  const batch = batchFor("input");
  const input = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
  const boundary = new Date(now).toISOString();
  await engine.completeSource(
    batch.id,
    batch.runId,
    input.id,
    input.inputFingerprint,
    false,
    undefined,
    [],
    boundary,
  );
  await engine.next(batch.id, batch.runId);
  const coverage = () =>
    db
      .prepare(
        "SELECT status,retrieval_boundary,retrieval_reconsidered FROM knowledge_discovery_coverage WHERE subject_id='input' AND phase='organization'",
      )
      .get();
  expect(coverage()).toEqual({
    status: "considered",
    retrieval_boundary: boundary,
    retrieval_reconsidered: 0,
  });
  await engine.tick();
  expect(coverage()).toEqual({
    status: "considered",
    retrieval_boundary: boundary,
    retrieval_reconsidered: 0,
  });
  publishedRetrievalBoundary = boundary;
  await engine.tick();
  expect(coverage()).toMatchObject({ retrieval_boundary: null, retrieval_reconsidered: 1 });
});

it("projects a queued canonical update before offering an owner revision", async () => {
  source();
  await engine.tick();
  const batch = batchFor("input");
  const offered = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
  createOpenLoop(
    db,
    {
      id: "pending-owner",
      createdByRun: batch.runId,
      title: "Prepare equipment",
      description: "The workshop begins Friday.",
      confidence: 0.8,
      importance: 0.5,
      docs: ["input"],
    },
    now,
  );
  await engine.completeSource(
    batch.id,
    batch.runId,
    offered.id,
    offered.inputFingerprint,
    false,
    ["interpretation", "organization", "conversion"],
    ["pending-owner"],
  );
  installKnowledgeOwnerTriggers(db);
  const before = getKnowledgeNode(db, "pending-owner")!.revision;
  updateOpenLoop(db, "pending-owner", { importance: 0.9 }, ++now);
  db.prepare(
    "INSERT INTO knowledge_owner_changes(kind,owner_id,operation,changed_at) VALUES('loop','unrelated-pending','update',?)",
  ).run(now);
  let view = await engine.next(batch.id, batch.runId);
  for (let pass = 0; pass < 10 && !view.items.some((item) => item.id === "pending-owner"); pass++)
    view = await engine.next(batch.id, batch.runId);
  const repair = view.items.find((item) => item.id === "pending-owner")!;
  expect(repair.node?.revision).toBeGreaterThan(before);
  expect(repair.node?.canonicalFields.importance).toBe(0.9);
  expect(
    db
      .prepare("SELECT owner_id FROM knowledge_owner_changes WHERE owner_id='unrelated-pending'")
      .get(),
  ).toEqual({ owner_id: "unrelated-pending" });
  db.prepare("DELETE FROM knowledge_owner_changes WHERE owner_id='unrelated-pending'").run();
  expect(await writeGate["knowledge.syncOwners"](10, ++now)).toMatchObject({ updatedNodeIds: [] });
  expect(getKnowledgeNode(db, "pending-owner")!.revision).toBe(repair.node!.revision);
  expect(() =>
    engine.preflightSaveNode(batch.id, batch.runId, repair.id, repair.inputFingerprint),
  ).not.toThrow();
  updateOpenLoop(db, "pending-owner", { importance: 0.6 }, ++now);
  await writeGate["knowledge.syncOwners"](1, ++now, "pending-owner");
  expect(() =>
    engine.preflightSaveNode(batch.id, batch.runId, repair.id, repair.inputFingerprint),
  ).toThrow("Frontier inputs changed");
});

it("does not nominate accepted outcome policy again for unrelated person rubric changes", async () => {
  source();
  settings.annotations.recordCheck = "enforce";
  createOpenLoop(
    db,
    {
      id: "accepted-outcome",
      title: "Prepare the observatory map",
      description: "Print the map for the open evening.",
      createdByRun: "run",
      docs: ["input"],
      importance: 0.3,
      confidence: 0.8,
    },
    now,
  );
  convertKnowledgeOwner(db, "loop", "accepted-outcome", now);
  db.prepare(
    "INSERT INTO knowledge_outcome_assessments(owner_id,policy,fingerprint,decision_id,review_batch_id,status,retry_at,updated_at) VALUES(?,?,?,?,NULL,'pass',0,?)",
  ).run(
    "accepted-outcome",
    JSON.stringify(["record-value-v13", "enforce", "scripted"]),
    "accepted-fingerprint",
    "accepted-decision",
    now,
  );
  db.exec("DELETE FROM knowledge_changes; DELETE FROM knowledge_work");
  await engine.tick();
  expect(db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all()).toEqual(
    [],
  );
});

it("nominates untouched old-policy outcomes within the existing review limit and respects attempt backoff", async () => {
  source();
  settings.annotations.recordCheck = "enforce";
  settings.knowledge.maxReviewsPerTick = 1;
  for (const id of ["policy-a", "policy-b"]) {
    createOpenLoop(
      db,
      {
        id,
        title: "Check the calibration",
        description: "The workshop begins Friday.",
        createdByRun: "run",
        docs: ["input"],
        importance: 0.3,
        confidence: 0.8,
      },
      now,
    );
    convertKnowledgeOwner(db, "loop", id, now);
  }
  db.exec("DELETE FROM knowledge_changes; DELETE FROM knowledge_work");
  await engine.tick();
  const reviews = db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all();
  expect(reviews).toHaveLength(1);
  expect(
    getKnowledgeNode(db, (reviews[0] as { subject_id: string }).subject_id)?.metadata.reviewReason,
  ).toBe("outcome_policy_revalidation");
  const other =
    (reviews[0] as { subject_id: string }).subject_id === "policy-a" ? "policy-b" : "policy-a";
  const fence = captureOutcomeWriteFence(db, other, ["input"]);
  recordOutcomeAssessmentAttempt(
    db,
    {
      fence,
      receipt: makeOutcomeAssessment(
        outcomeRecordPolicyKey("enforce", "scripted"),
        outcomeProposal(getOpenLoop(db, other)!),
        fence.sources,
        "outage",
        null,
      ),
      status: "unavailable",
      retryAt: now + 60_000,
    },
    now,
  );
  await engine.tick();
  expect(
    db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all(),
  ).toHaveLength(1);
  now += 60_001;
  await engine.tick();
  expect(
    db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all(),
  ).toHaveLength(2);
});

it.each(["wiki", "root", "doc_annotation", "person_annotation"] as const)(
  "gradually nominates outdated positive %s proof without a relevance gate",
  async (kind) => {
    source();
    await wiki("proof-policy");
    db.prepare("UPDATE knowledge_nodes SET kind=? WHERE id='proof-policy'").run(kind);
    db.prepare(
      "UPDATE knowledge_claims SET verification='verified',verifier='prior-policy' WHERE node_id='proof-policy'",
    ).run();
    db.exec("DELETE FROM knowledge_changes; DELETE FROM knowledge_work");
    score = 0;
    await engine.tick();
    expect(db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all()).toEqual(
      [{ subject_id: "proof-policy" }],
    );
    expect(getKnowledgeNode(db, "proof-policy")?.metadata.reviewReason).toBe(
      "verifier_policy_revalidation",
    );
    expect(decisionStates).not.toContainEqual(expect.objectContaining({ id: "proof-policy" }));
    await engine.tick();
    expect(
      db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all(),
    ).toHaveLength(1);
  },
);

it.each(["wiki", "root", "doc_annotation", "person_annotation"] as const)(
  "does not nominate current or nonpositive %s proof as policy repair",
  async (kind) => {
    source();
    await wiki("proof-policy");
    db.prepare("UPDATE knowledge_nodes SET kind=? WHERE id='proof-policy'").run(kind);
    db.prepare(
      "UPDATE knowledge_claims SET verification='verified',verifier=? WHERE node_id='proof-policy'",
    ).run(kind === "wiki" || kind === "root" ? CONTEXTUAL_VERIFIER : ANNOTATION_CONTEXT_VERIFIER);
    db.exec("DELETE FROM knowledge_changes; DELETE FROM knowledge_work");
    await engine.tick();
    expect(db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all()).toEqual(
      [],
    );
    db.exec(
      "UPDATE knowledge_claims SET verification='unverified',verifier='prior-policy' WHERE node_id='proof-policy'",
    );
    await engine.tick();
    expect(db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all()).toEqual(
      [],
    );
  },
);

it("bounds proof-policy nominations, skips outstanding work, and backs off completed unsuccessful attempts", async () => {
  source();
  settings.knowledge.maxReviewsPerTick = 1;
  for (const id of ["proof-a", "proof-b", "proof-c"]) await wiki(id);
  db.exec(
    "UPDATE knowledge_claims SET verification='verified',verifier=NULL; DELETE FROM knowledge_changes; DELETE FROM knowledge_work",
  );
  await engine.tick();
  expect(
    db
      .prepare("SELECT subject_id FROM knowledge_work WHERE reason='review' ORDER BY subject_id")
      .all(),
  ).toEqual([{ subject_id: "proof-a" }]);
  await engine.tick();
  expect(
    db
      .prepare("SELECT subject_id FROM knowledge_work WHERE reason='review' ORDER BY subject_id")
      .all(),
  ).toEqual([{ subject_id: "proof-a" }, { subject_id: "proof-b" }]);
  db.prepare(
    "UPDATE knowledge_work SET status='completed',updated_at=? WHERE subject_id='proof-a'",
  ).run(now);
  await engine.tick();
  expect(
    db
      .prepare("SELECT subject_id FROM knowledge_work WHERE reason='review' ORDER BY subject_id")
      .all(),
  ).toEqual([{ subject_id: "proof-a" }, { subject_id: "proof-b" }, { subject_id: "proof-c" }]);
  await engine.tick();
  expect(db.prepare("SELECT COUNT(*) n FROM knowledge_work WHERE reason='review'").get()).toEqual({
    n: 3,
  });
  now += Math.max(60_000, settings.knowledge.soonDelayMs) + 1;
  await engine.tick();
  expect(
    db
      .prepare(
        "SELECT COUNT(*) n FROM knowledge_work WHERE reason='review' AND subject_id='proof-a'",
      )
      .get(),
  ).toEqual({ n: 2 });
});

it("does not admit ordinary root reviews or historical annotations for proof-policy repair", async () => {
  createAnnotationStorageTables(db);
  source();
  for (const [id, invalidated, superseded] of [
    ["a-retired", now, null],
    ["b-superseded", null, "other"],
  ] as const) {
    db.prepare(
      `INSERT INTO doc_annotations(id,doc_id,claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at,invalidated_at,superseded_by)
      VALUES(?,'input','schedule','The workshop begins Friday.','input','The workshop begins Friday.',0.8,'fixture',?,?,?)`,
    ).run(id, now, invalidated, superseded);
    convertKnowledgeOwner(db, "doc_annotation", id, now);
  }
  await wiki("ordinary-root");
  db.exec("UPDATE knowledge_nodes SET kind='root' WHERE id='ordinary-root'");
  await wiki("z-active");
  db.exec(
    "UPDATE knowledge_claims SET verification='verified',verifier='prior-policy' WHERE node_id!='ordinary-root'; DELETE FROM knowledge_changes; DELETE FROM knowledge_work",
  );
  db.prepare(
    "UPDATE knowledge_nodes SET metadata_json=json_set(metadata_json,'$.nextReviewAt',?) WHERE id='ordinary-root'",
  ).run(now - 1);
  settings.knowledge.maxReviewsPerTick = 1;
  await engine.tick();
  expect(db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all()).toEqual([
    { subject_id: "z-active" },
  ]);
});

it("holds legacy candidate siblings before offering source work or buying decisions", async () => {
  for (const [index, id] of ["first", "second"].entries()) {
    db.prepare(
      "INSERT INTO documents(id,source_id,content_hash,content,title) VALUES(?,'fictional-source','v1','Equipment instructions','Equipment')",
    ).run(id);
    enqueueKnowledgeWork(
      db,
      {
        id: `work-${id}`,
        subjectId: id,
        subjectKind: "source",
        reason: "review",
        inputRevision: "v1",
        tier: "routine",
        dueAt: now,
      },
      now,
    );
    createKnowledgeBatch(
      db,
      {
        id: `batch-${id}`,
        runId: `run-${id}`,
        tier: "routine",
        work: [{ id: `work-${id}`, generation: 1, inputRevision: "v1" }],
        regionNodeIds: [`source:${id}`],
        frontier: [
          {
            nodeId: `source:${id}`,
            inputFingerprint: "v1",
            inputVersions: { [`source:${id}`]: "v1" },
            depth: 0,
          },
        ],
      },
      now + index,
    );
  }
  db.exec(`INSERT INTO knowledge_candidates(id,identity_key,title,scope,evidence_ids_json,status,created_at,updated_at)
    VALUES('shared-equipment','shared-equipment','Equipment','Equipment reference','["first","second"]','proposed',1,1);
    INSERT INTO knowledge_candidate_decision_work VALUES('shared-equipment',1,'work-first'),('shared-equipment',1,'work-second');`);
  expect(await engine.next("batch-second", "run-second")).toEqual({
    batchId: "batch-second",
    done: false,
    items: [],
  });
  expect(decisions).toBe(0);
  expect(listKnowledgeFrontier(db, "batch-second")[0]!.status).toBe("pending");
});

it.each(["open", "done", "missing"] as const)(
  "retained loop owners receive bounded contextual proof repair: %s",
  async (state) => {
    source();
    await wiki("loop-proof-policy");
    if (state !== "missing") {
      createOpenLoop(
        db,
        {
          id: "loop-proof-policy",
          title: "Prepare display",
          description: "Assembly proposed.",
          createdByRun: "seed",
          docs: ["input"],
          importance: 0.3,
          confidence: 0.8,
        },
        now,
      );
      if (state === "done") updateOpenLoop(db, "loop-proof-policy", { state: "done" }, now);
    }
    db.exec(
      "UPDATE knowledge_nodes SET kind='loop',owner_id='loop-proof-policy' WHERE id='loop-proof-policy'; UPDATE knowledge_claims SET verification='verified',verifier='entailment-verifier' WHERE node_id='loop-proof-policy'; DELETE FROM knowledge_changes; DELETE FROM knowledge_work",
    );
    score = 0;
    await engine.tick();
    const work = db.prepare("SELECT subject_id FROM knowledge_work WHERE reason='review'").all();
    expect(work).toEqual(state !== "missing" ? [{ subject_id: "loop-proof-policy" }] : []);
    if (state !== "missing")
      expect(getKnowledgeNode(db, "loop-proof-policy")?.metadata.reviewReason).toBe(
        "verifier_policy_revalidation",
      );
    expect(decisionStates).not.toContainEqual(expect.objectContaining({ id: "loop-proof-policy" }));
  },
);

it("leaves an owner a source discovery just created to that discovery, not a review of its own", async () => {
  settings = resolveBrainSettings({
    bootstrap: { enabled: false },
    knowledge: { soonDelay: "0s", routineDelay: "0s", maxSeeds: 1, maxFrontierNodes: 1 },
  });
  installKnowledgeOwnerTriggers(db);
  source("input", "v1", "Please confirm the rehearsal slot before Friday.");
  await engine.tick();
  const batch = batchFor("input");
  const offered = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
  expect(
    writerHandlers["knowledge.canonicalMutation"](
      db,
      captureKnowledgeCanonicalFence(db, { batchId: batch.id, runId: batch.runId }),
      "cognition.openLoopCreate",
      [
        {
          id: "rehearsal",
          createdByRun: batch.runId,
          title: "Confirm the rehearsal slot",
          description: "Please confirm the rehearsal slot before Friday.",
          confidence: 0.9,
          importance: 0.7,
          docs: ["input"],
        },
        { runId: batch.runId, priors: [] },
        now,
      ],
    ),
  ).toMatchObject({ ok: true });
  // The loop is due for review at once, and a scheduler tick runs while the
  // discovery that created it is still in flight.
  await engine.tick();
  expect(
    db.prepare("SELECT 1 FROM knowledge_work WHERE subject_id='rehearsal'").get(),
  ).toBeUndefined();
  await engine.completeSource(batch.id, batch.runId, offered.id, offered.inputFingerprint);
  const view = await engine.next(batch.id, batch.runId);
  expect(view.interrupted).toBeUndefined();
  expect(view.items.map((item) => item.id)).toEqual(["rehearsal"]);
});
