// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP coverage for the operator's observation reads: the list with its state
 * filter and keyset pagination, the detail view with its related loops and
 * salience decisions, the "would have pushed" log, the pruned outcomes, and
 * the sent morning brief by day or latest. Every route sits behind admin
 * scope and the visibility gate.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, ProviderId, SourceId, type Scope } from "@omnesis/types";
import { createDatabase, upsertDocuments } from "../db.js";
import { createServer } from "../server.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { createOpenLoop } from "./storage/open-loops.js";
import {
  createObservation,
  pruneClosedObservations,
  transitionObservation,
} from "./storage/observations.js";
import { markMorningBriefSent, replaceMorningBriefItems } from "./storage/morning-brief-items.js";
import { insertCognitionDecision } from "./storage/decisions.js";
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

function mint(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

async function get(path: string, token = ADMIN) {
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

function observe(
  id: string,
  at: number,
  extra: Partial<Parameters<typeof createObservation>[1]> = {},
) {
  return createObservation(
    db,
    { id, createdByRun: "run_note", summary: `Summary ${id}`, ...extra },
    at,
  );
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  ADMIN = mint([SCOPE_ADMIN, SCOPE_READ]);
  READ = mint([SCOPE_READ]);
  status = { ...ACTIVE };
  app = createServer(db, dbPath, { getBriefsStatus: () => status });
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

const ROUTES = [
  "/admin/brain/observations",
  "/admin/brain/observations/would-push",
  "/admin/brain/observations/outcomes",
  "/admin/brain/observations/obs_x",
  "/admin/brain/morning-brief",
];

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
    expect((await get("/admin/brain/observations")).status).toBe(200);
  });
});

describe("GET /admin/brain/observations", () => {
  beforeEach(() => {
    observe("obs_1", NOW - 4 * DAY);
    observe("obs_2", NOW - 3 * DAY);
    observe("obs_3", NOW - 2 * DAY);
    observe("obs_4", NOW - DAY);
    transitionObservation(db, "obs_2", { state: "held", reason: "below_bar" }, NOW);
    transitionObservation(db, "obs_3", { state: "dropped", reason: "expired" }, NOW);
    transitionObservation(
      db,
      "obs_4",
      { state: "shipped", shipped: { conversationId: "conv", messageId: "msg" } },
      NOW,
    );
  });

  test("lists every state newest first with ISO timestamps", async () => {
    const { status: code, body } = await get("/admin/brain/observations");
    expect(code).toBe(200);
    expect(body.items.map((o: { id: string }) => o.id)).toEqual([
      "obs_4",
      "obs_3",
      "obs_2",
      "obs_1",
    ]);
    expect(body.items[0]).toMatchObject({
      state: "shipped",
      shippedMessageId: "msg",
      createdAt: new Date(NOW - DAY).toISOString(),
      closedAt: new Date(NOW).toISOString(),
    });
    expect(body.items[1]).toMatchObject({ state: "dropped", closeReason: "expired" });
    expect(body.pageInfo.hasMore).toBe(false);
  });

  test.each([
    ["live", ["obs_1"]],
    ["held", ["obs_2"]],
    ["dropped", ["obs_3"]],
    ["shipped", ["obs_4"]],
    ["open", ["obs_2", "obs_1"]],
  ])("filters by state=%s", async (state, ids) => {
    const { body } = await get(`/admin/brain/observations?state=${state}`);
    expect(body.items.map((o: { id: string }) => o.id)).toEqual(ids);
  });

  test("rejects an unknown state and a bad limit", async () => {
    expect((await get("/admin/brain/observations?state=archived")).status).toBe(400);
    expect((await get("/admin/brain/observations?limit=0")).status).toBe(400);
    expect((await get("/admin/brain/observations?limit=abc")).status).toBe(400);
  });

  test("paginates with a cursor bound to its filter", async () => {
    const first = await get("/admin/brain/observations?limit=3");
    expect(first.body.items.map((o: { id: string }) => o.id)).toEqual(["obs_4", "obs_3", "obs_2"]);
    expect(first.body.pageInfo.hasMore).toBe(true);
    const cursor = first.body.pageInfo.nextCursor as string;
    expect(cursor).toBeTruthy();
    const second = await get(
      `/admin/brain/observations?limit=3&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(second.body.items.map((o: { id: string }) => o.id)).toEqual(["obs_1"]);
    expect(second.body.pageInfo.hasMore).toBe(false);
    // A cursor minted for one filter does not apply to another.
    expect(
      (await get(`/admin/brain/observations?state=open&cursor=${encodeURIComponent(cursor)}`))
        .status,
    ).toBe(400);
    expect((await get("/admin/brain/observations?cursor=garbage")).status).toBe(400);
  });
});

describe("GET /admin/brain/observations/:id", () => {
  test("404 for an unknown id", async () => {
    expect((await get("/admin/brain/observations/obs_missing")).status).toBe(404);
  });

  test("returns citations as document refs, related loops and salience decisions", async () => {
    upsertDocuments(db, [
      {
        providerId: ProviderId("google"),
        sourceId: SourceId("gmail-test"),
        externalId: "e1",
        title: "Riverside Estate invoice",
        content: "Invoice body",
        contentHash: "h-e1",
        sourceCreatedAt: "2026-07-01T09:00:00.000Z",
        sourceUpdatedAt: "2026-07-01T09:00:00.000Z",
        metadata: { documentType: "email" },
      },
    ]);
    const doc = db.prepare<[], { id: string }>("SELECT id FROM documents").get()!.id;
    createOpenLoop(
      db,
      {
        id: "loop_pay",
        createdByRun: "r",
        title: "Pay the invoice",
        confidence: 0.8,
        importance: 0.6,
      },
      NOW - DAY,
    );
    observe("obs_detail", NOW - DAY, {
      citations: [doc, "doc_gone"],
      relatedLoopIds: ["loop_pay", "loop_gone"],
    });
    insertCognitionDecision(db, {
      id: "decision_1",
      runId: "run_note",
      documentId: doc,
      subjectDocumentId: doc,
      purpose: "observation-salience",
      lane: "note",
      rubricVersion: "observation-salience-v1",
      contentHash: null,
      requestedModelId: "scripted",
      modelId: "scripted",
      requestJson: "{}",
      responseJson: null,
      score: 3,
      threshold: 2,
      verdict: "pass",
      error: null,
      reusedFrom: null,
      recordId: "obs_detail",
      enforced: true,
      latencyMs: 1,
      inputTokens: 10,
      createdAt: NOW - DAY,
    });
    const { status: code, body } = await get("/admin/brain/observations/obs_detail");
    expect(code).toBe(200);
    expect(body.observation.id).toBe("obs_detail");
    expect(body.observation.citations).toEqual([
      expect.objectContaining({ id: doc, title: "Riverside Estate invoice" }),
      { id: "doc_gone", title: null, sourceType: null },
    ]);
    expect(body.relatedLoops).toEqual([
      { id: "loop_gone", title: null, state: null },
      { id: "loop_pay", title: "Pay the invoice", state: "open" },
    ]);
    expect(body.decisions).toEqual([
      expect.objectContaining({
        id: "decision_1",
        purpose: "observation-salience",
        lane: "note",
        score: 3,
        createdAt: new Date(NOW - DAY).toISOString(),
      }),
    ]);
    expect(body).toHaveProperty("provenance");
  });
});

describe("GET /admin/brain/observations/would-push and /outcomes", () => {
  test("lists live and pruned would-push entries newest first", async () => {
    const scores = { alreadyKnown: 0, consequence: 4, timing: 3, modelId: "m", at: 1 };
    observe("obs_push_old", NOW - 200 * DAY, { notedScores: scores, wouldPushAt: NOW - 200 * DAY });
    transitionObservation(
      db,
      "obs_push_old",
      { state: "dropped", reason: "expired" },
      NOW - 150 * DAY,
    );
    pruneClosedObservations(db, NOW - 90 * DAY, NOW);
    observe("obs_push_new", NOW - DAY, {
      notedScores: scores,
      wouldPushAt: NOW - DAY,
      relevantUntil: NOW + DAY,
    });
    observe("obs_quiet", NOW - DAY);
    const { status: code, body } = await get("/admin/brain/observations/would-push");
    expect(code).toBe(200);
    expect(body.items.map((e: { id: string }) => e.id)).toEqual(["obs_push_new", "obs_push_old"]);
    expect(body.items[0]).toMatchObject({
      wouldPushAt: new Date(NOW - DAY).toISOString(),
      relevantUntil: new Date(NOW + DAY).toISOString(),
      shippedAt: null,
      state: "live",
    });
    expect(body.items[1]).toMatchObject({ state: "dropped", relevantUntil: null });
    expect((await get("/admin/brain/observations/would-push?limit=1")).body.items).toHaveLength(1);
    expect((await get("/admin/brain/observations/would-push?limit=-1")).status).toBe(400);
  });

  test("lists pruned outcomes with ISO times", async () => {
    observe("obs_gone", NOW - 200 * DAY);
    transitionObservation(
      db,
      "obs_gone",
      { state: "dropped", reason: "withdrawn" },
      NOW - 150 * DAY,
    );
    pruneClosedObservations(db, NOW - 90 * DAY, NOW);
    const { status: code, body } = await get("/admin/brain/observations/outcomes");
    expect(code).toBe(200);
    expect(body.items).toEqual([
      expect.objectContaining({
        id: "obs_gone",
        state: "dropped",
        closeReason: "withdrawn",
        createdAt: new Date(NOW - 200 * DAY).toISOString(),
        closedAt: new Date(NOW - 150 * DAY).toISOString(),
        prunedAt: new Date(NOW).toISOString(),
      }),
    ]);
    expect((await get("/admin/brain/observations/outcomes?limit=x")).status).toBe(400);
  });
});

describe("GET /admin/brain/morning-brief", () => {
  test("nothing sent: null with no items", async () => {
    expect((await get("/admin/brain/morning-brief")).body).toEqual({ sent: null, items: [] });
  });

  test("an unsent day shows its ranked list without a send record", async () => {
    observe("obs_a", NOW - DAY);
    replaceMorningBriefItems(db, "2026-07-02", "run_m", ["obs_a"]);
    const { body } = await get("/admin/brain/morning-brief?day=2026-07-02");
    expect(body.sent).toBeNull();
    expect(body.items).toEqual([
      expect.objectContaining({ rank: 1, observationId: "obs_a", runId: "run_m", messageId: null }),
    ]);
    expect(body.items[0].observation).toMatchObject({ id: "obs_a", state: "live" });
  });

  test("latest and by-day return the sent brief with its shipped items", async () => {
    observe("obs_a", NOW - 2 * DAY);
    observe("obs_b", NOW - 2 * DAY);
    replaceMorningBriefItems(db, "2026-07-01", "run_1", ["obs_a"]);
    markMorningBriefSent(
      db,
      { day: "2026-07-01", runId: "run_1", conversationId: "conv", messageId: "msg_1" },
      NOW - DAY,
    );
    replaceMorningBriefItems(db, "2026-07-02", "run_2", ["obs_b"]);
    markMorningBriefSent(
      db,
      { day: "2026-07-02", runId: "run_2", conversationId: "conv", messageId: "msg_2" },
      NOW,
    );
    const latest = (await get("/admin/brain/morning-brief")).body;
    expect(latest.sent).toEqual({
      day: "2026-07-02",
      runId: "run_2",
      conversationId: "conv",
      messageId: "msg_2",
      itemCount: 1,
      sentAt: new Date(NOW).toISOString(),
    });
    expect(latest.items).toEqual([
      expect.objectContaining({ observationId: "obs_b", messageId: "msg_2" }),
    ]);
    expect(latest.items[0].observation.state).toBe("shipped");
    const earlier = (await get("/admin/brain/morning-brief?day=2026-07-01")).body;
    expect(earlier.sent.messageId).toBe("msg_1");
    expect(earlier.items.map((i: { observationId: string }) => i.observationId)).toEqual(["obs_a"]);
    // An empty day parameter means latest.
    expect((await get("/admin/brain/morning-brief?day=")).body.sent.day).toBe("2026-07-02");
  });

  test("an item whose observation is gone renders with a null observation", async () => {
    replaceMorningBriefItems(db, "2026-07-02", "run_m", ["obs_missing"]);
    const { body } = await get("/admin/brain/morning-brief?day=2026-07-02");
    expect(body.items).toEqual([
      expect.objectContaining({ observationId: "obs_missing", observation: null }),
    ]);
  });
});
