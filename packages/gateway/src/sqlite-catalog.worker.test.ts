// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The catalog statistics read on the real io worker against a temp database:
 * the worker returns what the same read returns on a direct handle, so the
 * periodic refresh can hand the writer rows it never had to compute.
 *
 * All fixture data is invented.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "./db.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { IoTaskRunner } from "./scheduler/runners/io.js";
import { ioGateFromScheduler, type IoGate } from "./scheduler/io-ops.js";
import { SQLITE_CATALOG_TABLES, computeSqliteTableStats } from "./sqlite-catalog.js";
import type Database from "better-sqlite3";

const WORKER_URL = new URL("./workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("./workers/register-tsx.mjs", import.meta.url).href;

let dbPath: string;
let db: Database.Database;
let scheduler: Scheduler;
let io: IoGate;

beforeEach(async () => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath) as unknown as Database.Database;
  const insert = db.prepare(
    `INSERT INTO people (id, canonical_name, source, first_seen, last_seen, created_at, updated_at)
     VALUES (?, 'fixture person', 'fixture', ?, ?, ?, ?)`,
  );
  insert.run("p-1", "2023-04-01", "2025-01-01", "2023-04-01", "2023-04-01");
  insert.run("p-2", "2021-09-12", "2024-01-01", "2021-09-12", "2021-09-12");
  scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: dbPath,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  io = ioGateFromScheduler(scheduler);
});

afterEach(async () => {
  await scheduler.dispose();
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
});

it("reads the same statistics on the worker as on the handle", async () => {
  for (const tableName of SQLITE_CATALOG_TABLES) {
    const direct = computeSqliteTableStats(db, tableName);
    const viaWorker = await io.sqliteTableStats(tableName);
    expect(viaWorker === null).toBe(direct === null);
    if (direct && viaWorker) {
      const { computedAt: _directAt, ...directStats } = direct;
      const { computedAt: _workerAt, ...workerStats } = viaWorker;
      expect(workerStats).toEqual(directStats);
    }
  }
  expect(await io.sqliteTableStats("people")).toMatchObject({
    recordCount: 2,
    earliestDate: "2021-09-12",
    latestDate: "2023-04-01",
  });
  expect(await io.sqliteTableStats("no_such_table")).toBeNull();
});
