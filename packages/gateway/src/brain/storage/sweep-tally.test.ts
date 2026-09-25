// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Tests for the per-sweep tally: increments accumulate, a run's artifacts are
 * counted from `created_by_run`, and the timestamps only move when a run
 * actually settles.
 *
 * The reason this store exists at all is that run rows are pruned, so the
 * "survives losing the runs" case is the one that matters most here.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDatabase } from "../../db.js";
import { createBrief } from "./briefs.js";
import { appendOpenLoopLedger, createOpenLoop } from "./open-loops.js";
import { countRunArtifacts, listSweepTallies, recordSweepTally } from "./sweep-tally.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const NOW = Date.parse("2026-07-02T09:00:00.000Z");
const LATER = NOW + 7 * 86_400_000;

describe("sweep tally", () => {
  let path: string;
  let db: Db;

  beforeEach(() => {
    path = `/tmp/omnesis-test-${randomUUID()}.db`;
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (existsSync(path + suffix)) unlinkSync(path + suffix);
    }
  });

  const tally = (id: string) => listSweepTallies(db).get(id);

  test("an absent sweep has no row until something is recorded", () => {
    expect(listSweepTallies(db).size).toBe(0);
  });

  test("increments accumulate across runs", () => {
    recordSweepTally(
      db,
      { sweepId: "weekly-finances", runs: 1, promptTokens: 100, briefsCreated: 1 },
      NOW,
    );
    recordSweepTally(
      db,
      { sweepId: "weekly-finances", runs: 1, promptTokens: 250, loopsCreated: 2 },
      LATER,
    );
    expect(tally("weekly-finances")).toMatchObject({
      runs: 2,
      promptTokens: 350,
      briefsCreated: 1,
      loopsCreated: 2,
      firstRunAt: NOW,
      lastRunAt: LATER,
    });
  });

  test("a failed run counts separately and still stamps the clock", () => {
    recordSweepTally(db, { sweepId: "health-trends", failedRuns: 1 }, NOW);
    expect(tally("health-trends")).toMatchObject({ runs: 0, failedRuns: 1, lastRunAt: NOW });
  });

  test("a judge hold does not make a sweep look like it ran", () => {
    // Holds are recorded mid-run, so stamping `last_run_at` on them would
    // report a run that has not settled — and might yet fail.
    recordSweepTally(db, { sweepId: "waiting-on-others", briefsHeld: 1 }, NOW);
    expect(tally("waiting-on-others")).toMatchObject({
      runs: 0,
      briefsHeld: 1,
      firstRunAt: null,
      lastRunAt: null,
    });
    recordSweepTally(db, { sweepId: "waiting-on-others", runs: 1 }, LATER);
    expect(tally("waiting-on-others")).toMatchObject({
      runs: 1,
      briefsHeld: 1,
      firstRunAt: LATER,
      lastRunAt: LATER,
    });
  });

  test("a later increment resumes the same row rather than starting a new one", () => {
    recordSweepTally(db, { sweepId: "gone", runs: 4, briefsCreated: 3 }, NOW);
    recordSweepTally(db, { sweepId: "gone", runs: 1 }, LATER);
    expect(tally("gone")).toMatchObject({ runs: 5, briefsCreated: 3, firstRunAt: NOW });
  });

  describe("countRunArtifacts", () => {
    test("counts what a run created, and only that run's work", () => {
      createOpenLoop(
        db,
        {
          id: "loop_mine",
          createdByRun: "run_sweep",
          title: "Chase the refund",
          confidence: 0.7,
          importance: 0.5,
        },
        NOW,
      );
      createOpenLoop(
        db,
        {
          id: "loop_theirs",
          createdByRun: "run_other",
          title: "Book the studio",
          confidence: 0.7,
          importance: 0.5,
        },
        NOW,
      );
      createBrief(
        db,
        {
          id: "brief_mine",
          createdByRun: "run_sweep",
          kind: "info",
          title: "Two subscriptions renew next week",
          confidence: 0.7,
          urgency: 0.4,
        },
        NOW,
      );
      // Creating a loop writes no ledger entry, so "touched" counts updates
      // only — a created loop is not also billed as one this sweep updated.
      appendOpenLoopLedger(db, "loop_theirs", { runId: "run_sweep", note: "still open" }, NOW);
      appendOpenLoopLedger(db, "loop_theirs", { runId: "run_sweep", note: "chased again" }, NOW);

      expect(countRunArtifacts(db, "run_sweep")).toEqual({
        briefsCreated: 1,
        loopsCreated: 1,
        // Two entries on one loop is one loop touched.
        loopsTouched: 1,
        annotationsCreated: 0,
      });
      expect(countRunArtifacts(db, "run_nothing")).toEqual({
        briefsCreated: 0,
        loopsCreated: 0,
        loopsTouched: 0,
        annotationsCreated: 0,
      });
    });
  });
});
