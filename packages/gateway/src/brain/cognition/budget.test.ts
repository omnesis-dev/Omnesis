// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createBriefsStorageTables } from "../storage/schema.js";
import { recordCognitionSpend, cognitionSpendDay } from "../storage/spend.js";
import { cognitionBudgetVerdict } from "./budget.js";

let db: Database.Database;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const DAY = cognitionSpendDay(NOW);

beforeEach(() => {
  db = new Database(":memory:");
  createBriefsStorageTables(db);
});

afterEach(() => db.close());

/** Record spend for today under one mechanism. */
function spend(promptTokens: number, completionTokens: number, runs = 1, mechanism = "noticing") {
  recordCognitionSpend(
    db,
    DAY,
    mechanism,
    "some-model",
    { promptTokens, completionTokens },
    {
      countRun: runs > 0,
    },
  );
}

const NO_LIMITS = { dailyTokens: null, dailyRuns: null };

describe("cognitionBudgetVerdict", () => {
  it("never pauses when no ceiling is set", () => {
    // Absent budget must mean absent, not a default someone did not choose.
    spend(10_000_000, 500_000);
    expect(cognitionBudgetVerdict(db, NO_LIMITS, NOW)).toEqual({ exhausted: false });
  });

  it("does not pause before the token ceiling is reached", () => {
    spend(900, 50);
    expect(cognitionBudgetVerdict(db, { dailyTokens: 1_000, dailyRuns: null }, NOW).exhausted).toBe(
      false,
    );
  });

  it("pauses at the token ceiling and says which one and by how much", () => {
    spend(900, 200); // 1_100 total
    const verdict = cognitionBudgetVerdict(db, { dailyTokens: 1_000, dailyRuns: null }, NOW);
    expect(verdict).toMatchObject({
      exhausted: true,
      dimension: "tokens",
      used: 1_100,
      limit: 1_000,
    });
    if (verdict.exhausted) expect(verdict.reason).toMatch(/token budget/i);
  });

  it("pauses at the run ceiling independently of tokens", () => {
    for (let i = 0; i < 3; i++) spend(1, 1);
    const verdict = cognitionBudgetVerdict(db, { dailyTokens: null, dailyRuns: 3 }, NOW);
    expect(verdict).toMatchObject({ exhausted: true, dimension: "runs", used: 3, limit: 3 });
  });

  it("counts every mechanism, not just background work", () => {
    // A ceiling background work could exhaust while an interactive session
    // spent freely alongside it would not be a ceiling.
    spend(600, 0, 1, "interactive");
    spend(500, 0, 1, "datum-intake");
    expect(cognitionBudgetVerdict(db, { dailyTokens: 1_000, dailyRuns: null }, NOW).exhausted).toBe(
      true,
    );
  });

  it("resets with the day", () => {
    spend(5_000, 0);
    const limits = { dailyTokens: 1_000, dailyRuns: null };
    expect(cognitionBudgetVerdict(db, limits, NOW).exhausted).toBe(true);
    // Tomorrow is a fresh bucket — the ceiling is per day, not cumulative.
    const tomorrow = NOW + 86_400_000;
    expect(cognitionBudgetVerdict(db, limits, tomorrow).exhausted).toBe(false);
  });

  it("does not pause on a day with no recorded spend", () => {
    expect(cognitionBudgetVerdict(db, { dailyTokens: 1, dailyRuns: 1 }, NOW).exhausted).toBe(false);
  });
});
