// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The person directory of the Watch ontology, read on the real io worker
 * against a temp database: the worker returns exactly what the same read returns on a
 * direct handle, answers with a hash alone while the directory is unchanged,
 * and the ontology assembled through it equals the one assembled on the handle.
 *
 * All fixture data is invented.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabase } from "../db.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { IoTaskRunner } from "../scheduler/runners/io.js";
import { ioGateFromScheduler, type IoGate } from "../scheduler/io-ops.js";
import { LiveOntology } from "./ontology.js";
import { readPeopleDirectory } from "./people-directory.js";
import type Database from "better-sqlite3";
import type { Db } from "../data/types.js";

const WORKER_URL = new URL("../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

let dbPath: string;
let db: Database.Database;
let scheduler: Scheduler;
let io: IoGate;

function addPerson(id: string, name: string, options: { self?: boolean; into?: string } = {}) {
  db.prepare(
    `INSERT INTO people (id, canonical_name, merged_into, source, is_self, first_seen, last_seen, created_at, updated_at)
     VALUES (?, ?, ?, 'fixture', ?, '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
  ).run(id, name, options.into ?? null, options.self ? 1 : 0);
}

beforeEach(async () => {
  dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(dbPath) as unknown as Database.Database;
  addPerson("0a1b2c3d-0000-4000-8000-000000000001", "fixture self", { self: true });
  addPerson("b3f2a9d4-0000-4000-8000-000000000002", "fixture person");
  addPerson("c4e5f6a7-0000-4000-8000-000000000003", "fixture alias", {
    into: "b3f2a9d4-0000-4000-8000-000000000002",
  });
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

it("reads the same directory on the worker as on the handle", async () => {
  const expected = readPeopleDirectory(db as unknown as Db, null);
  expect(expected.people).toHaveLength(3);
  expect(expected.people?.[0]).toEqual({
    id: "0a1b2c3d-0000-4000-8000-000000000001",
    canonicalName: "fixture self",
    aliases: [],
    isSelf: true,
  });
  expect(expected.people?.[2]?.mergedInto).toBe("b3f2a9d4-0000-4000-8000-000000000002");
  expect(await io.watchPeopleDirectory(null)).toEqual(expected);
});

it("answers with the hash alone until the directory changes", async () => {
  const first = await io.watchPeopleDirectory(null);
  const unchanged = await io.watchPeopleDirectory(first.hash);
  expect(unchanged, "an unchanged directory was sent again").toEqual({
    hash: first.hash,
    people: null,
  });

  addPerson("d5f6a7b8-0000-4000-8000-000000000004", "fixture newcomer");
  const changed = await io.watchPeopleDirectory(first.hash);
  expect(changed.hash).not.toBe(first.hash);
  expect(changed).toEqual(readPeopleDirectory(db as unknown as Db, null));
});

it("assembles the same ontology through the worker as on the handle", async () => {
  const deps = { db: db as unknown as Db, analyticsDb: null, semanticallyIndexed: () => true };
  const onHandle = new LiveOntology(deps);
  const onWorker = new LiveOntology({
    ...deps,
    peopleDirectory: (knownHash) => io.watchPeopleDirectory(knownHash),
  });
  const first = await onWorker.current();
  expect(first).toEqual(await onHandle.current());
  expect(await onWorker.current(), "an unchanged install was described again").toBe(first);

  addPerson("d5f6a7b8-0000-4000-8000-000000000004", "fixture newcomer");
  const after = await onWorker.current();
  expect(after.people, "a new person waited for anything but the next pass").toHaveLength(4);
  expect(after).toEqual(await onHandle.current());
});
