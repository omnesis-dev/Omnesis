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
import { knowledgeHash } from "./storage-validation.js";
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
