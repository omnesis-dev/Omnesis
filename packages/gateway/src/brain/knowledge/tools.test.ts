// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { outcomeProposal, prepareOutcomeRecordContext } from "../record-check/outcome-context.js";
import { captureOutcomeWriteFence } from "../storage/outcome-write-fence.js";
import { RECORD_CHECK_RUBRIC_VERSION } from "../record-check/rubric.js";
import {
  createTemporalAnnotationTables,
  markTemporalAnnotationsRefilePresented,
} from "../../enrichment/temporal-annotations/storage.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createOpenLoop, getOpenLoop } from "../storage/open-loops.js";
import { createDecisionPayloadTables } from "../decision-payload.js";
import { resolveBrainSettings } from "../config.js";
import { withGrantedMutationsOnly } from "../steward/runtime.js";
import { makeOutcomeAssessment, persistOutcomeAssessment } from "./outcome-assessment.js";
import { checkKnowledgeOutcome } from "./outcome-check.js";
import { convertKnowledgeOwner } from "./owner-adapters.js";
import { buildKnowledgeTools } from "./tools.js";
import { WIKI_AUTHORING_GUIDANCE } from "./wiki-authoring.js";
import { KnowledgeEngine } from "./engine.js";
import { KnowledgeService } from "./service.js";
import { createKnowledgeTables, getKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { proposeKnowledgeCandidate } from "./discovery.js";
import { directKnowledgeGate } from "./writer.js";
import type { RecordCheckInput } from "../record-check/check.js";
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
  expect(save.description).not.toContain(WIKI_AUTHORING_GUIDANCE);
  expect(save.description).toContain("Create a synthesis page or replace a full one");
  expect(save.description).toContain("node.claimRemovals");
  expect(save.description).toContain(
    "reviewedClaimIds reports review and does not authorize removal",
  );
  expect(save.description).toContain("Every nonblank synthesis text span must be covered by tags");
});

it("exposes only owner-specific saves within narrowed artifact grants, without wiki/root mutation", () => {
  const scoped = buildKnowledgeTools(service, { runId: "run", scopedOwnersOnly: true });
  const digest = withGrantedMutationsOnly(
    scoped,
    run("daily", { digest: true, date: "2026-01-02" }),
  );
  expect(digest.filter((entry) => entry.mutates).map((entry) => entry.name)).toEqual([]);
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
  createOpenLoop(
    db,
    {
      id: "notice",
      createdByRun: "run",
      title: "Workshop",
      description: "Workshop Friday.",
      state: "open",
      importance: 0.5,
      confidence: 0.7,
      docs: ["evidence"],
    },
    1,
  );
  const tool = buildKnowledgeTools(service, { runId: "run", scopedOwnersOnly: true }).find(
    (entry) => entry.name === "loop_synthesis_save",
  )!;
  const input = {
    id: "notice",
    title: "Workshop",
    markdown: '<claim id="date" refs="source:evidence">Workshop Friday.</claim>',
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
  expect(await tool.invoke(input, context)).toMatchObject({ kind: "structured" });
  expect(getKnowledgeNode(db, "notice")).toMatchObject({ kind: "loop", ownerId: "notice" });
  expect(getKnowledgeNode(db, "notice")?.markdown).toContain("<claim");
  expect(getOpenLoop(db, "notice")).toMatchObject({
    description: "Workshop Friday.",
    state: "open",
  });
});
it("offers no scoped synthesis save for observations", () => {
  const names = buildKnowledgeTools(service, { runId: "run", scopedOwnersOnly: true }).map(
    (entry) => entry.name,
  );
  expect(names.filter((name) => name.endsWith("_synthesis_save")).sort()).toEqual([
    "doc_annotation_synthesis_save",
    "loop_synthesis_save",
    "person_annotation_synthesis_save",
  ]);
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
  const preflight = vi.spyOn(engine, "preflightSaveNode");
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
  expect(preflight).not.toHaveBeenCalled();
  expect(await save.invoke({ node, inputFingerprint: "stale-fingerprint" }, context)).toMatchObject(
    {
      kind: "error",
      code: "revision_conflict",
    },
  );
  expect(preflight).toHaveBeenCalledExactlyOnceWith(
    "batch",
    "run",
    "workshop",
    "stale-fingerprint",
  );
  expect(saveNode).not.toHaveBeenCalled();
});

it.each([false, true])(
  "requires observed creation context and permits independent repairs (parallel=%s)",
  async (parallel) => {
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
    db.exec("INSERT INTO documents VALUES('materials','Workshop materials allocated.','v2')");
    const node = {
      id: "workshop",
      kind: "wiki",
      title: "Workshop",
      markdown:
        '<claim id="date" refs="source:evidence">Workshop Friday.</claim><claim id="materials" refs="source:materials">Workshop materials allocated.</claim>',
      expectedRevision: 0,
      inputVersions: { "source:evidence": "v1", "source:materials": "v2" },
    };
    const maintenanceTools = buildKnowledgeTools(service, {
      runId: "run",
      batchId: "batch",
      engine,
      parallel,
    });
    const maintenanceSave = maintenanceTools.find((entry) => entry.name === "knowledge_save")!;
    const args = {
      node,
      candidateId: "candidate",
      creationAssessment: {
        reason: "Distinct workshop planning scope after inspecting related pages.",
        relatedPageIds: [],
      },
    };
    expect(await maintenanceSave.invoke(args, context)).toMatchObject({
      kind: "error",
      code: "revision_conflict",
    });
    await maintenanceTools
      .find((t) => t.name === "knowledge_list")!
      .invoke({ kind: "wiki" }, context);
    await maintenanceTools.find((t) => t.name === "knowledge_candidates")!.invoke({}, context);
    expect(await maintenanceSave.invoke(args, context)).toMatchObject({
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
  },
);

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
          sourceRevision: "v1",
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

it("returns actionable reference syntax errors without leaking existence and accepts a corrected source ref", async () => {
  const reference = buildKnowledgeTools(service, { runId: "run" }).find(
    (tool) => tool.name === "knowledge_reference",
  )!;
  const malformed = await Promise.all(
    ["doc:evidence", "doc:absent", "document:evidence", "document:absent"].map((ref) =>
      reference.invoke({ ref }, context),
    ),
  );
  for (const result of malformed) expect(result).toEqual(malformed[0]);
  expect(malformed[0]).toMatchObject({
    kind: "error",
    code: "reference_invalid",
    message: expect.stringContaining("Use source:<documentId> for a whole fetched document"),
  });
  const selector = await reference.invoke({ ref: "source:evidence#claim:date" }, context);
  expect(selector).toMatchObject({
    kind: "error",
    code: "reference_invalid",
    message: expect.stringContaining("source:<documentId>#evidence:<evidenceId>"),
  });
  expect(await reference.invoke({ ref: "source:evidence" }, context)).toMatchObject({
    kind: "structured",
    data: { ref: "source:evidence", revision: "v1", text: "Workshop Friday." },
  });
});

it("requires an actual bounded library read before a maintenance root save reaches the engine", async () => {
  createKnowledgeWorkTables(db);
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','fingerprint','routine','running',1,1)",
  );
  const saved = await service.save({
    id: "root",
    kind: "root",
    title: "Current context",
    markdown: "",
    expectedRevision: 0,
    inputVersions: {},
  });
  const log = createLogger("root-inspection-test");
  const engine = new KnowledgeEngine({
    db,
    service,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log,
    decisions: { getDecision: () => null, log, recordSpend: async () => {} },
  });
  // This test isolates the library-read prerequisite from frontier freshness;
  // the stale-frontier tests below exercise the real preflight independently.
  const preflight = vi.spyOn(engine, "preflightSaveNode").mockReturnValue({
    batchId: "batch",
    nodeId: "root",
    inputFingerprint: "fingerprint",
    inputVersions: {},
    depth: 0,
    status: "offered",
    resultRevision: null,
    attempts: 0,
  });
  const writer = vi.spyOn(engine, "saveNode").mockResolvedValue(saved);
  const entries = buildKnowledgeTools(service, { runId: "run", batchId: "batch", engine });
  const input = {
    node: {
      id: "root",
      kind: "root",
      title: "Current context",
      markdown: "",
      expectedRevision: saved.node.revision,
      inputVersions: {},
    },
    inputFingerprint: "fingerprint",
  };
  const save = entries.find((t) => t.name === "knowledge_save")!;
  expect(await save.invoke(input, context)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
    message: expect.stringContaining("knowledge_list"),
  });
  expect(writer).not.toHaveBeenCalled();
  expect(preflight).not.toHaveBeenCalled();
  // A mixed first page may contain only loops or annotations, not the wiki inventory.
  await entries.find((t) => t.name === "knowledge_list")!.invoke({ limit: 1 }, context);
  expect(await save.invoke(input, context)).toMatchObject({ kind: "error" });
  expect(writer).not.toHaveBeenCalled();
  expect(
    await entries
      .find((t) => t.name === "knowledge_list")!
      .invoke({ kind: "wiki", limit: 1 }, context),
  ).toMatchObject({ kind: "structured" });
  expect(await save.invoke(input, context)).toMatchObject({ kind: "structured" });
  expect(preflight).toHaveBeenCalledExactlyOnceWith("batch", "run", "root", "fingerprint");
  expect(writer).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "gates canonical loop prose through synthesis saves (scoped=%s) without rejudging proof-only saves",
  async (scopedOwnersOnly) => {
    createOpenLoop(
      db,
      {
        id: "outcome",
        createdByRun: "run",
        title: "Workshop plan",
        description: "Workshop Friday.",
        state: "open",
        importance: 0.5,
        confidence: 0.8,
        docs: ["evidence"],
      },
      1,
    );
    convertKnowledgeOwner(db, "loop", "outcome", 1);
    const approved = captureOutcomeWriteFence(db, "outcome", ["evidence"]);
    db.transaction(() =>
      persistOutcomeAssessment(
        db,
        "outcome",
        makeOutcomeAssessment(
          RECORD_CHECK_RUBRIC_VERSION,
          outcomeProposal(getOpenLoop(db, "outcome")!),
          approved.sources,
          "approved",
          null,
        ),
        approved.sources,
        1,
      ),
    )();
    const checkRecord = vi.fn(async () => ({
      save: false as const,
      score: 0.1,
      threshold: 0.8,
      decisionId: "decision",
    }));
    const entries = buildKnowledgeTools(service, { runId: "run", scopedOwnersOnly, checkRecord });
    const save = entries.find(
      (entry) => entry.name === (scopedOwnersOnly ? "loop_synthesis_save" : "knowledge_save"),
    )!;
    const before = service.fetch("outcome", true)!;
    const base = {
      id: "outcome",
      title: "Workshop plan",
      expectedRevision: before.revision,
      inputVersions: { "source:evidence": "v1" },
    };
    const argumentsFor = (markdown: string) =>
      scopedOwnersOnly
        ? { ...base, markdown }
        : { node: { ...base, kind: "loop", ownerId: "outcome", markdown } };
    expect(
      await save.invoke(
        argumentsFor('<claim id="changed" refs="source:evidence">Workshop completed.</claim>'),
        context,
      ),
    ).toMatchObject({ kind: "structured", resultType: "record.not_saved" });
    expect(checkRecord).toHaveBeenCalledTimes(1);
    expect(getOpenLoop(db, "outcome")?.description).toBe("Workshop Friday.");
    expect(service.fetch("outcome", true)?.revision).toBe(before.revision);
    await save.invoke(argumentsFor(before.markdown), context);
    expect(checkRecord).toHaveBeenCalledTimes(1);
  },
);

it("includes source ancestry and self-role hints for synthesis-supported outcome checks", () => {
  createDecisionPayloadTables(db);
  db.exec(
    "CREATE TABLE people(id TEXT PRIMARY KEY,is_self INTEGER); INSERT INTO people VALUES('actor',1)",
  );
  createOpenLoop(
    db,
    {
      id: "support",
      createdByRun: "run",
      title: "Workshop plan",
      description: "Workshop Friday.",
      state: "open",
      importance: 0.5,
      confidence: 0.8,
      docs: ["evidence"],
      actors: ["actor"],
    },
    1,
  );
  convertKnowledgeOwner(db, "loop", "support", 1);
  const prepared = prepareOutcomeRecordContext(db, {
    documentIds: [],
    supportingNodeIds: ["support"],
    previous: null,
    proposed: {
      title: "Workshop plan",
      description: "Workshop Friday.",
      state: "open",
      deadline: null,
      actors: ["actor"],
    },
    now: 10,
  });
  expect(prepared?.context).toMatchObject({
    proposed_actor_roles: [{ id: "actor", is_self: true }],
    sources: [{ id: "evidence", text: "Workshop Friday.", truncated: false }],
  });
  expect(prepared?.payloadCapture.subjects).toEqual(
    expect.arrayContaining([
      { kind: "node", id: "support" },
      { kind: "source", id: "evidence" },
    ]),
  );
});

it.each(["source", "owner"])(
  "refuses synthesis outcome writes when judged %s context changes before commit",
  async (change) => {
    db.prepare("INSERT INTO documents VALUES(?,?,?)").run(
      "context",
      "Additional workshop context.",
      "context-v1",
    );
    createOpenLoop(
      db,
      {
        id: "outcome",
        createdByRun: "run",
        title: "Workshop plan",
        description: "Workshop Friday.",
        state: "open",
        importance: 0.5,
        confidence: 0.8,
        docs: ["evidence", "context"],
      },
      1,
    );
    convertKnowledgeOwner(db, "loop", "outcome", 1);
    const before = service.fetch("outcome", true)!;
    const checkRecord = vi.fn(async () => {
      if (change === "source")
        db.prepare(
          "UPDATE documents SET content='Updated context.',content_hash='context-v2' WHERE id='context'",
        ).run();
      else db.prepare("UPDATE open_loops SET state='done' WHERE id='outcome'").run();
      return { save: true as const };
    });
    const save = buildKnowledgeTools(service, { runId: "run", checkRecord }).find(
      (entry) => entry.name === "knowledge_save",
    )!;
    const result = await save.invoke(
      {
        node: {
          id: "outcome",
          ownerId: "outcome",
          kind: "loop",
          title: "Revised workshop plan",
          markdown: '<claim id="revised" refs="source:evidence">Workshop Friday.</claim>',
          expectedRevision: before.revision,
          inputVersions: { "source:evidence": "v1" },
        },
      },
      context,
    );
    expect(result).toMatchObject({ kind: "error", code: "revision_conflict" });
    expect(checkRecord).toHaveBeenCalledOnce();
    expect(getOpenLoop(db, "outcome")?.title).toBe("Workshop plan");
    expect(service.fetch("outcome", true)?.revision).toBe(before.revision);
  },
);

it("prioritizes a newly appended synthesis source beyond nine retained claim refs", async () => {
  createDecisionPayloadTables(db);
  const oldIds = Array.from({ length: 9 }, (_, i) => `prior-${i}`);
  for (const id of [...oldIds, "new-support"])
    db.prepare("INSERT INTO documents VALUES(?,?,?)").run(
      id,
      `Observation context ${id}.`,
      `${id}-v1`,
    );
  createOpenLoop(
    db,
    {
      id: "priority-loop",
      createdByRun: "run",
      title: "Observation plan",
      description: "Arrange the briefing.",
      confidence: 0.8,
      importance: 0.6,
      docs: oldIds,
    },
    1,
  );
  convertKnowledgeOwner(db, "loop", "priority-loop", 1);
  // Existing converted claims cite all nine documents. The new source is last
  // in the proposed ref list, as happens when an agent appends fresh evidence.
  const refs = [...oldIds, "new-support"].map((id) => `source:${id}`).join(" ");
  const check = vi.fn(async (_input: RecordCheckInput) => ({ save: true as const }));
  await checkKnowledgeOutcome(service, check, {
    id: "priority-loop",
    kind: "loop",
    title: "Observation plan",
    markdown: `<claim id="legacy" refs="${refs}">Arrange the briefing after approval.</claim>`,
  });
  expect(check).toHaveBeenCalledOnce();
  const input = check.mock.calls[0]![0];
  expect(input.outcomeContext?.sources[0]?.id).toBe("new-support");
  expect(input.outcomeContext?.sources).toHaveLength(8);
  expect(input.outcomeContext?.sources_omitted).toBe(2);
  expect(input.payloadCapture?.subjects.filter((s) => s.kind === "source")).toHaveLength(10);
});

it.each(["revision", "source", "frontier"] as const)(
  "rejects stale %s before any outcome check or verifier",
  async (stale) => {
    createDecisionPayloadTables(db);
    createOpenLoop(
      db,
      {
        id: "preflight-loop",
        createdByRun: "run",
        title: "Observation plan",
        description: "Workshop Friday.",
        confidence: 0.8,
        importance: 0.6,
        docs: ["evidence"],
      },
      1,
    );
    convertKnowledgeOwner(db, "loop", "preflight-loop", 1);
    const before = service.fetch("preflight-loop", true)!;
    const verifier = vi.fn(async () => null);
    service.deps.getEntailmentVerifier = verifier;
    const checkRecord = vi.fn(async () => ({ save: true as const }));
    let engine: KnowledgeEngine | undefined;
    if (stale === "frontier") {
      createKnowledgeWorkTables(db);
      db.exec(
        "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('preflight-batch','run','seed','routine','running',1,1)",
      );
      db.exec(
        "INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES('preflight-batch','preflight-loop','offered','{}',0,'offered')",
      );
      const log = createLogger("preflight-test");
      engine = new KnowledgeEngine({
        db,
        service,
        writeGate: directKnowledgeGate(db),
        getSettings: () => resolveBrainSettings(),
        clock: () => 10,
        log,
        decisions: { getDecision: () => null, log, recordSpend: async () => {} },
      });
    }
    const save = buildKnowledgeTools(service, {
      runId: "run",
      checkRecord,
      ...(engine ? { batchId: "preflight-batch", engine } : {}),
    }).find((t) => t.name === "knowledge_save")!;
    const result = await save.invoke(
      {
        node: {
          id: before.id,
          ownerId: before.ownerId,
          kind: before.kind,
          title: "Observation briefing",
          markdown: '<claim id="legacy" refs="source:evidence">Workshop Friday.</claim>',
          expectedRevision: before.revision + (stale === "revision" ? 1 : 0),
          inputVersions: { "source:evidence": stale === "source" ? "old" : "v1" },
        },
        ...(engine ? { inputFingerprint: "stale-fingerprint" } : {}),
      },
      context,
    );
    expect(result).toMatchObject({ kind: "error", code: "revision_conflict" });
    expect(checkRecord).not.toHaveBeenCalled();
    expect(verifier).not.toHaveBeenCalled();
    expect(service.fetch(before.id, true)?.revision).toBe(before.revision);
  },
);

it("direct service saves reject stale dependency evidence before loading a verifier", async () => {
  const verifier = vi.fn(async () => null);
  service.deps.getEntailmentVerifier = verifier;
  await expect(
    service.save({
      id: "new-page",
      kind: "wiki",
      title: "Observation session",
      markdown: '<claim id="plan" refs="source:evidence">Workshop Friday.</claim>',
      expectedRevision: 0,
      inputVersions: { "source:evidence": "old" },
    }),
  ).rejects.toMatchObject({ code: "revision_conflict" });
  expect(verifier).not.toHaveBeenCalled();
});

it("batch reference reads preserve singular compatibility and reject mixed or oversized argument lists", async () => {
  const tool = buildKnowledgeTools(service, { runId: "run" }).find(
    (item) => item.name === "knowledge_reference",
  )!;
  expect(await tool.invoke({ ref: "source:evidence" }, context)).toMatchObject({
    kind: "structured",
    data: { ref: "source:evidence", revision: "v1" },
  });
  expect(
    await tool.invoke({ refs: ["source:evidence", "source:missing", "source:evidence"] }, context),
  ).toMatchObject({
    kind: "structured",
    data: {
      items: [
        { ok: true, value: { ref: "source:evidence" } },
        { ok: false, ref: "source:missing" },
      ],
      deferredRefs: [],
    },
  });
  for (const input of [
    { refs: [] },
    { ref: "source:evidence", refs: ["source:evidence"] },
    { refs: Array(17).fill("source:evidence") },
    { refs: Array.from({ length: 16 }, (_, i) => `source:${i}${"界".repeat(1000)}`) },
    { refs: Array.from({ length: 16 }, (_, i) => `source:${i}${"\u0001".repeat(1000)}`) },
  ])
    expect(await tool.invoke(input, context)).toMatchObject({
      kind: "error",
      code: "invalid_arguments",
    });
});

it("uses only the exact registered quote receipt and preserves explicit stale overrides", async () => {
  const tools = buildKnowledgeTools(service, { runId: "run" });
  const register = tools.find((tool) => tool.name === "knowledge_evidence")!;
  const save = tools.find((tool) => tool.name === "knowledge_save")!;
  const evidence = await register.invoke(
    { documentId: "evidence", contentHash: "v1", quote: "Workshop Friday." },
    context,
  );
  if (evidence.kind !== "structured") throw new Error("Expected evidence registration");
  const registered = evidence.data as { ref: string; revision: string };
  expect(registered.revision).toBe("v1");
  const node = {
    id: "root-registered",
    kind: "root",
    title: "Workshop",
    markdown: `<claim id="date" refs="${registered.ref}">Workshop Friday.</claim>`,
    expectedRevision: 0,
  };
  expect(await save.invoke({ node }, context)).toMatchObject({ kind: "structured" });
  expect(
    await save.invoke(
      { node: { ...node, expectedRevision: 1, inputVersions: { [registered.ref]: "old" } } },
      context,
    ),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(
    await save.invoke(
      {
        node: {
          ...node,
          expectedRevision: 1,
          markdown: '<claim id="date" refs="source:evidence">Workshop Friday.</claim>',
        },
      },
      context,
    ),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(getKnowledgeNode(db, node.id)?.revision).toBe(1);
});

it.each([false, true])(
  "returns bounded placement feedback only while its evidence remains readable (removed=%s)",
  async (removed) => {
    const input = {
      id: "orientation",
      kind: "root" as const,
      title: "Current orientation",
      markdown: '<claim id="date" refs="source:evidence">Workshop Friday.</claim>',
      expectedRevision: 0,
      inputVersions: { "source:evidence": "v1" },
    };
    await service.save(input);
    const reason = "The source does not link this workshop to the named observatory project.";
    const raw = JSON.stringify({
      contentInContext: {
        verdict: "supported",
        reason: "The date is stated.",
        evidenceQuotes: ["Workshop Friday."],
      },
      placementSupport: { verdict: "unsupported", reason, evidenceQuotes: [] },
      omittedDebug: "not returned",
    });
    const judged = new KnowledgeService({
      ...service.deps,
      getEntailmentVerifier: async () => ({
        dispose: async () => {},
        verify: async () => {
          if (removed) db.prepare("DELETE FROM documents WHERE id='evidence'").run();
          return { label: "neutral" as const, raw };
        },
      }),
    });
    const save = buildKnowledgeTools(judged, { runId: "background-review" }).find(
      (tool) => tool.name === "knowledge_save",
    )!;
    const result = await save.invoke(
      { node: { ...input, title: "Observatory project", expectedRevision: 1 } },
      context,
    );
    expect(result.kind).toBe("error");
    if (result.kind !== "error") throw new Error("Expected a refused write");
    expect(result.message).not.toContain("omittedDebug");
    if (removed) {
      expect(result.message).not.toContain(reason);
      expect(result.code).toBe("reference_invalid");
    } else {
      expect(result.code).toBe("claim_invalid");
      expect(result.message).toContain("placement_support");
      expect(result.message).toContain(reason);
      expect(result.message).toContain("do not repeat the unchanged proposal");
    }
    expect(
      db.prepare("SELECT revision,title FROM knowledge_nodes WHERE id='orientation'").get(),
    ).toEqual({ revision: 1, title: "Current orientation" });
  },
);
