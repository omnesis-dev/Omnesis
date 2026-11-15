// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search results' links read on the real io worker against a temp database
 * return exactly what the same read returns on a direct handle, including for
 * a document whose text spans many overflow pages and one with no row.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { createDatabase } from "../db.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { IoTaskRunner } from "../scheduler/runners/io.js";
import { ioGateFromScheduler } from "../scheduler/io-ops.js";
import { readSearchResultLinks } from "./result-links.js";

const WORKER_URL = new URL("../workers/io-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;
const NOW = "2025-02-01T10:00:00Z";

const paths: string[] = [];
const schedulers: Scheduler[] = [];

afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) await scheduler.dispose();
  for (const path of paths.splice(0))
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

it("returns what the direct read returns", async () => {
  const path = `/tmp/omnesis-test-${randomUUID()}.db`;
  paths.push(path);
  const db = createDatabase(path);
  const insert = db.prepare(
    `INSERT INTO documents (id,provider_id,source_id,external_id,title,content,content_hash,metadata,
       source_created_at,source_updated_at,ingested_at,updated_at)
     VALUES (?,'fictional','archive:fictional',?,'Agreement',?,?,?,?,?,?,?)`,
  );
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const id = `d${i}`;
    ids.push(id);
    const metadata = {
      ...(i % 2 ? { sourceUrl: `https://example.org/open/${id}` } : {}),
      ...(i % 3 ? {} : { appUrl: `fictional-app://doc/${id}` }),
      ...(i % 4 ? {} : { extra: { mimeType: "application/pdf" } }),
    };
    // One long text, so its metadata sits behind many overflow pages.
    const content = `Invented agreement ${i}. ${"warranty ".repeat(i === 5 ? 200_000 : 10)}`;
    insert.run(id, id, content, `h${i}`, JSON.stringify(metadata), NOW, NOW, NOW, NOW);
  }
  ids.push("missing");
  const direct = readSearchResultLinks(db, ids);
  expect(direct).toHaveLength(8);
  db.close();

  const scheduler = new Scheduler({ enablePreemption: false });
  scheduler.registerRunner(
    new IoTaskRunner({
      gatewayDbPath: path,
      concurrency: 1,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    }),
  );
  await scheduler.start();
  schedulers.push(scheduler);
  const gate = ioGateFromScheduler(scheduler);
  expect(await gate.searchResultLinks(ids)).toStrictEqual(direct);
  expect(await gate.searchResultLinks([])).toStrictEqual([]);
});
