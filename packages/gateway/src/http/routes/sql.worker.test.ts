// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `POST /sql` on the real io worker, against a temp database: every query
 * answers exactly what the same query answers on a read-only handle of the
 * route's own, the main thread's handle is never asked to run it, and the
 * worker runs it on a connection of its own, configured like the gateway's
 * main read handle rather than like the shared io handle.
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { SCOPE_ADMIN } from "@omnesis/types";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../db.js";
import { Scheduler } from "../../scheduler/scheduler.js";
import { IoTaskRunner } from "../../scheduler/runners/io.js";
import { ioGateFromScheduler, type IoGate } from "../../scheduler/io-ops.js";
import { errorResponse, HttpError } from "../errors.js";
import { strictRoute } from "../scope.js";
import { mountAnalyticsRoutes, type AnalyticsRoutesDeps } from "./analytics.js";
import type Database from "better-sqlite3";
import type { AppEnv } from "./types.js";

const WORKER_URL = new URL("../../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../../workers/register-tsx.mjs", import.meta.url).href;

const dbPath = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
const routes = new Set<ReturnType<typeof mountAnalyticsRoutes>>();
let db: Database.Database;
let scheduler: Scheduler;
let gate: IoGate;

function seed(target: Database.Database): void {
  const insert = target.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
                            metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'fixture', ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
  );
  target.transaction(() => {
    for (let i = 0; i < 40; i++) {
      const at = `2026-03-${String((i % 28) + 1).padStart(2, "0")}T09:00:00Z`;
      insert.run(
        `doc-${i}`,
        i % 2 ? "notes:fixture" : "mail:fixture",
        `ext-${i}`,
        i % 5 ? `Garden plan ${i}` : "",
        `Invented note ${i} about seed trays and the Q${(i % 4) + 1} budget review.`,
        `hash-${i}`,
        at,
        at,
        at,
        at,
      );
    }
  })();
  // Every storage class, BLOB included: a BLOB answers as `Buffer#toJSON`.
  target.exec(`CREATE TABLE fixture_cells (id INTEGER PRIMARY KEY, label TEXT, ratio REAL, payload BLOB);
    INSERT INTO fixture_cells VALUES (1, 'alpha', 0.25, x'00ff10'), (2, NULL, -3.5, NULL),
      (3, 'gamma', 1e300, x''), (4, 'δέλτα "quoted"', 0, x'deadbeef');`);
}

function appWith(gateway?: Pick<IoGate, "sqliteQuery">): {
  app: Hono<AppEnv>;
  prepare: ReturnType<typeof vi.spyOn>;
} {
  const app = strictRoute(new Hono<AppEnv>());
  app.use("*", async (c, next) => {
    c.set("auth", { authMethod: "bearer", scopes: [SCOPE_ADMIN], tokenId: null, deviceId: null });
    await next();
  });
  // The fallback opens a read-only handle of its own onto this file; a spy on
  // the handle the route was given sees any read that strays onto it.
  const prepare = vi.spyOn(db, "prepare");
  const mounted = mountAnalyticsRoutes(app, {
    db: db as unknown as AnalyticsRoutesDeps["db"],
    analyticsService: null,
    sourceService: {} as AnalyticsRoutesDeps["sourceService"],
    ...(gateway ? { ioGate: gateway } : {}),
  });
  routes.add(mounted);
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    throw err;
  });
  return { app, prepare };
}

interface Answer {
  status: number;
  contentType: string | null;
  /** The body with the measured `timing` zeroed, which no two runs share. */
  body: string;
}

async function post(app: Hono<AppEnv>, request: Record<string, unknown>): Promise<Answer> {
  const res = await app.request("/sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: (await res.text()).replace(/"timing":\d+/, '"timing":0'),
  };
}

const overCap = (n: number) =>
  `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${n}) SELECT n, printf('row-%05d', n) AS label FROM seq`;

/** Every behaviour of the route, by name: what it reads, and the case it pins. */
const CASES: Array<[string, Record<string, unknown>]> = [
  ["empty result", { sql: "SELECT id FROM documents WHERE id = 'missing'" }],
  ["empty table, no rows to name the columns", { sql: "SELECT * FROM documents WHERE 0" }],
  ["small result", { sql: "SELECT id, title, source_id FROM documents ORDER BY id" }],
  [
    "declared and expression column types",
    { sql: "SELECT id, COUNT(*) AS n FROM documents GROUP BY id" },
  ],
  ["every storage class, BLOB included", { sql: "SELECT * FROM fixture_cells ORDER BY id" }],
  ["auto limit, default 1000", { sql: overCap(1_500) }],
  ["auto limit, explicit", { sql: "SELECT id FROM documents ORDER BY id", limit: 7 }],
  ["auto limit, clamped at 100000 then capped", { sql: overCap(12_000), limit: 1_000_000 }],
  ["caller's LIMIT within the cap", { sql: `${overCap(20)} LIMIT 5` }],
  ["caller's LIMIT past the cap, truncated", { sql: `${overCap(12_000)} LIMIT 11000` }],
  ["LIMIT inside a string literal", { sql: "SELECT 'no LIMIT here' AS note" }],
  [
    "large result",
    { sql: "SELECT d.id, d.content, s.n FROM documents d, (" + overCap(200) + ") s", limit: 9_000 },
  ],
  ["syntax error", { sql: "SELEC id FROM documents" }],
  ["unknown table", { sql: "SELECT * FROM nonexistent_table_xyz" }],
  ["runtime error", { sql: "SELECT json_extract('not json', '$.a') AS x" }],
  ["insert, wrapped", { sql: "INSERT INTO documents (id) VALUES ('evil')" }],
  ["drop, wrapped", { sql: "DROP TABLE documents" }],
  [
    "insert past the wrapper with LIMIT",
    { sql: "INSERT INTO fixture_cells (id) SELECT 99 LIMIT 1" },
  ],
  [
    "insert returning rows past the wrapper",
    { sql: "INSERT INTO fixture_cells (id) VALUES (98) RETURNING id -- LIMIT" },
  ],
  [
    "delete through a CTE past the wrapper",
    {
      sql: "WITH x AS (SELECT 1) DELETE FROM documents WHERE id IN (SELECT 'doc-1' FROM x) RETURNING id -- LIMIT",
    },
  ],
  ["multi-statement smuggling", { sql: "SELECT 1 LIMIT 1; DROP TABLE documents" }],
  ["PRAGMA assignment without rows", { sql: "PRAGMA user_version = 7 -- LIMIT" }],
  ["PRAGMA read", { sql: "PRAGMA table_info(fixture_cells) -- LIMIT" }],
  ["ATTACH", { sql: "ATTACH DATABASE ':memory:' AS other -- LIMIT" }],
];

beforeAll(async () => {
  const writer = createDatabase(dbPath);
  seed(writer);
  writer.close();
  db = createDatabase(dbPath);
  scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      concurrency: 1,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  gate = ioGateFromScheduler(scheduler);
}, 60_000);

afterAll(async () => {
  await scheduler?.dispose();
  for (const mounted of routes) await mounted.close();
  routes.clear();
  db?.close();
  for (const suffix of ["", "-wal", "-shm"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

describe("POST /sql on the io worker", () => {
  it("answers every case exactly as the route's own read-only handle does", async () => {
    const direct = appWith();
    const worker = appWith(gate);
    for (const [name, request] of CASES) {
      const expected = await post(direct.app, request);
      const actual = await post(worker.app, request);
      expect(actual, name).toEqual(expected);
    }
    // The cases reach both answers: rows, a truncation, and refusals.
    const answers = await Promise.all(CASES.map(([, request]) => post(worker.app, request)));
    const statuses = new Set(answers.map((a) => a.status));
    expect([...statuses].sort()).toEqual([200, 400]);
    expect(answers.some((a) => a.body.includes('"truncated":true'))).toBe(true);
    // Nothing was written, whichever handle the refusals came from.
    expect(db.prepare("SELECT COUNT(*) AS n FROM fixture_cells").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 40 });
    expect(db.pragma("user_version", { simple: true })).not.toBe(7);
  }, 60_000);

  it("refuses a write with the engine's read-only refusal, as a 400", async () => {
    const { app } = appWith(gate);
    for (const sql of [
      "INSERT INTO fixture_cells (id) VALUES (98) RETURNING id -- LIMIT",
      "UPDATE fixture_cells SET label = 'x' RETURNING id -- LIMIT",
    ]) {
      const answer = await post(app, { sql });
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body)).toEqual({
        error: "attempt to write a readonly database",
        code: "BAD_REQUEST",
      });
    }
  });

  it("runs the query as the io op, never on the main thread's handle", async () => {
    const sqliteQuery = vi.spyOn(gate, "sqliteQuery");
    const { app, prepare } = appWith(gate);
    prepare.mockClear();
    const ok = await post(app, { sql: "SELECT id FROM documents ORDER BY id", limit: 3 });
    const refused = await post(app, { sql: "SELECT * FROM nonexistent_table_xyz" });
    expect(ok.status).toBe(200);
    expect(refused.status).toBe(400);
    expect(sqliteQuery).toHaveBeenCalledTimes(2);
    expect(sqliteQuery).toHaveBeenNthCalledWith(1, {
      sql: "SELECT id FROM documents ORDER BY id",
      limit: 3,
    });
    expect(prepare).not.toHaveBeenCalled();
    // Both ran on the io runner, at the priority a waiting person gets.
    const stats = scheduler.taskStats("io.sqliteQuery", 3600);
    expect(stats).toMatchObject({ runner: "io" });
    expect(stats!.countByPriority.user).toBeGreaterThanOrEqual(2);
    sqliteQuery.mockRestore();
    prepare.mockRestore();
  });

  it("runs on a connection of its own, which the operator's PRAGMAs cannot reach past", async () => {
    const { app } = appWith(gate);
    const pragma = async (name: string) =>
      (
        JSON.parse((await post(app, { sql: `PRAGMA ${name} -- LIMIT` })).body) as {
          rows: unknown[][];
        }
      ).rows[0]![0];
    // Read-only twice over, no memory-mapped reads, and temporary storage on
    // file (0, the build default) rather than the shared handle's memory (2).
    expect(await pragma("query_only")).toBe(1);
    expect(await pragma("mmap_size")).toBe(0);
    expect(await pragma("temp_store")).toBe(0);
    // The io handle's page-cache budget (64 MiB unless configured).
    expect(await pragma("cache_size")).toBe(-64 * 1024);
    // An assignment that returns a row does run, on this connection only.
    expect(await pragma("mmap_size = 4096")).toBe(4096);
    expect(await pragma("mmap_size")).toBe(4096);
  });
});
