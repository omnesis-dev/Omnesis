// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A temporal window's store half, read on the real io worker against a temp
 * database: every read returns exactly what the same read returns on a direct
 * handle, so moving it off the main event loop changes nothing a search or an
 * agent sees.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TEMPORAL_STATUSES } from "@omnesis/types";
import { createDatabase } from "../../db.js";
import { Scheduler } from "../../scheduler/scheduler.js";
import { IoTaskRunner } from "../../scheduler/runners/io.js";
import { ioGateFromScheduler } from "../../scheduler/io-ops.js";
import { TemporalQueryService } from "./temporal-query-service.js";
import { resolveTemporalRange } from "./temporal-range.js";
import {
  directTemporalStoreReads,
  type TemporalStoreReads,
  type TemporalStoreWindowRequest,
} from "./temporal-store-window.js";
import {
  FIXTURE_WINDOWS,
  FIXTURE_ZONES,
  fixtureScopes,
  seedTemporalFixture,
  type FixtureIds,
} from "./__fixtures__/test-utils.js";
import type Database from "better-sqlite3";
import type { TemporalItem, TemporalQueryInput } from "@omnesis/core";

const WORKER_URL = new URL("../../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../../workers/register-tsx.mjs", import.meta.url).href;

let dbPath: string;
let db: Database.Database;
let scheduler: Scheduler;
let worker: TemporalStoreReads;
let direct: TemporalStoreReads;
let ids: FixtureIds;

beforeAll(async () => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath) as unknown as Database.Database;
  ids = seedTemporalFixture(db);
  direct = directTemporalStoreReads(db);
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

function requests(): TemporalStoreWindowRequest[] {
  const out: TemporalStoreWindowRequest[] = [];
  for (const timeZone of FIXTURE_ZONES) {
    for (const window of FIXTURE_WINDOWS) {
      for (const scope of fixtureScopes(ids)) {
        const input: TemporalQueryInput = {
          ...window,
          ...scope,
          timeZone,
          statuses: [...TEMPORAL_STATUSES],
        };
        for (const anchoredOnly of [false, true]) {
          out.push({
            input,
            range: resolveTemporalRange(input),
            after: null,
            limit: 2,
            origins: ["projection", "annotation", "mention"],
            hideUnworthy: anchoredOnly,
            anchoredOnly,
          });
        }
      }
    }
  }
  return out;
}

it("reads every window's store half on the worker exactly as on the handle", async () => {
  const all = requests();
  let items = 0;
  for (const request of all) {
    const expected = await direct.temporalStoreWindow(request);
    expect(await worker.temporalStoreWindow(request), JSON.stringify(request.input)).toStrictEqual(
      expected,
    );
    items += expected.ranked.length + (expected.mentions?.items.length ?? 0);
  }
  expect(items).toBeGreaterThan(1_000);
});

it("pages past a cursor on the worker exactly as on the handle", async () => {
  const input: TemporalQueryInput = {
    from: "2026-10-05",
    to: "2026-10-19",
    timeZone: "Europe/London",
    statuses: [...TEMPORAL_STATUSES],
  };
  const range = resolveTemporalRange(input);
  const first = await direct.temporalStoreWindow({
    input,
    range,
    after: null,
    limit: 1,
    origins: ["mention"],
    hideUnworthy: false,
    anchoredOnly: false,
  });
  const after = first.mentions!.items[0]!.key;
  const request: TemporalStoreWindowRequest = {
    input,
    range,
    after,
    limit: 2,
    origins: ["projection", "annotation", "mention"],
    hideUnworthy: false,
    anchoredOnly: false,
  };
  const expected = await direct.temporalStoreWindow(request);
  expect(expected.mentions!.items.map((entry) => entry.key)).not.toContainEqual(after);
  expect(await worker.temporalStoreWindow(request)).toStrictEqual(expected);
});

it("answers a query and the anchored read through the worker as through the handle", async () => {
  let hide = false;
  const onHandle = new TemporalQueryService(db, undefined, { hideUnworthyMentions: () => hide });
  const onWorker = new TemporalQueryService(db, undefined, {
    hideUnworthyMentions: () => hide,
    storeReads: worker,
  });
  const pages = async (service: TemporalQueryService, input: TemporalQueryInput) => {
    const items: TemporalItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.query({ ...input, cursor, limit: 2 });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };
  for (const timeZone of ["UTC", "Pacific/Kiritimati", "America/Santiago"]) {
    for (const window of FIXTURE_WINDOWS) {
      for (const flag of [false, true]) {
        hide = flag;
        const input: TemporalQueryInput = {
          ...window,
          timeZone,
          origins: ["projection", "annotation", "mention"],
        };
        expect(await onWorker.query({ ...input, limit: 3 })).toStrictEqual(
          await onHandle.query({ ...input, limit: 3 }),
        );
        expect(await pages(onWorker, input)).toStrictEqual(await pages(onHandle, input));
        expect(await onWorker.anchoredItems({ ...input, limit: 4 })).toStrictEqual(
          await onHandle.anchoredItems({ ...input, limit: 4 }),
        );
      }
    }
  }
});
