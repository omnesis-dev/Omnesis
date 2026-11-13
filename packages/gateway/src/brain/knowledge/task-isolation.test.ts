// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { createLabTable, setLabFlag } from "../../lab/store.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { resolveBrainSettings } from "../config.js";
import { convertKnowledgeOwner } from "./owner-adapters.js";
import { KnowledgeService } from "./service.js";
import { createKnowledgeTables, getKnowledgeNode } from "./storage.js";
import { directKnowledgeGate } from "./writer.js";
import { KNOWLEDGE_SOURCE_ID } from "./source-meta.js";
import { KnowledgeEngine } from "./engine.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { enqueueKnowledgeWork, createKnowledgeBatch } from "./work.js";
import { knowledgeHash } from "./storage-validation.js";
import { buildKnowledgeTools } from "./tools.js";

let db: Database.Database;
let service: KnowledgeService;
beforeEach(() => {
  vi.stubEnv("OMNESIS_EXPERIMENTAL", "1");
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT,source_id TEXT,external_id TEXT)",
  );
  createBriefsStorageTables(db);
  createKnowledgeTables(db);
  createLabTable(db);
  setLabFlag(db, "tasks", true);
  createOpenLoop(
    db,
    {
      id: "task_example",
      createdByRun: "run",
      title: "Prepare workshop",
      description: "Prepare the workshop.",
      importance: 0.5,
      confidence: 1,
    },
    1,
  );
  convertKnowledgeOwner(db, "loop", "task_example", 2);
  service = new KnowledgeService({
    db,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log: createLogger("knowledge-task-isolation-test"),
  });
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

it("withholds task synthesis reads, history and references while preserving stored evidence", () => {
  expect(service.fetch("task_example")).not.toBeNull();
  expect(service.list({ kind: "loop" })).toHaveLength(1);
  expect(service.reference("loop:task_example#field:state").text).toBe('"open"');
  setLabFlag(db, "tasks", false);
  expect(service.fetch("task_example")).toBeNull();
  expect(service.editingSnapshot("task_example")).toBeNull();
  expect(service.list({ kind: "loop" })).toEqual([]);
  expect(service.list()).toEqual([]);
  expect(() => service.reference("loop:task_example#field:state")).toThrow(
    "Knowledge reference unavailable",
  );
  expect(() => service.history({ id: "task_example" })).toThrow("Knowledge history unavailable");
  expect(getKnowledgeNode(db, "task_example")).not.toBeNull();
  setLabFlag(db, "tasks", true);
  expect(service.fetch("task_example")).not.toBeNull();
});

it("withholds scoped loop synthesis tools and rechecks existing handles after opt-out", async () => {
  const context = { runId: "run", scopedOwnersOnly: true };
  const handles = buildKnowledgeTools(service, context);
  const loop = handles.find((entry) => entry.name === "loop_synthesis_save")!;
  expect(loop).toBeDefined();
  setLabFlag(db, "tasks", false);
  const hidden = buildKnowledgeTools(service, context);
  expect(hidden.some((entry) => entry.name === "loop_synthesis_save")).toBe(false);
  expect(hidden.some((entry) => entry.name === "doc_annotation_synthesis_save")).toBe(true);
  expect(
    hidden.find((entry) => entry.name === "knowledge_list")!.schema.safeParse({ kind: "loop" })
      .success,
  ).toBe(false);
  expect(hidden.find((entry) => entry.name === "knowledge_reference")!.description).not.toContain(
    "loop:",
  );
  expect(hidden.find((entry) => entry.name === "knowledge_link")).toBeUndefined();
  const node = getKnowledgeNode(db, "task_example")!;
  expect(
    await loop.invoke(
      {
        id: node.id,
        title: node.title,
        markdown: node.markdown,
        expectedRevision: node.revision,
        inputVersions: {},
      },
      { sessionId: "session", messageId: "message" },
    ),
  ).toMatchObject({ kind: "error", code: "reference_invalid" });
});

it("settles an already batched task without offering it after opt-out", async () => {
  createKnowledgeWorkTables(db);
  const node = getKnowledgeNode(db, "task_example")!;
  const versions = { "node:task_example": node.revision };
  enqueueKnowledgeWork(
    db,
    {
      id: "work",
      subjectId: node.id,
      subjectKind: "node",
      reason: "review",
      inputRevision: String(node.revision),
      tier: "routine",
      dueAt: 10,
    },
    10,
  );
  createKnowledgeBatch(
    db,
    {
      id: "batch",
      runId: "run",
      tier: "routine",
      work: [{ id: "work", generation: 1, inputRevision: String(node.revision) }],
      regionNodeIds: [node.id],
      frontier: [
        {
          nodeId: node.id,
          inputFingerprint: knowledgeHash(versions),
          inputVersions: versions,
          depth: 0,
        },
      ],
    },
    10,
  );
  const log = createLogger("knowledge-task-isolation-test");
  const engine = new KnowledgeEngine({
    db,
    service,
    writeGate: directKnowledgeGate(db),
    getSettings: () => resolveBrainSettings(),
    clock: () => 10,
    log,
    decisions: { getDecision: () => null, log, recordSpend: async () => {} },
  });
  setLabFlag(db, "tasks", false);
  expect((await engine.next("batch", "run")).items).toEqual([]);
  expect(getKnowledgeNode(db, node.id)).not.toBeNull();
});

it("cannot resolve a task mirror through its source reference after opt-out", () => {
  db.prepare(
    "INSERT INTO documents VALUES('task_mirror','Prepare the workshop.','v1',?,'task_example')",
  ).run(KNOWLEDGE_SOURCE_ID);
  setLabFlag(db, "tasks", false);
  expect(() => service.reference("source:task_mirror")).toThrow("Knowledge reference unavailable");
});
