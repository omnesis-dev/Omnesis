// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Benchmark and parity capture for the agent's `cite_record` tool on a large,
 * encrypted, invented corpus.
 *
 *   npx tsx scripts/bench-record-citation.mts build   <dir> [documents=400000] [maxContentBytes=4000]
 *   npx tsx scripts/bench-record-citation.mts measure <dir> [runs=7]
 *   npx tsx scripts/bench-record-citation.mts capture <dir> <out.json>
 *
 * `build` creates `<dir>/omnesis.db` with the full gateway schema, keyed like a
 * production store, and `<dir>/analytics.db`. The document store holds one
 * large mail-like source, a file source, and a run-tracking source with two
 * accounts whose analytics table binds each row to a document; with two
 * owners, the catalog names that table's source by its bare type, which is how
 * a citation reaches the documents without an account. A second, single-owner
 * table keeps its account-qualified source id.
 * `maxContentBytes` caps each document's body: the slow lookup reads index
 * entries rather than bodies, so a small cap builds a larger corpus in less
 * space.
 *
 * `measure` opens the document store the way the gateway's main thread does
 * (the default page cache) and calls the tool through the gateway's record
 * port, recording its latency and the longest event-loop block
 * (`monitorEventLoopDelay`). Each run opens a fresh handle, so its first call
 * pays decryption like a call after the cache has turned over; a second call
 * on the same handle is the warm case. `capture` writes what the tool returns
 * for every behaviour case, so two checkouts' outputs can be diffed for parity.
 *
 * Copy the script into another checkout to measure that checkout's code: it
 * imports relative to its own location. Never point it at a live config
 * directory; it writes the stores it measures.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { createCiteRecordTool } from "../packages/agent/src/index.js";
import { recordReference } from "../packages/core/src/index.js";
import { createGatewayRecordPort } from "../packages/gateway/src/agent/ports.js";
import { AnalyticsDb } from "../packages/gateway/src/analytics-db.js";
import { createDatabase, openReadOnlyDatabase } from "../packages/gateway/src/db.js";
import type { AnalyticsTableSchema } from "../packages/source-sdk/src/index.js";
import type { Db } from "../packages/gateway/src/data/types.js";

const [mode, dir, arg, arg2] = process.argv.slice(2);
if (!mode || !dir) {
  console.error("usage: bench-record-citation.mts build|measure|capture <dir> [arg]");
  process.exit(2);
}
const dbPath = join(dir, "omnesis.db");
const analyticsPath = join(dir, "analytics.db");
const keyPath = join(dir, "key.hex");
/** The gateway's default main-thread page cache (`runtime-settings.ts`). */
const READ_CACHE_BYTES = 256 * 1024 * 1024;

// ── deterministic invented content ─────────────────────────────────────────

let seed = 0x5eed4321;
function random(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const WORDS =
  "quarterly budget review marathon entry heart rate trend studio northstar riverside estate stellar sound invoice draft agenda follow up schedule venue catering summary notes travel itinerary garden supplies weekly report checklist renewal reminder".split(
    " ",
  );
function text(minBytes: number, maxBytes: number): string {
  const target = minBytes + Math.floor(random() * (maxBytes - minBytes));
  const out: string[] = [];
  let length = 0;
  while (length < target) {
    const word = WORDS[Math.floor(random() * WORDS.length)]!;
    out.push(word);
    length += word.length + 1;
  }
  return out.join(" ");
}

function runSchema(tableName: string): AnalyticsTableSchema {
  return {
    tableName,
    displayName: "Bench Runs",
    description: "Invented run activities",
    columns: [
      { name: "id", type: "VARCHAR", description: "Activity id" },
      { name: "route", type: "VARCHAR", description: "Route name" },
      { name: "distance_km", type: "DOUBLE", description: "Distance" },
      { name: "device_token", type: "VARCHAR", description: "Device token", sensitive: true },
      { name: "started_at", type: "TIMESTAMPTZ", description: "Start" },
    ],
    primaryKey: ["id"],
    semanticTimeColumn: "started_at",
    record: { titleColumns: ["route"], keyColumns: ["route", "distance_km", "device_token"] },
    boundDocument: { externalIdColumns: ["id"] },
  };
}
/** Two owners: the catalog names this table's source by its bare type. */
const SHARED_TABLE = "bench_runs";
/** One owner: the catalog keeps the account-qualified source id. */
const SINGLE_TABLE = "bench_rides";
const RUN_ACCOUNTS = ["bench-runs:acct-a", "bench-runs:acct-b"];
const RIDE_SOURCE = "bench-rides:acct-c";

async function build(documents: number, maxContentBytes: number): Promise<void> {
  mkdirSync(dir!, { recursive: true });
  if (existsSync(dbPath)) throw new Error(`${dbPath} exists; build into an empty directory`);
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("hex"));
  const db = createDatabase(dbPath, { encryptionKey: key });
  const insert = db.prepare(`
    INSERT INTO documents (id, provider_id, source_id, external_id, stream_id, title, content,
      content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let written = 0;
  let clock = Date.parse("2025-01-01T00:00:00Z");
  const add = (providerId: string, sourceId: string, externalId: string, type: string): void => {
    clock += 60_000;
    const at = new Date(clock).toISOString();
    insert.run(
      randomUUID(),
      providerId,
      sourceId,
      externalId,
      "",
      text(20, 60),
      text(Math.min(500, maxContentBytes), maxContentBytes),
      `hash-${written}`,
      JSON.stringify({ documentType: type }),
      at,
      at,
      at,
      at,
    );
    written += 1;
  };
  const fill = (target: number, next: (i: number) => void): void => {
    let i = 0;
    while (written < target) {
      db.transaction(() => {
        for (let n = 0; n < 2_000 && written < target; n++, i++) next(i);
      })();
      process.stdout.write(`\r${written} documents`);
    }
  };
  const runs = Math.round(documents * 0.05);
  fill(runs, (i) => add("bench-fitness", RUN_ACCOUNTS[i % 2]!, `activity-${i}`, "activity"));
  fill(runs + 2_000, (i) => add("bench-fitness", RIDE_SOURCE, `ride-${i}`, "activity"));
  fill(Math.round(documents * 0.7), (i) =>
    add("bench-mail", "bench-mail:inbox", `m-${i}`, "email"),
  );
  fill(documents, (i) => add("bench-files", "bench-files:drive", `folder/${i}.txt`, "file"));
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();

  const analytics = new AnalyticsDb(analyticsPath);
  await analytics.open();
  for (const account of RUN_ACCOUNTS) await analytics.ensureTable(runSchema(SHARED_TABLE), account);
  await analytics.ensureTable(runSchema(SINGLE_TABLE), RIDE_SOURCE);
  await analytics.close();
  console.log(`\nbuilt ${written} documents in ${dbPath}`);
}

// ── the tool, wired the way the gateway wires it ───────────────────────────

async function openTool(): Promise<{
  db: Db;
  analytics: AnalyticsDb;
  invoke: (args: unknown) => Promise<unknown>;
}> {
  const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
  const db = openReadOnlyDatabase(dbPath, { encryptionKey: key, cacheSizeBytes: READ_CACHE_BYTES });
  const analytics = new AnalyticsDb(analyticsPath);
  await analytics.open();
  const tool = createCiteRecordTool({ port: createGatewayRecordPort(db, analytics) });
  return {
    db,
    analytics,
    invoke: (args) => tool.invoke(args, { sessionId: "bench", messageId: "bench" }),
  };
}

function cite(table: string, id: string, startedAt: string | null = "2026-03-01T07:30:00.000Z") {
  return {
    reference: recordReference(table, [{ name: "id", value: id }]),
    snapshot: {
      id,
      route: "Riverside loop",
      distance_km: 8.4,
      device_token: "invented-token",
      started_at: startedAt,
    },
  };
}

function behaviourCases(): Array<[string, unknown]> {
  return [
    ["bare-type table, bound document in the first account", cite(SHARED_TABLE, "activity-10")],
    ["bare-type table, bound document in the second account", cite(SHARED_TABLE, "activity-11")],
    ["bare-type table, no bound document", cite(SHARED_TABLE, "activity-missing")],
    ["bare-type table, case variant of a bound id", cite(SHARED_TABLE, "ACTIVITY-10")],
    ["bare-type table, id of another source", cite(SHARED_TABLE, "m-10")],
    ["qualified table, bound document", cite(SINGLE_TABLE, "ride-10")],
    ["qualified table, no bound document", cite(SINGLE_TABLE, "ride-missing")],
    ["row with an empty semantic time", cite(SHARED_TABLE, "activity-10", null)],
    ["unknown table", cite("bench_missing", "activity-10")],
    ["repeat citation", cite(SHARED_TABLE, "activity-10")],
  ];
}

async function capture(out: string): Promise<void> {
  const { db, analytics, invoke } = await openTool();
  const results: Array<{ name: string; result: unknown }> = [];
  for (const [name, args] of behaviourCases()) results.push({ name, result: await invoke(args) });
  writeFileSync(out, JSON.stringify(results, null, 2));
  for (const r of results) {
    const result = r.result as { kind: string; boundDocumentId?: string | null };
    console.log(`${result.kind}  bound=${result.boundDocumentId ?? "-"}  ${r.name}`);
  }
  db.close();
  await analytics.close();
}

async function timed(
  invoke: (args: unknown) => Promise<unknown>,
  args: unknown,
): Promise<{ ms: number; blockedMs: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const started = performance.now();
  await invoke(args);
  const ms = performance.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 5));
  histogram.disable();
  return { ms, blockedMs: histogram.max / 1e6 };
}

function summary(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return `median ${median.toFixed(1)} ms, worst ${sorted.at(-1)!.toFixed(1)} ms`;
}

async function measure(runs: number): Promise<void> {
  const probes: Array<[string, unknown]> = [
    ["bare-type table, bound document", cite(SHARED_TABLE, "activity-10")],
    ["bare-type table, no bound document", cite(SHARED_TABLE, "activity-missing")],
    ["qualified table, bound document", cite(SINGLE_TABLE, "ride-10")],
  ];
  const rssBefore = process.memoryUsage().rss;
  for (const [name, args] of probes) {
    const cold = { ms: [] as number[], blocked: [] as number[] };
    const warm = { ms: [] as number[], blocked: [] as number[] };
    for (let run = 0; run < runs; run++) {
      const { db, analytics, invoke } = await openTool();
      const first = await timed(invoke, args);
      const second = await timed(invoke, args);
      cold.ms.push(first.ms);
      cold.blocked.push(first.blockedMs);
      warm.ms.push(second.ms);
      warm.blocked.push(second.blockedMs);
      db.close();
      await analytics.close();
    }
    console.log(name);
    console.log(`  fresh handle  latency ${summary(cold.ms)}; blocked ${summary(cold.blocked)}`);
    console.log(`  warm handle   latency ${summary(warm.ms)}; blocked ${summary(warm.blocked)}`);
  }
  console.log(
    `rss growth over the run: ${((process.memoryUsage().rss - rssBefore) / 1024 / 1024).toFixed(0)} MiB`,
  );
}

if (mode === "build") await build(Number(arg ?? 400_000), Number(arg2 ?? 4_000));
else if (mode === "measure") await measure(Number(arg ?? 7));
else if (mode === "capture") {
  if (!arg) throw new Error("capture needs an output path");
  await capture(arg);
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
