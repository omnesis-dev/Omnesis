// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `nearDup.applyBatch` against a real writer worker and a corpus the size of a
 * large drive bootstrap.
 *
 * Every eligible document write queues a near-dup inbox row, and the compute
 * drip hands the writer one batch of a hundred signed documents at a time.
 * Each document's apply starts by deleting its own LSH bucket rows, and that
 * delete read every bucket row of the active algo: with no `sqlite_stat1`, the
 * planner rated `algo_version = ?` on the bucket table's primary key as
 * selective as `doc_id = ?` on its doc index and took the covering key. Each
 * document therefore cost a scan proportional to the whole signed corpus, and
 * one chunk of documents held the writer for many seconds while every other
 * write on the gateway queued behind it.
 *
 * This suite seeds a signed corpus of invented documents, sixteen bucket rows
 * each, and holds the op to what one call may cost: a short hold, an unrelated
 * write that is served promptly behind it at a higher priority and at its own,
 * and the whole batch applied once the calls are done.
 * `OMNESIS_NEAR_DUP_BACKLOG_DOCS` sizes the corpus for a bench run.
 */

import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createDatabase } from "../db.js";
import { runWithPriority } from "../priority.js";
import { setActiveAlgoVersion } from "../near-dupes/meta.js";
import { Scheduler } from "./scheduler.js";
import { WriterTaskRunner } from "./runners/writer.js";
import { writeGateFromScheduler } from "./write-ops.js";
import type { NearDupApplyBatch } from "../near-dupes/types.js";
import type { WriteGate } from "../write-gate.js";
import type { SyncCursor } from "@omnesis/source-sdk";

const WORKER_URL = new URL("../workers/writer-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

/** Signed documents already in the corpus — the pilot held about 81k. */
const SIGNED_DOCS = Number(process.env.OMNESIS_NEAR_DUP_BACKLOG_DOCS ?? 80_000);
const BANDS = 16;
/** One compute batch, as `computeBatchSize` sizes it. */
const BATCH_DOCS = 100;
const BATCHES = 4;
/** The most near-duplicate edges one document carried on the pilot. */
const HEAVY_EDGES = 127;
/** The longest a single apply call may hold the writer. */
const HOLD_BUDGET_MS = 250;
/**
 * A ceiling on an unrelated write's end-to-end wait behind a call, for a write
 * left waiting for seconds. The wait is measured on the caller's side, so it
 * also pays the round trips to the writer thread, the checkpoints the writer
 * runs between ops and any stall of a shared runner: 516 ms has been seen with
 * the longest hold at 206 ms, so no budget near the hold stays green. What keeps
 * the write from waiting behind a batch is that each hold stays within
 * `HOLD_BUDGET_MS`.
 */
const WAIT_BUDGET_MS = 10 * HOLD_BUDGET_MS;
const ALGO = "synth-algo-v1";
const CURSOR: SyncCursor = {
  type: "incremental",
  lastSyncTime: "2026-01-05T09:00:00.000Z",
} as SyncCursor;

const corpusId = (i: number): string => `synth-drive-file-${i.toString(36).padStart(6, "0")}`;
const newId = (batch: number, i: number): string =>
  `synth-drive-new-${batch}-${i.toString().padStart(3, "0")}`;
const bucketHash = (doc: number, band: number): number =>
  (Math.imul(doc + 1, 2654435761) ^ Math.imul(band + 1, 40503)) | 0;

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"])
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
}

function insertDocStatement(db: Database.Database): Database.Statement {
  return db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, 'synth', 'synth-drive', ?, ?, '', ?, '{"documentType":"document"}',
       '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
}

/** Seed with a plain handle and close it before the writer opens the file. */
function seedCorpus(path: string): void {
  const db = createDatabase(path) as unknown as Database.Database;
  try {
    setActiveAlgoVersion(db as never, ALGO);
    const insertDoc = insertDocStatement(db);
    const insertSig = db.prepare(
      `INSERT INTO near_dup_signatures (doc_id, algo_version, signature, shingle_count, computed_at)
       VALUES (?, ?, ?, 40, 0)`,
    );
    const insertBucket = db.prepare(
      `INSERT INTO near_dup_lsh_buckets (algo_version, band_idx, bucket_hash, doc_id) VALUES (?, ?, ?, ?)`,
    );
    const insertEdge = db.prepare(
      `INSERT INTO near_dup_edges (doc_a, doc_b, algo_version, jaccard, pair_unique_df2,
         pair_unique_df5, containment_min, gate_family, computed_at)
       VALUES (?, ?, ?, 0.9, 3, 6, 0.96, 'file-like', 0)`,
    );
    const signature = Buffer.alloc(64, 7);
    db.transaction(() => {
      for (let i = 0; i < SIGNED_DOCS; i++) {
        const id = corpusId(i);
        insertDoc.run(id, id, `Quarterly report draft ${i}`, `ch-${i}`);
        insertSig.run(id, ALGO, signature);
        for (let b = 0; b < BANDS; b++) insertBucket.run(ALGO, b, bucketHash(i, b), id);
        if (i % 7 === 1) insertEdge.run(corpusId(i - 1), id, ALGO);
      }
      for (let n = 0; n < BATCHES; n++) {
        for (let i = 0; i < BATCH_DOCS; i++) {
          const id = newId(n, i);
          insertDoc.run(id, id, `Planning notes ${n}-${i}`, `ch-new-${n}-${i}`);
        }
      }
    })();
  } finally {
    db.close();
  }
}

/**
 * One compute batch of newly ingested files: each signed into sixteen
 * buckets, most matching a few corpus documents and one matching many.
 */
function makeBatch(n: number, inboxIds: number[]): NearDupApplyBatch {
  const batch: NearDupApplyBatch = {
    algoVersion: ALGO,
    processedInboxIds: inboxIds,
    signatureDeletes: [],
    signatures: [],
    bucketRows: [],
    edgeUpserts: [],
    edgeDeletes: [],
  };
  for (let i = 0; i < BATCH_DOCS; i++) {
    const docId = newId(n, i);
    batch.signatureDeletes.push(docId);
    batch.signatures.push({
      docId,
      algoVersion: ALGO,
      signature: Buffer.alloc(64, i),
      shingleCount: 40,
    });
    for (let b = 0; b < BANDS; b++) {
      batch.bucketRows.push({
        algoVersion: ALGO,
        bandIdx: b,
        bucketHash: bucketHash(SIGNED_DOCS + n * BATCH_DOCS + i, b),
        docId,
      });
    }
    const matches = i === 0 ? HEAVY_EDGES : 3;
    for (let m = 0; m < matches; m++) {
      const other = corpusId((n * 9973 + i * 131 + m * 17) % SIGNED_DOCS);
      const [docA, docB] = other < docId ? [other, docId] : [docId, other];
      batch.edgeUpserts.push({
        docA,
        docB,
        algoVersion: ALGO,
        jaccard: 0.88,
        pairUniqueDf2: 4,
        pairUniqueDf5: 7,
        containmentMin: 0.97,
        gateFamily: "file-like",
      });
    }
  }
  return batch;
}

describe("nearDup.applyBatch on the writer against a drive-sized signed corpus", () => {
  let dbPath: string;
  let scheduler: Scheduler;
  let gate: WriteGate;
  let read: Database.Database;
  let pressureSeq = 0;
  let nextBatch = 0;

  beforeAll(async () => {
    dbPath = `/tmp/omnesis-test-${randomUUID()}.db`;
    seedCorpus(dbPath);
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
    gate = writeGateFromScheduler(scheduler);
    read = new Database(dbPath, { readonly: true });
  }, 600_000);

  afterAll(async () => {
    read?.close();
    await scheduler?.dispose();
    cleanupDb(dbPath);
  });

  async function enqueueBatch(): Promise<NearDupApplyBatch> {
    const n = nextBatch++;
    const ids = Array.from({ length: BATCH_DOCS }, (_, i) => newId(n, i));
    await runWithPriority("background", () => gate.enqueueNearDupInbox(ids, "insert"));
    const placeholders = ids.map(() => "?").join(",");
    const inboxIds = read
      .prepare<string[], { id: number }>(
        `SELECT id FROM near_dup_inbox WHERE doc_id IN (${placeholders}) ORDER BY id`,
      )
      .all(...ids)
      .map((r) => r.id);
    expect(inboxIds).toHaveLength(BATCH_DOCS);
    return makeBatch(n, inboxIds);
  }

  function apply(batch: NearDupApplyBatch) {
    return runWithPriority("background", () => gate.applyNearDupBatch(batch));
  }

  /** Give a batch just dispatched time to be inside the writer. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

  function count(sql: string, ...args: string[]): number {
    return read.prepare<string[], { n: number }>(sql).get(...args)!.n;
  }

  function maxApplyHoldMs(): number {
    const stats = scheduler.snapshot(600).perTask.find((t) => t.name === "nearDup.applyBatch");
    expect(stats?.count).toBeGreaterThan(0);
    return stats!.max;
  }

  test("each call holds the writer inside the budget and the whole batch lands", async () => {
    for (let k = 0; k < BATCHES - 2; k++) {
      const batch = await enqueueBatch();
      const started = performance.now();
      const result = await apply(batch);
      const tookMs = performance.now() - started;
      expect(result.signaturesUpserted).toBe(BATCH_DOCS);
      expect(result.bucketsUpserted).toBe(BATCH_DOCS * BANDS);
      expect(result.edgesUpserted).toBe(batch.edgeUpserts.length);
      expect(result.inboxConsumed).toBe(BATCH_DOCS);
      process.stdout.write(
        `[near-dup bench] corpus=${SIGNED_DOCS} batch=${BATCH_DOCS} wall=${tookMs.toFixed(0)}ms maxHold=${maxApplyHoldMs().toFixed(0)}ms\n`,
      );
    }
    expect(maxApplyHoldMs()).toBeLessThan(HOLD_BUDGET_MS);
    expect(
      count("SELECT COUNT(*) AS n FROM near_dup_lsh_buckets WHERE algo_version = ?", ALGO),
    ).toBe((SIGNED_DOCS + (BATCHES - 2) * BATCH_DOCS) * BANDS);
  }, 600_000);

  test("a user write queued behind a batch is served promptly", async () => {
    const applying = apply(await enqueueBatch());
    await settle();
    const started = performance.now();
    expect(
      await runWithPriority("user", () =>
        gate.setSyncState(`synth-pressure-${pressureSeq++}`, CURSOR, undefined),
      ),
    ).toBe(true);
    const waited = performance.now() - started;
    expect((await applying).inboxConsumed).toBe(BATCH_DOCS);
    expect(waited).toBeLessThan(WAIT_BUDGET_MS);
    expect(maxApplyHoldMs()).toBeLessThan(HOLD_BUDGET_MS);
  }, 600_000);

  test("a background write at the batch's own priority is served promptly", async () => {
    const applying = apply(await enqueueBatch());
    await settle();
    const started = performance.now();
    expect(
      await runWithPriority("background", () =>
        gate.setSyncState(`synth-pressure-${pressureSeq++}`, CURSOR, undefined),
      ),
    ).toBe(true);
    const waited = performance.now() - started;
    expect((await applying).inboxConsumed).toBe(BATCH_DOCS);
    expect(waited).toBeLessThan(WAIT_BUDGET_MS);
    expect(maxApplyHoldMs()).toBeLessThan(HOLD_BUDGET_MS);
  }, 600_000);
});
