// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 52: introduce `cognition_spend` — per-(day, mechanism, model)
 * token-spend accounting — and copy the pre-split `cognition_spend_daily` day
 * totals in as mechanism 'unattributed' / model_id ''.
 *
 * A DB upgraded from before v52 carries populated cognition_spend_daily rows but
 * no cognition_spend table. This exercises that exact upgrade path — spend
 * seeded, pinned at v51 — through `runMigrations`, and asserts the copy is
 * correct, leaves the legacy table intact (downgrade safety), and is
 * idempotent (`INSERT OR IGNORE` over the composite PK).
 *
 * All fixture data is invented — never corpus-derived.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { createLogger } from "@omnesis/core";
import { runSchemaSetup } from "./schema.js";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import type { Db } from "./types.js";

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
});
afterEach(() => {
  db.close();
});

interface CognitionSpendRow {
  day: string;
  mechanism: string;
  model_id: string;
  runs: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

function cognitionRows(d: Db): CognitionSpendRow[] {
  return d
    .prepare<
      [],
      CognitionSpendRow
    >("SELECT * FROM cognition_spend ORDER BY day, mechanism, model_id")
    .all();
}

/**
 * Recreate a genuine pre-52 DB: cognition_spend_daily populated, cognition_spend
 * absent (head-shape `runSchemaSetup` creates it, so it is dropped again to
 * match what a real v51 install has on disk).
 */
function seedPre52(): void {
  runSchemaSetup(db);
  db.exec("DROP TABLE cognition_spend");
  db.exec(`
    INSERT INTO cognition_spend_daily (day, runs, prompt_tokens, completion_tokens, cache_read_tokens, cache_creation_tokens)
    VALUES ('2026-07-01', 4, 1000, 200, 600, 50),
           ('2026-07-02', 1, 90, 10, 0, 0)
  `);
  db.pragma("user_version = 51");
}

describe("migration 54 — cognition_spend + cognition_spend_daily history copy", () => {
  test("copies day totals in as 'unattributed' and keeps the legacy table intact", () => {
    seedPre52();

    expect(() => {
      runSchemaSetup(db);
      runMigrations(db, { log: createLogger("test") });
    }).not.toThrow();

    expect(cognitionRows(db)).toEqual([
      {
        day: "2026-07-01",
        mechanism: "unattributed",
        model_id: "",
        runs: 4,
        prompt_tokens: 1000,
        completion_tokens: 200,
        cache_read_tokens: 600,
        cache_creation_tokens: 50,
      },
      {
        day: "2026-07-02",
        mechanism: "unattributed",
        model_id: "",
        runs: 1,
        prompt_tokens: 90,
        completion_tokens: 10,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
    ]);

    // Downgrade safety: the legacy table survives, rows untouched.
    const legacy = db
      .prepare<
        [],
        { day: string; runs: number }
      >("SELECT day, runs FROM cognition_spend_daily ORDER BY day")
      .all();
    expect(legacy).toEqual([
      { day: "2026-07-01", runs: 4 },
      { day: "2026-07-02", runs: 1 },
    ]);
  });

  test("copy is idempotent — replaying v52's up() never double-counts, even beside new attributed rows", () => {
    seedPre52();
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    // A post-upgrade attributed bucket coexists with the copied history.
    db.exec(`
      INSERT INTO cognition_spend (day, mechanism, model_id, runs, prompt_tokens, completion_tokens)
      VALUES ('2026-07-03', 'data', 'model-x', 2, 300, 40)
    `);
    const afterFirst = cognitionRows(db);
    expect(afterFirst).toHaveLength(3); // guard: the seed actually populated

    // Replay ONLY v52's up() over the already-populated table (a second
    // runMigrations would no-op via the user_version gate and prove
    // nothing). The INSERT OR IGNORE on the composite PK must be a no-op.
    const v52 = MIGRATIONS.find((m) => m.version === 54);
    expect(v52).toBeDefined();
    v52!.up(db);
    expect(cognitionRows(db)).toEqual(afterFirst);
  });

  test("a fresh install (empty cognition_spend_daily) copies nothing", () => {
    runSchemaSetup(db);
    runMigrations(db, { log: createLogger("test") });
    expect(cognitionRows(db)).toEqual([]);
  });
});
