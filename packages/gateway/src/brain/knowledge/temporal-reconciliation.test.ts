// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, it } from "vitest";
import {
  buildBuiltinTools,
  PlanStore,
  type ToolHandle,
  type TemporalReadPort,
} from "@omnesis/agent";
import { createLogger, type EntailCapability } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import {
  directWriteGate,
  writeGateFromCall,
  type WriteGate,
  type WriterCallFn,
} from "../../write-gate.js";
import { writerHandlers } from "../../scheduler/writer-handlers.js";
import { TemporalQueryService } from "../../enrichment/temporal/temporal-query-service.js";
import { insertTemporalAnnotation } from "../../enrichment/temporal-annotations/storage.js";
import { buildCognitionOwnTools } from "../steward/tools.js";
import { createOpenLoopMirror } from "../steward/mirror.js";
import { buildMaintenanceCanonicalTools } from "./canonical-tool-fence.js";
import { readKnowledgeCollectionRevision } from "./reconciliation.js";

let db: ReturnType<typeof createDatabase>;
let sequence: number;
const log = createLogger("test:temporal-reconciliation");
const context = { sessionId: "session", messageId: "message" };
const quote = "The workshop takes place on 3 April 2031.";
beforeEach(() => {
  db = createDatabase(":memory:");
  sequence = 0;
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
    VALUES('evidence','test','fixture','evidence','Workshop',?,'v1','{}','2031-04-01','2031-04-01','2031-04-01','2031-04-01')`,
  ).run(quote);
});
afterEach(() => db.close());

function toolsFor(
  runId: string,
  options: { gate?: WriteGate; verifier?: EntailCapability; port?: TemporalReadPort } = {},
) {
  db.prepare(
    "INSERT INTO knowledge_batches(id,run_id,creation_fingerprint,tier,status,created_at,updated_at) VALUES(?,?,'fp','routine','running',1,1)",
  ).run(runId, runId);
  db.prepare(
    "INSERT INTO knowledge_frontier(batch_id,node_id,input_fingerprint,input_versions_json,depth,status) VALUES(?,'source:evidence','fp',?,0,'offered')",
  ).run(runId, JSON.stringify({ "source:evidence": "v1" }));
  const gate = options.gate ?? directWriteGate(db);
  const service = new TemporalQueryService(db);
  const port: TemporalReadPort = options.port ?? { query: (input) => service.query(input) };
  return buildMaintenanceCanonicalTools(
    db,
    gate,
    { batchId: runId, runId },
    (writeGate) => [
      ...buildBuiltinTools({
        ports: {
          temporal: port,
          search: {
            search: (input) => Promise.resolve({ query: input.query, durationMs: 0, results: [] }),
          },
          document: { fetch: () => Promise.resolve(null) },
        },
        planStore: new PlanStore(),
      }).filter((tool) => tool.name === "temporal_query"),
      ...buildCognitionOwnTools({
        db,
        writeGate,
        temporalPort: port,
        searchPort: {
          search: (input) => Promise.resolve({ query: input.query, durationMs: 0, results: [] }),
        },
        mirror: createOpenLoopMirror({ db, writeGate, log }),
        getNotesMaxBytes: () => 8192,
        clock: () => 100,
        runId,
        briefLane: "reactive",
        log,
        idGen: () => `temporal-${++sequence}`,
        ...(options.verifier
          ? { getEntailmentVerifier: () => Promise.resolve(options.verifier!) }
          : {}),
      }),
    ],
    { parallel: true },
  );
}
function invoke(tools: ToolHandle[], name: string, args: unknown = {}) {
  return tools.find((tool) => tool.name === name)!.invoke(args, context);
}
function query(tools: ToolHandle[]) {
  return invoke(tools, "temporal_query", {
    from: "2031-04-01",
    to: "2031-05-01",
    origins: ["annotation"],
    timeZone: "UTC",
  });
}
const add = { when: "2031-04-03", sentence: quote, force: true };
function externalWrite(id = "external") {
  insertTemporalAnnotation(
    db,
    {
      id,
      intervalStartMs: 1932940800000,
      intervalEndMs: 1933027199999,
      precision: "day",
      canonical: "2031-04-03",
      sentence: quote,
      documentIds: [],
      createdByRun: "external-run",
    },
    100,
  );
}
function onlyId() {
  return db.prepare<[], { id: string }>("SELECT id FROM temporal_annotations").get()!.id;
}

it.each(["temporal_annotation_add", "temporal_annotation_update", "temporal_annotation_delete"])(
  "requires the actual temporal_query before %s",
  async (name) => {
    const tools = toolsFor("run");
    expect(
      await invoke(tools, name, name.endsWith("add") ? add : { annotationId: "missing" }),
    ).toMatchObject({ kind: "error", code: "revision_conflict" });
    expect(await invoke(tools, "temporal_query", { unknown: true })).toMatchObject({
      kind: "error",
    });
    expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({
      kind: "error",
      code: "revision_conflict",
    });
    expect(await query(tools)).toMatchObject({
      kind: "structured",
      resultType: "temporal.results",
    });
    expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({
      kind: "structured",
      resultType: "temporal_annotation.added",
    });
  },
);

it("carries exact own-write receipts through add, update and delete", async () => {
  const tools = toolsFor("run");
  await query(tools);
  expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({
    resultType: "temporal_annotation.added",
  });
  const annotationId = onlyId();
  expect(
    await invoke(tools, "temporal_annotation_update", {
      annotationId,
      sentence: "Workshop planning session.",
    }),
  ).toMatchObject({ resultType: "temporal_annotation.updated" });
  expect(await invoke(tools, "temporal_annotation_delete", { annotationId })).toMatchObject({
    resultType: "temporal_annotation.deleted",
  });
});

it.each(["temporal_annotation_update", "temporal_annotation_delete"])(
  "rejects %s after an intervening temporal edit",
  async (name) => {
    externalWrite();
    const tools = toolsFor("run");
    await query(tools);
    db.exec("UPDATE temporal_annotations SET sentence='The workshop moved.' WHERE id='external'");
    expect(
      await invoke(tools, name, {
        annotationId: "external",
        ...(name.endsWith("update") ? { sentence: quote } : {}),
      }),
    ).toMatchObject({ kind: "error", code: "revision_conflict" });
    expect(
      db
        .prepare("SELECT sentence,invalidated_at FROM temporal_annotations WHERE id='external'")
        .get(),
    ).toEqual({ sentence: "The workshop moved.", invalidated_at: null });
  },
);

it.each(["temporal_annotation_update", "temporal_annotation_delete"])(
  "an unrelated fresh query does not authorize %s on an earlier annotation",
  async (name) => {
    externalWrite("annotation-a");
    const tools = toolsFor("run");
    expect(await query(tools)).toMatchObject({ kind: "structured" });
    db.exec(
      "UPDATE temporal_annotations SET sentence='The workshop moved.' WHERE id='annotation-a'",
    );
    expect(
      await invoke(tools, "temporal_query", {
        from: "2031-06-01",
        to: "2031-07-01",
        origins: ["annotation"],
        timeZone: "UTC",
      }),
    ).toMatchObject({ kind: "structured", data: { items: [] } });
    const args = {
      annotationId: "annotation-a",
      ...(name.endsWith("update") ? { sentence: quote } : {}),
    };
    expect(await invoke(tools, name, args)).toMatchObject({
      kind: "error",
      code: "revision_conflict",
    });
    await query(tools);
    expect(await invoke(tools, name, args)).toMatchObject({ kind: "structured" });
  },
);

it("an own write refreshes only the returned annotation identity", async () => {
  externalWrite("annotation-a");
  externalWrite("annotation-b");
  const tools = toolsFor("run");
  await query(tools);
  expect(
    await invoke(tools, "temporal_annotation_update", {
      annotationId: "annotation-a",
      sentence: "The workshop venue is confirmed.",
    }),
  ).toMatchObject({ resultType: "temporal_annotation.updated" });
  expect(
    await invoke(tools, "temporal_annotation_update", {
      annotationId: "annotation-b",
      sentence: "Another workshop.",
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(
    await invoke(tools, "temporal_annotation_delete", {
      annotationId: "annotation-a",
    }),
  ).toMatchObject({ resultType: "temporal_annotation.deleted" });
});

it("rejects a read spanning a concurrent annotation change", async () => {
  const service = new TemporalQueryService(db);
  const tools = toolsFor("run", {
    port: {
      query: async (input) => {
        const result = await service.query(input);
        externalWrite();
        return result;
      },
    },
  });
  expect(await query(tools)).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
});

it("admits one competing add after asynchronous verification and rejects the stale peer", async () => {
  let entered = 0;
  let bothEntered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    bothEntered = resolve;
  });
  const continueVerification = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verifier: EntailCapability = {
    verify: async () => {
      if (++entered === 2) bothEntered();
      await continueVerification;
      return { label: "entailment" };
    },
    dispose() {},
  };
  const a = toolsFor("a", { verifier }),
    b = toolsFor("b", { verifier });
  await Promise.all([query(a), query(b)]);
  const args = { ...add, evidence: { docId: "evidence", quote } };
  const pending = Promise.all([
    invoke(a, "temporal_annotation_add", args),
    invoke(b, "temporal_annotation_add", args),
  ]);
  await Promise.race([
    ready,
    pending.then((results) => {
      throw new Error(`Verification was not reached: ${JSON.stringify(results)}`);
    }),
  ]);
  release();
  const results = await pending;
  expect(results.filter((result) => result.kind === "structured")).toHaveLength(1);
  expect(results.filter((result) => result.kind === "error")).toEqual([
    expect.objectContaining({ code: "revision_conflict" }),
  ]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM temporal_annotations").get()).toEqual({ n: 1 });
});

it("does not acknowledge an external write after its own writer transaction", async () => {
  let interleave = true;
  const call: WriterCallFn = (op, args) => {
    const handler = (
      writerHandlers as unknown as Record<
        string,
        (database: ReturnType<typeof createDatabase>, ...args: unknown[]) => unknown
      >
    )[op]!;
    const result = handler(db, ...args);
    if (interleave) {
      interleave = false;
      externalWrite();
    }
    return Promise.resolve(result) as never;
  };
  const tools = toolsFor("run", { gate: writeGateFromCall(call) });
  await query(tools);
  expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({
    resultType: "temporal_annotation.added",
  });
  expect(
    await invoke(tools, "temporal_annotation_add", { ...add, when: "2031-04-04" }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  await query(tools);
  expect(
    await invoke(tools, "temporal_annotation_add", { ...add, when: "2031-04-04" }),
  ).toMatchObject({ resultType: "temporal_annotation.added" });
});

it("invalidates receipts for sidecar edits and delete/recreate ABA", () => {
  const start = readKnowledgeCollectionRevision(db, "temporal");
  externalWrite();
  const inserted = readKnowledgeCollectionRevision(db, "temporal");
  expect(inserted).toBeGreaterThan(start);
  db.exec("INSERT INTO temporal_annotation_documents VALUES('external','evidence')");
  expect(readKnowledgeCollectionRevision(db, "temporal")).toBeGreaterThan(inserted);
  const linked = readKnowledgeCollectionRevision(db, "temporal");
  db.exec("DELETE FROM temporal_annotations WHERE id='external'");
  externalWrite();
  expect(readKnowledgeCollectionRevision(db, "temporal")).toBeGreaterThan(linked);
});
