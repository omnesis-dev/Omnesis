// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createLogger,
  type AgentEvent,
  type DecisionCapability,
  type DecisionRequest,
  type DecisionResult,
} from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { upsertDocuments } from "../../data/repositories/DocumentRepository.js";
import { applyExtractedDates } from "../../enrichment/dates/storage.js";
import { createCognitionDrainerTasks } from "../run-drainer.js";
import { CognitionRunDriver } from "../run-driver.js";
import { FsCognitionTranscriptStore } from "../transcripts.js";
import { getCognitionRun } from "../storage/run-queue.js";
import {
  decisionVerdictsForRuns,
  insertCognitionDecision,
  listDecisionsForRun,
} from "../storage/decisions.js";
import { listCognitionCoverage } from "../storage/coverage.js";
import { bootstrapCorpusByMonth } from "../storage/bootstrap.js";
import { getCognitionEngineState, cognitionBootstrapEnqueuedKey } from "../storage/engine-state.js";
import { cognitionSpendDay, getCognitionSpendDayTotal } from "../storage/spend.js";
import { pruneActivityRetentionBatch } from "../../activity-retention/store.js";
import { WorthGate, recordWorthGateSpend } from "./gate.js";
import { EMAIL_WORTH_THRESHOLD, WORTH_GATE_RUBRIC_VERSION, emailWorthState } from "./rubric.js";
import type { ChatBackend, TurnInput } from "@omnesis/agent";
import type { DocumentInput } from "@omnesis/types";
import type { Scheduler } from "../../scheduler/scheduler.js";
import type { TaskContext } from "../../scheduler/types.js";
import type { ClaimedCognitionRun } from "../storage/types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("worth-gate");
const taskCtx: TaskContext = {
  shouldYield: () => false,
  elapsedMs: () => 0,
  signal: new AbortController().signal,
  log,
};

/** A scripted decision model: answers each email subject with a fixed score. */
class ScriptedDecision implements DecisionCapability {
  readonly modelId: string = "jev-test";
  readonly calls: DecisionRequest[] = [];
  constructor(private readonly scoreFor: (state: { subject: string }) => number | Error) {}
  async decide(request: DecisionRequest): Promise<DecisionResult> {
    this.calls.push(request);
    const score = this.scoreFor(request.state as { subject: string });
    if (score instanceof Error) throw score;
    return {
      model: "jev-1.13.0",
      answers: { worth_score: { type: "score", score, confidence: 0.8 } },
      inputTokens: 300,
    };
  }
  dispose(): void {}
}

describe("worth gate", () => {
  let dbPath: string;
  let db: Db;
  let dir: string;
  let now: number;
  let seq = 0;

  beforeEach(() => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath);
    dir = mkdtempSync(join(tmpdir(), "omnesis-worth-gate-"));
    now = Date.parse("2026-09-01T09:00:00.000Z");
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(input: {
    externalId: string;
    title: string;
    content?: string;
    documentType?: string;
    metadata?: Record<string, unknown>;
    contentHash?: string;
  }): string {
    const doc: DocumentInput = {
      providerId: "test" as DocumentInput["providerId"],
      sourceId: "mail:test" as DocumentInput["sourceId"],
      externalId: input.externalId,
      title: input.title,
      content: input.content ?? "Body text.",
      contentHash: input.contentHash ?? `hash-${input.externalId}`,
      metadata: {
        documentType: input.documentType ?? "email",
        people: [{ role: "sender", name: "Maya Reeves", emails: ["maya@example.com"] }],
        ...input.metadata,
      },
      sourceCreatedAt: "2024-01-01T00:00:00.000Z",
      sourceUpdatedAt: "2024-01-01T00:00:00.000Z",
    };
    upsertDocuments(db, [doc]);
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(input.externalId)!.id;
  }

  function futureDate(id: string): void {
    applyExtractedDates(db, [
      {
        id,
        dates: [
          {
            kind: "date",
            resolvedStart: "2099-06-01",
            resolvedEnd: null,
            relative: false,
            text: "2099-06-01",
            timex: "2099-06-01",
            charStart: 0,
            charEnd: 4,
          },
        ],
      },
    ]);
  }

  function gate(decision: DecisionCapability | null): WorthGate {
    const writeGate = directWriteGate(db);
    return new WorthGate({
      db,
      getDecision: () => decision,
      recordDecision: (record) => writeGate.recordCognitionDecision(record),
      recordSpend: async () => {},
      clock: () => now,
      idGen: () => `id${++seq}`,
      log,
    });
  }

  function bootstrapRun(docId: string, id = `run_${++seq}`): ClaimedCognitionRun {
    const payload = { docId, datumAt: 1_704_067_200_000 };
    return { id, kind: "bootstrap", payload, payloadJson: JSON.stringify(payload), attempts: 1 };
  }

  const scores: Record<string, number> = {
    "Weekly deals inside": 0.2,
    "Your flight is confirmed": 2.7,
    "Exactly on the line": EMAIL_WORTH_THRESHOLD,
  };
  const scripted = () => new ScriptedDecision((s) => scores[s.subject] ?? 1.5);

  test("skips an email scored under the threshold and records the exact request and answer", async () => {
    const docId = seed({
      externalId: "promo-1",
      title: "Weekly deals inside",
      content: "Sale ends Sunday.",
    });
    const decision = scripted();
    const outcome = await gate(decision).evaluate(bootstrapRun(docId, "run_a"));
    expect(outcome).toMatchObject({
      verdict: "skip",
      score: 0.2,
      threshold: EMAIL_WORTH_THRESHOLD,
    });
    expect(decision.calls).toHaveLength(1);
    expect(decision.calls[0]!.state).toEqual({
      subject: "Weekly deals inside",
      from: "Maya Reeves <maya@example.com>",
      body: "Sale ends Sunday.",
    });
    const [record] = listDecisionsForRun(db, "run_a");
    expect(record).toMatchObject({
      documentId: docId,
      subjectDocumentId: docId,
      lane: "bootstrap",
      verdict: "skip",
      score: 0.2,
      modelId: "jev-1.13.0",
      rubricVersion: WORTH_GATE_RUBRIC_VERSION,
      inputTokens: 300,
      reusedFrom: null,
      // A document judgement, and a skip that took effect.
      recordId: null,
      enforced: true,
    });
    expect(JSON.parse(record!.requestJson!)).toMatchObject({
      model: "jev-test",
      state: { subject: "Weekly deals inside" },
      questions: { worth_score: { type: "score" } },
    });
    expect(JSON.parse(record!.responseJson!)).toMatchObject({
      answers: { worth_score: { score: 0.2 } },
    });
  });

  test("passes an email scored at or above the threshold", async () => {
    const docId = seed({ externalId: "flight-1", title: "Your flight is confirmed" });
    const outcome = await gate(scripted()).evaluate(bootstrapRun(docId));
    expect(outcome?.verdict).toBe("pass");
  });

  test("is absent when no decision model is assigned", async () => {
    const docId = seed({ externalId: "promo-2", title: "Weekly deals inside" });
    expect(await gate(null).evaluate(bootstrapRun(docId))).toBeNull();
  });

  test("leaves non-email documents alone", async () => {
    const docId = seed({
      externalId: "note-1",
      title: "Weekly deals inside",
      documentType: "note",
    });
    const decision = scripted();
    expect(await gate(decision).evaluate(bootstrapRun(docId))).toBeNull();
    expect(decision.calls).toHaveLength(0);
  });

  test("exempts mail with structured booking dates and mail handed to the assistant", async () => {
    const booked = seed({
      externalId: "booked-1",
      title: "Weekly deals inside",
      metadata: { scheduledAt: "2099-01-01T10:00:00Z" },
    });
    const decision = scripted();
    expect(await gate(decision).evaluate(bootstrapRun(booked))).toBeNull();
    const handed = seed({ externalId: "handed-1", title: "Weekly deals inside" });
    const payload = {
      docId: handed,
      event: "inserted",
      datumAt: 1,
      debounceUntil: 1,
      immediate: true,
    };
    const dataRun: ClaimedCognitionRun = {
      id: "run_data_immediate",
      kind: "data",
      payload,
      payloadJson: JSON.stringify(payload),
      attempts: 1,
    };
    expect(await gate(decision).evaluate(dataRun)).toBeNull();
    expect(decision.calls).toHaveLength(0);
  });

  test("judges an attachment by its parent email", async () => {
    const parent = seed({ externalId: "thread-1", title: "Your flight is confirmed" });
    const attachment = seed({
      externalId: "thread-1/att/logo",
      title: "image005.png",
      documentType: "attachment",
      content: "Airline logo",
      metadata: { extra: { parentExternalId: "thread-1" } },
    });
    const decision = scripted();
    const outcome = await gate(decision).evaluate(bootstrapRun(attachment, "run_att"));
    expect(outcome?.verdict).toBe("pass");
    expect(decision.calls[0]!.state).toMatchObject({ subject: "Your flight is confirmed" });
    expect(listDecisionsForRun(db, "run_att")[0]).toMatchObject({
      documentId: attachment,
      subjectDocumentId: parent,
    });
  });

  test("reuses an earlier answer while the content is unchanged, and asks again after an edit", async () => {
    const docId = seed({ externalId: "promo-3", title: "Weekly deals inside" });
    const decision = scripted();
    const g = gate(decision);
    const first = await g.evaluate(bootstrapRun(docId, "run_1"));
    const second = await g.evaluate(bootstrapRun(docId, "run_2"));
    expect(decision.calls).toHaveLength(1);
    expect(second).toMatchObject({ verdict: "skip", score: 0.2 });
    expect(listDecisionsForRun(db, "run_2")[0]).toMatchObject({
      reusedFrom: first!.decisionId,
      requestJson: null,
    });
    seed({ externalId: "promo-3", title: "Weekly deals inside", contentHash: "hash-edited" });
    await g.evaluate(bootstrapRun(docId, "run_3"));
    expect(decision.calls).toHaveLength(2);
  });

  test("runs judging the same email at the same time share one call", async () => {
    const parent = seed({ externalId: "thread-2", title: "Weekly deals inside" });
    const attachment = seed({
      externalId: "thread-2/att/banner",
      title: "banner.png",
      documentType: "attachment",
      metadata: { extra: { parentExternalId: "thread-2" } },
    });
    let release!: () => void;
    const gateOpen = new Promise<void>((resolve) => (release = resolve));
    const decision = scripted();
    const slow: DecisionCapability = {
      modelId: decision.modelId,
      decide: async (request) => {
        await gateOpen;
        return decision.decide(request);
      },
      dispose: () => {},
    };
    const g = gate(slow);
    const both = Promise.all([
      g.evaluate(bootstrapRun(parent, "run_parent")),
      g.evaluate(bootstrapRun(attachment, "run_attachment")),
    ]);
    release();
    const [a, b] = await both;
    expect(decision.calls).toHaveLength(1);
    expect(a?.verdict).toBe("skip");
    expect(b?.verdict).toBe("skip");
    const tokens = [
      listDecisionsForRun(db, "run_parent")[0]!.inputTokens,
      listDecisionsForRun(db, "run_attachment")[0]!.inputTokens,
    ];
    expect(tokens.filter((t) => t === 300)).toHaveLength(1);
    expect(tokens.filter((t) => t === null)).toHaveLength(1);
  });

  test("a score exactly at the threshold passes", async () => {
    const docId = seed({ externalId: "edge-1", title: "Exactly on the line" });
    expect((await gate(scripted()).evaluate(bootstrapRun(docId)))?.verdict).toBe("pass");
  });

  test("does not reuse an answer given to another model", async () => {
    const docId = seed({ externalId: "model-1", title: "Weekly deals inside" });
    const first = scripted();
    await gate(first).evaluate(bootstrapRun(docId, "run_m1"));
    const second = new (class extends ScriptedDecision {
      override readonly modelId = "jev-next";
    })((st) => scores[st.subject] ?? 1.5);
    await gate(second).evaluate(bootstrapRun(docId, "run_m2"));
    expect(second.calls).toHaveLength(1);
    expect(listDecisionsForRun(db, "run_m2")[0]).toMatchObject({
      requestedModelId: "jev-next",
      reusedFrom: null,
    });
  });

  test("one run aborting does not cancel the call another run is waiting on", async () => {
    const docId = seed({ externalId: "abort-1", title: "Weekly deals inside" });
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const decision = scripted();
    const slow: DecisionCapability = {
      modelId: decision.modelId,
      decide: async (request) => {
        await open;
        return decision.decide(request);
      },
      dispose: () => {},
    };
    const g = gate(slow);
    const abort = new AbortController();
    const first = g.evaluate(bootstrapRun(docId, "run_ab1"), abort.signal);
    const second = g.evaluate(bootstrapRun(docId, "run_ab2"));
    abort.abort();
    release();
    expect(await first).toBeNull();
    expect((await second)?.verdict).toBe("skip");
    expect(listDecisionsForRun(db, "run_ab1")).toEqual([]);
    expect(decision.calls).toHaveLength(1);
  });

  test("a decision's tokens never count as a run toward the daily run budget", async () => {
    const writeGate = directWriteGate(db);
    await recordWorthGateSpend(writeGate, "2026-09-01", "jev-1.13.0", 300);
    expect(getCognitionSpendDayTotal(db, "2026-09-01")).toMatchObject({
      runs: 0,
      promptTokens: 300,
    });
  });

  test("deleting a document deletes every judgement that quotes it", async () => {
    const parent = seed({ externalId: "del-1", title: "Weekly deals inside" });
    const attachment = seed({
      externalId: "del-1/att/a",
      title: "a.png",
      documentType: "attachment",
      metadata: { extra: { parentExternalId: "del-1" } },
    });
    await gate(scripted()).evaluate(bootstrapRun(attachment, "run_del"));
    expect(listDecisionsForRun(db, "run_del")).toHaveLength(1);
    db.prepare("DELETE FROM documents WHERE id = ?").run(parent);
    expect(listDecisionsForRun(db, "run_del")).toEqual([]);
  });

  test("retention keeps verdicts but clears the audit text and drops unavailable rows", async () => {
    const ok = seed({ externalId: "ret-1", title: "Weekly deals inside" });
    const down = seed({ externalId: "ret-2", title: "Your flight is confirmed" });
    await gate(scripted()).evaluate(bootstrapRun(ok, "run_r1"));
    await gate(new ScriptedDecision(() => new Error("down"))).evaluate(
      bootstrapRun(down, "run_r2"),
    );
    expect(pruneActivityRetentionBatch(db, "cognitionDecisions", now + 1, 100).deleted).toBe(2);
    expect(listDecisionsForRun(db, "run_r1")[0]).toMatchObject({
      verdict: "skip",
      score: 0.2,
      requestJson: null,
      responseJson: null,
    });
    expect(listDecisionsForRun(db, "run_r2")).toEqual([]);
    expect(pruneActivityRetentionBatch(db, "cognitionDecisions", now + 1, 100).deleted).toBe(0);
  });

  test("fails open and records the model as unavailable", async () => {
    const docId = seed({ externalId: "promo-4", title: "Weekly deals inside" });
    const decision = new ScriptedDecision(() => new Error("TypeSafe HTTP 401: invalid key"));
    const outcome = await gate(decision).evaluate(bootstrapRun(docId, "run_err"));
    expect(outcome?.verdict).toBe("unavailable");
    expect(listDecisionsForRun(db, "run_err")[0]).toMatchObject({
      verdict: "unavailable",
      score: null,
      error: "TypeSafe HTTP 401: invalid key",
    });
    // An unavailable verdict is never reused: the next run asks again.
    await gate(decision).evaluate(bootstrapRun(docId, "run_err_2"));
    expect(decision.calls).toHaveLength(2);
  });

  describe("in the drainer", () => {
    function drainerWith(decision: DecisionCapability | null) {
      const writeGate = directWriteGate(db);
      const agentCalls: string[] = [];
      const backend: ChatBackend = {
        name: "scripted",
        model: "scripted-model",
        async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
          agentCalls.push(input.userMessage);
          yield {
            type: "agent.message.end",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              stopReason: "end_turn",
              usage: { inputTokens: 50, outputTokens: 10 },
            },
          };
        },
      };
      const transcripts = new FsCognitionTranscriptStore(join(dir, "t"));
      const driver = new CognitionRunDriver({
        resolveBackend: () => backend,
        transcripts,
        log,
        clock: () => now,
      });
      const bundle = createCognitionDrainerTasks(
        {
          db,
          writeGate,
          driver,
          transcripts,
          log,
          isEnabled: () => true,
          getBudgetVerdict: () => ({ exhausted: false as const }),
          getWorkerConcurrency: () => 1,
          getResurrectDebounceMs: () => 0,
          clock: () => now,
          worthGate: new WorthGate({
            db,
            getDecision: () => decision,
            recordDecision: (record) => writeGate.recordCognitionDecision(record),
            recordSpend: async () => {},
            clock: () => now,
            idGen: () => `id${++seq}`,
            log,
          }),
        },
        {} as unknown as Scheduler,
      );
      return { writeGate, drain: bundle.tasks[0]!, agentCalls };
    }

    test("a gated bootstrap run settles with no agent turn, stays covered, and refunds its pace slot", async () => {
      const promo = seed({ externalId: "promo-d", title: "Weekly deals inside" });
      const flight = seed({ externalId: "flight-d", title: "Your flight is confirmed" });
      futureDate(promo);
      futureDate(flight);
      const { writeGate, drain, agentCalls } = drainerWith(scripted());
      const dayKey = cognitionBootstrapEnqueuedKey(cognitionSpendDay(now));
      await writeGate.addToCognitionEngineCounter(dayKey, 2);
      for (const [id, docId] of [
        ["run_promo", promo],
        ["run_flight", flight],
      ] as const) {
        await writeGate.enqueueCognitionRun(
          { id, kind: "bootstrap", payload: { docId, datumAt: 1_704_067_200_000 } },
          now,
        );
      }
      await writeGate.markDocsBootstrapProcessed([promo, flight], new Date(now).toISOString());
      // One claim per tick at concurrency 1.
      await drain.run(undefined, taskCtx);
      await drain.run(undefined, taskCtx);

      expect(getCognitionRun(db, "run_promo")?.status).toBe("completed");
      expect(getCognitionRun(db, "run_promo")?.usage).toBeNull();
      expect(getCognitionRun(db, "run_flight")?.status).toBe("completed");
      expect(agentCalls).toHaveLength(1);
      expect(listDecisionsForRun(db, "run_promo")[0]?.verdict).toBe("skip");
      expect(listDecisionsForRun(db, "run_flight")[0]?.verdict).toBe("pass");
      expect(getCognitionEngineState(db, dayKey)).toBe("1");
      const coverage = listCognitionCoverage(db);
      expect(coverage.reduce((n, row) => n + row.skipped, 0)).toBe(1);

      const months = bootstrapCorpusByMonth(db, "2025-01-01T00:00:00.000Z", "2026-09-01");
      const jan = months.find((m) => m.month === "2024-01");
      expect(jan).toMatchObject({ gated: 1, reviewed: 1 });
    });

    test("the pace refund goes to the enqueue day and never below zero", async () => {
      const promo = seed({ externalId: "promo-r", title: "Weekly deals inside" });
      const { writeGate, drain } = drainerWith(scripted());
      const enqueueDay = cognitionSpendDay(now);
      await writeGate.enqueueCognitionRun(
        { id: "run_r", kind: "bootstrap", payload: { docId: promo, datumAt: 1_704_067_200_000 } },
        now,
      );
      now += 86_400_000;
      await drain.run(undefined, taskCtx);
      expect(getCognitionRun(db, "run_r")?.status).toBe("completed");
      // Nothing was counted on the enqueue day in this test, so nothing is refunded.
      expect(getCognitionEngineState(db, cognitionBootstrapEnqueuedKey(enqueueDay))).toBeNull();
      expect(
        getCognitionEngineState(db, cognitionBootstrapEnqueuedKey(cognitionSpendDay(now))),
      ).toBeNull();
    });

    test("a document whose newest decision passes counts as reviewed, not gated", async () => {
      const doc = seed({ externalId: "flip-1", title: "Weekly deals inside" });
      futureDate(doc);
      await gate(scripted()).evaluate(bootstrapRun(doc, "run_flip1"));
      now += 1000;
      scores["Weekly deals inside"] = 2.0;
      seed({ externalId: "flip-1", title: "Weekly deals inside", contentHash: "hash-flip-edited" });
      await gate(scripted()).evaluate(bootstrapRun(doc, "run_flip2"));
      scores["Weekly deals inside"] = 0.2;
      db.prepare("UPDATE documents SET bootstrap_processed_at = ? WHERE id = ?").run(
        new Date(now).toISOString(),
        doc,
      );
      const jan = bootstrapCorpusByMonth(db, "2025-01-01T00:00:00.000Z", "2026-09-01").find(
        (m) => m.month === "2024-01",
      );
      expect(jan).toMatchObject({ gated: 0, reviewed: 1 });
    });

    test("a record check on the same document never overrides its worth-gate verdict", async () => {
      const doc = seed({ externalId: "rc-1", title: "Weekly deals inside" });
      futureDate(doc);
      await gate(scripted()).evaluate(bootstrapRun(doc, "run_rc1"));
      now += 1000;
      // A later record check made during some other run, anchored on this document.
      insertCognitionDecision(db, {
        id: "dec_record",
        runId: "run_rc1",
        documentId: doc,
        subjectDocumentId: doc,
        purpose: "record-check",
        lane: "bootstrap",
        rubricVersion: "record-belongs-v1",
        contentHash: null,
        requestedModelId: "jev-test",
        modelId: "jev-test",
        requestJson: null,
        responseJson: null,
        score: 2.5,
        threshold: 0.81,
        verdict: "pass",
        error: null,
        reusedFrom: null,
        recordId: "ta_1",
        enforced: false,
        latencyMs: 1,
        inputTokens: 10,
        createdAt: now,
      });
      db.prepare("UPDATE documents SET bootstrap_processed_at = ? WHERE id = ?").run(
        new Date(now).toISOString(),
        doc,
      );
      const jan = bootstrapCorpusByMonth(db, "2025-01-01T00:00:00.000Z", "2026-09-01").find(
        (m) => m.month === "2024-01",
      );
      expect(jan).toMatchObject({ gated: 1 });
      expect(decisionVerdictsForRuns(db, ["run_rc1"]).get("run_rc1")).toBe("skip");
      expect(
        listDecisionsForRun(db, "run_rc1").map((d) => [d.purpose, d.recordId, d.enforced]),
      ).toEqual([
        ["worth-gate", null, true],
        ["record-check", "ta_1", false],
      ]);
    });

    test("the newest worth-gate verdict per document is read from the covering index", () => {
      const plan = db
        .prepare<[string], { detail: string }>(
          `EXPLAIN QUERY PLAN SELECT g2.rowid FROM cognition_decisions g2
            WHERE g2.document_id = ? AND g2.purpose = 'worth-gate'
            ORDER BY g2.created_at DESC, g2.rowid DESC LIMIT 1`,
        )
        .all("doc")
        .map((row) => row.detail)
        .join("\n");
      // A document holds a handful of decisions, so ordering them is trivial;
      // what matters is that the lookup never reaches the audit text.
      expect(plan).toContain("COVERING INDEX idx_cognition_decisions_document");
    });

    test("an unavailable decision model lets the run execute", async () => {
      const promo = seed({ externalId: "promo-u", title: "Weekly deals inside" });
      const { writeGate, drain, agentCalls } = drainerWith(
        new ScriptedDecision(() => new Error("TypeSafe HTTP 529: overloaded")),
      );
      await writeGate.enqueueCognitionRun(
        { id: "run_u", kind: "bootstrap", payload: { docId: promo, datumAt: 1_704_067_200_000 } },
        now,
      );
      await drain.run(undefined, taskCtx);
      expect(agentCalls).toHaveLength(1);
      expect(listDecisionsForRun(db, "run_u")[0]?.verdict).toBe("unavailable");
    });

    test("without a decision model every run executes and nothing is recorded", async () => {
      const promo = seed({ externalId: "promo-n", title: "Weekly deals inside" });
      const { writeGate, drain, agentCalls } = drainerWith(null);
      await writeGate.enqueueCognitionRun(
        { id: "run_n", kind: "bootstrap", payload: { docId: promo, datumAt: 1_704_067_200_000 } },
        now,
      );
      await drain.run(undefined, taskCtx);
      expect(agentCalls).toHaveLength(1);
      expect(listDecisionsForRun(db, "run_n")).toEqual([]);
    });
  });
});

describe("emailWorthState", () => {
  test("renders the sender and truncates the body", () => {
    expect(
      emailWorthState({
        title: "Hello",
        content: "x".repeat(2500),
        metadata: {
          people: [
            { role: "recipient", name: "A" },
            { role: "sender", emails: ["a@example.com", "b@example.com"] },
          ],
        },
      }),
    ).toEqual({ subject: "Hello", from: "<a@example.com,b@example.com>", body: "x".repeat(2000) });
  });

  test("tolerates missing people and content", () => {
    expect(emailWorthState({ title: null, content: null, metadata: {} })).toEqual({
      subject: "",
      from: "",
      body: "",
    });
  });
});
