// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The knowledge cascade against a real writer worker and an ingest-sized
 * backlog.
 *
 * Every document write that passes the knowledge source triggers queues one
 * invalidation job, on every install and with the Brain off, and the
 * `knowledge.cascade` periodic drains them a bounded slice at a time. The slice
 * was bounded in steps but not in cost: each step picked its row through a
 * join sorted over every pending row, so after a large ingest one slice held
 * the writer for tens of seconds and every other write on the gateway queued
 * behind it. This suite seeds a backlog the size of a large mailbox and drive
 * library, of invented sources, and holds the writer op to what a slice may
 * cost: a short hold, an unrelated write that is served promptly behind it,
 * a preempt seam that stops a slice after the step it is on, and a time slice
 * that stops a large step budget before it outlasts the hold.
 *
 * Like the link-apply preemption suite, it runs a Scheduler with preemption
 * and a real `WriterTaskRunner` against a temp DB, with no gateway process,
 * so a yield can be forced in the same synchronous turn as the dispatch.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
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
/** The longest a single cascade slice may hold the writer. */
const SLICE_HOLD_BUDGET_MS = 250;
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
  const db = createDatabase(path);
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
  let gate: WriteGate;
  let read: Database.Database;
  let pressureSeq = 0;

  beforeAll(async () => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    seedBacklog(dbPath);
    scheduler = new Scheduler({ enablePreemption: true });
    scheduler.registerRunner(
      new WriterTaskRunner({
        gatewayDbPath: dbPath,
        journalMode: "WAL",
        heartbeatIntervalMs: 1_000,
        heartbeatWarnGapMs: 10_000,
        workerUrl: WORKER_URL,
        workerExecArgv: ["--import", LOADER_URL],
      }),
    );
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

  function slice(limit = SLICE) {
    return runWithPriority("background", () => gate["knowledge.advanceCascade"](limit, NOW));
  }

  async function unrelatedWrite(): Promise<boolean> {
    return runWithPriority("user", () =>
      gate.setSyncState(`synth-pressure-${pressureSeq++}`, CURSOR, undefined),
    );
  }

  test("each slice drains its full step budget inside the hold budget", async () => {
    const before = pendingJobs();
    for (let i = 0; i < 10; i++) expect((await slice()).pending).toBe(true);
    expect(before - pendingJobs()).toBe(10 * SLICE);
    const stats = scheduler
      .snapshot(300)
      .perTask.find((task) => task.name === "knowledge.advanceCascade");
    expect(stats?.count).toBeGreaterThanOrEqual(10);
    expect(stats!.max).toBeLessThan(SLICE_HOLD_BUDGET_MS);
  });

  test("an unrelated write queued behind a slice is served promptly", async () => {
    const cascade = slice();
    const started = performance.now();
    expect(await unrelatedWrite()).toBe(true);
    const waited = performance.now() - started;
    await cascade;
    expect(waited).toBeLessThan(SLICE_HOLD_BUDGET_MS);
  });

  test("a preempted slice stops after the step it is on and leaves the rest pending", async () => {
    const before = pendingJobs();
    const cascade = slice(1000);
    const pressure = unrelatedWrite();
    const result = await cascade;
    expect(await pressure).toBe(true);
    expect(result.pending).toBe(true);
    expect(before - pendingJobs()).toBe(1);
  });

  test("an unpreempted large budget stops at its time slice and leaves the rest pending", async () => {
    const before = pendingJobs();
    expect((await slice(1000)).pending).toBe(true);
    const drained = before - pendingJobs();
    expect(drained).toBeGreaterThan(1);
    expect(drained).toBeLessThanOrEqual(1000);
    const stats = scheduler
      .snapshot(300)
      .perTask.find((task) => task.name === "knowledge.advanceCascade");
    expect(stats!.max).toBeLessThan(SLICE_HOLD_BUDGET_MS);
  });
});
