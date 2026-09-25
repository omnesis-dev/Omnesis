// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { mutableListRevision } from "./list-revisions.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

describe("mutable list revisions", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:") as unknown as Db;
    db.pragma("foreign_keys = ON");
    runSchemaSetup(db);
  });

  afterEach(() => db.close());

  test("ignores unrelated and bulk people writes without per-row revision churn", () => {
    db.exec(`
      INSERT INTO people (
        id, canonical_name, source, first_seen, last_seen, created_at, updated_at
      ) VALUES
        ('person-1', 'Maya Reeves', 'contacts', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
        ('person-2', 'Jamie Lopez', 'contacts', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01'),
        ('person-3', 'David Lin', 'contacts', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01');
      UPDATE people SET interaction_score_recent = 0.5;
    `);

    expect(mutableListRevision(db, "product-loops")).toBe(0);
    expect(mutableListRevision(db, "cognition-coverage")).toBe(0);
    expect(mutableListRevision(db, "cognition-runs")).toBe(0);
    expect(
      db
        .prepare<
          [],
          { name: string }
        >("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mutable_list_people%'")
        .all(),
    ).toEqual([]);
  });

  test("increments product-loop revision on insert, update, and delete", () => {
    db.prepare(
      `INSERT INTO open_loops (
         id, created_by_run, confidence, importance, title, created_at, last_update
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("loop-1", "run-1", 0.8, 0.7, "Review proposal", 1, 1);
    expect(mutableListRevision(db, "product-loops")).toBe(1);

    db.prepare("UPDATE open_loops SET importance = ? WHERE id = ?").run(0.9, "loop-1");
    expect(mutableListRevision(db, "product-loops")).toBe(2);

    db.prepare("DELETE FROM open_loops WHERE id = ?").run("loop-1");
    expect(mutableListRevision(db, "product-loops")).toBe(3);
  });

  test("increments coverage and run revisions independently", () => {
    db.prepare(
      `INSERT INTO cognition_coverage (
         source_id, workflow_id, workflow_version, last_progress_at
       ) VALUES (?, ?, ?, ?)`,
    ).run("source-1", "workflow-1", 1, 1);
    expect(mutableListRevision(db, "cognition-coverage")).toBe(1);
    expect(mutableListRevision(db, "cognition-runs")).toBe(0);
    db.prepare("UPDATE cognition_coverage SET last_progress_at = ? WHERE source_id = ?").run(
      2,
      "source-1",
    );
    db.prepare("DELETE FROM cognition_coverage WHERE source_id = ?").run("source-1");
    expect(mutableListRevision(db, "cognition-coverage")).toBe(3);

    db.prepare(
      `INSERT INTO cognition_runs (
         id, kind, next_attempt_at, enqueued_at
       ) VALUES (?, ?, ?, ?)`,
    ).run("run-1", "daily", 1, 1);
    db.prepare("UPDATE cognition_runs SET next_attempt_at = ? WHERE id = ?").run(2, "run-1");
    db.prepare("DELETE FROM cognition_runs WHERE id = ?").run("run-1");
    expect(mutableListRevision(db, "cognition-runs")).toBe(3);
    expect(mutableListRevision(db, "cognition-coverage")).toBe(3);
  });
});
