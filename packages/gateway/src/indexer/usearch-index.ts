// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * usearch HNSW index handles — the sole vector search engine.
 *
 * Two handles, one per thread boundary:
 *   - UsearchWriteHandle: owned by the indexer worker. Mutates the
 *     index (add/remove) and persists to disk via save().
 *   - UsearchReadHandle: owned by the main thread. Opens a memory-
 *     mapped read-only view for search and re-views (mtime-gated)
 *     before each search via `maybeRefresh()`, so the writer's saves
 *     — new vectors, and re-embeds at a new dimension after an
 *     embedder swap — become visible without a gateway restart.
 *
 * Communication between threads is through the file on disk. The
 * writer saves after each batch (atomic temp-write + rename, which
 * bumps the file mtime); the reader re-views when the mtime advances
 * to pick up changes. Because `view()` adopts the dimensionality
 * stored in the file, a re-view after a dimension-changing embedder
 * swap re-dimensions the read index for free. Crash safety: orphan
 * keys in the HNSW index (writer
 * crashed before save, or SQLite committed a delete before usearch
 * remove) are harmless — the post-search JOIN to `chunks` filters
 * them out.
 */

import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createLogger } from "@omnesis/core";
import usearch from "usearch";

import { shrinkPageCacheForScan } from "./scan-page-cache.js";
import type Database from "better-sqlite3";

const { Index, MetricKind, ScalarKind } = usearch;
const log = createLogger("gateway:usearch");

const HNSW_CONNECTIVITY = 16;
const HNSW_EXPANSION_ADD = 128;
const HNSW_EXPANSION_SEARCH = 64;

/** How often a cold rebuild saves its partial graph, so a crash resumes from it. */
const DEFAULT_CHECKPOINT_INTERVAL_MS = 60_000;
/** Changed rowids re-read per catch-up batch. */
const CATCH_UP_BATCH = 1_000;

type BackfillOptions = {
  onProgress?: (fraction: number) => void;
  threads?: number;
  pageSize?: number;
  /**
   * Rebuild even when the graph and DB have the same vector count. A
   * failed save can leave a stale graph with the right cardinality.
   */
  forceRebuild?: boolean;
  /**
   * Continue a cold rebuild a checkpoint left unfinished: keep the loaded
   * graph and add the chunks after this rowid. The caller has already caught
   * the graph up on the rowids it holds (`catchUpFromChangeLog`).
   */
  resumeAfterRowid?: number;
  /** Fired when a cold rebuild discards the graph and starts from the first chunk. */
  onRebuildStart?: () => void;
  /**
   * Save the partial graph at least this often while building. Default 60 s;
   * a timed interval stretches to ten times the cost of a save, and 0 saves
   * after every page.
   */
  checkpointIntervalMs?: number;
  /** Fired after each checkpoint save, including the final one. */
  onCheckpoint?: () => void;
  /**
   * Checked after every page. True stops the build after a checkpoint, so
   * the caller can release the graph's memory and resume on a later start.
   */
  shouldStop?: () => boolean;
};

/** `skipped`: the graph already matched; `stopped`: `shouldStop` ended it early. */
export type GraphBuildOutcome = "skipped" | "complete" | "stopped";

/**
 * Native build threads for the cold HNSW backfill. Machine-derived — half the
 * cores (min 1) — so the rebuild leaves headroom: it runs at the indexer
 * worker's nice 0 and therefore competes directly with interactive search
 * rather than yielding to it. Overridable via `opts.threads` (tests) or the
 * `OMNESIS_USEARCH_BACKFILL_THREADS` env knob for operator tuning.
 */
function resolveBackfillThreads(override?: number): number {
  if (override !== undefined && override > 0) return Math.floor(override);
  const env = Number(process.env.OMNESIS_USEARCH_BACKFILL_THREADS);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

function createIndex(dimensions: number): InstanceType<typeof Index> {
  return new Index({
    dimensions,
    metric: MetricKind.Cos,
    quantization: ScalarKind.F32,
    connectivity: HNSW_CONNECTIVITY,
    expansion_add: HNSW_EXPANSION_ADD,
    expansion_search: HNSW_EXPANSION_SEARCH,
    multi: false,
  });
}

/**
 * Fully load an on-disk HNSW file to prove it is safe to open in-process.
 *
 * MUST run only inside the boot-time validation subprocess
 * (`usearch-validate-subprocess.ts`), never in the gateway process: a
 * structurally corrupt file makes the native `load()` *abort the whole
 * process* (`free(): corrupted unsorted chunks`, SIGABRT) rather than throw a
 * catchable error, so no in-process try/catch can recover. Isolating the load
 * in a subprocess lets the parent observe the abort as a signal / non-zero
 * exit and quarantine the file (see `quarantineCorruptUsearch`).
 *
 * Uses the same HNSW parameters as every other handle so the load path is
 * identical to what the worker's write handle does at boot. Throws on a
 * wrong-dimension file (a catchable condition); native corruption can abort
 * before this returns.
 */
export function validateUsearchFile(path: string, dimensions: number): void {
  // Map before loading: view() bounds the declared vector matrix against the
  // file length, whereas load() allocates from its untrusted row/column counts
  // first. Even a tiny garbage file can exhaust memory on the allocating path.
  // The reader's search probe also catches graph corruption that only trips
  // lazy traversal (such as "Linking to missing level"). Native failures still
  // require subprocess isolation; a mapped view is not a complete validator.
  const viewer = createIndex(dimensions);
  viewer.view(path);
  const viewed = viewer.dimensions();
  if (viewed !== dimensions) {
    throw new Error(`usearch file dimension ${viewed} != expected ${dimensions}`);
  }
  if (viewer.size() > 0) {
    viewer.search(new Float32Array(dimensions), 1, 0);
  }

  // Also exercise the write handle's full deserialize path: a successful
  // reader probe alone does not prove that a writable index can be loaded.
  const loader = createIndex(dimensions);
  loader.load(path);
  const loaded = loader.dimensions();
  if (loaded !== dimensions) {
    throw new Error(`usearch file dimension ${loaded} != expected ${dimensions}`);
  }
}

// ── Write handle (indexer worker) ───────────────────────────────────

export class UsearchWriteHandle {
  private index: InstanceType<typeof Index>;
  private dirty = false;
  private onSaved?: () => void;
  private detached: boolean;
  private cursor: number | null = null;

  /**
   * `detached` opens the handle without loading the graph: every mutation and
   * save is a no-op and the file on disk is left as it is. The indexer uses it
   * when the graph does not fit in memory; the changes it skips are in the
   * vector change log and reach the graph when a later start loads it.
   */
  constructor(
    private readonly path: string,
    private readonly dimensions: number,
    opts: { detached?: boolean } = {},
  ) {
    this.index = createIndex(dimensions);
    this.detached = opts.detached === true;
    if (!this.detached && existsSync(path)) {
      this.index.load(path);
      // `load()` adopts the dimension serialized in the file. If that differs
      // from the dimension this handle was opened at (a stale index left by a
      // previous embedder, e.g. after a dimension-changing model swap), every
      // add() of a correctly-dimensioned vector would throw "flattened vectors
      // must be a multiple of the dimension" and wedge the indexer. Discard the
      // stale file and start a clean empty index at the expected dimension.
      // Defense in depth: the wipe path already deletes mismatched files, but
      // this guarantees the write handle never operates against a wrong-dim
      // index no matter what left one behind.
      const loadedDim = this.index.dimensions();
      if (loadedDim !== dimensions) {
        log.warn(
          `HNSW index at ${path} has dim ${loadedDim} but embedder expects ${dimensions}; discarding stale index and rebuilding empty`,
        );
        try {
          unlinkSync(path);
        } catch {
          // file vanished — fine
        }
        this.index = createIndex(dimensions);
      } else {
        log.info(`loaded HNSW index: ${this.index.size()} vectors from ${path}`);
      }
    }
  }

  /** True once the graph is not held in memory (opened detached, or released). */
  get isDetached(): boolean {
    return this.detached;
  }

  /**
   * The last rowid an unfinished cold rebuild has added, or null when the
   * graph is complete. A save writes the graph as of this cursor, so the
   * indexer stamps it next to the save (`usearch_backfill_cursor`).
   */
  get backfillCursor(): number | null {
    return this.cursor;
  }

  /**
   * Give the graph's memory back and stop maintaining it. Unsaved changes are
   * dropped from the graph but not lost: they are in the vector change log
   * above the graph's saved position. `view()` resets the native index —
   * releasing its allocations synchronously — before mapping the file; the
   * mapping is file-backed and goes with the wrapper.
   */
  release(): void {
    if (this.detached) return;
    if (existsSync(this.path)) this.index.view(this.path);
    this.index = createIndex(this.dimensions);
    this.detached = true;
    this.dirty = false;
  }

  add(key: bigint, vector: Float32Array): void {
    if (this.detached) return;
    try {
      this.index.remove(key);
    } catch {
      // key not in index — expected for new vectors
    }
    this.index.add(key, vector);
    this.dirty = true;
  }

  addBatch(entries: Array<{ key: bigint; vector: Float32Array }>): void {
    for (const e of entries) this.add(e.key, e.vector);
  }

  remove(key: bigint): void {
    if (this.detached) return;
    try {
      this.index.remove(key);
      this.dirty = true;
    } catch {
      // key not in index
    }
  }

  removeBatch(keys: bigint[]): void {
    for (const k of keys) this.remove(k);
  }

  /**
   * Register a callback fired after every successful `save()` (i.e. after the
   * on-disk plaintext graph is committed). The indexer worker uses it to stamp
   * `usearch_saved_seq` so the encrypted sidecar's fingerprint reflects exactly
   * what the plaintext file contains, independent of the shutdown path.
   */
  setOnSaved(cb: () => void): void {
    this.onSaved = cb;
  }

  save(): void {
    if (this.detached || !this.dirty) return;
    // Atomic save: write to a temp file then rename. The reader thread
    // mmap-views the file — a non-atomic save would expose a partially-
    // written file and crash with "Linking to missing level" in the
    // HNSW graph traversal. This writes only the plaintext working copy; on
    // an encrypted install the gateway's shutdown re-materialises the durable
    // `index.usearch.enc` from it (see the boot/shutdown flow in `index.ts`).
    const tmp = `${this.path}.tmp`;
    this.index.save(tmp);
    try {
      renameSync(tmp, this.path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* best-effort cleanup */
      }
      throw err;
    }
    this.dirty = false;
    // The on-disk graph is now committed; let the worker record the seq it
    // reflects. Runs AFTER the atomic rename so the stamp can never claim more
    // than the file actually holds.
    try {
      this.onSaved?.();
    } catch (err) {
      // The graph is readable, but its durability fingerprint was not stamped.
      // Keep the handle dirty so a later save retries both the atomic snapshot
      // and the callback instead of silently leaving an encrypted sidecar stale.
      this.dirty = true;
      throw err;
    }
  }

  clear(): void {
    try {
      unlinkSync(this.path);
    } catch {
      // file may not exist
    }
    this.index = createIndex(this.dimensions);
    this.dirty = false;
    this.cursor = null;
  }

  size(): number {
    return this.index.size();
  }

  close(): void {
    // Flush the plaintext graph so the gateway's shutdown can encrypt it into
    // the durable sidecar (encrypted installs) before purging the plaintext.
    this.save();
  }

  /**
   * Backfill the HNSW index from `chunks.embedding`.
   * Reads (rowid, embedding) in pages and adds to the index.
   * Idempotent: skips if index already has vectors matching the DB count.
   */
  backfillFromDb(db: Database.Database, opts?: BackfillOptions): GraphBuildOutcome {
    return drain(this.backfillFromDbBatches(db, opts));
  }

  /**
   * Worker-safe variant of {@link backfillFromDb}. Native construction of one
   * page remains synchronous, but yielding between pages lets the worker
   * service source-deletion and shutdown messages during a long cold rebuild.
   */
  backfillFromDbCooperatively(
    db: Database.Database,
    opts?: BackfillOptions,
  ): Promise<GraphBuildOutcome> {
    return drainCooperatively(this.backfillFromDbBatches(db, opts));
  }

  /**
   * Bring a graph saved at vector-change-log position `afterSeq` up to date:
   * every rowid logged since is re-read from `chunks` and re-added with its
   * current vector, or removed when the chunk or its vector is gone. Applying a
   * change the graph already has is harmless, so a saved position that lags
   * the file only costs work. `upToRowid` limits it to the rowids an
   * unfinished rebuild covers; resuming the build adds the rest.
   */
  catchUpFromChangeLog(
    db: Database.Database,
    afterSeq: number,
    opts?: { upToRowid?: number | null; threads?: number; shouldStop?: () => boolean },
  ): Promise<"complete" | "stopped"> {
    return drainCooperatively(this.catchUpBatches(db, afterSeq, opts));
  }

  private *catchUpBatches(
    db: Database.Database,
    afterSeq: number,
    opts?: { upToRowid?: number | null; threads?: number; shouldStop?: () => boolean },
  ): Generator<void, "complete" | "stopped", void> {
    if (this.detached) return "complete";
    const upTo = opts?.upToRowid ?? null;
    // The log's schema and triggers live with the rest of index.db (db.ts).
    const rowids = db
      .prepare<[number, number | null, number | null], number>(
        `SELECT DISTINCT chunk_rowid FROM vector_changes
          WHERE seq > ? AND (? IS NULL OR chunk_rowid <= ?)
          ORDER BY chunk_rowid`,
      )
      .pluck()
      .all(afterSeq, upTo, upTo);
    if (rowids.length === 0) return "complete";
    const threads = resolveBackfillThreads(opts?.threads);
    const dim = this.dimensions;
    const startMs = Date.now();
    log.info(
      `HNSW catch-up: ${rowids.length} changed vector(s) since the last checkpoint (index has ${this.index.size()})`,
    );
    const select = db.prepare<[string], { rowid: number; embedding: Buffer }>(
      `SELECT rowid, embedding FROM chunks
        WHERE rowid IN (SELECT value FROM json_each(?)) AND embedding IS NOT NULL`,
    );
    for (let i = 0; i < rowids.length; i += CATCH_UP_BATCH) {
      const batch = rowids.slice(i, i + CATCH_UP_BATCH);
      const live = new Map<number, Buffer>();
      for (const row of select.all(JSON.stringify(batch))) {
        if (row.embedding.byteLength === dim * 4) live.set(row.rowid, row.embedding);
      }
      const keys = new BigUint64Array(live.size);
      const matrix = new Float32Array(live.size * dim);
      let n = 0;
      for (const rowid of batch) {
        const key = BigInt(rowid);
        try {
          this.index.remove(key);
        } catch {
          // not in the graph
        }
        const embedding = live.get(rowid);
        if (!embedding) continue;
        keys[n] = key;
        matrix.set(new Float32Array(embedding.buffer, embedding.byteOffset, dim), n * dim);
        n++;
      }
      if (n > 0) this.index.add(keys, matrix, threads);
      this.dirty = true;
      if (opts?.shouldStop?.()) return "stopped";
      yield;
    }
    log.info(
      `HNSW catch-up complete: ${rowids.length} vector(s) in ${Date.now() - startMs}ms (index has ${this.index.size()})`,
    );
    return "complete";
  }

  private checkpoint(opts?: BackfillOptions): void {
    this.dirty = true;
    this.save();
    opts?.onCheckpoint?.();
  }

  private *backfillFromDbBatches(
    db: Database.Database,
    opts?: BackfillOptions,
  ): Generator<void, GraphBuildOutcome, void> {
    if (this.detached) return "skipped";
    const PAGE_SIZE = opts?.pageSize ?? 5_000;
    // Build the graph with usearch's multi-threaded batch `add` instead of one
    // vector at a time. A single-vector add is ~2ms of serial native HNSW graph
    // traversal; on a six-figure corpus that is ~25 minutes. Feeding a whole
    // page as a contiguous (keys, matrix) pair with a thread count lets usearch
    // construct the graph in parallel, cutting the cold rebuild to minutes.
    //
    // Default to HALF the cores, not all of them. This runs in the indexer
    // worker, which deliberately stays at nice 0 (real-time query embedding
    // lives there), so these native build threads do NOT yield to the main
    // event loop. Leaving headroom keeps interactive search responsive during
    // the rebuild — which, under encryption-at-rest, recurs on every restart
    // because the plaintext sidecar is purged each boot. Override with
    // OMNESIS_USEARCH_BACKFILL_THREADS or opts.threads.
    const dim = this.dimensions;
    const threads = resolveBackfillThreads(opts?.threads);

    const totalRow = db
      .prepare<
        [],
        { cnt: number }
      >(`SELECT count(*) as cnt FROM chunks WHERE embedding IS NOT NULL`)
      .get();
    const totalInDb = totalRow?.cnt ?? 0;
    const currentSize = this.index.size();

    const resumeAfter = opts?.resumeAfterRowid;
    if (
      resumeAfter === undefined &&
      !opts?.forceRebuild &&
      currentSize >= totalInDb &&
      totalInDb > 0
    ) {
      log.info(`HNSW backfill skipped: index has ${currentSize} vectors, DB has ${totalInDb}`);
      opts?.onProgress?.(1);
      return "skipped";
    }

    if (resumeAfter !== undefined) {
      log.info(
        `HNSW backfill resuming after rowid ${resumeAfter}: index has ${currentSize} of ${totalInDb} vectors`,
      );
    } else {
      log.info(
        `HNSW backfill starting: ${totalInDb} vectors to add (index has ${currentSize}${opts?.forceRebuild ? ", fingerprint stale" : ""})`,
      );
      // `clear()` already deletes the sidecar and recreates an empty index at
      // the right dimension, so no separate re-alloc is needed.
      if (currentSize > 0) this.clear();
      opts?.onRebuildStart?.();
    }
    const startMs = Date.now();
    const restorePageCache = shrinkPageCacheForScan(db);

    const stmt = db.prepare<[number, number], { rowid: number; embedding: Buffer }>(
      `SELECT rowid, embedding
       FROM chunks
       WHERE embedding IS NOT NULL AND rowid > ?
       ORDER BY rowid
       LIMIT ?`,
    );

    let lastRowid = resumeAfter ?? 0;
    this.cursor = lastRowid;
    const resumedWith = resumeAfter === undefined ? 0 : currentSize;
    let added = 0;
    let nextProgressLog = 50_000;
    let checkpointEvery = opts?.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    let lastCheckpointAt = Date.now();
    while (true) {
      const rows = stmt.all(lastRowid, PAGE_SIZE);
      if (rows.length === 0) break;
      // Pack this page into a contiguous key vector + flat n*d matrix for one
      // native multi-threaded `add`. Copy (not view) each embedding into the
      // shared matrix so the whole page is one contiguous buffer usearch can
      // parallelise over. A row whose stored vector isn't `dim` floats (only
      // possible from corruption / a stale mixed-dimension row) is skipped
      // rather than allowed to misalign the matrix.
      const keys = new BigUint64Array(rows.length);
      const matrix = new Float32Array(rows.length * dim);
      let n = 0;
      for (const row of rows) {
        const floats = row.embedding.byteLength / 4;
        if (floats !== dim) {
          log.warn(
            `HNSW backfill: skipping chunk rowid=${row.rowid} — embedding has ${floats} floats, expected ${dim}`,
          );
          continue;
        }
        keys[n] = BigInt(row.rowid);
        matrix.set(
          new Float32Array(row.embedding.buffer, row.embedding.byteOffset, floats),
          n * dim,
        );
        n++;
      }
      if (n > 0) {
        const pageKeys = n === rows.length ? keys : keys.subarray(0, n);
        if (resumeAfter !== undefined) {
          // A checkpoint's file can be a page ahead of its stamped cursor (a
          // kill between the rename and the stamp), so a resumed build may meet
          // rowids the graph already holds; replace them rather than duplicate.
          const present = this.index.contains(pageKeys) as boolean[];
          for (let i = 0; i < n; i++) if (present[i]) this.index.remove(pageKeys[i]);
        }
        this.index.add(pageKeys, n === rows.length ? matrix : matrix.subarray(0, n * dim), threads);
        added += n;
      }
      lastRowid = rows[rows.length - 1].rowid;
      this.cursor = lastRowid;
      if (added >= nextProgressLog) {
        log.info(
          `HNSW backfill progress: ${resumedWith + added}/${totalInDb} (${threads} threads)`,
        );
        nextProgressLog += 50_000;
      }
      opts?.onProgress?.(totalInDb > 0 ? Math.min((resumedWith + added) / totalInDb, 1) : 1);
      if (opts?.shouldStop?.()) {
        restorePageCache();
        this.checkpoint(opts);
        log.info(
          `HNSW backfill stopped after rowid ${lastRowid}: ${resumedWith + added}/${totalInDb} vectors saved for the next start`,
        );
        return "stopped";
      }
      if (Date.now() - lastCheckpointAt >= checkpointEvery) {
        // A checkpoint rewrites the whole graph on this thread, which also
        // embeds queries; keep it to a tenth of the build's time at most.
        const savingSince = Date.now();
        this.checkpoint(opts);
        lastCheckpointAt = Date.now();
        // An explicit interval of 0 asks for a checkpoint after every page
        // (tests rely on it to kill a build at a known position); only a
        // timed interval stretches with the cost of the save.
        if (checkpointEvery > 0)
          checkpointEvery = Math.max(checkpointEvery, (lastCheckpointAt - savingSince) * 10);
      }
      // Cooperative callers yield here. Deletions that land after this page
      // remove its vectors synchronously; keyset pagination means deleting
      // rows cannot shift the next page and make unrelated rows get skipped.
      yield;
    }

    restorePageCache();
    this.cursor = null;
    this.checkpoint(opts);
    opts?.onProgress?.(1);
    log.info(
      `HNSW backfill complete: ${added} vectors in ${Date.now() - startMs}ms (${threads} threads)`,
    );
    return "complete";
  }
}

function drain<T>(steps: Generator<void, T, void>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

async function drainCooperatively<T>(steps: Generator<void, T, void>): Promise<T> {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ── Read handle (main thread) ───────────────────────────────────────

/**
 * The minimal vector read surface the search pipeline depends on:
 * `maybeRefresh()` before a search to pick up the writer's latest save,
 * then `search()`. Both {@link UsearchReadHandle} (a single file) and
 * {@link import("./usearch-read-registry.js").UsearchReadRegistry} (which
 * follows the active index generation) satisfy it, so the
 * pipeline is agnostic to whether reads route through a fixed file or the
 * versioned registry.
 */
export interface VectorReadSource {
  maybeRefresh(): void;
  search(vector: Float32Array, k: number): Array<{ key: bigint; distance: number }>;
  size(): number;
  /**
   * Embedding-model identifier of the generation this source currently serves,
   * or null when unknown (a raw single-file handle carries no generation
   * identity). The candidate-generation core compares it against the model that
   * embedded the query so a same-dimension embedder swap degrades to BM25
   * instead of returning garbage-ranked neighbours. Optional: only the
   * versioned {@link import("./usearch-read-registry.js").UsearchReadRegistry}
   * knows the active generation's model.
   */
  activeModelId?(): string | null;
}

export class UsearchReadHandle implements VectorReadSource {
  private index: InstanceType<typeof Index>;
  /**
   * Identity of the index file the current view reflects, or null when
   * nothing has been viewed yet (file absent at construction, or never
   * created). A composite of mtime + size + inode rather than mtime alone:
   * the writer rebuilds via an atomic temp-write + rename, so a swap that
   * lands in the same millisecond as the last view still changes the size
   * and/or inode and is detected. `maybeRefresh()` re-views when this moves.
   */
  private viewedSignature: string | null = null;

  private constructor(
    private path: string,
    dimensions: number,
  ) {
    // Start with an empty shell so the handle is always usable even before
    // the writer has produced an index file. `maybeRefresh()` fills it in.
    this.index = createIndex(dimensions);
    this.reload();
  }

  private fileSignature(path: string = this.path): string | null {
    try {
      const s = statSync(path);
      return `${s.mtimeMs}:${s.size}:${s.ino}`;
    } catch {
      return null;
    }
  }

  /**
   * Always returns a handle, even when the index file doesn't exist yet —
   * the handle self-fills via `maybeRefresh()` once the writer creates the
   * file. Returning a live (possibly empty) handle instead of null is what
   * lets a gateway that booted before its first index build pick up vectors
   * without a restart.
   */
  static open(path: string, dimensions: number): UsearchReadHandle {
    return new UsearchReadHandle(path, dimensions);
  }

  /**
   * Re-view the index if the file has changed since the last view. Cheap in
   * the steady state — a single `stat` whose mtime hasn't moved is a no-op.
   * Called before each vector search so the reader tracks the writer's saves
   * (new docs, and re-embeds at a new dimension after an embedder swap).
   */
  maybeRefresh(): void {
    const sig = this.fileSignature();
    // File doesn't exist yet (or vanished) — nothing to view.
    if (sig === null) return;
    if (sig === this.viewedSignature) return;
    this.reload(sig);
  }

  private reload(signature?: string): void {
    const sig = signature ?? this.fileSignature();
    if (sig === null) return;
    // Re-view IN PLACE. USearch's native view() begins by resetting the index,
    // which synchronously releases the previous mmap before it adopts the new
    // file (and the dimensionality serialized in it). Replacing this tiny JS
    // wrapper with a fresh native Index leaves the old multi-gigabyte mmap to
    // V8 finalization, whose pressure accounting cannot see mapped file pages.
    this.index.view(this.path);
    this.viewedSignature = sig;
  }

  /**
   * Follow a versioned-index generation to a different file and, potentially,
   * a different embedding dimension while retaining one native mmap owner.
   *
   * Returns false while the target file is absent, leaving the current target
   * untouched so the registry retries after the generation is published. A
   * catchable native view failure does reset the current native index; callers
   * deliberately degrade that search to BM25 and retry this same target on the
   * next request rather than retaining an unbounded old mapping.
   */
  rebind(path: string, dimensions: number): boolean {
    const signature = this.fileSignature(path);
    if (signature === null) return false;
    this.index.view(path);
    const loadedDim = this.index.dimensions();
    if (loadedDim !== dimensions) {
      throw new Error(`usearch file dimension ${loadedDim} != expected ${dimensions}`);
    }
    this.path = path;
    this.viewedSignature = signature;
    return true;
  }

  search(vector: Float32Array, k: number): Array<{ key: bigint; distance: number }> {
    const effectiveK = Math.min(k, this.index.size());
    if (effectiveK <= 0) return [];
    const results = this.index.search(vector, effectiveK, 0);
    const out: Array<{ key: bigint; distance: number }> = [];
    for (let i = 0; i < results.keys.length; i++) {
      out.push({ key: results.keys[i], distance: results.distances[i] });
    }
    return out;
  }

  /** Force a re-view regardless of mtime. */
  reopen(): void {
    this.reload();
  }

  close(): void {
    // The upstream JS binding exposes no explicit disposal method. Re-views
    // are released deterministically by reusing this.index; final shutdown
    // still relies on the native wrapper's destructor with the process/isolate.
  }

  size(): number {
    return this.index.size();
  }
}
