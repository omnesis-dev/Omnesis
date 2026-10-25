// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createLogger } from "@omnesis/core";
import { resolveBrainSettings } from "../config.js";
import { createKnowledgeTables, getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { snapshotClaimMaintenance } from "./claim-maintenance.js";
import { WikiToolReconciliation } from "./wiki-tool-reconciliation.js";
import { readKnowledgeCollectionRevision } from "./reconciliation.js";
import { buildKnowledgeTools } from "./tools.js";
import { KnowledgeService } from "./service.js";
import { KnowledgeEngine } from "./engine.js";
import { directKnowledgeGate } from "./writer.js";
import { parseClaimMarkup } from "./claims.js";
import { CONTEXTUAL_VERIFIER, knowledgeClaimContexts } from "./claim-context.js";
import { knowledgeClaimFingerprint, knowledgeHash } from "./storage-validation.js";
import { knowledgeOrganizationVersion } from "./organization-context.js";
import { settleKnowledgeFrontier } from "./work.js";
import type { SaveKnowledgeNodeInput } from "./types.js";

let db: Database.Database;
const markdown =
  '<claim id="fact" refs="source:manual">Blue labels identify workshop cabinets.</claim>';
const proposal = (): SaveKnowledgeNodeInput => ({
  id: "cabinet",
  kind: "wiki",
  title: "Cabinet reference",
  markdown,
  expectedRevision: 1,
  inputVersions: { "source:manual": "v1" },
  maintenance: {
    batchId: "batch",
    runId: "run",
    inputFingerprint: "fingerprint",
    reviewedClaimIds: ["fact"],
  },
  runFence: {
    batchId: "batch",
    runId: "run",
    placementLibrary: { collection: "wiki", revision: 0 },
  },
});
beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT)");
  db.exec("INSERT INTO documents VALUES('manual','Blue labels identify workshop cabinets.','v1')");
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  saveKnowledgeNode(
    db,
    { ...proposal(), maintenance: undefined, runFence: undefined, expectedRevision: 0 },
    1,
  );
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','creation','soon','running',1,1)",
  );
  db.exec(
    "INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES('batch','cabinet','fingerprint','{}',0,'offered')",
  );
  db.exec(
    "INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status,batch_id) VALUES('work','cabinet','node','review','1',1,'soon',1,1,1,'batched','batch')",
  );
  snapshotClaimMaintenance(db, {
    batchId: "batch",
    nodeId: "cabinet",
    inputFingerprint: "fingerprint",
  });
});
afterEach(() => db.close());

it("rejects terminal omission atomically without erasing the pending obligation", () => {
  expect(() => saveKnowledgeNode(db, proposal(), 2)).toThrow(/placementAssessment/);
  expect(getKnowledgeNode(db, "cabinet")!.revision).toBe(1);
  expect(db.prepare("SELECT status FROM knowledge_claim_outcomes").get()).toEqual({
    status: "pending",
  });
});
it("allows partial claims and ordinary repair without a placement declaration", () => {
  saveKnowledgeNode(
    db,
    { ...proposal(), maintenance: { ...proposal().maintenance!, reviewedClaimIds: [] } },
    2,
  );
  expect(getKnowledgeNode(db, "cabinet")!.revision).toBe(2);
  db.exec("UPDATE knowledge_work SET reason='change'");
  expect(
    saveKnowledgeNode(db, { ...proposal(), expectedRevision: 2 }, 3).placementAssessment,
  ).toBeUndefined();
});
it("records standalone judgment without related identities or free prose, despite unrelated inventory writes", () => {
  const input = proposal();
  input.maintenance!.placementAssessment = {
    status: "standalone",
    reason: "Distinct reference scope.",
  };
  const saved = saveKnowledgeNode(db, input, 2);
  expect(saved.placementAssessment).toEqual({
    status: "standalone",
    batchId: "batch",
    inputFingerprint: "fingerprint",
    revision: 2,
    assessedAt: 2,
  });
  expect(
    JSON.parse(
      (
        db.prepare("SELECT diff_json FROM knowledge_revisions WHERE revision=2").get() as {
          diff_json: string;
        }
      ).diff_json,
    ).placementAssessment,
  ).toEqual(saved.placementAssessment);
  expect(JSON.stringify(saved.placementAssessment)).not.toContain("Distinct");
});
it("requires library receipt independently of editable node receipt", () => {
  const input = proposal();
  input.runFence = { batchId: "batch", runId: "run" };
  input.maintenance!.placementAssessment = {
    status: "standalone",
    reason: "Distinct reference scope.",
  };
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/knowledge_list/);
  const reconciliation = new WikiToolReconciliation(db, input.runFence);
  reconciliation.readNode(() => getKnowledgeNode(db, "cabinet"));
  expect(() => reconciliation.placementFence(reconciliation.nodeFence("cabinet", 1))).toThrow(
    /knowledge_list/,
  );
  reconciliation.read(
    () => [],
    () => ["pages"],
  );
  db.prepare(
    "UPDATE knowledge_reconciliation_revisions SET revision=revision+1 WHERE collection='wiki'",
  ).run();
  expect(reconciliation.placementFence(input.runFence).placementLibrary?.revision).toBeLessThan(
    readKnowledgeCollectionRevision(db, "wiki"),
  );
});
it("requires actual integrated links, read counterparts and current readable revisions", () => {
  saveKnowledgeNode(
    db,
    {
      ...proposal(),
      id: "workshop",
      title: "Workshop reference",
      maintenance: undefined,
      runFence: undefined,
      expectedRevision: 0,
    },
    1,
  );
  const input = proposal();
  input.maintenance!.placementAssessment = {
    status: "integrated",
    reason: "Cabinet is a workshop detail.",
    links: [{ fromId: "cabinet", toId: "workshop", kind: "part_of", otherRevision: 1 }],
  };
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/counterpart/);
  input.runFence!.placementNodeReads = { workshop: 1 };
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/persisted/);
  db.exec("INSERT INTO knowledge_links VALUES('cabinet','workshop','part_of')");
  db.exec("UPDATE knowledge_nodes SET revision=2 WHERE id='workshop'");
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/current revision/);
  db.exec(
    "UPDATE knowledge_nodes SET revision=1,fields_json='{\"withdrawn\":true}' WHERE id='workshop'",
  );
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/unavailable/);
  db.exec("UPDATE knowledge_nodes SET fields_json='{}' WHERE id='workshop'");
  db.exec("INSERT INTO knowledge_node_tombstones VALUES('workshop',2)");
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/unavailable/);
  expect(getKnowledgeNode(db, "cabinet")!.revision).toBe(1);
  db.exec("DELETE FROM knowledge_node_tombstones WHERE id='workshop'");
  expect(saveKnowledgeNode(db, input, 2).placementAssessment?.status).toBe("integrated");
});
it("preserves accepted prose with deferred outcome and a bounded existing review deadline", () => {
  const input = proposal();
  input.runFence = { batchId: "batch", runId: "run" };
  input.maintenance!.placementAssessment = { status: "deferred", reason: "Need more context." };
  input.maintenance!.placementRetryDelayMs = 0;
  const result = saveKnowledgeNode(db, input, 2);
  expect(result.node.markdown).toBe(markdown);
  expect(result.placementAssessment?.nextReviewAt).toBe(60002);
  expect(result.node.metadata.nextReviewAt).toBe(60002);
  expect(
    db.prepare("SELECT status,due_at AS dueAt FROM knowledge_work WHERE status='pending'").get(),
  ).toEqual({ status: "pending", dueAt: 60002 });
  expect(db.prepare("SELECT status FROM knowledge_work WHERE id='work'").get()).toEqual({
    status: "deferred",
  });
});

it("acquires placement receipts through the real nonparallel maintenance tools", async () => {
  const versions = {
    "node:cabinet": 1,
    "organization:cabinet": knowledgeOrganizationVersion(db, "cabinet"),
    "source:manual": "v1",
  };
  const fingerprint = knowledgeHash(versions);
  db.prepare("DELETE FROM knowledge_claim_outcomes").run();
  db.prepare("UPDATE knowledge_frontier SET input_fingerprint=?,input_versions_json=?").run(
    fingerprint,
    JSON.stringify(versions),
  );
  snapshotClaimMaintenance(db, {
    batchId: "batch",
    nodeId: "cabinet",
    inputFingerprint: fingerprint,
  });
  const log = createLogger("placement-tools-test");
  const service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    clock: () => 2,
    getSettings: () => resolveBrainSettings(),
    log,
  });
  const engine = new KnowledgeEngine({
    db,
    service,
    writeGate: directKnowledgeGate(db),
    clock: () => 2,
    getSettings: () => resolveBrainSettings(),
    log,
    decisions: { getDecision: () => null, log, recordSpend: async () => {} },
  });
  const tools = buildKnowledgeTools(service, {
    batchId: "batch",
    runId: "run",
    engine,
    parallel: false,
  });
  const invoke = (name: string, input: unknown) =>
    tools
      .find((tool) => tool.name === name)!
      .invoke(input, { sessionId: "session", messageId: "message" });
  const node = {
    id: "cabinet",
    kind: "wiki",
    title: "Cabinet reference",
    markdown,
    expectedRevision: 1,
    inputVersions: { "source:manual": "v1" },
  };
  await invoke("knowledge_fetch", { id: "cabinet", editing: true });
  expect(
    await invoke("knowledge_save", {
      node,
      inputFingerprint: fingerprint,
      reviewedClaimIds: ["fact"],
      placementAssessment: { status: "standalone", reason: "Distinct reference scope." },
    }),
  ).toMatchObject({ kind: "error" });
  expect(await invoke("knowledge_list", { kind: "wiki" })).toMatchObject({ kind: "structured" });
  expect(
    await invoke("knowledge_save", {
      node,
      inputFingerprint: fingerprint,
      reviewedClaimIds: ["fact"],
      placementAssessment: { status: "standalone", reason: "Distinct reference scope." },
    }),
  ).toMatchObject({ kind: "structured" });
  expect(db.prepare("SELECT status FROM knowledge_frontier").get()).toEqual({
    status: "unchanged",
  });
});

it("retains the placement obligation when a deferred write commits before settlement fails", () => {
  const input = proposal();
  input.maintenance!.placementAssessment = { status: "deferred", reason: "Need more context." };
  saveKnowledgeNode(db, input, 2);
  // The writer committed, but the offered frontier was never settled.
  expect(db.prepare("SELECT status FROM knowledge_frontier").get()).toEqual({ status: "offered" });
  const retry = { ...proposal(), expectedRevision: 2 };
  expect(() => saveKnowledgeNode(db, retry, 3)).toThrow(/placementAssessment/);
  expect(getKnowledgeNode(db, "cabinet")!.revision).toBe(2);
  retry.maintenance!.placementAssessment = { status: "deferred", reason: "Still need context." };
  expect(saveKnowledgeNode(db, retry, 3).placementAssessment?.status).toBe("deferred");
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM knowledge_work WHERE status='pending'").get(),
  ).toEqual({ n: 1 });
  const resolved = { ...proposal(), expectedRevision: 3 };
  resolved.maintenance!.placementAssessment = {
    status: "standalone",
    reason: "Distinct reference scope.",
  };
  expect(saveKnowledgeNode(db, resolved, 4).placementAssessment?.status).toBe("standalone");
  expect(db.prepare("SELECT status FROM knowledge_work WHERE id='work'").get()).toEqual({
    status: "batched",
  });
});

it("never stamps deferred placement reviewed even if a recovered settlement supplies its revision", () => {
  const input = proposal();
  input.maintenance!.placementAssessment = { status: "deferred", reason: "Need more context." };
  saveKnowledgeNode(db, input, 2);
  // Trusted historical verification fixture isolates editorial completion from proof.
  db.prepare("UPDATE knowledge_claims SET verification='verified' WHERE node_id='cabinet'").run();
  settleKnowledgeFrontier(
    db,
    {
      outcome: {
        batchId: "batch",
        runId: "run",
        nodeId: "cabinet",
        inputFingerprint: "fingerprint",
        status: "unchanged",
        resultRevision: 2,
      },
      append: [],
    },
    3,
  );
  expect(getKnowledgeNode(db, "cabinet")!.metadata.lastReviewedAt).toBeUndefined();
  expect(getKnowledgeNode(db, "cabinet")!.metadata.nextReviewAt).toBeGreaterThan(3);
});

it("defers editorial improvement separately after factual review, without a completed review stamp", () => {
  const input = proposal();
  input.maintenance!.curationDeferral = {
    reasonCode: "insufficient_useful_context",
    reason: "No useful additional context after bounded investigation.",
  };
  input.maintenance!.placementRetryDelayMs = 60_000;
  const saved = saveKnowledgeNode(db, input, 2);
  expect(saved.node.markdown).toBe(markdown);
  expect(saved.placementAssessment).toBeUndefined();
  expect(saved.curationDeferral).toMatchObject({
    nextReviewAt: 60002,
    reasonCode: "insufficient_useful_context",
  });
  expect(saved.node.metadata.lastReviewedAt).toBeUndefined();
  expect(db.prepare("SELECT status,last_error FROM knowledge_work WHERE id='work'").get()).toEqual({
    status: "deferred",
    last_error: "curation_insufficient_context",
  });
  expect(
    db
      .prepare("SELECT COUNT(*) AS n FROM knowledge_work WHERE status='pending' AND due_at<=2")
      .get(),
  ).toEqual({ n: 0 });
  expect(
    db
      .prepare("SELECT COUNT(*) AS n FROM knowledge_work WHERE status='pending' AND due_at=60002")
      .get(),
  ).toEqual({ n: 1 });
  // A committed deferral survives an interrupted frontier settlement.
  expect(() => saveKnowledgeNode(db, { ...proposal(), expectedRevision: 2 }, 3)).toThrow(
    /placementAssessment/,
  );
  expect(
    saveKnowledgeNode(db, { ...input, expectedRevision: 2 }, 3).curationDeferral,
  ).toBeDefined();
});

it("explains that claim repair, unlike a whole-page review, cannot be deferred", () => {
  db.exec("UPDATE knowledge_work SET reason='change'");
  const input = proposal();
  input.maintenance!.curationDeferral = {
    reasonCode: "insufficient_useful_context",
    reason: "No useful additional context.",
  };
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(
    /defers only an offered whole-page review.*leave their review pending/,
  );
  expect(getKnowledgeNode(db, "cabinet")!.revision).toBe(1);
});

it("does not let editorial deferral settle unreviewed claims or change page content", () => {
  const input = proposal();
  input.maintenance!.curationDeferral = {
    reasonCode: "insufficient_useful_context",
    reason: "Awaiting useful context.",
  };
  input.maintenance!.reviewedClaimIds = [];
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/every offered claim/);
  expect(db.prepare("SELECT status FROM knowledge_claim_outcomes").get()).toEqual({
    status: "pending",
  });
  expect(getKnowledgeNode(db, "cabinet")!.revision).toBe(1);
  input.maintenance!.reviewedClaimIds = ["fact"];
  expect(() => saveKnowledgeNode(db, { ...input, title: "Different scope" }, 2)).toThrow(
    /unchanged/,
  );
  expect(() => saveKnowledgeNode(db, { ...input, markdown: markdown + " padding" }, 2)).toThrow(
    /unchanged/,
  );
  expect(() =>
    saveKnowledgeNode(
      db,
      { ...input, claims: [{ id: "fact", epistemicStatus: "unsupported" }] },
      2,
    ),
  ).toThrow(/claim meaning/);
  db.exec("UPDATE documents SET content_hash='v2' WHERE id='manual'");
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow();
  expect(getKnowledgeNode(db, "cabinet")!.revision).toBe(1);
});

it("repairs supporting references while deferring editorial work only with current positive proof", () => {
  db.exec(
    "INSERT INTO documents VALUES('replacement','Blue labels identify workshop cabinets.','r1')",
  );
  const input = proposal();
  input.markdown = markdown.replace("source:manual", "source:manual source:replacement");
  input.inputVersions = { "source:manual": "v1", "source:replacement": "r1" };
  input.maintenance!.curationDeferral = {
    reasonCode: "insufficient_useful_context",
    reason: "No additional useful context.",
  };
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/current positive verification/);
  expect(getKnowledgeNode(db, "cabinet")!.revision).toBe(1);
  expect(db.prepare("SELECT status FROM knowledge_claim_outcomes").get()).toEqual({
    status: "pending",
  });
  const parsed = parseClaimMarkup(input.markdown);
  const context = knowledgeClaimContexts(input, parsed).get("fact");
  input.claims = [
    {
      id: "fact",
      verification: {
        status: "verified",
        verifier: CONTEXTUAL_VERIFIER,
        fingerprint: knowledgeClaimFingerprint(
          parsed.claims[0]!,
          input.inputVersions,
          undefined,
          context,
        ),
      },
    },
  ];
  const saved = saveKnowledgeNode(db, input, 2);
  expect(saved.node.plainText).toBe("Blue labels identify workshop cabinets.");
  expect(saved.meaningChanged).toBe(true);
  expect(saved.curationDeferral).toBeDefined();
  expect(saved.node.metadata.lastReviewedAt).toBeUndefined();
  expect(db.prepare("SELECT status FROM knowledge_work WHERE id='work'").get()).toEqual({
    status: "deferred",
  });
  expect(
    db
      .prepare("SELECT COUNT(*) AS n FROM knowledge_work WHERE status='pending' AND due_at<=2")
      .get(),
  ).toEqual({ n: 0 });
});

it("refuses proof repair that changes structure, qualifications or supporting relation semantics", () => {
  db.exec(
    "INSERT INTO documents VALUES('replacement','Blue labels identify workshop cabinets.','r1')",
  );
  const input = proposal();
  input.markdown = markdown.replace("source:manual", "source:replacement");
  input.inputVersions = { "source:replacement": "r1" };
  input.maintenance!.curationDeferral = {
    reasonCode: "insufficient_useful_context",
    reason: "No additional context.",
  };
  for (const altered of [
    { ...input, markdown: input.markdown.replace('id="fact"', 'id="new"') },
    { ...input, markdown: input.markdown.replace("Blue labels", "Green labels") },
    { ...input, title: "Different scope" },
    { ...input, claims: [{ id: "fact", modality: "proposal" as const }] },
    { ...input, claims: [{ id: "fact", supportLogic: "any" as const }] },
    { ...input, claims: [{ id: "fact", relations: { "source:replacement": "context" as const } }] },
  ])
    expect(() => saveKnowledgeNode(db, altered, 2)).toThrow(/Curation deferral/);
  input.inputVersions = { "source:replacement": "obsolete" };
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow();
  expect(getKnowledgeNode(db, "cabinet")!.revision).toBe(1);
});

it("retains an incoming project outcome only with an observed current loop and actual edge", () => {
  saveKnowledgeNode(
    db,
    {
      ...proposal(),
      id: "label-task",
      maintenance: undefined,
      runFence: undefined,
      expectedRevision: 0,
    },
    1,
  );
  db.exec("UPDATE knowledge_nodes SET kind='loop' WHERE id='label-task'");
  const input = proposal();
  input.maintenance!.placementAssessment = {
    status: "integrated",
    reason: "Label task belongs to the cabinet project.",
    links: [
      { fromId: "label-task", toId: "cabinet", kind: "belongs_to_project", otherRevision: 1 },
    ],
  };
  const reads = new WikiToolReconciliation(db, input.runFence!);
  reads.read(
    () => [],
    () => ["pages"],
  );
  input.runFence = reads.placementFence(input.runFence!);
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/counterpart/);
  reads.readNode(() => getKnowledgeNode(db, "label-task"));
  input.runFence = reads.placementFence(input.runFence);
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/persisted/);
  db.exec("INSERT INTO knowledge_links VALUES('label-task','cabinet','belongs_to_project')");
  db.exec("UPDATE knowledge_nodes SET revision=2 WHERE id='label-task'");
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/current revision/);
  db.exec(
    "UPDATE knowledge_nodes SET revision=1,fields_json='{\"state\":\"retired\"}' WHERE id='label-task'",
  );
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/current loop/);
  db.exec(
    "UPDATE knowledge_nodes SET kind='loop',fields_json='{\"withdrawn\":true}' WHERE id='label-task'",
  );
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/unavailable/);
  db.exec("UPDATE knowledge_nodes SET fields_json='{}' WHERE id='label-task'");
  db.exec("UPDATE knowledge_nodes SET fields_json='{\"state\":\"done\"}' WHERE id='label-task'");
  const link = input.maintenance!.placementAssessment.links[0]!;
  link.kind = "related_to";
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/current loop/);
  link.kind = "belongs_to_project";
  [link.fromId, link.toId] = [link.toId, link.fromId];
  expect(() => saveKnowledgeNode(db, input, 2)).toThrow(/current loop/);
  [link.fromId, link.toId] = [link.toId, link.fromId];
  expect(saveKnowledgeNode(db, input, 2).placementAssessment?.status).toBe("integrated");
  expect(db.prepare("SELECT kind FROM knowledge_links").all()).toEqual([
    { kind: "belongs_to_project" },
  ]);
});
