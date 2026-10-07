// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { z } from "zod";
import { beforeEach, afterEach, it, expect } from "vitest";
import { createLogger, type EntailCapability } from "@omnesis/core";
import { createAnnotationStorageTables } from "../storage/annotations.js";
import { createBrief, getBrief } from "../storage/briefs.js";
import { createBriefClaimsTables } from "../storage/brief-claims.js";
import { createBriefsStorageTables } from "../storage/schema.js";
import { directWriteGate, writeGateFromCall, type WriterCallFn } from "../../write-gate.js";
import { buildAnnotationTools, buildCognitionOwnTools } from "../steward/tools.js";

import { writerHandlers } from "../../scheduler/writer-handlers.js";
import { appendOpenLoopLedger, createOpenLoop, updateOpenLoop } from "../storage/open-loops.js";
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

const parallelContext = { sessionId: "session", messageId: "message" };
function parallelTools(
  options: { beforeRead?: () => Promise<void>; gate?: ReturnType<typeof directWriteGate> } = {},
) {
  let sequence = 0;
  return buildMaintenanceCanonicalTools(
    db,
    options.gate ?? directWriteGate(db),
    { batchId: "batch", runId: "run" },
    (gate) => [
      {
        name: "open_loop_search",
        description: "Search loops",
        schema: z.object({}),
        async invoke() {
          const loops = db.prepare("SELECT id FROM open_loops").all();
          await options.beforeRead?.();
          return {
            kind: "structured" as const,
            resultType: "open_loop.search_results",
            data: { loops },
          };
        },
      },
      {
        name: "open_loop_fetch",
        description: "Fetch loop",
        schema: z.object({ id: z.string() }),
        invoke(args: unknown) {
          const { id } = args as { id: string };
          return Promise.resolve({
            kind: "structured" as const,
            resultType: "open_loop.fetched",
            data: { id },
          });
        },
      },
      {
        name: "open_loop_create",
        description: "Create loop",
        schema: z.object({}),
        mutates: true,
        async invoke() {
          const result = await gate.createOpenLoop(
            {
              id: `created-${++sequence}`,
              createdByRun: "run",
              title: "Prepare workshop",
              confidence: 0.8,
              importance: 0.5,
            },
            { runId: "run", priors: [] },
            10,
          );
          return { kind: "structured" as const, resultType: "open_loop.created", data: result };
        },
      },
      {
        name: "open_loop_update",
        description: "Update loop",
        schema: z.object({ id: z.string() }),
        mutates: true,
        async invoke(args: unknown) {
          const { id } = args as { id: string };
          const result = await gate.updateOpenLoop(
            id,
            { state: "done" },
            { runId: "run", priors: [] },
            20,
          );
          return { kind: "structured" as const, resultType: "open_loop.updated", data: result };
        },
      },
    ],
    { parallel: true },
  );
}
function invokeParallel(tools: ReturnType<typeof parallelTools>, name: string, args = {}) {
  return tools.find((tool) => tool.name === name)!.invoke(args, parallelContext);
}
function seedParallelLoop(id = "target") {
  createOpenLoop(
    db,
    { id, createdByRun: "prior", title: "Prepare workshop", confidence: 0.8, importance: 0.5 },
    1,
  );
}

it("requires a reconciliation read and refuses a second negative-search create", async () => {
  const first = parallelTools();
  const second = parallelTools();
  expect(await invokeParallel(first, "open_loop_create")).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  await Promise.all([
    invokeParallel(first, "open_loop_search"),
    invokeParallel(second, "open_loop_search"),
  ]);
  expect(await invokeParallel(first, "open_loop_create")).toMatchObject({ kind: "structured" });
  expect(await invokeParallel(second, "open_loop_create")).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(db.prepare("SELECT COUNT(*) AS n FROM open_loops").get()).toEqual({ n: 1 });
  await invokeParallel(second, "open_loop_search");
  expect(await invokeParallel(second, "open_loop_update", { id: "created-1" })).toMatchObject({
    kind: "structured",
  });
});

it("refuses a stale model update even when the competing write precedes invocation", async () => {
  seedParallelLoop();
  const tools = parallelTools();
  await invokeParallel(tools, "open_loop_fetch", { id: "target" });
  updateOpenLoop(db, "target", { state: "dismissed" }, 2);
  expect(await invokeParallel(tools, "open_loop_update", { id: "target" })).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(db.prepare("SELECT state FROM open_loops WHERE id='target'").get()).toEqual({
    state: "dismissed",
  });
});

it("does not bless a DTO read before an asynchronous search completed", async () => {
  seedParallelLoop();
  const tools = parallelTools({
    beforeRead: () => {
      updateOpenLoop(db, "target", { state: "dismissed" }, 2);
      return Promise.resolve();
    },
  });
  expect(await invokeParallel(tools, "open_loop_search")).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(await invokeParallel(tools, "open_loop_update", { id: "target" })).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
});

it("retains exact own-write receipts and never acknowledges a later writer", async () => {
  let interleave = false;
  const call: WriterCallFn = async (op, args) => {
    const handler = (
      writerHandlers as unknown as Record<
        string,
        (db: Database.Database, ...args: unknown[]) => unknown
      >
    )[op]!;
    const result = handler(db, ...args);
    if (interleave) {
      interleave = false;
      seedParallelLoop("other");
    }
    return result as never;
  };
  const tools = parallelTools({ gate: writeGateFromCall(call) });
  await invokeParallel(tools, "open_loop_search");
  interleave = true;
  expect(await invokeParallel(tools, "open_loop_create")).toMatchObject({ kind: "structured" });
  expect(await invokeParallel(tools, "open_loop_create")).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  // The newly created owner itself has an exact receipt, despite never being fetched.
  // Reconcile the changed collection before this update.
  await invokeParallel(tools, "open_loop_search");
  expect(await invokeParallel(tools, "open_loop_update", { id: "created-1" })).toMatchObject({
    kind: "structured",
  });
});

it("keeps the collection revision monotone when an owner is deleted and recreated", async () => {
  seedParallelLoop();
  const tools = parallelTools();
  await invokeParallel(tools, "open_loop_search");
  db.prepare("DELETE FROM open_loops WHERE id=?").run("target");
  seedParallelLoop();
  expect(await invokeParallel(tools, "open_loop_create")).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
});

it("requires annotation reconciliation for the actual subject", async () => {
  db.prepare("INSERT INTO documents(id,content,content_hash) VALUES(?,?,?)").run(
    "other",
    "The workshop begins Friday.",
    "other-v1",
  );
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
        log: createLogger("test:annotation-reconciliation"),
      }),
    { parallel: true },
  );
  await tools
    .find((tool) => tool.name === "annotation_search")!
    .invoke({ docId: "evidence" }, parallelContext);
  const args = {
    docId: "other",
    claimType: "key-date",
    claimText: "The workshop begins Friday.",
    evidenceDocId: "other",
    evidenceQuote: "The workshop begins Friday.",
    confidence: 0.8,
    claimBasis: "quoted",
  };
  expect(
    await tools.find((tool) => tool.name === "annotate_durable")!.invoke(args, parallelContext),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(db.prepare("SELECT COUNT(*) AS n FROM doc_annotations").get()).toEqual({ n: 0 });
  await tools
    .find((tool) => tool.name === "annotation_search")!
    .invoke({ docId: "other" }, parallelContext);
  expect(
    await tools.find((tool) => tool.name === "annotate_durable")!.invoke(args, parallelContext),
  ).toMatchObject({ kind: "structured" });
});

it("rejects a fetched loop update after a ledger append at the same timestamp", async () => {
  seedParallelLoop();
  const tools = parallelTools();
  await invokeParallel(tools, "open_loop_fetch", { id: "target" });
  appendOpenLoopLedger(db, "target", { runId: "peer", note: "Workshop plan revised." }, 1);
  expect(await invokeParallel(tools, "open_loop_update", { id: "target" })).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(db.prepare("SELECT state,last_update FROM open_loops WHERE id='target'").get()).toEqual({
    state: "open",
    last_update: 1,
  });
});

it("rejects a fetched brief replacement after only its live asserted claims changed", async () => {
  createBriefClaimsTables(db);
  createBrief(
    db,
    {
      id: "brief",
      createdByRun: "prior",
      kind: "info",
      title: "Workshop plan",
      confidence: 0.8,
      urgency: 0.5,
      claims: [
        {
          id: "claim",
          claimText: "The workshop begins Friday.",
          evidenceDocId: "evidence",
          evidenceQuote: "The workshop begins Friday.",
          claimBasis: "quoted",
          verificationState: "verified",
          confidence: 0.8,
        },
      ],
    },
    1,
  );
  const tools = buildMaintenanceCanonicalTools(
    db,
    directWriteGate(db),
    { batchId: "batch", runId: "run" },
    (writeGate) =>
      buildCognitionOwnTools({
        db,
        writeGate,
        clock: () => 10,
        runId: "run",
        briefLane: "reactive",
        log: createLogger("test:brief-reconciliation"),
        searchPort: {
          search: (input) => Promise.resolve({ query: input.query, durationMs: 0, results: [] }),
        },
        mirror: { refresh: () => Promise.resolve(), remove: () => Promise.resolve() },
        getNotesMaxBytes: () => 8192,
      }),
    { parallel: true },
  );
  const before = getBrief(db, "brief");
  expect(
    await tools
      .find((tool) => tool.name === "brief_fetch")!
      .invoke({ id: "brief" }, parallelContext),
  ).toMatchObject({ kind: "structured" });
  db.prepare("UPDATE brief_claims SET claim_text=? WHERE id='claim'").run(
    "The workshop was postponed.",
  );
  expect(getBrief(db, "brief")).toEqual(before);
  expect(
    await tools
      .find((tool) => tool.name === "brief_update")!
      .invoke(
        {
          id: "brief",
          description: "Old workshop plan",
          assertedClaims: [],
          annotationDependencies: [],
        },
        parallelContext,
      ),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(
    db.prepare("SELECT claim_text,invalidated_at FROM brief_claims WHERE id='claim'").get(),
  ).toEqual({ claim_text: "The workshop was postponed.", invalidated_at: null });
});
