// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The writer's WAL checkpoints against a real writer worker, an encrypted
 * invented corpus, sustained document writes and reader threads that never
 * stop reading.
 *
 * A checkpoint copies every page written since the last one, so one a minute
 * held the writer for seconds; and with a reader always on the WAL the WAL
 * never rewound, so it grew for as long as the gateway ran. Here each
 * checkpoint stays short, a write queued behind one is served promptly, and
 * the WAL keeps being rewound and cut back to its size limit even while a
 * reader holds a long snapshot now and then.
 *
 * How far the WAL climbs before a rewind lands is not asserted. It is the write
 * rate times the wait for the rewind, so it measures this load and this machine:
 * the readers' statements take about as long as one rewind attempt waits, so a
 * few attempts in a row can miss and the backoff stretches the wait. What the
 * WAL owes the gateway is that the rewind comes and the file is cut back, so a
 * run keeps its load up until that has happened, within `REWIND_WAIT_SECONDS`.
 * The bench line reports the peak.
 *
 * The longest single checkpoint and the longest single write are not held to the
 * hold budget either. The catch-up after a long reader is one uncapped copy (see
 * `workers/wal-checkpoint.ts`), so its cost is the frames that reader pinned times
 * this machine's I/O: 261 ms has been seen for 4,917 frames. The typical run and
 * the typical write are held to the budget, and the worst of each to a ceiling.
 *
 * The second run swaps the synthetic readers for the gateway's own background
 * reads, run back to back over a backlog of large pending files, a DF table
 * and the corpus: each statement they run stays short, so the WAL keeps
 * rewinding instead of waiting for a scan to end.
 *
 * `OMNESIS_WAL_BENCH_SECONDS`, `OMNESIS_WAL_BENCH_DOCS`, `OMNESIS_WAL_BENCH_BACKLOG`,
 * `OMNESIS_WAL_BENCH_BACKLOG_KIB` and `OMNESIS_WAL_BENCH_DF_ROWS` size it for a bench.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { ProviderId, SourceId } from "@omnesis/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { publishDfGeneration } from "../near-dupes/meta.js";
import { runWithPriority } from "../priority.js";
import { WAL_SIZE_LIMIT_BYTES } from "../workers/wal-checkpoint.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { writeGateFromScheduler } from "./write-ops.js";
import { PILOT_ALGO, seedPilotCorpus } from "./__fixtures__/pilot-corpus.js";
import type { WriteGate } from "../write-gate.js";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";
import type Database from "better-sqlite3";

const WRITER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const READER_URL = new URL("./__fixtures__/wal-reader-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

const SECONDS = Number(process.env.OMNESIS_WAL_BENCH_SECONDS ?? 40);
const DOCS = Number(process.env.OMNESIS_WAL_BENCH_DOCS ?? 20_000);
/** Documents the writes cycle through, so the corpus stays its size while pages keep changing. */
const REWRITTEN = 4_000;
const BATCH = 40;
/**
 * Pause between write batches: about 10 MB/s of WAL, several times what the
 * pilot install wrote, so the WAL passes its size limit every few seconds.
 */
const BATCH_PAUSE_MS = 100;
const BACKLOG = Number(process.env.OMNESIS_WAL_BENCH_BACKLOG ?? 1_200);
const BACKLOG_KIB = Number(process.env.OMNESIS_WAL_BENCH_BACKLOG_KIB ?? 32);
const DF_ROWS = Number(process.env.OMNESIS_WAL_BENCH_DF_ROWS ?? 300_000);
const BACKLOG_SOURCE = "synth-drive-backlog";
const HOLD_BUDGET_MS = 250;
/** The worst single checkpoint or write a run may see, on a busy shared machine. */
const WORST_CASE_MS = 4 * HOLD_BUDGET_MS;
/** The longest statement, and so the longest snapshot, a background read may take. */
const READ_BUDGET_MS = 1_000;
const PROBE_EVERY_MS = 50;
/**
 * How long past `SECONDS` a run keeps its load up waiting for a rewind and the
 * cut back after it. Runs normally have both within seconds, so this only
 * lengthens a run on a machine slow enough to keep missing them.
 */
const REWIND_WAIT_SECONDS = 180;
const CURSOR: SyncCursor = {
  type: "incremental",
  lastSyncTime: "2026-01-05T09:00:00.000Z",
} as SyncCursor;
const WORDS = [
  "budget",
  "review",
  "quarterly",
  "marathon",
  "harbor",
  "lantern",
  "orchard",
  "summit",
  "ledger",
  "meadow",
  "invoice",
  "itinerary",
];

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
}

function inventedDoc(n: number, revision: number): DocumentInput {
  const words: string[] = [];
  for (let i = 0; i < 400; i++) words.push(WORDS[(n * 7 + i * 3 + revision) % WORDS.length]!);
  return {
    providerId: ProviderId("synth-mail"),
    sourceId: SourceId("synth-mail-work"),
    externalId: `synth-wal-${n}`,
    title: `Synth thread ${n} revision ${revision}`,
    content: words.join(" "),
    contentHash: `synth-wal-${n}-${revision}`,
    sourceCreatedAt: "2026-05-01T10:00:00.000Z",
    sourceUpdatedAt: new Date(Date.parse("2026-05-01T10:00:00.000Z") + revision).toISOString(),
    metadata: { documentType: "email" },
  } as DocumentInput;
}

interface ReaderStats {
  reads: number;
  maxStatementMs: number;
  maxOpMs: Record<string, number>;
}

interface ReaderHandle {
  stop: () => Promise<ReaderStats>;
}

interface ReaderOptions {
  window: number;
  holdMs?: number;
  holdEveryMs?: number;
  real?: { statsSourceId: string; algoVersion: string; dateBatch: number; dateMaxChars: number };
}

function startReader(path: string, keyHex: string, opts: ReaderOptions): Promise<ReaderHandle> {
  const stop = new SharedArrayBuffer(4);
  const worker = new Worker(READER_URL, {
    execArgv: ["--import", LOADER_URL],
    workerData: { path, keyHex, stop, ...opts },
  });
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", () => {
      resolve({
        stop: () =>
          new Promise((done, fail) => {
            worker.once("error", fail);
            worker.on("message", (m: { type: string } & ReaderStats) => {
              if (m.type === "done") done(m);
            });
            Atomics.store(new Int32Array(stop), 0, 1);
          }),
      });
    });
  });
}

/**
 * What a large source mid-ingest leaves behind: `docs` files of about `kib`
 * KiB each, all still waiting for the date pass, and a published DF
 * generation of `dfRows` shingles.
 */
function seedLongReaderLoad(
  db: Database.Database,
  docs: number,
  kib: number,
  dfRows: number,
): void {
  const pairs = Math.max(1, Math.round((kib * 1024) / 14));
  db.transaction(() => {
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash,
         metadata, source_created_at, source_updated_at, ingested_at, updated_at,
         people_resolved_at, vocabulary_processed_at, links_extracted_at, bootstrap_processed_at)
       SELECT printf('synth-backlog-%06d', i), 'synth-drive', ?, printf('synth-backlog-file-%06d', i),
              printf('Orchard itinerary %d', i),
              printf('Revision %d. ', i) || replace(hex(zeroblob(?)), '00', 'meadow ledger '),
              printf('synth-backlog-hash-%d', i), '{"documentType":"document"}',
              '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
              strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || i || ' seconds'),
              strftime('%Y-%m-%dT%H:%M:%fZ', '2026-10-20', '+' || i || ' seconds'),
              '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z',
              '2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z'
         FROM n`,
    ).run(docs, BACKLOG_SOURCE, pairs);
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
       INSERT INTO near_dup_df (algo_version, generation, shingle, df)
       SELECT ?, 1, printf('summit %08d lantern harbor', i), 2 + i % 9 FROM n`,
    ).run(dfRows, PILOT_ALGO);
    publishDfGeneration(db, PILOT_ALGO, 1, docs, dfRows, 1_790_000_000);
  })();
}

interface Bench {
  dbPath: string;
  keyHex: string;
  scheduler: Scheduler;
  runner: WriterTaskRunner;
  gate: WriteGate;
}

async function startBench(seedExtra?: (db: Database.Database) => void): Promise<Bench> {
  const key = randomBytes(32);
  const dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  const seed = createDatabase(dbPath, { encryptionKey: key }) as unknown as Database.Database;
  try {
    seedPilotCorpus(seed, { docs: DOCS });
    seedExtra?.(seed);
    seed.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    seed.close();
  }
  const scheduler = new Scheduler({ enablePreemption: true });
  const runner = new WriterTaskRunner({
    gatewayDbPath: dbPath,
    gatewayDbKeyHex: key.toString("hex"),
    journalMode: "WAL",
    heartbeatIntervalMs: 1_000,
    heartbeatWarnGapMs: 10_000,
    workerUrl: WRITER_URL,
    workerExecArgv: ["--import", LOADER_URL],
  });
  scheduler.registerRunner(runner);
  await scheduler.start();
  return {
    dbPath,
    keyHex: key.toString("hex"),
    scheduler,
    runner,
    gate: writeGateFromScheduler(scheduler),
  };
}

async function stopBench(bench: Bench | undefined): Promise<void> {
  if (!bench) return;
  await bench.scheduler.dispose();
  cleanupDb(bench.dbPath);
}

/**
 * Write for at least `SECONDS` while `readers` read, and on until the WAL has
 * been rewound and cut back or `REWIND_WAIT_SECONDS` more have passed, probing
 * the writer's latency with a user-priority write every `PROBE_EVERY_MS` and
 * sampling the WAL's size.
 */
async function runUnderLoad(bench: Bench, label: string, readers: ReaderOptions[]) {
  const { dbPath, gate, scheduler } = bench;
  const handles = await Promise.all(readers.map((r) => startReader(dbPath, bench.keyHex, r)));

  let maxWalBytes = 0;
  let shrinks = 0;
  let largestAfterShrink = 0;
  let lastWalBytes = 0;
  let reportedLogFrames = 0;
  const startedMs = performance.now();
  const earliestEndMs = startedMs + SECONDS * 1_000;
  const latestEndMs = earliestEndMs + REWIND_WAIT_SECONDS * 1_000;
  const loadContinues = () => {
    const now = performance.now();
    if (now < earliestEndMs) return true;
    const rewinds = bench.runner.walCheckpointMetrics(1)?.lifetime.rewinds ?? 0;
    return now < latestEndMs && (rewinds === 0 || shrinks === 0);
  };
  let written = 0;
  let revision = 0;
  const writing = (async () => {
    while (loadContinues()) {
      revision += 1;
      const docs: DocumentInput[] = [];
      for (let i = 0; i < BATCH; i++) docs.push(inventedDoc((written + i) % REWRITTEN, revision));
      const result = await runWithPriority("background", () => gate.upsertDocuments(docs));
      expect(result.rejectedSourceIds).toEqual([]);
      written += BATCH;
      await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
    }
  })();

  const probeMs: number[] = [];
  let seq = 0;
  const probing = (async () => {
    while (loadContinues()) {
      const started = performance.now();
      await runWithPriority("user", () =>
        gate.setSyncState(`synth-wal-probe-${seq++ % 8}`, CURSOR, undefined),
      );
      probeMs.push(performance.now() - started);
      await new Promise((r) => setTimeout(r, PROBE_EVERY_MS));
    }
  })();

  const sampler = setInterval(() => {
    const frames = bench.runner.walCheckpointMetrics(1)?.lastLogFrames ?? 0;
    reportedLogFrames = Math.max(reportedLogFrames, frames);
    const size = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
    maxWalBytes = Math.max(maxWalBytes, size);
    if (size < lastWalBytes) {
      shrinks += 1;
      largestAfterShrink = Math.max(largestAfterShrink, size);
    }
    lastWalBytes = size;
  }, 100);

  await Promise.all([writing, probing]);
  clearInterval(sampler);
  const ranSeconds = (performance.now() - startedMs) / 1_000;
  const readerStats = await Promise.all(handles.map((r) => r.stop()));

  const metrics = scheduler.snapshot(3_600).walCheckpoints!;
  const stats = metrics.lifetime;
  const upsert = scheduler.snapshot(900).perTask.find((t) => t.name === "db.upsertDocuments");
  const sorted = [...probeMs].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const maxOpMs: Record<string, number> = {};
  for (const r of readerStats)
    for (const [op, ms] of Object.entries(r.maxOpMs)) maxOpMs[op] = Math.max(maxOpMs[op] ?? 0, ms);
  process.stdout.write(
    `[${label}] docs=${DOCS} seconds=${SECONDS} ranSeconds=${ranSeconds.toFixed(0)} written=${written} ` +
      `checkpoints=${stats.runs} maxCheckpointMs=${stats.maxMs.toFixed(0)} totalCheckpointMs=${stats.totalMs.toFixed(0)} ` +
      `rewinds=${stats.rewinds} deferredRewinds=${stats.deferredRewinds} maxDeferredStreak=${stats.maxDeferredStreak} ` +
      `maxWalMiB=${(maxWalBytes / 2 ** 20).toFixed(1)} finalWalMiB=${(lastWalBytes / 2 ** 20).toFixed(1)} walShrinks=${shrinks} ` +
      `checkpointP95=${metrics.p95Ms.toFixed(0)}ms probes=${probeMs.length} probeP50=${p(0.5).toFixed(0)}ms probeP95=${p(0.95).toFixed(0)}ms probeP99=${p(0.99).toFixed(0)}ms probeMax=${sorted.at(-1)!.toFixed(0)}ms ` +
      `upsertMax=${upsert?.max.toFixed(0)}ms reads=${readerStats.map((r) => r.reads).join("/")} ` +
      `maxStatementMs=${readerStats.map((r) => r.maxStatementMs.toFixed(0)).join("/")} ` +
      `maxOpMs=${Object.entries(maxOpMs)
        .map(([op, ms]) => `${op}:${ms.toFixed(0)}`)
        .join(",")}\n`,
  );
  return {
    written,
    readerStats,
    metrics,
    stats,
    sorted,
    p,
    shrinks,
    largestAfterShrink,
    reportedLogFrames,
  };
}

describe("writer WAL checkpoints under sustained writes and constant readers", () => {
  let bench: Bench | undefined;

  beforeAll(async () => {
    bench = await startBench();
  }, 900_000);

  afterAll(async () => {
    await stopBench(bench);
  });

  test("checkpoints stay short, queued writes are served, and the WAL stays bounded", async () => {
    const run = await runUnderLoad(bench!, "wal checkpoint bench", [
      { window: 300 },
      { window: 1_500 },
      { window: 300, holdMs: 1_500, holdEveryMs: 4_000 },
    ]);
    const { stats, metrics, sorted, p } = run;

    expect(run.written).toBeGreaterThan(BATCH * 20);
    for (const r of run.readerStats) expect(r.reads).toBeGreaterThan(10);
    expect(stats.runs).toBeGreaterThan(SECONDS);
    expect(metrics.p95Ms).toBeLessThan(HOLD_BUDGET_MS);
    expect(stats.maxMs).toBeLessThan(WORST_CASE_MS);
    expect(p(0.95)).toBeLessThan(HOLD_BUDGET_MS);
    expect(sorted.at(-1)!).toBeLessThan(WORST_CASE_MS);
    expect(stats.rewinds).toBeGreaterThan(0);
    expect(run.shrinks).toBeGreaterThan(0);
    expect(run.largestAfterShrink).toBeLessThanOrEqual(WAL_SIZE_LIMIT_BYTES);
    expect(metrics).toMatchObject({ runs: stats.runs, maxMs: stats.maxMs, rewinds: stats.rewinds });
    expect(metrics.p95Ms).toBeLessThanOrEqual(metrics.maxMs);
    expect(run.reportedLogFrames).toBeGreaterThan(0);
    expect(metrics.lastLogFrames).toBeGreaterThanOrEqual(0);
    expect(metrics.lastCheckpointedFrames).toBeLessThanOrEqual(metrics.lastLogFrames!);
  }, 900_000);
});

describe("writer WAL checkpoints while the gateway's own background reads run back to back", () => {
  let bench: Bench | undefined;

  beforeAll(async () => {
    bench = await startBench((db) => seedLongReaderLoad(db, BACKLOG, BACKLOG_KIB, DF_ROWS));
  }, 900_000);

  afterAll(async () => {
    await stopBench(bench);
  });

  test("every statement stays short, readers never starve the rewind, and no checkpoint holds the writer", async () => {
    const real = {
      statsSourceId: BACKLOG_SOURCE,
      algoVersion: PILOT_ALGO,
      dateBatch: 50,
      dateMaxChars: 50_000,
    };
    const run = await runUnderLoad(bench!, "wal long readers bench", [
      { window: 0, real },
      { window: 0, real },
      { window: 300 },
    ]);
    const { stats, metrics, sorted, p } = run;

    expect(run.written).toBeGreaterThan(BATCH * 20);
    for (const r of run.readerStats) expect(r.reads).toBeGreaterThan(8);
    expect(stats.runs).toBeGreaterThan(SECONDS);
    for (const r of run.readerStats) expect(r.maxStatementMs).toBeLessThan(READ_BUDGET_MS);
    expect(metrics.p95Ms).toBeLessThan(HOLD_BUDGET_MS);
    expect(stats.maxMs).toBeLessThan(WORST_CASE_MS);
    expect(p(0.95)).toBeLessThan(HOLD_BUDGET_MS);
    expect(sorted.at(-1)!).toBeLessThan(WORST_CASE_MS);
    expect(stats.rewinds).toBeGreaterThan(0);
    expect(run.shrinks).toBeGreaterThan(0);
    expect(run.largestAfterShrink).toBeLessThanOrEqual(WAL_SIZE_LIMIT_BYTES);
  }, 900_000);
});
