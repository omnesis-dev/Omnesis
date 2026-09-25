// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The ledger's record of watch compilation restarts at the V2 compiler.
 *
 * Every `subscription_compile` row an existing install carries was written by
 * a compiler that no longer exists, in a payload shape that describes it —
 * stages it had, authoring paths it distinguished. Rather than teach every
 * reader a shape nothing will write again, migration 103 drops the rows.
 *
 * Two properties carry this file. The rows go and the accounting stays: spend
 * is a running per-day total with no run id in it, and attribution is designed
 * to outlive run rows, so unwinding either would be the deviation rather than
 * the cleanup. And the transcripts — files a SQL migration cannot reach — are
 * handed to the drain that runs at start, because a row deleted without its
 * artifact leaves a transcript the routes still serve by run id.
 *
 * All fixture data is invented.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  drainTranscriptEvictions,
  TRANSCRIPT_EVICTION_KEY,
  type TranscriptEvictionSink,
} from "../brain/transcript-eviction.js";
import { setCognitionEngineState } from "../brain/storage/engine-state.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import { runSchemaSetup } from "./schema.js";
import type { Db } from "./types.js";

const MIGRATION = MIGRATIONS.find((candidate) => candidate.version === 103);

let db: Db;

beforeEach(() => {
  db = new Database(":memory:") as unknown as Db;
  runSchemaSetup(db);
});
afterEach(() => db.close());

/** One settled run, in the shape `recordSettledCognitionRun` leaves behind. */
function seedRun(id: string, kind: string): void {
  db.prepare<[string, string]>(
    `INSERT INTO cognition_runs (
       id, kind, payload_json, dedupe_key, status, attempts, last_error, failure_code,
       next_attempt_at, enqueued_at, cycle_anchor_at, last_attempt_at, completed_at, usage_json
     ) VALUES (?, ?, '{}', NULL, 'completed', 1, NULL, NULL, 1000, 1000, 1000, 1000, 4000, NULL)`,
  ).run(id, kind);
}

function runIds(): string[] {
  return db
    .prepare<[], { id: string }>("SELECT id FROM cognition_runs ORDER BY id")
    .all()
    .map((row) => row.id);
}

function evictionQueue(): string[] {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM cognition_engine_state WHERE key = ?")
    .get(TRANSCRIPT_EVICTION_KEY);
  return row ? (JSON.parse(row.value) as string[]) : [];
}

describe("migration 103", () => {
  test("exists in the migration list", () => {
    expect(MIGRATION).toBeDefined();
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(103);
    expect(MIGRATIONS.filter((m) => m.version === 103)).toHaveLength(1);
  });

  test("drops every pre-V2 compile run and nothing else", () => {
    seedRun("run_compile_a", "subscription_compile");
    seedRun("run_compile_b", "subscription_compile");
    seedRun("run_datum", "data");
    seedRun("run_daily", "daily");

    MIGRATION?.up(db);

    // Only the compiles. A migration that took the whole ledger with them
    // would destroy the history of every other kind of reasoning.
    expect(runIds()).toEqual(["run_daily", "run_datum"]);
  });

  test("queues the deleted runs' transcripts for the drain that can reach them", () => {
    // The files are the other half of a run. Deleting rows without them
    // leaves transcripts the routes still serve by run id — records of a
    // compiler nothing else remembers.
    seedRun("run_compile_a", "subscription_compile");
    seedRun("run_compile_b", "subscription_compile");

    MIGRATION?.up(db);

    expect(evictionQueue().sort()).toEqual(["run_compile_a", "run_compile_b"]);
  });

  test("leaves the spend accounting alone", () => {
    // Spend rows are running per-(day, mechanism, model) totals carrying no
    // run id, so a compile's tokens cannot be unwound from them. They stay
    // accurate about what was actually spent.
    db.prepare(
      `INSERT INTO cognition_spend (day, mechanism, model_id, runs, prompt_tokens, completion_tokens)
       VALUES ('2026-07-02', 'subscription-compile', 'a-model', 3, 900, 90)`,
    ).run();
    seedRun("run_compile_a", "subscription_compile");

    MIGRATION?.up(db);

    expect(
      db
        .prepare<
          [],
          { runs: number }
        >("SELECT runs FROM cognition_spend WHERE mechanism = 'subscription-compile'")
        .get()?.runs,
    ).toBe(3);
  });

  test("is a no-op on an install that never compiled a watch", () => {
    seedRun("run_datum", "data");

    MIGRATION?.up(db);
    MIGRATION?.up(db);

    expect(runIds()).toEqual(["run_datum"]);
    expect(evictionQueue()).toEqual([]);
  });

  test("runs clean on a fresh install, through the whole sequence", () => {
    // Every migration runs on a fresh database after `runSchemaSetup`, so a
    // step that assumes rows or a table shape only an upgraded install has
    // fails a first boot.
    const fresh = new Database(":memory:") as unknown as Db;
    try {
      runSchemaSetup(fresh);
      expect(() => runMigrations(fresh)).not.toThrow();
      expect(
        fresh.prepare<[], { user_version: number }>("PRAGMA user_version").get()?.user_version,
      ).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      fresh.close();
    }
  });
});

/**
 * The write gate, reduced to the one verb.
 *
 * The drain runs on the main thread, whose handle on the main database is
 * read-only since the single-writer invariant: one worker owns the only
 * writable connection. A drain that cleared the queue directly would throw
 * *after* the files were already gone, so the queue would survive and every
 * subsequent start would retry a job with nothing left to do.
 */
function gate(): TranscriptEvictionSink & { wrote: Array<[string, string]> } {
  const wrote: Array<[string, string]> = [];
  return {
    wrote,
    setCognitionEngineState: (key, value) => {
      wrote.push([key, value]);
      setCognitionEngineState(db, key, value);
      return Promise.resolve();
    },
  };
}

describe("the drain that finishes what the migration started", () => {
  test("deletes the queued transcripts and clears the queue through the write gate", async () => {
    seedRun("run_compile_a", "subscription_compile");
    MIGRATION?.up(db);
    const deleted: string[][] = [];
    const writeGate = gate();

    const count = await drainTranscriptEvictions(
      db,
      {
        evictRuns: (ids) => {
          deleted.push([...ids]);
          return Promise.resolve(ids.length);
        },
      },
      writeGate,
    );

    expect(deleted).toEqual([["run_compile_a"]]);
    expect(count).toBe(1);
    expect(evictionQueue()).toEqual([]);
    // Through the gate, not around it. A drain reaching the database directly
    // passes every in-memory test and fails on a real gateway.
    expect(writeGate.wrote).toEqual([[TRANSCRIPT_EVICTION_KEY, "[]"]]);
  });

  test("gets all the way through against a read-only handle", async () => {
    // The handle the gateway actually gives it. This is the shape of the
    // failure it is worth having a test for: the files go, the clear throws,
    // and the queue is still there at the next start — forever.
    const file = join(mkdtempSync(join(tmpdir(), "omnesis-evict-")), "omnesis.db");
    const writable = new Database(file) as unknown as Db;
    runSchemaSetup(writable);
    writable
      .prepare<[string, string]>("INSERT INTO cognition_engine_state (key, value) VALUES (?, ?)")
      .run(TRANSCRIPT_EVICTION_KEY, JSON.stringify(["run_compile_a"]));
    writable.close();

    const readOnly = new Database(file, { readonly: true }) as unknown as Db;
    const cleared: Array<[string, string]> = [];
    try {
      const count = await drainTranscriptEvictions(
        readOnly,
        { evictRuns: (ids) => Promise.resolve(ids.length) },
        {
          setCognitionEngineState: (key, value) => {
            cleared.push([key, value]);
            return Promise.resolve();
          },
        },
      );

      expect(count).toBe(1);
      expect(cleared).toEqual([[TRANSCRIPT_EVICTION_KEY, "[]"]]);
    } finally {
      readOnly.close();
    }
  });

  test("keeps the queue when the deletion failed, so the next start retries", async () => {
    // A gateway must not fail to start over debug artifacts — but it must not
    // forget them either, or the files outlive their rows forever.
    seedRun("run_compile_a", "subscription_compile");
    MIGRATION?.up(db);

    await drainTranscriptEvictions(
      db,
      { evictRuns: () => Promise.reject(new Error("the disk is full")) },
      gate(),
    );

    expect(evictionQueue()).toEqual(["run_compile_a"]);
  });

  test("asks for nothing when there is nothing queued", async () => {
    let called = false;
    await drainTranscriptEvictions(
      db,
      {
        evictRuns: () => {
          called = true;
          return Promise.resolve(0);
        },
      },
      gate(),
    );
    expect(called).toBe(false);
  });
});
