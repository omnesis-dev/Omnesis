// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { createDatabase } from "../../db.js";
import {
  getCognitionSpendDayTotal,
  listCognitionSpend,
  listCognitionSpendDayTotals,
  cognitionSpendDay,
  recordCognitionSpend,
} from "./spend.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

describe("cognition spend tracking", () => {
  let path: string;
  let db: Db;
  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("runs fold into per-(day, mechanism, model) buckets", () => {
    recordCognitionSpend(db, "2026-07-01", "data", "model-x", {
      promptTokens: 1000,
      completionTokens: 200,
    });
    recordCognitionSpend(db, "2026-07-01", "data", "model-x", {
      promptTokens: 500,
      completionTokens: 100,
    });
    recordCognitionSpend(db, "2026-07-01", "daily", "model-x", {
      promptTokens: 30,
      completionTokens: 3,
    });
    recordCognitionSpend(db, "2026-07-01", "data", "model-y", {
      promptTokens: 7,
      completionTokens: 1,
    });
    expect(listCognitionSpend(db)).toEqual([
      {
        day: "2026-07-01",
        mechanism: "daily",
        modelId: "model-x",
        runs: 1,
        promptTokens: 30,
        completionTokens: 3,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        day: "2026-07-01",
        mechanism: "data",
        modelId: "model-x",
        runs: 2,
        promptTokens: 1500,
        completionTokens: 300,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        day: "2026-07-01",
        mechanism: "data",
        modelId: "model-y",
        runs: 1,
        promptTokens: 7,
        completionTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ]);
  });

  test("countRun:false folds tokens without bumping the run counter (failed attempts)", () => {
    recordCognitionSpend(db, "2026-07-01", "data", "model-x", {
      promptTokens: 100,
      completionTokens: 20,
    });
    recordCognitionSpend(
      db,
      "2026-07-01",
      "data",
      "model-x",
      { promptTokens: 40, completionTokens: 0 },
      { countRun: false },
    );
    // Also works when the failed attempt opens the bucket.
    recordCognitionSpend(
      db,
      "2026-07-02",
      "sweep",
      "",
      { promptTokens: 9, completionTokens: 1 },
      { countRun: false },
    );
    expect(getCognitionSpendDayTotal(db, "2026-07-01")).toEqual({
      day: "2026-07-01",
      runs: 1,
      promptTokens: 140,
      completionTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(getCognitionSpendDayTotal(db, "2026-07-02")).toEqual({
      day: "2026-07-02",
      runs: 0,
      promptTokens: 9,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(getCognitionSpendDayTotal(db, "2026-06-30")).toBeNull();
  });

  test("cache-read and cache-creation tokens fold into the bucket's totals", () => {
    recordCognitionSpend(db, "2026-07-01", "data", "model-x", {
      promptTokens: 1000,
      completionTokens: 50,
      cacheReadTokens: 800,
      cacheCreationTokens: 100,
    });
    // A second run without the cache split (an old-shape usage_json) folds cleanly.
    recordCognitionSpend(db, "2026-07-01", "data", "model-x", {
      promptTokens: 200,
      completionTokens: 10,
    });
    expect(listCognitionSpend(db)).toEqual([
      {
        day: "2026-07-01",
        mechanism: "data",
        modelId: "model-x",
        runs: 2,
        promptTokens: 1200,
        completionTokens: 60,
        cacheReadTokens: 800,
        cacheCreationTokens: 100,
      },
    ]);
  });

  test("listCognitionSpend returns newest-day-first, bounded by distinct days", () => {
    for (const day of ["2026-07-01", "2026-07-03", "2026-07-02"]) {
      recordCognitionSpend(db, day, "data", "model-x", { promptTokens: 1, completionTokens: 1 });
      recordCognitionSpend(db, day, "daily", "model-x", { promptTokens: 1, completionTokens: 1 });
    }
    expect(listCognitionSpend(db).map((r) => r.day)).toEqual([
      "2026-07-03",
      "2026-07-03",
      "2026-07-02",
      "2026-07-02",
      "2026-07-01",
      "2026-07-01",
    ]);
    // `days` bounds distinct days, not rows.
    const latest = listCognitionSpend(db, { days: 1 });
    expect(latest.map((r) => r.day)).toEqual(["2026-07-03", "2026-07-03"]);
    expect(latest.map((r) => r.mechanism)).toEqual(["daily", "data"]);
  });

  test("day totals aggregate across mechanisms and models, most recent first", () => {
    recordCognitionSpend(db, "2026-07-01", "data", "model-x", {
      promptTokens: 100,
      completionTokens: 10,
      cacheReadTokens: 40,
    });
    recordCognitionSpend(db, "2026-07-01", "synthesis", "model-y", {
      promptTokens: 50,
      completionTokens: 5,
      cacheCreationTokens: 20,
    });
    recordCognitionSpend(db, "2026-07-02", "daily", "model-x", {
      promptTokens: 9,
      completionTokens: 1,
    });
    expect(listCognitionSpendDayTotals(db)).toEqual([
      {
        day: "2026-07-02",
        runs: 1,
        promptTokens: 9,
        completionTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        day: "2026-07-01",
        runs: 2,
        promptTokens: 150,
        completionTokens: 15,
        cacheReadTokens: 40,
        cacheCreationTokens: 20,
      },
    ]);
    expect(listCognitionSpendDayTotals(db, { limit: 1 }).map((r) => r.day)).toEqual(["2026-07-02"]);
  });

  test("cognitionSpendDay formats local-time YYYY-MM-DD", () => {
    // Noon local time on an unambiguous date.
    const noon = new Date(2026, 6, 2, 12, 0, 0).getTime();
    expect(cognitionSpendDay(noon)).toBe("2026-07-02");
    // Deterministic: same instant, same day string.
    expect(cognitionSpendDay(noon)).toBe(cognitionSpendDay(noon));
  });
});
