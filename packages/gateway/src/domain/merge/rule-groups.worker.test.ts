// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Loading the People → Rules page on the real io worker against a temp database:
 * every page of every filter returns exactly what the same read on a direct
 * handle returns, and the person service serves it from the worker without
 * touching its own handle, so moving the read off the main event loop changes
 * nothing the operator is shown.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../../db.js";
import { Scheduler } from "../../scheduler/scheduler.js";
import { IoTaskRunner } from "../../scheduler/runners/io.js";
import { ioGateFromScheduler, type IoGate } from "../../scheduler/io-ops.js";
import { PersonService } from "../../http/services/PersonService.js";
import { listMergeRuleGroups } from "./rule-groups.js";
import {
  RULE_GROUP_FILTERS,
  loadAllPages,
  seedEdgeRuleGroups,
  seedLargeRuleGroups,
} from "./rule-groups-test-utils.js";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

const WORKER_URL = new URL("../../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../../workers/register-tsx.mjs", import.meta.url).href;

describe.each(["empty", "edge", "large"])("the %s rule groups on the io worker", (fixture) => {
  let dbPath: string;
  let db: Database.Database;
  let scheduler: Scheduler;
  let gate: IoGate;

  beforeAll(async () => {
    dbPath = join(tmpdir(), `omnesis-test-${randomUUID()}.db`);
    db = createDatabase(dbPath);
    if (fixture === "edge") seedEdgeRuleGroups(db);
    if (fixture === "large") seedLargeRuleGroups(db, 40);
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
    gate = ioGateFromScheduler(scheduler);
  });

  afterAll(async () => {
    await scheduler.dispose();
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
  });

  it("pages every filter exactly as the handle does", async () => {
    for (const filter of RULE_GROUP_FILTERS)
      for (const limit of [1, 25]) {
        expect(await loadAllPages(gate.mergeRuleGroups, { ...filter, limit })).toStrictEqual(
          await loadAllPages((query) => listMergeRuleGroups(db, query), { ...filter, limit }),
        );
      }
  });

  it("is what the person service serves, without reading on its own handle", async () => {
    const mainHandle = new Proxy(db, {
      get(target, property, receiver) {
        if (property === "prepare" || property === "exec")
          throw new Error("the rule groups must not read on the main handle");
        return Reflect.get(target, property, receiver);
      },
    });
    const service = new PersonService(mainHandle, {} as WriteGate, {}, gate);
    const served = await service.listMergeRuleGroups({ limit: 25 });
    expect(served).toStrictEqual(listMergeRuleGroups(db, { limit: 25 }));
    if (fixture !== "empty") expect(served.items.length).toBeGreaterThan(0);
  });
});
