// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { rmSync } from "node:fs";

import Database from "better-sqlite3";

import { createLogger } from "@omnesis/core";
import { normalizeText, shingles } from "@omnesis/near-dupes";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { captureOccVersion } from "../data/occ-materialized.js";
import type { Db } from "../data/types.js";
import type { ResolvedNearDupConfig } from "./config.js";
import type { NearDupDfSnapshot } from "./types.js";

const log = createLogger("gateway:near-dupes:df");

/**
 * Compute a fresh DF snapshot for the active algo. Full scan over
 * `documents.content` for eligible types — pure-read on the main DB.
 * Held wholly in memory, so it suits a fixture or a small corpus; the
 * scheduled rebuild stages to a file instead (`ShingleDfAccumulator`) and
 * the writer applies that with `applyNearDupDfFromStaging`.
 *
 * Shingle counts are accumulated in a private `:memory:` SQLite
 * database instead of a JS Map, avoiding V8's ~16.7M-entry Map
 * limit. On large corpora (150K+ docs, 20M+ unique shingles) the
 * Map approach throws "maximum size exceeded"; the SQLite accumulator
 * handles any corpus size with bounded memory.
 *
 * Singleton shingles (df=1) are pruned — they can't contribute to
 * cross-document matches. This typically cuts the DF table by 70-90%.
 */
const MIN_DF_TO_PERSIST = 2;
const FLUSH_BATCH_SIZE = 10_000;

/**
 * Shingle document-frequency accumulator backed by a private `:memory:`
 * SQLite table rather than a JS `Map`. A `Map` caps at V8's ~16.7M-entry
 * limit and throws "Map maximum size exceeded" on large corpora (150K+ docs,
 * 20M+ unique shingles before pruning); the SQLite table is bounded only by
 * available memory and handles any corpus size.
 *
 * Shared by the single-threaded `computeNearDupDfSnapshot` and the chunked,
 * CPU-pool `nearDupDfRefreshTask` so the cross-document merge has exactly one
 * implementation and one memory profile.
 */
export class ShingleDfAccumulator {
  private readonly accum: Database.Database;
  private readonly flush: (pairs: ReadonlyArray<readonly [string, number]>) => void;
  private readonly storagePath: string | null;

  /** Accumulate in process memory. Suits a fixture or a small corpus. */
  constructor();
  /**
   * Accumulate into a file at `storagePath`, keyed with `encryptionKey`.
   *
   * A corpus produces tens of millions of distinct shingle strings before
   * pruning; in a `:memory:` database every one of them is resident,
   * bounded only by what the machine has. On a file, the page cache below
   * bounds it, and the writer reads the result by opening the same file
   * rather than being handed a copy.
   *
   * A shingle is a run of words taken verbatim from a document, so this
   * file is corpus text and belongs under the same key as the stores it
   * derives from. `null` says the install keeps those stores in the clear
   * and this one may be too — it is not a default, because writing corpus
   * text unprotected beside an encrypted database is not something to fall
   * into by omission.
   */
  constructor(storagePath: string, encryptionKey: Buffer | null);
  constructor(storagePath?: string, encryptionKey?: Buffer | null) {
    this.storagePath = storagePath ?? null;
    this.accum =
      storagePath && encryptionKey
        ? (openEncryptedSqlite(storagePath, { key: encryptionKey }) as unknown as Database.Database)
        : new Database(storagePath ?? ":memory:");
    this.accum.pragma("journal_mode = OFF");
    this.accum.pragma("synchronous = OFF");
    // No memory-mapped reads. Mapped pages of a multi-gigabyte staging file
    // count against this process's resident memory, so mapping would put
    // most of the file back into RSS — the cost that staging on disk exists
    // to avoid, and on a large corpus it is gigabytes. Nothing here needs
    // mapping: the accumulator is written once, in order, and read once by
    // the writer through its own connection.
    this.accum.pragma("mmap_size = 0");
    // A small page cache is the point — the file is the storage, not a
    // spill area for a cache that would otherwise grow to hold everything.
    this.accum.pragma("cache_size = -262144");
    // Start from an empty table whatever the file held. A staging file
    // left by an interrupted build must never be merged into the next one:
    // its counts describe a corpus state that no longer exists.
    this.accum.exec("DROP TABLE IF EXISTS df");
    this.accum.exec(`
      CREATE TABLE df (
        shingle TEXT PRIMARY KEY,
        df      INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID
    `);
    const upsert = this.accum.prepare(
      `INSERT INTO df (shingle, df) VALUES (?, ?)
       ON CONFLICT(shingle) DO UPDATE SET df = df + excluded.df`,
    );
    this.flush = this.accum.transaction((pairs: ReadonlyArray<readonly [string, number]>) => {
      for (const [shingle, count] of pairs) upsert.run(shingle, count);
    });
  }

  /** Add a batch of (shingle, document-count) pairs. */
  add(pairs: ReadonlyArray<readonly [string, number]>): void {
    if (pairs.length > 0) this.flush(pairs);
  }

  /** Total distinct shingles accumulated so far. */
  uniqueCount(): number {
    return (this.accum.prepare("SELECT COUNT(*) AS c FROM df").get() as { c: number }).c;
  }

  /** Materialize entries with `df >= minDf` (singletons pruned out). */
  entries(minDf: number): Array<{ shingle: string; df: number }> {
    const out: Array<{ shingle: string; df: number }> = [];
    const rows = this.accum
      .prepare(`SELECT shingle, df FROM df WHERE df >= ?`)
      .iterate(minDf) as Iterable<{ shingle: string; df: number }>;
    for (const r of rows) out.push(r);
    return out;
  }

  /** The file this accumulator is backed by, or null when it is in memory. */
  path(): string | null {
    return this.storagePath;
  }

  /** Total rows that would survive the `minDf` prune. */
  countAtLeast(minDf: number): number {
    return (
      this.accum
        .prepare<[number], { c: number }>("SELECT COUNT(*) AS c FROM df WHERE df >= ?")
        .get(minDf)?.c ?? 0
    );
  }

  /**
   * Make sure everything written is on the file before another connection
   * attaches it. With `journal_mode = OFF` there is no WAL to checkpoint;
   * what matters is that SQLite has flushed its own cache, which closing
   * the write connection guarantees. This stays as the explicit place that
   * intent is expressed, and as the hook if the journal mode ever changes.
   */
  checkpoint(): void {
    if (!this.storagePath) return;
    const mode = this.accum.pragma("journal_mode", { simple: true });
    if (mode === "wal") this.accum.pragma("wal_checkpoint(TRUNCATE)");
  }

  close(opts: { deleteFile?: boolean } = {}): void {
    this.accum.close();
    if (opts.deleteFile && this.storagePath) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(`${this.storagePath}${suffix}`, { force: true });
        } catch {
          // A staging file we cannot remove is disk to reclaim later, not a
          // reason to fail a completed build.
        }
      }
    }
  }
}

export function computeNearDupDfSnapshot(db: Db, config: ResolvedNearDupConfig): NearDupDfSnapshot {
  const { algorithm, eligibleDocTypes, minContentLength, maxContentLength } = config;
  const capturedVersion = captureOccVersion(db, "near_dup_df");
  const placeholders = [...eligibleDocTypes].map(() => "?").join(",");
  const rows = db
    .prepare<unknown[], { content: string }>(
      `SELECT content
         FROM documents
        WHERE LENGTH(content) BETWEEN ? AND ?
          AND json_extract(metadata, '$.documentType') IN (${placeholders})`,
    )
    .iterate(minContentLength, maxContentLength, ...eligibleDocTypes) as Iterable<{
    content: string;
  }>;

  // Accumulate DF counts in a shared SQLite-backed accumulator (avoids the
  // JS Map size cap on large corpora).
  const accum = new ShingleDfAccumulator();
  let totalDocs = 0;
  let uniqueShingles: number;
  let entries: Array<{ shingle: string; df: number }>;
  try {
    let pending: Array<[string, number]> = [];
    for (const row of rows) {
      const sh = shingles(
        normalizeText(row.content, { stripQuotes: algorithm.stripQuotes }),
        algorithm.shingleSize,
      );
      if (sh.size === 0) continue;
      totalDocs++;
      for (const s of sh) pending.push([s, 1]);

      if (pending.length >= FLUSH_BATCH_SIZE) {
        accum.add(pending);
        pending = [];
      }
    }
    accum.add(pending);

    uniqueShingles = accum.uniqueCount();
    entries = accum.entries(MIN_DF_TO_PERSIST);
  } finally {
    accum.close();
  }
  const pruned = uniqueShingles - entries.length;

  log.info(
    `DF snapshot: ${totalDocs} docs, ${uniqueShingles} unique shingles, ${entries.length} after pruning df<${MIN_DF_TO_PERSIST} (-${pruned})`,
  );

  return {
    algoVersion: algorithm.algoVersion,
    totalDocs,
    entries,
    uniqueShingles: entries.length,
    capturedVersion,
  };
}

/**
 * Capture the OCC version for the DF refresh upfront, before any
 * chunk fetching begins. Must be called once at the start of a
 * DF rebuild so all chunks share the same version baseline.
 */
export function captureDfOccVersion(db: Db): number {
  return captureOccVersion(db, "near_dup_df");
}

/**
 * Fetch a page of eligible document content for the DF pipeline.
 * IO-only — the CPU-heavy shingle extraction happens on the CPU pool.
 *
 * Paged by a keyset cursor on `documents.id`, not by OFFSET. The filter
 * involves `LENGTH(content)` and a JSON extraction, so nothing can be
 * satisfied from an index: with OFFSET, page N re-evaluates and discards
 * every qualifying row before it, which turns one pass over the corpus
 * into a quadratic one and makes the last pages of a build the most
 * expensive. A cursor resumes where the previous page ended.
 */
export function fetchDfDocChunk(
  db: Db,
  eligibleDocTypes: ReadonlySet<string>,
  minContentLength: number,
  maxContentLength: number,
  afterId: string | null,
  limit: number,
): Array<{ id: string; content: string }> {
  const placeholders = [...eligibleDocTypes].map(() => "?").join(",");
  return db
    .prepare<unknown[], { id: string; content: string }>(
      `SELECT id, content
         FROM documents
        WHERE id > ?
          AND LENGTH(content) BETWEEN ? AND ?
          AND json_extract(metadata, '$.documentType') IN (${placeholders})
        ORDER BY id
        LIMIT ?`,
    )
    .all(afterId ?? "", minContentLength, maxContentLength, ...eligibleDocTypes, limit);
}

/**
 * Has a file-like document been ingested since the DF table was built?
 *
 * Existence, not a count: the trigger only needs to know whether anything
 * arrived, and `EXISTS` stops at the first row instead of walking the
 * corpus. `ingested_at` is when this install received the document, which
 * is the question being asked — a file synced today with an old authoring
 * date still means the statistic has new material to account for.
 */
export function nearDupFileLikeDocsSince(
  db: Db,
  builtAtSec: number,
  fileLikeDocTypes: readonly string[],
): boolean {
  if (fileLikeDocTypes.length === 0) return false;
  const placeholders = fileLikeDocTypes.map(() => "?").join(",");
  const row = db
    .prepare<unknown[], { present: number }>(
      `SELECT EXISTS (
         SELECT 1 FROM documents
          WHERE json_extract(metadata, '$.documentType') IN (${placeholders})
            AND ingested_at > ?
        ) AS present`,
    )
    .get(...fileLikeDocTypes, new Date(builtAtSec * 1000).toISOString());
  return (row?.present ?? 0) === 1;
}

/**
 * Reconstruct an in-memory `DfTable` from the snapshot for the
 * io worker. The sketcher hangs onto this for the lifetime of
 * the worker until the next DF refresh applies a new snapshot.
 *
 * We expose this as a pure helper so the compute pass can be tested
 * with a fixture DF table rather than a freshly-scanned corpus.
 */
export interface InMemoryDf {
  totalDocs: number;
  df(shingle: string): number;
  size(): number;
}

/**
 * Per-handle DF cache. `WeakMap<Db, CachedDf>` instead of a
 * module-level `let` so each db handle owns its own cache — production
 * has one io-worker handle for the lifetime of the worker, tests
 * have one handle per test, no cross-handle leakage. Auto-cleared when
 * the handle is garbage-collected.
 *
 * Keyed by `algoVersion|built_at` so a fresh DF rebuild (which stamps
 * a new `built_at` via `setDfBuiltAt`) automatically invalidates the
 * cached load on the next call.
 *
 * Why caching matters: every 2-second compute tick would otherwise
 * reload ~1 M shingle entries into a fresh `Map<string, number>` —
 * ~100 MB of allocation thrash per tick that GC then has to reclaim.
 * The cache holds one snapshot across many ticks; the writer's apply
 * path triggers the bust by stamping a new `built_at`.
 */
interface CachedDf {
  key: string;
  df: InMemoryDf;
}
const dfCaches = new WeakMap<object, CachedDf>();

export function buildInMemoryDfFromTable(db: Db, algoVersion: string): InMemoryDf {
  const metaRow = db
    .prepare<
      [string],
      { total_docs: number; built_at: number | null; live_generation: number }
    >(`SELECT total_docs, built_at, live_generation FROM near_dup_df_meta WHERE algo_version = ?`)
    .get(algoVersion);
  const totalDocs = metaRow?.total_docs ?? 0;
  // Read one generation, named by the meta row. A rebuild in flight is
  // writing the next one, so what this sees is a whole table — the one
  // published by the last completed build — never a partially replaced
  // one. The generation belongs in the cache key for the same reason
  // `built_at` does: a swap is exactly when this must be rebuilt.
  const generation = metaRow?.live_generation ?? 0;
  const cacheKey = `${algoVersion}|${generation}|${metaRow?.built_at ?? "fresh"}`;
  const cached = dfCaches.get(db as unknown as object);
  if (cached?.key === cacheKey) return cached.df;

  const counts = new Map<string, number>();
  const rows = db
    .prepare<
      [string, number],
      { shingle: string; df: number }
    >(`SELECT shingle, df FROM near_dup_df WHERE algo_version = ? AND generation = ?`)
    .iterate(algoVersion, generation) as Iterable<{ shingle: string; df: number }>;
  for (const r of rows) counts.set(r.shingle, r.df);
  const df: InMemoryDf = {
    totalDocs,
    df(shingle: string): number {
      return counts.get(shingle) ?? 0;
    },
    size(): number {
      return counts.size;
    },
  };
  dfCaches.set(db as unknown as object, { key: cacheKey, df });
  return df;
}
