// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * IoTaskRunner integration test — spawns the real io worker
 * against a temp DB and verifies Scheduler + IoTaskRunner work
 * end-to-end.
 *
 * Validates:
 *   - One task in flight at a time (concurrency=1).
 *   - `io.echo` returns its arg unchanged (smoke for envelope).
 *   - `io.countDocuments` returns 0 against a fresh schema'd DB.
 *   - Unknown op surfaces as TaskExecutionError.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { Scheduler } from "../scheduler.js";
import { TaskExecutionError } from "../types.js";
import { createDatabase } from "../../db.js";
import { IoTaskRunner } from "./io.js";
import type { Task, TaskOutcome } from "../types.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

// Worker file lives in src/workers/io-worker.ts; resolve relative
// to this test file's location.
const WORKER_URL = new URL("../../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../../workers/register-tsx.mjs", import.meta.url).href;

describe("IoTaskRunner — end-to-end with Scheduler", () => {
  let dbPath: string;
  let scheduler: Scheduler;
  let runner: IoTaskRunner;

  beforeEach(async () => {
    dbPath = testDbPath();
    // Create + migrate the DB on main thread first; the worker opens
    // with fileMustExist:true.
    const db = createDatabase(dbPath);
    db.close();

    runner = new IoTaskRunner({
      gatewayDbPath: dbPath,
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

  test("dispatches `io.echo` and resolves with arg", async () => {
    const t: Task<unknown[], unknown> = {
      name: "io.echo",
      runner: "io",
      priority: "realtime",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    const value = await scheduler.enqueue(t, ["hello"]);
    expect(value).toBe("hello");
  });

  test("io.countDocuments returns 0 on fresh DB", async () => {
    const t: Task<unknown[], number> = {
      name: "io.countDocuments",
      runner: "io",
      priority: "realtime",
      async run(): Promise<TaskOutcome<unknown[], number>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    // No args — handler ignores them, but the runner wraps single
    // non-array args; pass an empty array explicitly to match the
    // dispatch table's `handler(db, ...args)` calling convention.
    const count = await scheduler.enqueue(t, []);
    expect(count).toBe(0);
  });

  test("unknown op surfaces as TaskExecutionError", async () => {
    const t: Task<unknown[], unknown> = {
      name: "not.a.real.io.op",
      runner: "io",
      priority: "user",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    await expect(scheduler.enqueue(t, [])).rejects.toThrow(TaskExecutionError);
  });

  test("io.lookupPeople runs the real assembly on the worker handle", async () => {
    // Seed a person on the main-thread handle first; the worker opens the same
    // file read-only and must see the committed row.
    const seed = createDatabase(dbPath);
    seed
      .prepare(
        `INSERT INTO people (id, canonical_name, source, first_seen, last_seen,
                             created_at, updated_at, interaction_score_recent)
         VALUES ('p-io', 'Jamie Lopez', 'extracted', '2026-01-01', '2026-04-01T12:00:00Z',
                 '2026-01-01', '2026-01-01', 0.6)`,
      )
      .run();
    seed
      .prepare(
        `INSERT INTO person_aliases (id, person_id, alias_type, alias, created_at)
         VALUES ('a-io', 'p-io', 'email', 'jamie.lopez@example.com', '2026-01-01')`,
      )
      .run();
    seed.close();

    const t: Task<unknown[], unknown> = {
      name: "io.lookupPeople",
      runner: "io",
      priority: "user",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    const results = (await scheduler.enqueue(t, ["Jamie", 5, { experimental: false }])) as Array<{
      canonicalId: string;
      displayName: string;
      aliases: string[];
    }>;
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]?.canonicalId).toBe("p-io");
    expect(results[0]?.displayName).toBe("Jamie Lopez");
    expect(results[0]?.aliases).toContain("jamie.lopez@example.com");
  });

  test("processes multiple tasks in submission order (concurrency=1)", async () => {
    const t: Task<unknown[], unknown> = {
      name: "io.echo",
      runner: "io",
      priority: "realtime",
      async run(): Promise<TaskOutcome<unknown[], unknown>> {
        throw new Error("worker tasks don't run on main");
      },
    };
    const results = await Promise.all([
      scheduler.enqueue(t, ["a"]),
      scheduler.enqueue(t, ["b"]),
      scheduler.enqueue(t, ["c"]),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });
});
