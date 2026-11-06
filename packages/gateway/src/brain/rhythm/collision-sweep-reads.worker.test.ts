// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The collision sweep's candidate selection, run on the real io worker against
 * a temp database: each read returns exactly what it returns on a direct
 * handle, and a whole sweep reading through the worker enqueues exactly the
 * runs a sweep reading the handle does, so moving the selection off the main
 * event loop changes nothing the Brain is asked to judge.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { Scheduler } from "../../scheduler/scheduler.js";
import { IoTaskRunner } from "../../scheduler/runners/io.js";
import { ioGateFromScheduler } from "../../scheduler/io-ops.js";
import { directReadPort } from "../../scheduler/read-port.js";
import { COLLISION_SWEEP_READS, type CollisionSweepReads } from "./collision-sweep-reads.js";
import {
  FIXTURE_NOW,
  FIXTURE_SELF,
  recordSweep,
  seedEdgeFixture,
  seedLargeFixture,
  seedSmallFixture,
} from "./collision-sweep-test-utils.js";
import type Database from "better-sqlite3";

const WORKER_URL = new URL("../../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../../workers/register-tsx.mjs", import.meta.url).href;

const FIXTURES: Record<string, (db: Database.Database) => void> = {
  empty: () => {},
  small: seedSmallFixture,
  edge: seedEdgeFixture,
  large: (db) => seedLargeFixture(db),
};

describe.each(Object.keys(FIXTURES))("the %s fixture on the io worker", (name) => {
  let dbPath: string;
  let db: Database.Database;
  let scheduler: Scheduler;
  let worker: CollisionSweepReads;
  let direct: CollisionSweepReads;

  beforeAll(async () => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(dbPath) as unknown as Database.Database;
    FIXTURES[name]!(db);
    direct = directReadPort(COLLISION_SWEEP_READS, db);
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
    worker = ioGateFromScheduler(scheduler);
  });

  afterAll(async () => {
    await scheduler.dispose();
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  });

  it("selects the same loop, temporal and contradiction candidates as the handle", async () => {
    for (const limit of [1, 3, 1_000_000]) {
      for (const selfPersonId of [FIXTURE_SELF, null]) {
        const options = { limit, selfPersonId, now: FIXTURE_NOW };
        expect(await worker.collisionLoopCandidates(options)).toStrictEqual(
          await direct.collisionLoopCandidates(options),
        );
      }
      for (const horizonDays of [1, 60, 400]) {
        const options = { limit, now: FIXTURE_NOW, horizonDays };
        expect(await worker.collisionTemporalCandidates(options)).toStrictEqual(
          await direct.collisionTemporalCandidates(options),
        );
      }
      expect(await worker.collisionAnnotationContradictions({ max: limit })).toStrictEqual(
        await direct.collisionAnnotationContradictions({ max: limit }),
      );
    }
  });

  it("enqueues the same runs when the sweep reads through the worker", async () => {
    for (const arms of [
      { loops: true, contradictions: true, maxPerSweep: 3, contradictionsMax: 2 },
      { loops: true, contradictions: true, maxPerSweep: 60, contradictionsMax: 60 },
    ]) {
      const onWorker = await recordSweep(db, arms, { reads: worker });
      expect(onWorker).toStrictEqual(await recordSweep(db, arms));
    }
  });
});
