// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBriefsStorageTables } from "../storage/schema.js";
import { saveKnowledgeNode } from "./storage.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import {
  abandonKnowledgeBatch,
  MAX_CARRIED_FRONTIER_NODES,
  recordKnowledgeDiscoveryTargets,
  refreshKnowledgeWork,
} from "./work-lifecycle.js";
import {
  createKnowledgeBatch,
  enqueueKnowledgeWork,
  getKnowledgeWork,
  setKnowledgeFrontierOutcome,
  settleKnowledgeFrontier,
  type KnowledgeFrontierInput,
  type KnowledgeWorkReason,
} from "./work.js";
import {
  isolatedKnowledgeRetry,
  knowledgeRetryDelayMs,
  type KnowledgeRetryPolicy,
} from "./work-retry.js";

const policy: KnowledgeRetryPolicy = { backoffMs: 100, backoffCapMs: 300, maxFailedAttempts: 3 };
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys=ON");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,content TEXT NOT NULL)",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  for (const id of ["source-a", "source-b"])
    db.prepare("INSERT INTO documents VALUES(?,'v1','A fictional note')").run(id);
});
afterEach(() => db.close());

function enqueue(id: string, subjectId: string, reason: KnowledgeWorkReason = "change") {
  return enqueueKnowledgeWork(
    db,
    {
      id,
      subjectId,
      subjectKind: "source",
      reason,
      inputRevision: "v1",
      tier: "routine",
      dueAt: 5,
    },
    1,
  );
}
function page(id: string, kind: "wiki" | "root" = "wiki") {
  return saveKnowledgeNode(
    db,
    { id, kind, title: id, markdown: "Context", expectedRevision: 0, inputVersions: {} },
    1,
  ).node;
}
const frontierFor = (sourceId: string): KnowledgeFrontierInput => ({
  nodeId: `source:${sourceId}`,
  inputFingerprint: `fp-${sourceId}`,
  inputVersions: { [`source:${sourceId}`]: "v1" },
  depth: 0,
});
const nodeFrontier = (id: string, depth = 1): KnowledgeFrontierInput => ({
  nodeId: id,
  inputFingerprint: `fp-${id}`,
  inputVersions: { [`node:${id}`]: 1 },
  depth,
});
function batch(id: string, workIds: string[], extra: KnowledgeFrontierInput[] = []) {
  createKnowledgeBatch(
    db,
    {
      id,
      runId: `run-${id}`,
      tier: "routine",
      work: workIds.map((workId) => {
        const work = getKnowledgeWork(db, workId)!;
        return { id: work.id, generation: work.generation, inputRevision: work.inputRevision };
      }),
      frontier: [
        ...workIds.map((workId) => frontierFor(getKnowledgeWork(db, workId)!.subjectId)),
        ...extra,
      ],
      regionNodeIds: [],
    },
    2,
  );
}
function outcome(batchId: string, nodeId: string, status: "offered" | "changed") {
  setKnowledgeFrontierOutcome(
    db,
    { batchId, nodeId, inputFingerprint: `fp-${nodeId.replace("source:", "")}`, status },
    3,
  );
}
const latest = (subjectId: string) =>
  db
    .prepare<[string], { status: string; failures: number; due: number; error: string | null }>(
      "SELECT status,failures,due_at AS due,last_error AS error FROM knowledge_work WHERE subject_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
    )
    .get(subjectId)!;

it("doubles the retry delay per failure up to its cap", () => {
  expect([1, 2, 3, 4, 60].map((failures) => knowledgeRetryDelayMs(failures, policy))).toEqual([
    100, 200, 300, 300, 300,
  ]);
});

it("completes a settled source whose discovery target is still open and isolates the target, charging repeats", () => {
  page("target");
  recordKnowledgeDiscoveryTargets(
    db,
    { sourceId: "source-a", sourceRevision: "v1", nodeIds: ["target"] },
    1,
  );
  enqueue("work-a", "source-a");
  batch("batch", ["work-a"]);
  settleKnowledgeFrontier(
    db,
    {
      outcome: {
        batchId: "batch",
        nodeId: "source:source-a",
        inputFingerprint: "fp-source-a",
        status: "changed",
      },
      append: [nodeFrontier("target")],
    },
    3,
  );
  outcome("batch", "target", "offered");
  abandonKnowledgeBatch(db, { batchId: "batch", notBefore: 10, failure: policy }, 20);
  // A hub page many sources select must not hold every one of them open.
  expect(latest("source-a").status).toBe("completed");
  expect(latest("target")).toMatchObject({ status: "pending", failures: 1, due: 120 });
  expect(isolatedKnowledgeRetry(db, "target", 1)).toBe(true);
  // The next failed batch that offers the same page charges it again.
  enqueue("work-b", "source-b");
  batch("second", ["work-b"]);
  settleKnowledgeFrontier(
    db,
    {
      outcome: {
        batchId: "second",
        nodeId: "source:source-b",
        inputFingerprint: "fp-source-b",
        status: "changed",
      },
      append: [nodeFrontier("target")],
    },
    23,
  );
  outcome("second", "target", "offered");
  abandonKnowledgeBatch(db, { batchId: "second", notBefore: 30, failure: policy }, 40);
  expect(latest("source-b").status).toBe("completed");
  expect(latest("target")).toMatchObject({ status: "pending", failures: 2, due: 240 });
});

it("carries unfinished dependents as change work and keeps the settled seed", () => {
  page("dependent");
  enqueue("work-a", "source-a");
  batch("batch", ["work-a"]);
  settleKnowledgeFrontier(
    db,
    {
      outcome: {
        batchId: "batch",
        nodeId: "source:source-a",
        inputFingerprint: "fp-source-a",
        status: "changed",
      },
      append: [nodeFrontier("dependent")],
    },
    3,
  );
  abandonKnowledgeBatch(db, { batchId: "batch", notBefore: 10, failure: policy }, 20);
  expect(latest("source-a").status).toBe("completed");
  expect(
    db
      .prepare(
        "SELECT reason,status,failures,due_at AS due FROM knowledge_work WHERE subject_id='dependent'",
      )
      .get(),
  ).toEqual({ reason: "change", status: "pending", failures: 0, due: 10 });
});

it("retries every seed whole when too many dependents are unfinished to carry", () => {
  const dependents = Array.from({ length: MAX_CARRIED_FRONTIER_NODES + 1 }, (_, index) => {
    page(`dependent-${index}`);
    return nodeFrontier(`dependent-${index}`);
  });
  enqueue("work-a", "source-a");
  batch("batch", ["work-a"]);
  settleKnowledgeFrontier(
    db,
    {
      outcome: {
        batchId: "batch",
        nodeId: "source:source-a",
        inputFingerprint: "fp-source-a",
        status: "changed",
      },
      append: dependents,
    },
    3,
  );
  abandonKnowledgeBatch(db, { batchId: "batch", notBefore: 10, failure: policy }, 20);
  expect(latest("source-a")).toMatchObject({ status: "pending" });
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_work WHERE subject_kind='node'").get(),
  ).toEqual({ count: 0 });
});

it("parks at the cap together with a queued twin, and only a new revision admits fresh work", () => {
  enqueue("work-a", "source-a");
  db.prepare("UPDATE knowledge_work SET failures=2 WHERE id='work-a'").run();
  batch("batch", ["work-a"]);
  // A twin queued while the batch ran is the same obligation at the same revision.
  const twin = enqueue("twin", "source-a");
  expect(twin.status).toBe("pending");
  outcome("batch", "source:source-a", "offered");
  abandonKnowledgeBatch(db, { batchId: "batch", notBefore: 10, failure: policy }, 20);
  expect(getKnowledgeWork(db, "work-a")).toMatchObject({
    status: "deferred",
    failures: 3,
    lastError: "parked",
  });
  expect(getKnowledgeWork(db, "twin")).toMatchObject({ status: "deferred", lastError: "parked" });
  expect(enqueue("again", "source-a")).toMatchObject({ status: "deferred", lastError: "parked" });
  expect(
    db.prepare("SELECT COUNT(*) AS count FROM knowledge_work WHERE status='pending'").get(),
  ).toEqual({ count: 0 });
  // Another obligation for the same revision is not parked by this one.
  expect(enqueue("review", "source-a", "review").status).toBe("pending");
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='source-a'").run();
  expect(
    enqueueKnowledgeWork(
      db,
      {
        id: "fresh",
        subjectId: "source-a",
        subjectKind: "source",
        reason: "change",
        inputRevision: "v2",
        tier: "routine",
        dueAt: 30,
      },
      30,
    ),
  ).toMatchObject({ id: "fresh", status: "pending", failures: 0 });
});

it("never parks the root aggregate; it keeps retrying at the capped delay", () => {
  const root = page("root", "root");
  enqueueKnowledgeWork(
    db,
    {
      id: "root-work",
      subjectId: "root",
      subjectKind: "node",
      reason: "root",
      inputRevision: String(root.revision),
      tier: "routine",
      dueAt: 5,
    },
    1,
  );
  db.prepare("UPDATE knowledge_work SET failures=5 WHERE id='root-work'").run();
  createKnowledgeBatch(
    db,
    {
      id: "batch",
      runId: "run-batch",
      tier: "routine",
      work: [{ id: "root-work", generation: 1, inputRevision: String(root.revision) }],
      frontier: [nodeFrontier("root", 0)],
      regionNodeIds: [],
    },
    2,
  );
  outcome("batch", "root", "offered");
  abandonKnowledgeBatch(db, { batchId: "batch", notBefore: 10, failure: policy }, 20);
  expect(latest("root")).toMatchObject({ status: "pending", failures: 6, due: 320 });
});

it("resets failures when queued work reaches a new input revision", () => {
  enqueue("work-a", "source-a");
  db.prepare("UPDATE knowledge_work SET failures=2 WHERE id='work-a'").run();
  db.prepare("UPDATE documents SET content_hash='v2' WHERE id='source-a'").run();
  refreshKnowledgeWork(db, ["work-a"], 10);
  expect(getKnowledgeWork(db, "work-a")).toMatchObject({ inputRevision: "v2", failures: 0 });
  db.prepare("UPDATE knowledge_work SET failures=2 WHERE id='work-a'").run();
  db.prepare("UPDATE documents SET content_hash='v3' WHERE id='source-a'").run();
  enqueueKnowledgeWork(
    db,
    {
      id: "fold",
      subjectId: "source-a",
      subjectKind: "source",
      reason: "change",
      inputRevision: "v3",
      tier: "routine",
      dueAt: 30,
    },
    30,
  );
  expect(getKnowledgeWork(db, "work-a")).toMatchObject({ inputRevision: "v3", failures: 0 });
});
