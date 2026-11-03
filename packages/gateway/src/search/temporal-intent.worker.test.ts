// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A query's temporal intent read on a real search worker equals the same
 * reading made in this thread: every query, reference moment, zone and
 * numeric-date order below gives a `toStrictEqual` result through
 * `SearchWorkerPool.temporalIntent` and through `parseTemporalIntent`.
 *
 * All queries are invented.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createIndexDatabase } from "../indexer/db.js";
import { SearchWorkerPool } from "../workers/search-pool.js";
import {
  parseTemporalIntent,
  type TemporalIntent,
  type TemporalIntentOptions,
} from "./temporal-intent.js";

const WORKER_URL = new URL("../workers/search-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

const QUERIES = [
  // No date at all, and words that only look like one.
  "budget review notes",
  "",
  "may I borrow the ladder",
  "march protest photos",
  "email from June about the garden",
  "order 2025 tracking",
  "INV-2024 receipt",
  "week 3 notes",
  // English relative phrases.
  "invoice last week",
  "dentist next Monday",
  "what is on tomorrow",
  "photos from yesterday",
  "the last 7 days of receipts",
  "past 2 weeks standups",
  "next 3 months travel",
  "3 weeks ago dinner",
  "2 years ago holiday",
  "last summer trip",
  "receipts November",
  "Monday meeting",
  "since March",
  "until Friday",
  "the month before last",
  // Explicit dates, ranges and periods.
  "pottery class 20 September 2026",
  "parking permit February 2026",
  "Q3 2025 report",
  "H2 2024 planning",
  "March to May 2025",
  "between June and August",
  "from Jan to March",
  "1 to 5 October",
  "2026-07-08 2026-07-29 standup",
  "before 2026-09-01",
  "garden photos 2016 2017",
  '"Quarterly notes 2022-23"',
  // Numeric dates, read differently by the two orders.
  "10/07/2026 booking",
  "3/4 deadline",
  "12/11/2025 to 15/11/2025",
  // French.
  "la semaine prochaine",
  "factures du mois dernier",
  "réunion lundi",
  "du 1 au 3 mars 2026",
  "le mois prochain",
  "rendez-vous demain",
  "15 juin",
  // Spanish.
  "el mes pasado",
  "la semana que viene",
  "cena el próximo viernes",
  "facturas de agosto",
  "hoy por la tarde",
];

const ZONES = [
  "UTC",
  "Europe/London",
  "Pacific/Kiritimati", // UTC+14
  "Pacific/Pago_Pago", // UTC−11
  "Asia/Kolkata", // UTC+5:30
  "America/St_Johns", // UTC−3:30, with DST
  "Australia/Adelaide", // UTC+9:30/+10:30
  "America/Santiago", // DST changes at midnight
];

const MOMENTS = [
  Date.parse("2026-03-29T00:30:00Z"), // the day European clocks go forward
  Date.parse("2026-11-01T06:30:00Z"), // the day US clocks go back
  Date.parse("2026-09-06T04:30:00Z"), // the day Chilean clocks go forward, at midnight
  Date.parse("2026-12-31T23:30:00Z"), // the year turns in some zones and not others
];

const ORDERS = ["day-first", "month-first"] as const;

const CASES: Array<{ text: string; options: TemporalIntentOptions }> = [];
for (const text of QUERIES)
  for (const timeZone of ZONES)
    for (const nowMs of MOMENTS)
      for (const numericDateOrder of ORDERS)
        CASES.push({ text, options: { nowMs, timeZone, numericDateOrder } });

let configDir: string;
let pool: SearchWorkerPool;

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), "omnesis-temporal-intent-worker-"));
  const indexDbPath = join(configDir, "index.db");
  createIndexDatabase(indexDbPath).close();
  pool = new SearchWorkerPool({
    indexDbPath,
    configDir,
    concurrency: 2,
    heartbeatIntervalMs: 1_000,
    heartbeatWarnGapMs: 30_000,
    workerUrl: WORKER_URL,
    workerExecArgv: ["--import", LOADER_URL],
    warmTemporalIntent: true,
    startWaitMs: 60_000,
  });
  // Not awaited: a reading asked for while the pool starts waits for a worker.
  void pool.start();
});

afterAll(async () => {
  await pool.dispose();
  rmSync(configDir, { recursive: true, force: true });
});

it("waits for a starting pool instead of refusing the reading", async () => {
  const options: TemporalIntentOptions = {
    nowMs: MOMENTS[0]!,
    timeZone: "Europe/London",
    numericDateOrder: "day-first",
  };
  expect(pool.isStarting).toBe(true);
  const read = await pool.temporalIntent("invoice last week", options);
  expect(read).toStrictEqual(parseTemporalIntent("invoice last week", options));
  expect(read?.windows).toHaveLength(1);
});

it("reads every query on the worker exactly as in this thread", async () => {
  const onWorker = Promise.all(CASES.map((c) => pool.temporalIntent(c.text, c.options)));
  const here = CASES.map((c) => parseTemporalIntent(c.text, c.options));
  const there = await onWorker;
  for (let i = 0; i < CASES.length; i++) {
    expect(there[i], JSON.stringify(CASES[i])).toStrictEqual(here[i]);
  }

  // The set exercises every culture and both outcomes, so the equality covers
  // real readings rather than a wall of nulls.
  const read = here.filter((r): r is TemporalIntent => r !== null);
  expect(read.length).toBeGreaterThan(CASES.length / 2);
  expect(read.length).toBeLessThan(CASES.length);
  expect(new Set(read.map((r) => r.culture))).toEqual(new Set(["en-us", "en-*", "fr-fr", "es-es"]));
  expect(read.some((r) => r.windows.length > 1)).toBe(true);
}, 120_000);

it("stops waiting for a pool whose worker never reports ready", async () => {
  const stuck = new SearchWorkerPool({
    indexDbPath: join(configDir, "index.db"),
    configDir,
    concurrency: 1,
    // A worker that never answers its `init`.
    workerUrl: new URL("data:text/javascript,setInterval(() => {}, 1000)"),
    startWaitMs: 50,
  });
  void stuck.start().catch(() => {});
  try {
    expect(stuck.isStarting).toBe(true);
    await expect(
      stuck.temporalIntent("invoice last week", {
        nowMs: MOMENTS[0]!,
        timeZone: "UTC",
        numericDateOrder: "day-first",
      }),
    ).rejects.toThrow(/no search worker reported ready within 50ms/);
  } finally {
    await stuck.dispose();
  }
});

it("refuses a reading once the pool is disposed", async () => {
  const disposed = new SearchWorkerPool({
    indexDbPath: join(configDir, "index.db"),
    configDir,
    concurrency: 1,
    workerUrl: WORKER_URL,
    workerExecArgv: ["--import", LOADER_URL],
  });
  await disposed.dispose();
  await expect(
    disposed.temporalIntent("invoice last week", {
      nowMs: MOMENTS[0]!,
      timeZone: "UTC",
      numericDateOrder: "day-first",
    }),
  ).rejects.toThrow(/disposed/);
});
