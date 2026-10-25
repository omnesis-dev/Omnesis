// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import {
  readKnowledgeCollectionRevision,
  assertKnowledgeReconciliation,
} from "./reconciliation.js";
import { TemporalReconciliation } from "./temporal-reconciliation.js";
import type { CheckRecord } from "../record-check/check.js";

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
  options: {
    gate?: WriteGate;
    verifier?: EntailCapability;
    port?: TemporalReadPort;
    checkRecord?: CheckRecord;
  } = {},
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
        checkRecord: options.checkRecord,
        temporalPort: port,
        searchPort: {
          search: (input) => Promise.resolve({ query: input.query, durationMs: 0, results: [] }),
        },
        mirror: createOpenLoopMirror({ db, writeGate, log }),
        getNotesMaxBytes: () => 8192,
        clock: () => 100,
        runId,
        log,
        idGen: () => `temporal-${++sequence}`,
        ...(options.verifier
          ? { getEntailmentVerifier: () => Promise.resolve(options.verifier!) }
          : {}),
      }),
    ],
    { clock: () => 100, parallel: true },
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
    // Admission is a separate preflight; this race starts after the actual mutation commits.
    if (interleave && op === "knowledge.canonicalMutation") {
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
  expect(interleave).toBe(false);
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

it("rejects stale temporal reads before verifier and value checks, then accepts a refreshed read", async () => {
  const verify = vi.fn(async () => ({ label: "entailment" as const }));
  const checkRecord = vi.fn(async () => ({ save: true as const }));
  const tools = toolsFor("run", { verifier: { verify, dispose() {} }, checkRecord });
  await query(tools);
  externalWrite();
  const args = { ...add, evidence: { docId: "evidence", quote } };
  for (let retry = 0; retry < 2; retry++)
    expect(await invoke(tools, "temporal_annotation_add", args)).toMatchObject({
      kind: "error",
      code: "revision_conflict",
      message: expect.stringContaining("Repeat temporal_query"),
    });
  expect(verify).not.toHaveBeenCalled();
  expect(checkRecord).not.toHaveBeenCalled();
  await query(tools);
  expect(await invoke(tools, "temporal_annotation_add", args)).toMatchObject({
    resultType: "temporal_annotation.added",
  });
  expect(verify).toHaveBeenCalledOnce();
  expect(checkRecord).toHaveBeenCalledOnce();
});

it.each([
  { from: "2032-04-01", to: "2032-05-01" },
  { from: "2031-04-01", to: "2031-05-01", origins: ["projection"] },
  { from: "2031-04-01", to: "2031-05-01", documentIds: ["unrelated"] },
  { from: "2031-04-01", to: "2031-05-01", kinds: ["deadline"] },
])("does not let an unrelated query authorize a forced add: %j", async (input) => {
  const tools = toolsFor("scoped");
  expect(await invoke(tools, "temporal_query", { timeZone: "UTC", ...input })).toMatchObject({
    kind: "structured",
  });
  expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(db.prepare("SELECT COUNT(*) n FROM temporal_annotations").get()).toEqual({ n: 0 });
});

it("requires a complete query and refuses moving outside its observed window", async () => {
  const tools = toolsFor("move");
  await query(tools);
  expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({ kind: "structured" });
  const row = db.prepare("SELECT id FROM temporal_annotations").get() as { id: string };
  expect(
    await invoke(tools, "temporal_annotation_update", { annotationId: row.id, when: "2032-04-03" }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  await invoke(tools, "temporal_query", {
    from: "2031-04-01",
    to: "2033-01-01",
    timeZone: "UTC",
    origins: ["annotation"],
  });
  expect(
    await invoke(tools, "temporal_annotation_update", { annotationId: row.id, when: "2032-04-03" }),
  ).toMatchObject({ kind: "structured" });
  expect(db.prepare("SELECT canonical FROM temporal_annotations WHERE id=?").get(row.id)).toEqual({
    canonical: "2032-04-03",
  });
});

it("still conservatively refuses a disjoint concurrent write under global monotone CAS", async () => {
  const tools = toolsFor("global");
  await query(tools);
  insertTemporalAnnotation(
    db,
    {
      id: "far-away",
      intervalStartMs: Date.parse("2040-01-01"),
      intervalEndMs: Date.parse("2040-01-02") - 1,
      precision: "day",
      canonical: "2040-01-01",
      sentence: "The fictional archive opens.",
      documentIds: [],
      createdByRun: "other",
    },
    100,
  );
  expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
  expect(db.prepare("SELECT COUNT(*) n FROM temporal_annotations").get()).toEqual({ n: 1 });
});

it("a truncated annotation query cannot authorize creation", async () => {
  externalWrite("first");
  externalWrite("second");
  const tools = toolsFor("truncated");
  expect(
    await invoke(tools, "temporal_query", {
      from: "2031-04-01",
      to: "2031-05-01",
      timeZone: "UTC",
      origins: ["annotation"],
      limit: 1,
    }),
  ).toMatchObject({ kind: "structured", data: { truncated: true } });
  expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
  });
});

it("matches coarse dates in the query timezone, including daylight saving", async () => {
  const tools = toolsFor("zone");
  await invoke(tools, "temporal_query", {
    from: "2031-04-03",
    timeZone: "America/New_York",
    origins: ["annotation"],
  });
  expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({ kind: "structured" });
});

it("rolls back when unresolved links would make the actual stored annotation leave the read scope", async () => {
  const tools = toolsFor("resolved-links");
  await invoke(tools, "temporal_query", {
    from: "2031-04-01",
    to: "2031-05-01",
    timeZone: "UTC",
    origins: ["annotation"],
    entityIds: ["missing-loop"],
  });
  expect(
    await invoke(tools, "temporal_annotation_add", { ...add, loopIds: ["missing-loop"] }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
  expect(db.prepare("SELECT COUNT(*) n FROM temporal_annotations").get()).toEqual({ n: 0 });
});

it.each(["temporal_annotation_delete", "temporal_annotation_update"])(
  "does not combine a truncated target read with an unrelated complete scope for %s",
  async (tool) => {
    externalWrite("first");
    externalWrite("second");
    const tools = toolsFor("scope-combination");
    const truncated = await invoke(tools, "temporal_query", {
      from: "2031-04-01",
      to: "2031-05-01",
      timeZone: "UTC",
      origins: ["annotation"],
      limit: 1,
    });
    expect(truncated).toMatchObject({ kind: "structured", data: { truncated: true } });
    const id = (truncated as { data: { items: Array<{ id: string }> } }).data.items[0]!.id;
    await invoke(tools, "temporal_query", {
      from: "2032-04-01",
      to: "2032-05-01",
      timeZone: "UTC",
      origins: ["annotation"],
    });
    expect(
      await invoke(tools, tool, {
        annotationId: id,
        ...(tool === "temporal_annotation_update" ? { when: "2032-04-03" } : {}),
      }),
    ).toMatchObject({ kind: "error", code: "revision_conflict" });
    expect(
      db.prepare("SELECT canonical,invalidated_at FROM temporal_annotations WHERE id=?").get(id),
    ).toEqual({ canonical: "2031-04-03", invalidated_at: null });
  },
);

it("allows disjoint document writes without accepting overlapping phantoms", async () => {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
    SELECT 'other',provider_id,source_id,'other',title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at FROM documents WHERE id='evidence'`,
  ).run();
  const first = toolsFor("first-document"),
    second = toolsFor("second-document");
  const scope = (id: string) => ({
    from: "2031-04-01",
    to: "2031-05-01",
    origins: ["annotation"],
    timeZone: "UTC",
    documentIds: [id],
  });
  await invoke(first, "temporal_query", scope("evidence"));
  await invoke(second, "temporal_query", scope("other"));
  expect(
    await invoke(first, "temporal_annotation_add", {
      ...add,
      documentIds: ["evidence"],
      evidence: { docId: "evidence", quote },
    }),
  ).toMatchObject({ resultType: "temporal_annotation.added" });
  expect(
    await invoke(second, "temporal_annotation_add", {
      ...add,
      documentIds: ["other"],
      evidence: { docId: "other", quote },
    }),
  ).toMatchObject({ resultType: "temporal_annotation.added" });
  await invoke(first, "temporal_query", scope("evidence"));
  await invoke(second, "temporal_query", scope("evidence"));
  expect(
    await invoke(first, "temporal_annotation_add", {
      ...add,
      when: "2031-04-04",
      documentIds: ["evidence"],
      evidence: { docId: "evidence", quote },
    }),
  ).toMatchObject({ resultType: "temporal_annotation.added" });
  expect(
    await invoke(second, "temporal_annotation_add", {
      ...add,
      when: "2031-04-05",
      documentIds: ["evidence"],
      evidence: { docId: "evidence", quote },
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
});

it("retains the exact scoped writer receipt across a same-document postcommit race", async () => {
  let interleave = true;
  const call: WriterCallFn = (op, args) => {
    const handler = (
      writerHandlers as unknown as Record<
        string,
        (database: ReturnType<typeof createDatabase>, ...args: unknown[]) => unknown
      >
    )[op]!;
    const result = handler(db, ...args);
    if (interleave && op === "knowledge.canonicalMutation") {
      interleave = false;
      externalWrite();
      db.exec("INSERT INTO temporal_annotation_documents VALUES('external','evidence')");
    }
    return Promise.resolve(result) as never;
  };
  const tools = toolsFor("scoped-race", { gate: writeGateFromCall(call) });
  await invoke(tools, "temporal_query", {
    from: "2031-04-01",
    to: "2031-05-01",
    origins: ["annotation"],
    timeZone: "UTC",
    documentIds: ["evidence"],
  });
  expect(
    await invoke(tools, "temporal_annotation_add", {
      ...add,
      documentIds: ["evidence"],
      evidence: { docId: "evidence", quote },
    }),
  ).toMatchObject({ resultType: "temporal_annotation.added" });
  expect(
    await invoke(tools, "temporal_annotation_add", {
      ...add,
      when: "2031-04-04",
      documentIds: ["evidence"],
      evidence: { docId: "evidence", quote },
    }),
  ).toMatchObject({ kind: "error", code: "revision_conflict" });
});

it.each([
  "UPDATE documents SET source_id='third-source' WHERE id='other'",
  "UPDATE documents SET id='moved-document' WHERE id='other'",
])("keeps source-filtered reads global and fences membership changes: %s", async (mutation) => {
  db.prepare(
    `INSERT INTO documents(id,provider_id,source_id,external_id,title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at)
    SELECT 'other',provider_id,'second-source','other',title,content,content_hash,metadata,source_created_at,source_updated_at,ingested_at,updated_at FROM documents WHERE id='evidence'`,
  ).run();
  externalWrite();
  db.exec(
    "INSERT INTO temporal_annotation_documents VALUES('external','evidence'),('external','other')",
  );
  const input = {
    from: "2031-04-01",
    to: "2031-05-01",
    timeZone: "UTC",
    origins: ["annotation" as const],
    documentIds: ["evidence"],
    sourceIds: ["second-source"],
  };
  const service = new TemporalQueryService(db);
  const receipt = new TemporalReconciliation();
  const query = async () => ({
    kind: "structured" as const,
    resultType: "temporal.results",
    data: await service.query(input),
  });
  const initial = await receipt.read(db, input, query);
  expect(initial).toMatchObject({ data: { items: [expect.objectContaining({ id: "external" })] } });
  expect(receipt.require().temporalDocuments).toBeUndefined();
  db.exec(mutation);
  expect(await service.query(input)).toMatchObject({ items: [] });
  expect(() => assertKnowledgeReconciliation(db, receipt.require())).toThrow(
    /reconciled collection/,
  );
});

it("explains scope replacement and recovers with one complete batch window", async () => {
  const tools = toolsFor("batch-guidance");
  await query(tools);
  await invoke(tools, "temporal_query", {
    from: "2031-06-01",
    to: "2031-07-01",
    origins: ["annotation"],
    timeZone: "UTC",
  });
  expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
    message: expect.stringContaining("Only the latest query"),
  });
  expect(db.prepare("SELECT count(*) n FROM temporal_annotations").get()).toEqual({ n: 0 });
  await query(tools);
  expect(await invoke(tools, "temporal_annotation_add", add)).toMatchObject({
    kind: "structured",
    resultType: "temporal_annotation.added",
  });
});

it("explains the inclusive endpoint refusal and accepts a covering query", async () => {
  const tools = toolsFor("endpoint-guidance");
  const span = { ...add, when: "2031-04-03T12:00:00Z", until: "2031-04-04T00:00:00Z" };
  await invoke(tools, "temporal_query", {
    from: "2031-04-03",
    to: "2031-04-04",
    origins: ["annotation"],
    timeZone: "UTC",
  });
  expect(await invoke(tools, "temporal_annotation_add", span)).toMatchObject({
    kind: "error",
    code: "revision_conflict",
    message: expect.stringContaining("Annotation until is inclusive but query to is exclusive"),
  });
  expect(db.prepare("SELECT count(*) n FROM temporal_annotations").get()).toEqual({ n: 0 });
  await invoke(tools, "temporal_query", {
    from: "2031-04-03",
    to: "2031-04-05",
    origins: ["annotation"],
    timeZone: "UTC",
  });
  expect(await invoke(tools, "temporal_annotation_add", span)).toMatchObject({
    kind: "structured",
    resultType: "temporal_annotation.added",
  });
  expect(tools.find((t) => t.name === "temporal_annotation_add")!.description).toContain(
    "separate queries are not combined",
  );
});
