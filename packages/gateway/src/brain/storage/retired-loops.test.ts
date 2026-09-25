// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
type Db = Database.Database;
import { createDatabase } from "../../db.js";
import {
  cascadeOpenLoopPrivacyDelete,
  createOpenLoop,
  deleteOpenLoop,
  updateOpenLoop,
  type CreateOpenLoopInput,
} from "./open-loops.js";
import {
  listRetiredLoops,
  normalizeLoopTitle,
  searchRetiredLoopsLexical,
} from "./retired-loops.js";
import type { RetiredLoopRow } from "./types.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function loopInput(over: Partial<CreateOpenLoopInput> = {}): CreateOpenLoopInput {
  return {
    id: over.id ?? `olp_${randomUUID()}`,
    createdByRun: over.createdByRun ?? "run_1",
    title: over.title ?? "Renew the parking permit",
    description: over.description ?? "The permit lapses at the end of the month.",
    confidence: over.confidence ?? 0.8,
    importance: over.importance ?? 0.6,
    ...over,
  };
}

interface RetiredDbRow {
  id: string;
  title: string;
  title_norm: string;
  description: string;
  outcome: string;
  importance: number;
  created_at: number;
  retired_at: number;
  cadence_days: number | null;
  recurrence_count: number;
}

function retiredRows(db: Db): RetiredDbRow[] {
  return db.prepare<[], RetiredDbRow>("SELECT * FROM retired_loops ORDER BY retired_at, id").all();
}

describe("normalizeLoopTitle", () => {
  test("is order- and punctuation-insensitive and drops <3-char words", () => {
    expect(normalizeLoopTitle("Reply to the lawyer's email")).toBe("email lawyer reply the");
    // Same word set, different order + punctuation → same key.
    expect(normalizeLoopTitle("Email — the lawyer, reply!")).toBe("email lawyer reply the");
    // "to" / "s" are dropped (length < 3).
    expect(normalizeLoopTitle("Reply to it")).toBe("reply");
  });

  test("keeps non-Latin words rather than normalising to empty", () => {
    // Unicode-aware split: a CJK title survives as a single token.
    expect(normalizeLoopTitle("提交报告")).toBe("提交报告");
  });
});

describe("retired-loops consolidation store", () => {
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

  test("resolving an open loop (open→done) appends a trace with outcome 'done'", () => {
    createOpenLoop(
      db,
      loopInput({
        id: "olp_1",
        title: "Confirm the studio booking",
        description: "Awaiting the studio's reply.",
        importance: 0.7,
        actors: ["per_maya"],
        involved: ["per_sam"],
      }),
      1000,
    );
    updateOpenLoop(db, "olp_1", { state: "done" }, 5000);

    const rows = retiredRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "olp_1",
      title: "Confirm the studio booking",
      title_norm: "booking confirm studio the",
      outcome: "done",
      importance: 0.7, // the PRE-update importance snapshot
      created_at: 1000,
      retired_at: 5000,
      cadence_days: null,
      recurrence_count: 1,
    });
  });

  test("dismissing an open loop (open→dismissed) appends a trace with outcome 'dismissed'", () => {
    createOpenLoop(db, loopInput({ id: "olp_1" }), 1000);
    updateOpenLoop(db, "olp_1", { state: "dismissed" }, 5000);
    expect(retiredRows(db).map((r) => r.outcome)).toEqual(["dismissed"]);
  });

  test("a delete with { retire: true } records 'decayed' when the loop was decay-checked", () => {
    createOpenLoop(db, loopInput({ id: "olp_1" }), 1000);
    // A decay-check KEEP bumps decay_check_count to 1 without resolving.
    updateOpenLoop(db, "olp_1", { lastDecayCheck: 2000 }, 2000);
    deleteOpenLoop(db, "olp_1", { retire: true, now: 9000 });

    const rows = retiredRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "olp_1", outcome: "decayed", retired_at: 9000 });
  });

  test("a delete with { retire: true } records 'deleted' when the loop was never decay-checked", () => {
    createOpenLoop(db, loopInput({ id: "olp_1" }), 1000);
    deleteOpenLoop(db, "olp_1", { retire: true, now: 9000 });
    expect(retiredRows(db).map((r) => r.outcome)).toEqual(["deleted"]);
  });

  test("a delete WITHOUT the retire opt writes no trace (internal deletes stay trace-free)", () => {
    createOpenLoop(db, loopInput({ id: "olp_1" }), 1000);
    deleteOpenLoop(db, "olp_1");
    expect(retiredRows(db)).toEqual([]);
  });

  test("two retirements sharing a title_norm compute cadence_days = day-gap and recurrence 1 then 2", () => {
    // Two DISTINCT loops with the same title (identical title_norm), retired
    // three days apart.
    createOpenLoop(db, loopInput({ id: "olp_1", title: "Renew the parking permit" }), 1000);
    updateOpenLoop(db, "olp_1", { state: "done" }, 10 * DAY_MS);

    createOpenLoop(db, loopInput({ id: "olp_2", title: "Renew the parking permit" }), 11 * DAY_MS);
    updateOpenLoop(db, "olp_2", { state: "done" }, 13 * DAY_MS);

    const byId = new Map(retiredRows(db).map((r) => [r.id, r]));
    expect(byId.get("olp_1")).toMatchObject({ cadence_days: null, recurrence_count: 1 });
    expect(byId.get("olp_2")).toMatchObject({ cadence_days: 3, recurrence_count: 2 });
  });

  test("the prior lookup excludes self — re-retiring the same loop id keeps recurrence at 1", () => {
    // Resolve olp_1 (trace #1, recurrence 1), then delete the same id (trace
    // #2). Without self-exclusion, #2 would see #1 and count 2; with it, the
    // loop's own prior trace is ignored so the count stays 1.
    createOpenLoop(db, loopInput({ id: "olp_1", title: "Renew the parking permit" }), 1000);
    updateOpenLoop(db, "olp_1", { state: "done" }, 5 * DAY_MS);
    deleteOpenLoop(db, "olp_1", { retire: true, now: 8 * DAY_MS });

    const rows = retiredRows(db);
    // INSERT OR REPLACE on the loop id → one row, the latest disposition.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "olp_1",
      outcome: "deleted",
      cadence_days: null,
      recurrence_count: 1,
    });
  });

  test("searchRetiredLoopsLexical token-matches title + description, newest first", () => {
    createOpenLoop(
      db,
      loopInput({
        id: "olp_1",
        title: "Submit the passport renewal form",
        description: "The form was posted.",
      }),
      1000,
    );
    updateOpenLoop(db, "olp_1", { state: "done" }, 2000);

    createOpenLoop(
      db,
      loopInput({
        id: "olp_2",
        title: "Book the dentist",
        description: "Called about a passport.",
      }),
      1000,
    );
    updateOpenLoop(db, "olp_2", { state: "dismissed" }, 4000);

    // Unrelated trace that must not match.
    createOpenLoop(db, loopInput({ id: "olp_3", title: "Water the plants" }), 1000);
    updateOpenLoop(db, "olp_3", { state: "done" }, 3000);

    // "passport" is in olp_1's title and olp_2's description → both match,
    // newest-retired (olp_2 @4000) first.
    const hits = searchRetiredLoopsLexical(db, "passport");
    expect(hits.map((h: RetiredLoopRow) => h.id)).toEqual(["olp_2", "olp_1"]);

    // Short tokens (<3 chars) are ignored → no rows from a stopword-only query.
    expect(searchRetiredLoopsLexical(db, "of to")).toEqual([]);

    // The limit is honoured.
    expect(searchRetiredLoopsLexical(db, "passport", { limit: 1 }).map((h) => h.id)).toEqual([
      "olp_2",
    ]);
  });

  test("listRetiredLoops returns every trace newest-retired first, honouring the limit", () => {
    createOpenLoop(db, loopInput({ id: "olp_1", title: "Book the dentist" }), 1000);
    updateOpenLoop(db, "olp_1", { state: "done" }, 2000);
    createOpenLoop(db, loopInput({ id: "olp_2", title: "Renew the parking permit" }), 1000);
    updateOpenLoop(db, "olp_2", { state: "dismissed" }, 4000);
    createOpenLoop(db, loopInput({ id: "olp_3", title: "Water the plants" }), 1000);
    updateOpenLoop(db, "olp_3", { state: "done" }, 3000);

    expect(listRetiredLoops(db).map((r) => r.id)).toEqual(["olp_2", "olp_3", "olp_1"]);
    expect(listRetiredLoops(db, { limit: 2 }).map((r) => r.id)).toEqual(["olp_2", "olp_3"]);
  });

  test("a privacy delete NEVER writes a retired_loops trace (privacy invariant)", () => {
    createOpenLoop(db, loopInput({ id: "olp_1", docs: ["doc_gone"] }), 1000);
    const result = cascadeOpenLoopPrivacyDelete(db, ["doc_gone"]);
    expect(result.deletedLoopIds).toEqual(["olp_1"]);
    // The loop is gone from the active store...
    expect(db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM open_loops").get()!.n).toBe(0);
    // ...and left NO retirement trace behind (it would leak the purged title).
    expect(retiredRows(db)).toEqual([]);
  });
});
