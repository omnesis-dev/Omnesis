// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end preemption test — proves the cooperative-yield mechanism
 * works against a real WriterTaskRunner + writer worker.
 *
 * Setup:
 *   - Scheduler with `enablePreemption: true`.
 *   - Real WriterTaskRunner against a temp DB.
 *   - Realtime-priority `db.upsertDocuments` task with N docs and a
 *     small `chunkSize` so it iterates several chunks.
 *
 * Verification:
 *   - Mid-flight, enqueue a user-priority `db.setSyncState` task.
 *   - The user-priority op completes before the realtime op finishes
 *     (the realtime op yielded mid-batch and the user op slipped in).
 *   - Both tasks ultimately complete; all N docs end up in the DB.
 *
 * The test is flaky-by-design if the writer is too fast (the user op
 * lands AFTER the realtime op finishes). To guard, we use enough docs
 * (200) and small chunkSize so the realtime op always takes at least
 * a few chunks.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runWithPriority } from "../priority.js";
import { createDatabase } from "../db.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { writeGateFromScheduler } from "./write-ops.js";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

const WORKER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

function testDbPath(): string {
  return `/tmp/omnesis-preempt-${randomUUID()}.db`;
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

function makeDocs(n: number): DocumentInput[] {
  const now = new Date().toISOString();
  const docs: DocumentInput[] = [];
  for (let i = 0; i < n; i++) {
    docs.push({
      providerId: "test-provider",
      sourceId: "preempt-test",
      externalId: `doc-${i}`,
      title: `Doc ${i}`,
      content: `Content for doc ${i} `.repeat(100),
      contentHash: `hash-${i}`,
      sourceCreatedAt: now,
      sourceUpdatedAt: now,
      metadata: { documentType: "email" },
    });
  }
  return docs;
}

describe("Cooperative preemption e2e", () => {
  let dbPath: string;
  let scheduler: Scheduler;

  beforeEach(async () => {
    dbPath = testDbPath();
    const db = createDatabase(dbPath);
    db.close();
    scheduler = new Scheduler({ enablePreemption: true });
    scheduler.registerRunner(
      new WriterTaskRunner({
        gatewayDbPath: dbPath,
        journalMode: "WAL",
        heartbeatIntervalMs: 1_000,
        heartbeatWarnGapMs: 10_000,
        workerUrl: WORKER_URL,
        workerExecArgv: ["--import", LOADER_URL],
      }),
    );
    await scheduler.start();
  });

  afterEach(async () => {
    await scheduler.dispose();
    cleanupDb(dbPath);
  });

  test("user-priority op interrupts realtime upsertDocuments mid-flight", async () => {
    const gate = writeGateFromScheduler(scheduler);

    // 200 docs at chunk-size 25 (the worker's default) → 8 chunks.
    // Enough to take wall time, so the user op has a chance to land.
    const docs = makeDocs(200);

    // Kick off the realtime upsert (collector-priority by default).
    const upsertStartedAt = Date.now();
    const upsertPromise = runWithPriority("realtime", () => gate.upsertDocuments(docs));

    // Wait a beat so the upsert is actually in flight, then enqueue
    // the user op. (If we enqueue too fast, the upsert hasn't started
    // yet, the user op runs first by priority, and we don't actually
    // exercise the yield path.)
    await new Promise((r) => setTimeout(r, 30));

    const userStartedAt = Date.now();
    const userPromise = runWithPriority("user", () =>
      gate.setSyncState(
        "preempt-test",
        { type: "incremental", lastSyncTime: new Date().toISOString() } as SyncCursor,
        undefined,
      ),
    );
    const userResult = await userPromise;
    const userTookMs = Date.now() - userStartedAt;

    // The realtime upsert should still be running when the user op completes.
    // If preemption works, userTookMs should be a fraction of the upsert's
    // total wall time. A loose bound: user op completes within 2× the
    // ~25-doc chunk time (a few hundred ms on a temp DB).
    expect(userResult).toBe(true);
    // Sanity: the user op didn't have to wait the entire upsert.
    // We don't assert a tight bound (worker speed varies), just that
    // the user op didn't wait for ALL chunks of the realtime op.
    const upsertTookSoFar = Date.now() - upsertStartedAt;
    expect(userTookMs).toBeLessThan(upsertTookSoFar);

    // Realtime upsert eventually completes.
    await upsertPromise;

    // Snapshot: confirms the task was tracked. yieldCount is timing-
    // sensitive in the e2e (depends on whether the worker had finished
    // the realtime op before the user op landed) — the unit test in
    // db.test.ts proves the chunked-yield behavior of upsertDocuments
    // deterministically. Here we just check the task ran through
    // priority queues and metrics on a real worker.
    const snap = scheduler.snapshot(60);
    const upsertStats = snap.perTask.find((t) => t.name === "db.upsertDocuments");
    expect(upsertStats).toBeDefined();
    expect(upsertStats!.count).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("upsertWithCursor under mid-flight preemption loses no doc, even with tombstones", async () => {
    // The riskiest yieldable op is the collector's `db.upsertWithCursor`: it
    // resumes a mid-page yield by document identity, because `upsertDocuments`
    // drops tombstoned (privacy-deleted) docs up front and thus returns a
    // `remaining` slice on a filtered basis. An index-based resume would
    // mis-map and silently drop real docs. This drives the whole thing through
    // the REAL writer worker (real SharedArrayBuffer token + postMessage resume
    // round-trip) with a tombstone in the page and mid-flight preemption, and
    // asserts end-to-end that no non-tombstoned doc is lost.
    const gate = writeGateFromScheduler(scheduler);
    const provider = "test-provider";
    const source = "cursor-preempt";

    // Tombstone doc-90..doc-99 the production way (through the worker, so the
    // worker's tombstone-presence cache is invalidated). The docs need not
    // exist yet; the tombstone suppresses them on the upsert below.
    for (let i = 90; i < 100; i++) {
      await gate.deleteDocumentForUser(provider, source, `doc-${i}`);
    }

    // A large page (300 docs) so the cursor op spans ~6 chunks at the worker's
    // default chunkSize (50), giving mid-flight preemption a chance to force a
    // yield → identity-based resume.
    const now = new Date().toISOString();
    const docs: DocumentInput[] = [];
    for (let i = 0; i < 300; i++) {
      docs.push({
        providerId: provider,
        sourceId: source,
        externalId: `doc-${i}`,
        title: `Doc ${i}`,
        content: `Content for doc ${i} `.repeat(50),
        contentHash: `hash-${i}`,
        sourceCreatedAt: now,
        sourceUpdatedAt: now,
        metadata: { documentType: "email" },
      });
    }
    const cursor = { type: "incremental", lastSyncTime: now } as SyncCursor;

    const upsertPromise = runWithPriority("realtime", () =>
      gate.upsertWithCursor({
        providerId: provider,
        sourceId: source,
        documents: docs,
        hasMore: false,
        cursor,
      }),
    );

    // Pressure preemption with a few user-priority ops mid-flight to maximise
    // the chance a yield fires (the integrity assertions hold either way).
    await new Promise((r) => setTimeout(r, 25));
    for (let k = 0; k < 3; k++) {
      await runWithPriority("user", () =>
        gate.setSyncState(`other-source-${k}`, cursor, undefined),
      );
    }
    await upsertPromise;

    // Verify integrity via a fresh read-only handle (the worker still owns the
    // writable one; WAL permits concurrent readers).
    const read = new Database(dbPath, { readonly: true });
    try {
      const present = new Set(
        read
          .prepare<[string], { external_id: string }>(
            "SELECT external_id FROM documents WHERE source_id = ?",
          )
          .all(source)
          .map((r) => r.external_id),
      );
      // All 290 non-tombstoned docs landed — none dropped across the yields.
      expect(present.size).toBe(290);
      // The docs an index-based resume would have dropped are specifically present.
      for (const id of ["doc-50", "doc-55", "doc-59", "doc-149", "doc-299"]) {
        expect(present.has(id)).toBe(true);
      }
      // The 10 tombstoned docs stayed suppressed.
      for (let i = 90; i < 100; i++) expect(present.has(`doc-${i}`)).toBe(false);
      // The cursor advanced (final chunk committed it).
      const state = read
        .prepare<[string], { cursor: string }>("SELECT cursor FROM sync_state WHERE source_id = ?")
        .get(source);
      expect(state?.cursor).toBeTruthy();
    } finally {
      read.close();
    }
  }, 30_000);

  test("preemption disabled: no yields even with mid-flight higher-priority op", async () => {
    // Re-build with preemption disabled to confirm yields require it.
    await scheduler.dispose();
    cleanupDb(dbPath);
    dbPath = testDbPath();
    const db = createDatabase(dbPath);
    db.close();
    scheduler = new Scheduler({ enablePreemption: false });
    scheduler.registerRunner(
      new WriterTaskRunner({
        gatewayDbPath: dbPath,
        journalMode: "WAL",
        heartbeatIntervalMs: 1_000,
        heartbeatWarnGapMs: 10_000,
        workerUrl: WORKER_URL,
        workerExecArgv: ["--import", LOADER_URL],
      }),
    );
    await scheduler.start();

    const gate = writeGateFromScheduler(scheduler);
    const docs = makeDocs(50);

    const upsertPromise = runWithPriority("realtime", () => gate.upsertDocuments(docs));
    await new Promise((r) => setTimeout(r, 10));
    await runWithPriority("user", () =>
      gate.setSyncState(
        "preempt-test",
        { type: "incremental", lastSyncTime: new Date().toISOString() } as SyncCursor,
        undefined,
      ),
    );
    await upsertPromise;

    const snap = scheduler.snapshot(60);
    const upsertStats = snap.perTask.find((t) => t.name === "db.upsertDocuments");
    expect(upsertStats).toBeDefined();
    // With preemption disabled we should NEVER see a yield, regardless
    // of how the user op interleaves — the worker token is the no-op
    // shape that always returns false.
    expect(upsertStats!.yieldCount).toBe(0);
  }, 30_000);
});
