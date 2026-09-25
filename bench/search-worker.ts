#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Search-worker relocation bench (Slice 3B — STAGE 5 proof).
 *
 * The whole point of Slice 3B is to move the SYNCHRONOUS candidate-generation
 * block — BM25 over FTS5, native usearch.search over the HNSW graph, the
 * candidate fetch from index.db, and the pure-JS fusion / boost / diversity /
 * full-pool hydrate — OFF the main event loop onto a dedicated search-worker.
 * This bench PROVES and QUANTIFIES that.
 *
 * The metric is **main-thread event-loop occupancy**, NOT wall-clock latency.
 * Wall-clock may even rise slightly on the worker arm (the postMessage
 * round-trip is not free) — that is expected and fine. What matters is: how
 * many milliseconds of event-loop lag per query does relocating the block
 * eliminate?
 *
 * Two arms over one identical heavy on-disk index (N ~ 60k chunks):
 *   Arm A (worker OFF / baseline): runCandidateGen() INLINE on the main thread.
 *     The heavy block holds the JS thread for its whole duration, so the loop
 *     freezes once per query.
 *   Arm B (worker ON, K=1): await pool.candidateGen() over a real
 *     SearchWorkerPool. The block runs on the worker thread; main stays free.
 *
 * During each arm a main-thread event-loop-delay probe runs (perf_hooks
 * `monitorEventLoopDelay` histogram + a redundant setInterval heartbeat). The
 * headline: arm A's loop lag max/p99 ~ the per-call block duration (loop frozen
 * per query); arm B's stays near zero (loop free).
 *
 * Guards: (1) parity — arm A and arm B return byte-identical results for a
 * sample query; (2) the worker was actually used (pool ready, inflight > 0, no
 * fallback), so the low arm-B lag is real relocation, not a silent inline path.
 *
 * Fully isolated: a fresh temp dir, never the live gateway / :7600 /
 * ~/.config/omnesis.
 *
 * Use:
 *   npx tsx bench/search-worker.ts
 *   BENCH_N=30000 BENCH_QUERIES=300 BENCH_CONCURRENCY=4 npx tsx bench/search-worker.ts
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as yieldToLoop } from "node:timers/promises";

import {
  EMBEDDING_DIM,
  createIndexDatabase,
  openIndexDb,
  upsertChunks,
  type ChunkUpsertInput,
} from "../packages/gateway/src/indexer/db.js";
import { UsearchWriteHandle } from "../packages/gateway/src/indexer/usearch-index.js";
import { UsearchReadRegistry } from "../packages/gateway/src/indexer/usearch-read-registry.js";
import { SearchWorkerPool } from "../packages/gateway/src/workers/search-pool.js";
import {
  runCandidateGen,
  type CandidateGenRequest,
  type CandidateGenResources,
  type CandidateGenResult,
} from "../packages/gateway/src/search/candidate-gen.js";
import {
  resolveDiversityConfig,
  resolveSearchSettings,
  resolveSourcePriorsConfig,
  resolveVectorConfig,
} from "../packages/gateway/src/search/search-config.js";

// ── Params ──────────────────────────────────────────────────────────────────

const N = intEnv("BENCH_N", 60_000); // chunks seeded into the heavy index
const QUERIES = intEnv("BENCH_QUERIES", 200); // candidate-gen calls per arm
const CONCURRENCY = intEnv("BENCH_CONCURRENCY", 4); // arm-B in-flight window
const WARMUP = intEnv("BENCH_WARMUP", 12); // untimed calls to warm caches
const DISTINCT_QUERIES = 64; // varied requests we cycle through
const VOCAB = 400; // distinct BM25 tokens
const TOKENS_PER_DOC = 8;

function intEnv(name: string, dflt: number): number {
  const v = process.env[name];
  if (!v) return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
}

// ── Deterministic fixtures (invented, corpus-free) ────────────────────────────

/** Deterministic normalized embedding for a seed — the sidecar test's helper. */
function embedding(val: number): Float32Array {
  const a = new Float32Array(EMBEDDING_DIM);
  let s = (val * 0x9e3779b9) >>> 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    a[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  let n = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) n += a[i] * a[i];
  const norm = Math.sqrt(n) || 1;
  for (let i = 0; i < EMBEDDING_DIM; i++) a[i] /= norm;
  return a;
}

/** Seedable PRNG (mulberry32) so the corpus + query stream are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const token = (i: number): string => `t${String(i).padStart(3, "0")}`;

// ── Metrics helpers ───────────────────────────────────────────────────────────

function pct(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank))];
}

function stats(samples: number[]): { p50: number; p99: number; max: number; mean: number } {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.length ? s.reduce((x, y) => x + y, 0) / s.length : 0;
  return { p50: pct(s, 50), p99: pct(s, 99), max: s.length ? s[s.length - 1] : 0, mean };
}

const ms = (n: number): string => n.toFixed(2);
const NS_PER_MS = 1e6;

/** A redundant heartbeat probe: records how late each tick fires (loop lag). */
class Heartbeat {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private intervalMs = 0;
  readonly samples: number[] = [];
  start(intervalMs: number): void {
    this.intervalMs = intervalMs;
    this.last = performance.now();
    this.samples.length = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      this.samples.push(Math.max(0, now - this.last - this.intervalMs));
      this.last = now;
    }, intervalMs);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ── Request construction (embedder attached: BM25 + vector) ──────────────────

function buildRequests(): CandidateGenRequest[] {
  const settings = resolveSearchSettings(undefined);
  const vectorConfig = resolveVectorConfig(undefined);
  const sourcePriors = resolveSourcePriorsConfig(
    undefined,
    {},
    { docCounts: [], rrfK: settings.params.rrfK },
  );
  const diversity = resolveDiversityConfig(undefined);
  const rng = mulberry32(0xbeef);
  const reqs: CandidateGenRequest[] = [];
  for (let q = 0; q < DISTINCT_QUERIES; q++) {
    const terms: string[] = [];
    for (let k = 0; k < 3; k++) terms.push(token(Math.floor(rng() * VOCAB)));
    const queryDoc = Math.floor(rng() * N);
    reqs.push({
      mode: "hybrid",
      bm25Text: terms.join(" "),
      embedderPresent: true,
      queryVector: embedding(queryDoc),
      embedMs: 0,
      queryModelId: null, // no active generation stamp ⇒ degrade guard is inert
      filters: {},
      allowedDocumentIds: undefined,
      candidateLimit: settings.params.candidateLimit, // 50
      limit: settings.params.resultLimit, // 10
      settings,
      vectorConfig,
      sourcePriors,
      diversity,
      commonTokenThreshold: 0.1,
    });
  }
  return reqs;
}

// ── Corpus seeding + HNSW build ───────────────────────────────────────────────

function seedIndex(dbPath: string, configDir: string): { buildMs: number; vectors: number } {
  const db = createIndexDatabase(dbPath);
  const rng = mulberry32(0x1234);
  const BATCH = 5_000;
  let batch: ChunkUpsertInput[] = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    upsertChunks(db, batch);
    batch = [];
  };
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const terms: string[] = [];
    for (let k = 0; k < TOKENS_PER_DOC; k++) terms.push(token(Math.floor(rng() * VOCAB)));
    batch.push({
      id: `c-${i}`,
      documentId: `doc-${i}`,
      chunkIndex: 0,
      content: terms.join(" "),
      embedding: embedding(i),
      sourceId: `src-${i % 6}`, // 6 synthetic sources so diversity/priors have work
      documentType: ["note", "email", "conversation", "file"][i % 4],
      title: `record ${i} ${terms[0]} ${terms[1]}`,
      sourceCreatedAt: new Date(Date.UTC(2026, 0, 1 + (i % 900))).toISOString(),
      author: `Author ${i % 50}`,
    });
    if (batch.length >= BATCH) flush();
  }
  flush();
  // Populate indexed_documents so the content-hash fetch in candidate-gen is
  // exercised with distinct hashes (no artificial dedupe collapse).
  db.exec(
    `INSERT OR REPLACE INTO indexed_documents (document_id, content_hash, chunk_count, indexed_at)
       SELECT document_id, 'h-' || document_id, 1, '2026-01-01T00:00:00Z' FROM chunks`,
  );
  const seedMs = performance.now() - t0;
  process.stderr.write(`  seeded ${N} chunks + FTS in ${(seedMs / 1000).toFixed(1)}s\n`);

  const tBuild = performance.now();
  const writer = new UsearchWriteHandle(join(configDir, "index.usearch"), EMBEDDING_DIM);
  writer.backfillFromDb(db);
  const vectors = writer.size();
  writer.close();
  const buildMs = performance.now() - tBuild;
  db.close();
  return { buildMs, vectors };
}

// ── Byte-identity parity compare ──────────────────────────────────────────────

function parityEqual(a: CandidateGenResult, b: CandidateGenResult): { ok: boolean; why: string } {
  if (a.results.length !== b.results.length)
    return { ok: false, why: `pool size ${a.results.length} != ${b.results.length}` };
  for (let i = 0; i < a.results.length; i++) {
    const x = a.results[i];
    const y = b.results[i];
    if (x.documentId !== y.documentId)
      return { ok: false, why: `#${i} id ${x.documentId} != ${y.documentId}` };
    if (x.chunkRowid !== y.chunkRowid)
      return { ok: false, why: `#${i} chunkRowid ${x.chunkRowid} != ${y.chunkRowid}` };
    if (x.score !== y.score) return { ok: false, why: `#${i} score ${x.score} != ${y.score}` };
    if (x.chunkText !== y.chunkText) return { ok: false, why: `#${i} chunkText differs` };
  }
  const ah = JSON.stringify({ ...a.contentHashByDoc });
  const bh = JSON.stringify({ ...b.contentHashByDoc });
  if (ah !== bh) return { ok: false, why: "contentHashByDoc differs" };
  if (a.vectorDegraded !== b.vectorDegraded) return { ok: false, why: "vectorDegraded differs" };
  if (JSON.stringify(a.notices) !== JSON.stringify(b.notices))
    return { ok: false, why: "notices differ" };
  return { ok: true, why: "" };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-swbench-"));
  const dbPath = join(configDir, `index-${randomUUID()}.db`);
  process.stderr.write(`Search-worker bench — isolated dir ${configDir}\n`);
  process.stderr.write(`Building heavy index: N=${N} chunks, dim=${EMBEDDING_DIM}...\n`);

  const { buildMs, vectors } = seedIndex(dbPath, configDir);
  process.stderr.write(`  HNSW build: ${vectors} vectors in ${(buildMs / 1000).toFixed(1)}s\n`);

  // Main-thread fallback substrate (what arm A calls, and what the pipeline
  // would degrade to). Read-only handle, no query_only (matches the worker).
  const mainDb = openIndexDb(dbPath, { readonly: true });
  const mainResources: CandidateGenResources = {
    indexDb: mainDb,
    usearchRead: new UsearchReadRegistry(mainDb, configDir),
  };

  const requests = buildRequests();
  const monitor = monitorEventLoopDelay({ resolution: 1 });
  const heartbeat = new Heartbeat();
  monitor.enable();

  // ── Per-call block magnitude (single, unqueued, main-thread) ────────────────
  for (let i = 0; i < WARMUP; i++) runCandidateGen(mainResources, requests[i % requests.length]);
  const blockSamples: number[] = [];
  let samplePool: CandidateGenResult | null = null;
  for (let i = 0; i < Math.min(QUERIES, 120); i++) {
    const t0 = performance.now();
    const r = runCandidateGen(mainResources, requests[i % requests.length]);
    blockSamples.push(performance.now() - t0);
    if (i === 0) samplePool = r;
  }
  const block = stats(blockSamples);
  process.stderr.write(
    `  per-call candidate-gen block: p50=${ms(block.p50)}ms p99=${ms(block.p99)}ms ` +
      `max=${ms(block.max)}ms (pool size ${samplePool?.results.length ?? 0})\n`,
  );

  // ── Arm A: worker OFF — runCandidateGen INLINE on main ──────────────────────
  process.stderr.write(`\nArm A (worker OFF): ${QUERIES} inline candidate-gen calls...\n`);
  monitor.reset();
  heartbeat.start(4);
  const armAWall: number[] = [];
  for (let k = 0; k < QUERIES; k++) {
    const t0 = performance.now();
    runCandidateGen(mainResources, requests[k % requests.length]); // blocks the loop
    armAWall.push(performance.now() - t0);
    await yieldToLoop(); // let the loop breathe between queries (per-query blocks)
  }
  heartbeat.stop();
  const armALoop = {
    p50: monitor.percentile(50) / NS_PER_MS,
    p99: monitor.percentile(99) / NS_PER_MS,
    max: monitor.max / NS_PER_MS,
    mean: monitor.mean / NS_PER_MS,
  };
  const armAHeart = stats(heartbeat.samples);
  const armAWallS = stats(armAWall);

  // ── Arm B: worker ON, K=1 — pool.candidateGen off the main thread ───────────
  process.stderr.write(`Arm B (worker ON, K=1): starting SearchWorkerPool...\n`);
  const workerUrl = new URL("../packages/gateway/src/workers/search-worker.ts", import.meta.url);
  const loaderUrl = new URL("../packages/gateway/src/workers/register-tsx.mjs", import.meta.url)
    .href;
  const pool = new SearchWorkerPool({
    indexDbPath: dbPath,
    configDir,
    concurrency: 1,
    maxInflightBeforeFallback: Math.max(2, CONCURRENCY),
    heartbeatIntervalMs: 60_000,
    heartbeatWarnGapMs: 600_000,
    workerUrl,
    workerExecArgv: ["--import", loaderUrl],
  });
  await pool.start();
  if (!pool.isReady) throw new Error("search worker pool never became ready");

  // Warm the worker (pages its own mmap/FTS caches in).
  for (let i = 0; i < WARMUP; i++) await pool.candidateGen(requests[i % requests.length]);

  process.stderr.write(`Arm B: ${QUERIES} pool calls, concurrency ${CONCURRENCY}...\n`);
  monitor.reset();
  heartbeat.start(4);
  const armBWall: number[] = [];
  let launched = 0;
  let resolved = 0;
  let errors = 0;
  let maxPoolInflight = 0;
  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      while (pool.inflightCount < CONCURRENCY && launched < QUERIES) {
        const req = requests[launched % requests.length];
        launched += 1;
        const t0 = performance.now();
        pool
          .candidateGen(req)
          .then(() => {
            armBWall.push(performance.now() - t0);
          })
          .catch((err: unknown) => {
            errors += 1;
            reject(err instanceof Error ? err : new Error(String(err)));
          })
          .finally(() => {
            resolved += 1;
            if (resolved >= QUERIES) resolve();
            else pump();
          });
        maxPoolInflight = Math.max(maxPoolInflight, pool.inflightCount);
      }
    };
    pump();
  });
  heartbeat.stop();
  const armBLoop = {
    p50: monitor.percentile(50) / NS_PER_MS,
    p99: monitor.percentile(99) / NS_PER_MS,
    max: monitor.max / NS_PER_MS,
    mean: monitor.mean / NS_PER_MS,
  };
  const armBHeart = stats(heartbeat.samples);
  const armBWallS = stats(armBWall);
  monitor.disable();

  // ── Guard 1: byte-identical parity (arm A inline vs arm B worker) ───────────
  const sampleReq = requests[0];
  const inlineRes = runCandidateGen(mainResources, sampleReq);
  const workerRes = await pool.candidateGen(sampleReq);
  const parity = parityEqual(inlineRes, workerRes);

  // ── Report ──────────────────────────────────────────────────────────────────
  const line = "─".repeat(78);
  const out: string[] = [];
  out.push("");
  out.push(line);
  out.push("  SEARCH-WORKER RELOCATION BENCH (Slice 3B) — main-thread event-loop occupancy");
  out.push(line);
  out.push(`  index:            N=${N} chunks / ${vectors} HNSW vectors (dim ${EMBEDDING_DIM})`);
  out.push(
    `  search:           BM25 + vector (embedder attached), candidateLimit=50 resultLimit=10`,
  );
  out.push(`  queries per arm:  ${QUERIES}   arm-B concurrency: ${CONCURRENCY} (K=1 worker)`);
  out.push(
    `  per-call block:   p50=${ms(block.p50)}ms  p99=${ms(block.p99)}ms  max=${ms(block.max)}ms` +
      `   (the synchronous candidate-gen cost = the main-loop freeze per query)`,
  );
  out.push("");
  out.push("  MAIN-THREAD EVENT-LOOP LAG  (monitorEventLoopDelay histogram)");
  out.push("  arm                         p50 (ms)   p99 (ms)   max (ms)   cg wall p50/p99 (ms)");
  out.push("  " + "-".repeat(74));
  out.push(
    `  A  worker OFF (inline)     ${col(armALoop.p50)} ${col(armALoop.p99)} ${col(armALoop.max)}   ${ms(armAWallS.p50)} / ${ms(armAWallS.p99)}`,
  );
  out.push(
    `  B  worker ON  (K=1)        ${col(armBLoop.p50)} ${col(armBLoop.p99)} ${col(armBLoop.max)}   ${ms(armBWallS.p50)} / ${ms(armBWallS.p99)}`,
  );
  out.push("");
  out.push("  CROSS-CHECK  (setInterval 4ms heartbeat lag)");
  out.push(
    `  A  worker OFF              p50=${ms(armAHeart.p50)}  p99=${ms(armAHeart.p99)}  max=${ms(armAHeart.max)}  (${heartbeatN(armAHeart)})`,
  );
  out.push(
    `  B  worker ON               p50=${ms(armBHeart.p50)}  p99=${ms(armBHeart.p99)}  max=${ms(armBHeart.max)}`,
  );
  out.push("");
  out.push(line);
  const deltaP99 = armALoop.p99 - armBLoop.p99;
  const deltaMax = armALoop.max - armBLoop.max;
  out.push(`  HEADLINE — event-loop lag ELIMINATED per query by the worker:`);
  out.push(
    `             p99:  ${ms(armALoop.p99)}ms (A) - ${ms(armBLoop.p99)}ms (B)  =  ${ms(deltaP99)}ms freed`,
  );
  out.push(
    `             max:  ${ms(armALoop.max)}ms (A) - ${ms(armBLoop.max)}ms (B)  =  ${ms(deltaMax)}ms freed`,
  );
  out.push("");
  out.push(
    `  GUARD 1 parity (A inline == B worker, byte-identical): ${parity.ok ? "PASS" : "FAIL — " + parity.why}`,
  );
  out.push(
    `  GUARD 2 worker used: pool.isReady=${pool.isReady}  maxInflight=${maxPoolInflight}  ` +
      `resolved=${resolved}/${QUERIES}  errors=${errors}` +
      `  ${maxPoolInflight > 0 && errors === 0 ? "(worker path exercised, no fallback)" : "(SUSPECT)"}`,
  );
  out.push(line);
  out.push("");
  process.stdout.write(out.join("\n"));

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  await pool.dispose();
  mainDb.close();
  rmSync(configDir, { recursive: true, force: true });

  const healthy = parity.ok && maxPoolInflight > 0 && errors === 0 && resolved === QUERIES;
  process.exit(healthy ? 0 : 1);
}

function col(n: number): string {
  return ms(n).padStart(8);
}
function heartbeatN(s: { max: number }): string {
  return `n heartbeat ticks recorded; max ${ms(s.max)}ms`;
}

main().catch((err) => {
  process.stderr.write(
    `\nBENCH FAILED: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
