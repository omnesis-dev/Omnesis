// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { resolveBrainSettings } from "../config.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createKnowledgeTables, getKnowledgeNode, saveKnowledgeNode } from "./storage.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { KnowledgeService } from "./service.js";
import { directKnowledgeGate } from "./writer.js";
import { buildKnowledgeTools } from "./tools.js";
import { proposeKnowledgeCandidate } from "./discovery.js";
import { WikiToolReconciliation } from "./wiki-tool-reconciliation.js";
import type { ToolHandle } from "@omnesis/agent";

let db: Database.Database;
let service: KnowledgeService;
const invocation = { sessionId: "synthetic-session", messageId: "synthetic-message" };
const proposal = {
  identityKey: "workshop",
  title: "Workshop",
  scope: "Workshop planning",
  evidenceVersions: { evidence: "v1" },
};
const node = {
  id: "workshop",
  kind: "wiki" as const,
  title: "Workshop",
  markdown:
    '<claim id="date" refs="source:evidence">Workshop on Friday.</claim><claim id="materials" refs="source:materials">The materials allocation is approved.</claim>',
  expectedRevision: 0,
  inputVersions: { "source:evidence": "v1", "source:materials": "v2" },
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT); INSERT INTO documents VALUES('evidence','Workshop on Friday.','v1'),('materials','The materials allocation is approved.','v2')",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log: createLogger("wiki-reconciliation-test"),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});
function tools(id: string): ToolHandle[] {
  db.prepare(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES(?,?,?,'routine','running',1,1)",
  ).run(id, id, id);
  return buildKnowledgeTools(service, { runId: id, batchId: id, parallel: true });
}
async function call(entries: ToolHandle[], name: string, args: unknown) {
  return entries.find((tool) => tool.name === name)!.invoke(args, invocation);
}
async function reconcile(entries: ToolHandle[]) {
  expect(await call(entries, "knowledge_list", { kind: "wiki" })).toMatchObject({
    kind: "structured",
  });
  expect(await call(entries, "knowledge_candidates", {})).toMatchObject({ kind: "structured" });
}

it("invalidates a concurrent negative search even when the proposed identity keys differ", async () => {
  const first = tools("first");
  const second = tools("second");
  await reconcile(first);
  await reconcile(second);
  expect(await call(first, "knowledge_propose_page", proposal)).toMatchObject({
    kind: "structured",
  });
  expect(
    await call(second, "knowledge_propose_page", {
      ...proposal,
      identityKey: "alternate-workshop",
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get()).toEqual({ n: 1 });
  // Reading valid evidence does not reconcile concurrent library changes.
  expect(await call(second, "knowledge_reference", { ref: "source:evidence" })).toMatchObject({
    kind: "structured",
    data: { revision: "v1" },
  });
  const refused = await call(second, "knowledge_propose_page", {
    ...proposal,
    identityKey: "alternate-workshop",
  });
  expect(refused).toMatchObject({
    kind: "error",
    code: "revision_conflict",
    message: expect.stringContaining('knowledge_list({kind:"wiki"})'),
  });
  if (refused.kind !== "error") throw new Error("Expected reconciliation refusal");
  expect(refused.message).toContain("knowledge_candidates({})");
  expect(refused.message).toContain("do not refresh this collection receipt");
  expect(refused.message).toContain("Retain already-read source inputVersions");
  // Refreshing one half of the reconciliation must not silently refresh the other.
  await call(second, "knowledge_candidates", {});
  expect(
    await call(second, "knowledge_propose_page", {
      ...proposal,
      identityKey: "alternate-workshop",
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  await reconcile(second);
  expect(
    await call(second, "knowledge_propose_page", {
      ...proposal,
      identityKey: "another-scope",
      scope: "Independent event logistics",
    }),
  ).toMatchObject({ kind: "structured" });
});

it("requires page and candidate reconciliation rather than an empty individual fetch", async () => {
  const entries = tools("run");
  await call(entries, "knowledge_fetch", { id: "absent" });
  await call(entries, "knowledge_candidates", {});
  expect(await call(entries, "knowledge_propose_page", proposal)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get()).toEqual({ n: 0 });
});

it("carries exact own-write receipts through proposal, publication, and revision without exposing them", async () => {
  const entries = tools("run");
  await reconcile(entries);
  const proposed = await call(entries, "knowledge_propose_page", proposal);
  expect(proposed).toMatchObject({ kind: "structured" });
  if (proposed.kind !== "structured") throw new Error("Expected candidate result");
  expect(proposed.data).not.toHaveProperty("reconciliationReceipt");
  const candidate = proposed.data as { id: string };
  const published = await call(entries, "knowledge_save", {
    node,
    candidateId: candidate.id,
    creationAssessment: {
      reason: "The workshop reference synthesizes timing and approved materials allocation.",
      relatedPageIds: [],
    },
  });
  expect(published).toMatchObject({ kind: "structured", data: { node: { revision: 1 } } });
  if (published.kind !== "structured") throw new Error("Expected wiki result");
  expect(published.data).not.toHaveProperty("reconciliationReceipt");
  expect(
    await call(entries, "knowledge_save", { node: { ...node, expectedRevision: 1 } }),
  ).toMatchObject({ kind: "structured", data: { node: { revision: 2 } } });
  expect(
    await call(entries, "knowledge_save", { node: { ...node, id: "root", kind: "root" } }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
});

it("rejects an existing wiki write derived from a stale read, including a guessed new revision", async () => {
  saveKnowledgeNode(db, node, 1);
  const entries = tools("run");
  await call(entries, "knowledge_fetch", { id: node.id, editing: true });
  saveKnowledgeNode(db, { ...node, expectedRevision: 1, title: "Revised workshop" }, 2);
  expect(
    await call(entries, "knowledge_save", { node: { ...node, expectedRevision: 2 } }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(getKnowledgeNode(db, node.id)).toMatchObject({ revision: 2, title: "Revised workshop" });
  await call(entries, "knowledge_fetch", { id: node.id, editing: true });
  expect(
    await call(entries, "knowledge_save", { node: { ...node, expectedRevision: 2 } }),
  ).toMatchObject({ kind: "structured" });
});

it("does not adopt an intervening writer's generation while awaiting its own proposal result", async () => {
  const entries = tools("run");
  await reconcile(entries);
  const original = service.deps.writeGate["knowledge.proposeCandidate"];
  vi.spyOn(service.deps.writeGate, "knowledge.proposeCandidate").mockImplementation(
    async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      proposeKnowledgeCandidate(
        db,
        { ...proposal, id: "competitor", identityKey: "competing-scope" },
        20,
      );
      return result;
    },
  );
  const proposed = await call(entries, "knowledge_propose_page", proposal);
  if (proposed.kind !== "structured") throw new Error("Expected candidate result");
  const candidate = proposed.data as { id: string };
  expect(
    await call(entries, "knowledge_save", {
      node,
      candidateId: candidate.id,
      creationAssessment: {
        reason: "The workshop reference synthesizes timing and approved materials allocation.",
        relatedPageIds: [],
      },
    }),
  ).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(getKnowledgeNode(db, node.id)).toBeNull();
});

it("checks reconciliation again inside the writer transaction after admission", async () => {
  const entries = tools("run");
  await reconcile(entries);
  const original = service.deps.writeGate["knowledge.proposeCandidate"];
  vi.spyOn(service.deps.writeGate, "knowledge.proposeCandidate").mockImplementation(
    async (...args: Parameters<typeof original>) => {
      proposeKnowledgeCandidate(
        db,
        { ...proposal, id: "competitor", identityKey: "competing-scope" },
        20,
      );
      return original(...args);
    },
  );
  expect(await call(entries, "knowledge_propose_page", proposal)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get()).toEqual({ n: 1 });
});

it("rejects a read that crossed a collection mutation instead of certifying the returned stale view", () => {
  tools("run");
  const receipts = new WikiToolReconciliation(db, { runId: "run", batchId: "run" });
  expect(() =>
    receipts.read(
      () => {
        proposeKnowledgeCandidate(db, { ...proposal, id: "competitor" }, 20);
        return [];
      },
      () => ["pages"],
    ),
  ).toThrow("reconciled collection changed");
  expect(() => receipts.fence(["pages"])).toThrow("Read current wiki pages");
});

it("does not treat a status-filtered candidate list as a complete proposal reconciliation", async () => {
  const entries = tools("run");
  await call(entries, "knowledge_list", { kind: "wiki" });
  await call(entries, "knowledge_candidates", { status: "dismissed" });
  expect(await call(entries, "knowledge_propose_page", proposal)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
});

it("candidate decisions keep their read revision across concurrent collection edits", async () => {
  proposeKnowledgeCandidate(db, { ...proposal, id: "candidate" }, 1);
  const entries = tools("run");
  await call(entries, "knowledge_candidates", {});
  proposeKnowledgeCandidate(db, { ...proposal, id: "other", identityKey: "other-event" }, 2);
  expect(
    await call(entries, "knowledge_candidate_decide", {
      id: "candidate",
      expectedRevision: 1,
      status: "deferred",
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  await call(entries, "knowledge_candidates", {});
  expect(
    await call(entries, "knowledge_candidate_decide", {
      id: "candidate",
      expectedRevision: 1,
      status: "deferred",
    }),
  ).toMatchObject({ kind: "structured", data: { revision: 2 } });
});

it("requires the publication candidate itself to have been returned by a read", async () => {
  proposeKnowledgeCandidate(db, { ...proposal, id: "a-observed" }, 1);
  proposeKnowledgeCandidate(
    db,
    { ...proposal, id: "z-unseen", identityKey: "unseen-candidate" },
    2,
  );
  const entries = tools("run");
  await call(entries, "knowledge_list", { kind: "wiki" });
  await call(entries, "knowledge_candidates", { limit: 1 });
  expect(
    await call(entries, "knowledge_save", {
      node,
      candidateId: "z-unseen",
      creationAssessment: {
        reason: "The workshop reference synthesizes timing and approved materials allocation.",
        relatedPageIds: [],
      },
    }),
  ).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(getKnowledgeNode(db, node.id)).toBeNull();
  await call(entries, "knowledge_candidates", { afterId: "a-observed" });
  expect(
    await call(entries, "knowledge_save", {
      node,
      candidateId: "z-unseen",
      creationAssessment: {
        reason: "The workshop reference synthesizes timing and approved materials allocation.",
        relatedPageIds: [],
      },
    }),
  ).toMatchObject({
    kind: "structured",
  });
});

it("does not certify arbitrary empty page tails as proposal reconciliation", async () => {
  const entries = tools("run");
  await call(entries, "knowledge_list", { kind: "wiki", afterId: "zzzz" });
  await call(entries, "knowledge_candidates", { afterId: "zzzz" });
  expect(await call(entries, "knowledge_propose_page", proposal)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM knowledge_candidates").get()).toEqual({ n: 0 });
});

it("allows disjoint existing wiki repairs after both actual reads despite intervening library writes", async () => {
  const other = { ...node, id: "materials" };
  saveKnowledgeNode(db, node, 1);
  saveKnowledgeNode(db, other, 1);
  const first = tools("first");
  const second = tools("second");
  await call(first, "knowledge_fetch", { id: node.id, editing: true });
  await call(second, "knowledge_fetch", { id: other.id, editing: true });
  let entered = 0;
  let release!: () => void;
  const bothVerifying = new Promise<void>((resolve) => {
    release = resolve;
  });
  service.deps.getEntailmentVerifier = async () => ({
    async verify() {
      if (++entered === 2) release();
      await bothVerifying;
      return { label: "entailment" as const, probability: 1 };
    },
    dispose() {},
  });
  const results = await Promise.all([
    call(first, "knowledge_save", {
      node: { ...node, expectedRevision: 1, title: "Workshop revised" },
    }),
    call(second, "knowledge_save", {
      node: { ...other, expectedRevision: 1, title: "Materials revised" },
    }),
  ]);
  expect(entered).toBe(4);
  for (const result of results)
    expect(result).toMatchObject({ kind: "structured", data: { node: { revision: 2 } } });
  // An exact own-write response remains a read; an unrelated write does not erase it.
  expect(
    await call(first, "knowledge_save", {
      node: { ...node, expectedRevision: 2, title: "Workshop revised" },
    }),
  ).toMatchObject({ kind: "structured", data: { node: { revision: 3 } } });
});

it("still refuses a same-wiki mutation during asynchronous verification", async () => {
  saveKnowledgeNode(db, node, 1);
  const entries = tools("run");
  await call(entries, "knowledge_fetch", { id: node.id, editing: true });
  service.deps.getEntailmentVerifier = async () => ({
    async verify() {
      saveKnowledgeNode(db, { ...node, expectedRevision: 1, title: "Concurrent revision" }, 2);
      return { label: "entailment" as const, probability: 1 };
    },
    dispose() {},
  });
  expect(
    await call(entries, "knowledge_save", {
      node: { ...node, expectedRevision: 1, title: "Stale proposed revision" },
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(getKnowledgeNode(db, node.id)).toMatchObject({
    revision: 2,
    title: "Concurrent revision",
  });
  // Failed writes cannot grant the winner's revision to this run.
  expect(
    await call(entries, "knowledge_save", {
      node: { ...node, expectedRevision: 2 },
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
});

it("candidate settlement cannot refresh stale exclusive creation inventory", async () => {
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('exclusive','exclusive','exclusive','routine','running',1,1)",
  );
  const entries = buildKnowledgeTools(service, {
    runId: "exclusive",
    batchId: "exclusive",
    parallel: false,
  });
  proposeKnowledgeCandidate(db, { ...proposal, id: "observed" }, 1);
  await reconcile(entries);
  proposeKnowledgeCandidate(db, { ...proposal, id: "new-scope", identityKey: "new-scope" }, 2);
  expect(
    await call(entries, "knowledge_candidate_decide", {
      id: "observed",
      expectedRevision: 1,
      status: "deferred",
    }),
  ).toMatchObject({ kind: "structured" });
  expect(
    await call(entries, "knowledge_propose_page", { ...proposal, identityKey: "different-scope" }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
});
