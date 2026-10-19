// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP coverage for the operator's interest-ledger reads: the ledger page
 * with its counts, backlog, signals newest first and the suggestion-gate
 * verdicts, and the lookup probe that runs one gate-style lookup. Both sit
 * behind admin scope and the visibility gate, and neither exists when the
 * composition has no interest engine.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "@omnesis/core";
import { ProviderId, SCOPE_ADMIN, SCOPE_READ, SourceId, type Scope } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import { createServer } from "../server.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { InterestEngine } from "./interest/engine.js";
import { insertCognitionDecision } from "./storage/decisions.js";
import {
  insertInterestSignal,
  setInterestSignalEmbedding,
  supersedeInterestSignals,
  type NewInterestSignal,
} from "./storage/interest.js";
import { createOpenLoop } from "./storage/open-loops.js";
import { applyTaskCommand } from "./storage/tasks.js";
import type { BriefsFeatureStatus } from "./feature-gate.js";
import type Database from "better-sqlite3";

const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const DAY = 86_400_000;
const ACTIVE: BriefsFeatureStatus = {
  visible: true,
  enabled: true,
  modelAssigned: true,
  active: true,
};

let db: Database.Database;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let ADMIN: string;
let READ: string;
let status: BriefsFeatureStatus;
let enabled: boolean;

function mint(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

async function get(path: string, token = ADMIN) {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

function engine(): InterestEngine {
  return new InterestEngine({
    db,
    writeGate: {
      recordInterestSignal: vi.fn(),
      supersedeInterestSignals: vi.fn(),
      setInterestSignalEmbedding: vi.fn(),
      resetInterestEmbeddingsNotFrom: vi.fn(() => Promise.resolve(0)),
    },
    // No embedder: the probe compares by word overlap, as a gate does then.
    getEmbedder: () => null,
    enabled: () => enabled,
    clock: () => NOW,
    idGen: () => randomUUID(),
    log: createLogger("test:interest"),
  });
}

function signal(
  id: string,
  at: number,
  extra: Partial<NewInterestSignal> & Pick<NewInterestSignal, "subjectText">,
) {
  return insertInterestSignal(db, {
    id,
    polarity: 1,
    kind: "task",
    source: "task_accepted",
    createdAt: at,
    ...extra,
  });
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  ADMIN = mint([SCOPE_ADMIN, SCOPE_READ]);
  READ = mint([SCOPE_READ]);
  status = { ...ACTIVE };
  enabled = true;
  app = createServer(db, dbPath, { getBriefsStatus: () => status, interest: engine() });
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

const ROUTES = ["/admin/brain/interest", "/admin/brain/interest/lookup?text=boiler"];

describe("gates", () => {
  test("every route 404s when the feature is not visible", async () => {
    status = { visible: false, enabled: false, modelAssigned: false, active: false };
    for (const route of ROUTES) expect((await get(route)).status, route).toBe(404);
  });

  test("every route refuses a read-only token", async () => {
    for (const route of ROUTES) expect((await get(route, READ)).status, route).toBe(403);
  });

  test("visible but inactive still serves the reads", async () => {
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    expect((await get("/admin/brain/interest")).status).toBe(200);
  });

  test("a composition without an interest engine has no routes", async () => {
    const bare = createServer(db, dbPath, { getBriefsStatus: () => status });
    for (const route of ROUTES) {
      const res = await bare.request(route, { headers: { authorization: `Bearer ${ADMIN}` } });
      expect(res.status, route).toBe(404);
    }
  });
});

describe("GET /admin/brain/interest", () => {
  test("an empty ledger reads as enabled with nothing in it", async () => {
    const { status: code, body } = await get("/admin/brain/interest");
    expect(code).toBe(200);
    expect(body).toEqual({
      enabled: true,
      backlog: 0,
      counts: { live: 0, superseded: 0, positive: 0, negative: 0, statements: 0 },
      signals: [],
      withheld: [],
      decisions: [],
    });
  });

  test("lists the suggestions the gate withheld with the ledger entry undo takes", async () => {
    createOpenLoop(
      db,
      {
        id: "loop_held",
        createdByRun: "run_gate",
        title: "Chase the deposit refund",
        confidence: 0.8,
        importance: 0.6,
        proposal: { tier: "withhold", note: "Like the invoices you ignore" },
      },
      NOW - DAY,
    );
    const { body } = await get("/admin/brain/interest");
    expect(body.withheld).toEqual([
      {
        loopId: "loop_held",
        title: "Chase the deposit refund",
        seq: expect.any(Number),
        at: new Date(NOW - DAY).toISOString(),
        note: "Like the invoices you ignore",
      },
    ]);
    const undone = applyTaskCommand(
      db,
      { surface: "tasks", runId: "user:tasks", kind: "undo", seq: body.withheld[0].seq },
      NOW,
    );
    expect(undone.ok).toBe(true);
    expect((await get("/admin/brain/interest")).body.withheld).toEqual([]);
  });

  test("lists every signal newest first with counts, backlog and vectors", async () => {
    signal("int_a", NOW - 3 * DAY, {
      subjectText: "Book the boiler engineer",
      loopId: "loop_boiler",
      conversationId: "conv_brief",
    });
    signal("int_b", NOW - 2 * DAY, {
      polarity: -1,
      kind: "observation",
      source: "brief_not_interested",
      subjectText: "The venue moved",
      note: "Not my event",
      observationId: "obs_venue",
    });
    signal("int_c", NOW - DAY, {
      kind: "statement",
      source: "statement",
      subjectText: "more about the marathon",
    });
    signal("int_old", NOW - 4 * DAY, {
      subjectText: "Renew the parking permit",
      loopId: "loop_permit",
    });
    setInterestSignalEmbedding(db, "int_a", { vector: [0.1, 0.2], model: "embed-test" }, NOW);
    supersedeInterestSignals(db, { loopId: "loop_permit" }, NOW - DAY);
    enabled = false;

    const { status: code, body } = await get("/admin/brain/interest");
    expect(code).toBe(200);
    expect(body.enabled).toBe(false);
    // Two live signals without a vector; the superseded one is not a backlog.
    expect(body.backlog).toBe(2);
    expect(body.counts).toEqual({
      live: 3,
      superseded: 1,
      positive: 1,
      negative: 1,
      statements: 1,
    });
    expect(body.signals.map((s: { id: string }) => s.id)).toEqual([
      "int_c",
      "int_b",
      "int_a",
      "int_old",
    ]);
    expect(body.signals[2]).toEqual({
      id: "int_a",
      polarity: 1,
      kind: "task",
      source: "task_accepted",
      text: "Book the boiler engineer",
      note: null,
      loopId: "loop_boiler",
      observationId: null,
      conversationId: "conv_brief",
      embedded: true,
      createdAt: new Date(NOW - 3 * DAY).toISOString(),
      supersededAt: null,
    });
    expect(body.signals[1]).toMatchObject({
      polarity: -1,
      source: "brief_not_interested",
      note: "Not my event",
      observationId: "obs_venue",
      embedded: false,
    });
    expect(body.signals[3]).toMatchObject({
      id: "int_old",
      supersededAt: new Date(NOW - DAY).toISOString(),
    });
  });

  test("honours and bounds the limit", async () => {
    for (let i = 0; i < 5; i += 1) signal(`int_${i}`, NOW - i, { subjectText: `Signal ${i}` });
    expect((await get("/admin/brain/interest?limit=2")).body.signals).toHaveLength(2);
    expect((await get("/admin/brain/interest?limit=0")).status).toBe(400);
    expect((await get("/admin/brain/interest?limit=abc")).status).toBe(400);
  });

  /** One suggestion-gate verdict about `recordId`; `documentId` anchors it to a document. */
  const decision = (
    id: string,
    recordId: string,
    at: number,
    score: number,
    documentId: string | null = null,
  ) =>
    insertCognitionDecision(db, {
      id,
      runId: "run_propose",
      documentId,
      subjectDocumentId: documentId,
      purpose: "task-propose",
      lane: "tier",
      rubricVersion: "task-propose-v1",
      contentHash: null,
      requestedModelId: "scripted",
      modelId: "scripted",
      requestJson: JSON.stringify({ state: { owner_interest: {} } }),
      responseJson: JSON.stringify({ tier: score }),
      score,
      threshold: 1,
      verdict: score === 0 ? "skip" : "pass",
      error: null,
      reusedFrom: null,
      recordId,
      enforced: false,
      latencyMs: 1,
      inputTokens: 10,
      createdAt: at,
    });

  test("lists the suggestion-gate verdicts newest first through the decision DTO", async () => {
    decision("dec_1", "loop_a", NOW - 2 * DAY, 1);
    decision("dec_2", "loop_b", NOW - DAY, 0);
    decision("dec_3", "loop_a", NOW, 2);
    // Another purpose about the same record is not a suggestion-gate verdict.
    insertCognitionDecision(db, {
      id: "dec_check",
      runId: "run_check",
      documentId: null,
      subjectDocumentId: null,
      purpose: "task-check",
      lane: "same_task",
      rubricVersion: "task-check-v2",
      contentHash: null,
      requestedModelId: "scripted",
      modelId: "scripted",
      requestJson: "{}",
      responseJson: null,
      score: 1,
      threshold: 1,
      verdict: "pass",
      error: null,
      reusedFrom: null,
      recordId: "loop_a",
      enforced: true,
      latencyMs: 1,
      inputTokens: 10,
      createdAt: NOW,
    });

    const { body } = await get("/admin/brain/interest");
    expect(body.decisions.map((d: { id: string }) => d.id)).toEqual(["dec_3", "dec_2", "dec_1"]);
    expect(body.decisions[0]).toEqual(
      expect.objectContaining({
        id: "dec_3",
        purpose: "task-propose",
        lane: "tier",
        verdict: "pass",
        score: 2,
        threshold: 1,
        recordId: "loop_a",
        enforced: false,
        createdAt: new Date(NOW).toISOString(),
        request: { state: { owner_interest: {} } },
        response: { tier: 2 },
      }),
    );
    expect(body.decisions[1]).toMatchObject({ verdict: "skip", score: 0, recordId: "loop_b" });
  });

  test("keeps the verdicts of the 50 most recently judged records", async () => {
    // 51 records, one verdict each, oldest first; the oldest record falls off.
    for (let i = 0; i < 51; i += 1) decision(`dec_${i}`, `loop_${i}`, NOW - (51 - i) * 1000, 1);
    // A second, older verdict about a recent record still rides in with it.
    decision("dec_50_old", "loop_50", NOW - 60 * DAY, 0);
    const { body } = await get("/admin/brain/interest");
    const ids = body.decisions.map((d: { id: string }) => d.id);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe("dec_50");
    expect(ids).toContain("dec_1");
    expect(ids).not.toContain("dec_0");
    // Fifty records' newest verdicts fill the page before any record's older one.
    expect(ids).not.toContain("dec_50_old");
    // Newest first throughout.
    const times = body.decisions.map((d: { createdAt: string }) => Date.parse(d.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test("a verdict anchored to a document that is no longer readable keeps its score but not its payload", async () => {
    upsertDocuments(db, [
      {
        providerId: ProviderId("google"),
        sourceId: SourceId("gmail-test"),
        externalId: "e1",
        title: "Boiler service quote",
        content: "Quote body",
        contentHash: "h-e1",
        sourceCreatedAt: "2026-07-01T09:00:00.000Z",
        sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
        metadata: { documentType: "email" },
      },
    ]);
    const doc = db.prepare<[], { id: string }>("SELECT id FROM documents").get()!.id;
    decision("dec_open", "loop_a", NOW - DAY, 1);
    decision("dec_fenced", "loop_b", NOW, 2, doc);
    // A purge of the document's source is pending: its audit content is fenced.
    db.prepare(
      "INSERT INTO knowledge_cascade_jobs (kind, target_kind, target_id, revision, created_at) VALUES ('purge', 'source', ?, 'r1', ?)",
    ).run(doc, NOW);
    const { body } = await get("/admin/brain/interest");
    expect(body.decisions.map((d: { id: string }) => d.id)).toEqual(["dec_fenced", "dec_open"]);
    expect(body.decisions[0]).toMatchObject({
      id: "dec_fenced",
      score: 2,
      verdict: "pass",
      documentId: doc,
      request: null,
      response: null,
      error: null,
    });
    expect(body.decisions[1]).toMatchObject({
      id: "dec_open",
      request: { state: { owner_interest: {} } },
      response: { tier: 1 },
    });
  });
});

describe("GET /admin/brain/interest/lookup", () => {
  test("rejects a missing, blank or oversized text", async () => {
    expect((await get("/admin/brain/interest/lookup")).status).toBe(400);
    expect((await get("/admin/brain/interest/lookup?text=%20%20")).status).toBe(400);
    expect((await get(`/admin/brain/interest/lookup?text=${"a".repeat(2001)}`)).status).toBe(400);
    expect((await get(`/admin/brain/interest/lookup?text=${"a".repeat(2000)}`)).status).toBe(200);
  });

  test("an empty ledger answers a null result", async () => {
    const { status: code, body } = await get("/admin/brain/interest/lookup?text=boiler%20engineer");
    expect(code).toBe(200);
    expect(body).toEqual({ text: "boiler engineer", result: null });
  });

  test("returns the resembling reactions by polarity, with age and similarity", async () => {
    signal("int_yes", NOW - 3 * DAY, {
      subjectText: "Book the boiler engineer",
      loopId: "loop_boiler",
    });
    signal("int_no", NOW - 2 * DAY, {
      polarity: -1,
      kind: "observation",
      source: "brief_not_interested",
      subjectText: "The boiler engineer newsletter",
      note: "Marketing, not mine",
      observationId: "obs_news",
    });
    signal("int_say", NOW - DAY, {
      polarity: -1,
      kind: "statement",
      source: "statement",
      subjectText: "less about the boiler engineer",
    });
    signal("int_far", NOW, { subjectText: "Renew the parking permit" });

    const { status: code, body } = await get(
      "/admin/brain/interest/lookup?text=Pay%20the%20boiler%20engineer%20invoice",
    );
    expect(code).toBe(200);
    expect(body.text).toBe("Pay the boiler engineer invoice");
    expect(body.result.positive).toEqual([
      expect.objectContaining({
        text: "Book the boiler engineer",
        source: "task_accepted",
        ageDays: 3,
        basis: "words",
      }),
    ]);
    expect(body.result.positive[0].similarity).toBeGreaterThan(0.2);
    expect(body.result.negative).toEqual([
      expect.objectContaining({
        text: "The boiler engineer newsletter",
        note: "Marketing, not mine",
        source: "brief_not_interested",
        ageDays: 2,
        basis: "words",
      }),
    ]);
    expect(body.result.statements).toEqual([
      expect.objectContaining({ direction: "less", ageDays: 1, basis: "words" }),
    ]);
    // Nothing about parking resembles the probe.
    expect(JSON.stringify(body.result)).not.toContain("parking");
  });

  test("answers null while the ledger is disabled", async () => {
    signal("int_yes", NOW - DAY, { subjectText: "Book the boiler engineer" });
    enabled = false;
    expect(
      (await get("/admin/brain/interest/lookup?text=boiler%20engineer")).body.result,
    ).toBeNull();
  });
});
