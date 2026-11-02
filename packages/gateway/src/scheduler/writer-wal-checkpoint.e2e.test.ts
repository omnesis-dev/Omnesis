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
 * `OMNESIS_WAL_BENCH_SECONDS` and `OMNESIS_WAL_BENCH_DOCS` size it for a bench.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { ProviderId, SourceId } from "@omnesis/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { runWithPriority } from "../priority.js";
import { WAL_SIZE_LIMIT_BYTES } from "../workers/wal-checkpoint.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { writeGateFromScheduler } from "./write-ops.js";
import { seedPilotCorpus } from "./__fixtures__/pilot-corpus.js";
import type { WriteGate } from "../write-gate.js";
import type { DocumentInput, SyncCursor } from "@omnesis/source-sdk";
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
const HOLD_BUDGET_MS = 250;
const PROBE_EVERY_MS = 50;
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

interface ReaderHandle {
  stop: () => Promise<{ reads: number; maxStatementMs: number }>;
}

function startReader(
  path: string,
  keyHex: string,
  opts: { window: number; holdMs?: number; holdEveryMs?: number },
): Promise<ReaderHandle> {
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
            worker.on("message", (m: { type: string; reads: number; maxStatementMs: number }) => {
              if (m.type === "done") done(m);
            });
            Atomics.store(new Int32Array(stop), 0, 1);
          }),
      });
    });
  });
}

describe("writer WAL checkpoints under sustained writes and constant readers", () => {
  const key = randomBytes(32);
  let dbPath: string;
  let scheduler: Scheduler;
  let gate: WriteGate;

  beforeAll(async () => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    const seed = createDatabase(dbPath, { encryptionKey: key }) as unknown as Database.Database;
    try {
      seedPilotCorpus(seed, { docs: DOCS });
      seed.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      seed.close();
    }
    scheduler = new Scheduler({ enablePreemption: true });
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
    gate = writeGateFromScheduler(scheduler);
  }, 900_000);

  afterAll(async () => {
    await scheduler?.dispose();
    cleanupDb(dbPath);
  });

  test("checkpoints stay short, queued writes are served, and the WAL stays bounded", async () => {
    const keyHex = key.toString("hex");
    const readers = await Promise.all([
      startReader(dbPath, keyHex, { window: 300 }),
      startReader(dbPath, keyHex, { window: 1_500 }),
      startReader(dbPath, keyHex, { window: 300, holdMs: 1_500, holdEveryMs: 4_000 }),
    ]);

    const deadline = performance.now() + SECONDS * 1_000;
    let written = 0;
    let revision = 0;
    const writing = (async () => {
      while (performance.now() < deadline) {
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
      while (performance.now() < deadline) {
        const started = performance.now();
        await runWithPriority("user", () =>
          gate.setSyncState(`synth-wal-probe-${seq++ % 8}`, CURSOR, undefined),
        );
        probeMs.push(performance.now() - started);
        await new Promise((r) => setTimeout(r, PROBE_EVERY_MS));
      }
    })();

    let maxWalBytes = 0;
    let shrinks = 0;
    let lastWalBytes = 0;
    const sampler = setInterval(() => {
      const size = existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0;
      maxWalBytes = Math.max(maxWalBytes, size);
      if (size < lastWalBytes) shrinks += 1;
      lastWalBytes = size;
    }, 100);

    await Promise.all([writing, probing]);
    clearInterval(sampler);
    const readerStats = await Promise.all(readers.map((r) => r.stop()));

    const metrics = scheduler.snapshot(3_600).walCheckpoints!;
    const stats = metrics.lifetime;
    const perTask = scheduler.snapshot(900).perTask;
    const upsert = perTask.find((t) => t.name === "db.upsertDocuments");
    const sorted = [...probeMs].sort((a, b) => a - b);
    const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
    process.stdout.write(
      `[wal checkpoint bench] docs=${DOCS} seconds=${SECONDS} written=${written} ` +
        `checkpoints=${stats.runs} maxCheckpointMs=${stats.maxMs.toFixed(0)} totalCheckpointMs=${stats.totalMs.toFixed(0)} ` +
        `rewinds=${stats.rewinds} deferredRewinds=${stats.deferredRewinds} ` +
        `maxWalMiB=${(maxWalBytes / 2 ** 20).toFixed(1)} finalWalMiB=${(lastWalBytes / 2 ** 20).toFixed(1)} walShrinks=${shrinks} ` +
        `probes=${probeMs.length} probeP50=${p(0.5).toFixed(0)}ms probeP99=${p(0.99).toFixed(0)}ms probeMax=${sorted.at(-1)!.toFixed(0)}ms ` +
        `upsertMax=${upsert?.max.toFixed(0)}ms reads=${readerStats.map((r) => r.reads).join("/")}\n`,
    );

    expect(written).toBeGreaterThan(BATCH * 20);
    for (const r of readerStats) expect(r.reads).toBeGreaterThan(10);
    expect(stats.runs).toBeGreaterThan(SECONDS);
    expect(stats.maxMs).toBeLessThan(HOLD_BUDGET_MS);
    expect(sorted.at(-1)!).toBeLessThan(HOLD_BUDGET_MS * 2);
    expect(p(0.99)).toBeLessThan(HOLD_BUDGET_MS);
    expect(stats.rewinds).toBeGreaterThan(0);
    expect(shrinks).toBeGreaterThan(0);
    expect(maxWalBytes).toBeLessThan(WAL_SIZE_LIMIT_BYTES * 2);
    expect(metrics).toMatchObject({ runs: stats.runs, maxMs: stats.maxMs, rewinds: stats.rewinds });
    expect(metrics.p95Ms).toBeLessThanOrEqual(metrics.maxMs);
    expect(metrics.lastLogFrames).toBeGreaterThan(0);
  }, 900_000);
});
