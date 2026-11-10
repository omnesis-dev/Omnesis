// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark and parity capture for `POST /sql` (`omnesis sql`) on a large,
 * encrypted, invented store.
 *
 *   npx tsx scripts/bench-sql-off-main.mts build   <dir> [documents=120000]
 *   npx tsx scripts/bench-sql-off-main.mts measure <dir> [runs=7]
 *   npx tsx scripts/bench-sql-off-main.mts capture <dir> <out.json>
 *
 * `build` creates `<dir>/omnesis.db` with the full gateway schema, keyed like a
 * production store, and fills `documents` with invented notes and messages of
 * a few kilobytes each across a dozen sources and three years. `measure` opens
 * the store the way the gateway's main thread does (read-only, its default page
 * cache), starts one io read worker the way the gateway does, mounts the
 * analytics routes as the server does, and posts operator queries, recording
 * request latency, the longest event-loop block (`monitorEventLoopDelay`), the
 * worker's own execution time where the route uses it, and RSS. Each run opens
 * a fresh handle and worker, so its first request reads a cold page cache; a
 * second request on the same handle is the warm case. `capture` writes the
 * status, content type and body (with the measured `timing` zeroed) of every
 * behaviour case, so two checkouts' outputs can be diffed for parity.
 *
 * Copy the script into another checkout to measure that checkout's route: it
 * imports the route code relative to its own location, and a checkout whose
 * `/sql` takes no read worker ignores the one offered. Never point it at a live
 * config directory; it writes the store it measures.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Hono } from "hono";

import { SCOPE_ADMIN } from "@omnesis/types";
import { createDatabase, openReadOnlyDatabase } from "../packages/gateway/src/db.js";
import { Scheduler } from "../packages/gateway/src/scheduler/scheduler.js";
import { IoTaskRunner } from "../packages/gateway/src/scheduler/runners/io.js";
import { ioGateFromScheduler } from "../packages/gateway/src/scheduler/io-ops.js";
import { errorResponse, HttpError } from "../packages/gateway/src/http/errors.js";
import { strictRoute } from "../packages/gateway/src/http/scope.js";
import { mountAnalyticsRoutes } from "../packages/gateway/src/http/routes/analytics.js";

const WORKER_URL = new URL("../packages/gateway/src/workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../packages/gateway/src/workers/register-tsx.mjs", import.meta.url)
  .href;
/** The gateway's defaults for the main read handle and each io read handle. */
const MAIN_READ_CACHE_BYTES = 256 * 1024 * 1024;
const IO_READ_CACHE_BYTES = 64 * 1024 * 1024;

const [mode, dir, arg] = process.argv.slice(2);
if (!mode || !dir) {
  console.error("usage: bench-sql-off-main.mts build|measure|capture <dir> [arg]");
  process.exit(2);
}
const dbPath = join(dir, "omnesis.db");
const keyPath = join(dir, "key.hex");

// ── build ───────────────────────────────────────────────────────────────────

const SOURCES = [
  "mail:inbox",
  "mail:work",
  "notes:garden",
  "notes:journal",
  "chat:family",
  "chat:team",
  "files:drive",
  "calendar:home",
  "tasks:list",
  "web:history",
  "health:daily",
  "photos:library",
];
const WORDS =
  "seed tray budget review marathon entry form harbor lantern quarterly orchard ledger compass meadow kettle signal ferry granite violet thunder canvas pocket ribbon walnut summit".split(
    " ",
  );

function sentence(seed: number, words: number): string {
  const out: string[] = [];
  let x = seed;
  for (let i = 0; i < words; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push(WORDS[x % WORDS.length]!);
  }
  return out.join(" ");
}

function build(documents: number): void {
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; build into an empty directory`);
  mkdirSync(dir!, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"));
  const db = createDatabase(dbPath, { encryptionKey: key });
  const insert = db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
                            metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const start = Date.parse("2023-01-01T00:00:00Z");
  const span = 3 * 365 * 24 * 3600 * 1000;
  const batch = 5_000;
  for (let from = 0; from < documents; from += batch) {
    db.transaction(() => {
      for (let i = from; i < Math.min(from + batch, documents); i++) {
        const source = SOURCES[i % SOURCES.length]!;
        const at = new Date(start + Math.floor((i / documents) * span)).toISOString();
        // A few kilobytes of body each, one in fifty a long one.
        const words = i % 50 === 0 ? 3_000 : 300 + (i % 400);
        const content = sentence(i + 1, words);
        insert.run(
          `bench-doc-${i}`,
          source.split(":")[0],
          source,
          `bench-ext-${i}`,
          `Invented ${source.split(":")[0]} item ${i}: ${sentence(i + 7, 5)}`,
          content,
          createHash("sha256").update(content).digest("hex"),
          JSON.stringify({ tags: [WORDS[i % WORDS.length]], size: words }),
          at,
          at,
          at,
          at,
        );
      }
    })();
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  console.log(`built ${documents} invented documents in ${dbPath}`);
}

// ── the route, mounted the way the gateway mounts it ───────────────────────

function loadKey(): string {
  return readFileSync(keyPath, "utf8").trim();
}

async function startWorker() {
  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      gatewayDbKeyHex: loadKey(),
      concurrency: 1,
      cacheSizeBytes: IO_READ_CACHE_BYTES,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  return { scheduler, gate: ioGateFromScheduler(scheduler) };
}

async function openApp() {
  const db = openReadOnlyDatabase(dbPath, {
    encryptionKey: Buffer.from(loadKey(), "hex"),
    cacheSizeBytes: MAIN_READ_CACHE_BYTES,
  });
  const worker = await startWorker();
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500);
  });
  app.use("*", async (c, next) => {
    c.set("requestId" as never, "bench-request" as never);
    c.set(
      "auth" as never,
      {
        authMethod: "bearer",
        deviceId: null,
        credentialDeviceId: null,
        tokenId: null,
        scopes: [SCOPE_ADMIN],
      } as never,
    );
    await next();
  });
  mountAnalyticsRoutes(strictRoute(app as never), {
    db,
    analyticsService: null,
    sourceService: {} as never,
    // The gateway's read worker. A checkout whose `/sql` reads on the main
    // handle ignores it.
    ...({ ioGate: worker.gate } as object),
  } as never);
  return {
    app,
    workerExecMs: () => {
      const stats = worker.scheduler.taskStats("io.sqliteQuery", 3_600);
      return stats ? stats.totalExecMs : null;
    },
    close: async () => {
      await worker.scheduler.dispose();
      db.close();
    },
  };
}

interface Answer {
  status: number;
  contentType: string | null;
  body: string;
}

async function post(app: Hono, request: Record<string, unknown>): Promise<Answer> {
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

// ── capture ─────────────────────────────────────────────────────────────────

const seq = (n: number) =>
  `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${n}) SELECT n, printf('row-%05d', n) AS label FROM seq`;

const CASES: Array<[string, Record<string, unknown>]> = [
  ["empty result", { sql: "SELECT id FROM documents WHERE id = 'missing'" }],
  ["empty, no rows to name the columns", { sql: "SELECT * FROM documents WHERE 0" }],
  ["small", { sql: "SELECT id, title, source_id FROM documents ORDER BY id LIMIT 25" }],
  ["types", { sql: "SELECT id, COUNT(*) AS n FROM documents GROUP BY id LIMIT 3" }],
  [
    "every storage class",
    {
      sql: "SELECT 1 AS i, 2.5 AS r, 'text' AS t, NULL AS z, x'00ff10' AS b, zeroblob(3) AS zb, 9007199254740993 AS big LIMIT 1",
    },
  ],
  [
    "aggregate scan",
    {
      sql: "SELECT source_id, COUNT(*) AS n, SUM(LENGTH(content)) AS bytes FROM documents GROUP BY source_id ORDER BY source_id",
    },
  ],
  ["auto limit, default", { sql: "SELECT id, source_created_at FROM documents ORDER BY id" }],
  ["auto limit, explicit", { sql: "SELECT id FROM documents ORDER BY id", limit: 17 }],
  [
    "auto limit, clamped then capped",
    { sql: "SELECT id, title FROM documents ORDER BY id", limit: 1_000_000 },
  ],
  ["caller's LIMIT within the cap", { sql: "SELECT id FROM documents ORDER BY id LIMIT 9" }],
  [
    "caller's LIMIT past the cap",
    { sql: "SELECT id, title, metadata FROM documents ORDER BY id LIMIT 50000" },
  ],
  ["large rows", { sql: "SELECT id, content FROM documents ORDER BY id", limit: 2_000 }],
  ["sorted over the corpus", { sql: "SELECT id FROM documents ORDER BY content DESC", limit: 20 }],
  ["generated", { sql: seq(12_000) + " LIMIT 12000" }],
  ["LIMIT in a literal", { sql: "SELECT 'no LIMIT here' AS note" }],
  ["syntax error", { sql: "SELEC id FROM documents" }],
  ["unknown table", { sql: "SELECT * FROM nonexistent_table_xyz" }],
  ["runtime error", { sql: "SELECT json_extract('not json', '$.a') AS x" }],
  ["insert, wrapped", { sql: "INSERT INTO documents (id) VALUES ('evil')" }],
  ["update, wrapped", { sql: "UPDATE documents SET title = 'x'" }],
  ["drop, wrapped", { sql: "DROP TABLE documents" }],
  ["create, wrapped", { sql: "  CREATE TABLE evil (x INT)" }],
  ["comment-led insert", { sql: "/* note */ INSERT INTO documents (id) VALUES ('evil')" }],
  ["insert past the wrapper", { sql: "INSERT INTO documents (id) SELECT 'evil' LIMIT 1" }],
  [
    "insert returning past the wrapper",
    { sql: "INSERT INTO documents (id) VALUES ('evil') RETURNING id -- LIMIT" },
  ],
  [
    "update returning past the wrapper",
    { sql: "UPDATE documents SET title = 'x' RETURNING id -- LIMIT" },
  ],
  [
    "CTE delete returning past the wrapper",
    {
      sql: "WITH x AS (SELECT 1) DELETE FROM documents WHERE id IN (SELECT 'bench-doc-1' FROM x) RETURNING id -- LIMIT",
    },
  ],
  ["multi-statement", { sql: "SELECT 1 LIMIT 1; DROP TABLE documents" }],
  ["multi-statement, wrapped", { sql: "SELECT 1; DELETE FROM documents" }],
  ["PRAGMA assignment", { sql: "PRAGMA user_version = 7 -- LIMIT" }],
  ["PRAGMA journal_mode", { sql: "PRAGMA journal_mode = DELETE -- LIMIT" }],
  ["PRAGMA read", { sql: "PRAGMA table_info(documents) -- LIMIT" }],
  ["ATTACH", { sql: "ATTACH DATABASE ':memory:' AS other -- LIMIT" }],
  ["VACUUM", { sql: "VACUUM -- LIMIT" }],
];

async function capture(out: string): Promise<void> {
  const { app, close } = await openApp();
  const results: Array<{ name: string } & Answer> = [];
  for (const [name, request] of CASES) results.push({ name, ...(await post(app, request)) });
  writeFileSync(out, JSON.stringify(results, null, 2));
  const digest = createHash("sha256").update(JSON.stringify(results)).digest("hex");
  const statuses = results.map((r) => r.status).join(",");
  console.log(`${results.length} responses, sha256 ${digest}\nstatuses ${statuses}`);
  await close();
}

// ── measure ─────────────────────────────────────────────────────────────────

interface Timed {
  ms: number;
  blockedMs: number;
  status: number;
  bytes: number;
}

async function timed(app: Hono, request: Record<string, unknown>): Promise<Timed> {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const started = performance.now();
  const res = await app.request("/sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const bytes = (await res.arrayBuffer()).byteLength;
  const ms = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 5));
  histogram.disable();
  return { ms, blockedMs: histogram.max / 1e6, status: res.status, bytes };
}

function summary(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return `median ${median.toFixed(1)} ms, worst ${sorted.at(-1)!.toFixed(1)} ms`;
}

const PROBES: Array<[string, Record<string, unknown>]> = [
  [
    "aggregate scan over every document",
    {
      sql: "SELECT source_id, COUNT(*) AS n, SUM(LENGTH(content)) AS bytes FROM documents GROUP BY source_id",
    },
  ],
  [
    "10,000-row result (caller's LIMIT past the cap)",
    { sql: "SELECT id, title, source_id, metadata, source_created_at FROM documents LIMIT 20000" },
  ],
];

async function measure(runs: number): Promise<void> {
  for (const [name, request] of PROBES) {
    const cold = { ms: [] as number[], blocked: [] as number[] };
    const warm = { ms: [] as number[], blocked: [] as number[] };
    const workerMs: number[] = [];
    const rss: number[] = [];
    let bytes = 0;
    for (let run = 0; run < runs; run++) {
      const { app, close, workerExecMs } = await openApp();
      const rssBefore = process.memoryUsage().rss;
      const first = await timed(app, request);
      const second = await timed(app, request);
      if (first.status !== 200 || second.status !== 200) throw new Error(`${name} failed`);
      bytes = first.bytes;
      cold.ms.push(first.ms);
      cold.blocked.push(first.blockedMs);
      warm.ms.push(second.ms);
      warm.blocked.push(second.blockedMs);
      const exec = workerExecMs();
      if (exec !== null) workerMs.push(exec / 2);
      rss.push((process.memoryUsage().rss - rssBefore) / 1024 / 1024);
      await close();
    }
    console.log(`${name} (${(bytes / 1024).toFixed(0)} KiB body)`);
    console.log(`  fresh handle  latency ${summary(cold.ms)}; blocked ${summary(cold.blocked)}`);
    console.log(`  warm handle   latency ${summary(warm.ms)}; blocked ${summary(warm.blocked)}`);
    if (workerMs.length) console.log(`  worker exec per request ${summary(workerMs)}`);
    console.log(`  process RSS growth per run ${summary(rss).replaceAll(" ms", " MiB")}`);
  }
}

if (mode === "build") build(Number(arg ?? 120_000));
else if (mode === "measure") await measure(Number(arg ?? 7));
else if (mode === "capture") await capture(arg ?? join(dir, "capture.json"));
else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
// A disposed io worker can leave a handle that keeps the process alive.
process.exit(0);
