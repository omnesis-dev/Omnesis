// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The digest and sweep enqueuers run on the main event loop each rhythm tick
 * and ask the run ledger two questions: has this occurrence already run, and
 * is any run due. On a run row both the dedupe key and the attempt count lie
 * past the payload, so a statement that walks the ledger reads every payload;
 * each question must be one bounded index seek.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBriefsStorageTables } from "./schema.js";
import { hasCognitionRunWithDedupeKey, hasDuePendingCognitionRun } from "./run-queue.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  createBriefsStorageTables(db);
});
afterEach(() => db.close());

function run(
  id: string,
  status: string,
  dedupeKey: string | null,
  nextAttemptAt = 0,
  attempts = 0,
) {
  db.prepare(
    `INSERT INTO cognition_runs(id,kind,payload_json,dedupe_key,status,attempts,next_attempt_at,enqueued_at)
     VALUES(?,'daily',?,?,?,?,?,0)`,
  ).run(id, JSON.stringify({ note: "x".repeat(4096) }), dedupeKey, status, attempts, nextAttemptAt);
}

function plan(sql: string, ...params: unknown[]): string[] {
  return db
    .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail);
}

it("finds an occurrence's run whatever its status, through the dedupe index", () => {
  run("pending", "pending", "digest:2027-03-10");
  run("settled", "completed", "sweep:themes:2027-03-09");
  run("failed", "failed", "sweep:themes:2027-03-08");
  run("unkeyed", "completed", null);
  expect(hasCognitionRunWithDedupeKey(db, "digest:2027-03-10")).toBe(true);
  expect(hasCognitionRunWithDedupeKey(db, "sweep:themes:2027-03-09")).toBe(true);
  expect(hasCognitionRunWithDedupeKey(db, "sweep:themes:2027-03-08")).toBe(true);
  expect(hasCognitionRunWithDedupeKey(db, "digest:2027-03-11")).toBe(false);
  expect(
    plan("SELECT 1 FROM cognition_runs WHERE dedupe_key = ? LIMIT 1", "digest:2027-03-11"),
  ).toEqual([
    "SEARCH cognition_runs USING COVERING INDEX idx_cognition_runs_dedupe (dedupe_key=?)",
  ]);
});

it("answers whether a run is due from the due index, counting only claimable runs", () => {
  const now = 1_000;
  expect(hasDuePendingCognitionRun(db, now)).toBe(false);
  run("later", "pending", null, now + 1);
  run("exhausted", "pending", null, now - 1, 5);
  run("settled", "completed", null, now - 1);
  expect(hasDuePendingCognitionRun(db, now)).toBe(false);
  run("due", "pending", null, now - 1);
  expect(hasDuePendingCognitionRun(db, now)).toBe(true);
  const steps = plan(
    `SELECT 1 FROM cognition_runs
      WHERE status = 'pending' AND next_attempt_at <= ? AND attempts < ? LIMIT 1`,
    now,
    5,
  );
  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatch(/^SEARCH cognition_runs USING INDEX idx_cognition_runs_due /);
});
