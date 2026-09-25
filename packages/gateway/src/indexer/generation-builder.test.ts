// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  createIndexDatabase,
  setIndexEmbedModel,
  migrateAdoptInPlaceVersion,
  createBuildingIndexVersion,
  flipActiveIndexVersion,
  cleanupStaleBuildingState,
  getActiveIndexVersion,
  getBuildableDocumentCount,
  getIndexGenerationStatus,
  getIndexVersion,
  getBuildingEmbeddingCount,
  getIndexedDocumentCount,
  nextIndexVersion,
  setIndexVersionProgress,
  upsertBuildingEmbeddings,
  upsertChunks,
  usearchPathForVersion,
  type ChunkUpsertInput,
} from "./db.js";
import { BuildAbortedError, GenerationBuilder } from "./generation-builder.js";
import { UsearchWriteHandle } from "./usearch-index.js";
import { UsearchReadRegistry } from "./usearch-read-registry.js";
import type { Embedder } from "./types.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

let db: Db;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gen-builder-"));
  db = createIndexDatabase(join(dir, "index.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Deterministic unit-normalized embedding of `dim` seeded from `val`. */
function makeEmbedding(val: number, dim: number): Float32Array {
  const arr = new Float32Array(dim);
  let s = (val * 0x9e3779b9) >>> 0;
  for (let i = 0; i < dim; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    arr[i] = (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += arr[i] * arr[i];
  const norm = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) arr[i] /= norm;
  return arr;
}

/**
 * A chunk whose body carries its ordinal `i`. The mock embedder below recovers
 * `i` from the embedding input, so a query for ordinal `k` resolves to this
 * chunk's row in BOTH the old and the new generation regardless of dimension.
 */
function makeChunk(i: number, dim: number): ChunkUpsertInput {
  return {
    id: `chunk-${i}`,
    documentId: `doc-${i}`,
    chunkIndex: 0,
    content: `synthetic content ${i}`,
    embedding: makeEmbedding(i, dim),
    sourceId: "demo-source",
    documentType: "note",
    title: `Document ${i}`,
    sourceCreatedAt: "2026-01-01T00:00:00.000Z",
    author: "Maya Reeves",
  };
}

/** Embedder that maps an input string to a deterministic vector of `dim`,
 *  keyed on the ordinal embedded in the chunk body. Optionally gated so a test
 *  can observe the system mid-build. */
function ordinalEmbedder(dim: number, gate?: Promise<void>, onFirstCall?: () => void): Embedder {
  let firstCallFired = false;
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (!firstCallFired) {
        firstCallFired = true;
        onFirstCall?.();
      }
      if (gate) await gate;
      return texts.map((t) => {
        const m = t.match(/synthetic content (\d+)/);
        const val = m ? Number(m[1]) : 0;
        return makeEmbedding(val, dim);
      });
    },
    async embedQuery(query: string): Promise<Float32Array> {
      const m = query.match(/(\d+)/);
      return makeEmbedding(m ? Number(m[1]) : 0, dim);
    },
    async dispose(): Promise<void> {},
  };
}

/** Wraps {@link ordinalEmbedder} with a counter of how many texts it embedded —
 *  the honest proof that resume continues "from where it left off, not zero". */
function countingOrdinalEmbedder(dim: number): {
  embedder: Embedder;
  embeddedCount: () => number;
} {
  let count = 0;
  const base = ordinalEmbedder(dim);
  return {
    embedder: {
      async embed(texts: string[]): Promise<Float32Array[]> {
        count += texts.length;
        return base.embed(texts);
      },
      embedQuery: (q: string) => base.embedQuery(q),
      dispose: () => base.dispose(),
    },
    embeddedCount: () => count,
  };
}

const DIM_A = 64;
const DIM_B = 128;
const N = 8;

/** Seed an active generation-1 index (dim A) over N chunks. */
function seedGeneration1(): void {
  const chunks: ChunkUpsertInput[] = [];
  for (let i = 1; i <= N; i++) chunks.push(makeChunk(i, DIM_A));
  upsertChunks(db, chunks);
  setIndexEmbedModel(db, "old-embedder", DIM_A);
  migrateAdoptInPlaceVersion(db);
  // Build generation 1's usearch from chunks.embedding (keyed by rowid).
  const writer = new UsearchWriteHandle(usearchPathForVersion(dir, 1), DIM_A);
  writer.backfillFromDb(db);
  writer.close();
}

describe("GenerationBuilder + atomic flip (headline: graceful swap keeps vector search live)", () => {
  test("active generation serves throughout the rebuild, new generation serves after the flip — no restart", async () => {
    seedGeneration1();

    // One long-lived read registry — the search read path. NEVER reconstructed
    // below: proving the swap needs no gateway restart.
    const registry = new UsearchReadRegistry(db, dir);
    registry.maybeRefresh();
    expect(registry.size()).toBe(N);
    // Generation 1 (dim A) answers a dim-A query for ordinal 3 with row 3.
    expect(registry.search(makeEmbedding(3, DIM_A), 1)[0]?.key).toBe(3n);

    // Begin a graceful build of generation 2 under a different-dimension model,
    // gated so we can inspect the system mid-rebuild.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstCall!: () => void;
    const buildStarted = new Promise<void>((r) => (firstCall = r));
    const embedder = ordinalEmbedder(DIM_B, gate, firstCall);

    const newVersion = nextIndexVersion(db);
    expect(newVersion).toBe(2);
    createBuildingIndexVersion(db, {
      version: newVersion,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });
    const builder = new GenerationBuilder(db, dir, newVersion, embedder, DIM_B);
    const buildPromise = builder.build();

    // ── DURING the rebuild ───────────────────────────────────────────────
    await buildStarted;
    registry.maybeRefresh();
    // The active pointer has NOT moved; the registry still serves generation 1.
    expect(getActiveIndexVersion(db)).toBe(1);
    expect(registry.size()).toBe(N);
    // Vector search STILL returns the old generation's candidates — never
    // BM25-only, never empty.
    expect(registry.search(makeEmbedding(3, DIM_A), 1)[0]?.key).toBe(3n);
    // Both generation files coexist (bounded to two).
    expect(existsSync(usearchPathForVersion(dir, 1))).toBe(true);

    // ── Finish the build + atomic flip ───────────────────────────────────
    release();
    await buildPromise;

    flipActiveIndexVersion(db, {
      newVersion,
      oldVersion: 1,
      embedModel: "new-embedder",
      embedDim: DIM_B,
    });
    // Retire generation 1's file (the lifecycle does this post-flip).
    rmSync(usearchPathForVersion(dir, 1), { force: true });

    // ── AFTER the flip — SAME registry instance, no restart ──────────────
    registry.maybeRefresh();
    expect(getActiveIndexVersion(db)).toBe(2);
    expect(registry.size()).toBe(N);
    // Generation 2 (dim B) now answers a dim-B query for ordinal 3 with row 3.
    expect(registry.search(makeEmbedding(3, DIM_B), 1)[0]?.key).toBe(3n);

    // Bounded to two → exactly one generation file remains on disk.
    expect(existsSync(usearchPathForVersion(dir, 1))).toBe(false);
    expect(existsSync(usearchPathForVersion(dir, 2))).toBe(true);

    // Version bookkeeping + cleanup.
    expect(getIndexVersion(db, 1)?.state).toBe("retired");
    expect(getIndexVersion(db, 2)?.state).toBe("active");
    expect(getBuildingEmbeddingCount(db)).toBe(0);

    // chunks.embedding was promoted to the new dimension (restart-consistent).
    const row = db
      .prepare<[], { embedding: Buffer }>("SELECT embedding FROM chunks WHERE rowid = 3")
      .get();
    expect(row?.embedding.byteLength).toBe(DIM_B * 4);
  });

  test("docs_built reaches docs_total exactly at completion — honest 100%, no clamp (epic #1011)", async () => {
    seedGeneration1();

    // Seed the building row with the SAME denominator the builder uses
    // (distinct documents over chunks), as production does
    // (`createBuildingIndexVersion` → `getBuildableDocumentCount`).
    const docsTotal = getBuildableDocumentCount(db);
    expect(docsTotal).toBe(N);

    const newVersion = nextIndexVersion(db);
    createBuildingIndexVersion(db, {
      version: newVersion,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal,
    });
    await new GenerationBuilder(db, dir, newVersion, ordinalEmbedder(DIM_B), DIM_B).build();

    // The building generation's status reads exactly 100% with docsBuilt ===
    // docsTotal — the percentage is honest end-to-end, not merely clamped.
    const status = getIndexGenerationStatus(db);
    expect(status.building).not.toBeNull();
    expect(status.building?.docsBuilt).toBe(N);
    expect(status.building?.docsTotal).toBe(N);
    expect(status.building?.percent).toBe(100);

    // Same denominator both ways: the row's raw docs_built equals docs_total, so
    // 100% holds without the [0,100] clamp ever engaging.
    const row = getIndexVersion(db, newVersion);
    expect(row?.docs_built).toBe(row?.docs_total);
    expect(row?.docs_built).toBe(N);
  });

  test("a build does not touch the active generation's vectors or content", async () => {
    seedGeneration1();
    const beforeEmb = db
      .prepare<[], { embedding: Buffer }>("SELECT embedding FROM chunks WHERE rowid = 1")
      .get();
    expect(beforeEmb?.embedding.byteLength).toBe(DIM_A * 4);

    createBuildingIndexVersion(db, {
      version: 2,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });
    await new GenerationBuilder(db, dir, 2, ordinalEmbedder(DIM_B), DIM_B).build();

    // chunks.embedding is UNCHANGED (still old dim) — the build staged into the
    // scratch table only; the active generation is intact until the flip.
    const afterEmb = db
      .prepare<[], { embedding: Buffer }>("SELECT embedding FROM chunks WHERE rowid = 1")
      .get();
    expect(afterEmb?.embedding.byteLength).toBe(DIM_A * 4);
    expect(getBuildingEmbeddingCount(db)).toBe(N);
    expect(getActiveIndexVersion(db)).toBe(1);
  });
});

describe("GenerationBuilder.catchUp (mid-rebuild ingest fan-out)", () => {
  test("a document ingested during a rebuild is searchable in the new generation immediately after the flip — and a deleted one does not resurrect", async () => {
    seedGeneration1(); // generation 1 (dim A) over rowids 1..N
    const registry = new UsearchReadRegistry(db, dir);
    registry.maybeRefresh();
    expect(registry.size()).toBe(N);

    const newVersion = nextIndexVersion(db);
    createBuildingIndexVersion(db, {
      version: newVersion,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });
    const builder = new GenerationBuilder(db, dir, newVersion, ordinalEmbedder(DIM_B), DIM_B);

    // Main pass over the snapshot of N chunks (worker would be running here).
    await builder.build();
    expect(getBuildingEmbeddingCount(db)).toBe(N);

    // ── Simulate ingest DURING the rebuild: the still-live worker chunked +
    //    embedded a new doc into the ACTIVE generation (chunks + old-dim
    //    embedding). It is NOT yet in the building generation.
    upsertChunks(db, [makeChunk(99, DIM_A)]);
    const newRowid = BigInt(
      db
        .prepare<[], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = 'doc-99'")
        .get()!.rowid,
    );
    // ── Simulate a doc DELETED during the rebuild (rowid 5, staged by build).
    const deletedRowid = 5n;
    db.prepare("DELETE FROM chunks WHERE document_id = ?").run("doc-5");

    // ── Pre-flip fan-out catch-up (caller runs this AFTER quiescing ingest).
    const res = await builder.catchUp();
    expect(res.added).toBe(1); // doc-99
    expect(res.removed).toBe(1); // doc-5
    // Building now covers exactly the live corpus: N - 1 deleted + 1 added.
    expect(getBuildingEmbeddingCount(db)).toBe(N);

    // ── Atomic flip (the lifecycle promotes + moves the pointer here).
    flipActiveIndexVersion(db, {
      newVersion,
      oldVersion: 1,
      embedModel: "new-embedder",
      embedDim: DIM_B,
    });
    rmSync(usearchPathForVersion(dir, 1), { force: true });

    // ── AFTER the flip — same registry, no restart.
    registry.maybeRefresh();
    expect(getActiveIndexVersion(db)).toBe(2);
    expect(registry.size()).toBe(N);

    // The mid-rebuild document is searchable in the NEW generation immediately.
    expect(registry.search(makeEmbedding(99, DIM_B), 1)[0]?.key).toBe(newRowid);

    // The deleted document does NOT resurrect — its rowid is absent from the
    // new generation entirely.
    const keys = registry.search(makeEmbedding(5, DIM_B), N).map((r) => r.key);
    expect(keys).not.toContain(deletedRowid);

    // chunks.embedding for the late arrival was promoted to the new dimension.
    const promoted = db
      .prepare<
        [],
        { embedding: Buffer }
      >("SELECT embedding FROM chunks WHERE document_id = 'doc-99'")
      .get();
    expect(promoted?.embedding.byteLength).toBe(DIM_B * 4);
    // No staged orphans linger after the flip.
    expect(getBuildingEmbeddingCount(db)).toBe(0);
  });

  test("catch-up is a no-op when nothing changed since the main pass", async () => {
    seedGeneration1();
    createBuildingIndexVersion(db, {
      version: 2,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });
    const builder = new GenerationBuilder(db, dir, 2, ordinalEmbedder(DIM_B), DIM_B);
    await builder.build();

    const res = await builder.catchUp();
    expect(res.added).toBe(0);
    expect(res.removed).toBe(0);
    expect(getBuildingEmbeddingCount(db)).toBe(N);
  });
});

describe("abandon-in-flight (cooperative cancellation, bounded-to-two)", () => {
  test("build() throws BuildAbortedError when its signal aborts mid-pass and never touches the active generation", async () => {
    seedGeneration1();
    const beforeActive = db
      .prepare<[], { embedding: Buffer }>("SELECT embedding FROM chunks WHERE rowid = 1")
      .get();
    expect(beforeActive?.embedding.byteLength).toBe(DIM_A * 4);

    createBuildingIndexVersion(db, {
      version: 2,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstCall!: () => void;
    const buildStarted = new Promise<void>((r) => (firstCall = r));
    const ac = new AbortController();
    const builder = new GenerationBuilder(
      db,
      dir,
      2,
      ordinalEmbedder(DIM_B, gate, firstCall),
      DIM_B,
      {
        signal: ac.signal,
      },
    );

    const buildPromise = builder.build();
    await buildStarted; // the build is parked in embed()
    ac.abort(); // a newer swap arrives → abandon
    release();

    await expect(buildPromise).rejects.toBeInstanceOf(BuildAbortedError);

    // The active generation (gen 1) is byte-for-byte intact — abandon never
    // promotes or mutates chunks.embedding.
    expect(getActiveIndexVersion(db)).toBe(1);
    const afterActive = db
      .prepare<[], { embedding: Buffer }>("SELECT embedding FROM chunks WHERE rowid = 1")
      .get();
    expect(afterActive?.embedding.byteLength).toBe(DIM_A * 4);

    // cleanupStaleBuildingState drops the abandoned generation's file + staging.
    cleanupStaleBuildingState(db, join(dir, "index.db"));
    expect(existsSync(usearchPathForVersion(dir, 2))).toBe(false);
    expect(getBuildingEmbeddingCount(db)).toBe(0);
    expect(getIndexVersion(db, 2)?.state).toBe("retired");
  });

  test("catchUp() throws BuildAbortedError when its signal aborts mid-pass", async () => {
    seedGeneration1();
    createBuildingIndexVersion(db, {
      version: 2,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstCall!: () => void;
    const started = new Promise<void>((r) => (firstCall = r));
    const ac = new AbortController();
    const builder = new GenerationBuilder(
      db,
      dir,
      2,
      ordinalEmbedder(DIM_B, gate, firstCall),
      DIM_B,
      {
        signal: ac.signal,
      },
    );

    // catchUp embeds the as-yet-unstaged chunks; gate the first embed so we can
    // abort mid-pass before any flip could occur.
    const catchUpPromise = builder.catchUp();
    await started;
    ac.abort();
    release();

    await expect(catchUpPromise).rejects.toBeInstanceOf(BuildAbortedError);
    expect(getActiveIndexVersion(db)).toBe(1);
  });
});

describe("cleanupStaleBuildingState (crash defense)", () => {
  test("retires a dangling building generation and drops its file + staged vectors", async () => {
    seedGeneration1();
    createBuildingIndexVersion(db, {
      version: 2,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });
    // Simulate a crash mid-build: a partial generation-2 file + staged vectors.
    await new GenerationBuilder(db, dir, 2, ordinalEmbedder(DIM_B), DIM_B).build();
    expect(existsSync(usearchPathForVersion(dir, 2))).toBe(true);
    expect(getBuildingEmbeddingCount(db)).toBe(N);

    cleanupStaleBuildingState(db, join(dir, "index.db"));

    // The active generation is untouched; the building one is gone.
    expect(getActiveIndexVersion(db)).toBe(1);
    expect(getIndexVersion(db, 1)?.state).toBe("active");
    expect(getIndexVersion(db, 2)?.state).toBe("retired");
    expect(existsSync(usearchPathForVersion(dir, 2))).toBe(false);
    expect(getBuildingEmbeddingCount(db)).toBe(0);
  });

  test("is a no-op with no building generation", () => {
    seedGeneration1();
    cleanupStaleBuildingState(db, join(dir, "index.db"));
    expect(getActiveIndexVersion(db)).toBe(1);
    expect(existsSync(usearchPathForVersion(dir, 1))).toBe(true);
  });
});

describe("GenerationBuilder.resume (crash-safe resume)", () => {
  /** Stage the first `k` chunks under the new model, as a crash mid-build would
   *  leave them: committed to the durable staging table + progress recorded. */
  function stagePartial(version: number, k: number): void {
    const staged: Array<{ chunkRowid: number; embedding: Float32Array }> = [];
    for (let rowid = 1; rowid <= k; rowid++) {
      staged.push({ chunkRowid: rowid, embedding: makeEmbedding(rowid, DIM_B) });
    }
    upsertBuildingEmbeddings(db, staged);
    setIndexVersionProgress(db, version, k);
  }

  test("resumes from staged progress — embeds ONLY the remaining chunks, not the whole corpus", async () => {
    seedGeneration1(); // generation 1 (dim A) over rowids 1..N, active
    const newVersion = nextIndexVersion(db); // 2
    createBuildingIndexVersion(db, {
      version: newVersion,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });

    // Crash mid-build: the first K chunks were embedded + durably staged.
    const K = 5;
    stagePartial(newVersion, K);
    expect(getBuildingEmbeddingCount(db)).toBe(K);

    // Resume with a COUNTING embedder.
    const { embedder, embeddedCount } = countingOrdinalEmbedder(DIM_B);
    const res = await new GenerationBuilder(db, dir, newVersion, embedder, DIM_B).resume();

    // Only the remaining N - K chunks were embedded — NOT all N (not from zero).
    expect(embeddedCount()).toBe(N - K);
    expect(res.added).toBe(N - K);
    // The building generation now covers the whole corpus.
    expect(getBuildingEmbeddingCount(db)).toBe(N);

    // Flip + verify search serves the resumed generation and finds every doc —
    // both a chunk that was pre-staged (ordinal 2) and one freshly resumed (8).
    flipActiveIndexVersion(db, {
      newVersion,
      oldVersion: 1,
      embedModel: "new-embedder",
      embedDim: DIM_B,
    });
    rmSync(usearchPathForVersion(dir, 1), { force: true });
    const registry = new UsearchReadRegistry(db, dir);
    registry.maybeRefresh();
    expect(getActiveIndexVersion(db)).toBe(2);
    expect(registry.size()).toBe(N);
    expect(registry.search(makeEmbedding(8, DIM_B), 1)[0]?.key).toBe(8n); // resumed
    expect(registry.search(makeEmbedding(2, DIM_B), 1)[0]?.key).toBe(2n); // pre-staged
  });

  test("a document ingested during the crash window is embedded on resume and present after the flip", async () => {
    seedGeneration1();
    const newVersion = nextIndexVersion(db);
    createBuildingIndexVersion(db, {
      version: newVersion,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });
    stagePartial(newVersion, 3);

    // A doc the still-live worker chunked into the ACTIVE generation after the
    // crash point — present in `chunks` (old dim), absent from staging.
    upsertChunks(db, [makeChunk(99, DIM_A)]);
    const newRowid = BigInt(
      db
        .prepare<[], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = 'doc-99'")
        .get()!.rowid,
    );

    const { embedder, embeddedCount } = countingOrdinalEmbedder(DIM_B);
    const res = await new GenerationBuilder(db, dir, newVersion, embedder, DIM_B).resume();
    // Remaining originals (N - 3) plus the mid-crash doc.
    expect(embeddedCount()).toBe(N - 3 + 1);
    expect(res.added).toBe(N - 3 + 1);
    expect(getBuildingEmbeddingCount(db)).toBe(N + 1);

    flipActiveIndexVersion(db, {
      newVersion,
      oldVersion: 1,
      embedModel: "new-embedder",
      embedDim: DIM_B,
    });
    rmSync(usearchPathForVersion(dir, 1), { force: true });
    const registry = new UsearchReadRegistry(db, dir);
    registry.maybeRefresh();
    expect(getActiveIndexVersion(db)).toBe(2);
    // The mid-crash document is searchable in the resumed generation.
    expect(registry.search(makeEmbedding(99, DIM_B), 1)[0]?.key).toBe(newRowid);
  });

  test("rebuilds a torn usearch file from staging — corrupt-file recovery (never re-embeds)", async () => {
    seedGeneration1();
    const newVersion = nextIndexVersion(db);
    createBuildingIndexVersion(db, {
      version: newVersion,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });
    // All N chunks were embedded + staged, but the crash left a garbage usearch
    // file (a torn atomic save). The staging table is intact.
    stagePartial(newVersion, N);
    writeFileSync(usearchPathForVersion(dir, newVersion), "not-a-real-usearch-file");

    const { embedder, embeddedCount } = countingOrdinalEmbedder(DIM_B);
    const res = await new GenerationBuilder(db, dir, newVersion, embedder, DIM_B).resume();
    // Nothing left to embed (all staged) — resume rebuilds the file from staging
    // with ZERO embed calls.
    expect(embeddedCount()).toBe(0);
    expect(res.added).toBe(0);

    flipActiveIndexVersion(db, {
      newVersion,
      oldVersion: 1,
      embedModel: "new-embedder",
      embedDim: DIM_B,
    });
    rmSync(usearchPathForVersion(dir, 1), { force: true });
    const registry = new UsearchReadRegistry(db, dir);
    registry.maybeRefresh();
    expect(getActiveIndexVersion(db)).toBe(2);
    expect(registry.size()).toBe(N);
    expect(registry.search(makeEmbedding(4, DIM_B), 1)[0]?.key).toBe(4n);
  });

  test("re-entrant: a second crash mid-resume resumes again rather than restarting from zero", async () => {
    seedGeneration1();
    const newVersion = nextIndexVersion(db);
    createBuildingIndexVersion(db, {
      version: newVersion,
      embedModel: "new-embedder",
      embedDim: DIM_B,
      docsTotal: getIndexedDocumentCount(db),
    });
    // First crash left 3 of N staged.
    stagePartial(newVersion, 3);

    // First resume attempt is interrupted partway (a second crash): emulate it by
    // staging two more chunks (4, 5) — the durable progress a partial resume left.
    upsertBuildingEmbeddings(db, [
      { chunkRowid: 4, embedding: makeEmbedding(4, DIM_B) },
      { chunkRowid: 5, embedding: makeEmbedding(5, DIM_B) },
    ]);
    expect(getBuildingEmbeddingCount(db)).toBe(5);

    // Second resume continues from 5 — embeds only the final N - 5.
    const { embedder, embeddedCount } = countingOrdinalEmbedder(DIM_B);
    const res = await new GenerationBuilder(db, dir, newVersion, embedder, DIM_B).resume();
    expect(embeddedCount()).toBe(N - 5);
    expect(res.added).toBe(N - 5);
    expect(getBuildingEmbeddingCount(db)).toBe(N);
  });
});
