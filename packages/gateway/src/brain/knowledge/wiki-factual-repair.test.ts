// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDecisionPayloadTables } from "../decision-payload.js";
import { recordCheckPolicyKey } from "../record-check/rubric.js";
import { WIKI_REPAIR_RUBRIC_VERSION } from "../record-check/wiki-rubric.js";
import { resolveBrainSettings } from "../config.js";
import { createKnowledgeTables, getKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { snapshotClaimMaintenance } from "./claim-maintenance.js";
import { KnowledgeService } from "./service.js";
import { directKnowledgeGate } from "./writer.js";
import { WikiValueCheck } from "./wiki-value-check.js";
import { assertWikiRepairAssessment, wikiFactualRepairFingerprint } from "./wiki-factual-repair.js";
import type { CheckRecord } from "../record-check/check.js";
import type { SaveKnowledgeNodeInput } from "./types.js";

let db: Database.Database;
let service: KnowledgeService;
let verdict: "entailment" | "neutral" | "unavailable";
const policy = recordCheckPolicyKey("enforce", "fixture");
const original =
  '<claim id="humidity" refs="source:manual">## Storage\nStore samples below 80% humidity.</claim>\n\n<claim id="sealed" refs="source:manual">Containers stay sealed.</claim>';
const proposal = (): SaveKnowledgeNodeInput => ({
  id: "storage",
  kind: "wiki",
  title: "Sample storage",
  expectedRevision: 1,
  markdown: original.replace("80%", "40%"),
  inputVersions: { "source:manual": "v1" },
  maintenance: {
    batchId: "batch",
    runId: "run",
    inputFingerprint: "offered",
    reviewedClaimIds: ["humidity", "sealed"],
    curationDeferral: {
      reasonCode: "insufficient_useful_context",
      reason: "Correct the storage limit without adding topics.",
      factualRepair: { claimIds: ["humidity"] },
    },
  },
});
const check = () =>
  Object.assign(
    vi.fn<CheckRecord>(async () => ({
      save: true,
      assessment: { policy, decisionId: "decision", rubricVersion: WIKI_REPAIR_RUBRIC_VERSION },
    })),
    { policyKey: () => policy },
  );
beforeEach(async () => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('manual','Store samples below 40% humidity. Containers stay sealed.','v1')",
  );
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  createDecisionPayloadTables(db);
  db.exec(
    "CREATE TABLE cognition_decisions(id TEXT PRIMARY KEY,run_id TEXT,record_id TEXT,rubric_version TEXT,enforced INTEGER,verdict TEXT,requested_model_id TEXT)",
  );
  db.prepare(
    "INSERT INTO cognition_decisions VALUES('decision','run','storage',?,1,'pass','fixture')",
  ).run(WIKI_REPAIR_RUBRIC_VERSION);
  verdict = "unavailable";
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log: createLogger("repair-test"),
    getEntailmentVerifier: async () => ({
      modelId: "fixture",
      dispose() {},
      async verify() {
        if (verdict === "unavailable") throw new Error("fixture outage");
        return { label: verdict, probability: verdict === "entailment" ? 1 : 0 };
      },
    }),
  });
  await service.save({
    ...proposal(),
    markdown: original,
    expectedRevision: 0,
    maintenance: undefined,
  });
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','creation','soon','running',1,1); INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES('batch','storage','offered','{}',0,'offered'); INSERT INTO knowledge_work(id,subject_id,subject_kind,reason,input_revision,input_changed_at,tier,due_at,created_at,updated_at,status,batch_id) VALUES('work','storage','node','review','1',1,'soon',1,1,1,'batched','batch')",
  );
  snapshotClaimMaintenance(db, {
    batchId: "batch",
    nodeId: "storage",
    inputFingerprint: "offered",
  });
});
afterEach(() => db.close());
it("requires one enforcing integrity decision and positive factual proof, retaining editorial debt", async () => {
  const previousReview = getKnowledgeNode(db, "storage")!.metadata.lastReviewedAt;
  const input = proposal(),
    judge = check();
  input.wikiRepairAssessment = await new WikiValueCheck(service, judge).assess(input);
  expect(judge).toHaveBeenCalledTimes(1);
  expect(judge.mock.calls[0]![0]).toMatchObject({
    record: { kind: "factual_repair" },
    wikiContext: { factualRepair: { beforeMarkup: original, afterMarkup: input.markdown } },
  });
  verdict = "entailment";
  const result = await service.save(input);
  expect(result.node.plainText).toContain("40%");
  expect(result.node.plainText).toContain("Containers stay sealed.");
  expect(result.curationDeferral).toBeDefined();
  expect(result.node.metadata.lastReviewedAt).toEqual(previousReview);
  expect(db.prepare("SELECT status FROM knowledge_work WHERE id='work'").get()).toEqual({
    status: "deferred",
  });
  expect(
    db.prepare("SELECT verification FROM knowledge_claims WHERE node_id='storage'").all(),
  ).toEqual([{ verification: "verified" }, { verification: "verified" }]);
  expect(
    db.prepare("SELECT COUNT(*) n FROM knowledge_work WHERE status='pending' AND due_at<=10").get(),
  ).toEqual({ n: 0 });
});
it.each(["neutral", "unavailable"] as const)(
  "does not commit with %s factual verification",
  async (label) => {
    const input = proposal();
    input.wikiRepairAssessment = await new WikiValueCheck(service, check()).assess(input);
    verdict = label;
    await expect(service.save(input)).rejects.toThrow();
    expect(getKnowledgeNode(db, "storage")!.revision).toBe(1);
    expect(db.prepare("SELECT status FROM knowledge_work WHERE id='work'").get()).toEqual({
      status: "batched",
    });
  },
);
it("does not treat off/shadow/unavailable or ordinary value passes as repair authorization", async () => {
  for (const result of [
    { save: true as const },
    { save: true as const, assessment: { policy, decisionId: "decision" } },
    { save: false as const, decisionId: "decision", score: 0, threshold: 1.5 },
  ]) {
    const judge = Object.assign(
      vi.fn<CheckRecord>(async () => result),
      { policyKey: () => policy },
    );
    await expect(new WikiValueCheck(service, judge).assess(proposal())).rejects.toThrow(
      /not authorized/,
    );
  }
  await expect(service.save(proposal())).rejects.toThrow(/enforced repair-integrity/);
});
it("rejects unrelated prose, new headings, claim deletion and changes outside claims before judgement", () => {
  const input = proposal();
  for (const markdown of [
    input.markdown.replace("Containers stay sealed.", "Containers are opened daily."),
    input.markdown + "\nNew unsupported prose.",
    input.markdown.replace("## Storage", "## Transport"),
    input.markdown.replace(/\n\n<claim id="sealed"[\s\S]*$/, ""),
  ])
    expect(() => wikiFactualRepairFingerprint(db, { ...input, markdown })).toThrow(
      /Factual repair/,
    );
  expect(() => wikiFactualRepairFingerprint(db, { ...input, expectedRevision: 0 })).toThrow();
});
it("rejects altered proposals, revoked ledger authorization and changed source versions atomically", async () => {
  const input = proposal();
  input.wikiRepairAssessment = await new WikiValueCheck(service, check()).assess(input);
  verdict = "entailment";
  await expect(
    service.save({ ...input, markdown: input.markdown.replace("40%", "30%") }),
  ).rejects.toThrow(/assessment/);
  db.exec("UPDATE cognition_decisions SET enforced=0");
  await expect(service.save(input)).rejects.toThrow(/assessment/);
  db.exec("UPDATE cognition_decisions SET enforced=1; UPDATE documents SET content_hash='v2'");
  await expect(service.save(input)).rejects.toThrow();
  expect(getKnowledgeNode(db, "storage")!.revision).toBe(1);
});

it("keeps the initial lane limited to asserted supporting claims", () => {
  db.exec("UPDATE knowledge_claims SET epistemic_status='unsupported' WHERE id='sealed'");
  expect(() => wikiFactualRepairFingerprint(db, proposal())).toThrow(/Factual repair/);
});
it("does not let raw writer defaults erase an inherited qualifier after assessment", async () => {
  db.exec("UPDATE knowledge_claims SET attribution='Laboratory protocol' WHERE id='sealed'");
  const input = proposal();
  input.wikiRepairAssessment = await new WikiValueCheck(service, check()).assess(input);
  expect(() => assertWikiRepairAssessment(db, input)).not.toThrow();
  expect(() => assertWikiRepairAssessment(db, input, true)).toThrow();
  expect(() =>
    assertWikiRepairAssessment(
      db,
      {
        ...input,
        claims: [{ id: "sealed", attribution: "Laboratory protocol" }],
      },
      true,
    ),
  ).not.toThrow();
});

it.each(["source", "privacy", "policy"] as const)(
  "refuses a %s change during the integrity decision",
  async (change) => {
    const input = proposal();
    let currentPolicy = policy;
    const judge = Object.assign(
      vi.fn<CheckRecord>(async () => {
        if (change === "source") db.exec("UPDATE documents SET content_hash='v2'");
        if (change === "privacy")
          db.exec("UPDATE knowledge_decision_privacy SET generation=generation+1");
        if (change === "policy")
          currentPolicy = recordCheckPolicyKey("enforce", "replacement-model");
        return {
          save: true,
          assessment: { policy, decisionId: "decision", rubricVersion: WIKI_REPAIR_RUBRIC_VERSION },
        };
      }),
      { policyKey: () => currentPolicy },
    );
    verdict = "entailment";
    await expect(
      (async () => {
        input.wikiRepairAssessment = await new WikiValueCheck(service, judge).assess(input);
        await service.save(input);
      })(),
    ).rejects.toThrow();
    expect(getKnowledgeNode(db, "storage")!.revision).toBe(1);
    expect(db.prepare("SELECT status FROM knowledge_work WHERE id='work'").get()).toEqual({
      status: "batched",
    });
  },
);

it("preserves an unnamed enclosing claim while correcting its named nested assertion", async () => {
  const nested =
    '<claim id="sealed" refs="source:manual">Containers stay sealed.\n<claim id="humidity" refs="source:manual">Store samples below 80% humidity.</claim></claim>';
  await service.save({ ...proposal(), markdown: nested, maintenance: undefined });
  const input = { ...proposal(), expectedRevision: 2, markdown: nested.replace("80%", "40%") };
  expect(() => wikiFactualRepairFingerprint(db, input)).not.toThrow();
  expect(() =>
    wikiFactualRepairFingerprint(db, {
      ...input,
      markdown: input.markdown.replace("Containers stay sealed.", "Containers may be opened."),
    }),
  ).toThrow(/Factual repair/);
});

it.each([
  "> ## Storage\n> Store samples below 80% humidity.",
  "- ## Storage\n  Store samples below 80% humidity.",
])("preserves headings nested within Markdown containers: %s", async (body) => {
  const nestedHeading = original.replace("## Storage\nStore samples below 80% humidity.", body);
  await service.save({ ...proposal(), markdown: nestedHeading, maintenance: undefined });
  const input = {
    ...proposal(),
    expectedRevision: 2,
    markdown: nestedHeading.replace("80%", "40%"),
  };
  expect(() => wikiFactualRepairFingerprint(db, input)).not.toThrow();
  expect(() =>
    wikiFactualRepairFingerprint(db, {
      ...input,
      markdown: input.markdown.replace("## Storage", "## Transport"),
    }),
  ).toThrow(/Factual repair/);
});
