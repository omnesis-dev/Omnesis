// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The knowledge cascade against a real writer worker and an ingest-sized
 * backlog.
 *
 * Every document write that passes the knowledge source triggers queues one
 * invalidation job, on every install and with the Brain off, and the
 * `knowledge.cascade` periodic drains them a bounded slice at a time. A slice
 * that sorted every pending row on each step would hold the writer for tens of
 * seconds after a large ingest, with every other write on the gateway queued
 * behind it. This suite seeds a backlog the size of a large mailbox and drive
 * library, of invented sources, and asserts what keeps a slice short there:
 * slices advance within their step budget and leave the rest pending, a step
 * picks its row from the backlog with index seeks only, and a write queued
 * behind a slice stops it after the step it is on.
 *
 * Nothing here is timed. A stopwatch around a writer op also measures the
 * machine: the commit's WAL fsync and the scheduling of two threads, which no
 * slice can bound and which a shared runner occasionally stretches. The hold's
 * own factors are asserted without one in `cascade-order.test.ts`: every
 * statement a step runs is index-served, and the writer handler's time slice
 * stops a large budget once its clock says the slice is spent.
 *
 * It runs a Scheduler with preemption and a real `WriterTaskRunner` against
 * a temp DB, with no gateway process. A barrier holds the runner's dispatch
 * until the higher-priority write has requested a yield: the worker must not
 * race ahead of that signal while the main thread is descheduled.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  KNOWLEDGE_CASCADE_NEXT_JOB_SQL,
  KNOWLEDGE_CASCADE_NEXT_ROW_SQL,
} from "../brain/knowledge/storage-invalidation.js";
import { createFreshTestDatabase } from "../testing/fresh-database.js";
import { runWithPriority } from "../priority.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { writeGateFromScheduler } from "./write-ops.js";
import type { WriteGate } from "../write-gate.js";
import type { SyncCursor } from "@omnesis/source-sdk";

const WORKER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

/** Pending invalidation jobs, one per invented source revision. */
const BACKLOG = 200_000;
const SLICE = 100;
const NOW = 1_800_000_000_000;
const CURSOR: SyncCursor = {
  type: "incremental",
  lastSyncTime: "2026-01-05T09:00:00.000Z",
} as SyncCursor;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
}

/** Seed with a plain handle and close it before the writer opens the file. */
function seedBacklog(path: string): void {
  const db = createFreshTestDatabase(path);
  try {
    const insertJob = db.prepare(
      "INSERT INTO knowledge_cascade_jobs(kind,target_kind,target_id,revision,created_at) VALUES(?,'source',?,?,?)",
    );
    const insertRow = db.prepare(
      "INSERT INTO knowledge_cascade_frontier(job_id,target_kind,target_id) VALUES(?,'source',?)",
    );
    db.transaction(() => {
      for (let i = 0; i < BACKLOG; i++) {
        const source = `synth-drive-file-${i.toString(36).padStart(6, "0")}`;
        const kind = i % 5000 === 4999 ? "purge" : "invalidate";
        const revision = kind === "purge" ? "deleted" : `rev-${(i * 2654435761) >>> 0}`;
        insertRow.run(insertJob.run(kind, source, revision, NOW).lastInsertRowid, source);
      }
    })();
  } finally {
    db.close();
  }
}

describe("knowledge cascade on the writer against an ingest backlog", () => {
  let dbPath: string;
  let scheduler: Scheduler;
  let writer: WriterTaskRunner;
  let gate: WriteGate;
  let read: Database.Database;
  let pressureSeq = 0;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
    seedBacklog(dbPath);
    scheduler = new Scheduler({ enablePreemption: true });
    writer = new WriterTaskRunner({
      gatewayDbPath: dbPath,
      journalMode: "WAL",
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    });
    scheduler.registerRunner(writer);
    await scheduler.start();
    gate = writeGateFromScheduler(scheduler);
    read = new Database(dbPath, { readonly: true });
  }, 120_000);

  afterAll(async () => {
    read?.close();
    await scheduler?.dispose();
    cleanupDb(dbPath);
  });

  function pendingJobs(): number {
    return read
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM knowledge_cascade_jobs")
      .get()!.n;
  }

  function plan(sql: string, ...args: unknown[]): string[] {
    return read
      .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...args)
      .map((row) => row.detail);
  }

  function slice(limit = SLICE) {
    return runWithPriority("background", () => gate["knowledge.advanceCascade"](limit, NOW));
  }

  async function unrelatedWrite(): Promise<boolean> {
    return runWithPriority("user", () =>
      gate.setSyncState(`synth-pressure-${pressureSeq++}`, CURSOR, undefined),
    );
  }

  test("slices of any budget advance through the backlog and leave the rest pending", async () => {
    for (const limit of [...Array<number>(10).fill(SLICE), 1000]) {
      const before = pendingJobs();
      expect((await slice(limit)).pending).toBe(true);
      const drained = before - pendingJobs();
      expect(drained).toBeGreaterThanOrEqual(1);
      expect(drained).toBeLessThanOrEqual(limit);
    }
  });

  test("a step picks its row from this backlog with index seeks only", () => {
    const plans = [
      ...plan(KNOWLEDGE_CASCADE_NEXT_JOB_SQL, "purge"),
      ...plan(KNOWLEDGE_CASCADE_NEXT_JOB_SQL, "invalidate"),
      ...plan(KNOWLEDGE_CASCADE_NEXT_ROW_SQL, 1),
    ];
    expect(plans.length).toBeGreaterThan(0);
    for (const detail of plans) {
      expect(detail).toMatch(/^SEARCH /);
      expect(detail).not.toMatch(/TEMP B-TREE/);
    }
  });

  test.each([SLICE, 1000])(
    "a write queued behind a slice of %i steps stops it after the step it is on and is served",
    async (limit) => {
      const before = pendingJobs();
      const release = Promise.withResolvers<void>();
      const exec = writer.exec.bind(writer);
      const held = vi.spyOn(writer, "exec").mockImplementationOnce(async (...args) => {
        await release.promise;
        return exec(...args);
      });
      const cascade = slice(limit);
      let pressure: Promise<boolean> | undefined;
      try {
        expect(held).toHaveBeenCalledOnce();
        const preemptRequests = scheduler.preemptRequestCount;
        pressure = unrelatedWrite();
        expect(scheduler.preemptRequestCount).toBe(preemptRequests + 1);
        expect(scheduler.getPreemptBuffer("writer")?.isRequested()).toBe(true);
        release.resolve();
        const result = await cascade;
        expect(await pressure).toBe(true);
        expect(result.pending).toBe(true);
        expect(before - pendingJobs()).toBe(1);
      } finally {
        release.resolve();
        await Promise.allSettled([cascade, pressure]);
        held.mockRestore();
      }
    },
  );
});
