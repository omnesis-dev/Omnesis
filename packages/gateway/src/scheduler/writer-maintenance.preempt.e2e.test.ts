// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The writer's periodic maintenance against a real writer worker, real io
 * workers and an encrypted corpus shaped like a large install.
 *
 * Each op here held the writer for seconds on such an install. The catalog
 * refresh counted every catalog table and scanned its date column on the
 * writer, and the collapsed-candidate sweep resolved both alias sides of every
 * pending candidate there; both now measure on an io reader and hand the
 * writer finished rows. The people backfill, the knowledge cascade and the
 * candidate accept loop over many small units and stopped only for a
 * higher-priority op, so a write queued at their own priority waited out the
 * whole batch; each now gives the writer back once its time slice is spent.
 * Planner statistics are new writer work, analyzed one index at a time.
 *
 * For each op the suite holds one call to what it may cost: a short hold, an
 * unrelated write served promptly behind it, and the whole job done once the
 * calls are. `OMNESIS_WRITER_MAINTENANCE_DOCS` sizes the corpus for a bench.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createLogger } from "@omnesis/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase, openReadOnlyDatabase } from "../db.js";
import { runWithPriority } from "../priority.js";
import { setActiveAlgoVersion } from "../near-dupes/meta.js";
import { BUCKET_DELETE_FOR_DOC_SQL } from "../near-dupes/NearDupWriterOps.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { IoTaskRunner } from "./runners/io.js";
import { writeGateFromScheduler } from "./write-ops.js";
import { ioGateFromScheduler, type IoGate } from "./io-ops.js";
import { catalogRefreshTask } from "./tasks/backfill-tasks.js";
import { sweepCollapsedCandidates } from "./tasks/backfill-helpers.js";
import {
  PILOT_ALGO,
  pilotDocId,
  seedPilotCorpus,
  type PilotCorpus,
} from "./__fixtures__/pilot-corpus.js";
import type { BackfillTaskOptsInternal } from "./tasks/backfill.js";
import type { TaskContext } from "./types.js";
import type { WriteGate } from "../write-gate.js";
import type { SyncCursor } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";

const WRITER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const IO_URL = new URL("../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

/** Documents in the corpus — the pilot held about 640k; a fifth keeps the suite quick. */
const DOCS = Number(process.env.OMNESIS_WRITER_MAINTENANCE_DOCS ?? 120_000);
const UNRESOLVED_DOCS = 400;
const PENDING_CANDIDATES = 3_000;
/** The longest a single call may hold the writer. */
const HOLD_BUDGET_MS = 250;
/**
 * The longest an unrelated write may wait end to end behind a call. It is
 * measured on the caller's side, so it also pays the round trips to the writer
 * thread and whatever the writer runs between ops; on a shared CI runner that
 * alone has pushed it a millisecond past the hold budget. The hold itself stays
 * held to `HOLD_BUDGET_MS`, and an unsliced call still waits far longer than
 * this.
 */
const WAIT_BUDGET_MS = 2 * HOLD_BUDGET_MS;
const CURSOR: SyncCursor = {
  type: "incremental",
  lastSyncTime: "2026-01-05T09:00:00.000Z",
} as SyncCursor;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
}

describe("writer maintenance against a large encrypted corpus", () => {
  const key = randomBytes(32);
  let dbPath: string;
  let corpus: PilotCorpus;
  let scheduler: Scheduler;
  let gate: WriteGate;
  let io: IoGate;
  let read: Database.Database;
  let pressureSeq = 0;

  beforeAll(async () => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    const seed = createDatabase(dbPath, { encryptionKey: key }) as unknown as Database.Database;
    try {
      setActiveAlgoVersion(seed as never, PILOT_ALGO);
      corpus = seedPilotCorpus(seed, {
        docs: DOCS,
        unresolvedDocs: UNRESOLVED_DOCS,
        pendingCandidates: PENDING_CANDIDATES,
        collapsedEvery: 2,
      });
      seed.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      seed.close();
    }
    scheduler = new Scheduler({ enablePreemption: true });
    scheduler.registerRunner(
      new WriterTaskRunner({
        gatewayDbPath: dbPath,
        gatewayDbKeyHex: key.toString("hex"),
        journalMode: "WAL",
        heartbeatIntervalMs: 1_000,
        heartbeatWarnGapMs: 10_000,
        workerUrl: WRITER_URL,
        workerExecArgv: ["--import", LOADER_URL],
      }),
    );
    scheduler.registerRunner(
      new IoTaskRunner({
        gatewayDbPath: dbPath,
        gatewayDbKeyHex: key.toString("hex"),
        concurrency: 2,
        heartbeatIntervalMs: 1_000,
        heartbeatWarnGapMs: 10_000,
        workerUrl: IO_URL,
        workerExecArgv: ["--import", LOADER_URL],
      }),
    );
    await scheduler.start();
    gate = writeGateFromScheduler(scheduler);
    io = ioGateFromScheduler(scheduler);
    read = openReadOnlyDatabase(dbPath, { encryptionKey: key });
  }, 900_000);

  afterAll(async () => {
    read?.close();
    await scheduler?.dispose();
    cleanupDb(dbPath);
  });

  function count(sql: string, ...args: string[]): number {
    return read.prepare<string[], { n: number }>(sql).get(...args)!.n;
  }

  function writerStats(name: string) {
    const stats = scheduler.snapshot(900).perTask.find((t) => t.name === name);
    expect(stats?.count).toBeGreaterThan(0);
    return stats!;
  }

  function report(name: string, wallMs: number): void {
    const stats = writerStats(name);
    process.stdout.write(
      `[writer maintenance bench] docs=${DOCS} op=${name} calls=${stats.count} yields=${stats.yieldCount} p95Hold=${stats.p95.toFixed(0)}ms maxHold=${stats.max.toFixed(0)}ms totalHold=${stats.totalExecMs.toFixed(0)}ms wall=${wallMs.toFixed(0)}ms\n`,
    );
  }

  /**
   * Time a write queued behind an op. A writer op is dispatched when it is
   * enqueued, so it is already inside the writer; an op that starts with io
   * reads gets `settleMs` to reach the writer first.
   */
  async function waitBehind(priority: "user" | "background", settleMs = 0): Promise<number> {
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
    const started = performance.now();
    expect(
      await runWithPriority(priority, () =>
        gate.setSyncState(`synth-pressure-${pressureSeq++}`, CURSOR, undefined),
      ),
    ).toBe(true);
    return performance.now() - started;
  }

  test("the catalog is measured on io readers and the writer only stores the rows", async () => {
    const task = catalogRefreshTask({
      writeGate: gate,
      ioGate: io,
      log: createLogger("test:catalog"),
      catalogRefreshIntervalMs: 300_000,
    } as unknown as BackfillTaskOptsInternal);
    const started = performance.now();
    const refreshing = runWithPriority("background", () => task.run(undefined, {} as TaskContext));
    const waited = await waitBehind("user", 30);
    await refreshing;
    report("catalog.upsertSqliteTableStats", performance.now() - started);
    expect(waited).toBeLessThan(WAIT_BUDGET_MS);
    expect(writerStats("catalog.upsertSqliteTableStats").max).toBeLessThan(HOLD_BUDGET_MS);
    expect(
      scheduler.snapshot(900).perTask.some((t) => t.name === "catalog.refreshSqliteTableStats"),
    ).toBe(false);
    const stored = (table: string) =>
      read
        .prepare<[string], { row_count: number }>(
          "SELECT row_count FROM catalog_table_stats WHERE table_name = ?",
        )
        .get(table)!.row_count;
    expect(stored("documents")).toBe(DOCS);
    expect(stored("document_people")).toBe(count("SELECT COUNT(*) AS n FROM document_people"));
    expect(stored("person_aliases")).toBe(count("SELECT COUNT(*) AS n FROM person_aliases"));
  }, 600_000);

  test("collapsed candidates are found on a reader and accepted in bounded chunks", async () => {
    const accepted = () =>
      count("SELECT COUNT(*) AS n FROM merge_candidates WHERE status = 'accepted'");
    const acceptedBefore = accepted();
    const started = performance.now();
    const sweeping = runWithPriority("background", () => sweepCollapsedCandidates(io, gate));
    const { swept } = await sweeping;
    report("people.acceptCollapsedMergeCandidates", performance.now() - started);
    expect(swept).toBe(corpus.collapsedCandidateIds.length);
    expect(accepted() - acceptedBefore).toBe(swept);
    expect(writerStats("people.acceptCollapsedMergeCandidates").max).toBeLessThan(HOLD_BUDGET_MS);
    expect(
      scheduler
        .snapshot(900)
        .perTask.some((t) => t.name === "people.sweepCollapsedMergeCandidates"),
    ).toBe(false);
  }, 600_000);

  test("a people backfill batch gives the writer back between slices and finishes", async () => {
    const started = performance.now();
    const backfilling = runWithPriority("background", () =>
      gate.backfillManyPeople(UNRESOLVED_DOCS),
    );
    const waited = await waitBehind("background");
    const result = await backfilling;
    report("people.backfillManyPeople", performance.now() - started);
    expect(result.processed).toBe(UNRESOLVED_DOCS);
    expect(count("SELECT COUNT(*) AS n FROM documents WHERE people_resolved_at IS NULL")).toBe(0);
    expect(waited).toBeLessThan(WAIT_BUDGET_MS);
    const stats = writerStats("people.backfillManyPeople");
    expect(stats.yieldCount).toBeGreaterThan(0);
    expect(stats.max).toBeLessThan(HOLD_BUDGET_MS);
  }, 600_000);

  test("a full cascade step budget stays inside the hold and lets a same-priority write in", async () => {
    const before = count("SELECT COUNT(*) AS n FROM knowledge_cascade_jobs");
    expect(before).toBeGreaterThan(1_000);
    const started = performance.now();
    const cascading = runWithPriority("background", () =>
      gate["knowledge.advanceCascade"](1_000, Date.now()),
    );
    const waited = await waitBehind("background");
    expect((await cascading).pending).toBe(true);
    for (let i = 0; i < 5; i++)
      await runWithPriority("background", () =>
        gate["knowledge.advanceCascade"](1_000, Date.now()),
      );
    report("knowledge.advanceCascade", performance.now() - started);
    expect(before - count("SELECT COUNT(*) AS n FROM knowledge_cascade_jobs")).toBeGreaterThan(5);
    expect(waited).toBeLessThan(WAIT_BUDGET_MS);
    expect(writerStats("knowledge.advanceCascade").max).toBeLessThan(HOLD_BUDGET_MS);
  }, 600_000);

  test("planner statistics are analyzed one bounded unit at a time and change the plan", async () => {
    const unpinned = BUCKET_DELETE_FOR_DOC_SQL.replace(" INDEXED BY idx_near_dup_lsh_doc", "");
    const plan = (db: Database.Database) =>
      (
        db.prepare(`EXPLAIN QUERY PLAN ${unpinned}`).all(pilotDocId(6), PILOT_ALGO) as Array<{
          detail: string;
        }>
      )
        .map((r) => r.detail)
        .join("\n");
    expect(plan(read)).not.toMatch(/idx_near_dup_lsh_doc/);

    const started = performance.now();
    const analyzing = runWithPriority("background", () => gate.refreshPlannerStatistics());
    const waited = await waitBehind("background");
    const { analyzed } = await analyzing;
    report("db.refreshPlannerStatistics", performance.now() - started);
    expect(analyzed).toBeGreaterThan(50);
    expect(waited).toBeLessThan(WAIT_BUDGET_MS);
    const stats = writerStats("db.refreshPlannerStatistics");
    expect(stats.yieldCount).toBeGreaterThan(0);
    expect(stats.max).toBeLessThan(HOLD_BUDGET_MS);
    expect(count("SELECT COUNT(DISTINCT tbl) AS n FROM sqlite_stat1")).toBeGreaterThanOrEqual(15);

    const fresh = openReadOnlyDatabase(dbPath, { encryptionKey: key });
    try {
      expect(plan(fresh)).toMatch(/SEARCH near_dup_lsh_buckets USING INDEX idx_near_dup_lsh_doc/);
    } finally {
      fresh.close();
    }
    expect(
      (await runWithPriority("background", () => gate.refreshPlannerStatistics())).analyzed,
    ).toBe(0);
  }, 600_000);
});
