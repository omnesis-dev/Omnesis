// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { writerHandlers } from "../../scheduler/writer-handlers.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createAnnotationStorageTables } from "../storage/annotations.js";
import { createPersonAnnotationStorageTables } from "../storage/person-annotations.js";
import { createOpenLoop, getOpenLoop } from "../storage/open-loops.js";
import { createBrief } from "../storage/briefs.js";
import { createKnowledgeTables } from "./schema.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { captureKnowledgeCanonicalFence } from "./canonical-fence.js";
import { captureCanonicalEnrollment, enrollCanonicalMutation } from "./canonical-enrollment.js";
import { getKnowledgeNode } from "./storage-read.js";
import { installKnowledgeOwnerTriggers } from "./owner-triggers.js";

let db: Database.Database;
const run = { batchId: "batch", runId: "run" };
const dependencies = { runId: "run", priors: [] };
const input = {
  id: "task",
  createdByRun: "run",
  title: "Prepare workshop",
  description: "Bring notebooks.",
  confidence: 0.8,
  importance: 0.5,
  docs: ["evidence"],
};
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT,source_id TEXT DEFAULT 'test-source'); INSERT INTO documents(id,content,content_hash) VALUES('evidence','Bring notebooks.','v1'),('other','Bring pencils.','v2')",
  );
  createBriefsStorageTables(db);
  createAnnotationStorageTables(db);
  createPersonAnnotationStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  installKnowledgeOwnerTriggers(db);
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','fingerprint','routine','running',1,1)",
  );
  for (const [id, revision] of [
    ["evidence", "v1"],
    ["other", "v2"],
  ])
    db.prepare(
      "INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES('batch',?,?,?,0,'offered')",
    ).run(`source:${id}`, `fp:${id}`, JSON.stringify({ [`source:${id}`]: revision }));
});
afterEach(() => db.close());
function hints() {
  return db
    .prepare("SELECT source_id,node_id FROM knowledge_discovery_targets ORDER BY source_id,node_id")
    .all();
}
function create(patch: Partial<typeof input> = {}) {
  return writerHandlers["knowledge.canonicalMutation"](
    db,
    captureKnowledgeCanonicalFence(db, run),
    "cognition.openLoopCreate",
    [{ ...input, ...patch }, dependencies, 10],
  );
}
it("atomically enrolls a persisted owner only against its offered evidence", () => {
  expect(create()).toMatchObject({ ok: true });
  expect(getKnowledgeNode(db, "task")).toMatchObject({
    kind: "loop",
    plainText: "Bring notebooks.",
  });
  expect(hints()).toEqual([{ source_id: "evidence", node_id: "task" }]);
  expect(db.prepare("SELECT 1 FROM knowledge_work").all()).toEqual([]);
});
it("reconciles updated prose immediately without waiting for the owner sweep", () => {
  create();
  const fence = captureKnowledgeCanonicalFence(db, run, { id: "task" }, "open_loop_update");
  const result = writerHandlers["knowledge.canonicalMutation"](
    db,
    fence,
    "cognition.openLoopUpdate",
    ["task", { description: "Bring twelve notebooks." }, dependencies, 20],
  );
  expect(result).toMatchObject({ ok: true });
  expect(getKnowledgeNode(db, "task")?.plainText).toBe("Bring twelve notebooks.");
  expect(hints()).toHaveLength(1);
  expect(
    db.prepare("SELECT 1 FROM knowledge_owner_changes WHERE owner_id='task'").get(),
  ).toBeUndefined();
});
it("queues independent review when no offered source is persisted as evidence", () => {
  create({ docs: [] });
  expect(hints()).toEqual([]);
  expect(db.prepare("SELECT subject_id,reason,status FROM knowledge_work").all()).toEqual([
    { subject_id: "task", reason: "review", status: "pending" },
  ]);
});
it("does not publish phantom owners on a failed dependency gate", () => {
  const result = writerHandlers["knowledge.canonicalMutation"](
    db,
    captureKnowledgeCanonicalFence(db, run),
    "cognition.openLoopCreate",
    [input, { runId: "run", priors: [{ priorStore: "doc", priorAnnotationId: "missing" }] }, 10],
  );
  expect(result).toMatchObject({ ok: true, value: { ok: false } });
  expect(getOpenLoop(db, "task")).toBeNull();
  expect(getKnowledgeNode(db, "task")).toBeNull();
  expect(hints()).toEqual([]);
});
it("rolls back oversized conversion together with the canonical mutation", () => {
  expect(() => create({ description: "x".repeat(262145) })).toThrow("bounded conversion budget");
  expect(getOpenLoop(db, "task")).toBeNull();
  expect(hints()).toEqual([]);
});
it("refuses stale source authority before writing anything", () => {
  const fence = captureKnowledgeCanonicalFence(db, run);
  db.exec("UPDATE documents SET content_hash='changed' WHERE id='evidence'");
  expect(
    writerHandlers["knowledge.canonicalMutation"](db, fence, "cognition.openLoopCreate", [
      input,
      dependencies,
      10,
    ]),
  ).toMatchObject({ ok: false, code: "revision_conflict" });
  expect(getOpenLoop(db, "task")).toBeNull();
  expect(hints()).toEqual([]);
});
it("keeps an edited, already offered owner unresolved until knowledge_save", () => {
  create();
  const revision = getKnowledgeNode(db, "task")!.revision;
  db.prepare(
    "INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES('batch','task','owner-fp',?,1,'offered')",
  ).run(JSON.stringify({ "node:task": revision }));
  expect(
    writerHandlers["knowledge.canonicalMutation"](
      db,
      captureKnowledgeCanonicalFence(db, run),
      "cognition.openLoopUpdate",
      ["task", { description: "Bring twelve notebooks." }, dependencies, 20],
    ),
  ).toMatchObject({ ok: true });
  expect(getKnowledgeNode(db, "task")!.revision).toBe(revision);
  expect(db.prepare("SELECT status FROM knowledge_frontier WHERE node_id='task'").get()).toEqual({
    status: "offered",
  });
  expect(
    db.prepare("SELECT operation FROM knowledge_owner_changes WHERE owner_id='task'").get(),
  ).toEqual({ operation: "update" });
});
it.each(["brief", "doc_annotation", "person_annotation"] as const)(
  "enrolls newly persisted %s owners without a model-provided target",
  (kind) => {
    const operation =
      kind === "brief"
        ? "cognition.briefCreate"
        : kind === "doc_annotation"
          ? "cognition.annotationCreate"
          : "cognition.personAnnotationCreate";
    const candidate = captureCanonicalEnrollment(db, operation, [{ id: "owner" }]);
    db.transaction(() => {
      if (kind === "brief")
        createBrief(
          db,
          {
            id: "owner",
            createdByRun: "run",
            title: "Workshop materials",
            description: "Bring notebooks.",
            kind: "info",
            confidence: 0.8,
            urgency: 0.3,
            citations: ["evidence"],
          },
          10,
        );
      else {
        const table = kind === "doc_annotation" ? "doc_annotations" : "person_annotations";
        const subject = kind === "doc_annotation" ? "doc_id" : "person_id";
        db.prepare(
          `INSERT INTO ${table}(id,${subject},claim_type,claim_text,evidence_doc_id,evidence_quote,confidence,created_by_run,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
        ).run(
          "owner",
          "evidence",
          "preparation",
          "Bring notebooks.",
          "evidence",
          "Bring notebooks.",
          0.8,
          "run",
          10,
        );
      }
      enrollCanonicalMutation(db, captureKnowledgeCanonicalFence(db, run), candidate, 10);
    })();
    expect(getKnowledgeNode(db, "owner")?.kind).toBe(kind);
    expect(hints()).toEqual([{ source_id: "evidence", node_id: "owner" }]);
  },
);
it("does not resurrect privacy-withdrawn owners", () => {
  createOpenLoop(db, input, 10);
  db.prepare("INSERT INTO knowledge_node_tombstones(id,deleted_at) VALUES('task',11)").run();
  enrollCanonicalMutation(
    db,
    captureKnowledgeCanonicalFence(db, run),
    { kind: "loop", id: "task", version: null },
    12,
  );
  expect(getKnowledgeNode(db, "task")).toBeNull();
  expect(hints()).toEqual([]);
});

it("keeps a canonical resolution valid while unavailable evidence leaves conversion pending", () => {
  createOpenLoop(db, { ...input, docs: ["missing"] }, 1);
  const fence = captureKnowledgeCanonicalFence(db, run, { id: "task" }, "open_loop_update");
  expect(
    writerHandlers["knowledge.canonicalMutation"](db, fence, "cognition.openLoopUpdate", [
      "task",
      { state: "done" },
      dependencies,
      20,
    ]),
  ).toMatchObject({ ok: true });
  expect(getOpenLoop(db, "task")?.state).toBe("done");
  expect(getKnowledgeNode(db, "task")).toBeNull();
  expect(hints()).toEqual([]);
  expect(db.prepare("SELECT kind,owner_id,operation FROM knowledge_owner_changes").all()).toEqual([
    { kind: "loop", owner_id: "task", operation: "update" },
  ]);
});
