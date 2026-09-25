// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The daily rhythm's due-gate + enqueue contract (criterion 6's daily
 * half): fires once per local day at/after the configured hour; after
 * downtime fires once for the most recent boundary (never N times); one
 * `daily` batch run per source with sample-typed data in the previous
 * day — all dedupe-keyed so a replayed pass folds
 * instead of double-enqueueing.
 */

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createLogger } from "@omnesis/core";
import { createDatabase } from "../../db.js";
import { enqueueCognitionRun, type EnqueueCognitionRunInput } from "../storage/run-queue.js";
import {
  getCognitionEngineState,
  setCognitionEngineState,
  COGNITION_DAILY_LAST_RUN_DAY_KEY,
} from "../storage/engine-state.js";
import { dailySourceRunDedupeKey } from "../run-payloads.js";
import { runDailyEnqueuePass, type DailyEnqueuerWriteOps } from "./daily-enqueuer.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const log = createLogger("test:briefs-rhythm");

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

/** Local-time instant helper (the rhythm's boundary basis is local time). */
function local(y: number, mo: number, d: number, h: number, mi = 0): number {
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}
/** Local `YYYY-MM-DD` for an instant. */
function localDay(ms: number): string {
  const dt = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

describe("daily enqueuer", () => {
  let path: string;
  let db: Db;
  let clockNow: number;

  const writeOps = (): DailyEnqueuerWriteOps => ({
    enqueueCognitionRun: async (input: EnqueueCognitionRunInput, now: number) =>
      enqueueCognitionRun(db, input, now),
    setCognitionEngineState: async (key: string, value: string) =>
      setCognitionEngineState(db, key, value),
  });

  const pass = () =>
    runDailyEnqueuePass({
      db,
      writeGate: writeOps(),
      clock: () => clockNow,
      getDailyRunHour: () => 5,
      log,
      idGen: () => randomUUID(),
    });

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  /** Seed one document row with a source timestamp + documentType. */
  function seedDoc(sourceId: string, documentType: string, sourceCreatedAtMs: number): void {
    const iso = new Date(sourceCreatedAtMs).toISOString();
    db.prepare(
      `INSERT INTO documents (
         id, provider_id, source_id, external_id, title, content, content_hash,
         metadata, source_created_at, source_updated_at, ingested_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `doc_${randomUUID()}`,
      "prov",
      sourceId,
      `ext_${randomUUID()}`,
      "t",
      "c",
      "h",
      JSON.stringify({ documentType }),
      iso,
      iso,
      iso,
      iso,
    );
  }

  /** Seed a rolling-aggregate document (the generic marker, not a sample type). */
  function seedRollingAggregateDoc(sourceId: string, sourceCreatedAtMs: number): void {
    const iso = new Date(sourceCreatedAtMs).toISOString();
    db.prepare(
      `INSERT INTO documents (
         id, provider_id, source_id, external_id, title, content, content_hash,
         metadata, source_created_at, source_updated_at, ingested_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `doc_${randomUUID()}`,
      "prov",
      sourceId,
      `ext_${randomUUID()}`,
      "t",
      "c",
      "h",
      JSON.stringify({ documentType: "summary", rollingAggregate: true }),
      iso,
      iso,
      iso,
      iso,
    );
  }

  function pendingRuns(): { kind: string; dedupe_key: string | null; payload_json: string }[] {
    return db
      .prepare<
        [],
        { kind: string; dedupe_key: string | null; payload_json: string }
      >("SELECT kind, dedupe_key, payload_json FROM cognition_runs WHERE status = 'pending' ORDER BY dedupe_key")
      .all();
  }

  test("the due-gate fires once per day at/after the hour, never twice", async () => {
    // Yesterday already handled.
    setCognitionEngineState(db, COGNITION_DAILY_LAST_RUN_DAY_KEY, localDay(local(2026, 3, 9, 5)));

    clockNow = local(2026, 3, 10, 4, 59);
    expect((await pass()).fired).toBe(false);

    clockNow = local(2026, 3, 10, 5, 0);
    expect((await pass()).fired).toBe(true);
    expect(getCognitionEngineState(db, COGNITION_DAILY_LAST_RUN_DAY_KEY)).toBe(
      localDay(local(2026, 3, 10, 5)),
    );

    clockNow = local(2026, 3, 10, 5, 30);
    expect((await pass()).fired).toBe(false);
    clockNow = local(2026, 3, 10, 23, 0);
    expect((await pass()).fired).toBe(false);
  });

  test("after downtime the gate fires ONCE for the most recent boundary, not once per missed day", async () => {
    setCognitionEngineState(db, COGNITION_DAILY_LAST_RUN_DAY_KEY, localDay(local(2026, 3, 1, 5)));
    // A sample-typed doc for each of several missed days.
    seedDoc("bank-main", "transaction", local(2026, 3, 3, 12));
    seedDoc("bank-main", "transaction", local(2026, 3, 9, 12)); // in the final range

    clockNow = local(2026, 3, 10, 6, 0);
    const result = await pass();
    expect(result.fired).toBe(true);

    // One batch for the [Mar 9 05:00, Mar 10 05:00) range. The datum from the
    // 3rd is NOT re-batched — the backlog rule in prompts covers it.
    const rows = pendingRuns();
    expect(rows).toHaveLength(1);
    const batch = rows.find((r) => r.dedupe_key?.startsWith("daily:source:"));
    expect(batch?.dedupe_key).toBe(dailySourceRunDedupeKey("bank-main", "2026-03-10"));
    const payload = JSON.parse(batch!.payload_json) as { dateFrom: string; dateTo: string };
    expect(Date.parse(payload.dateFrom)).toBe(local(2026, 3, 9, 5));
    expect(Date.parse(payload.dateTo)).toBe(local(2026, 3, 10, 5));

    // And it does not fire again.
    expect((await pass()).fired).toBe(false);
    expect(pendingRuns()).toHaveLength(1);
  });

  test("one daily batch per source with sample-typed data in range; other data never batches", async () => {
    const inRange = local(2026, 3, 9, 12);
    seedDoc("bank-main", "transaction", inRange);
    seedDoc("bank-main", "transaction", local(2026, 3, 9, 15)); // same source, still one run
    seedDoc("fitness-tracker", "activity", inRange);
    seedDoc("bank-old", "transaction", local(2026, 3, 5, 12)); // out of range
    seedDoc("mail-main", "email", inRange); // not a sample type

    clockNow = local(2026, 3, 10, 5, 0);
    const result = await pass();
    expect(result.sourceIds).toEqual(["bank-main", "fitness-tracker"]);

    const rows = pendingRuns();
    const batchKeys = rows.map((r) => r.dedupe_key).filter((k) => k?.startsWith("daily:source:"));
    expect(batchKeys).toEqual([
      dailySourceRunDedupeKey("bank-main", "2026-03-10"),
      dailySourceRunDedupeKey("fitness-tracker", "2026-03-10"),
    ]);
    for (const row of rows) expect(row.kind).toBe("daily");
    const batch = JSON.parse(
      rows.find((r) => r.dedupe_key === batchKeys[0])!.payload_json,
    ) as Record<string, unknown>;
    expect(batch["sourceId"]).toBe("bank-main");
  });

  test("a rolling-aggregate source (generic marker, not a sample type) still gets a daily batch", async () => {
    // The waker routes rolling-aggregate summaries to the daily batch instead
    // of waking per rewrite; the daily enqueuer must therefore still discover
    // the source by its generic metadata marker, not only by sample doc types.
    seedRollingAggregateDoc("usage-tracker:local", local(2026, 3, 9, 12));
    seedDoc("bank-main", "transaction", local(2026, 3, 9, 12)); // a sample type, unioned in
    seedDoc("mail-main", "email", local(2026, 3, 9, 12)); // neither — never batches

    clockNow = local(2026, 3, 10, 5, 0);
    const result = await pass();
    expect(result.sourceIds).toEqual(["bank-main", "usage-tracker:local"]);

    const batchKeys = pendingRuns()
      .map((r) => r.dedupe_key)
      .filter((k) => k?.startsWith("daily:source:"));
    expect(batchKeys).toEqual([
      dailySourceRunDedupeKey("bank-main", "2026-03-10"),
      dailySourceRunDedupeKey("usage-tracker:local", "2026-03-10"),
    ]);
  });

  test("an analytics-only source still gets a daily batch; a source on both planes is deduped", async () => {
    // Document plane: bank-main produced transactions; mail-main is not a
    // sample type and never batches.
    seedDoc("bank-main", "transaction", local(2026, 3, 9, 12));
    seedDoc("mail-main", "email", local(2026, 3, 9, 12));

    // Analytics plane: health-tracker's whole day was samples (no documents),
    // and bank-main appears here too (both planes) — it must dedupe to one
    // batch, not two.
    let probed: { fromMs: number; toMs: number } | null = null;
    const listAnalyticsSampleSourceIds = async (
      fromMs: number,
      toMs: number,
    ): Promise<string[]> => {
      probed = { fromMs, toMs };
      return ["health-tracker", "bank-main"];
    };

    clockNow = local(2026, 3, 10, 5, 0);
    const result = await runDailyEnqueuePass({
      db,
      writeGate: writeOps(),
      clock: () => clockNow,
      getDailyRunHour: () => 5,
      log,
      listAnalyticsSampleSourceIds,
      idGen: () => randomUUID(),
    });

    // Probed with the same boundary-to-boundary range the document scan uses.
    expect(probed).toEqual({ fromMs: local(2026, 3, 9, 5), toMs: local(2026, 3, 10, 5) });
    // bank-main (deduped across planes) + health-tracker (analytics-only), sorted.
    expect(result.sourceIds).toEqual(["bank-main", "health-tracker"]);

    const batchKeys = pendingRuns()
      .map((r) => r.dedupe_key)
      .filter((k) => k?.startsWith("daily:source:"));
    expect(batchKeys).toEqual([
      dailySourceRunDedupeKey("bank-main", "2026-03-10"),
      dailySourceRunDedupeKey("health-tracker", "2026-03-10"),
    ]);
  });

  test("the pass enqueues source batches only — the day-ahead lookahead is a sweep", async () => {
    // The day-ahead lookahead is the `may-day` system sweep, with its own
    // cadence and anchor, so a boundary with no batchable source enqueues
    // nothing at all.
    clockNow = local(2026, 3, 10, 5, 0);
    expect((await pass()).fired).toBe(true);
    expect(pendingRuns()).toHaveLength(0);
  });

  test("a replayed pass (crash before the marker write) folds by dedupe key — restart-safe", async () => {
    seedDoc("bank-main", "transaction", local(2026, 3, 9, 12));
    clockNow = local(2026, 3, 10, 5, 0);
    await pass();
    expect(pendingRuns()).toHaveLength(1);

    // Simulate the crash-before-marker replay: roll the marker back and re-run.
    setCognitionEngineState(db, COGNITION_DAILY_LAST_RUN_DAY_KEY, "2026-03-09");
    const replay = await pass();
    expect(replay.fired).toBe(true);
    expect(pendingRuns()).toHaveLength(1); // folded, not duplicated
  });

  test("a backwards clock jump past an already-run day stays quiet", async () => {
    setCognitionEngineState(db, COGNITION_DAILY_LAST_RUN_DAY_KEY, "2026-03-10");
    clockNow = local(2026, 3, 9, 6, 0);
    expect((await pass()).fired).toBe(false);
  });
});
