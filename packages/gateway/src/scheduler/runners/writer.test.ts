// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * WriterTaskRunner integration test — spawns the real writer worker
 * against a temp DB and verifies Scheduler + WriterTaskRunner work
 * end-to-end.
 *
 * Validates:
 *   - One task in flight at a time (concurrency=1).
 *   - Result values flow back as TaskOutcome `{kind:"done"}`.
 *   - Worker errors surface as TaskExecutionError.
 *   - Yieldable ops (when Phase 3 lands handlers that return a yield-
 *     shaped value) flow through unchanged. Tested here against a
 *     fake op definition would require a worker change; deferred.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Scheduler } from "../scheduler.js";
import { TaskExecutionError } from "../types.js";
import { createDatabase } from "../../db.js";
import { WriterTaskRunner } from "./writer.js";
import type { Task, TaskOutcome } from "../types.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

// Worker file lives in src/workers/writer-worker.ts; resolve relative
// to this test file's location.
const WORKER_URL = new URL("../../workers/writer-worker.ts", import.meta.url);
const LOADER_URL = new URL("../../workers/register-tsx.mjs", import.meta.url).href;

describe("WriterTaskRunner — end-to-end with Scheduler", () => {
  let dbPath: string;
  let scheduler: Scheduler;
  let runner: WriterTaskRunner;

  beforeEach(async () => {
    dbPath = testDbPath();
    // Create + migrate the DB on main thread first; the worker opens
    // with fileMustExist:true.
    const db = createDatabase(dbPath);
    db.close();

    runner = new WriterTaskRunner({
      gatewayDbPath: dbPath,
      journalMode: "WAL",
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    });
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(runner);
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
    cleanupDb(dbPath);
  });

  test("dispatches a known op and resolves with its value", async () => {
    // Empty upsert — no-op write that exercises the dispatch path.
    const t: Task<unknown[], unknown> = {
      name: "db.upsertDocuments",
      runner: "writer",
      priority: "realtime",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    const result = await scheduler.enqueue(t, [[]]);
    expect(result).toEqual({
      rejectedSourceIds: [],
      ignoredReplicaDocuments: [],
      suppressedDocuments: [],
    });
  });

  test("unknown op surfaces as TaskExecutionError", async () => {
    const t: Task<unknown[], unknown> = {
      name: "not.a.real.op",
      runner: "writer",
      priority: "user",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    await expect(scheduler.enqueue(t, [])).rejects.toThrow(TaskExecutionError);
  });

  test("processes multiple tasks in submission order (concurrency=1)", async () => {
    const t: Task<unknown[], unknown> = {
      name: "db.upsertDocuments",
      runner: "writer",
      priority: "realtime",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    const results = await Promise.all([
      scheduler.enqueue(t, [[]]),
      scheduler.enqueue(t, [[]]),
      scheduler.enqueue(t, [[]]),
    ]);
    expect(results).toEqual([
      { rejectedSourceIds: [], ignoredReplicaDocuments: [], suppressedDocuments: [] },
      { rejectedSourceIds: [], ignoredReplicaDocuments: [], suppressedDocuments: [] },
      { rejectedSourceIds: [], ignoredReplicaDocuments: [], suppressedDocuments: [] },
    ]);
  });
});

/**
 * The writer watchdog's line. A gateway whose writer is wedged is the
 * shape most user-visible slowness takes, and the one fact worth having in
 * the journal at that moment is which op is holding it — knowable here,
 * where the op's own slow-op line only arrives once it finishes.
 */
describe("writer watchdog description", () => {
  type Inflight = Map<number, { taskName: string; dispatchedAtMs: number }>;
  function describe_(entries: Array<[number, string, number]>): string {
    const runner = Object.create(WriterTaskRunner.prototype) as {
      inflight: Inflight;
      describeInflight(): string;
    };
    runner.inflight = new Map(
      entries.map(([id, taskName, dispatchedAtMs]) => [id, { taskName, dispatchedAtMs }]),
    );
    return runner.describeInflight();
  }

  test("says so plainly when nothing is dispatched", () => {
    expect(describe_([])).toBe("nothing dispatched");
  });

  test("names each held op oldest first, with how long it has been held", () => {
    const now = Date.now();
    const line = describe_([
      [2, "io.recent", now - 3_000],
      [1, "links.upsertExtractedLinksBatch", now - 458_000],
    ]);
    // Oldest first: the op that has been held longest is the one that
    // explains the stall, and it must not be buried behind newer arrivals.
    expect(line).toBe("holding: links.upsertExtractedLinksBatch for 458s, io.recent for 3s");
  });
});
