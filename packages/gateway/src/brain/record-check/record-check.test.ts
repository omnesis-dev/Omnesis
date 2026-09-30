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
import { pruneActivityRetentionBatch } from "../../activity-retention/store.js";
import { listDecisionsForRun } from "../storage/decisions.js";
import { cognitionSpendDay, getCognitionSpendDayTotal } from "../storage/spend.js";
import { createOpenLoopMirror } from "../steward/mirror.js";
import { buildCognitionOwnTools } from "../steward/tools.js";
import { RecordCheck, type CheckRecord } from "./check.js";
import {
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
    test("covers data and bootstrap runs only, and never content handed to the assistant", () => {
      const { check: c } = check(new ScriptedDecision(), "shadow");
      expect(c.forRun(run("bootstrap", { docId: "d", datumAt: NOW }))).not.toBeNull();
      expect(c.forRun(run("data", { docId: "d", event: "created", datumAt: NOW }))).not.toBeNull();
      expect(
        c.forRun(run("data", { docId: "d", event: "created", datumAt: NOW, immediate: true })),
      ).toBeNull();
      expect(c.forRun(run("daily", {}))).toBeNull();
      expect(c.forRun(run("synthesis", {}))).toBeNull();
    });
  });

  describe("modes", () => {
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

    function tools(overrides: { checkRecord?: CheckRecord } = {}): ToolHandle[] {
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
      const checkRecord = check(decision, "enforce").check.forRun(bootstrapRun(doc))!;
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
