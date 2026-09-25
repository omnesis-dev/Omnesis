// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for the /briefs surface: GET /briefs/feed (the
 * ranked feed with resolved citations), POST /briefs/:id/read (the
 * per-brief seen signal), POST /briefs/:id/dismiss, the unified temporal
 * window plus legacy annotation-only reads, and the `/loops*` reads. The suite
 * asserts the disabled-feature gate, parked-agent access for the feed and
 * triage routes, the auth scope, and each response contract;
 * the dismissal additionally proves the state flip + pending feedback
 * run land durably before the response returns.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../db.js";
import { createServer } from "../server.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import {
  insertTemporalAnnotation,
  invalidateTemporalAnnotation,
  type CreateTemporalAnnotationInput,
} from "../enrichment/temporal-annotations/storage.js";
import { createBrief, getBrief, type CreateBriefInput } from "./storage/briefs.js";
import {
  appendOpenLoopLedger,
  createOpenLoop,
  updateOpenLoop,
  type CreateOpenLoopInput,
} from "./storage/open-loops.js";
import { TEMPORAL_ANNOTATION_WINDOW_MAX_SPAN_MS } from "./temporal-annotation-window.js";
import type { StatusCache } from "../http/services/StatusCache.js";
import type { BriefsFeatureStatus } from "./feature-gate.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let app: ReturnType<typeof createServer>;
let ADMIN_TOKEN: string;
let READ_TOKEN: string;
let status: BriefsFeatureStatus;
let statusCache: StatusCache;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function seedBrief(over: Partial<CreateBriefInput> = {}): string {
  const id = over.id ?? `brf_${randomUUID()}`;
  createBrief(
    db,
    {
      id,
      createdByRun: "run_seed",
      kind: "loop",
      title: "Confirm the marathon entry went through",
      description: "The entry form looked submitted.",
      confidence: 0.7,
      urgency: 0.5,
      ...over,
    },
    1000,
  );
  return id;
}

function dismiss(id: string, body: unknown, token = ADMIN_TOKEN) {
  return app.request(`/briefs/${id}/dismiss`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function feed(token = ADMIN_TOKEN) {
  return app.request("/briefs/feed", { headers: { authorization: `Bearer ${token}` } });
}

function feedPage(query: string, token = ADMIN_TOKEN) {
  return app.request(`/briefs/feed?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function count(token = ADMIN_TOKEN) {
  return app.request("/briefs/count", { headers: { authorization: `Bearer ${token}` } });
}

function markRead(id: string, token = ADMIN_TOKEN) {
  return app.request(`/briefs/${id}/read`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

async function feedIds(): Promise<string[]> {
  const res = await feed();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { briefs: { id: string }[] };
  return body.briefs.map((b) => b.id);
}

function seedDoc(id: string, title: string): void {
  const iso = new Date(1000).toISOString();
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
       source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'test-provider', 'test-source', ?, ?, 'body', 'hash', ?, ?, ?, ?)`,
  ).run(id, id, title, iso, iso, iso, iso);
}

function loopsList(token = ADMIN_TOKEN) {
  return app.request("/loops", { headers: { authorization: `Bearer ${token}` } });
}

function loopsPage(query: string, token = ADMIN_TOKEN) {
  return app.request(`/loops?${query}`, { headers: { authorization: `Bearer ${token}` } });
}

function loopDetail(id: string, token = ADMIN_TOKEN) {
  return app.request(`/loops/${id}`, { headers: { authorization: `Bearer ${token}` } });
}

function loopDetailPage(id: string, query: string, token = ADMIN_TOKEN) {
  return app.request(`/loops/${id}?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function seedLoop(over: Partial<CreateOpenLoopInput> = {}, now = 1000): string {
  const id = over.id ?? `olp_${randomUUID()}`;
  createOpenLoop(
    db,
    {
      id,
      createdByRun: "run_seed",
      title: "Chase the venue deposit refund",
      description: "The refund was promised after the cancellation.",
      confidence: 0.8,
      importance: 0.6,
      ...over,
    },
    now,
  );
  return id;
}

function seedPerson(id: string, name: string): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, merged_into, source, is_self, first_seen, last_seen,
        created_at, updated_at)
     VALUES (?, ?, NULL, 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name);
}

/** Seed the user's own person row (is_self = 1, canonical) so `youAreActor` can resolve. */
function seedSelf(id: string, name: string): void {
  db.prepare(
    `INSERT INTO people (id, canonical_name, merged_into, source, is_self, first_seen, last_seen,
        created_at, updated_at)
     VALUES (?, ?, NULL, 'test', 1, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name);
}

/** A day entry on 2026-07-08 (created at t=1000) unless the override re-times it. */
function seedTemporalAnnotation(over: Partial<CreateTemporalAnnotationInput> = {}): string {
  const id = over.id ?? `ta_${randomUUID()}`;
  insertTemporalAnnotation(
    db,
    {
      id,
      intervalStartMs: Date.UTC(2026, 6, 8),
      intervalEndMs: Date.UTC(2026, 6, 9) - 1,
      precision: "day",
      canonical: "2026-07-08",
      sentence: "Travel insurance quote expires",
      kind: "expiry",
      documentIds: [],
      createdByRun: "run_seed",
      ...over,
    },
    1000,
  );
  return id;
}

// A window covering all of July 2026 — encloses every seeded entry.
const WINDOW_QS = `?from=${Date.UTC(2026, 6, 1)}&to=${Date.UTC(2026, 7, 1)}`;

function timeWindow(qs: string, token = ADMIN_TOKEN) {
  return app.request(`/briefs/time-index/window${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function temporalWindow(qs: string, token = ADMIN_TOKEN) {
  return app.request(`/briefs/temporal/window${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function canonicalTemporalAnnotationDetail(
  id: string,
  timeZone = "Europe/London",
  token = ADMIN_TOKEN,
) {
  return app.request(
    `/briefs/temporal/annotations/${encodeURIComponent(id)}?timeZone=${encodeURIComponent(timeZone)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
}

function temporalAnnotationDetail(id: string, token = ADMIN_TOKEN) {
  return app.request(`/briefs/time-index/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** An open loop whose deadline day passed long ago — due in any timezone. */
function seedDueLoop(id: string, state: "open" | "done" = "open"): void {
  createOpenLoop(
    db,
    {
      id,
      createdByRun: "run_seed",
      title: "Send back the signed rental form",
      confidence: 0.8,
      importance: 0.6,
      state,
      deadline: { type: "by", date: "2000-01-02" },
    },
    1000,
  );
}

beforeEach(() => {
  dbPath = `/tmp/omnesis-briefs-http-${randomUUID()}.db`;
  db = createDatabase(dbPath);
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN]);
  READ_TOKEN = mintToken([SCOPE_READ]);
  status = { visible: true, enabled: true, modelAssigned: true, active: true };
  app = createServer(db, dbPath, {
    getBriefsStatus: () => status,
    onStatusCache: (cache) => {
      statusCache = cache;
    },
  });
});

afterEach(() => {
  statusCache.stop();
  db.close();
  cleanupDb(dbPath);
});

describe("POST /briefs/:id/dismiss", () => {
  test("dismisses: flips the state durably and enqueues the feedback run before responding", async () => {
    const id = seedBrief();
    const res = await dismiss(id, { reason: "already_handled", feedback: "paid it yesterday" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; state: string; feedbackRunId: string };
    expect(body.ok).toBe(true);
    expect(body.state).toBe("dismissed_already_handled");

    const brief = getBrief(db, id)!;
    expect(brief.state).toBe("dismissed_already_handled");
    expect(brief.userFeedback).toBe("paid it yesterday");
    const run = db
      .prepare<
        [string],
        { kind: string; status: string; payload_json: string }
      >("SELECT kind, status, payload_json FROM cognition_runs WHERE id = ?")
      .get(body.feedbackRunId);
    expect(run).toMatchObject({ kind: "feedback", status: "pending" });
    expect(JSON.parse(run!.payload_json)).toEqual({ briefId: id });
  });

  test("a snooze forwards the ISO snoozeUntil into the feedback payload as unix ms", async () => {
    const id = seedBrief();
    const res = await dismiss(id, { reason: "snoozed", snoozeUntil: "2026-07-03T09:00:00.000Z" });
    expect(res.status).toBe(200);
    const { feedbackRunId } = (await res.json()) as { feedbackRunId: string };
    const run = db
      .prepare<
        [string],
        { payload_json: string }
      >("SELECT payload_json FROM cognition_runs WHERE id = ?")
      .get(feedbackRunId)!;
    expect(JSON.parse(run.payload_json)).toEqual({
      briefId: id,
      snoozeUntil: Date.parse("2026-07-03T09:00:00.000Z"),
    });
  });

  test("an agent-decided snooze queues its decision while the background model is parked", async () => {
    const id = seedBrief();
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    const res = await dismiss(id, { reason: "snoozed" });
    expect(res.status).toBe(200);
    const { feedbackRunId } = (await res.json()) as { feedbackRunId: string };
    expect(getBrief(db, id)?.state).toBe("dismissed_snoozed");
    expect(
      db
        .prepare<[string], { status: string }>("SELECT status FROM cognition_runs WHERE id = ?")
        .get(feedbackRunId),
    ).toEqual({ status: "pending" });
  });

  test("remains available without a runnable model and 404s when experimental mode is off", async () => {
    const id = seedBrief();
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    const parked = await dismiss(id, { reason: "wrong" });
    expect(parked.status).toBe(200);
    const { feedbackRunId } = (await parked.json()) as { feedbackRunId: string };
    expect(getBrief(db, id)?.state).toBe("dismissed_wrong");
    expect(
      db
        .prepare<[string], { status: string }>("SELECT status FROM cognition_runs WHERE id = ?")
        .get(feedbackRunId),
    ).toEqual({ status: "pending" });

    const disabledId = seedBrief();
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    expect((await dismiss(disabledId, { reason: "wrong" })).status).toBe(404);
    // No getter wired at all (a gateway built without the feature bag).
    const bare = createServer(db, dbPath, {});
    const res = await bare.request(`/briefs/${disabledId}/dismiss`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ reason: "wrong" }),
    });
    expect(res.status).toBe(404);
    expect(getBrief(db, disabledId)?.state).toBe("unread"); // nothing flipped
  });

  test("unknown brief → 404; terminal brief → 409; reason/kind mismatch → 400", async () => {
    expect((await dismiss("brf_missing", { reason: "wrong" })).status).toBe(404);

    const terminalId = seedBrief();
    await dismiss(terminalId, { reason: "wrong" });
    expect((await dismiss(terminalId, { reason: "not_relevant" })).status).toBe(409);

    const infoId = seedBrief({ kind: "info" });
    expect((await dismiss(infoId, { reason: "already_handled" })).status).toBe(400);
  });

  test("body validation: unknown reason and malformed snoozeUntil are 400s", async () => {
    const id = seedBrief();
    expect((await dismiss(id, { reason: "meh" })).status).toBe(400);
    expect((await dismiss(id, { reason: "snoozed", snoozeUntil: "someday" })).status).toBe(400);
    expect(getBrief(db, id)?.state).toBe("unread");
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    const id = seedBrief();
    expect((await dismiss(id, { reason: "wrong" }, READ_TOKEN)).status).toBe(403);
    const res = await app.request(`/briefs/${id}/dismiss`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "wrong" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /briefs/feed", () => {
  test("serves historical briefs without a runnable model and 404s when disabled", async () => {
    seedBrief();
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    const parked = await feed();
    expect(parked.status).toBe(200);
    const parkedBody = (await parked.json()) as { briefs: Array<{ title: string }> };
    expect(parkedBody.briefs).toEqual([
      expect.objectContaining({ title: "Confirm the marathon entry went through" }),
    ]);
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    expect((await feed()).status).toBe(404);
    const bare = createServer(db, dbPath, {});
    const res = await bare.request("/briefs/feed", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    expect((await feed(READ_TOKEN)).status).toBe(403);
    expect((await app.request("/briefs/feed")).status).toBe(401);
  });

  test("an empty feed is an empty array — the 'no briefs to show' state", async () => {
    const res = await feed();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      briefs: [],
      pageInfo: { hasMore: false, limit: 30 },
    });
  });

  test("paginates the full semantic rank with an opaque cursor", async () => {
    const now = Date.now();
    seedBrief({ id: "brf_ambient", kind: "info", urgency: 0.2 });
    seedBrief({ id: "brf_next", kind: "info", eventAt: now + 20 * 60 * 1000 });
    seedBrief({ id: "brf_loop", kind: "loop", urgency: 0.8 });
    seedBrief({ id: "brf_read", kind: "info", urgency: 1 });
    expect((await markRead("brf_read")).status).toBe(200);

    const first = await feedPage("limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      briefs: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; limit: number; nextCursor?: string };
    };
    expect(firstBody.briefs.map((brief) => brief.id)).toEqual(["brf_next", "brf_loop"]);
    expect(firstBody.pageInfo).toMatchObject({ hasMore: true, limit: 2 });
    expect(firstBody.pageInfo.nextCursor).toEqual(expect.any(String));

    const second = await feedPage(
      `limit=2&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor!)}`,
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      briefs: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; limit: number; nextCursor?: string };
    };
    expect(secondBody.briefs.map((brief) => brief.id)).toEqual(["brf_ambient", "brf_read"]);
    expect(secondBody.pageInfo).toEqual({ hasMore: false, limit: 2 });
    expect((await feedPage("limit=2&cursor=not-a-cursor")).status).toBe(400);
  });

  test("a page-boundary brief marked read mid-walk is returned exactly once", async () => {
    for (const id of ["brf_a", "brf_b", "brf_c", "brf_d", "brf_e"]) {
      seedBrief({ id, kind: "info", urgency: 0.5 });
    }

    const seen: string[] = [];
    const first = await feedPage("limit=2");
    const firstBody = (await first.json()) as {
      briefs: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    seen.push(...firstBody.briefs.map((brief) => brief.id));
    expect(seen).toEqual(["brf_a", "brf_b"]);
    expect(firstBody.pageInfo.hasMore).toBe(true);

    // The cursor's read high-water keeps this already-returned boundary row in
    // its original unread group for the rest of the walk. Without it, moving
    // to the read group would make the row eligible again on a later page.
    expect((await markRead("brf_b")).status).toBe(200);
    let cursor = firstBody.pageInfo.nextCursor;
    while (cursor) {
      const response = await feedPage(`limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        briefs: Array<{ id: string }>;
        pageInfo: { hasMore: boolean; nextCursor?: string };
      };
      seen.push(...body.briefs.map((brief) => brief.id));
      cursor = body.pageInfo.nextCursor;
      if (!body.pageInfo.hasMore) break;
    }

    expect(seen).toEqual(["brf_a", "brf_b", "brf_c", "brf_d", "brf_e"]);
    expect(new Set(seen)).toHaveLength(seen.length);
  });

  test("ranks tiers end-to-end: next-hour event, due loop, other loop, ambient info; read last", async () => {
    const now = Date.now();
    seedBrief({ id: "brf_ambient", kind: "info", urgency: 0.99, confidence: 0.99 });
    seedBrief({ id: "brf_next_hour", kind: "info", eventAt: now + 30 * 60 * 1000 });
    seedDueLoop("olp_due");
    seedBrief({ id: "brf_due_loop", kind: "loop", relatedLoopIds: ["olp_due"] });
    // A resolved loop's past deadline no longer summons a due reminder.
    seedDueLoop("olp_done", "done");
    seedBrief({ id: "brf_done_loop", kind: "loop", relatedLoopIds: ["olp_done"] });
    seedBrief({ id: "brf_read_ambient", kind: "info" });
    expect((await markRead("brf_read_ambient")).status).toBe(200);

    expect(await feedIds()).toEqual([
      "brf_next_hour",
      "brf_due_loop",
      "brf_done_loop",
      "brf_ambient",
      "brf_read_ambient",
    ]);
  });

  test("shows only unread/read with next_show null-or-past and relevance unexpired", async () => {
    const now = Date.now();
    seedBrief({ id: "brf_in" });
    seedBrief({ id: "brf_show_past", nextShow: now - 1000 });
    seedBrief({ id: "brf_show_future", nextShow: now + 60_000 });
    seedBrief({ id: "brf_expired", relevantUntil: now - 1000 });
    seedBrief({ id: "brf_snoozed" });
    await dismiss("brf_snoozed", { reason: "snoozed" });
    seedBrief({ id: "brf_terminal" });
    await dismiss("brf_terminal", { reason: "wrong" });

    expect((await feedIds()).sort()).toEqual(["brf_in", "brf_show_past"]);
  });

  test("serializes the brief with ISO timestamps and resolved citations, dangling ones dropped", async () => {
    const now = Date.now();
    seedDoc("doc_quote", "Quote from the venue");
    seedDoc("doc_thread", "Thread about the booking");
    seedBrief({
      id: "brf_1",
      kind: "info",
      body: "Longer context…",
      citations: ["doc_quote", "doc_vanished", "doc_thread"],
      eventAt: now + 30 * 60 * 1000,
      relevantUntil: now + 60 * 60 * 1000,
    });

    const res = await feed();
    const { briefs } = (await res.json()) as { briefs: Record<string, unknown>[] };
    expect(briefs).toHaveLength(1);
    const b = briefs[0]!;
    expect(b).toMatchObject({
      id: "brf_1",
      kind: "info",
      state: "unread",
      title: "Confirm the marathon entry went through",
      description: "The entry form looked submitted.",
      body: "Longer context…",
      confidence: 0.7,
      urgency: 0.5,
      createdAt: new Date(1000).toISOString(),
      eventAt: new Date(now + 30 * 60 * 1000).toISOString(),
      relevantUntil: new Date(now + 60 * 60 * 1000).toISOString(),
    });
    expect(b.citations).toEqual([
      {
        docId: "doc_quote",
        title: "Quote from the venue",
        providerId: "test-provider",
        sourceId: "test-source",
      },
      {
        docId: "doc_thread",
        title: "Thread about the booking",
        providerId: "test-provider",
        sourceId: "test-source",
      },
    ]);
  });
});

describe("POST /briefs/:id/thread", () => {
  function openThreadReq(id: string, token = ADMIN_TOKEN) {
    return app.request(`/briefs/${id}/thread`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  test("404s when no talkback port is wired (feature booted without it)", async () => {
    const id = seedBrief();
    const res = await openThreadReq(id);
    expect(res.status).toBe(404);
  });

  test("opens a thread through the port and returns its conversation id", async () => {
    const opened: string[] = [];
    app = createServer(db, dbPath, {
      getBriefsStatus: () => status,
      getBriefTalkback: () => ({
        // eslint-disable-next-line @typescript-eslint/require-await
        async openThread(callerId, briefId) {
          opened.push(`${callerId}:${briefId}`);
          return { conversationId: "s_thread_1", created: true };
        },
      }),
    });
    const id = seedBrief();
    const res = await openThreadReq(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ conversationId: "s_thread_1", created: true });
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(`:${id}`);
  });

  test("maps unknown-brief and unavailable errors to 404/409, and 404s when inactive", async () => {
    const { BriefNotFoundError, TalkbackUnavailableError } =
      await import("./talkback/talkback-service.js");
    app = createServer(db, dbPath, {
      getBriefsStatus: () => status,
      getBriefTalkback: () => ({
        // eslint-disable-next-line @typescript-eslint/require-await
        async openThread(_callerId, briefId) {
          if (briefId === "brief_missing") throw new BriefNotFoundError("nope");
          throw new TalkbackUnavailableError("agent harness disabled");
        },
      }),
    });
    expect((await openThreadReq("brief_missing")).status).toBe(404);
    expect((await openThreadReq("brief_other")).status).toBe(409);
    // Pin the gate with the 409 id — a missing id 404s either way.
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    expect((await openThreadReq("brief_other")).status).toBe(404);
  });
});

describe("GET /briefs/count", () => {
  test("counts historical briefs without a runnable model and 404s when disabled", async () => {
    seedBrief();
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    const parked = await count();
    expect(parked.status).toBe(200);
    expect(await parked.json()).toEqual({ unread: 1 });
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    expect((await count()).status).toBe(404);
    const bare = createServer(db, dbPath, {});
    const res = await bare.request("/briefs/count", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    expect((await count(READ_TOKEN)).status).toBe(403);
    expect((await app.request("/briefs/count")).status).toBe(401);
  });

  test("zero when there are no briefs", async () => {
    const res = await count();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unread: 0 });
  });

  test("counts only showable UNREAD briefs — the drawer badge's subset", async () => {
    const now = Date.now();
    // Counted: unread, showable now.
    seedBrief({ id: "brf_in" });
    seedBrief({ id: "brf_show_past", nextShow: now - 1000 });
    // Not counted: read (already seen).
    seedBrief({ id: "brf_read" });
    expect((await markRead("brf_read")).status).toBe(200);
    // Not counted: snoozed / not-yet-due / expired / terminally dismissed.
    seedBrief({ id: "brf_show_future", nextShow: now + 60_000 });
    seedBrief({ id: "brf_expired", relevantUntil: now - 1000 });
    seedBrief({ id: "brf_snoozed" });
    await dismiss("brf_snoozed", { reason: "snoozed" });
    seedBrief({ id: "brf_terminal" });
    await dismiss("brf_terminal", { reason: "wrong" });

    const res = await count();
    expect(res.status).toBe(200);
    // brf_in + brf_show_past only — exactly the feed's showable subset
    // narrowed to unread (read ones excluded).
    expect(await res.json()).toEqual({ unread: 2 });
  });
});

describe("GET /loops", () => {
  test("404s when the feature is inactive — either prong (inert-when-off)", async () => {
    seedLoop();
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    expect((await loopsList()).status).toBe(404);
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    expect((await loopsList()).status).toBe(404);
    const bare = createServer(db, dbPath, {});
    const res = await bare.request("/loops", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    expect((await loopsList(READ_TOKEN)).status).toBe(403);
    expect((await app.request("/loops")).status).toBe(401);
  });

  test("no loops is an empty array", async () => {
    const res = await loopsList();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      loops: [],
      pageInfo: { hasMore: false, limit: 50 },
    });
  });

  test("filters active/resolved and keyset-paginates the complete importance order", async () => {
    seedLoop({ id: "olp_active_high", importance: 0.9 }, 1000);
    seedLoop({ id: "olp_active_tie_b", importance: 0.5 }, 2000);
    seedLoop({ id: "olp_active_tie_a", importance: 0.5 }, 2000);
    seedLoop({ id: "olp_snoozed", state: "snoozed", importance: 0.2 }, 4000);
    seedLoop({ id: "olp_done", state: "done", importance: 0.8 }, 3000);
    seedLoop({ id: "olp_dismissed", state: "dismissed", importance: 0.4 }, 5000);

    const first = await loopsPage("state=active&limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      loops: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; limit: number; nextCursor?: string };
    };
    expect(firstBody.loops.map((loop) => loop.id)).toEqual(["olp_active_high", "olp_active_tie_b"]);
    expect(firstBody.pageInfo).toMatchObject({ hasMore: true, limit: 2 });

    const second = await loopsPage(
      `state=active&limit=2&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor!)}`,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      loops: [{ id: "olp_active_tie_a" }, { id: "olp_snoozed" }],
      pageInfo: { hasMore: false, limit: 2 },
    });

    const resolved = await loopsPage("state=resolved&limit=50");
    expect(resolved.status).toBe(200);
    expect(
      ((await resolved.json()) as { loops: Array<{ id: string }> }).loops.map((loop) => loop.id),
    ).toEqual(["olp_done", "olp_dismissed"]);

    expect(
      (
        await loopsPage(
          `state=resolved&limit=2&cursor=${encodeURIComponent(firstBody.pageInfo.nextCursor!)}`,
        )
      ).status,
    ).toBe(400);
    expect((await loopsPage("state=unknown")).status).toBe(400);
  });

  test("rejects only relevant stale cursors so clients can reset the page walk", async () => {
    seedLoop({ id: "olp_first", importance: 0.9 }, 1000);
    seedLoop({ id: "olp_second", importance: 0.8 }, 2000);
    const first = (await (await loopsPage("limit=1")).json()) as {
      pageInfo: { nextCursor: string };
    };

    // An unrelated gateway write must not invalidate this surface.
    db.prepare("UPDATE devices SET name = name").run();
    expect(
      (await loopsPage(`limit=1&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status,
    ).toBe(200);

    updateOpenLoop(db, "olp_second", { importance: 0.95 }, 3000);
    const stale = await loopsPage(
      `limit=1&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "STALE_PAGE_CURSOR" });
  });

  test("ranks by importance, ties breaking most-recently-updated first", async () => {
    seedLoop({ id: "olp_low", importance: 0.2 }, 3000); // newest, least important
    seedLoop({ id: "olp_high", importance: 0.9 }, 1000); // oldest, most important
    seedLoop({ id: "olp_mid", importance: 0.5 }, 2000);
    seedLoop({ id: "olp_tie", importance: 0.5 }, 2500); // ties olp_mid on importance

    const res = await loopsList();
    expect(res.status).toBe(200);
    const { loops } = (await res.json()) as { loops: Record<string, unknown>[] };
    // importance DESC, then last_update DESC among equal-importance loops.
    expect(loops.map((l) => l.id)).toEqual(["olp_high", "olp_tie", "olp_mid", "olp_low"]);
  });

  test("surfaces the Radar signals: importance, actors (with isSelf), involved, blockedBy", async () => {
    seedSelf("per_self", "You");
    seedPerson("per_maya", "Maya Reeves");
    const blocker = seedLoop(
      { id: "olp_blocker", title: "Get the catering quote", importance: 0.4 },
      1000,
    );
    seedLoop(
      {
        id: "olp_main",
        importance: 0.7,
        actors: ["per_self"],
        involved: ["per_maya"],
        blockedBy: [blocker, "olp_gone"], // olp_gone never existed → dropped
        deadline: { type: "by", date: "2026-08-01" },
      },
      2000,
    );

    const { loops } = (await (await loopsList()).json()) as { loops: Record<string, unknown>[] };
    const main = loops.find((l) => l.id === "olp_main")!;
    expect(main).toMatchObject({
      importance: 0.7,
      actors: [{ id: "per_self", name: "You", isSelf: true }],
      involved: [{ id: "per_maya", name: "Maya Reeves" }],
      // Only the surviving blocker is surfaced; the non-existent id is dropped.
      blockedBy: [{ id: "olp_blocker", title: "Get the catering quote" }],
    });
    // Full product DTO shape — no engine bookkeeping leaks.
    expect(Object.keys(main).sort()).toEqual([
      "actors",
      "blockedBy",
      "createdAt",
      "deadline",
      "description",
      "id",
      "importance",
      "involved",
      "lastUpdate",
      "state",
      "title",
    ]);
  });

  test("a loop whose actors are all other people is not flagged isSelf", async () => {
    seedSelf("per_self", "You");
    seedPerson("per_maya", "Maya Reeves");
    seedLoop({ id: "olp_waiting", actors: ["per_maya"] });
    const { loops } = (await (await loopsList()).json()) as { loops: Record<string, unknown>[] };
    const waiting = loops.find((l) => l.id === "olp_waiting")!;
    expect(waiting.actors).toEqual([{ id: "per_maya", name: "Maya Reeves", isSelf: false }]);
  });

  test("a resolved (done) blocker no longer blocks — only active blockers survive in blockedBy", async () => {
    const doneBlocker = seedLoop({ id: "olp_done_blk", state: "done", title: "Old blocker" }, 1000);
    const activeBlocker = seedLoop({ id: "olp_active_blk", title: "Get the catering quote" }, 1000);
    seedLoop(
      { id: "olp_blocked", blockedBy: [doneBlocker, activeBlocker, "olp_never_existed"] },
      2000,
    );

    const { loops } = (await (await loopsList()).json()) as { loops: Record<string, unknown>[] };
    const blocked = loops.find((l) => l.id === "olp_blocked")!;
    // The done blocker and the missing id are dropped; only the still-active
    // one keeps the loop blocked.
    expect(blocked.blockedBy).toEqual([{ id: "olp_active_blk", title: "Get the catering quote" }]);
  });
});

describe("GET /loops/:id", () => {
  test("404s: unknown loop, and inert-when-off on both prongs", async () => {
    expect((await loopDetail("olp_missing")).status).toBe(404);
    const id = seedLoop();
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    expect((await loopDetail(id)).status).toBe(404);
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    expect((await loopDetail(id)).status).toBe(404);
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    const id = seedLoop();
    expect((await loopDetail(id, READ_TOKEN)).status).toBe(403);
    expect((await app.request(`/loops/${id}`)).status).toBe(401);
  });

  test("enriches actors (with isSelf) / involved to { id, name }; an unresolvable ref keeps name null", async () => {
    seedSelf("per_self", "You");
    seedPerson("per_maya", "Maya Reeves");
    seedPerson("per_jamie", "Jamie Lopez");
    const id = seedLoop({
      actors: ["per_self", "per_maya"],
      involved: ["per_jamie", "ghost@example.com"],
    });

    const res = await loopDetail(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { loop: Record<string, unknown> };
    expect(body.loop.actors).toEqual([
      { id: "per_self", name: "You", isSelf: true },
      { id: "per_maya", name: "Maya Reeves", isSelf: false },
    ]);
    expect(body.loop.involved).toEqual([
      { id: "per_jamie", name: "Jamie Lopez" },
      { id: "ghost@example.com", name: null },
    ]);
    expect(Object.keys(body.loop).sort()).toEqual([
      "actors",
      "blockedBy",
      "createdAt",
      "deadline",
      "description",
      "id",
      "importance",
      "involved",
      "lastUpdate",
      "state",
      "title",
    ]);
  });

  test("returns the ledger newest note first, without run internals", async () => {
    const id = seedLoop();
    appendOpenLoopLedger(db, id, { runId: "run_a", note: "Asked for the refund status." }, 2000);
    appendOpenLoopLedger(db, id, { runId: "run_b", note: "They promised it this week." }, 3000);

    const res = await loopDetail(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ledger: Record<string, unknown>[];
      ledgerTruncated: boolean;
    };
    expect(body.ledger).toEqual([
      { seq: 2, at: new Date(3000).toISOString(), note: "They promised it this week." },
      { seq: 1, at: new Date(2000).toISOString(), note: "Asked for the refund status." },
    ]);
    expect(body.ledgerTruncated).toBe(false);
  });

  test("bounds the legacy ledger and lets callers omit it", async () => {
    const id = seedLoop();
    for (let seq = 1; seq <= 51; seq += 1) {
      appendOpenLoopLedger(
        db,
        id,
        { runId: `run_${seq}`, note: `Status check ${seq}.` },
        1000 + seq,
      );
    }

    const legacy = await loopDetail(id);
    expect(legacy.status).toBe(200);
    const legacyBody = (await legacy.json()) as {
      ledger: Array<{ seq: number }>;
      ledgerTruncated: boolean;
    };
    expect(legacyBody.ledger).toHaveLength(50);
    expect(legacyBody.ledger[0]?.seq).toBe(51);
    expect(legacyBody.ledger.at(-1)?.seq).toBe(2);
    expect(legacyBody.ledgerTruncated).toBe(true);

    const compact = await loopDetailPage(id, "includeChildren=0");
    expect(compact.status).toBe(200);
    const compactBody = (await compact.json()) as Record<string, unknown>;
    expect(compactBody).not.toHaveProperty("ledger");
    expect(compactBody).not.toHaveProperty("ledgerTruncated");
  });
});

describe("POST /briefs/:id/read", () => {
  test("flips unread → read durably; idempotent on repeat", async () => {
    const id = seedBrief();
    const res = await markRead(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, state: "read" });
    expect(getBrief(db, id)?.state).toBe("read");
    const again = await markRead(id);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, state: "read" });
  });

  test("unknown brief → 404; dismissed brief → 409", async () => {
    expect((await markRead("brf_missing")).status).toBe(404);
    const id = seedBrief();
    await dismiss(id, { reason: "wrong" });
    expect((await markRead(id)).status).toBe(409);
    expect(getBrief(db, id)?.state).toBe("dismissed_wrong");
  });

  test("works without a runnable model and 404s when experimental mode is off", async () => {
    const id = seedBrief();
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    expect((await markRead(id)).status).toBe(200);
    expect(getBrief(db, id)?.state).toBe("read");

    const disabledId = seedBrief();
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    expect((await markRead(disabledId)).status).toBe(404);
    expect(getBrief(db, disabledId)?.state).toBe("unread");
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    const id = seedBrief();
    expect((await markRead(id, READ_TOKEN)).status).toBe(403);
    expect((await app.request(`/briefs/${id}/read`, { method: "POST" })).status).toBe(401);
  });
});

describe("GET /briefs/time-index/window", () => {
  test("404s when the feature is inactive — either prong (inert-when-off)", async () => {
    seedTemporalAnnotation();
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    expect((await timeWindow(WINDOW_QS)).status).toBe(404);
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    expect((await timeWindow(WINDOW_QS)).status).toBe(404);
    const bare = createServer(db, dbPath, {});
    const res = await bare.request(`/briefs/time-index/window${WINDOW_QS}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    expect((await timeWindow(WINDOW_QS, READ_TOKEN)).status).toBe(403);
    expect((await app.request(`/briefs/time-index/window${WINDOW_QS}`)).status).toBe(401);
  });

  test("400s: missing/non-integer from/to, from > to, over-wide span, too many kinds", async () => {
    const from = Date.UTC(2026, 6, 1);
    const to = Date.UTC(2026, 7, 1);
    expect((await timeWindow(`?to=${to}`)).status).toBe(400); // missing from
    expect((await timeWindow(`?from=${from}`)).status).toBe(400); // missing to
    expect((await timeWindow(`?from=&to=${to}`)).status).toBe(400); // empty string
    expect((await timeWindow(`?from=%20&to=${to}`)).status).toBe(400); // whitespace only
    expect((await timeWindow(`?from=abc&to=${to}`)).status).toBe(400); // non-numeric
    expect((await timeWindow(`?from=1.5&to=${to}`)).status).toBe(400); // non-integer
    expect((await timeWindow(`?from=${to}&to=${from}`)).status).toBe(400); // inverted
    expect(
      (await timeWindow(`?from=0&to=${TEMPORAL_ANNOTATION_WINDOW_MAX_SPAN_MS + 1}`)).status,
    ).toBe(400);
    // Exactly the max span is still a valid window.
    expect((await timeWindow(`?from=0&to=${TEMPORAL_ANNOTATION_WINDOW_MAX_SPAN_MS}`)).status).toBe(
      200,
    );
    const thirteen = Array.from({ length: 13 }, (_, i) => `k${i}`).join(",");
    expect((await timeWindow(`${WINDOW_QS}&kinds=${thirteen}`)).status).toBe(400);
    // limit: junk, zero, and over-cap all 400; the bounds are valid.
    expect((await timeWindow(`${WINDOW_QS}&limit=abc`)).status).toBe(400);
    expect((await timeWindow(`${WINDOW_QS}&limit=0`)).status).toBe(400);
    expect((await timeWindow(`${WINDOW_QS}&limit=501`)).status).toBe(400);
    expect((await timeWindow(`${WINDOW_QS}&limit=1`)).status).toBe(200);
    expect((await timeWindow(`${WINDOW_QS}&limit=500`)).status).toBe(200);
  });

  test("an empty window is nowMs + truncated:false + an empty entries array", async () => {
    const res = await timeWindow(WINDOW_QS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nowMs: number; truncated: boolean; entries: unknown[] };
    expect(typeof body.nowMs).toBe("number");
    expect(body.truncated).toBe(false);
    expect(body.entries).toEqual([]);
  });

  test("limit caps the page and truncation is signalled, never silent", async () => {
    seedTemporalAnnotation({ id: "tix_a" });
    seedTemporalAnnotation({ id: "tix_b" });
    seedTemporalAnnotation({ id: "tix_c" });
    const res = await timeWindow(`${WINDOW_QS}&limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { truncated: boolean; entries: { id: string }[] };
    expect(body.entries).toHaveLength(2);
    expect(body.truncated).toBe(true);
    // A limit exactly matching the window's population is not truncation.
    const exact = (await (await timeWindow(`${WINDOW_QS}&limit=3`)).json()) as {
      truncated: boolean;
      entries: unknown[];
    };
    expect(exact.entries).toHaveLength(3);
    expect(exact.truncated).toBe(false);
  });

  test("an empty kinds param filters nothing (all kinds returned)", async () => {
    seedTemporalAnnotation({ id: "tix_deadline", kind: "deadline" });
    seedTemporalAnnotation({ id: "tix_nokind", kind: null });
    const res = await timeWindow(`${WINDOW_QS}&kinds=`);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { id: string }[] };
    expect(entries.map((e) => e.id).sort()).toEqual(["tix_deadline", "tix_nokind"]);
  });

  test("serializes entries with ISO created/updated stamps and resolved documents", async () => {
    seedDoc("doc_policy", "Insurance policy renewal");
    seedTemporalAnnotation({ id: "tix_1", documentIds: ["doc_policy"] });
    const res = await timeWindow(WINDOW_QS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { nowMs: number; entries: unknown[] };
    // Deep-equal pins the whole DTO — internals like createdByRun and the
    // raw documentIds must not leak.
    expect(body.entries).toEqual([
      {
        id: "tix_1",
        intervalStartMs: Date.UTC(2026, 6, 8),
        intervalEndMs: Date.UTC(2026, 6, 9) - 1,
        granularity: "day",
        canonical: "2026-07-08",
        sentence: "Travel insurance quote expires",
        kind: "expiry",
        createdAt: new Date(1000).toISOString(),
        updatedAt: new Date(1000).toISOString(),
        documents: [
          {
            docId: "doc_policy",
            title: "Insurance policy renewal",
            providerId: "test-provider",
            sourceId: "test-source",
          },
        ],
      },
    ]);
  });

  test("kinds filters end-to-end (CSV, whitespace tolerated)", async () => {
    seedTemporalAnnotation({ id: "tix_deadline", kind: "deadline" });
    seedTemporalAnnotation({ id: "tix_event", kind: "event" });
    seedTemporalAnnotation({ id: "tix_expiry", kind: "expiry" });
    const res = await timeWindow(`${WINDOW_QS}&kinds=deadline,%20expiry`);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { id: string }[] };
    expect(entries.map((e) => e.id).sort()).toEqual(["tix_deadline", "tix_expiry"]);
  });

  test("a linked document that no longer exists is dropped, not rendered dead", async () => {
    seedDoc("doc_gone", "Vanishing confirmation");
    seedTemporalAnnotation({ id: "tix_orphan", documentIds: ["doc_gone"] });
    db.prepare("DELETE FROM documents WHERE id = ?").run("doc_gone");
    const res = await timeWindow(WINDOW_QS);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as { entries: { id: string; documents: unknown[] }[] };
    expect(entries.map((e) => e.id)).toEqual(["tix_orphan"]);
    expect(entries[0]!.documents).toEqual([]);
  });
});

describe("GET /briefs/temporal/window", () => {
  const temporalQs = `${WINDOW_QS}&timeZone=Europe%2FLondon`;

  function seedDocumentProjection(): string {
    const id = "tp_document_scheduled";
    seedDoc("doc_scheduled", "Northstar planning session");
    db.prepare(
      `INSERT INTO document_temporal_projections (
         id, source_id, document_id, document_external_id, slot,
         start_ms, end_exclusive_ms, start_canonical, end_canonical,
         precision, all_day, time_zone, label, kind, modality, status,
         source_updated_at, projected_at
       ) VALUES (?, 'test-source', 'doc_scheduled', 'doc_scheduled', 'scheduled',
         ?, ?, '2026-07-07T08:00:00.000Z', '2026-07-07T09:00:00.000Z',
         'instant', 0, 'Europe/London', 'Northstar planning session',
         'event', 'scheduled', 'active', '2026-07-01T00:00:00.000Z',
         '2026-07-01T00:00:01.000Z')`,
    ).run(id, Date.UTC(2026, 6, 7, 8), Date.UTC(2026, 6, 7, 9));
    return id;
  }

  test("returns projections and annotations in one chronological provenance-rich page", async () => {
    const projectionId = seedDocumentProjection();
    const annotationId = seedTemporalAnnotation({ id: "ta_interpretation" });
    const res = await temporalWindow(temporalQs);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nowMs: number;
      window: { start: string; endExclusive: string; timeZone: string };
      items: Array<Record<string, unknown>>;
      coverage: { annotations: { selective: boolean } };
      truncated: boolean;
    };
    expect(body.items.map((item) => item.id)).toEqual([projectionId, annotationId]);
    expect(body.items[0]).toMatchObject({
      origin: "projection",
      label: "Northstar planning session",
      projection: {
        sourceId: "test-source",
        documentId: "doc_scheduled",
        slot: "scheduled",
      },
    });
    expect(body.items[1]).toMatchObject({
      origin: "annotation",
      label: "Travel insurance quote expires",
      annotation: { projectionIds: [], revision: 1 },
    });
    expect(body.coverage.annotations.selective).toBe(true);
    expect(body.window).toEqual({
      start: new Date(Date.UTC(2026, 6, 1)).toISOString(),
      endExclusive: new Date(Date.UTC(2026, 7, 1)).toISOString(),
      timeZone: "Europe/London",
    });
    expect(body.truncated).toBe(false);
    expect(typeof body.nowMs).toBe("number");
  });

  test("filters by origin and paginates with an opaque query-bound cursor", async () => {
    seedDocumentProjection();
    seedTemporalAnnotation({ id: "ta_a" });
    seedTemporalAnnotation({
      id: "ta_b",
      intervalStartMs: Date.UTC(2026, 6, 9),
      intervalEndMs: Date.UTC(2026, 6, 10) - 1,
      canonical: "2026-07-09",
    });
    const first = await temporalWindow(`${temporalQs}&origins=annotation&limit=1`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: Array<{ id: string; origin: string }>;
      truncated: boolean;
      nextCursor: string;
    };
    expect(firstBody.items).toEqual([{ ...firstBody.items[0], id: "ta_a", origin: "annotation" }]);
    expect(firstBody.truncated).toBe(true);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await temporalWindow(
      `${temporalQs}&origins=annotation&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      items: [{ id: "ta_b", origin: "annotation" }],
      truncated: false,
    });

    const mismatched = await temporalWindow(
      `${temporalQs}&origins=projection&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    );
    expect(mismatched.status).toBe(400);
  });

  test("accepts a retired kind spelling and filters on the canonical one", async () => {
    const projectionId = seedDocumentProjection();

    const canonical = await temporalWindow(`${temporalQs}&kinds=event`);
    expect(canonical.status).toBe(200);
    expect((await canonical.json()) as { items: Array<{ id: string }> }).toMatchObject({
      items: [{ id: projectionId }],
    });

    // `calendar_event` resolves to `appointment`, so an older client's filter is
    // honoured rather than rejected — and matches no `event` row.
    const retired = await temporalWindow(`${temporalQs}&kinds=calendar_event`);
    expect(retired.status).toBe(200);
    expect(((await retired.json()) as { items: unknown[] }).items).toEqual([]);

    expect((await temporalWindow(`${temporalQs}&kinds=not_a_kind`)).status).toBe(400);
  });

  test("reports a failure of its own as a sanitized 500, not as a bad request", async () => {
    // A store the route cannot read is the gateway's failure, not the caller's.
    // The vocabulary columns carry CHECK constraints, so a value outside the
    // vocabulary cannot be inserted; removing the table is the reachable way to
    // make the read fail.
    db.exec("DROP TABLE document_temporal_projections");

    const res = await temporalWindow(temporalQs);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; code: string };
    expect(body).toMatchObject({ code: "INTERNAL_ERROR" });
    // A 400 echoes the thrown message verbatim; the SQLite failure names the
    // table, and the client must never see it.
    expect(JSON.stringify(body)).not.toMatch(/document_temporal_projections/);
  });

  test("validates the canonical contract, feature gate, and admin scope", async () => {
    expect((await temporalWindow(WINDOW_QS)).status).toBe(400);
    expect((await temporalWindow(`${WINDOW_QS}&timeZone=Not%2FAZone`)).status).toBe(400);
    expect((await temporalWindow(`${temporalQs}&origins=projection,wrong`)).status).toBe(400);
    expect((await temporalWindow(`${temporalQs}&limit=101`)).status).toBe(400);
    expect((await temporalWindow(temporalQs, READ_TOKEN)).status).toBe(403);
    expect((await app.request(`/briefs/temporal/window${temporalQs}`)).status).toBe(401);
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    expect((await temporalWindow(temporalQs)).status).toBe(200);
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    expect((await temporalWindow(temporalQs)).status).toBe(404);
  });

  test("resolves an addressable annotation in the requested timezone outside any UI window", async () => {
    const id = seedTemporalAnnotation({ id: "ta_addressable", canonical: "2026-07-08" });
    const res = await canonicalTemporalAnnotationDetail(id, "America/Los_Angeles");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      item: {
        id,
        origin: "annotation",
        start: "2026-07-08T07:00:00.000Z",
        endExclusive: "2026-07-09T07:00:00.000Z",
        timeZone: "America/Los_Angeles",
        label: "Travel insurance quote expires",
        annotation: { revision: 1 },
      },
    });
  });

  test("guards canonical annotation detail by visibility, timezone, scope, and existence", async () => {
    const id = seedTemporalAnnotation({ id: "ta_detail_guard" });
    expect((await canonicalTemporalAnnotationDetail(id, "Not/AZone")).status).toBe(400);
    expect((await canonicalTemporalAnnotationDetail("ta_missing")).status).toBe(404);
    expect((await canonicalTemporalAnnotationDetail(id, "UTC", READ_TOKEN)).status).toBe(403);
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    expect((await canonicalTemporalAnnotationDetail(id)).status).toBe(200);
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    expect((await canonicalTemporalAnnotationDetail(id)).status).toBe(404);
  });
});

describe("GET /briefs/time-index/:id", () => {
  test("returns the single entry in the window's DTO shape", async () => {
    seedDoc("doc_policy", "Insurance policy renewal");
    seedTemporalAnnotation({ id: "tix_one", documentIds: ["doc_policy"] });
    const res = await temporalAnnotationDetail("tix_one");
    expect(res.status).toBe(200);
    const { entry } = (await res.json()) as { entry: Record<string, unknown> };
    expect(entry).toMatchObject({
      id: "tix_one",
      sentence: "Travel insurance quote expires",
      kind: "expiry",
      createdAt: new Date(1000).toISOString(),
      updatedAt: new Date(1000).toISOString(),
    });
    expect(entry.documents).toEqual([
      {
        docId: "doc_policy",
        title: "Insurance policy renewal",
        providerId: "test-provider",
        sourceId: "test-source",
      },
    ]);
  });

  test("404s for an unknown or invalidated entry", async () => {
    const res = await temporalAnnotationDetail("tix_missing");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("Temporal annotation not found");
    const id = seedTemporalAnnotation();
    invalidateTemporalAnnotation(db, id, 2000);
    expect((await temporalAnnotationDetail(id)).status).toBe(404);
  });

  test("404s when the feature is inactive — either prong (inert-when-off)", async () => {
    const id = seedTemporalAnnotation();
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    expect((await temporalAnnotationDetail(id)).status).toBe(404);
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    expect((await temporalAnnotationDetail(id)).status).toBe(404);
    const bare = createServer(db, dbPath, {});
    const res = await bare.request(`/briefs/time-index/${id}`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    const id = seedTemporalAnnotation();
    expect((await temporalAnnotationDetail(id, READ_TOKEN)).status).toBe(403);
    expect((await app.request(`/briefs/time-index/${id}`)).status).toBe(401);
  });
});

describe("removed temporal-annotation talkback routes", () => {
  test("canonical and legacy thread endpoints are absent", async () => {
    const id = seedTemporalAnnotation();
    for (const route of [
      `/briefs/temporal/annotations/${id}/thread`,
      `/briefs/time-index/${id}/thread`,
    ]) {
      const response = await app.request(route, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(response.status).toBe(404);
    }
  });
});
