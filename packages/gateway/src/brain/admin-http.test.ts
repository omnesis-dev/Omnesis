// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * HTTP-level coverage for the /admin/brain operator surface: loops
 * list/show, run list/show, transcript access, the per-datum decision
 * view, daily spend, and the agent-notes print/wipe. Every route
 * asserts the visibility gate (404 whenever the feature is hidden) and
 * the admin scope; reads additionally prove stored history stays
 * servable while visible-but-inactive, writes prove they stay 404 there;
 * the wipe additionally proves the write lands durably through the
 * write gate.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { SCOPE_ADMIN, SCOPE_READ, type Scope } from "@omnesis/types";
import { createDatabase } from "../db.js";
import { createServer } from "../server.js";
import { createToken } from "../data/repositories/TokenRepository.js";
import { createDevice } from "../data/repositories/DeviceRepository.js";
import { insertTemporalAnnotation } from "../enrichment/temporal-annotations/storage.js";
import { recordRunAttribution } from "./storage/run-attribution.js";
import { createMutableClock } from "./virtual-clock.js";
import { createBrief } from "./storage/briefs.js";
import { cascadeBriefClaimPrivacyDelete } from "./storage/brief-claims.js";
import { appendOpenLoopLedger, createOpenLoop, updateOpenLoop } from "./storage/open-loops.js";
import { writeCognitionNotes, readCognitionNotes } from "./storage/notes.js";
import { cognitionSpendDay, recordCognitionSpend } from "./storage/spend.js";
import { recordCognitionCoverage } from "./storage/coverage.js";
import { setCognitionEngineState } from "./storage/engine-state.js";
import {
  completeCognitionRun,
  enqueueCognitionRun,
  claimDueCognitionRuns,
  recordSettledCognitionRun,
} from "./storage/run-queue.js";
import {
  FsCognitionTranscriptStore,
  cognitionTranscriptsDir,
  type CognitionRunTranscript,
} from "./transcripts.js";
import type { BriefsFeatureStatus } from "./feature-gate.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dbPath: string;
let configDir: string;
let app: ReturnType<typeof createServer>;
let ioBacklogCalls = 0;
/** Mutable so a test can express a ceiling the lane has actually passed. */
let bootstrapSettings = {
  enabled: true,
  direction: "recent-first" as const,
  backlogTarget: 200,
  maxRunsPerDay: 200,
  maxRuns: 1_000_000,
  batchSize: 100,
  recencyWindowMs: 7 * 86_400_000,
};
/** Mutable so a test can express an install with, and without, a ceiling. */
let budgetSettings: { dailyTokens: number | null; dailyRuns: number | null } = {
  dailyTokens: null,
  dailyRuns: null,
};
let ADMIN_TOKEN: string;
let READ_TOKEN: string;
let status: BriefsFeatureStatus;
/** Fake drainer live-run registry; tests mark ids running here. */
let runningNow: Map<string, number>;

function cleanupDb(path: string) {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function mintToken(scopes: readonly Scope[]): string {
  const dev = createDevice(db, { name: `test-${randomUUID()}`, kind: "cli" });
  return createToken(db, dev.id, scopes).token;
}

function get(path: string, token = ADMIN_TOKEN) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

function post(path: string, token = ADMIN_TOKEN) {
  return app.request(path, { method: "POST", headers: { authorization: `Bearer ${token}` } });
}

function transcriptStore(): FsCognitionTranscriptStore {
  return new FsCognitionTranscriptStore(cognitionTranscriptsDir(configDir));
}

function seedLoop(
  id: string,
  over: { state?: "open" | "snoozed" | "done" | "dismissed"; title?: string } = {},
): void {
  createOpenLoop(
    db,
    {
      id,
      createdByRun: "run_seed",
      title: over.title ?? "Reply to the venue quote from Stellar Sound",
      description: "Waiting on a decision.",
      confidence: 0.8,
      importance: 0.6,
      state: over.state ?? "open",
      deadline: { type: "by", date: "2026-07-10" },
      docs: [],
    },
    1000,
  );
}

/** Insert a bare document row so a loop's linked-doc enrichment can resolve it. */
function seedDocument(id: string, over: { sourceId?: string; title?: string } = {}): void {
  const nowIso = new Date(1000).toISOString();
  db.prepare(
    `INSERT INTO documents
       (id, provider_id, source_id, external_id, title, content, content_hash,
        metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  ).run(
    id,
    "google:test-account",
    over.sourceId ?? "gmail:test-account",
    `ext-${id}`,
    over.title ?? "Booking confirmation for a studio session",
    "body text",
    `hash-${id}`,
    nowIso,
    nowIso,
    nowIso,
    nowIso,
  );
}

/** A completed `data` run with recorded usage, seeded through the real queue path. */
function seedCompletedRun(id: string, docId: string): void {
  enqueueCognitionRun(
    db,
    { id, kind: "data", payload: { docId, event: "created", datumAt: 500 } },
    1000,
  );
  claimDueCognitionRuns(db, { now: 2000 });
  completeCognitionRun(db, id, {
    usage: { promptTokens: 120, completionTokens: 30 },
    now: 3000,
  });
}

function seedTranscript(
  over: Partial<CognitionRunTranscript> & { runId: string; finishedAt: number },
): void {
  transcriptStore().save({
    attempt: 1,
    kind: "data",
    startedAt: over.finishedAt - 500,
    prompt: "Background Cognition Steward run.",
    events: [],
    finalText: "Nothing to do.",
    outcome: "completed",
    usage: { promptTokens: 100, completionTokens: 20 },
    ...over,
  });
}

const ALL_ROUTES: Array<{ method: "GET" | "POST"; path: string }> = [
  { method: "GET", path: "/admin/brain/loops" },
  { method: "GET", path: "/admin/brain/loops/loop_1" },
  { method: "GET", path: "/admin/brain/pulse" },
  { method: "GET", path: "/admin/brain/run-kinds" },
  { method: "GET", path: "/admin/brain/runs" },
  { method: "GET", path: "/admin/brain/runs/run_1" },
  { method: "GET", path: "/admin/brain/transcripts" },
  { method: "GET", path: "/admin/brain/transcripts/1000-run_1-a1.json" },
  { method: "GET", path: "/admin/brain/decisions" },
  { method: "GET", path: "/admin/brain/spend" },
  { method: "GET", path: "/admin/brain/budget" },
  { method: "GET", path: "/admin/brain/coverage" },
  { method: "GET", path: "/admin/brain/bootstrap" },
  { method: "GET", path: "/admin/brain/bootstrap/backlog" },
  { method: "GET", path: "/admin/brain/bootstrap/timeline?cached=1" },
  { method: "POST", path: "/admin/brain/bootstrap/start" },
  { method: "GET", path: "/admin/brain/briefs" },
  { method: "GET", path: "/admin/brain/briefs/brf_1" },
  { method: "GET", path: "/admin/brain/loops/loop_1/ledger" },
  { method: "GET", path: "/admin/brain/loops/loop_1/briefs" },
  { method: "GET", path: "/admin/brain/loops/loop_1/scheduled" },
  { method: "GET", path: "/admin/brain/scheduled" },
  { method: "GET", path: "/admin/brain/retired-loops" },
  { method: "GET", path: "/admin/brain/temporal-annotations" },
  { method: "GET", path: "/admin/brain/time-index" },
  { method: "GET", path: "/admin/brain/notes" },
  { method: "POST", path: "/admin/brain/notes/wipe" },
  { method: "GET", path: "/admin/brain/clock" },
  { method: "POST", path: "/admin/brain/clock" },
];

beforeEach(() => {
  dbPath = `/tmp/omnesis-briefs-admin-http-${randomUUID()}.db`;
  configDir = mkdtempSync(join(tmpdir(), "omnesis-briefs-admin-"));
  db = createDatabase(dbPath);
  ADMIN_TOKEN = mintToken([SCOPE_ADMIN]);
  READ_TOKEN = mintToken([SCOPE_READ]);
  status = { visible: true, enabled: true, modelAssigned: true, active: true };
  runningNow = new Map();
  ioBacklogCalls = 0;
  budgetSettings = { dailyTokens: null, dailyRuns: null };
  // Starting the backfill is its own operator decision, so a fresh database
  // has not made it. Record it here: these tests are about what the lane
  // REPORTS once running, not about the start gate, which has its own test.
  db.prepare(
    "INSERT INTO cognition_engine_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("bootstrap_started_at", "1");
  bootstrapSettings = {
    enabled: true,
    direction: "recent-first" as const,
    backlogTarget: 200,
    maxRunsPerDay: 200,
    maxRuns: 1_000_000,
    batchSize: 100,
    recencyWindowMs: 7 * 86_400_000,
  };
  app = createServer(db, dbPath, {
    getBriefsStatus: () => status,
    // The backlog runs on the io worker in production; the fake stands in for
    // it so the route's shape and cache are exercised without one.
    io: {
      bootstrapBacklog: async () => {
        ioBacklogCalls += 1;
        return { remaining: 42, dateScanPending: 0, corpusTotal: 100 };
      },
      bootstrapCorpusByMonth: async () => [],
    },
    getBootstrapSettings: () => bootstrapSettings,
    getBudgetSettings: () => budgetSettings,
    configDir,
    cognitionActivity: {
      startedAtMs: (id) => runningNow.get(id) ?? null,
      runningIds: () => [...runningNow.keys()],
    },
  });
});

afterEach(() => {
  db.close();
  cleanupDb(dbPath);
  rmSync(configDir, { recursive: true, force: true });
});

describe("inert-when-off + scopes", () => {
  test("every /admin/brain route 404s when the feature is hidden", async () => {
    status = { visible: false, enabled: false, modelAssigned: true, active: false };
    for (const route of ALL_ROUTES) {
      const res = route.method === "GET" ? await get(route.path) : await post(route.path);
      expect(res.status, `${route.method} ${route.path}`).toBe(404);
    }
  });

  test("visible-but-inactive serves stored reads; writes stay 404", async () => {
    seedLoop("loop_1");
    seedCompletedRun("run_1", "doc-1");
    status = { visible: true, enabled: true, modelAssigned: false, active: false };
    for (const route of ALL_ROUTES) {
      const res = route.method === "GET" ? await get(route.path) : await post(route.path);
      if (route.method === "POST") {
        expect(res.status, `${route.method} ${route.path}`).toBe(404);
        continue;
      }
      if (
        route.path === "/admin/brain/briefs/brf_1" ||
        route.path === "/admin/brain/transcripts/1000-run_1-a1.json"
      ) {
        // Genuinely-missing resources still 404 — the gate is not what refuses them.
        expect(res.status, `GET ${route.path}`).toBe(404);
        continue;
      }
      expect(res.status, `GET ${route.path}`).toBe(200);
    }
    // And the reads carry the stored rows, not empty pages.
    const loops = (await (await get("/admin/brain/loops")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(loops.items.map((l) => l.id)).toContain("loop_1");
    const runs = (await (await get("/admin/brain/runs")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(runs.items.map((r) => r.id)).toContain("run_1");
    // Unknown ids still 404 — the gate lets the read through, the lookup refuses it.
    expect((await get("/admin/brain/loops/loop_missing")).status).toBe(404);
    expect((await get("/admin/brain/runs/run_missing")).status).toBe(404);
  });

  test("every /admin/brain route 404s when no status getter is wired at all", async () => {
    const bare = createServer(db, dbPath, { configDir });
    for (const route of ALL_ROUTES) {
      const res = await bare.request(route.path, {
        method: route.method,
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(404);
    }
  });

  test("requires admin scope: read-only token 403s, unauthenticated 401s", async () => {
    for (const route of ALL_ROUTES) {
      const res =
        route.method === "GET"
          ? await get(route.path, READ_TOKEN)
          : await post(route.path, READ_TOKEN);
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      const unauthenticated = await app.request(route.path, { method: route.method });
      expect(unauthenticated.status, `${route.method} ${route.path}`).toBe(401);
    }
  });
});

describe("GET /admin/brain/loops", () => {
  test("lists loops most-recently-updated first, with the full field set", async () => {
    seedLoop("loop_a");
    seedLoop("loop_b", { title: "Confirm the marathon entry", state: "done" });
    const res = await get("/admin/brain/loops");
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(items).toHaveLength(2);
    const loop = items.find((l) => l.id === "loop_a")!;
    expect(loop).toMatchObject({
      state: "open",
      title: "Reply to the venue quote from Stellar Sound",
      confidence: 0.8,
      importance: 0.6,
      deadline: { type: "by", date: "2026-07-10" },
      decayCheckCount: 0,
    });
    expect(loop.createdAt).toBe(new Date(1000).toISOString());
  });

  test("filters by state and validates state/limit params", async () => {
    seedLoop("loop_a");
    seedLoop("loop_b", { state: "snoozed" });
    seedLoop("loop_c", { state: "done" });
    seedLoop("loop_d", { state: "dismissed" });
    const open = (await (await get("/admin/brain/loops?state=open")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(open.items.map((l) => l.id)).toEqual(["loop_a"]);
    const active = (await (await get("/admin/brain/loops?state=active")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(active.items.map((l) => l.id).sort()).toEqual(["loop_a", "loop_b"]);
    const resolved = (await (await get("/admin/brain/loops?state=resolved")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(resolved.items.map((l) => l.id).sort()).toEqual(["loop_c", "loop_d"]);
    expect((await get("/admin/brain/loops?state=bogus")).status).toBe(400);
    expect((await get("/admin/brain/loops?limit=0")).status).toBe(400);
    expect((await get("/admin/brain/loops?limit=junk")).status).toBe(400);
  });

  test("pages by a stable keyset and binds cursors to the active filters", async () => {
    seedLoop("loop_a");
    seedLoop("loop_b");
    seedLoop("loop_c", { state: "done" });

    const first = (await (await get("/admin/brain/loops?state=active&limit=1")).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.items).toHaveLength(1);
    expect(first.pageInfo.hasMore).toBe(true);

    const second = (await (
      await get(
        `/admin/brain/loops?state=active&limit=1&cursor=${encodeURIComponent(first.pageInfo.nextCursor!)}`,
      )
    ).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean };
    };
    expect(new Set([...first.items, ...second.items].map((loop) => loop.id))).toEqual(
      new Set(["loop_a", "loop_b"]),
    );
    expect(second.pageInfo.hasMore).toBe(false);
    expect(
      (
        await get(
          `/admin/brain/loops?state=resolved&limit=1&cursor=${encodeURIComponent(first.pageInfo.nextCursor!)}`,
        )
      ).status,
    ).toBe(400);
  });

  test("rejects a cursor after a loop mutates between pages", async () => {
    seedLoop("loop_a");
    seedLoop("loop_b");
    const first = (await (await get("/admin/brain/loops?limit=1")).json()) as {
      pageInfo: { nextCursor?: string };
    };

    db.prepare("UPDATE open_loops SET last_update = last_update + 1 WHERE id = ?").run("loop_a");

    const stale = await get(
      `/admin/brain/loops?limit=1&cursor=${encodeURIComponent(first.pageInfo.nextCursor!)}`,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "STALE_PAGE_CURSOR" });
  });
});

describe("GET /admin/brain/pulse", () => {
  test("returns exact collection totals while keeping queue subsets distinct", async () => {
    const snapshotNow = Date.now();
    seedCompletedRun("run_completed", "document-example");
    enqueueCognitionRun(
      db,
      { id: "run_due_queued", kind: "data", payload: {}, notBefore: snapshotNow - 10_000 },
      snapshotNow - 20_000,
    );
    enqueueCognitionRun(
      db,
      { id: "run_due_running", kind: "data", payload: {}, notBefore: snapshotNow - 5_000 },
      snapshotNow - 20_000,
    );
    enqueueCognitionRun(
      db,
      { id: "run_upcoming", kind: "data", payload: {}, notBefore: snapshotNow + 60_000 },
      snapshotNow - 20_000,
    );
    seedLoop("loop_open");
    seedLoop("loop_done", { state: "done" });
    runningNow.set("run_due_running", snapshotNow - 1_000);

    const body = (await (await get("/admin/brain/pulse")).json()) as {
      counts: {
        queuedRuns: number;
        upcomingRuns: number;
        totalRuns: number;
        openLoops: number;
        totalLoops: number;
      };
      runningRuns: Array<{ id: string }>;
      upcomingRuns: Array<{ id: string }>;
    };
    expect(body.counts.queuedRuns).toBe(1);
    expect(body.counts.upcomingRuns).toBe(1);
    expect(body.counts.totalRuns).toBe(4);
    expect(body.counts.openLoops).toBe(1);
    expect(body.counts.totalLoops).toBe(2);
    expect(body.runningRuns.map((run) => run.id)).toEqual(["run_due_running"]);
    expect(body.upcomingRuns.map((run) => run.id)).toEqual(["run_upcoming"]);
  });
});

describe("GET /admin/brain/loops/:id", () => {
  test("returns the loop with its ledger (oldest first) and attached briefs", async () => {
    seedLoop("loop_a");
    appendOpenLoopLedger(db, "loop_a", { runId: "run_1", note: "Quote received." }, 2000);
    appendOpenLoopLedger(db, "loop_a", { runId: "run_2", note: "Still no reply." }, 3000);
    createBrief(
      db,
      {
        id: "brf_1",
        createdByRun: "run_2",
        kind: "loop",
        title: "Nudge: the venue quote is still unanswered",
        description: "Three days now.",
        confidence: 0.7,
        urgency: 0.5,
        relatedLoopIds: ["loop_a"],
      },
      4000,
    );
    const res = await get("/admin/brain/loops/loop_a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      loop: { id: string };
      ledger: Array<{ runId: string; note: string; at: string }>;
      briefs: Array<{ id: string; state: string }>;
    };
    expect(body.loop.id).toBe("loop_a");
    expect(body.ledger.map((e) => e.runId)).toEqual(["run_1", "run_2"]);
    expect(body.ledger[0]).toMatchObject({
      note: "Quote received.",
      at: new Date(2000).toISOString(),
    });
    expect(body.briefs).toEqual([
      expect.objectContaining({ id: "brf_1", kind: "loop", state: "unread" }),
    ]);
  });

  test("enriches linked docs to { id, title, sourceType }, with nulls for a missing doc", async () => {
    seedDocument("doc_known", {
      sourceId: "gmail:test-account",
      title: "Booking confirmation for a studio session",
    });
    createOpenLoop(
      db,
      {
        id: "loop_docs",
        createdByRun: "run_seed",
        title: "Reply to the studio booking quote",
        description: "",
        confidence: 0.8,
        importance: 0.6,
        state: "open",
        deadline: null,
        // A real, ingested doc + a dangling reference (deleted / never ingested).
        docs: ["doc_known", "doc_missing"],
      },
      1000,
    );
    const res = await get("/admin/brain/loops/loop_docs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      loop: { docs: Array<{ id: string; title: string | null; sourceType: string | null }> };
    };
    // The known doc resolves its title + source *type* (not the full source id);
    // the missing doc keeps its id with null title/source and never crashes.
    expect(body.loop.docs).toEqual([
      { id: "doc_known", title: "Booking confirmation for a studio session", sourceType: "gmail" },
      { id: "doc_missing", title: null, sourceType: null },
    ]);
  });

  test("enriches person refs to { id, name }, resolving legacy emails via aliases", async () => {
    db.prepare(
      `INSERT INTO people (id, canonical_name, source, is_self, first_seen, last_seen,
          created_at, updated_at)
       VALUES ('per_maya', 'Maya Reeves', 'test', 0, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO person_aliases (person_id, alias, alias_type, source_id, created_at)
       VALUES ('per_maya', 'maya@example.com', 'email', 'test', '2026-01-01')`,
    ).run();
    createOpenLoop(
      db,
      {
        id: "loop_people",
        createdByRun: "run_seed",
        title: "Confirm the studio booking",
        description: "",
        confidence: 0.8,
        importance: 0.6,
        state: "open",
        deadline: null,
        // A person id + a legacy raw email (resolvable) + an unresolvable one.
        actors: ["per_maya"],
        involved: ["maya@example.com", "ghost@example.com"],
      },
      1000,
    );
    const body = (await (await get("/admin/brain/loops/loop_people")).json()) as {
      loop: { actors: Array<{ id: string; name: string | null }>; involved: unknown };
    };
    expect(body.loop.actors).toEqual([{ id: "per_maya", name: "Maya Reeves" }]);
    expect(body.loop.involved).toEqual([
      { id: "per_maya", name: "Maya Reeves" },
      { id: "ghost@example.com", name: null },
    ]);
  });

  test("404s for an unknown loop", async () => {
    expect((await get("/admin/brain/loops/loop_missing")).status).toBe(404);
  });
});

describe("GET /admin/brain/run-kinds", () => {
  test("returns every queue kind with its canonical label and explanation", async () => {
    const res = await get("/admin/brain/run-kinds");
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: Array<{ kind: string; label: string; description: string }>;
    };
    expect(items.map(({ kind }) => kind)).toEqual([
      "data",
      "daily",
      "time_based",
      "feedback",
      "synthesis",
      "sweep",
      "bootstrap",
      "verification",
      "merge_adjudication",
      "notes_compaction",
      "subscription_compile",
    ]);
    expect(
      items.every(({ label, description }) => label.length > 0 && description.length > 0),
    ).toBe(true);
    expect(items.find(({ kind }) => kind === "sweep")).toEqual({
      kind: "sweep",
      label: "Sweep",
      description:
        "Runs a configured thematic prompt over the corpus on its cadence to look for a particular kind of signal.",
    });
  });
});

describe("GET /admin/brain/runs", () => {
  test("lists runs newest-enqueued first with usage; filters by kind and status", async () => {
    seedCompletedRun("run_1", "doc_a");
    enqueueCognitionRun(db, { id: "run_2", kind: "feedback", payload: { briefId: "b" } }, 5000);
    const res = await get("/admin/brain/runs");
    const { items } = (await res.json()) as { items: Array<Record<string, unknown>> };
    expect(items.map((r) => r.id)).toEqual(["run_2", "run_1"]);
    expect(items[1]).toMatchObject({
      kind: "data",
      status: "completed",
      attempts: 1,
      usage: { promptTokens: 120, completionTokens: 30 },
      completedAt: new Date(3000).toISOString(),
    });
    // The payload is deliberately not exposed on the run list.
    expect(items[0]).not.toHaveProperty("payload");

    const pending = (await (await get("/admin/brain/runs?status=pending")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(pending.items.map((r) => r.id)).toEqual(["run_2"]);
    const data = (await (await get("/admin/brain/runs?kind=data")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(data.items.map((r) => r.id)).toEqual(["run_1"]);
    expect((await get("/admin/brain/runs?kind=bogus")).status).toBe(400);
    expect((await get("/admin/brain/runs?status=bogus")).status).toBe(400);
  });

  test("orders and keyset-pages scheduled runs by nextAttemptAt", async () => {
    enqueueCognitionRun(
      db,
      { id: "run_later", kind: "data", payload: {}, notBefore: 9_000 },
      1_000,
    );
    enqueueCognitionRun(db, { id: "run_soon", kind: "data", payload: {}, notBefore: 3_000 }, 2_000);
    enqueueCognitionRun(
      db,
      { id: "run_middle", kind: "data", payload: {}, notBefore: 6_000 },
      3_000,
    );
    const first = (await (await get("/admin/brain/runs?order=nextAttemptAt&limit=2")).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.items.map((run) => run.id)).toEqual(["run_soon", "run_middle"]);
    expect(first.pageInfo.hasMore).toBe(true);
    const second = (await (
      await get(
        `/admin/brain/runs?order=nextAttemptAt&limit=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor!)}`,
      )
    ).json()) as { items: Array<{ id: string }>; pageInfo: { hasMore: boolean } };
    expect(second.items.map((run) => run.id)).toEqual(["run_later"]);
    expect(second.pageInfo.hasMore).toBe(false);
  });

  test("decodes each kind's pending payload into a display-safe trigger", async () => {
    enqueueCognitionRun(
      db,
      {
        id: "run_data",
        kind: "data",
        payload: {
          docId: "doc_x",
          event: "updated",
          datumAt: 500,
          diff: "--- a\n+++ b\n+added line\n-removed line\n context",
        },
      },
      1000,
    );
    enqueueCognitionRun(
      db,
      {
        id: "run_daily",
        kind: "daily",
        payload: { sourceId: "src_1", dateFrom: "2026-07-01", dateTo: "2026-07-01" },
      },
      2000,
    );
    enqueueCognitionRun(
      db,
      { id: "run_mayday", kind: "daily", payload: { mayDay: true, date: "2026-07-02" } },
      3000,
    );
    enqueueCognitionRun(
      db,
      { id: "run_sched", kind: "time_based", payload: { prompt: "re-check the visa dates" } },
      4000,
    );
    enqueueCognitionRun(
      db,
      { id: "run_decay", kind: "time_based", payload: { decayCheckLoopId: "loop_z" } },
      5000,
    );
    enqueueCognitionRun(
      db,
      { id: "run_fb", kind: "feedback", payload: { briefId: "brf_q", snoozeUntil: 9000 } },
      6000,
    );
    const { items } = (await (await get("/admin/brain/runs")).json()) as {
      items: Array<{ id: string; trigger: Record<string, unknown> }>;
    };
    const byId = new Map(items.map((r) => [r.id, r.trigger]));
    expect(byId.get("run_data")).toEqual({
      type: "data",
      docId: "doc_x",
      event: "updated",
      diff: { added: 1, removed: 1 },
    });
    expect(byId.get("run_daily")).toEqual({
      type: "daily-source",
      sourceId: "src_1",
      dateFrom: "2026-07-01",
      dateTo: "2026-07-01",
    });
    expect(byId.get("run_mayday")).toEqual({ type: "daily-mayday", date: "2026-07-02" });
    expect(byId.get("run_sched")).toEqual({ type: "scheduled", prompt: "re-check the visa dates" });
    expect(byId.get("run_decay")).toEqual({ type: "decay-check", loopId: "loop_z" });
    expect(byId.get("run_fb")).toEqual({ type: "feedback", briefId: "brf_q", snoozeUntil: 9000 });
  });

  test("an inline-recorded watch compilation is filterable and decodes its trigger", async () => {
    recordSettledCognitionRun(db, {
      runId: "run_compile",
      kind: "subscription_compile",
      payload: {
        request: "a fictional launch decision arrives",
        authoredBy: "integration",
        path: "session",
        attempts: 2,
      },
      startedAt: 1000,
      now: 4000,
      day: "2026-07-02",
      mechanism: "subscription-compile",
      modelId: "fictional-model",
      usage: { promptTokens: 80, completionTokens: 10 },
      outcome: {
        kind: "failed",
        errorMessage: "background agent exceeded its context window",
        failureCode: "context_window_exceeded",
      },
    });
    const { items } = (await (await get("/admin/brain/runs?kind=subscription_compile")).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "run_compile",
      kind: "subscription_compile",
      status: "failed",
      lastError: "background agent exceeded its context window",
      failureCode: "context_window_exceeded",
      trigger: {
        type: "subscription-compile",
        request: "a fictional launch decision arrives",
        authoredBy: "integration",
        path: "session",
        attempts: 2,
        replaces: null,
        refusalCodes: [],
      },
    });
  });
});

describe("GET /admin/brain/runs/:id", () => {
  test("returns the run row plus its transcript refs", async () => {
    seedCompletedRun("run_1", "doc_a");
    seedTranscript({ runId: "run_1", finishedAt: 3000 });
    const body = (await (await get("/admin/brain/runs/run_1")).json()) as {
      run: { id: string } | null;
      transcripts: Array<{ fileName: string; attempt: number }>;
    };
    expect(body.run?.id).toBe("run_1");
    expect(body.transcripts).toEqual([
      expect.objectContaining({ attempt: 1, finishedAt: new Date(3000).toISOString() }),
    ]);
  });

  test("a pruned run row with surviving transcripts still resolves (run: null)", async () => {
    seedTranscript({ runId: "run_gone", finishedAt: 3000 });
    const body = (await (await get("/admin/brain/runs/run_gone")).json()) as {
      run: unknown;
      transcripts: unknown[];
    };
    expect(body.run).toBeNull();
    expect(body.transcripts).toHaveLength(1);
  });

  test("returns rebuilding instead of a false 404 while legacy run refs are incomplete", async () => {
    const transcriptsDir = cognitionTranscriptsDir(configDir);
    mkdirSync(transcriptsDir, { recursive: true });
    for (let i = 0; i < 250; i += 1) {
      const finishedAt = 10_000 + i;
      writeFileSync(
        join(transcriptsDir, `${finishedAt}-run_archive_${i}-a1.json`),
        JSON.stringify({
          attempt: 1,
          kind: "data",
          runId: `run_archive_${i}`,
          startedAt: finishedAt - 1,
          finishedAt,
          prompt: "Invented archived run.",
          events: [],
          finalText: "",
          outcome: "completed",
          usage: null,
        }),
        "utf8",
      );
    }

    const response = await get("/admin/brain/runs/run_awaiting_discovery");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run: null,
      transcripts: [],
      rebuilding: true,
      retryAfterMs: 100,
    });
  });

  test("pending AND settled runs carry the decoded trigger (settling keeps the references)", async () => {
    enqueueCognitionRun(
      db,
      {
        id: "run_pending",
        kind: "data",
        payload: { docId: "doc_p", event: "created", datumAt: 42 },
      },
      1000,
    );
    const pending = (await (await get("/admin/brain/runs/run_pending")).json()) as {
      run: { trigger: Record<string, unknown> } | null;
    };
    // The detail endpoint also enriches the trigger's doc; these ids were
    // never ingested, so the ref keeps null title/source.
    expect(pending.run?.trigger).toEqual({
      type: "data",
      docId: "doc_p",
      event: "created",
      diff: null,
      doc: { id: "doc_p", title: null, sourceType: null },
    });
    // Settling strips only snapshot/diff, so a completed run still says
    // what triggered it.
    seedCompletedRun("run_done", "doc_a");
    const done = (await (await get("/admin/brain/runs/run_done")).json()) as {
      run: { trigger: Record<string, unknown> } | null;
    };
    expect(done.run?.trigger).toEqual({
      type: "data",
      docId: "doc_a",
      event: "created",
      diff: null,
      doc: { id: "doc_a", title: null, sourceType: null },
    });
  });

  test("enriches a data trigger's doc to { id, title, sourceType }; list rows keep the bare id", async () => {
    seedDocument("doc_trig", { sourceId: "gmail:test-account", title: "Studio booking follow-up" });
    seedCompletedRun("run_trig", "doc_trig");
    const detail = (await (await get("/admin/brain/runs/run_trig")).json()) as {
      run: { trigger: { doc?: unknown } } | null;
    };
    expect(detail.run?.trigger.doc).toEqual({
      id: "doc_trig",
      title: "Studio booking follow-up",
      sourceType: "gmail",
    });
    const list = (await (await get("/admin/brain/runs")).json()) as {
      items: Array<{ id: string; trigger: { doc?: unknown } }>;
    };
    expect(list.items.find((r) => r.id === "run_trig")!.trigger.doc).toBeUndefined();
  });

  test("a legacy wiped row recovers a coarse trigger from its dedupe key", async () => {
    enqueueCognitionRun(
      db,
      {
        id: "run_legacy",
        kind: "data",
        payload: { docId: "doc_L", event: "updated", datumAt: 42 },
        dedupeKey: "data:doc:doc_L",
      },
      1000,
    );
    claimDueCognitionRuns(db, { now: 2000 });
    completeCognitionRun(db, "run_legacy", { usage: null, now: 3000 });
    // Simulate a row settled before payload retention existed.
    db.prepare("UPDATE cognition_runs SET payload_json = '{}' WHERE id = ?").run("run_legacy");
    const body = (await (await get("/admin/brain/runs/run_legacy")).json()) as {
      run: { trigger: Record<string, unknown> } | null;
    };
    expect(body.run?.trigger).toEqual({
      type: "data",
      docId: "doc_L",
      event: null,
      diff: null,
      doc: { id: "doc_L", title: null, sourceType: null },
    });
  });

  test("flags the run the drainer is executing right now", async () => {
    enqueueCognitionRun(
      db,
      { id: "run_live", kind: "data", payload: { docId: "doc_r", event: "created", datumAt: 1 } },
      1000,
    );
    claimDueCognitionRuns(db, { now: 2000 });
    runningNow.set("run_live", 2000);
    const live = (await (await get("/admin/brain/runs/run_live")).json()) as {
      run: { running: boolean } | null;
    };
    expect(live.run?.running).toBe(true);
    // Settled → the flag drops even if the registry is stale.
    completeCognitionRun(db, "run_live", { usage: null, now: 3000 });
    const done = (await (await get("/admin/brain/runs/run_live")).json()) as {
      run: { running: boolean } | null;
    };
    expect(done.run?.running).toBe(false);
  });

  test("carries the structured loop scope of a scheduled/decay check", async () => {
    enqueueCognitionRun(
      db,
      { id: "run_check", kind: "time_based", payload: { prompt: "re-check", loopId: "loop_q" } },
      1000,
    );
    const body = (await (await get("/admin/brain/runs/run_check")).json()) as {
      run: { loopId: string | null; running: boolean } | null;
    };
    expect(body.run?.loopId).toBe("loop_q");
    expect(body.run?.running).toBe(false);
  });

  test("404s when neither the run row nor any transcript exists", async () => {
    expect((await get("/admin/brain/runs/run_missing")).status).toBe(404);
  });
});

describe("transcripts", () => {
  test("lists refs newest-finished first, filterable by runId", async () => {
    seedTranscript({ runId: "run_1", finishedAt: 1000 });
    seedTranscript({ runId: "run_2", finishedAt: 2000 });
    seedTranscript({ runId: "run_1", finishedAt: 3000, attempt: 2 });
    const all = (await (await get("/admin/brain/transcripts")).json()) as {
      items: Array<{ runId: string; attempt: number }>;
    };
    expect(all.items.map((r) => `${r.runId}/a${r.attempt}`)).toEqual([
      "run_1/a2",
      "run_2/a1",
      "run_1/a1",
    ]);
    const one = (await (await get("/admin/brain/transcripts?runId=run_1")).json()) as {
      items: Array<{ runId: string }>;
    };
    expect(one.items).toHaveLength(2);
    const limited = (await (await get("/admin/brain/transcripts?limit=1")).json()) as {
      items: unknown[];
    };
    expect(limited.items).toHaveLength(1);
  });

  test("pages refs without overlap and binds the cursor to the run filter", async () => {
    seedTranscript({ runId: "run_1", finishedAt: 1000 });
    seedTranscript({ runId: "run_2", finishedAt: 2000 });
    seedTranscript({ runId: "run_1", finishedAt: 3000, attempt: 2 });
    const first = (await (await get("/admin/brain/transcripts?limit=2")).json()) as {
      items: Array<{ runId: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.items.map((ref) => ref.runId)).toEqual(["run_1", "run_2"]);
    expect(first.pageInfo.hasMore).toBe(true);
    const second = (await (
      await get(
        `/admin/brain/transcripts?limit=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor!)}`,
      )
    ).json()) as {
      items: Array<{ runId: string }>;
      pageInfo: { hasMore: boolean };
    };
    expect(second.items.map((ref) => ref.runId)).toEqual(["run_1"]);
    expect(second.pageInfo.hasMore).toBe(false);
    expect(
      (
        await get(
          `/admin/brain/transcripts?runId=run_1&cursor=${encodeURIComponent(
            first.pageInfo.nextCursor!,
          )}`,
        )
      ).status,
    ).toBe(400);
  });

  test("fetches one transcript verbatim by file name; unknown or crafted names 404", async () => {
    seedTranscript({ runId: "run_1", finishedAt: 3000, finalText: "Created one loop." });
    const refs = (await (await get("/admin/brain/transcripts")).json()) as {
      items: Array<{ fileName: string }>;
    };
    const res = await get(`/admin/brain/transcripts/${refs.items[0]!.fileName}`);
    expect(res.status).toBe(200);
    const { transcript } = (await res.json()) as {
      transcript: { runId: string; finalText: string; finishedAt: number };
    };
    expect(transcript).toMatchObject({
      runId: "run_1",
      finalText: "Created one loop.",
      finishedAt: 3000,
    });

    expect((await get("/admin/brain/transcripts/1-nope-a1.json")).status).toBe(404);
    // A traversal-shaped name never matches a stored ref (and the store
    // itself refuses non-pattern names) — 404, not a file read.
    expect(
      (await get(`/admin/brain/transcripts/${encodeURIComponent("1-../../etc/passwd-a1.json")}`))
        .status,
    ).toBe(404);
  });
});

describe("GET /admin/brain/decisions", () => {
  test("summarizes transcripts newest first and filters by ?doc=", async () => {
    seedTranscript({
      runId: "run_1",
      finishedAt: 1000,
      payload: { docId: "doc_a", event: "created", datumAt: 500 },
      events: [
        {
          type: "agent.tool.start",
          payload: { toolCallId: "t1", tool: "search", args: { query: "venue quote" } },
        },
        {
          type: "agent.tool.start",
          payload: {
            toolCallId: "t2",
            tool: "open_loop_create",
            args: { title: "Reply to the venue quote" },
          },
        },
        {
          type: "agent.tool.result",
          payload: { toolCallId: "t2", result: { kind: "structured" } },
        },
      ],
      finalText: "New commitment found; tracked it.",
    });
    seedTranscript({
      runId: "run_2",
      finishedAt: 2000,
      payload: { docId: "doc_b", event: "updated", datumAt: 1500 },
    });
    const all = (await (await get("/admin/brain/decisions")).json()) as {
      items: Array<{
        runId: string;
        subject: string | null;
        actions: Array<{ tool: string; detail: string; ok: boolean }>;
        researchToolCalls: number;
      }>;
    };
    expect(all.items.map((d) => d.runId)).toEqual(["run_2", "run_1"]);
    const first = all.items[1]!;
    expect(first.subject).toBe("doc doc_a (created)");
    expect(first.researchToolCalls).toBe(1);
    expect(first.actions).toEqual([
      { tool: "open_loop_create", detail: 'create loop "Reply to the venue quote"', ok: true },
    ]);

    const filtered = (await (await get("/admin/brain/decisions?doc=doc_a")).json()) as {
      items: Array<{ runId: string }>;
    };
    expect(filtered.items.map((d) => d.runId)).toEqual(["run_1"]);
  });

  test("pages matching decisions and binds cursors to the document filter", async () => {
    for (const [runId, finishedAt, docId] of [
      ["run_1", 1000, "doc_a"],
      ["run_2", 2000, "doc_b"],
      ["run_3", 3000, "doc_a"],
    ] as const) {
      seedTranscript({
        runId,
        finishedAt,
        payload: { docId, event: "created", datumAt: finishedAt - 100 },
      });
    }
    const first = (await (await get("/admin/brain/decisions?doc=doc_a&limit=1")).json()) as {
      items: Array<{ runId: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.items.map((decision) => decision.runId)).toEqual(["run_3"]);
    expect(first.pageInfo.hasMore).toBe(true);
    const second = (await (
      await get(
        `/admin/brain/decisions?doc=doc_a&limit=1&cursor=${encodeURIComponent(
          first.pageInfo.nextCursor!,
        )}`,
      )
    ).json()) as {
      items: Array<{ runId: string }>;
      pageInfo: { hasMore: boolean };
    };
    expect(second.items.map((decision) => decision.runId)).toEqual(["run_1"]);
    expect(second.pageInfo.hasMore).toBe(false);
    expect(
      (
        await get(
          `/admin/brain/decisions?doc=doc_b&cursor=${encodeURIComponent(
            first.pageInfo.nextCursor!,
          )}`,
        )
      ).status,
    ).toBe(400);
  });

  test("returns a continuation instead of scanning an entire sparse decision archive", async () => {
    seedTranscript({
      runId: "run_target",
      finishedAt: 1000,
      payload: { docId: "doc_target", event: "created", datumAt: 900 },
    });
    for (let index = 0; index < 105; index += 1) {
      seedTranscript({
        runId: `run_noise_${index}`,
        finishedAt: 2000 + index,
        payload: { docId: "doc_noise", event: "created", datumAt: 1900 + index },
      });
    }

    const first = (await (await get("/admin/brain/decisions?doc=doc_target&limit=1")).json()) as {
      items: Array<{ runId: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string | null };
      rebuilding: boolean;
      retryAfterMs?: number;
    };
    expect(first.items).toEqual([]);
    expect(first.rebuilding).toBe(true);
    expect(first.retryAfterMs).toBe(100);
    expect(first.pageInfo.hasMore).toBe(false);
    expect(first.pageInfo.nextCursor).toBeUndefined();

    let ready = first;
    for (let attempt = 0; ready.rebuilding && attempt < 20; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      ready = (await (
        await get("/admin/brain/decisions?doc=doc_target&limit=1")
      ).json()) as typeof first;
    }
    expect(ready.rebuilding).toBe(false);
    expect(ready.pageInfo.hasMore).toBe(true);

    const second = (await (
      await get(
        `/admin/brain/decisions?doc=doc_target&limit=1&cursor=${encodeURIComponent(
          ready.pageInfo.nextCursor!,
        )}`,
      )
    ).json()) as {
      items: Array<{ runId: string }>;
      pageInfo: { hasMore: boolean };
    };
    expect(second.items.map((decision) => decision.runId)).toEqual(["run_target"]);
    expect(second.pageInfo.hasMore).toBe(false);
  });
});

describe("GET /admin/brain/spend", () => {
  test("returns per-day totals (aggregated across mechanisms/models) most recent first, capped by ?days=", async () => {
    recordCognitionSpend(db, "2026-06-30", "data", "model-x", {
      promptTokens: 100,
      completionTokens: 10,
    });
    recordCognitionSpend(db, "2026-07-01", "data", "model-x", {
      promptTokens: 200,
      completionTokens: 20,
    });
    recordCognitionSpend(db, "2026-07-01", "synthesis", "model-y", {
      promptTokens: 50,
      completionTokens: 5,
    });
    const res = await get("/admin/brain/spend");
    const { items } = (await res.json()) as {
      items: Array<{ day: string; runs: number; promptTokens: number }>;
    };
    expect(items).toEqual([
      {
        day: "2026-07-01",
        runs: 2,
        promptTokens: 250,
        completionTokens: 25,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        day: "2026-06-30",
        runs: 1,
        promptTokens: 100,
        completionTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ]);
    const one = (await (await get("/admin/brain/spend?days=1")).json()) as { items: unknown[] };
    expect(one.items).toHaveLength(1);
    expect((await get("/admin/brain/spend?days=zero")).status).toBe(400);
  });
});

describe("GET /admin/brain/coverage", () => {
  test("reports per-source tallies with their workflow label and the corpus-wide reviewed count", async () => {
    recordCognitionCoverage(
      db,
      [
        {
          sourceId: "mail:maya@example.com",
          workflowId: "source-bootstrap",
          workflowVersion: 1,
          eligible: 4,
          processed: 3,
          promptTokens: 1_200,
          completionTokens: 300,
        },
        {
          sourceId: "files:jamie@example.com",
          workflowId: "datum-intake",
          workflowVersion: 1,
          processed: 2,
        },
      ],
      Date.parse("2026-07-02T09:00:00.000Z"),
    );
    // The corpus-wide figure comes from the per-document bootstrap marker,
    // which is what the two lanes actually write.
    db.prepare(
      `INSERT INTO documents
         (id, provider_id, source_id, external_id, title, content, content_hash,
          metadata, source_created_at, source_updated_at, ingested_at, updated_at,
          bootstrap_processed_at)
       VALUES ('doc_reviewed', 'test', 'mail:maya@example.com', 'ext-1', 't', 'b', 'h',
          '{}', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
          '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z',
          '2026-07-02T09:00:00.000Z')`,
    ).run();

    const res = await get("/admin/brain/coverage");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bootstrapProcessedDocs: number;
      items: Array<Record<string, unknown>>;
    };
    expect(body.bootstrapProcessedDocs).toBe(1);
    // Newest progress first; rows that moved together fall back to source id.
    expect(body.items).toEqual([
      {
        sourceId: "files:jamie@example.com",
        sourceType: "files",
        workflowId: "datum-intake",
        workflowLabel: "Datum intake",
        workflowVersion: 1,
        eligible: 0,
        processed: 2,
        skipped: 0,
        promptTokens: 0,
        completionTokens: 0,
        lastProgressAt: "2026-07-02T09:00:00.000Z",
        status: "live",
      },
      {
        sourceId: "mail:maya@example.com",
        sourceType: "mail",
        workflowId: "source-bootstrap",
        workflowLabel: "Source catch-up",
        workflowVersion: 1,
        eligible: 4,
        processed: 3,
        skipped: 0,
        promptTokens: 1_200,
        completionTokens: 300,
        lastProgressAt: "2026-07-02T09:00:00.000Z",
        status: "in-progress",
      },
    ]);
  });

  test("keyset-pages equal-time rows with the full composite key", async () => {
    const now = Date.parse("2026-07-02T09:00:00.000Z");
    recordCognitionCoverage(
      db,
      [
        {
          sourceId: "files:maya@example.com",
          workflowId: "datum-intake",
          workflowVersion: 1,
          processed: 1,
        },
        {
          sourceId: "mail:maya@example.com",
          workflowId: "source-bootstrap",
          workflowVersion: 1,
          processed: 1,
        },
        {
          sourceId: "mail:maya@example.com",
          workflowId: "source-bootstrap",
          workflowVersion: 2,
          processed: 1,
        },
      ],
      now,
    );
    const first = (await (await get("/admin/brain/coverage?limit=2")).json()) as {
      items: Array<{ sourceId: string; workflowVersion: number }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.items.map((row) => `${row.sourceId}/v${row.workflowVersion}`)).toEqual([
      "files:maya@example.com/v1",
      "mail:maya@example.com/v1",
    ]);
    expect(first.pageInfo.hasMore).toBe(true);
    const second = (await (
      await get(
        `/admin/brain/coverage?limit=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor!)}`,
      )
    ).json()) as {
      items: Array<{ sourceId: string; workflowVersion: number }>;
      pageInfo: { hasMore: boolean };
    };
    expect(second.items.map((row) => `${row.sourceId}/v${row.workflowVersion}`)).toEqual([
      "mail:maya@example.com/v2",
    ]);
    expect(second.pageInfo.hasMore).toBe(false);
  });
});

describe("GET /admin/brain/briefs", () => {
  function seedBrief(
    id: string,
    over: { state?: string; kind?: "info" | "loop"; title?: string; loopId?: string } = {},
  ): void {
    createBrief(
      db,
      {
        id,
        createdByRun: "run_seed",
        kind: over.kind ?? "loop",
        title: over.title ?? "Nudge: the venue quote is still unanswered",
        description: "Three days now.",
        confidence: 0.7,
        urgency: 0.5,
        citations: ["doc_a"],
        ...(over.loopId ? { relatedLoopIds: [over.loopId] } : {}),
      },
      4000,
    );
    if (over.state && over.state !== "unread") {
      db.prepare("UPDATE briefs SET state = ? WHERE id = ?").run(over.state, id);
    }
  }

  test("lists ALL briefs (every state, newest first) with the full field set", async () => {
    seedBrief("brf_a", { title: "Active nudge" });
    seedBrief("brf_b", { state: "dismissed_not_relevant", title: "Dismissed one", kind: "info" });
    const res = await get("/admin/brain/briefs");
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: Array<Record<string, unknown>> };
    // Both surface — dismissed briefs the user feed hides are visible here.
    expect(items.map((b) => b.id).sort()).toEqual(["brf_a", "brf_b"]);
    const active = items.find((b) => b.id === "brf_a")!;
    expect(active).toMatchObject({
      kind: "loop",
      state: "unread",
      title: "Active nudge",
      citations: ["doc_a"],
      confidence: 0.7,
      urgency: 0.5,
    });
    expect(active.createdAt).toBe(new Date(4000).toISOString());
  });

  test("filters by state and validates state/limit params", async () => {
    seedBrief("brf_a");
    seedBrief("brf_b", { state: "read" });
    seedBrief("brf_c", { state: "dismissed_snoozed" });
    seedBrief("brf_d", { state: "dismissed_wrong" });
    const wrong = (await (await get("/admin/brain/briefs?state=dismissed_wrong")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(wrong.items.map((b) => b.id)).toEqual(["brf_d"]);
    const read = (await (await get("/admin/brain/briefs?state=read")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(read.items.map((brief) => brief.id)).toEqual(["brf_b"]);
    const snoozed = (await (await get("/admin/brain/briefs?state=snoozed")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(snoozed.items.map((brief) => brief.id)).toEqual(["brf_c"]);
    const dismissed = (await (await get("/admin/brain/briefs?state=dismissed")).json()) as {
      items: Array<{ id: string }>;
    };
    expect(dismissed.items.map((brief) => brief.id)).toEqual(["brf_d"]);
    expect((await get("/admin/brain/briefs?state=bogus")).status).toBe(400);
    expect((await get("/admin/brain/briefs?limit=0")).status).toBe(400);
  });
});

describe("artifact provenance on the detail routes", () => {
  test("names the workflow behind a brief, and admits when it cannot", async () => {
    createBrief(
      db,
      {
        id: "brf_prov",
        createdByRun: "run_attributed",
        kind: "info",
        title: "Something noticed",
        description: "d",
        confidence: 0.5,
        urgency: 0.5,
      },
      1000,
    );
    createBrief(
      db,
      {
        id: "brf_old",
        createdByRun: "run_from_before_attribution",
        kind: "info",
        title: "Older card",
        description: "d",
        confidence: 0.5,
        urgency: 0.5,
      },
      1000,
    );
    recordRunAttribution(db, {
      runId: "run_attributed",
      workflowId: "noticing",
      workflowVersion: 1,
      modelId: "scripted-model",
      settledAt: 5000,
    });

    const attributed = (await (await get("/admin/brain/briefs/brf_prov")).json()) as {
      provenance: { workflow: { id: string; label: string } | null; modelId: string | null };
    };
    expect(attributed.provenance.workflow).toMatchObject({ id: "noticing", label: "Noticing" });
    expect(attributed.provenance.modelId).toBe("scripted-model");

    // The run row is not consulted — attribution outlives it — so a brief
    // whose run was never attributed reports the gap instead of guessing.
    const older = (await (await get("/admin/brain/briefs/brf_old")).json()) as {
      provenance: { workflow: unknown; runId: string };
    };
    expect(older.provenance.workflow).toBeNull();
    expect(older.provenance.runId).toBe("run_from_before_attribution");
  });

  test("names the workflow behind a loop", async () => {
    createOpenLoop(
      db,
      {
        id: "loop_prov",
        createdByRun: "run_minted",
        title: "Chase the quote",
        description: "d",
        confidence: 0.8,
        importance: 0.6,
      },
      1000,
    );
    recordRunAttribution(db, {
      runId: "run_minted",
      workflowId: "datum-intake",
      workflowVersion: 2,
      modelId: "scripted-model",
      settledAt: 5000,
    });

    const body = (await (await get("/admin/brain/loops/loop_prov")).json()) as {
      provenance: { workflow: { label: string; version: number } | null };
    };
    expect(body.provenance.workflow).toMatchObject({ label: "Datum intake", version: 2 });
  });
});

describe("GET /admin/brain/briefs/:id", () => {
  test("returns the brief in full plus its derived feed tier", async () => {
    // A loop with a past deadline, so the loop brief's tier is deterministically
    // "due-loop" regardless of the wall clock the endpoint reads.
    createOpenLoop(
      db,
      {
        id: "loop_a",
        createdByRun: "run_seed",
        title: "Reply to the venue quote",
        description: "Overdue.",
        confidence: 0.8,
        importance: 0.6,
        deadline: { type: "by", date: "2020-01-01" },
      },
      1000,
    );
    createBrief(
      db,
      {
        id: "brf_1",
        createdByRun: "run_1",
        kind: "loop",
        title: "The venue quote is due",
        description: "Reply before the deadline.",
        body: "Longer context here.",
        confidence: 0.6,
        urgency: 0.4,
        citations: ["doc_x"],
        relatedLoopIds: ["loop_a"],
      },
      4000,
    );
    const body = (await (await get("/admin/brain/briefs/brf_1")).json()) as {
      brief: {
        id: string;
        body: string;
        relatedLoopIds: string[];
        citations: Array<{ id: string; title: string | null; sourceType: string | null }>;
      };
      feedTier: { rank: number; label: string };
    };
    expect(body.brief).toMatchObject({
      id: "brf_1",
      body: "Longer context here.",
      relatedLoopIds: ["loop_a"],
      // Citations come back enriched like a loop detail's docs; doc_x was
      // never ingested, so it keeps its id with null title/sourceType.
      citations: [{ id: "doc_x", title: null, sourceType: null }],
    });
    // loop_a's deadline (2026-07-10) is due relative to the loop's fake now,
    // so a loop brief lands in the due-loop tier.
    expect(body.feedTier.label).toBe("due-loop");
  });

  test("serves the brief's live asserted claims on the detail payload; the list stays slim", async () => {
    seedDocument("doc_ev", { title: "Deposit receipt from Stellar Sound" });
    createBrief(
      db,
      {
        id: "brf_claims",
        createdByRun: "run_1",
        kind: "info",
        title: "Venue deposit confirmed",
        confidence: 0.6,
        urgency: 0.4,
        claims: [
          {
            id: "bclaim_1",
            claimText: "the venue deposit was paid",
            evidenceDocId: "doc_ev",
            evidenceQuote: "we paid the venue deposit this morning",
            claimBasis: "quoted",
            confidence: 0.8,
            verificationState: "verified",
          },
        ],
      },
      4000,
    );
    const body = (await (await get("/admin/brain/briefs/brf_claims")).json()) as {
      claims: Array<Record<string, unknown>>;
    };
    expect(body.claims).toHaveLength(1);
    expect(body.claims[0]).toMatchObject({
      id: "bclaim_1",
      claimText: "the venue deposit was paid",
      claimBasis: "quoted",
      confidence: 0.8,
      verificationState: "verified",
      evidenceQuote: "we paid the venue deposit this morning",
      // The evidence doc is enriched like the detail route's citations.
      evidenceDoc: { id: "doc_ev", title: "Deposit receipt from Stellar Sound" },
    });
    expect(body.claims[0]!.createdAt).toBe(new Date(4000).toISOString());

    // The list endpoint stays slim: no claims field rides its items.
    const list = (await (await get("/admin/brain/briefs")).json()) as {
      items: Array<Record<string, unknown>>;
    };
    const item = list.items.find((b) => b.id === "brf_claims")!;
    expect(item.claims).toBeUndefined();

    // Privacy-deleting the evidence document purges the claims — the detail
    // payload stops serving the verbatim quote.
    cascadeBriefClaimPrivacyDelete(db, ["doc_ev"]);
    const after = (await (await get("/admin/brain/briefs/brf_claims")).json()) as {
      claims: Array<Record<string, unknown>>;
    };
    expect(after.claims).toEqual([]);
  });

  test("404s for an unknown brief", async () => {
    expect((await get("/admin/brain/briefs/brf_missing")).status).toBe(404);
  });
});

describe("GET /admin/brain/scheduled", () => {
  test("lists only pending time_based runs, soonest-fire first, with the loop link", async () => {
    // A pending scheduled check (agent-scheduled, loop-linked) + a decay check.
    enqueueCognitionRun(
      db,
      {
        id: "run_sched",
        kind: "time_based",
        payload: { prompt: "re-check the venue quote", loopId: "loop_a" },
        notBefore: 9000,
      },
      1000,
    );
    enqueueCognitionRun(
      db,
      {
        id: "run_decay",
        kind: "time_based",
        payload: { decayCheckLoopId: "loop_b" },
        notBefore: 5000,
      },
      1000,
    );
    // Noise the endpoint must exclude: a data run, and a settled time_based run.
    enqueueCognitionRun(
      db,
      { id: "run_data", kind: "data", payload: { docId: "d", event: "created" } },
      1000,
    );
    enqueueCognitionRun(
      db,
      { id: "run_done", kind: "time_based", payload: { prompt: "old" } },
      1000,
    );
    claimDueCognitionRuns(db, { now: 2000 });
    completeCognitionRun(db, "run_done", { usage: null, now: 3000 });

    const { items } = (await (await get("/admin/brain/scheduled")).json()) as {
      items: Array<{
        id: string;
        loopId: string | null;
        fireAt: string;
        trigger: { type: string };
      }>;
    };
    // Only the two pending time_based runs, soonest fire first (decay@5000 before sched@9000).
    expect(items.map((r) => r.id)).toEqual(["run_decay", "run_sched"]);
    const sched = items.find((r) => r.id === "run_sched")!;
    expect(sched.loopId).toBe("loop_a");
    expect(sched.trigger).toEqual({ type: "scheduled", prompt: "re-check the venue quote" });
    expect(sched.fireAt).toBe(new Date(9000).toISOString());
    const decay = items.find((r) => r.id === "run_decay")!;
    expect(decay.loopId).toBe("loop_b");
    expect(decay.trigger).toEqual({ type: "decay-check", loopId: "loop_b" });
  });

  test("keyset-pages the pending queue by fire time", async () => {
    for (const [id, notBefore] of [
      ["run_s1", 3000],
      ["run_s2", 4000],
      ["run_s3", 5000],
    ] as const) {
      enqueueCognitionRun(db, { id, kind: "time_based", payload: { prompt: id }, notBefore }, 1000);
    }
    const first = (await (await get("/admin/brain/scheduled?limit=2")).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.items.map((run) => run.id)).toEqual(["run_s1", "run_s2"]);
    expect(first.pageInfo.hasMore).toBe(true);
    const second = (await (
      await get(
        `/admin/brain/scheduled?limit=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor!)}`,
      )
    ).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean };
    };
    expect(second.items.map((run) => run.id)).toEqual(["run_s3"]);
    expect(second.pageInfo.hasMore).toBe(false);
  });
});

describe("GET /admin/brain/retired-loops", () => {
  test("returns the consolidation store newest-retired first with the full shape", async () => {
    // Retiring a loop (open → done) writes a consolidation trace.
    seedLoop("loop_a", { title: "Reply to the recurring status update" });
    updateOpenLoop(db, "loop_a", { state: "done" }, 5000);
    const { items } = (await (await get("/admin/brain/retired-loops")).json()) as {
      items: Array<{
        id: string;
        outcome: string;
        title: string;
        titleNorm: string;
        recurrenceCount: number;
        retiredAt: string;
      }>;
    };
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "loop_a",
      outcome: "done",
      title: "Reply to the recurring status update",
      recurrenceCount: 1,
    });
    expect(items[0]!.retiredAt).toBe(new Date(5000).toISOString());
    expect(items[0]!.titleNorm.length).toBeGreaterThan(0);
  });
});

describe("GET /admin/brain/temporal-annotations", () => {
  test("lists entries with linked docs enriched to { id, title, sourceType }, nulls for a stale ref", async () => {
    seedDocument("doc_marathon", {
      sourceId: "gmail:test-account",
      title: "Marathon entry confirmation",
    });
    seedDocument("doc_gone", { sourceId: "gmail:test-account", title: "Old registration email" });
    insertTemporalAnnotation(
      db,
      {
        id: "ti_1",
        intervalStartMs: Date.UTC(2027, 0, 15),
        intervalEndMs: Date.UTC(2027, 0, 16) - 1,
        precision: "day",
        canonical: "2027-01-15",
        sentence: "Marathon registration closes",
        kind: "deadline",
        documentIds: ["doc_marathon", "doc_gone"],
        createdByRun: "run_seed",
      },
      1000,
    );
    // Delete one linked doc under a disabled FK cascade so the entry keeps a
    // stale reference — the enrichment must null it out, never crash the read.
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("DELETE FROM documents WHERE id = 'doc_gone'").run();
    db.exec("PRAGMA foreign_keys = ON");

    const res = await get("/admin/brain/temporal-annotations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stats: { total: number };
      items: Array<{
        id: string;
        sentence: string;
        documentIds?: unknown;
        documents: Array<{ id: string; title: string | null; sourceType: string | null }>;
      }>;
    };
    expect(body.stats.total).toBe(1);
    expect(body.items.map((e) => e.id)).toEqual(["ti_1"]);
    // The link set is unordered; reads sort by document id for determinism.
    expect(body.items[0]!.documents).toEqual([
      { id: "doc_gone", title: null, sourceType: null },
      { id: "doc_marathon", title: "Marathon entry confirmation", sourceType: "gmail" },
    ]);
    // The enriched refs REPLACE the bare ids — no duplicated id list.
    expect(body.items[0]!.documentIds).toBeUndefined();

    const legacy = await get("/admin/brain/time-index");
    expect(legacy.status).toBe(200);
    const legacyBody = (await legacy.json()) as typeof body;
    expect(legacyBody.items).toEqual(body.items);
    expect(legacyBody.stats).toMatchObject({
      total: body.stats.total,
    });
  });

  test("keyset-pages tied intervals without shifting after an earlier insert", async () => {
    const seed = (id: string, intervalStartMs: number) =>
      insertTemporalAnnotation(
        db,
        {
          id,
          intervalStartMs,
          intervalEndMs: intervalStartMs,
          precision: "instant",
          canonical: new Date(intervalStartMs).toISOString(),
          sentence: `Invented event ${id}`,
          kind: "event",
          documentIds: [],
          createdByRun: "run_seed",
        },
        1000,
      );
    seed("ti_a", 5000);
    seed("ti_b", 5000);
    seed("ti_c", 6000);

    const first = (await (
      await get("/admin/brain/temporal-annotations?limit=2&order=asc")
    ).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { nextCursor?: string };
    };
    expect(first.items.map((entry) => entry.id)).toEqual(["ti_a", "ti_b"]);

    // The new row sorts before the rendered boundary. Offset pagination would
    // return ti_b again; the interval/id keyset continues at ti_c.
    seed("ti_0", 4000);
    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);
    const second = (await (
      await get(`/admin/brain/temporal-annotations?limit=2&order=asc&cursor=${cursor}`)
    ).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean };
    };
    expect(second.items.map((entry) => entry.id)).toEqual(["ti_c"]);
    expect(second.pageInfo.hasMore).toBe(false);
    expect(
      (await get(`/admin/brain/temporal-annotations?limit=2&order=desc&cursor=${cursor}`)).status,
    ).toBe(400);
  });
});

describe("GET /admin/brain/loops/:id — scheduled runs", () => {
  test("includes the loop's pending scheduled checks", async () => {
    seedLoop("loop_a");
    enqueueCognitionRun(
      db,
      {
        id: "run_sched",
        kind: "time_based",
        payload: { prompt: "check loop_a again", loopId: "loop_a" },
        notBefore: 9000,
      },
      1000,
    );
    // A scheduled check for a DIFFERENT loop must not leak in.
    enqueueCognitionRun(
      db,
      { id: "run_other", kind: "time_based", payload: { prompt: "other", loopId: "loop_z" } },
      1000,
    );
    const body = (await (await get("/admin/brain/loops/loop_a")).json()) as {
      scheduledRuns: Array<{ id: string; loopId: string | null }>;
    };
    expect(body.scheduledRuns.map((r) => r.id)).toEqual(["run_sched"]);
    expect(body.scheduledRuns[0]!.loopId).toBe("loop_a");
  });

  test("keyset-pages only that loop's pending scheduled checks", async () => {
    seedLoop("loop_a");
    seedLoop("loop_b");
    for (const [id, loopId, notBefore] of [
      ["run_a1", "loop_a", 3000],
      ["run_b1", "loop_b", 3500],
      ["run_a2", "loop_a", 4000],
      ["run_a3", "loop_a", 5000],
    ] as const) {
      const isScheduledCheck = id.endsWith("1");
      enqueueCognitionRun(
        db,
        {
          id,
          kind: "time_based",
          payload: isScheduledCheck ? { prompt: id, loopId } : { decayCheckLoopId: loopId },
          notBefore,
        },
        1000,
      );
    }

    const first = (await (await get("/admin/brain/loops/loop_a/scheduled?limit=2")).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean; nextCursor?: string };
    };
    expect(first.items.map((run) => run.id)).toEqual(["run_a1", "run_a2"]);
    expect(first.pageInfo.hasMore).toBe(true);

    const cursor = encodeURIComponent(first.pageInfo.nextCursor!);
    const second = (await (
      await get(`/admin/brain/loops/loop_a/scheduled?limit=2&cursor=${cursor}`)
    ).json()) as {
      items: Array<{ id: string }>;
      pageInfo: { hasMore: boolean };
    };
    expect(second.items.map((run) => run.id)).toEqual(["run_a3"]);
    expect(second.pageInfo.hasMore).toBe(false);
    expect((await get(`/admin/brain/loops/loop_b/scheduled?limit=2&cursor=${cursor}`)).status).toBe(
      400,
    );
  });

  test("rejects a cursor after a scheduled run moves between pages", async () => {
    seedLoop("loop_a");
    for (const [id, notBefore] of [
      ["run_a1", 3000],
      ["run_a2", 4000],
    ] as const) {
      enqueueCognitionRun(
        db,
        {
          id,
          kind: "time_based",
          payload: { decayCheckLoopId: "loop_a" },
          notBefore,
        },
        1000,
      );
    }
    const first = (await (await get("/admin/brain/loops/loop_a/scheduled?limit=1")).json()) as {
      pageInfo: { nextCursor?: string };
    };

    db.prepare("UPDATE cognition_runs SET next_attempt_at = next_attempt_at + 1 WHERE id = ?").run(
      "run_a2",
    );

    const stale = await get(
      `/admin/brain/loops/loop_a/scheduled?limit=1&cursor=${encodeURIComponent(first.pageInfo.nextCursor!)}`,
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "STALE_PAGE_CURSOR" });
  });
});

describe("read-only guarantee", () => {
  test("adds no mutation route under /admin/brain beyond the sanctioned notes wipe", () => {
    // The cognition debug surface is read-only, and its few mutating routes
    // are each a deliberate exception rather than a drift. Listed explicitly
    // so a new one has to be argued for here before it can exist:
    //
    //   clock          — the virtual clock, test/demo compositions only
    //   notes/wipe     — the V1-sanctioned agent-notes wipe
    //   bootstrap/start — the operator's decision to begin the backfill. It
    //                     mutates nothing the Brain reasoned over: it records
    //                     that a human said go, which is exactly the consent
    //                     this surface previously assumed from a model
    //                     assignment.
    const mutating = app.routes
      .filter(
        (r) =>
          r.path.startsWith("/admin/brain") &&
          r.method !== "GET" &&
          r.method !== "ALL" &&
          r.method !== "OPTIONS" &&
          r.method !== "HEAD",
      )
      .map((r) => `${r.method} ${r.path}`);
    expect([...new Set(mutating)].sort()).toEqual([
      "POST /admin/brain/bootstrap/start",
      "POST /admin/brain/clock",
      "POST /admin/brain/notes/wipe",
    ]);
  });
});

describe("agent notes print/wipe", () => {
  test("GET returns the stored content; POST wipe clears it durably", async () => {
    writeCognitionNotes(db, "The user ignores newsletter deadlines.", {
      maxBytes: 8192,
      now: 1000,
    });
    const before = (await (await get("/admin/brain/notes")).json()) as { content: string };
    expect(before.content).toBe("The user ignores newsletter deadlines.");

    const wipe = await post("/admin/brain/notes/wipe");
    expect(wipe.status).toBe(200);
    expect((await wipe.json()) as { ok: boolean }).toEqual({ ok: true });
    expect(readCognitionNotes(db)).toBe("");
    const after = (await (await get("/admin/brain/notes")).json()) as { content: string };
    expect(after.content).toBe("");
  });
});

describe("/admin/brain/clock (the replay time cursor)", () => {
  test("without a virtual clock: GET reports wall time, POST refuses", async () => {
    const res = await get("/admin/brain/clock", ADMIN_TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { virtual: boolean; now: string };
    expect(body.virtual).toBe(false);
    expect(Math.abs(Date.parse(body.now) - Date.now())).toBeLessThan(5_000);

    const refused = await app.request("/admin/brain/clock", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ now: "2026-01-01T00:00:00.000Z" }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("OMNESIS_BRIEFS_VIRTUAL_CLOCK");
  });

  test("with a virtual clock: POST moves it and GET reads it back", async () => {
    const clock = createMutableClock(1_000);
    const virtualApp = createServer(db, dbPath, {
      getBriefsStatus: () => status,
      configDir,
      briefsClock: clock,
    });
    const before = await virtualApp.request("/admin/brain/clock", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(((await before.json()) as { virtual: boolean }).virtual).toBe(true);

    const set = await virtualApp.request("/admin/brain/clock", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ now: "2026-05-10T12:00:00.000Z" }),
    });
    expect(set.status).toBe(200);
    expect(clock()).toBe(Date.parse("2026-05-10T12:00:00.000Z"));

    const bad = await virtualApp.request("/admin/brain/clock", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ now: "not a time" }),
    });
    expect(bad.status).toBe(400);
  });
});

describe("GET /admin/brain/bootstrap", () => {
  test("reports the lane's state, its resolved caps, and the boundary it selects on", async () => {
    const res = await app.request("/admin/brain/bootstrap", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // The server was constructed moments ago, so the lane is inside its boot
    // window — which is the truth, and what the route should say.
    expect(body.state).toBe("holding");
    expect(typeof body.reason).toBe("string");
    expect((body.reason as string).length).toBeGreaterThan(0);

    // The resolved caps ride along because they are not fetchable anywhere
    // else: the config routes serve an operator's overrides, so an untouched
    // maxRunsPerDay reads as absent on the wire.
    expect(body.settings).toMatchObject({ maxRunsPerDay: 200, maxRuns: 1_000_000 });
    expect(body.enqueuedToday).toBe(0);
    expect(body.totalEnqueued).toBe(0);
    expect(body.runs).toEqual({ pending: 0, completed: 0, failed: 0 });
    expect(typeof body.recencyFloor).toBe("string");
  });

  test("surfaces a parked lane and names the ceiling that parked it", async () => {
    // Parked is derived from the LIVE comparison, so the ceiling has to be one
    // the lane has actually passed — setting the stored key alone would not,
    // and should not, be enough.
    bootstrapSettings = { ...bootstrapSettings, maxRuns: 2200 };
    setCognitionEngineState(db, "bootstrap_state", "parked");
    setCognitionEngineState(db, "bootstrap_total_enqueued", "2200");
    const res = await app.request("/admin/brain/bootstrap", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.state).toBe("parked");
    expect(body.totalEnqueued).toBe(2200);
    // This is the state an install can sit in indefinitely with no other
    // signal, so the response has to carry the fix, not just the fact.
    expect(body.reason).toContain("brain.bootstrap.maxRuns");
  });

  test("counts bootstrap runs by status, ignoring the rest of the shared queue", async () => {
    seedDocument("doc-bs");
    enqueueCognitionRun(
      db,
      { id: "bs-1", kind: "bootstrap", payload: { docId: "doc-bs", datumAt: 1 } },
      1000,
    );
    seedCompletedRun("data-1", "doc-bs");
    const res = await app.request("/admin/brain/bootstrap", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = (await res.json()) as { runs: Record<string, number> };
    expect(body.runs.pending).toBe(1);
    expect(body.runs.completed).toBe(0);
  });
});

describe("GET /admin/brain/bootstrap/backlog", () => {
  test("returns the backlog with the date-scan progress that qualifies it", async () => {
    const res = await app.request("/admin/brain/bootstrap/backlog", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.pending).toBe(false);
    expect(typeof body.remaining).toBe("number");
    // The scan counters travel with the backlog deliberately: an unscanned
    // document cannot qualify, so it is invisible to `remaining` and will
    // enter it later. The figure is only a denominator once the scan is done.
    expect(body.dateScanPending).toBe(0);
    // Derived from the corpus total rather than counted directly: the partial
    // indexes cover only the unscanned side, so counting the scanned side is a
    // full table scan.
    expect(body.dateScanned).toBe(100);
    // Dated, so a client can present it as the snapshot it is.
    expect(typeof body.computedAt).toBe("string");
  });

  test("cached=1 answers `pending` cold, without ever running the scan", async () => {
    const res = await app.request("/admin/brain/bootstrap/backlog?cached=1", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: true });
    // The whole point of this path: a surface can show the figure without
    // being what pays for the corpus scan.
    expect(ioBacklogCalls).toBe(0);
  });

  test("cached=1 serves a warmed snapshot without recomputing", async () => {
    await app.request("/admin/brain/bootstrap/backlog", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(ioBacklogCalls).toBe(1);
    const res = await app.request("/admin/brain/bootstrap/backlog?cached=1", {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.remaining).toBe(42);
    expect(ioBacklogCalls).toBe(1);
  });

  test("collapses repeat requests inside the cache window onto one scan", async () => {
    await Promise.all(
      [1, 2, 3].map(() =>
        app.request("/admin/brain/bootstrap/backlog", {
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        }),
      ),
    );
    expect(ioBacklogCalls).toBe(1);
  });
});

describe("GET /admin/brain/budget", () => {
  test("reports no ceiling as a ceiling of none, not as a large number", async () => {
    // The default an open-source install starts on. `null` lets a surface say
    // "unbounded"; a sentinel would have it print one.
    const res = await get("/admin/brain/budget");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.dailyTokens).toBeNull();
    expect(body.dailyRuns).toBeNull();
    expect(body.usedTokens).toBe(0);
    expect(body.usedRuns).toBe(0);
    expect(body.exhausted).toBeNull();
    expect(typeof body.day).toBe("string");
  });

  test("reports the ceilings an operator has set", async () => {
    budgetSettings = { dailyTokens: 30_000_000, dailyRuns: 2_000 };
    const body = (await (await get("/admin/brain/budget")).json()) as Record<string, unknown>;
    expect(body.dailyTokens).toBe(30_000_000);
    expect(body.dailyRuns).toBe(2_000);
  });

  test("carries no figure in currency", async () => {
    // No inference API the Brain talks to exposes a price, so a number in
    // money would be an estimate the gateway cannot verify. Asserted on the
    // wire, because that is where a well-meaning addition would appear.
    budgetSettings = { dailyTokens: 30_000_000, dailyRuns: null };
    const text = await (await get("/admin/brain/budget")).text();
    expect(text).not.toMatch(/usd|dollar|"cost"|price/i);
  });

  test("splits the day by what it cost, with cache-read a subset of prompt", async () => {
    // The relationship that makes the split meaningful: `cacheRead` is part of
    // `prompt`, not additional. Reading it as additional would double-count the
    // cheapest tokens and inflate the day.
    recordCognitionSpend(db, cognitionSpendDay(Date.now()), "datum-intake", "test-model", {
      promptTokens: 1000,
      completionTokens: 40,
      cacheReadTokens: 700,
      cacheCreationTokens: 0,
    });
    const body = (await (await get("/admin/brain/budget")).json()) as Record<string, any>;
    const b = body.breakdown;
    expect(b.promptTokens).toBe(1000);
    expect(b.cacheReadTokens).toBe(700);
    expect(b.freshInputTokens).toBe(300);
    expect(b.completionTokens).toBe(40);
    expect(b.cacheHitRate).toBeCloseTo(0.7, 5);
    // Enforcement still counts them flat, so a ceiling stays predictable.
    expect(body.usedTokens).toBe(1040);
  });

  test("never reports negative fresh input", async () => {
    // A provider reporting more cached than prompted is nonsense, but it must
    // render as zero rather than as a negative quantity of reading.
    recordCognitionSpend(db, cognitionSpendDay(Date.now()), "datum-intake", "test-model", {
      promptTokens: 100,
      completionTokens: 0,
      cacheReadTokens: 500,
      cacheCreationTokens: 0,
    });
    const body = (await (await get("/admin/brain/budget")).json()) as Record<string, any>;
    expect(body.breakdown.freshInputTokens).toBe(0);
  });

  test("is admin-only", async () => {
    expect([401, 403]).toContain((await get("/admin/brain/budget", READ_TOKEN)).status);
  });
});
