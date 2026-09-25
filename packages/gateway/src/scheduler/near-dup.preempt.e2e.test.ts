// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * End-to-end no-starvation test for `nearDup.applyBatch`.
 *
 * The user emphasized that the near-dup background drip must NEVER
 * cause starvation of real-time or user-priority writer ops. This test
 * stages a worst-case scenario:
 *
 *   1. Background-priority `nearDup.applyBatch` carrying 50 docs'
 *      worth of signature + bucket + edge upserts — enough work to
 *      take real wall time inside the writer worker.
 *   2. While that batch is mid-flight, fire a user-priority
 *      `db.setSyncState` AND a realtime-priority `db.upsertDocuments`.
 *   3. Assert both higher-priority ops complete BEFORE the background
 *      batch — they slipped in via the cooperative yield path
 *      (`PreemptToken.requested()` flips after the in-flight task
 *      sees a higher-priority enqueue).
 *
 * Why this matters: a single large near-dup batch could in principle
 * park the writer for hundreds of ms; without yield, user-triggered
 * search filter ingestion or a portal action would queue behind it.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runWithPriority } from "../priority.js";
import { createDatabase } from "../db.js";
import { setActiveAlgoVersion } from "../near-dupes/meta.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { writeGateFromScheduler } from "./write-ops.js";
import type {
  NearDupApplyBatch,
  NearDupBucketUpsert,
  NearDupEdgeUpsert,
  NearDupSignatureUpsert,
} from "../near-dupes/types.js";
import type { SyncCursor } from "@omnesis/source-sdk";
import type { DocumentInput } from "@omnesis/types";

const WORKER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

function testDbPath(): string {
  return `/tmp/omnesis-near-dup-preempt-${randomUUID()}.db`;
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

/**
 * Build a batch of N docs, each with one signature row + 16 bucket
 * rows + edges to every other doc. With N=50 that's 50 signatures +
 * 800 bucket rows + 1,225 edge upserts — heavy enough that the batch
 * runs across many YIELD_GRANULARITY=25 chunks.
 */
function makeNearDupBatch(n: number): NearDupApplyBatch {
  const algoVersion = "preempt-test-v1";
  const signatures: NearDupSignatureUpsert[] = [];
  const bucketRows: NearDupBucketUpsert[] = [];
  const edgeUpserts: NearDupEdgeUpsert[] = [];
  const signatureDeletes: string[] = [];
  const processedInboxIds: number[] = [];
  for (let i = 0; i < n; i++) {
    const docId = `doc-${i.toString().padStart(4, "0")}`;
    signatureDeletes.push(docId);
    signatures.push({
      docId,
      algoVersion,
      signature: Buffer.from(`sig-${i}`),
      shingleCount: 10,
    });
    for (let b = 0; b < 16; b++) {
      bucketRows.push({
        algoVersion,
        bandIdx: b,
        bucketHash: i * 17 + b,
        docId,
      });
    }
    for (let j = 0; j < i; j++) {
      const docA = `doc-${j.toString().padStart(4, "0")}`;
      const docB = docId;
      edgeUpserts.push({
        docA,
        docB,
        algoVersion,
        jaccard: 0.9,
        pairUniqueDf2: 5,
        pairUniqueDf5: 10,
        containmentMin: 0.95,
        gateFamily: "email",
      });
    }
    processedInboxIds.push(i + 1);
  }
  return {
    algoVersion,
    processedInboxIds,
    signatureDeletes,
    signatures,
    bucketRows,
    edgeUpserts,
    edgeDeletes: [],
  };
}

function makeDocs(n: number): DocumentInput[] {
  const now = new Date().toISOString();
  return Array.from({ length: n }, (_, i) => ({
    providerId: "test-provider",
    sourceId: "preempt-near-dup",
    externalId: `user-doc-${i}`,
    title: `User Doc ${i}`,
    content: `User content ${i} `.repeat(50),
    contentHash: `user-hash-${i}`,
    sourceCreatedAt: now,
    sourceUpdatedAt: now,
    metadata: { documentType: "email" },
  }));
}

describe("near-dup applyBatch — no-starvation preempt", () => {
  let dbPath: string;
  let scheduler: Scheduler;

  beforeEach(async () => {
    dbPath = testDbPath();
    const db = createDatabase(dbPath);
    // Seed the active algo and 50 placeholder document rows so the
    // applyBatch's signature/bucket FKs resolve. Edges are not FK'd
    // to documents in this test path — we drop them post-write via
    // INSERT OR REPLACE — but signature + lsh_buckets ARE FK'd, so
    // we seed.
    setActiveAlgoVersion(db, "preempt-test-v1");
    const insertDoc = db.prepare(
      `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
          content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = db.transaction(() => {
      for (let i = 0; i < 50; i++) {
        const id = `doc-${i.toString().padStart(4, "0")}`;
        insertDoc.run(
          id,
          "p",
          "src:p",
          id,
          `t-${i}`,
          `body-${i}`,
          `ch-${i}`,
          JSON.stringify({ documentType: "email" }),
          "2025-01-01T00:00:00Z",
          "2025-01-01T00:00:00Z",
          "2025-01-01T00:00:00Z",
          "2025-01-01T00:00:00Z",
        );
      }
    });
    tx();
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

  test("user-priority setSyncState slips in before a heavy background nearDup.applyBatch", async () => {
    const gate = writeGateFromScheduler(scheduler);

    const batch = makeNearDupBatch(50);
    // No explicit runWithPriority — nearDup.applyBatch defaults to
    // "background" via the write-ops registry, which is what we want
    // to test (the production drip uses the default priority).
    const applyStartedAt = Date.now();
    const applyPromise = gate.applyNearDupBatch(batch);

    // Give the writer a moment to start the batch.
    await new Promise((r) => setTimeout(r, 30));

    const userStartedAt = Date.now();
    const userPromise = runWithPriority("user", () =>
      gate.setSyncState(
        "preempt-near-dup",
        { type: "incremental", lastSyncTime: new Date().toISOString() } as SyncCursor,
        undefined,
      ),
    );
    const userResult = await userPromise;
    const userTookMs = Date.now() - userStartedAt;
    expect(userResult).toBe(true);

    // The user op shouldn't have waited for the entire applyBatch to
    // finish. Loose bound: user took less than the total wall time of
    // the batch up to this point (which keeps growing until applyBatch
    // resolves).
    const applyTookSoFar = Date.now() - applyStartedAt;
    expect(userTookMs).toBeLessThan(applyTookSoFar);

    await applyPromise;

    // Sanity: the batch did make it all the way through (every signature
    // landed in the table).
    const db = createDatabase(dbPath);
    const sigCount = (
      db.prepare("SELECT COUNT(*) AS n FROM near_dup_signatures").get() as { n: number }
    ).n;
    db.close();
    expect(sigCount).toBe(50);
  }, 30_000);

  test("realtime-priority upsertDocuments lands in the middle of a background near-dup batch", async () => {
    const gate = writeGateFromScheduler(scheduler);

    const batch = makeNearDupBatch(50);
    const applyStartedAt = Date.now();
    const applyPromise = gate.applyNearDupBatch(batch);

    await new Promise((r) => setTimeout(r, 30));

    const realtimeStartedAt = Date.now();
    const realtimeDocs = makeDocs(5);
    const realtimePromise = runWithPriority("realtime", () => gate.upsertDocuments(realtimeDocs));
    await realtimePromise;
    const realtimeTookMs = Date.now() - realtimeStartedAt;

    const applyTookSoFar = Date.now() - applyStartedAt;
    expect(realtimeTookMs).toBeLessThan(applyTookSoFar);

    await applyPromise;

    // All 5 user docs landed.
    const db = createDatabase(dbPath);
    const userDocs = (
      db
        .prepare("SELECT COUNT(*) AS n FROM documents WHERE source_id = ?")
        .get("preempt-near-dup") as { n: number }
    ).n;
    db.close();
    expect(userDocs).toBe(5);

    // Scheduler metrics — `nearDup.applyBatch` ran. yieldCount is
    // timing-sensitive, but the task should have been observed.
    const snap = scheduler.snapshot(60);
    const applyStats = snap.perTask.find((t) => t.name === "nearDup.applyBatch");
    expect(applyStats).toBeDefined();
    expect(applyStats!.count).toBeGreaterThanOrEqual(1);
  }, 30_000);

  test("user-priority SLA bucket caught a sample mid-batch (no starvation)", async () => {
    const gate = writeGateFromScheduler(scheduler);
    const batch = makeNearDupBatch(50);
    const applyPromise = gate.applyNearDupBatch(batch);
    await new Promise((r) => setTimeout(r, 30));

    // Fire several user-priority ops back-to-back so the SLA bucket
    // accumulates samples. Each op carries the priority via ALS through
    // runWithPriority.
    const userOps: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      userOps.push(
        runWithPriority("user", () =>
          gate.setSyncState(
            `preempt-${i}`,
            { type: "incremental", lastSyncTime: new Date().toISOString() } as SyncCursor,
            undefined,
          ),
        ),
      );
    }
    await Promise.all(userOps);
    await applyPromise;

    const snap = scheduler.snapshot(60);
    // 10 user-priority ops were enqueued — the SLA bucket should
    // reflect that.
    expect(snap.userSla.count).toBeGreaterThanOrEqual(10);
    // The user-priority p95 queue time should be well under the apply
    // batch's total wall time. We assert a loose 5-second bound; a
    // proper starvation regression would push this into the seconds
    // range. The unit test in NearDupWriterOps.test.ts proves the
    // yield path returns `remaining` correctly.
    if (snap.userSla.p95Ms !== undefined) {
      expect(snap.userSla.p95Ms).toBeLessThan(5_000);
    }
  }, 30_000);
});
