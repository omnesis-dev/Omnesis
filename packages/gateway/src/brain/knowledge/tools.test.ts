// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import {
  createTemporalAnnotationTables,
  markTemporalAnnotationsRefilePresented,
} from "../../enrichment/temporal-annotations/storage.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createBrief, getBrief } from "../storage/briefs.js";
import { resolveBrainSettings } from "../config.js";
import { withGrantedMutationsOnly } from "../steward/runtime.js";
import { buildKnowledgeTools } from "./tools.js";
import { WIKI_AUTHORING_GUIDANCE } from "./wiki-authoring.js";
import { KnowledgeEngine } from "./engine.js";
import { KnowledgeService } from "./service.js";
import { createKnowledgeTables, getKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { proposeKnowledgeCandidate } from "./discovery.js";
import { directKnowledgeGate } from "./writer.js";
import type { ClaimedCognitionRun } from "../storage/types.js";

let db: Database.Database;
let service: KnowledgeService;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('evidence','Workshop Friday.','v1')",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log: createLogger("knowledge-tools-test"),
  });
});
afterEach(() => db.close());
function run(kind: ClaimedCognitionRun["kind"], payload: unknown): ClaimedCognitionRun {
  return { id: "run", kind, payload, payloadJson: JSON.stringify(payload), attempts: 1 };
}
const context = { sessionId: "session", messageId: "message" };
it("accepts the null owner identity returned when reading a root page", async () => {
  await service.save({
    id: "root",
    kind: "root",
    title: "Current context",
    markdown: '<claim id="date" refs="source:evidence">Workshop Friday.</claim>',
    expectedRevision: 0,
    inputVersions: { "source:evidence": "v1" },
  });
  const node = service.fetch("root", true)!;
  expect(node.ownerId).toBeNull();
  const save = buildKnowledgeTools(service, { runId: "run" }).find(
    (entry) => entry.name === "knowledge_save",
  )!;
  expect(
    await save.invoke(
      {
        node: {
          id: node.id,
          kind: node.kind,
          ownerId: node.ownerId,
          title: node.title,
          markdown: node.markdown,
          expectedRevision: node.revision,
          inputVersions: { "source:evidence": "v1" },
        },
      },
      context,
    ),
  ).toMatchObject({ kind: "structured" });
  expect(getKnowledgeNode(db, "root")?.revision).toBe(2);
});
it("bounds maintenance-input paging and binds it to the tool's run and batch", async () => {
  createKnowledgeWorkTables(db);
  const log = createLogger("knowledge-tools-test");
  const engine = new KnowledgeEngine({
    db,
    service,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log,
    decisions: { getDecision: () => null, log, recordSpend: async () => {} },
  });
  const inputs = buildKnowledgeTools(service, {
    runId: "run",
    batchId: "missing-batch",
    engine,
  }).find((entry) => entry.name === "knowledge_maintenance_inputs")!;
  expect(inputs.mutates).toBe(false);
  expect(await inputs.invoke({ id: "page", limit: 33 }, context)).toMatchObject({
    kind: "error",
    code: "invalid_arguments",
  });
  expect(await inputs.invoke({ id: "page", batchId: "another-batch" }, context)).toMatchObject({
    kind: "error",
    code: "invalid_arguments",
  });
  expect(await inputs.invoke({ id: "page" }, context)).toMatchObject({ kind: "error" });
  expect(
    buildKnowledgeTools(service, { runId: "run" }).some(
      (entry) => entry.name === "knowledge_maintenance_inputs",
    ),
  ).toBe(false);
});
it("describes canonical operations and fresh reads before a terminal maintenance save", () => {
  const save = buildKnowledgeTools(service, { runId: "run" }).find(
    (entry) => entry.name === "knowledge_save",
  )!;
  expect(save.description).toContain(
    "operational mutations must succeed BEFORE this terminal save",
  );
  expect(save.description).toContain("state, deadline, retirement, and ledger changes");
  expect(save.description).toContain("knowledge_next_frontier and knowledge_fetch(editing=true)");
  expect(save.description).toContain("required canonical action is refused or incomplete");
  expect(save.description).toContain(WIKI_AUTHORING_GUIDANCE);
});

it("exposes only owner-specific saves within narrowed artifact grants, without wiki/root mutation", () => {
  const scoped = buildKnowledgeTools(service, { runId: "run", scopedOwnersOnly: true });
  const digest = withGrantedMutationsOnly(
    scoped,
    run("daily", { digest: true, date: "2026-01-02" }),
  );
  expect(digest.filter((entry) => entry.mutates).map((entry) => entry.name)).toEqual([
    "brief_synthesis_save",
  ]);
  const memory = withGrantedMutationsOnly(scoped, run("verification", {}));
  expect(
    memory
      .filter((entry) => entry.mutates)
      .map((entry) => entry.name)
      .sort(),
  ).toEqual(["doc_annotation_synthesis_save", "person_annotation_synthesis_save"]);
  expect(digest.some((entry) => entry.name === "knowledge_reference")).toBe(true);
  expect(scoped.some((entry) => entry.name === "knowledge_save")).toBe(false);
  const broad = buildKnowledgeTools(service, { runId: "run" });
  expect(broad.some((entry) => entry.name === "knowledge_save")).toBe(true);
  expect(broad.some((entry) => entry.name.endsWith("_synthesis_save"))).toBe(false);
});
it("binds scoped saves to an existing canonical owner and rejects kind or field escalation", async () => {
  createBrief(
    db,
    {
      id: "notice",
      createdByRun: "run",
      kind: "info",
      title: "Workshop",
      description: "Workshop Friday.",
      confidence: 0.7,
      urgency: 0.3,
      citations: ["evidence"],
    },
    1,
  );
  const tool = buildKnowledgeTools(service, { runId: "run", scopedOwnersOnly: true }).find(
    (entry) => entry.name === "brief_synthesis_save",
  )!;
  const input = {
    id: "notice",
    title: "Workshop",
    markdown:
      '<claim id="date" refs="source:evidence">## Description\nWorkshop Friday.\n\n## Body\n</claim>',
    expectedRevision: 0,
    inputVersions: { "source:evidence": "v1" },
  };
  expect(await tool.invoke({ ...input, kind: "wiki" }, context)).toMatchObject({
    kind: "error",
    code: "invalid_arguments",
  });
  expect(
    await tool.invoke({ ...input, canonicalFields: { state: "dismissed" } }, context),
  ).toMatchObject({ kind: "error", code: "invalid_arguments" });
  expect(await tool.invoke({ ...input, id: "missing" }, context)).toMatchObject({
    kind: "error",
    code: "reference_invalid",
  });
  const state = getBrief(db, "notice")!.state;
  expect(await tool.invoke(input, context)).toMatchObject({ kind: "structured" });
  expect(getKnowledgeNode(db, "notice")).toMatchObject({ kind: "brief", ownerId: "notice" });
  expect(getKnowledgeNode(db, "notice")?.markdown).toContain("<claim");
  expect(getBrief(db, "notice")?.description).toBe("Workshop Friday.");
  expect(getBrief(db, "notice")?.state).toBe(state);
});

it("rejects missing and blank maintenance fingerprints before consulting the engine", async () => {
  createKnowledgeWorkTables(db);
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','fingerprint','routine','running',1,1)",
  );
  const log = createLogger("knowledge-tools-test");
  const engine = new KnowledgeEngine({
    db,
    service,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log,
    decisions: { getDecision: () => null, log, recordSpend: async () => {} },
  });
  const saveNode = vi.spyOn(engine, "saveNode");
  const save = buildKnowledgeTools(service, { runId: "run", batchId: "batch", engine }).find(
    (entry) => entry.name === "knowledge_save",
  )!;
  const node = {
    id: "workshop",
    kind: "wiki",
    title: "Workshop",
    markdown: '<claim id="date" refs="source:evidence">Workshop Friday.</claim>',
    expectedRevision: 1,
    inputVersions: { "source:evidence": "v1" },
  };
  for (const inputFingerprint of [undefined, "", " \t\n"]) {
    expect(await save.invoke({ node, inputFingerprint }, context)).toMatchObject({
      kind: "error",
      code: "claim_invalid",
      message: expect.stringContaining("inputFingerprint at the top level beside node"),
    });
  }
  expect(saveNode).not.toHaveBeenCalled();
  expect(await save.invoke({ node, inputFingerprint: "stale-fingerprint" }, context)).toMatchObject(
    {
      kind: "error",
      code: "revision_conflict",
    },
  );
  expect(saveNode).toHaveBeenCalledOnce();
});

it("allows new maintenance wikis and nonmaintenance revisions without a frontier fingerprint", async () => {
  createKnowledgeWorkTables(db);
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','fingerprint','routine','running',1,1)",
  );
  proposeKnowledgeCandidate(
    db,
    {
      id: "candidate",
      identityKey: "workshop",
      title: "Workshop",
      scope: "Planning",
      evidenceVersions: { evidence: "v1" },
    },
    1,
  );
  const log = createLogger("knowledge-tools-test");
  const engine = new KnowledgeEngine({
    db,
    service,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log,
    decisions: { getDecision: () => null, log, recordSpend: async () => {} },
  });
  const node = {
    id: "workshop",
    kind: "wiki",
    title: "Workshop",
    markdown: '<claim id="date" refs="source:evidence">Workshop Friday.</claim>',
    expectedRevision: 0,
    inputVersions: { "source:evidence": "v1" },
  };
  const maintenanceSave = buildKnowledgeTools(service, {
    runId: "run",
    batchId: "batch",
    engine,
  }).find((entry) => entry.name === "knowledge_save")!;
  expect(await maintenanceSave.invoke({ node, candidateId: "candidate" }, context)).toMatchObject({
    kind: "structured",
  });
  expect(getKnowledgeNode(db, node.id)?.revision).toBe(1);
  const save = buildKnowledgeTools(service, { runId: "run" }).find(
    (entry) => entry.name === "knowledge_save",
  )!;
  expect(await save.invoke({ node: { ...node, expectedRevision: 1 } }, context)).toMatchObject({
    kind: "structured",
  });
  expect(getKnowledgeNode(db, node.id)?.revision).toBe(2);
});

it("rejects mutations from abandoned maintenance tools and at the queued writer boundary", async () => {
  createKnowledgeWorkTables(db);
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','fingerprint','routine','running',1,1)",
  );
  const tools = buildKnowledgeTools(service, { runId: "run", batchId: "batch" });
  db.exec("UPDATE knowledge_batches SET status='abandoned'");
  for (const tool of tools.filter((entry) => entry.mutates)) {
    expect(await tool.invoke({}, context)).toMatchObject({
      kind: "error",
      code: "revision_conflict",
    });
  }
  const fence = { batchId: "batch", runId: "run" };
  expect(() =>
    proposeKnowledgeCandidate(
      db,
      {
        id: "candidate",
        identityKey: "workshop",
        title: "Workshop",
        scope: "Planning",
        evidenceVersions: { evidence: "v1" },
      },
      2,
      fence,
    ),
  ).toThrow("no longer active");
  await expect(
    service.evidence(
      { documentId: "evidence", contentHash: "v1", quote: "Workshop Friday." },
      fence,
    ),
  ).rejects.toThrow("no longer active");
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get()).toEqual({ n: 0 });
});

it("returns terminal frontier for abandoned maintenance while refusing page mutations", async () => {
  createKnowledgeWorkTables(db);
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','fingerprint','routine','abandoned',1,1)",
  );
  const log = createLogger("knowledge-frontier-test");
  const engine = new KnowledgeEngine({
    db,
    service,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log,
    decisions: { getDecision: () => null, log, recordSpend: async () => {} },
  });
  const tools = buildKnowledgeTools(service, { runId: "run", batchId: "batch", engine });
  const frontier = tools.find((entry) => entry.name === "knowledge_next_frontier")!;
  expect(await frontier.invoke({}, context)).toMatchObject({
    kind: "structured",
    data: { done: true, interrupted: true, items: [] },
  });
  expect(
    await tools.find((entry) => entry.name === "knowledge_save")!.invoke({}, context),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  const stolen = buildKnowledgeTools(service, {
    runId: "other-run",
    batchId: "batch",
    engine,
  }).find((entry) => entry.name === "knowledge_next_frontier")!;
  expect(await stolen.invoke({}, context)).toMatchObject({
    kind: "error",
    code: "reference_invalid",
  });
});

it("bounds decorated frontier responses without acknowledging omitted temporal casualties", async () => {
  createKnowledgeWorkTables(db);
  createTemporalAnnotationTables(db);
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','fingerprint','routine','running',1,1)",
  );
  db.prepare(
    "INSERT INTO temporal_annotations(id,interval_start_ms,interval_end_ms,precision,sentence,created_by_run,created_at,updated_at,invalidated_at,invalidation_cause) VALUES('casualty',1,2,'day',?,'previous',1,1,2,'content_change')",
  ).run("Fictional workshop context. ".repeat(400));
  db.exec(
    "INSERT INTO temporal_annotation_documents(annotation_id,document_id) VALUES('casualty','evidence')",
  );
  const settings = resolveBrainSettings();
  settings.knowledge.maxFrontierChars = 3000;
  service.deps.getSettings = () => settings;
  const log = createLogger("knowledge-frontier-test");
  const engine = new KnowledgeEngine({
    db,
    service,
    writeGate: directKnowledgeGate(db),
    getSettings: () => settings,
    clock: () => 10,
    log,
    decisions: { getDecision: () => null, log, recordSpend: async () => {} },
  });
  vi.spyOn(engine, "next").mockResolvedValue({
    batchId: "batch",
    done: false,
    items: [
      {
        id: "source:evidence",
        pendingClaimIds: [],
        depth: 0,
        inputFingerprint: "fingerprint",
        inputVersions: { "source:evidence": "v1" },
        source: {
          id: "evidence",
          title: "Workshop",
          content: "Workshop Friday.",
          contentHash: "v1",
          sourceCreatedAt: null,
          sourceUpdatedAt: null,
        },
      },
    ],
  });
  const mark = vi.fn(async (ids: readonly string[], runId: string) =>
    markTemporalAnnotationsRefilePresented(db, ids, runId),
  );
  const tools = buildKnowledgeTools(service, {
    runId: "run",
    batchId: "batch",
    engine,
    markTemporalPresented: mark,
  });
  const response = await tools
    .find((entry) => entry.name === "knowledge_next_frontier")!
    .invoke({}, context);
  expect(JSON.stringify(response).length).toBeLessThanOrEqual(settings.knowledge.maxFrontierChars);
  expect(response).toMatchObject({
    kind: "structured",
    data: { items: [{ temporal: { contextOmitted: true, hasMoreInvalidated: true } }] },
  });
  expect(mark).not.toHaveBeenCalled();
  expect(
    db
      .prepare("SELECT refile_presented_run AS run FROM temporal_annotations WHERE id='casualty'")
      .get(),
  ).toEqual({ run: null });
  await tools
    .find((entry) => entry.name === "knowledge_temporal_context")!
    .invoke({ documentId: "evidence" }, context);
  expect(mark).toHaveBeenCalledWith(["casualty"], "run");
});
