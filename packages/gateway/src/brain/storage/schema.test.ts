// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { createDatabase } from "../../db.js";
import { createBriefsStorageTables } from "./schema.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

const EXPECTED_TABLES = [
  "brief_citations",
  "brief_related_loops",
  "briefs",
  "cognition_notes",
  "cognition_runs",
  "cognition_spend",
  "cognition_spend_daily",
  "open_loop_docs",
  "open_loop_ledger",
  "open_loop_people",
  "open_loops",
  "retired_loops",
];

describe("briefs storage schema", () => {
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

  test("all tables exist after a normal boot", () => {
    const tables = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${EXPECTED_TABLES.map(
          () => "?",
        ).join(", ")})`,
      )
      .all(...EXPECTED_TABLES)
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(EXPECTED_TABLES);
  });

  test("DDL is idempotent — re-running with existing data is a no-op", () => {
    db.prepare(
      `INSERT INTO open_loops (id, created_by_run, confidence, importance, title, created_at, last_update)
       VALUES ('olp_1', 'run_1', 0.9, 0.5, 'Reply to the venue quote', 1000, 1000)`,
    ).run();
    createBriefsStorageTables(db);
    const row = db.prepare<[], { id: string }>("SELECT id FROM open_loops").get();
    expect(row?.id).toBe("olp_1");
  });

  test("the retired_loops consolidation store + its title-norm index exist", () => {
    const index = db
      .prepare<
        [],
        { name: string }
      >("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_retired_loops_title_norm'")
      .get();
    expect(index?.name).toBe("idx_retired_loops_title_norm");
    // The table accepts a trace row (smoke over the declared columns).
    expect(() =>
      db
        .prepare(
          `INSERT INTO retired_loops (id, title, title_norm, outcome, importance, created_at, retired_at)
           VALUES ('rlp_1', 'Renew the parking permit', 'parking permit renew the', 'done', 0.6, 1000, 2000)`,
        )
        .run(),
    ).not.toThrow();
    const row = db
      .prepare<[], { recurrence_count: number }>("SELECT recurrence_count FROM retired_loops")
      .get();
    // recurrence_count defaults to 1.
    expect(row?.recurrence_count).toBe(1);
  });

  test("pending dedupe-key uniqueness is enforced by the partial index", () => {
    const insert = (id: string, status: string) =>
      db
        .prepare(
          `INSERT INTO cognition_runs (id, kind, dedupe_key, status, next_attempt_at, enqueued_at)
           VALUES (?, 'data', 'doc:abc', ?, 0, 0)`,
        )
        .run(id, status);
    insert("run_1", "pending");
    expect(() => insert("run_2", "pending")).toThrow(/UNIQUE/);
    // Completed rows keep their key without blocking a new pending one.
    insert("run_3", "completed");
  });

  test("actual filtered keysets use complete ordering indexes without a temp sort", () => {
    const cases: Array<{ query: string; params: Array<string | number>; index: string }> = [
      {
        query:
          "SELECT * FROM briefs INDEXED BY idx_briefs_created_page WHERE (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?",
        params: [2000, "brf_cursor", 51],
        index: "idx_briefs_created_page",
      },
      {
        query: "SELECT MAX(read_at) FROM briefs",
        params: [],
        index: "idx_briefs_read_snapshot",
      },
      {
        query:
          "SELECT * FROM briefs INDEXED BY idx_briefs_state_created_page WHERE state = ? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?",
        params: ["read", 2000, "brf_cursor", 51],
        index: "idx_briefs_state_created_page",
      },
      {
        query:
          "SELECT * FROM briefs INDEXED BY idx_briefs_active_created_page WHERE state IN ('unread', 'read') AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?",
        params: [2000, "brf_cursor", 51],
        index: "idx_briefs_active_created_page",
      },
      {
        query:
          "SELECT * FROM briefs INDEXED BY idx_briefs_dismissed_created_page WHERE state IN ('dismissed_already_handled', 'dismissed_acknowledged', 'dismissed_not_relevant', 'dismissed_wrong') AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?",
        params: [2000, "brf_cursor", 51],
        index: "idx_briefs_dismissed_created_page",
      },
      {
        query:
          "SELECT * FROM cognition_runs INDEXED BY idx_cognition_runs_enqueued_page WHERE (enqueued_at, id) < (?, ?) ORDER BY enqueued_at DESC, id DESC LIMIT ?",
        params: [2000, "run_cursor", 51],
        index: "idx_cognition_runs_enqueued_page",
      },
      {
        query:
          "SELECT * FROM cognition_runs INDEXED BY idx_cognition_runs_status_enqueued_page WHERE status = ? AND (enqueued_at, id) < (?, ?) ORDER BY enqueued_at DESC, id DESC LIMIT ?",
        params: ["failed", 2000, "run_cursor", 51],
        index: "idx_cognition_runs_status_enqueued_page",
      },
      {
        query:
          "SELECT * FROM cognition_runs INDEXED BY idx_cognition_runs_kind_enqueued_page WHERE kind = ? AND (enqueued_at, id) < (?, ?) ORDER BY enqueued_at DESC, id DESC LIMIT ?",
        params: ["data", 2000, "run_cursor", 51],
        index: "idx_cognition_runs_kind_enqueued_page",
      },
      {
        query:
          "SELECT * FROM cognition_runs INDEXED BY idx_cognition_runs_status_kind_enqueued_page WHERE kind = ? AND status = ? AND (enqueued_at, id) < (?, ?) ORDER BY enqueued_at DESC, id DESC LIMIT ?",
        params: ["data", "failed", 2000, "run_cursor", 51],
        index: "idx_cognition_runs_status_kind_enqueued_page",
      },
      {
        query:
          "SELECT * FROM cognition_runs INDEXED BY idx_cognition_runs_due WHERE status = 'pending' AND next_attempt_at > ? ORDER BY next_attempt_at ASC, id ASC LIMIT ?",
        params: [1000, 11],
        index: "idx_cognition_runs_due",
      },
      {
        query:
          "SELECT * FROM cognition_runs INDEXED BY idx_cognition_runs_status_kind_scheduled_page WHERE kind = ? AND status = ? AND (next_attempt_at, id) > (?, ?) ORDER BY next_attempt_at ASC, id ASC LIMIT ?",
        params: ["time_based", "pending", 2000, "run_cursor", 51],
        index: "idx_cognition_runs_status_kind_scheduled_page",
      },
      {
        query:
          "SELECT * FROM open_loops INDEXED BY idx_open_loops_active_importance_page WHERE state IN ('open', 'snoozed') AND (importance, last_update, id) < (?, ?, ?) ORDER BY importance DESC, last_update DESC, id DESC LIMIT ?",
        params: [0.5, 2000, "olp_cursor", 51],
        index: "idx_open_loops_active_importance_page",
      },
      {
        query:
          "SELECT * FROM open_loops INDEXED BY idx_open_loops_resolved_importance_page WHERE state IN ('done', 'dismissed') AND (importance, last_update, id) < (?, ?, ?) ORDER BY importance DESC, last_update DESC, id DESC LIMIT ?",
        params: [0.5, 2000, "olp_cursor", 51],
        index: "idx_open_loops_resolved_importance_page",
      },
      {
        query:
          "SELECT * FROM open_loops INDEXED BY idx_open_loops_state_importance_page WHERE state = ? AND (importance, last_update, id) < (?, ?, ?) ORDER BY importance DESC, last_update DESC, id DESC LIMIT ?",
        params: ["open", 0.5, 2000, "olp_cursor", 51],
        index: "idx_open_loops_state_importance_page",
      },
      {
        query:
          "SELECT * FROM open_loops INDEXED BY idx_open_loops_active_update_page WHERE state IN ('open', 'snoozed') AND (last_update, id) < (?, ?) ORDER BY last_update DESC, id DESC LIMIT ?",
        params: [2000, "olp_cursor", 51],
        index: "idx_open_loops_active_update_page",
      },
      {
        query:
          "SELECT * FROM open_loops INDEXED BY idx_open_loops_state_update WHERE state = ? AND (last_update, id) < (?, ?) ORDER BY last_update DESC, id DESC LIMIT ?",
        params: ["open", 2000, "olp_cursor", 51],
        index: "idx_open_loops_state_update",
      },
      {
        query:
          "SELECT * FROM retired_loops INDEXED BY idx_retired_loops_page WHERE (retired_at, id) < (?, ?) ORDER BY retired_at DESC, id DESC LIMIT ?",
        params: [2000, "rlp_cursor", 51],
        index: "idx_retired_loops_page",
      },
    ];

    for (const { query, params, index } of cases) {
      const details = db
        .prepare<Array<string | number>, { detail: string }>(`EXPLAIN QUERY PLAN ${query}`)
        .all(...params)
        .map((row) => row.detail);
      expect(details.join("\n"), query).toContain(index);
      expect(details.join("\n"), query).not.toContain("USE TEMP B-TREE");
    }
  });
});
