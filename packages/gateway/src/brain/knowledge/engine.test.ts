// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, type DecisionCapability } from "@omnesis/core";
import { DERIVATION_STAGES } from "../../domain/DocumentDerivation.js";
import { createTemporalAnnotationTables } from "../../enrichment/temporal-annotations/storage.js";
import { createOpenLoop, updateOpenLoop } from "../storage/open-loops.js";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { OMNESIS_CHAT_SOURCE_ID } from "../../sources/omnesis-chat/ids.js";
import { convertKnowledgeOwner } from "./owner-adapters.js";
import { createKnowledgeSourceTriggers } from "./source-triggers.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { directKnowledgeGate } from "./writer.js";
import { KnowledgeService } from "./service.js";
import { KnowledgeEngine, type KnowledgeEngineDeps } from "./engine.js";
import { KNOWLEDGE_DISCOVERY_POLICY, recordKnowledgeCoverage } from "./discovery.js";
import { listKnowledgeFrontier } from "./work.js";
import {
  advanceKnowledgeCascade,
  getKnowledgeNode,
  recordKnowledgeSourceChange,
  purgeKnowledgeNode,
  saveKnowledgeNode,
} from "./storage.js";

let db: Database.Database, engine: KnowledgeEngine, service: KnowledgeService;
let now: number, serial: number, score: number, decisions: number;
let settings: ReturnType<typeof resolveBrainSettings>;
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
  settings = resolveBrainSettings({ bootstrap: { enabled: false } });
  const writeGate = directKnowledgeGate(db);
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
    ).toEqual([{ input_revision: "v2" }]);
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
    const view = await engine.next(batch.id, batch.runId);
    expect(view.items[0]!.orientation?.map((node) => node.id)).toContain("project");
    expect(view.items[0]!.node!.plainText).toBe("");
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
    await engine.saveNode(batch.id, batch.runId, repair.id, repair.inputFingerprint, {
      id: "project",
      kind: "wiki",
      title: "project",
      markdown:
        '<claim id="fact" refs="source:new-evidence">The workshop now begins Saturday.</claim>',
      expectedRevision: repair.node!.revision,
      inputVersions: { "source:new-evidence": "v1" },
    });
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
      "UPDATE knowledge_claims SET verification='verified' WHERE node_id='reviewed'",
    ).run();
    db.exec("DELETE FROM knowledge_changes");
    await engine.tick();
    const batch = batchFor("reviewed");
    const offered = (await engine.next(batch.id, batch.runId)).items.find(
      (item) => item.id === "reviewed",
    )!;
    await directKnowledgeGate(db)["knowledge.settleFrontier"](
      {
        outcome: {
          batchId: batch.id,
          runId: batch.runId,
          nodeId: offered.id,
          inputFingerprint: offered.inputFingerprint,
          status: "unchanged",
          resultRevision: offered.node!.revision,
        },
        append: [],
      },
      now,
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
    await engine.saveNode(batch.id, batch.runId, offered.id, offered.inputFingerprint, {
      id: "overdue",
      kind: "wiki",
      title: "Overdue context",
      markdown,
      expectedRevision: offered.node!.revision,
      inputVersions: { "source:input": "v1" },
    });
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
    engine.deps.writeGate["knowledge.settleFrontier"] = async (...args) => {
      const result = await settle(...args);
      purgeKnowledgeNode(db, "project", now);
      return result;
    };
    await expect(
      engine.saveNode(batch.id, batch.runId, offered.id, offered.inputFingerprint, {
        id: "project",
        kind: "wiki",
        title: "project",
        markdown: '<claim id="fact" refs="source:input">The workshop begins Friday.</claim>',
        expectedRevision: offered.node!.revision,
        inputVersions: { "source:input": "v1" },
      }),
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
      engine.saveNode(batch.id, batch.runId, offered.id, offered.inputFingerprint, {
        id: "project",
        kind: "wiki",
        title: "project",
        markdown: '<claim id="fact" refs="source:input">A late write.</claim>',
        expectedRevision: offered.node!.revision,
        inputVersions: { "source:input": "v1" },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    expect(getKnowledgeNode(db, "project")!.revision).toBe(offered.node!.revision);
  });

  it("reserves the source frontier namespace from synthesis identities", async () => {
    await expect(
      service.save({
        id: "source:ambiguous",
        kind: "wiki",
        title: "Context",
        markdown: "",
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
    await engine.saveNode(batch.id, batch.runId, offered.id, offered.inputFingerprint, {
      id: "parent",
      kind: "wiki",
      title: "Workshop",
      markdown: markdown.replace("Friday", "Saturday"),
      expectedRevision: offered.node!.revision,
      inputVersions: { "source:a": "v2", "source:b": "v1" },
    });
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
      await engine.saveNode(batch.id, batch.runId, repair.id, repair.inputFingerprint, {
        id: "project",
        kind: "wiki",
        title: "project",
        markdown: `<claim id="fact" refs="source:input">The workshop begins ${day}.</claim>`,
        expectedRevision: repair.node!.revision,
        inputVersions: { "source:input": version },
      });
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
    await engine.saveNode(batch.id, batch.runId, parent.id, parent.inputFingerprint, {
      id: "parent",
      kind: "wiki",
      title: "parent",
      markdown: '<claim id="fact" refs="source:input">The workshop begins Friday.</claim>',
      expectedRevision: parent.node!.revision,
      inputVersions: { "source:input": "v1" },
    });
    await engine.next(batch.id, batch.runId);
    source("input", "v2");
    now++;
    await engine.tick();
    batch = batchFor("input");
    offered = (await engine.next(batch.id, batch.runId)).items.find((item) => item.source)!;
    await engine.completeSource(batch.id, batch.runId, offered.id, offered.inputFingerprint);
    parent = (await engine.next(batch.id, batch.runId)).items.find((item) => item.id === "parent")!;
    const saved = await engine.saveNode(batch.id, batch.runId, parent.id, parent.inputFingerprint, {
      id: "parent",
      kind: "wiki",
      title: "parent",
      markdown: '<claim id="fact" refs="source:input">The workshop begins Friday.</claim>',
      expectedRevision: parent.node!.revision,
      inputVersions: { "source:input": "v2" },
    });
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
