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
 * For each op the suite holds one call to what it may do, without a
 * stopwatch: the work stays where it belongs (an io reader or the writer), a
 * sliced call gives the writer back while it still has work so a write queued
 * at its own priority finishes first, a call never runs past its unit budget,
 * and the whole job is done once the calls are. A measured hold also measures
 * the machine, its commits' fsyncs and the scheduling of two threads, so the
 * holds and waits are printed for a bench and never asserted; the handlers'
 * time slices are pinned with a fake clock in `writer-batch-slices.test.ts`
 * and `cascade-order.test.ts`. `OMNESIS_WRITER_MAINTENANCE_DOCS` sizes the
 * corpus for a bench.
 */

import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { createLogger } from "@omnesis/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  KNOWLEDGE_CASCADE_NEXT_JOB_SQL,
  KNOWLEDGE_CASCADE_NEXT_ROW_SQL,
} from "../brain/knowledge/storage-invalidation.js";
import { createDatabase, openReadOnlyDatabase } from "../db.js";
import { runWithPriority } from "../priority.js";
import { setActiveAlgoVersion } from "../near-dupes/meta.js";
import { BUCKET_DELETE_FOR_DOC_SQL } from "../near-dupes/NearDupWriterOps.js";
import { sqlitePerformanceDatabasePath } from "../../test/sqlite-performance-temp.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { IoTaskRunner } from "./runners/io.js";
import { writeGateFromScheduler } from "./write-ops.js";
import { ioGateFromScheduler, type IoGate } from "./io-ops.js";
import { catalogRefreshTask } from "./tasks/backfill-tasks.js";
import { sweepCollapsedCandidates } from "./tasks/backfill-helpers.js";
import {
  CORPUS_ALGO,
  corpusDocId,
  seedLargeCorpus,
  type LargeCorpus,
} from "./__fixtures__/large-corpus.js";
import type { BackfillTaskOptsInternal } from "./tasks/backfill.js";
import type { TaskContext } from "./types.js";
import type { WriteGate } from "../write-gate.js";
import type { SyncCursor } from "@omnesis/source-sdk";
import type Database from "better-sqlite3";

const WRITER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const IO_URL = new URL("../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

/** Documents in the corpus: enough to make a whole-table pass slow, few enough to keep the suite quick. */
const DOCS = Number(process.env.OMNESIS_WRITER_MAINTENANCE_DOCS ?? 120_000);
const UNRESOLVED_DOCS = 400;
const PENDING_CANDIDATES = 3_000;
/**
 * The average hold a call aims for, printed beside each op's measured holds for
 * a bench to compare. Not asserted: a shared runner has measured a 254 ms
 * average and a 621 ms single hold from ops whose slicing was intact.
 */
const HOLD_BUDGET_MS = 250;
/**
 * The worst single hold a bench should see, printed beside the measured one.
 * One statement can't be sliced, and a call that does not slice at all holds
 * for seconds: the people backfill held 6.6 s as one call and planner
 * statistics 1.1 s.
 */
const WORST_HOLD_MS = 4 * HOLD_BUDGET_MS;
/** The cascade's step budget per call, the largest `knowledge.advanceCascade` accepts. */
const CASCADE_STEPS = 1_000;

/** Whether `op` has yet to settle, read after awaiting something queued behind it. */
function stillRunning(op: unknown): () => boolean {
  let running = true;
  const settled = () => {
    running = false;
  };
  void Promise.resolve(op).then(settled, settled);
  return () => running;
}
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
  let corpus: LargeCorpus;
  let scheduler: Scheduler;
  let gate: WriteGate;
  let io: IoGate;
  let read: Database.Database;
  let pressureSeq = 0;

  beforeAll(async () => {
    dbPath = sqlitePerformanceDatabasePath();
    const seed = createDatabase(dbPath, { encryptionKey: key }) as unknown as Database.Database;
    try {
      setActiveAlgoVersion(seed as never, CORPUS_ALGO);
      corpus = seedLargeCorpus(seed, {
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

  function explain(sql: string, ...args: unknown[]): string[] {
    return read
      .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...args)
      .map((row) => row.detail);
  }

  function writerStats(name: string) {
    const stats = scheduler.snapshot(900).perTask.find((t) => t.name === name);
    expect(stats?.count).toBeGreaterThan(0);
    return stats!;
  }

  /** Print an op's measured holds, and the wait of the write queued behind it, for a bench. */
  function report(name: string, wallMs: number, waitedMs?: number): void {
    const stats = writerStats(name);
    const avgHold = stats.totalExecMs / stats.count;
    const waited = waitedMs === undefined ? "" : ` wait=${waitedMs.toFixed(0)}ms`;
    process.stdout.write(
      `[writer maintenance bench] docs=${DOCS} op=${name} calls=${stats.count} yields=${stats.yieldCount} avgHold=${avgHold.toFixed(0)}ms (aim ${HOLD_BUDGET_MS}ms) p95Hold=${stats.p95.toFixed(0)}ms maxHold=${stats.max.toFixed(0)}ms (aim ${WORST_HOLD_MS}ms) totalHold=${stats.totalExecMs.toFixed(0)}ms wall=${wallMs.toFixed(0)}ms${waited}\n`,
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
    report("catalog.upsertSqliteTableStats", performance.now() - started, waited);
    // The writer's whole share of the refresh is one call storing finished rows.
    expect(writerStats("catalog.upsertSqliteTableStats").count).toBe(1);
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
    const backfillRunning = stillRunning(backfilling);
    const waited = await waitBehind("background");
    expect(backfillRunning()).toBe(true);
    const result = await backfilling;
    report("people.backfillManyPeople", performance.now() - started, waited);
    expect(result.processed).toBe(UNRESOLVED_DOCS);
    expect(count("SELECT COUNT(*) AS n FROM documents WHERE people_resolved_at IS NULL")).toBe(0);
    expect(writerStats("people.backfillManyPeople").yieldCount).toBeGreaterThan(0);
  }, 600_000);

  test("a full cascade step budget stops within its steps and lets a same-priority write in", async () => {
    const jobs = () => count("SELECT COUNT(*) AS n FROM knowledge_cascade_jobs");
    const before = jobs();
    expect(before).toBeGreaterThan(6 * CASCADE_STEPS);
    // A call's hold is its steps times the cost of a step. A step picks its row
    // from this backlog with index seeks only, so it costs the same however
    // many jobs wait.
    const firstJob = read
      .prepare<[], { id: number }>("SELECT MIN(id) AS id FROM knowledge_cascade_jobs")
      .get()!.id;
    const plans = [
      ...explain(KNOWLEDGE_CASCADE_NEXT_JOB_SQL, "purge"),
      ...explain(KNOWLEDGE_CASCADE_NEXT_JOB_SQL, "invalidate"),
      ...explain(KNOWLEDGE_CASCADE_NEXT_ROW_SQL, firstJob),
    ];
    expect(plans.length).toBeGreaterThan(0);
    for (const detail of plans) {
      expect(detail).toMatch(/^SEARCH /);
      expect(detail).not.toMatch(/TEMP B-TREE/);
    }
    const advance = () =>
      runWithPriority("background", () =>
        gate["knowledge.advanceCascade"](CASCADE_STEPS, Date.now()),
      );
    const started = performance.now();
    const cascading = advance();
    const waited = await waitBehind("background");
    expect((await cascading).pending).toBe(true);
    // Each job here is one invalidated source with no dependents, so it is
    // finished in one step: a call that drains more jobs than its step budget
    // ran past that budget.
    const drained = [before - jobs()];
    for (let i = 0; i < 5; i++) {
      const pending = jobs();
      expect((await advance()).pending).toBe(true);
      drained.push(pending - jobs());
    }
    report("knowledge.advanceCascade", performance.now() - started, waited);
    for (const steps of drained) {
      expect(steps).toBeGreaterThan(0);
      expect(steps).toBeLessThanOrEqual(CASCADE_STEPS);
    }
  }, 600_000);

  test("planner statistics are analyzed one bounded unit at a time and change the plan", async () => {
    const unpinned = BUCKET_DELETE_FOR_DOC_SQL.replace(" INDEXED BY idx_near_dup_lsh_doc", "");
    const plan = (db: Database.Database) =>
      (
        db.prepare(`EXPLAIN QUERY PLAN ${unpinned}`).all(corpusDocId(6), CORPUS_ALGO) as Array<{
          detail: string;
        }>
      )
        .map((r) => r.detail)
        .join("\n");
    expect(plan(read)).not.toMatch(/idx_near_dup_lsh_doc/);

    const started = performance.now();
    const analyzing = runWithPriority("background", () => gate.refreshPlannerStatistics());
    const analyzeRunning = stillRunning(analyzing);
    const waited = await waitBehind("background");
    expect(analyzeRunning()).toBe(true);
    const { analyzed } = await analyzing;
    report("db.refreshPlannerStatistics", performance.now() - started, waited);
    expect(analyzed).toBeGreaterThan(50);
    expect(writerStats("db.refreshPlannerStatistics").yieldCount).toBeGreaterThan(0);
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
