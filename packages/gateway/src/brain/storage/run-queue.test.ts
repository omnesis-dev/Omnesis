// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
type Db = Database.Database;
import { createDatabase } from "../../db.js";
import { pruneActivityRetentionBatch } from "../../activity-retention/store.js";
import { notesCompactionRunDedupeKey, SCHEDULED_INSTRUCTION_MAX_CHARS } from "../run-payloads.js";
import { DERIVATION_STAGES } from "../../domain/DocumentDerivation.js";
import {
  cancelScheduledRunsForLoop,
  claimDueCognitionRuns,
  completeCognitionRun,
  countPendingCognitionRuns,
  enqueueCognitionRun,
  failCognitionRun,
  finalizeCognitionRun,
  getCognitionRun,
  getPendingRunByDedupeKey,
  listCognitionRuns,
  listCognitionRunsByDedupePrefix,
  pullForwardReadyCognitionRun,
  recordSettledCognitionRun,
} from "./run-queue.js";
import { getCognitionSpendDayTotal, listCognitionSpend } from "./spend.js";

function testDbPath(): string {
  return `/tmp/omnesis-test-${randomUUID()}.db`;
}
function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

// A fixed future UTC-day bucket (day index 20000) for the scheduled-run dedup
// tests, plus a helper to place a fire time at a given hour within it — the
// operator's "same loop got both a 07:00 and an 08:00 identical check on one
// day" scenario, distilled to two ms in a single UTC calendar day.
const SCHED_DAY_MS = 20_000 * 86_400_000;
function schedAt(hours: number): number {
  return SCHED_DAY_MS + hours * 3_600_000;
}

import { getRunAttribution } from "./run-attribution.js";
import type Database from "better-sqlite3";

describe("steward run queue", () => {
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

  test("readiness and schedule CAS are evaluated in the same write", () => {
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc-race', 'google', 'drive:maya@example.com', 'ext-race', 'Example', '', 'hash', '{}', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run();
    enqueueCognitionRun(
      db,
      {
        id: "run-race",
        kind: "data",
        payload: { docId: "doc-race", debounceUntil: 2_000, barrierUntil: 3_000 },
        notBefore: 3_000,
      },
      1_000,
    );

    expect(
      pullForwardReadyCognitionRun(
        db,
        "run-race",
        "doc-race",
        2_000,
        2_000,
        3_000,
        DERIVATION_STAGES,
      ),
    ).toBe(false);
    expect(getCognitionRun(db, "run-race")!.nextAttemptAt).toBe(3_000);

    db.prepare("DELETE FROM documents WHERE id = ?").run("doc-race");
    expect(
      pullForwardReadyCognitionRun(
        db,
        "run-race",
        "doc-race",
        2_000,
        2_000,
        3_000,
        DERIVATION_STAGES,
      ),
    ).toBe(true);
    expect(getCognitionRun(db, "run-race")!.nextAttemptAt).toBe(2_000);

    db.prepare("UPDATE cognition_runs SET next_attempt_at = 3000 WHERE id = ?").run("run-race");
    db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content, content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES ('doc-race', 'google', 'drive:maya@example.com', 'ext-race', 'Example', '', 'hash', '{}', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run();
    expect(pullForwardReadyCognitionRun(db, "run-race", "doc-race", 2_000, 2_000, 3_000, [])).toBe(
      true,
    );
  });

  describe("attribution is written when a run settles", () => {
    // Without this, deleting the `recordRunAttribution` call in
    // `finalizeCognitionRun` leaves every other test green — the whole
    // provenance surface reads from a table nothing proved gets written.
    test("a completed run records its workflow, version and model", () => {
      enqueueCognitionRun(
        db,
        {
          id: "run_att",
          kind: "data",
          payload: { docId: "d1", event: "created", datumAt: 1 },
        },
        1000,
      );
      claimDueCognitionRuns(db, { now: 1000 });
      finalizeCognitionRun(db, {
        runId: "run_att",
        now: 2000,
        day: "2026-01-01",
        mechanism: "datum-intake",
        modelId: "scripted-model",
        usage: { promptTokens: 10, completionTokens: 2 },
        outcome: { kind: "completed" },
      });

      expect(getRunAttribution(db, "run_att")).toMatchObject({
        runId: "run_att",
        workflowId: "datum-intake",
        workflowVersion: 1,
        modelId: "scripted-model",
        settledAt: 2000,
      });
    });

    test("a terminally failed run is attributed too", () => {
      // A run can write artifacts and then fail; those artifacts still need to
      // be explainable.
      enqueueCognitionRun(db, { id: "run_fail", kind: "verification", payload: {} }, 1000);
      claimDueCognitionRuns(db, { now: 1000 });
      finalizeCognitionRun(db, {
        runId: "run_fail",
        now: 3000,
        day: "2026-01-01",
        mechanism: "memory-regrounding",
        modelId: "",
        usage: null,
        outcome: { kind: "failed", errorMessage: "boom", terminal: true, nextAttemptAt: 0 },
      });

      expect(getRunAttribution(db, "run_fail")).toMatchObject({
        workflowId: "memory-regrounding",
        modelId: "",
      });
    });
  });

  test("enqueue then claim: ASAP run is due at now, attempts bump on claim", () => {
    enqueueCognitionRun(db, { id: "run_1", kind: "data", payload: { docId: "doc_a" } }, 1000);
    const claimed = claimDueCognitionRuns(db, { now: 1000, limit: 10 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toEqual({
      id: "run_1",
      kind: "data",
      payload: { docId: "doc_a" },
      payloadJson: JSON.stringify({ docId: "doc_a" }),
      attempts: 1,
    });
    // Still pending on disk (no claimed status) — a crash re-claims it later.
    expect(getCognitionRun(db, "run_1")?.status).toBe("pending");
  });

  test("a scheduled run is invisible until notBefore passes", () => {
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "time_based", payload: { prompt: "check the quote" }, notBefore: 5000 },
      1000,
    );
    expect(claimDueCognitionRuns(db, { now: 4999 })).toHaveLength(0);
    expect(claimDueCognitionRuns(db, { now: 5000 })).toHaveLength(1);
  });

  test("claims are exactly-once per tick: a claimed row is not re-claimed while in flight", () => {
    enqueueCognitionRun(db, { id: "run_1", kind: "data", payload: {} }, 1000);
    expect(claimDueCognitionRuns(db, { now: 1000 })).toHaveLength(1);
    // Second drain at the same instant: attempts bumped, next_attempt_at
    // unchanged, so the row IS visible again — the drain serializes runs
    // and pushes next_attempt_at out (or completes) before its next tick.
    // The attempts cap is the crash back-stop:
    expect(claimDueCognitionRuns(db, { now: 1000, maxAttempts: 2 })).toHaveLength(1);
    expect(claimDueCognitionRuns(db, { now: 1000, maxAttempts: 2 })).toHaveLength(0);
  });

  test("ordering: oldest-due first, limit respected", () => {
    enqueueCognitionRun(db, { id: "run_b", kind: "data", payload: {}, notBefore: 2000 }, 1000);
    enqueueCognitionRun(db, { id: "run_a", kind: "data", payload: {}, notBefore: 1000 }, 1000);
    enqueueCognitionRun(db, { id: "run_c", kind: "data", payload: {}, notBefore: 3000 }, 1000);
    const claimed = claimDueCognitionRuns(db, { now: 10_000, limit: 2 });
    expect(claimed.map((r) => r.id)).toEqual(["run_a", "run_b"]);
  });

  test("reactive kinds (feedback, data) claim ahead of generative/periodic when all are due", () => {
    // Same due instant for all — kind priority, not next_attempt_at, decides.
    enqueueCognitionRun(
      db,
      { id: "run_synth", kind: "synthesis", payload: {}, notBefore: 1000 },
      1000,
    );
    enqueueCognitionRun(db, { id: "run_daily", kind: "daily", payload: {}, notBefore: 1000 }, 1000);
    enqueueCognitionRun(db, { id: "run_data", kind: "data", payload: {}, notBefore: 1000 }, 1000);
    enqueueCognitionRun(db, { id: "run_fb", kind: "feedback", payload: {}, notBefore: 1000 }, 1000);
    const claimed = claimDueCognitionRuns(db, { now: 10_000, limit: 10 });
    expect(claimed.map((r) => r.id).slice(0, 2)).toEqual(["run_fb", "run_data"]);
    expect(new Set(claimed.map((r) => r.id).slice(2))).toEqual(new Set(["run_synth", "run_daily"]));
  });

  test("verification is idle-only (lowest rank, like bootstrap): a due daily claims first", () => {
    // The re-verification backlog must never delay the periodic lanes — a
    // pre-daily sweep tick enqueues verification runs at next_attempt_at=now,
    // and the morning brief still has to claim ahead of them.
    enqueueCognitionRun(
      db,
      { id: "run_verify", kind: "verification", payload: {}, notBefore: 1000 },
      1000,
    );
    enqueueCognitionRun(db, { id: "run_daily", kind: "daily", payload: {}, notBefore: 2000 }, 2000);
    // SQL rank: the limit-1 claim takes the daily even though the
    // verification run has the older due time.
    expect(claimDueCognitionRuns(db, { now: 10_000, limit: 1 }).map((r) => r.id)).toEqual([
      "run_daily",
    ]);
    // Idle queue (the daily settled): the verification backlog drains on
    // leftover capacity.
    completeCognitionRun(db, "run_daily", { usage: null, now: 10_001 });
    expect(claimDueCognitionRuns(db, { now: 10_001, limit: 1 }).map((r) => r.id)).toEqual([
      "run_verify",
    ]);
  });

  test("complete records usage and settles the payload to its reference shape", () => {
    enqueueCognitionRun(
      db,
      {
        id: "run_1",
        kind: "data",
        payload: {
          docId: "doc_a",
          event: "updated",
          diff: "…diff text…",
          snapshot: { content: "old body", capturedAt: 900 },
        },
      },
      1000,
    );
    claimDueCognitionRuns(db, { now: 1000 });
    completeCognitionRun(db, "run_1", {
      usage: { promptTokens: 1200, completionTokens: 300 },
      now: 2000,
    });
    const run = getCognitionRun(db, "run_1");
    expect(run?.status).toBe("completed");
    expect(run?.completedAt).toBe(2000);
    expect(run?.usage).toEqual({ promptTokens: 1200, completionTokens: 300 });
    // No prior-version storage: the fold snapshot + diff die with the run;
    // the reference-shaped rest is retained so the settled row still says
    // what triggered it.
    expect(run?.payload).toEqual({ docId: "doc_a", event: "updated" });
    expect(claimDueCognitionRuns(db, { now: 10_000 })).toHaveLength(0);
  });

  test("soft failure re-pends with a pushed-out horizon; terminal failure ends the run", () => {
    enqueueCognitionRun(db, { id: "run_1", kind: "feedback", payload: { briefId: "brf_1" } }, 1000);
    claimDueCognitionRuns(db, { now: 1000 });
    failCognitionRun(db, "run_1", {
      errorMessage: "backend timeout",
      terminal: false,
      nextAttemptAt: 6000,
      now: 1100,
    });
    let run = getCognitionRun(db, "run_1");
    expect(run?.status).toBe("pending");
    expect(run?.lastError).toBe("backend timeout");
    expect(run?.nextAttemptAt).toBe(6000);
    expect(claimDueCognitionRuns(db, { now: 5999 })).toHaveLength(0);
    expect(claimDueCognitionRuns(db, { now: 6000 })).toHaveLength(1);
    failCognitionRun(db, "run_1", {
      errorMessage: "backend gone",
      terminal: true,
      nextAttemptAt: 0,
      now: 6100,
    });
    run = getCognitionRun(db, "run_1");
    expect(run?.status).toBe("failed");
    expect(run?.completedAt).toBe(6100);
    // A terminal failure settles the payload like a completion — the
    // reference-shaped fields survive.
    expect(run?.payload).toEqual({ briefId: "brf_1" });
    expect(claimDueCognitionRuns(db, { now: 10_000 })).toHaveLength(0);
  });

  test("fold-on-update: an enqueue with a matching pending dedupe key replaces the payload", () => {
    const first = enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: { rev: 1 }, dedupeKey: "doc:abc" },
      1000,
    );
    expect(first).toEqual({ outcome: "inserted", runId: "run_1", nextAttemptAt: 1000 });
    const second = enqueueCognitionRun(
      db,
      { id: "run_2", kind: "data", payload: { rev: 2 }, dedupeKey: "doc:abc", notBefore: 3000 },
      2000,
    );
    // The fold adopts the new schedule, and reports it.
    expect(second).toEqual({ outcome: "folded", runId: "run_1", nextAttemptAt: 3000 });
    // One pending row, carrying the folded payload + schedule; run_2 never existed.
    expect(getCognitionRun(db, "run_2")).toBeNull();
    const pending = getPendingRunByDedupeKey(db, "doc:abc");
    expect(pending?.id).toBe("run_1");
    expect(pending?.payload).toEqual({ rev: 2 });
    expect(pending?.nextAttemptAt).toBe(3000);
  });

  test("notes_compaction runs fold on their fixed dedupe key — one pending compaction", () => {
    // Every over-cap notes write enqueues a compaction; the fixed key folds
    // them all into one pending run. The run reads the live notes at claim
    // time, so the newest reason simply replaces the older one.
    const first = enqueueCognitionRun(
      db,
      {
        id: "run_1",
        kind: "notes_compaction",
        payload: { reason: "notes at 9000 of 8192 bytes after append" },
        dedupeKey: notesCompactionRunDedupeKey(),
      },
      1000,
    );
    expect(first).toEqual({ outcome: "inserted", runId: "run_1", nextAttemptAt: 1000 });
    const second = enqueueCognitionRun(
      db,
      {
        id: "run_2",
        kind: "notes_compaction",
        payload: { reason: "notes at 9400 of 8192 bytes after append" },
        dedupeKey: notesCompactionRunDedupeKey(),
      },
      2000,
    );
    expect(second).toEqual({ outcome: "folded", runId: "run_1", nextAttemptAt: 2000 });
    expect(getCognitionRun(db, "run_2")).toBeNull();
    const pending = getPendingRunByDedupeKey(db, notesCompactionRunDedupeKey());
    expect(pending?.id).toBe("run_1");
    expect(pending?.payload).toEqual({ reason: "notes at 9400 of 8192 bytes after append" });
    // Once the pending run settles, a fresh over-cap write enqueues anew.
    claimDueCognitionRuns(db, { now: 2500 });
    completeCognitionRun(db, "run_1", { usage: null, now: 2600 });
    const third = enqueueCognitionRun(
      db,
      {
        id: "run_3",
        kind: "notes_compaction",
        payload: { reason: "notes at 8700 of 8192 bytes after append" },
        dedupeKey: notesCompactionRunDedupeKey(),
      },
      3000,
    );
    expect(third).toEqual({ outcome: "inserted", runId: "run_3", nextAttemptAt: 3000 });
  });

  test("a completed run does not fold a new enqueue on the same key", () => {
    enqueueCognitionRun(db, { id: "run_1", kind: "data", payload: {}, dedupeKey: "doc:abc" }, 1000);
    claimDueCognitionRuns(db, { now: 1000 });
    completeCognitionRun(db, "run_1", { usage: null, now: 1100 });
    const next = enqueueCognitionRun(
      db,
      { id: "run_2", kind: "data", payload: {}, dedupeKey: "doc:abc" },
      2000,
    );
    expect(next).toEqual({ outcome: "inserted", runId: "run_2", nextAttemptAt: 2000 });
  });

  test("enqueue is idempotent on the row id", () => {
    enqueueCognitionRun(db, { id: "run_1", kind: "daily", payload: { day: "2026-07-01" } }, 1000);
    enqueueCognitionRun(db, { id: "run_1", kind: "daily", payload: { day: "2026-07-02" } }, 2000);
    expect(getCognitionRun(db, "run_1")?.payload).toEqual({ day: "2026-07-01" });
  });

  test("finalize completed: row settled, usage stored, spend attributed to (mechanism, model)", () => {
    enqueueCognitionRun(db, { id: "run_1", kind: "data", payload: { docId: "d" } }, 1000);
    claimDueCognitionRuns(db, { now: 1000 });
    finalizeCognitionRun(db, {
      runId: "run_1",
      now: 2000,
      day: "2026-07-02",
      mechanism: "data",
      modelId: "model-x",
      usage: { promptTokens: 120, completionTokens: 30 },
      outcome: { kind: "completed" },
    });
    const row = getCognitionRun(db, "run_1");
    expect(row?.status).toBe("completed");
    expect(row?.usage).toEqual({ promptTokens: 120, completionTokens: 30 });
    // The reference-shaped payload survives the settle.
    expect(row?.payload).toEqual({ docId: "d" });
    expect(listCognitionSpend(db)).toEqual([
      {
        day: "2026-07-02",
        mechanism: "data",
        modelId: "model-x",
        runs: 1,
        promptTokens: 120,
        completionTokens: 30,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ]);
  });

  test("finalize completed: cache split survives usage_json and folds into spend", () => {
    enqueueCognitionRun(db, { id: "run_1", kind: "data", payload: { docId: "d" } }, 1000);
    claimDueCognitionRuns(db, { now: 1000 });
    finalizeCognitionRun(db, {
      runId: "run_1",
      now: 2000,
      day: "2026-07-02",
      mechanism: "data",
      modelId: "model-x",
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        cacheReadTokens: 90,
        cacheCreationTokens: 10,
      },
      outcome: { kind: "completed" },
    });
    expect(getCognitionRun(db, "run_1")?.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      cacheReadTokens: 90,
      cacheCreationTokens: 10,
    });
    expect(getCognitionSpendDayTotal(db, "2026-07-02")).toEqual({
      day: "2026-07-02",
      runs: 1,
      promptTokens: 120,
      completionTokens: 30,
      cacheReadTokens: 90,
      cacheCreationTokens: 10,
    });
  });

  test("finalize failed attempt: tokens still counted, runs counter untouched", () => {
    enqueueCognitionRun(db, { id: "run_1", kind: "data", payload: { docId: "d" } }, 1000);
    claimDueCognitionRuns(db, { now: 1000 });
    finalizeCognitionRun(db, {
      runId: "run_1",
      now: 2000,
      day: "2026-07-02",
      mechanism: "data",
      modelId: "model-x",
      usage: { promptTokens: 80, completionTokens: 5 },
      outcome: {
        kind: "failed",
        errorMessage: "backend 500",
        terminal: false,
        nextAttemptAt: 9000,
      },
    });
    const row = getCognitionRun(db, "run_1");
    expect(row?.status).toBe("pending");
    expect(row?.lastError).toBe("backend 500");
    expect(row?.nextAttemptAt).toBe(9000);
    // A failed attempt spent tokens but is not a completed run.
    expect(getCognitionSpendDayTotal(db, "2026-07-02")).toEqual({
      day: "2026-07-02",
      runs: 0,
      promptTokens: 80,
      completionTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  test("finalize terminal failure drops the transient snapshot/diff", () => {
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: { docId: "d", diff: "big diff" } },
      1000,
    );
    claimDueCognitionRuns(db, { now: 1000 });
    finalizeCognitionRun(db, {
      runId: "run_1",
      now: 2000,
      day: "2026-07-02",
      mechanism: "data",
      modelId: null,
      usage: null,
      outcome: {
        kind: "failed",
        errorMessage: "prompt is too long",
        failureCode: "context_window_exceeded",
        terminal: true,
        nextAttemptAt: 0,
      },
    });
    const row = getCognitionRun(db, "run_1");
    expect(row?.status).toBe("failed");
    // The diff must not outlive the run, even a failed one; the doc
    // reference survives.
    expect(row?.payload).toEqual({ docId: "d" });
  });

  test("finalize with an in-flight fold resurrects the row instead of settling it", () => {
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: { v: 1 }, dedupeKey: "data:doc:d1" },
      1000,
    );
    const [claimed] = claimDueCognitionRuns(db, { now: 1000 });
    // A fold lands while the run is in flight (the row is still pending).
    enqueueCognitionRun(
      db,
      { id: "run_2", kind: "data", payload: { v: 2 }, dedupeKey: "data:doc:d1" },
      1500,
    );
    finalizeCognitionRun(db, {
      runId: "run_1",
      now: 2000,
      day: "2026-07-02",
      mechanism: "data",
      modelId: "model-x",
      usage: { promptTokens: 10, completionTokens: 2 },
      claimedPayloadJson: claimed.payloadJson,
      outcome: { kind: "completed" },
    });
    const row = getCognitionRun(db, "run_1")!;
    // Back to pending as a logically fresh run over the folded payload…
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.failureCode).toBeNull();
    expect(row.payload).toEqual({ v: 2 });
    // …while the attempt's spend was still recorded.
    expect(getCognitionSpendDayTotal(db, "2026-07-02")).toMatchObject({ promptTokens: 10 });
  });

  test("terminal failure resurrects different work folded during the final attempt", () => {
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: { v: 1 }, dedupeKey: "data:doc:d1" },
      1000,
    );
    const [claimed] = claimDueCognitionRuns(db, { now: 1000 });
    // A fold lands while the terminal attempt is in flight.
    enqueueCognitionRun(
      db,
      { id: "run_2", kind: "data", payload: { v: 2 }, dedupeKey: "data:doc:d1" },
      1500,
    );
    finalizeCognitionRun(db, {
      runId: "run_1",
      now: 2000,
      day: "2026-07-02",
      mechanism: "data",
      modelId: null,
      usage: null,
      claimedPayloadJson: claimed.payloadJson,
      outcome: {
        kind: "failed",
        errorMessage: "prompt is too long",
        failureCode: "context_window_exceeded",
        terminal: true,
        nextAttemptAt: 0,
      },
    });
    const row = getCognitionRun(db, "run_1")!;
    // The failed attempt exhausted its budget for v1, not for v2, which it
    // never saw. The folded work gets a fresh cycle and attempt budget.
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.failureCode).toBeNull();
    expect(row.payload).toEqual({ v: 2 });
    const next = enqueueCognitionRun(
      db,
      { id: "run_3", kind: "data", payload: { v: 3 }, dedupeKey: "data:doc:d1" },
      9000,
    );
    expect(next).toEqual({ outcome: "folded", runId: "run_1", nextAttemptAt: 9000 });
  });

  test("terminal failure settles when an in-flight fold is byte-identical", () => {
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: { v: 1 }, dedupeKey: "data:doc:d1" },
      1000,
    );
    const [claimed] = claimDueCognitionRuns(db, { now: 1000 });
    enqueueCognitionRun(
      db,
      { id: "run_2", kind: "data", payload: { v: 1 }, dedupeKey: "data:doc:d1" },
      1500,
    );

    finalizeCognitionRun(db, {
      runId: "run_1",
      now: 2000,
      day: "2026-07-02",
      mechanism: "data",
      modelId: null,
      usage: null,
      claimedPayloadJson: claimed.payloadJson,
      outcome: {
        kind: "failed",
        errorMessage: "prompt is too long",
        failureCode: "context_window_exceeded",
        terminal: true,
        nextAttemptAt: 0,
      },
    });

    expect(getCognitionRun(db, "run_1")).toMatchObject({
      status: "failed",
      failureCode: "context_window_exceeded",
    });
  });

  test("a fold into a soft-failed row resets the attempt budget and adopts the fold schedule", () => {
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: { v: 1 }, dedupeKey: "data:doc:d1" },
      1000,
    );
    claimDueCognitionRuns(db, { now: 1000 });
    // A soft failure leaves it pending with a burned attempt + pushed schedule.
    finalizeCognitionRun(db, {
      runId: "run_1",
      now: 1100,
      day: "2026-07-02",
      mechanism: "data",
      modelId: null,
      usage: null,
      outcome: {
        kind: "failed",
        errorMessage: "backend 500",
        terminal: false,
        nextAttemptAt: 9000,
      },
    });
    expect(getCognitionRun(db, "run_1")?.attempts).toBe(1);

    // A fold (new data) is fresh work: the attempt budget and error reset.
    enqueueCognitionRun(
      db,
      { id: "run_2", kind: "data", payload: { v: 2 }, dedupeKey: "data:doc:d1", notBefore: 3000 },
      2000,
    );
    const row = getCognitionRun(db, "run_1")!;
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeNull();
    expect(row.nextAttemptAt).toBe(3000);
    expect(row.payload).toEqual({ v: 2 });
  });

  test("a completed in-flight fold resurrects into a FRESH debounce window, not an immediate re-fire (anti-busy-loop)", () => {
    // This is the regression the whole design exists to prevent: once the
    // ceiling fires and the run goes in-flight, a message folding in-flight
    // must NOT make the resurrected run immediately due (which, on a hot
    // thread, would fire the agent back-to-back on every message).
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: { v: 1 }, dedupeKey: "data:doc:d1" },
      1000,
    );
    const [claimed] = claimDueCognitionRuns(db, { now: 1000 });
    // A fold lands while in-flight, with a next_attempt_at already in the past
    // (as it would be right after a ceiling fire) — the busy-loop trigger.
    enqueueCognitionRun(
      db,
      { id: "run_2", kind: "data", payload: { v: 2 }, dedupeKey: "data:doc:d1", notBefore: 1500 },
      1500,
    );
    finalizeCognitionRun(db, {
      runId: "run_1",
      now: 2000,
      day: "2026-07-02",
      mechanism: "data",
      modelId: "model-x",
      usage: null,
      claimedPayloadJson: claimed.payloadJson,
      debounceMs: 600,
      outcome: { kind: "completed" },
    });
    const row = getCognitionRun(db, "run_1")!;
    expect(row.status).toBe("pending");
    expect(row.payload).toEqual({ v: 2 });
    // Re-enters the debounce window at resurrect_now + debounce (2000 + 600),
    // NOT fires immediately — the thread then fires at most once per ceiling.
    expect(row.nextAttemptAt).toBe(2600);
    // The cycle anchor is reset to the resurrect: the ceiling counts afresh.
    expect(row.cycleAnchorAt).toBe(2000);
  });

  test("a byte-identical in-flight fold settles normally (idempotent, not resurrected)", () => {
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: { v: 1 }, dedupeKey: "data:doc:d1" },
      1000,
    );
    const [claimed] = claimDueCognitionRuns(db, { now: 1000 });
    // A fold carrying byte-identical payload: the attempt already processed
    // exactly this state, so the run settles rather than re-running.
    enqueueCognitionRun(
      db,
      { id: "run_2", kind: "data", payload: { v: 1 }, dedupeKey: "data:doc:d1" },
      1500,
    );
    finalizeCognitionRun(db, {
      runId: "run_1",
      now: 2000,
      day: "2026-07-02",
      mechanism: "data",
      modelId: "model-x",
      usage: null,
      claimedPayloadJson: claimed.payloadJson,
      outcome: { kind: "completed" },
    });
    expect(getCognitionRun(db, "run_1")?.status).toBe("completed");
  });

  test("a forever-folded run clamps next_attempt_at to cycle_anchor + maxDefer (debounce-starvation guarantee)", () => {
    // Insert anchors the cycle at 1000; debounce 100, ceiling 500.
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: { v: 0 }, dedupeKey: "data:doc:d1", notBefore: 1100 },
      1000,
    );
    const anchor = getCognitionRun(db, "run_1")!.cycleAnchorAt;
    expect(anchor).toBe(1000);

    // Fold faster than the 100ms debounce, well past the 500ms ceiling. The
    // naive `now + debounce` would defer the run forever; the clamp caps it.
    let lastNext = 0;
    for (const foldNow of [1200, 1450, 1490, 1600]) {
      const folded = enqueueCognitionRun(
        db,
        {
          id: `fold_${foldNow}`,
          kind: "data",
          payload: { v: foldNow },
          dedupeKey: "data:doc:d1",
          notBefore: foldNow + 100,
          maxDeferMs: 500,
        },
        foldNow,
      );
      const row = getCognitionRun(db, "run_1")!;
      // Never deferred past the ceiling, and the anchor is immutable across folds.
      expect(row.nextAttemptAt).toBeLessThanOrEqual(anchor + 500);
      expect(row.cycleAnchorAt).toBe(anchor);
      // The fold reports the schedule it actually landed on — the clamped one.
      expect(folded).toEqual({
        outcome: "folded",
        runId: "run_1",
        nextAttemptAt: row.nextAttemptAt,
      });
      lastNext = row.nextAttemptAt;
    }
    // Pinned at the ceiling — CLAIMABLE by anchor + ceiling regardless of the
    // continued folds (at foldNow 1600 the run is already due).
    expect(lastNext).toBe(anchor + 500);
  });

  test("a settled run fires at anchor + debounce; the ceiling never fires it early", () => {
    // One insert, no folds. An insert never clamps — a genuinely quiet datum
    // waits its full debounce and is not accelerated to anchor + ceiling.
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: {}, dedupeKey: "data:doc:d1", notBefore: 1100 },
      1000,
    );
    const row = getCognitionRun(db, "run_1")!;
    expect(row.cycleAnchorAt).toBe(1000);
    expect(row.nextAttemptAt).toBe(1100);
  });

  test("a fold without maxDefer is never clamped (daily / decay schedules untouched)", () => {
    // Non-waker enqueues (daily, decay, feedback, time_based) omit maxDefer, so
    // their intentional schedules — a far-future daily boundary or decay
    // back-off — are honoured verbatim, never clamped to the cycle anchor.
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "daily", payload: { v: 1 }, dedupeKey: "daily:s:2026-07-02" },
      1000,
    );
    enqueueCognitionRun(
      db,
      {
        id: "run_2",
        kind: "daily",
        payload: { v: 2 },
        dedupeKey: "daily:s:2026-07-02",
        notBefore: 999_999,
      },
      2000,
    );
    expect(getCognitionRun(db, "run_1")!.nextAttemptAt).toBe(999_999);
  });

  test("a re-claim after a crash keeps the cycle anchor and does not double-process", () => {
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: { v: 1 }, dedupeKey: "data:doc:d1", notBefore: 1000 },
      1000,
    );
    const anchor = getCognitionRun(db, "run_1")!.cycleAnchorAt;
    // Claim (in-flight), then crash before finalize: the row stays pending.
    expect(claimDueCognitionRuns(db, { now: 1000 })).toHaveLength(1);
    // Re-claim once due again (a crash back-stop, not a fresh cycle).
    expect(claimDueCognitionRuns(db, { now: 1000 })).toHaveLength(1);
    const row = getCognitionRun(db, "run_1")!;
    expect(row.attempts).toBe(2); // attempts bumped by each claim…
    expect(row.cycleAnchorAt).toBe(anchor); // …but the cycle anchor is untouched
    expect(row.payload).toEqual({ v: 1 }); // …and the payload survives until a settle
  });

  test("a completion frees the dedupe key; the next wake inserts a fresh cycle anchor", () => {
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "data", payload: {}, dedupeKey: "data:doc:d1" },
      1000,
    );
    claimDueCognitionRuns(db, { now: 1000 });
    completeCognitionRun(db, "run_1", { usage: null, now: 1100 });
    const res = enqueueCognitionRun(
      db,
      { id: "run_2", kind: "data", payload: {}, dedupeKey: "data:doc:d1" },
      5000,
    );
    expect(res).toEqual({ outcome: "inserted", runId: "run_2", nextAttemptAt: 5000 });
    // A brand-new row starts a brand-new cycle at its own enqueue time.
    expect(getCognitionRun(db, "run_2")!.cycleAnchorAt).toBe(5000);
  });

  test("pruneTerminal drops settled rows past the cutoff, keeps pending + fresh ones", () => {
    enqueueCognitionRun(db, { id: "run_old", kind: "data", payload: {} }, 1000);
    enqueueCognitionRun(db, { id: "run_fresh", kind: "data", payload: {} }, 1000);
    enqueueCognitionRun(db, { id: "run_pending", kind: "data", payload: {} }, 1000);
    claimDueCognitionRuns(db, { now: 1000, limit: 2 });
    completeCognitionRun(db, "run_old", { usage: null, now: 2000 });
    completeCognitionRun(db, "run_fresh", { usage: null, now: 9000 });
    expect(pruneActivityRetentionBatch(db, "cognitionRuns", 5000, 100).deleted).toBe(1);
    expect(getCognitionRun(db, "run_old")).toBeNull();
    expect(getCognitionRun(db, "run_fresh")?.status).toBe("completed");
    expect(getCognitionRun(db, "run_pending")?.status).toBe("pending");
  });

  // The claim is the ONLY writer of last_attempt_at, which is what makes it
  // the claim clock the provenance-recheck sweep's coverage predicate reads.
  test("last_attempt_at is the claim clock: stamped from the caller's now, moved by a re-claim, frozen by a settle", () => {
    enqueueCognitionRun(
      db,
      { id: "run_1", kind: "feedback", payload: {}, dedupeKey: "provrecheck:brief:brief_1" },
      1000,
    );
    const lastAttemptAt = (): number | null =>
      listCognitionRunsByDedupePrefix(db, "provrecheck:")[0]!.lastAttemptAt;
    expect(lastAttemptAt()).toBeNull(); // enqueued, never claimed

    claimDueCognitionRuns(db, { now: 1500 });
    expect(lastAttemptAt()).toBe(1500);
    // A crash back-stop re-claim re-derives the run's work at the new clock.
    claimDueCognitionRuns(db, { now: 4000 });
    expect(lastAttemptAt()).toBe(4000);
    // A settle records the outcome, never a new attempt: the claim clock holds
    // at the last claim — it is what that attempt actually had in view.
    completeCognitionRun(db, "run_1", { usage: null, now: 4200 });
    expect(lastAttemptAt()).toBe(4000);
    // A soft failure likewise re-schedules without re-stamping the attempt.
    failCognitionRun(db, "run_1", {
      errorMessage: "backend unreachable",
      terminal: false,
      nextAttemptAt: 5000,
      now: 4300,
    });
    expect(lastAttemptAt()).toBe(4000);
  });

  test("listCognitionRunsByDedupePrefix returns every status with attempts + last_attempt_at", () => {
    enqueueCognitionRun(
      db,
      { id: "run_done", kind: "feedback", payload: {}, dedupeKey: "provrecheck:brief:brief_1" },
      1000,
    );
    claimDueCognitionRuns(db, { now: 1200 });
    completeCognitionRun(db, "run_done", { usage: null, now: 1300 });
    enqueueCognitionRun(
      db,
      { id: "run_pending", kind: "feedback", payload: {}, dedupeKey: "provrecheck:loop:loop_1" },
      2000,
    );
    // A different prefix is out of scope, as is a key-less run.
    enqueueCognitionRun(
      db,
      { id: "run_other", kind: "verification", payload: {}, dedupeKey: "verify:batch:1" },
      2000,
    );
    enqueueCognitionRun(db, { id: "run_bare", kind: "daily", payload: {} }, 2000);

    const rows = listCognitionRunsByDedupePrefix(db, "provrecheck:").sort((a, b) =>
      a.dedupeKey.localeCompare(b.dedupeKey),
    );
    expect(rows).toEqual([
      // A settled row still reports its claim — it is what that run covered.
      {
        dedupeKey: "provrecheck:brief:brief_1",
        status: "completed",
        attempts: 1,
        lastAttemptAt: 1200,
      },
      { dedupeKey: "provrecheck:loop:loop_1", status: "pending", attempts: 0, lastAttemptAt: null },
    ]);
  });

  test("countPending counts due + scheduled pending rows under the attempts cap", () => {
    enqueueCognitionRun(db, { id: "run_1", kind: "data", payload: {} }, 1000);
    enqueueCognitionRun(db, { id: "run_2", kind: "data", payload: {}, notBefore: 99999 }, 1000);
    enqueueCognitionRun(db, { id: "run_3", kind: "data", payload: {} }, 1000);
    claimDueCognitionRuns(db, { now: 1000, limit: 1 });
    completeCognitionRun(db, "run_1", { usage: null, now: 1100 });
    expect(countPendingCognitionRuns(db, 5)).toBe(2);
    // Rows at/over the attempts cap fall out of the backlog gauge.
    expect(countPendingCognitionRuns(db, 0)).toBe(0);
  });

  test("listCognitionRuns returns newest-enqueued first, filtered by kind/status/limit", () => {
    enqueueCognitionRun(db, { id: "run_1", kind: "data", payload: {} }, 1000);
    enqueueCognitionRun(db, { id: "run_2", kind: "feedback", payload: {} }, 2000);
    enqueueCognitionRun(db, { id: "run_3", kind: "data", payload: {} }, 3000);
    claimDueCognitionRuns(db, { now: 3000, limit: 1 });
    completeCognitionRun(db, "run_1", {
      usage: { promptTokens: 9, completionTokens: 1 },
      now: 3100,
    });

    expect(listCognitionRuns(db).map((r) => r.id)).toEqual(["run_3", "run_2", "run_1"]);
    expect(listCognitionRuns(db, { kinds: ["data"] }).map((r) => r.id)).toEqual(["run_3", "run_1"]);
    expect(listCognitionRuns(db, { statuses: ["pending"] }).map((r) => r.id)).toEqual([
      "run_3",
      "run_2",
    ]);
    expect(listCognitionRuns(db, { limit: 1 }).map((r) => r.id)).toEqual(["run_3"]);
    const completed = listCognitionRuns(db, { statuses: ["completed"] });
    expect(completed).toHaveLength(1);
    expect(completed[0]!.usage).toEqual({ promptTokens: 9, completionTokens: 1 });
  });

  test("cancelScheduledRunsForLoop drops only never-claimed time_based runs matching the loop", () => {
    // A claimed/in-flight check for loop_x: enqueue first, then claim it
    // (limit 1, before any other row is due) so it is `pending` on disk
    // with attempts bumped — the `attempts = 0` guard must spare it.
    enqueueCognitionRun(
      db,
      { id: "sched_claimed", kind: "time_based", payload: { prompt: "p", loopId: "loop_x" } },
      1000,
    );
    claimDueCognitionRuns(db, { now: 1000, limit: 1 });

    // Never-claimed rows enqueued after: the loop_x one is retracted, the
    // others are spared (different loop / no loopId).
    enqueueCognitionRun(
      db,
      { id: "sched_fresh", kind: "time_based", payload: { prompt: "p", loopId: "loop_x" } },
      2000,
    );
    enqueueCognitionRun(
      db,
      { id: "sched_other", kind: "time_based", payload: { prompt: "p", loopId: "loop_y" } },
      2000,
    );
    enqueueCognitionRun(
      db,
      { id: "sched_none", kind: "time_based", payload: { prompt: "p" } },
      2000,
    );

    const dropped = cancelScheduledRunsForLoop(db, "loop_x");
    expect(dropped).toBe(1); // only the fresh never-claimed loop_x row
    expect(getCognitionRun(db, "sched_fresh")).toBeNull();
    expect(getCognitionRun(db, "sched_claimed")).not.toBeNull(); // in-flight, spared
    expect(getCognitionRun(db, "sched_other")).not.toBeNull(); // different loop
    expect(getCognitionRun(db, "sched_none")).not.toBeNull(); // no loopId

    // Idempotent: a second call finds nothing.
    expect(cancelScheduledRunsForLoop(db, "loop_x")).toBe(0);
    // A loop with no scheduled runs is a clean no-op.
    expect(cancelScheduledRunsForLoop(db, "loop_absent")).toBe(0);
  });

  test("cancelScheduledRunsForLoop also cancels via a loop id found in the prompt (no structured loopId)", () => {
    // The robust backstop: a check the agent scheduled WITHOUT a structured
    // loopId but whose prompt names the loop is still cancelled on resolve.
    enqueueCognitionRun(
      db,
      {
        id: "sched_prompt",
        kind: "time_based",
        payload: { prompt: "Check on loop_alpha for a reply" },
      },
      2000,
    );
    // A structured-linked check is still cancelled (the original path).
    enqueueCognitionRun(
      db,
      {
        id: "sched_structured",
        kind: "time_based",
        payload: { prompt: "re-check", loopId: "loop_alpha" },
      },
      2000,
    );
    // A check whose prompt names a DIFFERENT loop is untouched.
    enqueueCognitionRun(
      db,
      {
        id: "sched_other_prompt",
        kind: "time_based",
        payload: { prompt: "Check on loop_beta later" },
      },
      2000,
    );
    // A promptless check (decay-shaped payload) never matches the prompt clause.
    enqueueCognitionRun(
      db,
      { id: "sched_decayshaped", kind: "time_based", payload: { decayCheckLoopId: "loop_alpha" } },
      2000,
    );
    // A non-time_based run whose prompt names the loop is spared (kind guard).
    enqueueCognitionRun(
      db,
      { id: "sched_data", kind: "data", payload: { prompt: "loop_alpha appeared" } },
      2000,
    );

    const dropped = cancelScheduledRunsForLoop(db, "loop_alpha");
    expect(dropped).toBe(2); // the prompt-named and the structured-linked rows
    expect(getCognitionRun(db, "sched_prompt")).toBeNull();
    expect(getCognitionRun(db, "sched_structured")).toBeNull();
    expect(getCognitionRun(db, "sched_other_prompt")).not.toBeNull(); // different loop
    expect(getCognitionRun(db, "sched_decayshaped")).not.toBeNull(); // no prompt
    expect(getCognitionRun(db, "sched_data")).not.toBeNull(); // wrong kind
  });

  test("cancelScheduledRunsForLoop prompt fallback spares claimed (in-flight) rows", () => {
    // A prompt-named check that has been claimed (attempts bumped) must be
    // spared by the same `attempts = 0` guard the structured path uses.
    enqueueCognitionRun(
      db,
      {
        id: "sched_prompt_claimed",
        kind: "time_based",
        payload: { prompt: "Check on loop_gamma" },
      },
      1000,
    );
    claimDueCognitionRuns(db, { now: 1000, limit: 1 });
    expect(cancelScheduledRunsForLoop(db, "loop_gamma")).toBe(0);
    expect(getCognitionRun(db, "sched_prompt_claimed")).not.toBeNull();
  });

  test("a same-loop, same-UTC-day check is refused by default: nothing is written, and the refusal carries the pending check's real time and instruction", () => {
    const first = enqueueCognitionRun(
      db,
      {
        id: "sched_1",
        kind: "time_based",
        payload: { prompt: "Confirm the parking permit renewal", loopId: "loop_permit" },
        notBefore: schedAt(7),
      },
      1000,
    );
    expect(first).toEqual({ outcome: "inserted", runId: "sched_1", nextAttemptAt: schedAt(7) });
    const before = getCognitionRun(db, "sched_1")!;

    // A second run — which can't see sched_1 — schedules a different check for
    // the same loop later the same UTC day. The queue never decides which of
    // the two instructions matters: it writes nothing and hands back the check
    // it collided with, at the hour that check will ACTUALLY fire (07:00, not
    // the 18:00 that was asked for) and with the instruction it carries.
    const second = enqueueCognitionRun(
      db,
      {
        id: "sched_2",
        kind: "time_based",
        payload: {
          prompt: "Refresh the permit brief before the evening visit",
          loopId: "loop_permit",
        },
        notBefore: schedAt(18),
      },
      2000,
    );
    expect(second).toEqual({
      outcome: "refused",
      reason: "pending_check",
      loopId: "loop_permit",
      runId: "sched_1",
      nextAttemptAt: schedAt(7),
      existingPayload: { prompt: "Confirm the parking permit renewal", loopId: "loop_permit" },
    });
    expect(getCognitionRun(db, "sched_2")).toBeNull();

    // Not calling again IS the third resolution: the pending check stands
    // exactly as it was — same payload, same schedule, same attempt budget.
    const pending = listCognitionRuns(db, { kinds: ["time_based"], statuses: ["pending"] });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(before);

    // A refusal is repeatable: asking again without a policy refuses again and
    // still writes nothing.
    const third = enqueueCognitionRun(
      db,
      {
        id: "sched_3",
        kind: "time_based",
        payload: { prompt: "Confirm the parking permit renewal", loopId: "loop_permit" },
        notBefore: schedAt(9),
      },
      3000,
    );
    expect(third.outcome).toBe("refused");
    expect(getCognitionRun(db, "sched_1")).toEqual(before);
    expect(listCognitionRuns(db, { kinds: ["time_based"], statuses: ["pending"] })).toHaveLength(1);
  });

  test("`merge` appends the instruction to the pending check, annotated with the hour it asked for, and keeps that check's schedule", () => {
    enqueueCognitionRun(
      db,
      {
        id: "sched_1",
        kind: "time_based",
        payload: { prompt: "Confirm the parking permit renewal", loopId: "loop_permit" },
        notBefore: schedAt(7),
      },
      1000,
    );
    const merged = enqueueCognitionRun(
      db,
      {
        id: "sched_2",
        kind: "time_based",
        payload: {
          prompt: "Refresh the permit brief before the evening visit",
          loopId: "loop_permit",
        },
        notBefore: schedAt(18),
        onScheduleConflict: "merge",
      },
      2000,
    );
    // The call landed on the existing check, and the time reported is the
    // hour that check fires — not the 18:00 the merged instruction asked for.
    expect(merged).toEqual({ outcome: "merged", runId: "sched_1", nextAttemptAt: schedAt(7) });
    expect(getCognitionRun(db, "sched_2")).toBeNull();

    // One check for the loop that day, carrying both instructions; the merged
    // one says which hour it was written for, since it will run at 07:00.
    const pending = listCognitionRuns(db, { kinds: ["time_based"], statuses: ["pending"] });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.payload).toEqual({
      prompt:
        "Confirm the parking permit renewal\n\n" +
        `Also requested for ${new Date(schedAt(18)).toISOString()}: ` +
        "Refresh the permit brief before the evening visit",
      loopId: "loop_permit",
    });
    expect(pending[0]!.nextAttemptAt).toBe(schedAt(7));
    expect(pending[0]!.attempts).toBe(0);
  });

  test("`add` inserts a second check for the loop alongside the pending one", () => {
    enqueueCognitionRun(
      db,
      {
        id: "sched_1",
        kind: "time_based",
        payload: { prompt: "Confirm the parking permit renewal", loopId: "loop_permit" },
        notBefore: schedAt(7),
      },
      1000,
    );
    const before = getCognitionRun(db, "sched_1")!;
    const added = enqueueCognitionRun(
      db,
      {
        id: "sched_2",
        kind: "time_based",
        payload: {
          prompt: "Refresh the permit brief before the evening visit",
          loopId: "loop_permit",
        },
        notBefore: schedAt(18),
        onScheduleConflict: "add",
      },
      2000,
    );
    expect(added).toEqual({ outcome: "inserted", runId: "sched_2", nextAttemptAt: schedAt(18) });

    // Two pending checks for the loop that day, the first untouched.
    const pending = listCognitionRuns(db, {
      kinds: ["time_based"],
      statuses: ["pending"],
      orderBy: "nextAttemptAt",
      order: "asc",
    });
    expect(pending.map((r) => r.id)).toEqual(["sched_1", "sched_2"]);
    expect(pending[0]).toEqual(before);
    expect(pending[1]!.payload).toEqual({
      prompt: "Refresh the permit brief before the evening visit",
      loopId: "loop_permit",
    });
  });

  test("a merge that would push the stored instruction past the cap is refused as instruction_full and writes nothing", () => {
    const full = "x".repeat(SCHEDULED_INSTRUCTION_MAX_CHARS - 100);
    enqueueCognitionRun(
      db,
      {
        id: "sched_1",
        kind: "time_based",
        payload: { prompt: full, loopId: "loop_permit" },
        notBefore: schedAt(7),
      },
      1000,
    );
    const before = getCognitionRun(db, "sched_1")!;
    const overflow = enqueueCognitionRun(
      db,
      {
        id: "sched_2",
        kind: "time_based",
        payload: { prompt: "y".repeat(200), loopId: "loop_permit" },
        notBefore: schedAt(18),
        onScheduleConflict: "merge",
      },
      2000,
    );
    expect(overflow).toEqual({
      outcome: "refused",
      reason: "instruction_full",
      loopId: "loop_permit",
      runId: "sched_1",
      nextAttemptAt: schedAt(7),
      existingPayload: { prompt: full, loopId: "loop_permit" },
    });
    expect(getCognitionRun(db, "sched_1")).toEqual(before);
    expect(getCognitionRun(db, "sched_2")).toBeNull();

    // `add` is the way through: the second instruction becomes its own check.
    const added = enqueueCognitionRun(
      db,
      {
        id: "sched_3",
        kind: "time_based",
        payload: { prompt: "y".repeat(200), loopId: "loop_permit" },
        notBefore: schedAt(18),
        onScheduleConflict: "add",
      },
      3000,
    );
    expect(added.outcome).toBe("inserted");
    expect(listCognitionRuns(db, { kinds: ["time_based"], statuses: ["pending"] })).toHaveLength(2);
  });

  test("`merge` and `add` with nothing to collide with insert normally", () => {
    // The check the agent was told about may have fired or been cancelled by
    // the time it retries; the retry then lands as a plain insert.
    const merge = enqueueCognitionRun(
      db,
      {
        id: "sched_m",
        kind: "time_based",
        payload: { prompt: "Confirm the parking permit renewal", loopId: "loop_permit" },
        notBefore: schedAt(7),
        onScheduleConflict: "merge",
      },
      1000,
    );
    expect(merge).toEqual({ outcome: "inserted", runId: "sched_m", nextAttemptAt: schedAt(7) });
    expect(getCognitionRun(db, "sched_m")!.payload).toEqual({
      prompt: "Confirm the parking permit renewal",
      loopId: "loop_permit",
    });
    const add = enqueueCognitionRun(
      db,
      {
        id: "sched_a",
        kind: "time_based",
        payload: { prompt: "Chase the dentist appointment", loopId: "loop_dentist" },
        notBefore: schedAt(8),
        onScheduleConflict: "add",
      },
      1000,
    );
    expect(add).toEqual({ outcome: "inserted", runId: "sched_a", nextAttemptAt: schedAt(8) });
  });

  test("a different day, a different loop, or no loopId schedules normally (no collision)", () => {
    enqueueCognitionRun(
      db,
      {
        id: "sched_base",
        kind: "time_based",
        payload: { prompt: "Confirm the parking permit renewal", loopId: "loop_permit" },
        notBefore: schedAt(7),
      },
      1000,
    );

    // Same loop, NEXT UTC day → a distinct check, inserted (different days are
    // genuinely different checks).
    const nextDay = enqueueCognitionRun(
      db,
      {
        id: "sched_nextday",
        kind: "time_based",
        payload: { prompt: "Second reminder for the parking permit", loopId: "loop_permit" },
        notBefore: schedAt(24 + 8),
      },
      1000,
    );
    expect(nextDay.outcome).toBe("inserted");

    // Different loop, same day → distinct check, inserted.
    const otherLoop = enqueueCognitionRun(
      db,
      {
        id: "sched_otherloop",
        kind: "time_based",
        payload: { prompt: "Chase the dentist appointment", loopId: "loop_dentist" },
        notBefore: schedAt(8),
      },
      1000,
    );
    expect(otherLoop.outcome).toBe("inserted");

    // No structured loopId, same day → never collides; two loop-less checks both
    // land (they carry no key a collision could be detected on).
    const noLoopA = enqueueCognitionRun(
      db,
      {
        id: "sched_noloop_a",
        kind: "time_based",
        payload: { prompt: "Pre-meeting refresh" },
        notBefore: schedAt(9),
      },
      1000,
    );
    const noLoopB = enqueueCognitionRun(
      db,
      {
        id: "sched_noloop_b",
        kind: "time_based",
        payload: { prompt: "Another pre-meeting refresh" },
        notBefore: schedAt(10),
      },
      1000,
    );
    expect(noLoopA.outcome).toBe("inserted");
    expect(noLoopB.outcome).toBe("inserted");

    // All five distinct checks survive.
    expect(listCognitionRuns(db, { kinds: ["time_based"], statuses: ["pending"] })).toHaveLength(5);
  });

  test("a claimed (in-flight) or completed same-loop, same-day run is never a collision target or mutated", () => {
    // An in-flight check for loop_inflight: enqueue then claim it (attempts
    // bumped, still `pending` on disk). It is NOT a collision target (attempts > 0).
    enqueueCognitionRun(
      db,
      {
        id: "sched_inflight",
        kind: "time_based",
        payload: { prompt: "In-flight check", loopId: "loop_inflight" },
        notBefore: schedAt(7),
      },
      1000,
    );
    claimDueCognitionRuns(db, { now: schedAt(7), limit: 1 });
    const inflightBefore = getCognitionRun(db, "sched_inflight");
    expect(inflightBefore?.attempts).toBe(1);

    // A new same-loop, same-day check while the other is in flight is created,
    // and the claimed row is untouched.
    const created = enqueueCognitionRun(
      db,
      {
        id: "sched_new",
        kind: "time_based",
        payload: { prompt: "New check", loopId: "loop_inflight" },
        notBefore: schedAt(8),
      },
      2000,
    );
    expect(created).toEqual({ outcome: "inserted", runId: "sched_new", nextAttemptAt: schedAt(8) });
    expect(getCognitionRun(db, "sched_inflight")).toEqual(inflightBefore);

    // A completed run for loop_done never blocks or is mutated by a new same-day
    // schedule (only never-claimed pending checks are collision targets).
    enqueueCognitionRun(
      db,
      {
        id: "sched_done",
        kind: "time_based",
        payload: { prompt: "Already handled", loopId: "loop_done" },
        notBefore: schedAt(7),
      },
      1000,
    );
    claimDueCognitionRuns(db, { now: schedAt(7), limit: 1 });
    completeCognitionRun(db, "sched_done", { usage: null, now: schedAt(7) + 1 });
    const completedBefore = getCognitionRun(db, "sched_done");
    expect(completedBefore?.status).toBe("completed");

    const afterComplete = enqueueCognitionRun(
      db,
      {
        id: "sched_after",
        kind: "time_based",
        payload: { prompt: "Fresh check for the same loop", loopId: "loop_done" },
        notBefore: schedAt(9),
      },
      3000,
    );
    expect(afterComplete.outcome).toBe("inserted");
    expect(getCognitionRun(db, "sched_done")).toEqual(completedBefore);
  });

  test("a merged check still auto-cancels on resolve: cancelScheduledRunsForLoop retracts the one row", () => {
    enqueueCognitionRun(
      db,
      {
        id: "sched_1",
        kind: "time_based",
        payload: { prompt: "Confirm renewal", loopId: "loop_permit" },
        notBefore: schedAt(7),
      },
      1000,
    );
    const merged = enqueueCognitionRun(
      db,
      {
        id: "sched_2",
        kind: "time_based",
        payload: { prompt: "Confirm renewal again", loopId: "loop_permit" },
        notBefore: schedAt(8),
        onScheduleConflict: "merge",
      },
      2000,
    );
    expect(merged.outcome).toBe("merged");

    // The two schedules are one pending check; resolving the loop retracts
    // exactly that one and leaves the queue clean.
    expect(cancelScheduledRunsForLoop(db, "loop_permit")).toBe(1);
    expect(listCognitionRuns(db, { kinds: ["time_based"], statuses: ["pending"] })).toHaveLength(0);
  });

  describe("recordSettledCognitionRun (inline runs — watch compilation)", () => {
    const payload = {
      origin: "subscription",
      condition: "a fictional launch decision arrives",
      stage: "model",
    };

    test("inserts a terminal completed row with attribution and spend", () => {
      recordSettledCognitionRun(db, {
        runId: "run_compile_ok",
        kind: "subscription_compile",
        payload,
        startedAt: 1_000,
        now: 9_000,
        day: "2026-07-02",
        mechanism: "subscription-compile",
        modelId: "fictional-model",
        usage: { promptTokens: 100, completionTokens: 20 },
        outcome: { kind: "completed" },
      });

      const run = getCognitionRun(db, "run_compile_ok");
      expect(run).toMatchObject({
        kind: "subscription_compile",
        status: "completed",
        attempts: 1,
        lastError: null,
        enqueuedAt: 1_000,
        completedAt: 9_000,
        usage: { promptTokens: 100, completionTokens: 20 },
        payload,
      });
      expect(getRunAttribution(db, "run_compile_ok")).toMatchObject({
        workflowId: "subscription-compile",
        modelId: "fictional-model",
      });
      expect(getCognitionSpendDayTotal(db, "2026-07-02")).toMatchObject({
        runs: 1,
        promptTokens: 100,
        completionTokens: 20,
      });
    });

    test("a refused compilation settles as failed, tokens counted but not the run", () => {
      recordSettledCognitionRun(db, {
        runId: "run_compile_refused",
        kind: "subscription_compile",
        payload,
        startedAt: 1_000,
        now: 9_000,
        day: "2026-07-02",
        mechanism: "subscription-compile",
        modelId: "fictional-model",
        usage: { promptTokens: 50, completionTokens: 5 },
        outcome: {
          kind: "failed",
          errorMessage: "refused (unsupported_condition): the substrate cannot express it",
        },
      });

      expect(getCognitionRun(db, "run_compile_refused")).toMatchObject({
        status: "failed",
        lastError: "refused (unsupported_condition): the substrate cannot express it",
        completedAt: 9_000,
      });
      expect(getCognitionSpendDayTotal(db, "2026-07-02")).toMatchObject({
        runs: 0,
        promptTokens: 50,
      });
    });

    test("an inline model failure persists its stable failure code", () => {
      recordSettledCognitionRun(db, {
        runId: "run_compile_context",
        kind: "subscription_compile",
        payload,
        startedAt: 1_000,
        now: 9_000,
        day: "2026-07-02",
        mechanism: "subscription-compile",
        modelId: "fictional-model",
        usage: null,
        outcome: {
          kind: "failed",
          errorMessage: "background agent exceeded its context window",
          failureCode: "context_window_exceeded",
        },
      });

      expect(getCognitionRun(db, "run_compile_context")).toMatchObject({
        status: "failed",
        lastError: "background agent exceeded its context window",
        failureCode: "context_window_exceeded",
      });
    });

    test("the drainer can never claim an inline-recorded run", () => {
      recordSettledCognitionRun(db, {
        runId: "run_compile_unclaimable",
        kind: "subscription_compile",
        payload,
        startedAt: 1_000,
        now: 2_000,
        day: "2026-07-02",
        mechanism: "subscription-compile",
        modelId: null,
        usage: null,
        outcome: { kind: "completed" },
      });

      // Claim far in the future: a pending row would be due; a settled one never is.
      expect(claimDueCognitionRuns(db, { now: 10_000_000 })).toHaveLength(0);
    });

    test("a duplicate record call changes nothing — not the row, not the day's spend", () => {
      const base = {
        runId: "run_compile_dup",
        kind: "subscription_compile" as const,
        payload,
        startedAt: 1_000,
        day: "2026-07-02",
        mechanism: "subscription-compile" as const,
        modelId: "fictional-model",
        // Non-null on purpose: spend is a running total, so a duplicate that
        // slipped past the row's conflict guard would bill these twice.
        usage: { promptTokens: 100, completionTokens: 20 },
      };
      recordSettledCognitionRun(db, { ...base, now: 2_000, outcome: { kind: "completed" } });
      recordSettledCognitionRun(db, {
        ...base,
        now: 3_000,
        outcome: { kind: "failed", errorMessage: "later duplicate" },
      });

      expect(getCognitionRun(db, "run_compile_dup")).toMatchObject({
        status: "completed",
        completedAt: 2_000,
        lastError: null,
      });
      expect(getCognitionSpendDayTotal(db, "2026-07-02")).toMatchObject({
        runs: 1,
        promptTokens: 100,
        completionTokens: 20,
      });
      // The first settle's provenance stands; the duplicate does not restamp it.
      expect(getRunAttribution(db, "run_compile_dup")).toMatchObject({ settledAt: 2_000 });
    });

    test("an inline run is pruned on the ordinary retention sweep", () => {
      recordSettledCognitionRun(db, {
        runId: "run_compile_old",
        kind: "subscription_compile",
        payload,
        startedAt: 1_000,
        now: 2_000,
        day: "2026-07-02",
        mechanism: "subscription-compile",
        modelId: null,
        usage: null,
        outcome: { kind: "completed" },
      });

      expect(pruneActivityRetentionBatch(db, "cognitionRuns", 5_000, 100).deleted).toBe(1);
      expect(getCognitionRun(db, "run_compile_old")).toBeNull();
    });
  });
});

describe("an attempt refunded because the provider, not the payload, failed", () => {
  let db: Db;
  let path: string;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  const attemptsOf = (id: string): number =>
    db
      .prepare<[string], { attempts: number }>("SELECT attempts FROM cognition_runs WHERE id = ?")
      .get(id)!.attempts;

  function enqueueAndClaim(id: string, now: number): void {
    enqueueCognitionRun(db, { id, kind: "bootstrap", payload: { docId: "d1" } }, now);
    claimDueCognitionRuns(db, { now });
  }

  test("the refund returns the run to the budget it had before the attempt", () => {
    enqueueAndClaim("run_refund", 1000);
    expect(attemptsOf("run_refund")).toBe(1);
    failCognitionRun(db, "run_refund", {
      errorMessage: "HTTP 412",
      terminal: false,
      nextAttemptAt: 2000,
      now: 1500,
      refundAttempt: true,
    });
    expect(attemptsOf("run_refund")).toBe(0);
  });

  test("without the refund a failure spends the attempt, as an ordinary retry should", () => {
    enqueueAndClaim("run_spend", 1000);
    failCognitionRun(db, "run_spend", {
      errorMessage: "malformed",
      terminal: false,
      nextAttemptAt: 2000,
      now: 1500,
    });
    expect(attemptsOf("run_spend")).toBe(1);
  });

  test("a run at the cap stays CLAIMABLE, which is the whole point", () => {
    // The failure this guards against is subtle: declining to mark the run
    // terminal is not enough on its own. Claiming increments `attempts` and the
    // claim query skips rows at the cap, so a run left pending at the cap would
    // sit there forever — not consumed, but never retried either, which for the
    // document it carries is the same outcome.
    const MAX = 3;
    enqueueCognitionRun(db, { id: "run_cap", kind: "bootstrap", payload: { docId: "d1" } }, 1000);
    for (let i = 0; i < MAX; i++) {
      expect(claimDueCognitionRuns(db, { now: 1000, maxAttempts: MAX })).toHaveLength(1);
      failCognitionRun(db, "run_cap", {
        errorMessage: "HTTP 412",
        terminal: false,
        nextAttemptAt: 1000,
        now: 1000,
        refundAttempt: true,
      });
    }
    // An outage lasting many cycles still leaves the run ready for the moment
    // the backend comes back.
    expect(claimDueCognitionRuns(db, { now: 1000, maxAttempts: MAX })).toHaveLength(1);
  });

  test("the refund never drives the attempt count below zero", () => {
    enqueueAndClaim("run_floor", 1000);
    for (let i = 0; i < 3; i++) {
      failCognitionRun(db, "run_floor", {
        errorMessage: "HTTP 412",
        terminal: false,
        nextAttemptAt: 2000,
        now: 1500,
        refundAttempt: true,
      });
    }
    expect(attemptsOf("run_floor")).toBe(0);
  });
});

describe("a provenance recheck is maintenance, not a reaction", () => {
  let db: Db;
  let path: string;

  beforeEach(() => {
    path = testDbPath();
    db = createDatabase(path);
  });
  afterEach(() => {
    db.close();
    cleanupDb(path);
  });

  test("it is claimed after everything a person is waiting on", () => {
    // Both rows are `feedback` kind and both are due, so kind alone cannot
    // order them. The recheck is enqueued FIRST and is still claimed second:
    // a sweep's bulk output must never sit in front of a dismissed brief.
    enqueueCognitionRun(
      db,
      { id: "run_recheck", kind: "feedback", payload: {}, dedupeKey: "feedback:provenance:loop-1" },
      1000,
    );
    enqueueCognitionRun(
      db,
      { id: "run_reaction", kind: "feedback", payload: {}, dedupeKey: "feedback:brief:brief-1" },
      2000,
    );
    const claimed = claimDueCognitionRuns(db, { now: 3000, limit: 10 });
    expect(claimed.map((r) => r.id)).toEqual(["run_reaction", "run_recheck"]);
  });

  test("it yields to ordinary data runs too", () => {
    enqueueCognitionRun(
      db,
      { id: "run_recheck", kind: "feedback", payload: {}, dedupeKey: "feedback:provenance:loop-2" },
      1000,
    );
    enqueueCognitionRun(db, { id: "run_data", kind: "data", payload: { docId: "d1" } }, 2000);
    const claimed = claimDueCognitionRuns(db, { now: 3000, limit: 10 });
    expect(claimed.map((r) => r.id)).toEqual(["run_data", "run_recheck"]);
  });

  test("an ordinary feedback run still outranks the backlog kinds", () => {
    // The rerank must not have cost the reactive tier its whole point.
    enqueueCognitionRun(db, { id: "run_boot", kind: "bootstrap", payload: { docId: "d1" } }, 1000);
    enqueueCognitionRun(
      db,
      { id: "run_fb", kind: "feedback", payload: {}, dedupeKey: "feedback:brief:brief-2" },
      2000,
    );
    const claimed = claimDueCognitionRuns(db, { now: 3000, limit: 10 });
    expect(claimed.map((r) => r.id)).toEqual(["run_fb", "run_boot"]);
  });
});
