// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for the `/loops*` reads and the unified temporal
 * window plus annotation reads. The suite asserts the disabled-feature
 * gate, the auth scope, and each response contract, and that the retired
 * brief routes are not mounted.
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
  type CreateTemporalAnnotationInput,
} from "../enrichment/temporal-annotations/storage.js";
import {
  appendOpenLoopLedger,
  createOpenLoop,
  updateOpenLoop,
  type CreateOpenLoopInput,
} from "./storage/open-loops.js";
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

function temporalWindow(qs: string, token = ADMIN_TOKEN) {
  return app.request(`/temporal/window${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function canonicalTemporalAnnotationDetail(
  id: string,
  timeZone = "Europe/London",
  token = ADMIN_TOKEN,
) {
  return app.request(
    `/temporal/annotations/${encodeURIComponent(id)}?timeZone=${encodeURIComponent(timeZone)}`,
    { headers: { authorization: `Bearer ${token}` } },
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

describe("GET /temporal/window", () => {
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

  test("validates the canonical contract and admin scope, whatever the Brain's state", async () => {
    expect((await temporalWindow(WINDOW_QS)).status).toBe(400);
    expect((await temporalWindow(`${WINDOW_QS}&timeZone=Not%2FAZone`)).status).toBe(400);
    expect((await temporalWindow(`${temporalQs}&origins=projection,wrong`)).status).toBe(400);
    expect((await temporalWindow(`${temporalQs}&limit=101`)).status).toBe(400);
    expect((await temporalWindow(temporalQs, READ_TOKEN)).status).toBe(403);
    expect((await app.request(`/temporal/window${temporalQs}`)).status).toBe(401);
    // The time index exists without the Brain: served when it is hidden too.
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    expect((await temporalWindow(temporalQs)).status).toBe(200);
    status = { visible: false, enabled: false, modelAssigned: false, active: false };
    expect((await temporalWindow(temporalQs)).status).toBe(200);
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

  test("guards canonical annotation detail by timezone, scope, and existence", async () => {
    const id = seedTemporalAnnotation({ id: "ta_detail_guard" });
    expect((await canonicalTemporalAnnotationDetail(id, "Not/AZone")).status).toBe(400);
    expect((await canonicalTemporalAnnotationDetail("ta_missing")).status).toBe(404);
    expect((await canonicalTemporalAnnotationDetail(id, "UTC", READ_TOKEN)).status).toBe(403);
    status = { visible: false, enabled: false, modelAssigned: false, active: false };
    expect((await canonicalTemporalAnnotationDetail(id)).status).toBe(200);
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

describe("removed brief routes", () => {
  test("the brief feed, count, read, dismiss and thread endpoints are absent", async () => {
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
    for (const route of ["/briefs/feed", "/briefs/count"]) {
      expect((await app.request(route, { headers })).status).toBe(404);
    }
    for (const action of ["read", "dismiss", "thread"]) {
      const response = await app.request(`/briefs/brf_missing/${action}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ reason: "wrong" }),
      });
      expect(response.status).toBe(404);
    }
  });
});
