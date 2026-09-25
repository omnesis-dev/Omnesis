// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search-worker relocation (Slice 3B) — ranking-order invariant across the
 * thread split.
 *
 * The pipeline's post-candidate-gen order is load-bearing: fusion → boost →
 * diversity (the last REORDER) → RefCount (enrich, never sort) → content-hash
 * dedupe (position-preserving, slices to `limit`). Moving candidate-gen to a
 * worker must not perturb any of it.
 *
 * Fusion is always RRF: with no embedder attached the vector list is simply
 * empty, so each candidate scores `bm25Weight / (rrfK + bm25Rank)` and the
 * head takes the `topRankBonus` / `nearTopRankBonus` nudges. (The stage report
 * calls the method "bm25-only" — that names the input lists, not the formula.)
 * At the default k = 60 the six docs score, BM25 rank in parentheses:
 *
 *   d1 (1) 1/61 + 0.05 = .06639   d4 (4) 1/64          = .01563
 *   d2 (2) 1/62 + 0.02 = .03613   d6 (5) 1/65          = .01538
 *   d3 (3) 1/63 + 0.02 = .03587   d5 (6) 1/66          = .01515
 *
 * so fusion emits d1, d2, d3, d4, d6, d5. No source priors are configured, so
 * the boost pass is score-neutral here.
 *
 * The fixture is engineered so BOTH reordering mechanisms fire at `limit = 3`:
 *   - Diversity REORDERS: two gmail docs (d1, d2) out-score the notes docs on
 *     BM25, but MMR spreads sources, lifting a notes doc (d3) above d2 — the
 *     pool becomes d1, d3, d2, d6, d4, d5.
 *   - Dedupe pulls a TAIL doc UP into the window: d1 and d2 share a content
 *     hash, so d2 (which held a top-3 slot) collapses into d1, and d6 — 4th in
 *     that pool, OUTSIDE the naive top-3 — is pulled into the window.
 *
 * Assertions:
 *   1. The worker-path final result set is BYTE-IDENTICAL to the in-process one
 *      (ids, order, score, chunkText, refCount, breakdown) — the parity guard.
 *   2. Diversity actually ran (the fixture isn't a single-bucket no-op).
 *   3. The tail-pull is real: a distinct-hash twin fixture windows to [d1,d3,d2],
 *      while the shared-hash fixture windows to [d1,d3,d6] — d6 replaced the
 *      collapsed d2.
 *   4. RefCount ran and did NOT re-sort: a giant inbound-ref count on the LAST
 *      result does not move it, and the order is identical with and without the
 *      ref source.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createIndexDatabase,
  EMBEDDING_DIM,
  openIndexDb,
  setIndexedDocument,
  upsertChunks,
} from "../indexer/db.js";
import { SearchWorkerPool } from "../workers/search-pool.js";
import { SearchPipeline } from "./pipeline.js";
import { closeTempDb } from "./test-utils.js";
import type { LinkRefSource } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

const dummyEmbedding = new Float32Array(EMBEDDING_DIM).fill(0);

const WORKER_URL = new URL("../workers/search-worker.ts", import.meta.url);
const LOADER_URL = new URL("../workers/register-tsx.mjs", import.meta.url).href;

/**
 * Six "budget" documents across three source types, BM25 term frequency
 * descending d1..d6. `sharedTopHash` decides whether the two top gmail docs
 * (d1, d2) share a content hash — the switch that turns the content-hash dedupe
 * into a tail-pull.
 */
function seedIndexDb(path: string, sharedTopHash: boolean): void {
  const db = createIndexDatabase(path);
  const rows: Array<[string, string, string, string]> = [
    ["d1", "gmail:user@example.com", "email", "budget budget budget budget budget review here"],
    ["d2", "gmail:user@example.com", "email", "budget budget budget budget review here now"],
    ["d3", "apple-notes:local", "note", "budget budget budget review of the plan"],
    ["d4", "apple-notes:local", "note", "budget budget review of the plan here"],
    ["d5", "whatsapp:local", "conversation", "budget review chat message"],
    ["d6", "whatsapp:local", "conversation", "budget note quick"],
  ];
  upsertChunks(
    db,
    rows.map(([id, sourceId, dt, content], i) => ({
      id: `chunk-${id}`,
      documentId: id,
      chunkIndex: 0,
      content,
      embedding: dummyEmbedding,
      sourceId,
      documentType: dt,
      title: `Doc ${id}`,
      sourceCreatedAt: `2026-0${(i % 9) + 1}-01T10:00:00Z`,
    })),
  );
  for (const [id] of rows) setIndexedDocument(db, id, `hash-${id}`, 1);
  if (sharedTopHash) {
    // d1 and d2 are byte-distinct but share a hash → dedupe collapses d2 into
    // d1, freeing a top-3 slot for the tail doc d6.
    setIndexedDocument(db, "d1", "hash-top-dup", 1);
    setIndexedDocument(db, "d2", "hash-top-dup", 1);
  }
  db.close();
}

/** A ref source that reports a huge inbound-ref count for the LAST expected
 *  result (`d6`) and nothing for the rest — a re-sort by refCount would jump it
 *  to the front; a correct pipeline leaves it in place. */
function refSourceFor(hotDocId: string, count: number): LinkRefSource {
  return {
    getInboundRefCounts(documentIds: readonly string[]): Map<string, number> {
      const m = new Map<string, number>();
      for (const id of documentIds) m.set(id, id === hotDocId ? count : 0);
      return m;
    },
  };
}

describe("search worker — ranking-order invariant (diversity reorder + dedupe tail-pull)", () => {
  let configDir: string;
  let dbPath: string;
  let inProcDb: Db;
  let pool: SearchWorkerPool;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "omnesis-sword-"));
    dbPath = join(configDir, "index.db");
    seedIndexDb(dbPath, /* sharedTopHash */ true);
    inProcDb = openIndexDb(dbPath, { readonly: true });
    pool = new SearchWorkerPool({
      indexDbPath: dbPath,
      configDir,
      concurrency: 1,
      maxInflightBeforeFallback: 2,
      heartbeatIntervalMs: 1_000,
      heartbeatWarnGapMs: 10_000,
      workerUrl: WORKER_URL,
      workerExecArgv: ["--import", LOADER_URL],
    });
    await pool.start();
  });

  afterEach(async () => {
    await pool.dispose();
    inProcDb.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  test("worker-path final order is byte-identical to in-process, with diversity + tail-pull active", async () => {
    const refSource = refSourceFor("d6", 999);

    // Both pipelines share the SAME ref source + config, so a byte-identical
    // result set is the correct expectation.
    const inproc = new SearchPipeline({ indexDb: inProcDb, linkRefSource: refSource });
    const worker = new SearchPipeline({ indexDb: inProcDb, linkRefSource: refSource });
    worker.setSearchPool(pool);

    const inprocRes = await inproc.search({ text: "budget", limit: 3 });
    const workerRes = await worker.search({ text: "budget", limit: 3 });

    // (1) Parity: identical ids/order/score/chunkText/refCount/breakdown.
    expect(workerRes.results).toEqual(inprocRes.results);
    expect(worker.getSearchWorkerFallbacks()).toEqual({
      saturated: 0,
      error: 0,
      unconfigured: 0,
    });

    const order = workerRes.results.map((r) => r.documentId);
    // (3a) The engineered window: d2 collapsed into d1, d6 pulled up from 4th.
    expect(order).toEqual(["d1", "d3", "d6"]);

    // (2) Diversity actually reordered (multi-bucket fixture, not a no-op).
    expect(workerRes.stages?.diversity?.status).toBe("ran");

    // (4) RefCount ran and did NOT re-sort: d6 carries its giant ref count but
    // stays LAST — a re-sort by refCount would have jumped it to position 0.
    const d6 = workerRes.results.find((r) => r.documentId === "d6");
    expect(d6?.refCount).toBe(999);
    expect(order[order.length - 1]).toBe("d6");
  });

  test("tail-pull is real: a distinct-hash twin windows to [d1,d3,d2], the shared-hash to [d1,d3,d6]", async () => {
    // Same corpus but with d1/d2 as DISTINCT hashes — nothing collapses, so the
    // naive top-3 keeps d2 and d6 stays outside the window. The contrast proves
    // the shared-hash run's d6 is a genuine tail doc dedupe pulled in.
    const distinctPath = join(configDir, "index-distinct.db");
    seedIndexDb(distinctPath, /* sharedTopHash */ false);
    const distinctDb = openIndexDb(distinctPath, { readonly: true });
    const distinct = new SearchPipeline({ indexDb: distinctDb });

    const distinctRes = await distinct.search({ text: "budget", limit: 3 });
    const distinctOrder = distinctRes.results.map((r) => r.documentId);
    expect(distinctOrder).toEqual(["d1", "d3", "d2"]);
    expect(distinctOrder).not.toContain("d6"); // d6 is outside the naive top-3

    // The shared-hash pipeline (worker) pulls d6 IN where d2 was.
    const worker = new SearchPipeline({ indexDb: inProcDb });
    worker.setSearchPool(pool);
    const sharedRes = await worker.search({ text: "budget", limit: 3 });
    const sharedOrder = sharedRes.results.map((r) => r.documentId);
    expect(sharedOrder).toEqual(["d1", "d3", "d6"]);
    expect(sharedOrder).not.toContain("d2"); // d2 collapsed into d1

    closeTempDb(distinctDb);
  });

  test("RefCount is position-preserving: order is identical with and without the ref source", async () => {
    const withRef = new SearchPipeline({
      indexDb: inProcDb,
      linkRefSource: refSourceFor("d6", 999),
    });
    withRef.setSearchPool(pool);
    const noRef = new SearchPipeline({ indexDb: inProcDb });
    noRef.setSearchPool(pool);

    const withRes = await withRef.search({ text: "budget", limit: 3 });
    const noRes = await noRef.search({ text: "budget", limit: 3 });

    // The ref enrichment attaches a count but never reorders.
    expect(withRes.results.map((r) => r.documentId)).toEqual(
      noRes.results.map((r) => r.documentId),
    );
    expect(withRes.results.find((r) => r.documentId === "d6")?.refCount).toBe(999);
    expect(noRes.results.find((r) => r.documentId === "d6")?.refCount).toBeUndefined();
  });
});
