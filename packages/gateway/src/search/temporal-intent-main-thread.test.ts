// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The date recognizer stays off the main thread of a gateway with search
 * workers. Building its models takes a second or more and a parse a few
 * milliseconds per culture, all synchronous, so on the main thread every
 * request and WebSocket the gateway serves would wait for it. This drives
 * temporal searches through a pipeline wired to a real search-worker pool and
 * counts every recognizer model this thread asks for: none, from the moment
 * the time index is attached, while the pool starts, and once it is serving.
 * The same searches without a pool read the time inline, which both proves the
 * count sees this thread and gives the readings the worker path must match.
 *
 * All fixture data is invented.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createIndexDatabase, EMBEDDING_DIM, openIndexDb, upsertChunks } from "../indexer/db.js";
import { SearchWorkerPool } from "../workers/search-pool.js";
import { SearchPipeline } from "./pipeline.js";
import { closeTempDb } from "./test-utils.js";
import type { TemporalIndexReader } from "./temporal-event-docs.js";
import type Database from "better-sqlite3";

const mainThread = vi.hoisted(() => ({ models: 0 }));

vi.mock("../enrichment/dates/recognizer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../enrichment/dates/recognizer.js")>();
  return {
    ...actual,
    dateTimeModel: (...args: Parameters<typeof actual.dateTimeModel>) => {
      mainThread.models += 1;
      return actual.dateTimeModel(...args);
    },
  };
});

const WORKER_URL = new URL("../workers/search-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;
const SRC = fileURLToPath(new URL("..", import.meta.url));

const QUERIES = [
  "invoice last week",
  "dentist next Monday",
  "parking permit February 2026",
  "la semaine prochaine",
  "el mes pasado",
  "budget review notes",
];

const noEventDocuments: TemporalIndexReader = {
  anchoredItems: () => Promise.resolve([]),
};

let configDir: string;
let db: Database.Database;
let pool: SearchWorkerPool;

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-temporal-main-"));
  const indexDbPath = join(configDir, "index.db");
  const seed = createIndexDatabase(indexDbPath);
  upsertChunks(seed, [
    {
      id: "chunk-invoice",
      documentId: "doc-invoice",
      chunkIndex: 0,
      content: "Invoice for the studio rental, paid by card",
      embedding: new Float32Array(EMBEDDING_DIM),
      sourceId: "gmail:maya@example.com",
      documentType: "email",
      title: "Studio invoice",
      sourceCreatedAt: "2026-09-30T10:00:00Z",
    },
  ]);
  seed.close();
  db = openIndexDb(indexDbPath, { readonly: true });
  pool = new SearchWorkerPool({
    indexDbPath,
    configDir,
    concurrency: 1,
    heartbeatIntervalMs: 1_000,
    heartbeatWarnGapMs: 30_000,
    workerUrl: WORKER_URL,
    workerExecArgv: ["--import", LOADER_URL],
    warmTemporalIntent: true,
    startWaitMs: 60_000,
  });
});

afterAll(async () => {
  await pool.dispose();
  closeTempDb(db);
  rmSync(configDir, { recursive: true, force: true });
});

function pipeline(withPool: boolean): SearchPipeline {
  const p = new SearchPipeline({ indexDb: db, searchConfig: { temporal: { enabled: true } } });
  p.setTemporalIndex(noEventDocuments, "day-first");
  if (withPool) p.setSearchPool(pool);
  return p;
}

const options = { timeZone: "Europe/London", temporal: { referenceTime: "2026-10-07T19:00:00Z" } };

it("reads every search's time on a search worker, never on this thread", async () => {
  const withPool = pipeline(true);
  // The pool starts with the first searches already waiting on it.
  void pool.start();
  expect(pool.isStarting).toBe(true);
  const viaWorker = await Promise.all(QUERIES.map((text) => withPool.search({ text, ...options })));
  // Let any boot-time timer the pipeline might have scheduled fire.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(mainThread.models).toBe(0);

  const inline = await Promise.all(
    QUERIES.map((text) => pipeline(false).search({ text, ...options })),
  );
  expect(mainThread.models).toBeGreaterThan(0);
  expect(viaWorker.map((r) => r.query.temporal)).toStrictEqual(inline.map((r) => r.query.temporal));
  expect(viaWorker.map((r) => r.stages?.temporal?.status)).toStrictEqual(
    inline.map((r) => r.stages?.temporal?.status),
  );
  expect(viaWorker.filter((r) => r.query.temporal).length).toBeGreaterThan(QUERIES.length / 2);
}, 60_000);

it("leaves the recognizer to the modules that run it off the main thread", () => {
  // `parseTemporalIntent` runs on a search worker (and inline only when no
  // worker can take the query); `extractDatesForDocs` runs on the cpu pool.
  // Anything else that builds a model would do it wherever it is called from.
  const callers = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
        const text = readFileSync(path, "utf8");
        for (const fn of [
          "dateTimeModel(",
          "warmTemporalIntent(",
          "parseTemporalIntent(",
          "DateTimeRecognizer(",
        ])
          if (text.includes(fn)) callers.set(fn, [...(callers.get(fn) ?? []), relative(SRC, path)]);
      }
    }
  };
  walk(SRC);
  expect(callers.get("dateTimeModel(")?.sort()).toEqual([
    "enrichment/dates/extractor.ts",
    "enrichment/dates/recognizer.ts",
    "search/temporal-intent.ts",
  ]);
  expect(callers.get("warmTemporalIntent(")?.sort()).toEqual([
    "search/temporal-intent.ts",
    "workers/search-worker.ts",
  ]);
  expect(callers.get("parseTemporalIntent(")?.sort()).toEqual([
    "search/pipeline.ts",
    "search/temporal-intent.ts",
    "workers/search-worker.ts",
  ]);
  expect(callers.get("DateTimeRecognizer(")).toEqual(["enrichment/dates/recognizer.ts"]);
});
