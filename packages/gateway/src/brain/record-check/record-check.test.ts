// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The record check: which runs it covers, what each mode does with a verdict,
 * how it fails open, what it writes to the decision ledger and the spend
 * table, and how the three create tools consult it before saving.
 *
 * Fixture data is invented — no corpus content.
 */

import { existsSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLogger } from "@omnesis/core";
import { ProviderId, SourceId, type DocumentInput } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../../db.js";
import { directWriteGate } from "../../write-gate.js";
import { recordDecisionSpend } from "../decision-call.js";
import {
  captureDecisionPayloadSubjects,
  decisionPayloadErasureGeneration,
  readDecisionPayload,
} from "../decision-payload.js";
import { pruneActivityRetentionBatch } from "../../activity-retention/store.js";
import { listDecisionsForRun } from "../storage/decisions.js";
import { cognitionSpendDay, getCognitionSpendDayTotal } from "../storage/spend.js";
import { createOpenLoopMirror } from "../steward/mirror.js";
import { buildCognitionOwnTools } from "../steward/tools.js";
import { RecordCheck, type CheckRecord } from "./check.js";
import { documentRecordContext } from "./document-context.js";
import {
  DOCUMENT_RECORD_VALUE_QUESTIONS,
  RECORD_BELONGS_QUESTIONS,
  RECORD_BELONGS_THRESHOLD,
  RECORD_CHECK_RUBRIC_VERSION,
  RECORD_CHECK_SPEND_MECHANISM,
} from "./rubric.js";
import type { RecordCheckMode } from "../config.js";
import type { DecisionCapability, DecisionRequest, ToolResult } from "@omnesis/core";
import type { SearchPort, ToolHandle } from "@omnesis/agent";
import type { ClaimedCognitionRun } from "../storage/types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test").child("record-check");
const CTX = { sessionId: "S", messageId: "M" };
const NOW = Date.parse("2026-09-01T10:00:00.000Z");

/** A scripted decision model: scores each record sentence from a table, `fallback` otherwise. */
class ScriptedDecision implements DecisionCapability {
  readonly modelId = "jev-test";
  readonly calls: DecisionRequest[] = [];
  constructor(
    private readonly scores: Record<string, number> = {},
    private readonly failWith?: Error,
    private readonly fallback = 2.5,
  ) {}
  async decide(request: DecisionRequest) {
    this.calls.push(request);
    if (this.failWith) throw this.failWith;
    const record = (request.state as { record: string }).record;
    return {
      model: "jev-1.13.0",
      answers: { belongs: { type: "score" as const, score: this.scores[record] ?? this.fallback } },
      inputTokens: 120,
    };
  }
  dispose() {}
}

/** A decision model that answers only when released, or rejects when its signal aborts. */
class HeldDecision implements DecisionCapability {
  readonly modelId = "jev-test";
  signal: AbortSignal | undefined;
  private release: (() => void) | null = null;
  decide(_request: DecisionRequest, opts?: { signal?: AbortSignal }) {
    this.signal = opts?.signal;
    return new Promise<Awaited<ReturnType<DecisionCapability["decide"]>>>((resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(opts.signal!.reason), { once: true });
      this.release = () =>
        resolve({ model: "jev-1.13.0", answers: { belongs: { type: "score", score: 0.1 } } });
    });
  }
  answer(): void {
    this.release?.();
  }
  dispose() {}
}

function run(kind: string, payload: unknown, id = "run_1"): ClaimedCognitionRun {
  return { id, kind, payload, attempts: 1 } as unknown as ClaimedCognitionRun;
}

const NOTICE = "Studio Northstar says its new cycle room opens on 3 October 2026.";
const BOOKING = "Maya Reeves booked the rehearsal room for 3 October 2026.";

describe("record check", () => {
  let path: string;
  let db: Db;
  let seq: number;

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
    seq = 0;
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    }
  });

  function insertDoc(externalId: string, content: string): string {
    const doc: DocumentInput = {
      providerId: ProviderId("google"),
      sourceId: SourceId("gmail-test"),
      externalId,
      title: `Message ${externalId}`,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      sourceCreatedAt: "2026-08-30T09:00:00.000Z",
      sourceUpdatedAt: "2026-08-30T09:00:00.000Z",
      metadata: { documentType: "email" },
    };
    upsertDocuments(db, [doc]);
    return db
      .prepare<[string], { id: string }>("SELECT id FROM documents WHERE external_id = ?")
      .get(externalId)!.id;
  }

  function check(
    decision: DecisionCapability | null,
    mode: RecordCheckMode,
    opts: { failLedger?: boolean } = {},
  ): { check: RecordCheck; setMode: (m: RecordCheckMode) => void } {
    const writeGate = directWriteGate(db);
    let current = mode;
    const recordCheck = new RecordCheck({
      getDecision: () => decision,
      getMode: () => current,
      recordDecision: (record) =>
        opts.failLedger
          ? Promise.reject(new Error("ledger write failed"))
          : writeGate.recordCognitionDecision(record),
      recordSpend: (modelId, inputTokens) =>
        recordDecisionSpend(
          writeGate,
          cognitionSpendDay(NOW),
          RECORD_CHECK_SPEND_MECHANISM,
          modelId,
          inputTokens,
        ),
      clock: () => NOW,
      idGen: () => `d${++seq}`,
      log,
    });
    return { check: recordCheck, setMode: (m) => (current = m) };
  }

  const record = (docId: string, text = NOTICE) => ({
    recordId: "ta_1",
    record: { type: "timeline" as const, kind: "event", text },
    documentId: docId,
  });

  describe("scope", () => {
    test("covers source interpretation and legacy ingestion, never unrelated lanes or user-handed content", () => {
      const { check: c } = check(new ScriptedDecision(), "shadow");
      expect(c.forRun(run("bootstrap", { docId: "d", datumAt: NOW }))).not.toBeNull();
      expect(c.forRun(run("data", { docId: "d", event: "created", datumAt: NOW }))).not.toBeNull();
      expect(
        c.forRun(run("data", { docId: "d", event: "created", datumAt: NOW, immediate: true })),
      ).toBeNull();
      expect(c.forRun(run("daily", {}))).toBeNull();
      expect(c.forRun(run("synthesis", {}))).toBeNull();
      expect(
        c.forRun(run("synthesis", { focus: "knowledge-maintenance", batchId: "batch" })),
      ).not.toBeNull();
      for (const payload of [
        { focus: "knowledge-maintenance" },
        { focus: "knowledge-maintenance", batchId: "" },
        { focus: "noticing", date: "2026-09-01" },
        { focus: "collision", loopIds: ["loop"] },
        { focus: "annotation-contradiction", annotationIds: ["annotation"] },
      ])
        expect(c.forRun(run("synthesis", payload))).toBeNull();
    });
  });

  test("an enforcing maintenance run drops a weak record and attributes its real decision and spend", async () => {
    const doc = insertDoc("maintenance-record", NOTICE);
    const { check: c } = check(new ScriptedDecision({ [NOTICE]: 0.1 }), "enforce");
    const bound = c.forRun(run("synthesis", { focus: "knowledge-maintenance", batchId: "batch" }))!;
    await expect(bound(record(doc))).resolves.toMatchObject({ save: false, score: 0.1 });
    expect(listDecisionsForRun(db, "run_1")).toMatchObject([
      { lane: "synthesis", documentId: doc, recordId: "ta_1", verdict: "skip", enforced: true },
    ]);
    expect(getCognitionSpendDayTotal(db, cognitionSpendDay(NOW))).toMatchObject({
      promptTokens: 120,
      runs: 0,
    });
  });

  describe("modes", () => {
    test("source-context work is needed only while a live record gate can judge it", () => {
      const mode = check(new ScriptedDecision(), "off");
      const bound = mode.check.forRun(run("bootstrap", { docId: "doc", datumAt: NOW }))!;
      expect(bound.needsDocumentContext?.()).toBe(false);
      mode.setMode("shadow");
      expect(bound.needsDocumentContext?.()).toBe(true);
      mode.setMode("enforce");
      expect(bound.needsDocumentContext?.()).toBe(true);
      const absent = check(null, "enforce").check.forRun(
        run("bootstrap", { docId: "doc", datumAt: NOW }),
      )!;
      expect(absent.needsDocumentContext?.()).toBe(false);
    });

    test("a document annotation without safe subject context fails open without a guessed model score", async () => {
      const doc = insertDoc("context-unavailable", BOOKING);
      const decision = new ScriptedDecision({ [BOOKING]: 0.1 });
      const bound = check(decision, "enforce").check.forRun(
        run("bootstrap", { docId: doc, datumAt: NOW }),
      )!;
      await expect(
        bound({
          recordId: "missing-context",
          documentId: doc,
          record: { type: "doc-fact", kind: "topic", text: BOOKING },
        }),
      ).resolves.toEqual({ save: true });
      expect(decision.calls).toHaveLength(0);
      expect(listDecisionsForRun(db, "run_1")).toMatchObject([
        {
          verdict: "unavailable",
          score: null,
          enforced: true,
          error: "Document annotation source context unavailable",
        },
      ]);
    });

    test("retains exact value-check inputs separately and erases them when any supporting source is deleted", async () => {
      const subject = insertDoc("audit-subject", BOOKING);
      const other = insertDoc("audit-support", "The reserved room includes a keyboard.");
      const payloadCapture = captureDecisionPayloadSubjects(
        db,
        { sourceIds: [subject, other] },
        decisionPayloadErasureGeneration(db),
      );
      expect(payloadCapture).not.toBeNull();
      const context = documentRecordContext(subject, BOOKING, [
        { docId: other, quote: "The reserved room includes a keyboard." },
      ]);
      const decision = new ScriptedDecision();
      const bound = check(decision, "enforce").check.forRun(
        run("bootstrap", { docId: subject, datumAt: NOW }),
      )!;
      await bound({
        recordId: "audited-note",
        documentId: subject,
        record: { type: "doc-fact", kind: "context", text: BOOKING },
        documentContext: context,
        payloadCapture: payloadCapture!,
      });
      const row = listDecisionsForRun(db, "run_1")[0]!;
      expect(JSON.parse(row.requestJson!).state.document_context.redacted).toBe(true);
      expect(readDecisionPayload(db, row.id)).toMatchObject({
        availability: "available",
        request: { state: { document_context: context }, questions: decision.calls[0]!.questions },
        response: { model: "jev-1.13.0", answers: { belongs: { type: "score", score: 2.5 } } },
      });
      db.prepare("DELETE FROM documents WHERE id=?").run(other);
      expect(readDecisionPayload(db, row.id).availability).toBe("unavailable");
      expect(listDecisionsForRun(db, "run_1")).toHaveLength(1);
    });

    test("keeps malformed document responses only in the erased exact payload", async () => {
      const subject = insertDoc("malformed-subject", BOOKING);
      const marker = "A fictional second source contains a violet stage plan.";
      const other = insertDoc("malformed-support", marker);
      const payloadCapture = captureDecisionPayloadSubjects(
        db,
        { sourceIds: [subject, other] },
        decisionPayloadErasureGeneration(db),
      )!;
      const decision: DecisionCapability = {
        modelId: "scripted",
        decide: async () => ({
          model: "scripted",
          answers: { [marker]: { type: "score", score: 1 } },
          inputTokens: 7,
        }),
        dispose() {},
      };
      const bound = check(decision, "enforce").check.forRun(
        run("bootstrap", { docId: subject, datumAt: NOW }),
      )!;
      await bound({
        recordId: "malformed-note",
        documentId: subject,
        record: { type: "doc-fact", kind: "context", text: BOOKING },
        documentContext: documentRecordContext(subject, BOOKING, [{ docId: other, quote: marker }]),
        payloadCapture,
      });
      const row = listDecisionsForRun(db, "run_1")[0]!;
      expect(row).toMatchObject({
        verdict: "unavailable",
        responseJson: null,
        error: "Document annotation value check unavailable",
        inputTokens: 7,
      });
      expect(JSON.stringify(row)).not.toContain(marker);
      expect(JSON.stringify(readDecisionPayload(db, row.id).response)).toContain(marker);
      db.prepare("DELETE FROM documents WHERE id=?").run(other);
      expect(readDecisionPayload(db, row.id).availability).toBe("unavailable");
      expect(JSON.stringify(listDecisionsForRun(db, "run_1"))).not.toContain(marker);
    });

    test("does not restore supporting-source text when a value-check verdict returns after deletion", async () => {
      const subject = insertDoc("audit-late-subject", BOOKING);
      const other = insertDoc("audit-late-support", "A keyboard is included.");
      const payloadCapture = captureDecisionPayloadSubjects(
        db,
        { sourceIds: [subject, other] },
        decisionPayloadErasureGeneration(db),
      );
      expect(payloadCapture).not.toBeNull();
      const decision = new HeldDecision();
      const bound = check(decision, "enforce").check.forRun(
        run("bootstrap", { docId: subject, datumAt: NOW }),
      )!;
      const pending = bound({
        recordId: "late-note",
        documentId: subject,
        record: { type: "doc-fact", kind: "context", text: BOOKING },
        documentContext: documentRecordContext(subject, BOOKING, [
          { docId: other, quote: "A keyboard is included." },
        ]),
        payloadCapture: payloadCapture!,
      });
      db.prepare("DELETE FROM documents WHERE id=?").run(other);
      decision.answer();
      await pending;
      const row = listDecisionsForRun(db, "run_1")[0]!;
      expect(row.requestJson).not.toContain("A keyboard is included.");
      expect(readDecisionPayload(db, row.id).availability).toBe("unavailable");
    });

    test("sends bounded source context to the value check but persists only its redacted summary without a trusted capture", async () => {
      const doc = insertDoc("context-redaction", BOOKING);
      const decision = new ScriptedDecision({ [BOOKING]: 2.1 });
      const bound = check(decision, "enforce").check.forRun(
        run("bootstrap", { docId: doc, datumAt: NOW }),
      )!;
      const context = documentRecordContext(doc, "Subject-only private marker XQZ", [
        { docId: "other", quote: "Other-source private marker VJT" },
      ]);
      await expect(
        bound({
          recordId: "with-context",
          documentId: doc,
          record: { type: "doc-fact", kind: "context", text: BOOKING },
          documentContext: context,
        }),
      ).resolves.toEqual({ save: true });
      expect(decision.calls[0]!.questions).toEqual(DOCUMENT_RECORD_VALUE_QUESTIONS);
      const valueInstructions = decision.calls[0]!.questions.belongs!.instructions;
      expect(valueInstructions).toContain("retain materially useful outcomes");
      expect(valueInstructions).toContain("need not preserve every detail or add a second source");
      expect(valueInstructions).toContain("wording overlap alone does not disqualify it");
      expect(valueInstructions).toContain("restating a short message is not enough");
      expect(valueInstructions).toContain("footer boilerplate");
      expect(decision.calls[0]!.state).toMatchObject({ document_context: context });
      const request = listDecisionsForRun(db, "run_1")[0]!.requestJson!;
      expect(request).not.toContain("Subject-only private marker");
      expect(request).not.toContain("Other-source private marker");
      expect(JSON.parse(request).state.document_context).toMatchObject({
        redacted: true,
        replayable: false,
        other_source_count: 1,
      });
    });

    test.each(["timeline", "doc-fact", "person-fact"] as const)(
      "enforce applies the current rubric and keeps its exact boundary for %s",
      async (type) => {
        const doc = insertDoc(`boundary-${type}`, BOOKING);
        const decision = new ScriptedDecision({ [BOOKING]: RECORD_BELONGS_THRESHOLD });
        const bound = check(decision, "enforce").check.forRun(
          run("bootstrap", { docId: doc, datumAt: NOW }),
        )!;
        await expect(
          bound({
            recordId: `boundary-${type}`,
            documentId: doc,
            record: { type, kind: null, text: BOOKING },
            ...(type === "doc-fact"
              ? {
                  documentContext: documentRecordContext(doc, BOOKING, [
                    { docId: doc, quote: BOOKING },
                  ]),
                }
              : {}),
          }),
        ).resolves.toEqual({ save: true });
        expect(decision.calls).toEqual([
          {
            state: {
              record_type: type,
              record_kind: "",
              record: BOOKING,
              ...(type === "doc-fact"
                ? {
                    document_context: documentRecordContext(doc, BOOKING, [
                      { docId: doc, quote: BOOKING },
                    ]),
                  }
                : {}),
            },
            questions:
              type === "doc-fact" ? DOCUMENT_RECORD_VALUE_QUESTIONS : RECORD_BELONGS_QUESTIONS,
          },
        ]);
        expect(listDecisionsForRun(db, "run_1")).toMatchObject([
          {
            rubricVersion: "record-value-v4",
            verdict: "pass",
            score: RECORD_BELONGS_THRESHOLD,
            enforced: true,
          },
        ]);
      },
    );

    test("shadow records a skip that took no effect and saves the record", async () => {
      const doc = insertDoc("m1", NOTICE);
      const decision = new ScriptedDecision({ [NOTICE]: 0.1 });
      const { check: c } = check(decision, "shadow");
      const bound = c.forRun(run("bootstrap", { docId: doc, datumAt: NOW }))!;
      await expect(bound(record(doc))).resolves.toEqual({ save: true });
      await c.idle();
      const [row] = listDecisionsForRun(db, "run_1");
      expect(row).toMatchObject({
        purpose: "record-check",
        lane: "bootstrap",
        documentId: doc,
        subjectDocumentId: doc,
        rubricVersion: RECORD_CHECK_RUBRIC_VERSION,
        verdict: "skip",
        score: 0.1,
        threshold: RECORD_BELONGS_THRESHOLD,
        recordId: "ta_1",
        enforced: false,
        modelId: "jev-1.13.0",
        inputTokens: 120,
      });
      expect(JSON.parse(row!.requestJson!)).toMatchObject({
        model: "jev-test",
        state: { record_type: "timeline", record_kind: "event", record: NOTICE },
        questions: { belongs: { type: "score" } },
      });
    });

    test("shadow saves at once, without waiting for the model to answer", async () => {
      const doc = insertDoc("m1", NOTICE);
      const decision = new HeldDecision();
      const { check: c } = check(decision, "shadow");
      const bound = c.forRun(run("bootstrap", { docId: doc, datumAt: NOW }))!;
      await expect(bound(record(doc))).resolves.toEqual({ save: true });
      expect(listDecisionsForRun(db, "run_1")).toEqual([]);
      decision.answer();
      await c.idle();
      expect(listDecisionsForRun(db, "run_1")[0]).toMatchObject({
        verdict: "skip",
        enforced: false,
      });
    });

    test("enforce drops a record scored below the threshold and keeps one above it", async () => {
      const doc = insertDoc("m1", NOTICE);
      const decision = new ScriptedDecision({ [NOTICE]: 0.1, [BOOKING]: 2.8 });
      const bound = check(decision, "enforce").check.forRun(
        run("data", { docId: doc, event: "created", datumAt: NOW }),
      )!;
      const dropped = await bound(record(doc));
      expect(dropped).toMatchObject({
        save: false,
        score: 0.1,
        threshold: RECORD_BELONGS_THRESHOLD,
      });
      await expect(bound(record(doc, BOOKING))).resolves.toEqual({ save: true });
      expect(listDecisionsForRun(db, "run_1").map((d) => [d.verdict, d.enforced, d.lane])).toEqual([
        ["skip", true, "data"],
        ["pass", true, "data"],
      ]);
    });

    test("off asks nothing and records nothing; the mode is read on every record", async () => {
      const doc = insertDoc("m1", NOTICE);
      const decision = new ScriptedDecision({ [NOTICE]: 0.1 });
      const { check: c, setMode } = check(decision, "off");
      const bound = c.forRun(run("bootstrap", { docId: doc, datumAt: NOW }))!;
      await expect(bound(record(doc))).resolves.toEqual({ save: true });
      expect(decision.calls).toHaveLength(0);
      expect(listDecisionsForRun(db, "run_1")).toEqual([]);
      setMode("enforce");
      await expect(bound(record(doc))).resolves.toMatchObject({ save: false });
    });

    test("with no decision model every record is saved unjudged", async () => {
      const doc = insertDoc("m1", NOTICE);
      const bound = check(null, "enforce").check.forRun(
        run("bootstrap", { docId: doc, datumAt: NOW }),
      )!;
      await expect(bound(record(doc))).resolves.toEqual({ save: true });
      expect(listDecisionsForRun(db, "run_1")).toEqual([]);
    });
  });

  describe("failure", () => {
    test("an unreachable model saves the record, even under enforce, and says why", async () => {
      const doc = insertDoc("m1", NOTICE);
      const decision = new ScriptedDecision({}, new Error("TypeSafe HTTP 503"));
      const bound = check(decision, "enforce").check.forRun(
        run("bootstrap", { docId: doc, datumAt: NOW }),
      )!;
      await expect(bound(record(doc))).resolves.toEqual({ save: true });
      expect(listDecisionsForRun(db, "run_1")[0]).toMatchObject({
        verdict: "unavailable",
        score: null,
        error: "TypeSafe HTTP 503",
        inputTokens: null,
      });
    });

    test("an aborted run rejects instead of saving", async () => {
      const doc = insertDoc("m1", NOTICE);
      const bound = check(new ScriptedDecision(), "enforce").check.forRun(
        run("bootstrap", { docId: doc, datumAt: NOW }),
      )!;
      const controller = new AbortController();
      controller.abort(new Error("run cancelled"));
      await expect(bound(record(doc), controller.signal)).rejects.toThrow("run cancelled");
    });

    test("an abort under enforce cancels the model call itself", async () => {
      const doc = insertDoc("m1", NOTICE);
      const decision = new HeldDecision();
      const bound = check(decision, "enforce").check.forRun(
        run("bootstrap", { docId: doc, datumAt: NOW }),
      )!;
      const controller = new AbortController();
      const pending = bound(record(doc), controller.signal);
      controller.abort(new Error("run cancelled"));
      await expect(pending).rejects.toThrow("run cancelled");
      expect(decision.signal?.aborted).toBe(true);
    });

    test("a failed ledger write still saves the record", async () => {
      const doc = insertDoc("m1", NOTICE);
      const bound = check(new ScriptedDecision({ [NOTICE]: 0.1 }), "enforce", {
        failLedger: true,
      }).check.forRun(run("bootstrap", { docId: doc, datumAt: NOW }))!;
      await expect(bound(record(doc))).resolves.toEqual({ save: true });
    });

    test("past the retention window a record-check verdict is deleted, not kept", async () => {
      const doc = insertDoc("m1", NOTICE);
      const { check: c } = check(new ScriptedDecision({ [NOTICE]: 0.1 }), "enforce");
      await c.forRun(run("bootstrap", { docId: doc, datumAt: NOW }))!(record(doc));
      expect(listDecisionsForRun(db, "run_1")).toHaveLength(1);
      expect(pruneActivityRetentionBatch(db, "cognitionDecisions", NOW + 1, 100).deleted).toBe(1);
      expect(listDecisionsForRun(db, "run_1")).toEqual([]);
    });

    test("spend lands under the record-check mechanism without counting a run", async () => {
      const doc = insertDoc("m1", NOTICE);
      const { check: c } = check(new ScriptedDecision(), "shadow");
      await c.forRun(run("bootstrap", { docId: doc, datumAt: NOW }))!(record(doc));
      await c.idle();
      const row = db
        .prepare<
          [string],
          { prompt_tokens: number; runs: number }
        >(`SELECT prompt_tokens, runs FROM cognition_spend WHERE mechanism = ?`)
        .get(RECORD_CHECK_SPEND_MECHANISM);
      expect(row).toEqual({ prompt_tokens: 120, runs: 0 });
      expect(getCognitionSpendDayTotal(db, cognitionSpendDay(NOW))?.runs ?? 0).toBe(0);
    });
  });

  describe("in the create tools", () => {
    const emptySearchPort: SearchPort = {
      async search(input) {
        return { query: input.query, durationMs: 0, results: [] };
      },
    };
    const QUOTE = "the new cycle room opens on 3 October 2026";

    function tools(
      overrides: Pick<
        Parameters<typeof buildCognitionOwnTools>[0],
        "checkRecord" | "validateAnnotationEvidence"
      > = {},
    ): ToolHandle[] {
      const writeGate = directWriteGate(db);
      return buildCognitionOwnTools({
        db,
        writeGate,
        searchPort: emptySearchPort,
        mirror: createOpenLoopMirror({ db, writeGate, log }),
        getNotesMaxBytes: () => 8192,
        clock: () => NOW,
        runId: "run_1",
        idGen: () => `id${++seq}`,
        annotationsEnabled: true,
        briefLane: "reactive",
        log,
        ...overrides,
      });
    }
    function tool(list: ToolHandle[], name: string): ToolHandle {
      const found = list.find((t) => t.name === name);
      if (!found) throw new Error(`no tool ${name}`);
      return found;
    }
    function resultType(result: ToolResult): string {
      if (result.kind !== "structured") throw new Error(JSON.stringify(result));
      return result.resultType;
    }
    const count = (table: string) =>
      db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n;
    const bootstrapRun = (doc: string) => run("bootstrap", { docId: doc, datumAt: NOW });
    function insertPerson(): void {
      db.prepare(
        `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
         VALUES ('per_1', 'Maya Reeves', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
      ).run();
    }
    const personArgs = (over: Record<string, unknown> = {}) => ({
      personId: "per_1",
      claimType: "announcement",
      claimText: "Maya Reeves announced the cycle room opening.",
      evidenceDocId: db.prepare<[], { id: string }>("SELECT id FROM documents LIMIT 1").get()!.id,
      evidenceQuote: QUOTE,
      confidence: 0.6,
      claimBasis: "inferred",
      ...over,
    });
    const docFactArgs = (doc: string, over: Record<string, unknown> = {}) => ({
      docId: doc,
      claimType: "topic",
      claimText: "the members update announces the cycle room",
      evidenceDocId: doc,
      evidenceQuote: QUOTE,
      confidence: 0.6,
      claimBasis: "quoted",
      ...over,
    });

    test("document value checks receive trusted subject context and distinct other evidence", async () => {
      const subject = insertDoc("context-subject", `Members update: ${QUOTE}.`);
      const other = insertDoc("context-other", BOOKING);
      const captured: Parameters<CheckRecord>[0][] = [];
      const list = tools({
        checkRecord: async (input) => {
          captured.push(input);
          return {
            save: false,
            decisionId: "declined",
            score: 0.1,
            threshold: RECORD_BELONGS_THRESHOLD,
          };
        },
      });
      const result = await tool(list, "annotate_durable").invoke(
        {
          docId: subject,
          claimType: "context",
          claimText: "A workshop context observation.",
          evidenceDocId: subject,
          evidenceQuote: QUOTE,
          additionalEvidence: [{ docId: other, quote: BOOKING }],
          confidence: 0.6,
          claimBasis: "synthesized",
        },
        CTX,
      );
      expect(resultType(result)).toBe("record.not_saved");
      expect(captured[0]!.documentContext).toMatchObject({
        subject_text: `Members update: ${QUOTE}.`,
        evidence: [
          { source: 0, is_subject: true, quote: QUOTE },
          { source: 1, is_subject: false, quote: BOOKING },
        ],
      });
      expect(captured[0]!.payloadCapture?.subjects).toEqual(
        expect.arrayContaining([
          { kind: "source", id: subject },
          { kind: "source", id: other },
        ]),
      );
    });

    test("changed other-source support after asynchronous subject validation cannot enter the value check", async () => {
      const body = `Members update: ${QUOTE}.`;
      const subject = insertDoc("context-race-subject", body);
      const other = insertDoc("context-race-other", BOOKING);
      const captured: Parameters<CheckRecord>[0][] = [];
      const list = tools({
        validateAnnotationEvidence: async (id, quote) => {
          if (id === subject && quote === body) {
            const replacement = "The source has changed.";
            db.prepare("UPDATE documents SET content=?,content_hash=? WHERE id=?").run(
              replacement,
              createHash("sha256").update(replacement).digest("hex"),
              other,
            );
          }
          return null;
        },
        checkRecord: async (input) => {
          captured.push(input);
          return {
            save: false,
            decisionId: "declined",
            score: 0.1,
            threshold: RECORD_BELONGS_THRESHOLD,
          };
        },
      });
      await tool(list, "annotate_durable").invoke(
        {
          docId: subject,
          claimType: "context",
          claimText: "A workshop context observation.",
          evidenceDocId: subject,
          evidenceQuote: QUOTE,
          additionalEvidence: [{ docId: other, quote: BOOKING }],
          confidence: 0.6,
          claimBasis: "synthesized",
        },
        CTX,
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]!.documentContext).toBeUndefined();
    });

    test("a privacy-hidden subject never enters a document check's extra source context", async () => {
      const subject = insertDoc("context-hidden", "A source-only private marker.");
      const other = insertDoc("context-visible", BOOKING);
      db.prepare(
        "UPDATE knowledge_source_revisions SET deleted=1,updated_at=? WHERE document_id=?",
      ).run(NOW, subject);
      const captured: Parameters<CheckRecord>[0][] = [];
      const list = tools({
        checkRecord: async (input) => {
          captured.push(input);
          return {
            save: false,
            decisionId: "declined",
            score: 0.1,
            threshold: RECORD_BELONGS_THRESHOLD,
          };
        },
      });
      await tool(list, "annotate_durable").invoke(
        {
          docId: subject,
          claimType: "context",
          claimText: "A workshop context observation.",
          evidenceDocId: other,
          evidenceQuote: BOOKING,
          confidence: 0.6,
          claimBasis: "quoted",
        },
        CTX,
      );
      expect(captured).toHaveLength(1);
      expect(captured[0]!.documentContext).toBeUndefined();
      expect(JSON.stringify(captured)).not.toContain("source-only private marker");
    });

    test("enforce: a dropped doc, person and temporal record is not saved, and the agent is told not to retry", async () => {
      const doc = insertDoc("m1", `Members update: ${QUOTE}.`);
      db.prepare(
        `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen, created_at, updated_at)
         VALUES ('per_1', 'Maya Reeves', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
      ).run();
      const decision = new ScriptedDecision({
        [NOTICE]: 0.1,
        "Maya Reeves announced the cycle room opening.": 0.2,
        "the members update announces the cycle room": 0.3,
      });
      const checkRecord = check(decision, "enforce").check.forRun(
        run("bootstrap", { docId: doc, datumAt: NOW }),
      )!;
      const list = tools({ checkRecord });

      const temporal = await tool(list, "temporal_annotation_add").invoke(
        {
          when: "2026-10-03",
          sentence: NOTICE,
          kind: "event",
          evidence: { docId: doc, quote: QUOTE },
        },
        CTX,
      );
      const person = await tool(list, "annotate_person").invoke(
        {
          personId: "per_1",
          claimType: "announcement",
          claimText: "Maya Reeves announced the cycle room opening.",
          evidenceDocId: doc,
          evidenceQuote: QUOTE,
          confidence: 0.6,
          claimBasis: "inferred",
        },
        CTX,
      );
      const docFact = await tool(list, "annotate_durable").invoke(
        {
          docId: doc,
          claimType: "topic",
          claimText: "the members update announces the cycle room",
          evidenceDocId: doc,
          evidenceQuote: QUOTE,
          confidence: 0.6,
          claimBasis: "quoted",
        },
        CTX,
      );
      for (const result of [temporal, person, docFact]) {
        expect(resultType(result)).toBe("record.not_saved");
        if (result.kind === "structured") {
          expect((result.data as { guidance: string }).guidance).toContain("Do not retry");
        }
      }
      expect(count("temporal_annotations")).toBe(0);
      expect(count("person_annotations")).toBe(0);
      expect(count("doc_annotations")).toBe(0);
      expect(
        listDecisionsForRun(db, "run_1").map((d) => [d.recordId?.slice(0, 3), d.verdict]),
      ).toEqual([
        ["ta_", "skip"],
        ["pan", "skip"],
        ["ann", "skip"],
      ]);
    });

    test("shadow: each record is saved under the id the ledger names", async () => {
      const doc = insertDoc("m1", `Members update: ${QUOTE}.`);
      insertPerson();
      const decision = new ScriptedDecision({ [NOTICE]: 0.1 });
      const { check: c } = check(decision, "shadow");
      const list = tools({ checkRecord: c.forRun(bootstrapRun(doc))! });
      const added = await tool(list, "temporal_annotation_add").invoke(
        {
          when: "2026-10-03",
          sentence: NOTICE,
          kind: "event",
          evidence: { docId: doc, quote: QUOTE },
        },
        CTX,
      );
      expect(resultType(added)).toBe("temporal_annotation.added");
      const person = await tool(list, "annotate_person").invoke(personArgs(), CTX);
      expect(resultType(person)).toBe("person_annotation.created");
      await c.idle();
      const idOf = (r: ToolResult) =>
        r.kind === "structured" ? (r.data as { id: string }).id : "";
      expect(
        listDecisionsForRun(db, "run_1").map((d) => [d.recordId, d.verdict, d.enforced]),
      ).toEqual([
        [idOf(added), "skip", false],
        [idOf(person), "pass", false],
      ]);
    });

    test("a supersede replaces a belief without being checked", async () => {
      const doc = insertDoc("m1", `Members update: ${QUOTE}.`);
      insertPerson();
      const first = tools();
      const docFact = await tool(first, "annotate_durable").invoke(docFactArgs(doc), CTX);
      const personFact = await tool(first, "annotate_person").invoke(personArgs(), CTX);
      const idOf = (r: ToolResult) =>
        r.kind === "structured" ? (r.data as { id: string }).id : "";
      const decision = new ScriptedDecision({}, undefined, 0.1);
      const list = tools({
        checkRecord: check(decision, "enforce").check.forRun(bootstrapRun(doc))!,
      });
      const replacedDoc = await tool(list, "annotate_durable").invoke(
        docFactArgs(doc, {
          claimText: "the members update names the cycle studio",
          supersedes: idOf(docFact),
        }),
        CTX,
      );
      const replacedPerson = await tool(list, "annotate_person").invoke(
        personArgs({
          claimText: "Maya Reeves wrote the members update.",
          supersedes: idOf(personFact),
        }),
        CTX,
      );
      expect(resultType(replacedDoc)).toBe("annotation.created");
      expect(resultType(replacedPerson)).toBe("person_annotation.created");
      expect(decision.calls).toHaveLength(0);
    });

    test("self-sourced scheduling entries and refused writes are never checked", async () => {
      const doc = insertDoc("m1", `Members update: ${QUOTE}.`);
      const decision = new ScriptedDecision({ [NOTICE]: 0.1 });
      const list = tools({
        checkRecord: check(decision, "enforce").check.forRun(bootstrapRun(doc))!,
      });
      // No evidence: the agent's own bookkeeping.
      const own = await tool(list, "temporal_annotation_add").invoke(
        { when: "2026-10-03", sentence: "check back on the renewal", kind: "reminder" },
        CTX,
      );
      expect(resultType(own)).toBe("temporal_annotation.added");
      // A write the evidence teeth refuse never reaches the check.
      const refused = await tool(list, "annotate_durable").invoke(
        {
          docId: doc,
          claimType: "topic",
          claimText: "the update mentions a pool",
          evidenceDocId: doc,
          evidenceQuote: "a quote that appears nowhere in the message",
          confidence: 0.6,
          claimBasis: "quoted",
        },
        CTX,
      );
      expect(refused.kind).toBe("error");
      expect(decision.calls).toHaveLength(0);
    });

    test("without a bound check (interactive memory) records save as before", async () => {
      const doc = insertDoc("m1", `Members update: ${QUOTE}.`);
      const added = await tool(tools(), "temporal_annotation_add").invoke(
        {
          when: "2026-10-03",
          sentence: NOTICE,
          kind: "event",
          evidence: { docId: doc, quote: QUOTE },
        },
        CTX,
      );
      expect(resultType(added)).toBe("temporal_annotation.added");
      expect(listDecisionsForRun(db, "run_1")).toEqual([]);
    });
  });
});
