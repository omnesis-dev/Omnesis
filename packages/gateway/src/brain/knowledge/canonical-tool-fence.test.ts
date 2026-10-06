// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { beforeEach, afterEach, it, expect } from "vitest";
import { createLogger, type EntailCapability } from "@omnesis/core";
import { createAnnotationStorageTables } from "../storage/annotations.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { directWriteGate, writeGateFromCall, type WriterCallFn } from "../../write-gate.js";
import { buildAnnotationTools, buildCognitionOwnTools } from "../steward/tools.js";

import { writerHandlers } from "../../scheduler/writer-handlers.js";
import { createOpenLoop, updateOpenLoop } from "../storage/open-loops.js";
import { buildMaintenanceCanonicalTools } from "./canonical-tool-fence.js";
import { createKnowledgeWorkTables } from "./work-schema.js";
import { createKnowledgeTables } from "./schema.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    "CREATE TABLE documents(id TEXT PRIMARY KEY,content TEXT,content_hash TEXT,metadata TEXT,source_id TEXT DEFAULT 'test-source'); CREATE TABLE removed_sources(id TEXT PRIMARY KEY); INSERT INTO documents(id,content,content_hash) VALUES('evidence','The workshop begins Friday.','v1')",
  );
  createBriefsStorageTables(db);
  createAnnotationStorageTables(db);
  createKnowledgeTables(db);
  createKnowledgeWorkTables(db);
  db.exec(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES('batch','run','batch-fingerprint','routine','running',1,1)",
  );
  db.prepare(
    "INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES('batch','source:evidence','input-fingerprint',?,0,'offered')",
  ).run(JSON.stringify({ "source:evidence": "v1" }));
});
afterEach(() => db.close());
it.each([
  "abandoned",
  "source-revised",
  "frontier-replaced",
  "cited-source-revised",
  "cited-source-generated",
  "additional-source-revised",
  "current",
])("fences a real canonical annotation after its delayed verifier: %s", async (change) => {
  db.prepare("INSERT INTO documents(id,content,content_hash) VALUES(?,?,?)").run(
    "extra",
    "The workshop begins Friday.",
    "extra-v1",
  );
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verifier: EntailCapability = {
    verify: async () => {
      enter();
      await ready;
      return { label: "entailment" };
    },
    dispose: () => {},
  };
  const tools = buildMaintenanceCanonicalTools(
    db,
    directWriteGate(db),
    { batchId: "batch", runId: "run" },
    (writeGate) =>
      buildAnnotationTools({
        db,
        writeGate,
        clock: () => 10,
        runId: "run",
        log: createLogger("test:canonical-fence"),
        getEntailmentVerifier: async () => verifier,
      }),
  );
  const pending = tools
    .find((tool) => tool.name === "annotate_durable")!
    .invoke(
      {
        docId: "evidence",
        claimType: "key-date",
        claimText: "The workshop begins Friday.",
        evidenceDocId: change.startsWith("cited-source-") ? "extra" : "evidence",
        ...(change === "additional-source-revised"
          ? { additionalEvidence: [{ docId: "extra", quote: "The workshop begins Friday." }] }
          : {}),
        evidenceQuote: "The workshop begins Friday.",
        confidence: 0.8,
        claimBasis: "quoted",
      },
      { sessionId: "session", messageId: "message" },
    );
  await Promise.race([
    entered,
    pending.then((result) => {
      throw new Error(`Tool ended before reaching the delayed boundary: ${JSON.stringify(result)}`);
    }),
  ]);
  if (change === "abandoned") db.exec("UPDATE knowledge_batches SET status='abandoned'");
  if (change === "source-revised")
    db.exec("UPDATE documents SET content_hash='v2',content='The workshop begins Saturday.'");
  if (change === "cited-source-revised" || change === "additional-source-revised")
    db.exec(
      "UPDATE documents SET content_hash='extra-v2',content='The workshop begins Saturday.' WHERE id='extra'",
    );
  if (change === "cited-source-generated")
    db.exec("UPDATE documents SET source_id='brain-knowledge' WHERE id='extra'");
  if (change === "frontier-replaced")
    db.exec("UPDATE knowledge_frontier SET input_fingerprint='replacement'");
  release();
  expect(await pending).toMatchObject(
    change === "current" ? { kind: "structured" } : { kind: "error", code: "revision_conflict" },
  );
  expect(db.prepare("SELECT COUNT(*) AS n FROM doc_annotations").get()).toEqual({
    n: change === "current" ? 1 : 0,
  });
});

it.each(["changed", "current", "missing-evidence"])(
  "fences an unrelated canonical loop queued behind another writer: %s",
  async (scenario) => {
    const changed = scenario === "changed";
    createOpenLoop(
      db,
      {
        id: "target",
        createdByRun: "prior",
        title: "Prepare workshop",
        confidence: 0.8,
        importance: 0.5,
        docs: [scenario === "missing-evidence" ? "missing" : "evidence"],
      },
      1,
    );
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call: WriterCallFn = async (op, args) => {
      enter();
      await ready;
      const handler = (
        writerHandlers as unknown as Record<
          string,
          (db: Database.Database, ...args: unknown[]) => unknown
        >
      )[op];
      if (!handler) throw new Error(`Unexpected writer operation: ${op}`);
      return handler(db, ...args) as never;
    };
    const tools = buildMaintenanceCanonicalTools(
      db,
      writeGateFromCall(call),
      { batchId: "batch", runId: "run" },
      (writeGate) =>
        buildCognitionOwnTools({
          db,
          writeGate,
          clock: () => 10,
          runId: "run",
          briefLane: "reactive",
          log: createLogger("test:canonical-fence"),
          searchPort: {
            search: (input) => Promise.resolve({ query: input.query, durationMs: 0, results: [] }),
          },
          mirror: { refresh: () => Promise.resolve(), remove: () => Promise.resolve() },
          getNotesMaxBytes: () => 8192,
        }),
    );
    const pending = tools
      .find((tool) => tool.name === "open_loop_update")!
      .invoke(
        { id: "target", state: "done", annotationDependencies: [] },
        { sessionId: "session", messageId: "message" },
      );
    await Promise.race([
      entered,
      pending.then((result) => {
        throw new Error(
          `Tool ended before reaching the delayed boundary: ${JSON.stringify(result)}`,
        );
      }),
    ]);
    if (changed) updateOpenLoop(db, "target", { state: "dismissed" }, 2);
    release();
    expect(await pending).toMatchObject(
      changed ? { kind: "error", code: "revision_conflict" } : { kind: "structured" },
    );
    expect(db.prepare("SELECT state FROM open_loops WHERE id='target'").get()).toEqual({
      state: changed ? "dismissed" : "done",
    });
  },
);

it.each(["primary", "additional"])(
  "refuses a current generated synthesis as %s annotation evidence before verification",
  async (position) => {
    db.prepare(
      "INSERT INTO documents(id,content,content_hash,source_id,metadata) VALUES(?,?,?,?,?)",
    ).run(
      "generated",
      "The workshop begins Friday.",
      "generated-v1",
      position === "primary" ? "brain-knowledge" : "test-source",
      position === "additional" ? JSON.stringify({ documentType: "knowledge" }) : null,
    );
    let verifierCalls = 0;
    const tools = buildMaintenanceCanonicalTools(
      db,
      directWriteGate(db),
      { batchId: "batch", runId: "run" },
      (writeGate) =>
        buildAnnotationTools({
          db,
          writeGate,
          clock: () => 10,
          runId: "run",
          log: createLogger("test:canonical-fence"),
          getEntailmentVerifier: async () => ({
            verify: async () => {
              verifierCalls++;
              return { label: "entailment" };
            },
            dispose: () => {},
          }),
        }),
    );
    const result = await tools
      .find((tool) => tool.name === "annotate_durable")!
      .invoke(
        {
          docId: "evidence",
          claimType: "key-date",
          claimText: "The workshop begins Friday.",
          evidenceDocId: position === "primary" ? "generated" : "evidence",
          evidenceQuote: "The workshop begins Friday.",
          confidence: 0.8,
          claimBasis: "quoted",
          ...(position === "additional"
            ? { additionalEvidence: [{ docId: "generated", quote: "The workshop begins Friday." }] }
            : {}),
        },
        { sessionId: "session", messageId: "message" },
      );
    expect(result).toMatchObject({ kind: "error", code: "invalid_evidence" });
    expect(verifierCalls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM doc_annotations").get()).toEqual({ n: 0 });
  },
);
