// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The due-soon prime's `dueLoopCount`: the number the morning brief reads to
 * decide whether loops coming due are a reason to send. Only active loops
 * whose deadline falls on or before the far edge of the recency window
 * count; recently touched loops without a near deadline are context, never a
 * reason to send.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDatabase } from "../../db.js";
import { createOpenLoop } from "../storage/open-loops.js";
import { cognitionSpendDay } from "../storage/spend.js";
import { resolveBrainSettings, type ResolvedBrainSettings } from "../config.js";
import { readDueSoonDeltaPrime } from "./delta-prime.js";
import type Database from "better-sqlite3";
import type { OpenLoopState } from "../storage/types.js";

const NOW = Date.parse("2026-07-02T10:00:00.000Z");
const DAY = 86_400_000;
const WINDOW = 2 * DAY;

let path: string;
let db: Database.Database;

function cfg(overrides: Partial<ResolvedBrainSettings> = {}): ResolvedBrainSettings {
  return { ...resolveBrainSettings(), recencyWindowMs: WINDOW, ...overrides };
}

function loop(
  id: string,
  opts: { deadline?: unknown; state?: OpenLoopState; at?: number; importance?: number } = {},
): void {
  createOpenLoop(
    db,
    {
      id,
      createdByRun: "run_seed",
      title: `Task ${id}`,
      confidence: 0.8,
      importance: opts.importance ?? 0.5,
      ...(opts.deadline !== undefined ? { deadline: opts.deadline } : {}),
      ...(opts.state ? { state: opts.state } : {}),
    },
    opts.at ?? NOW - 10 * DAY,
  );
}

const count = (c = cfg()) => readDueSoonDeltaPrime(db, { now: NOW, cfg: c }).dueLoopCount;

beforeEach(() => {
  path = `/tmp/omnesis-test-${randomUUID()}.db`;
  db = createDatabase(path);
});
afterEach(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
});

describe("readDueSoonDeltaPrime dueLoopCount", () => {
  test("is zero on an empty store", () => {
    const prime = readDueSoonDeltaPrime(db, { now: NOW, cfg: cfg() });
    expect(prime.dueLoopCount).toBe(0);
    expect(prime.hasInputs).toBe(false);
  });

  test("counts loops due today, overdue, and on the window's last day", () => {
    loop("today", { deadline: cognitionSpendDay(NOW) });
    loop("overdue", { deadline: cognitionSpendDay(NOW - 3 * DAY) });
    loop("edge", { deadline: cognitionSpendDay(NOW + WINDOW) });
    expect(count()).toBe(3);
  });

  test("a deadline past the window's edge does not count", () => {
    loop("later", { deadline: cognitionSpendDay(NOW + WINDOW + DAY) });
    expect(count()).toBe(0);
  });

  test("a recently touched loop with no deadline is context but not due", () => {
    loop("touched", { at: NOW - DAY });
    const prime = readDueSoonDeltaPrime(db, { now: NOW, cfg: cfg() });
    expect(prime.hasInputs).toBe(true);
    expect(prime.text).toContain("Task touched");
    expect(prime.dueLoopCount).toBe(0);
  });

  test("a recently touched loop due far ahead is listed but not counted", () => {
    loop("far", { at: NOW - DAY, deadline: cognitionSpendDay(NOW + 20 * DAY) });
    const prime = readDueSoonDeltaPrime(db, { now: NOW, cfg: cfg() });
    expect(prime.text).toContain("Task far");
    expect(prime.dueLoopCount).toBe(0);
  });

  test("accepts ISO instants and { date } deadlines", () => {
    loop("instant", { deadline: new Date(NOW + DAY).toISOString() });
    loop("object", { deadline: { date: cognitionSpendDay(NOW + DAY) } });
    loop("garbage", { deadline: "not a date" });
    loop("bad-object", { deadline: { when: "tomorrow" } });
    expect(count()).toBe(2);
  });

  test("snoozed loops count; resolved loops never do", () => {
    const due = cognitionSpendDay(NOW);
    loop("open", { deadline: due });
    loop("snoozed", { deadline: due, state: "snoozed" });
    loop("done", { deadline: due, state: "done" });
    loop("dismissed", { deadline: due, state: "dismissed" });
    expect(count()).toBe(2);
  });

  test("counts only within the primeMaxLoops cap", () => {
    for (let i = 0; i < 5; i++) loop(`due${i}`, { deadline: cognitionSpendDay(NOW) });
    expect(count(cfg({ primeMaxLoops: 3 }))).toBe(3);
    expect(count(cfg({ primeMaxLoops: 12 }))).toBe(5);
  });
});
