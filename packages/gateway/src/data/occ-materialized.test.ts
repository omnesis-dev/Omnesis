// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import {
  advanceOccWatermark,
  captureOccVersion,
  readOccMeta,
  type RefreshJob,
} from "./occ-materialized.js";

type Db = Database.Database;

/**
 * Build the `refresh_meta` shape in memory. The
 * helpers all key into this single table by `job`.
 */
function makeRefreshMeta(): Db {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE refresh_meta (
       job TEXT PRIMARY KEY CHECK (job IN ('link_graph', 'interaction_scores', 'merge_rules')),
       dirty_version INTEGER NOT NULL DEFAULT 0,
       last_computed_version INTEGER NOT NULL DEFAULT -1,
       last_computed_at INTEGER,
       needs_refresh INTEGER NOT NULL DEFAULT 1
     );`,
  );
  return db;
}

const JOB: RefreshJob = "interaction_scores";

describe("captureOccVersion", () => {
  let db: Db;
  beforeEach(() => {
    db = makeRefreshMeta();
  });
  afterEach(() => db.close());

  test("returns 0 when no row exists yet (brand-new DB)", () => {
    expect(captureOccVersion(db, JOB)).toBe(0);
  });

  test("returns the persisted dirty_version when a row exists", () => {
    db.prepare("INSERT INTO refresh_meta (job, dirty_version) VALUES (?, ?)").run(JOB, 7);
    expect(captureOccVersion(db, JOB)).toBe(7);
  });

  test("never reads from any other job (defensive)", () => {
    db.prepare("INSERT INTO refresh_meta (job, dirty_version) VALUES (?, 11)").run(JOB);
    db.prepare("INSERT INTO refresh_meta (job, dirty_version) VALUES (?, 99)").run("merge_rules");
    // The helper hard-codes WHERE job = ?, so a future schema change
    // that allowed cross-job lookups would still get the canonical row.
    expect(captureOccVersion(db, JOB)).toBe(11);
  });
});

describe("readOccMeta", () => {
  let db: Db;
  beforeEach(() => {
    db = makeRefreshMeta();
  });
  afterEach(() => db.close());

  test("returns the {dirtyVersion=0, lastComputedVersion=-1, lastComputedAt=null} sentinel when empty", () => {
    expect(readOccMeta(db, JOB)).toEqual({
      dirtyVersion: 0,
      lastComputedVersion: -1,
      lastComputedAt: null,
    });
  });

  test("returns the persisted triple", () => {
    db.prepare(
      "INSERT INTO refresh_meta (job, dirty_version, last_computed_version, last_computed_at) VALUES (?, ?, ?, ?)",
    ).run(JOB, 5, 3, 1_700_000_000_000);
    expect(readOccMeta(db, JOB)).toEqual({
      dirtyVersion: 5,
      lastComputedVersion: 3,
      lastComputedAt: 1_700_000_000_000,
    });
  });

  test("each job is independent", () => {
    db.prepare(
      "INSERT INTO refresh_meta (job, dirty_version, last_computed_version) VALUES (?, ?, ?)",
    ).run("interaction_scores", 5, 3);
    db.prepare(
      "INSERT INTO refresh_meta (job, dirty_version, last_computed_version) VALUES (?, ?, ?)",
    ).run("merge_rules", 8, 4);
    expect(readOccMeta(db, "interaction_scores").lastComputedVersion).toBe(3);
    expect(readOccMeta(db, "merge_rules").lastComputedVersion).toBe(4);
  });
});

describe("advanceOccWatermark", () => {
  let db: Db;
  beforeEach(() => {
    db = makeRefreshMeta();
    db.prepare("INSERT INTO refresh_meta (job, dirty_version) VALUES (?, 0)").run(JOB);
  });
  afterEach(() => db.close());

  test("writes both the captured version and the wall-clock time", () => {
    advanceOccWatermark(db, {
      job: JOB,
      capturedVersion: 9,
      nowMs: 1_500_000_000_000,
    });
    const row = db
      .prepare<
        [],
        { last_computed_version: number; last_computed_at: number }
      >("SELECT last_computed_version, last_computed_at FROM refresh_meta WHERE job = ?")
      .get(JOB);
    expect(row).toEqual({
      last_computed_version: 9,
      last_computed_at: 1_500_000_000_000,
    });
  });

  test("does not bump dirty_version (only the watermark)", () => {
    db.prepare("UPDATE refresh_meta SET dirty_version = 12 WHERE job = ?").run(JOB);
    advanceOccWatermark(db, { job: JOB, capturedVersion: 12 });
    const dirty = db
      .prepare<
        [],
        { dirty_version: number }
      >("SELECT dirty_version FROM refresh_meta WHERE job = ?")
      .get(JOB)?.dirty_version;
    expect(dirty).toBe(12);
  });

  test("is monotonic — a stale pass can never drag the watermark back", () => {
    advanceOccWatermark(db, { job: JOB, capturedVersion: 9 });
    advanceOccWatermark(db, { job: JOB, capturedVersion: 4 });
    const version = db
      .prepare<
        [],
        { last_computed_version: number }
      >("SELECT last_computed_version FROM refresh_meta WHERE job = ?")
      .get(JOB)?.last_computed_version;
    expect(version).toBe(9);
  });

  test("defaults `nowMs` to Date.now() when omitted", () => {
    const before = Date.now();
    advanceOccWatermark(db, { job: JOB, capturedVersion: 1 });
    const after = Date.now();
    const ts = db
      .prepare<
        [],
        { last_computed_at: number }
      >("SELECT last_computed_at FROM refresh_meta WHERE job = ?")
      .get(JOB)?.last_computed_at;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test("only advances the named job — siblings untouched", () => {
    db.prepare("INSERT INTO refresh_meta (job, dirty_version) VALUES (?, 0)").run("merge_rules");
    advanceOccWatermark(db, { job: JOB, capturedVersion: 6, nowMs: 1_900_000_000_000 });
    const sibling = db
      .prepare<
        [],
        { last_computed_version: number; last_computed_at: number | null }
      >("SELECT last_computed_version, last_computed_at FROM refresh_meta WHERE job = ?")
      .get("merge_rules");
    expect(sibling).toEqual({ last_computed_version: -1, last_computed_at: null });
  });
});
