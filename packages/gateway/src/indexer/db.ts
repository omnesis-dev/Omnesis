// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Index database — stores chunks, embeddings, FTS, and indexer state.
 * Single SQLite file at ~/.config/omnesis/index.db.
 */

import { readdirSync, rmSync, unlinkSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
type Db = Database.Database;
import { createLogger } from "@omnesis/core";
import { openEncryptedSqlite } from "../sqlite-encryption.js";
import { buildEmbeddingPreamble } from "./embedding-input.js";

const log = createLogger("indexer:db");

/**
 * Dimension of embedding vectors. Hardcoded to match
 * nomic-embed-text-v1.5 (the indexer's embedding model). A model change
 * would need a full reindex.
 */
export const EMBEDDING_DIM = 768;

export interface IndexedDocumentRow {
  document_id: string;
  content_hash: string;
  chunk_count: number;
  indexed_at: string;
  /** 1 on first index; increments on every subsequent re-index. */
  index_version: number;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  source_id: string;
  document_type: string | null;
  title: string;
  source_url: string | null;
  source_created_at: string;
  author: string | null;
  tags: string | null; // JSON array
  relevance_score: number | null;
}

// ── Index DB connection opener ────────────────────────────────────────

export interface OpenIndexDbOptions {
  readonly?: boolean;
  skipWal?: boolean;
  mmapBytes?: number;
  cacheSizeBytes?: number;
  encryptionKey?: Buffer | null;
  migratePlaintext?: boolean;
}

export function openIndexDb(path: string, opts: OpenIndexDbOptions = {}): Db {
  const db = opts.encryptionKey
    ? (openEncryptedSqlite(path, {
        key: opts.encryptionKey,
        readonly: opts.readonly === true,
        fileMustExist: opts.readonly === true,
        migratePlaintext: opts.migratePlaintext ?? opts.readonly !== true,
      }) as unknown as Db)
    : opts.readonly
      ? new Database(path, { readonly: true })
      : new Database(path);
  if (!opts.skipWal && !opts.readonly) {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (opts.readonly) {
    let mmapBytes = opts.mmapBytes;
    const envOverride = process.env.OMNESIS_INDEX_MMAP_BYTES;
    if (envOverride && /^\d+$/.test(envOverride)) {
      mmapBytes = Number(envOverride);
    }
    db.exec(`PRAGMA mmap_size = ${mmapBytes ?? 0}`);
  } else {
    db.exec("PRAGMA mmap_size = 0");
  }
  const cacheBytes = opts.cacheSizeBytes ?? 1024 * 1024 * 1024;
  const cacheKib = Math.max(2, Math.floor(cacheBytes / 1024));
  db.exec(`PRAGMA cache_size = -${cacheKib}`);
  return db;
}

// ── Schema creation ──────────────────────────────────────────────────

/** Add a column if the table doesn't already have it (idempotent migration). */
function ensureColumn(db: Db, table: string, column: string, ddl: string): void {
  const cols = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function createIndexDatabase(path: string, opts: OpenIndexDbOptions = {}): Db {
  const db = openIndexDb(path, opts);

  const hadChunksFts =
    db
      .prepare<
        [],
        { present: number }
      >("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'chunks_fts'")
      .get()?.present === 1;
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_id TEXT NOT NULL,
      document_type TEXT,
      title TEXT NOT NULL,
      source_url TEXT,
      source_created_at TEXT NOT NULL,
      author TEXT,
      tags TEXT,
      relevance_score REAL,
      embedding BLOB,
      UNIQUE(document_id, chunk_index)
    )
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(document_type)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_date ON chunks(source_created_at)");

  // Queue of chunk rowids whose HNSW vectors still need removing. The HTTP
  // delete cascade runs on the main thread, which holds only a *read*
  // handle on usearch, so it can't remove vectors itself — it enqueues the
  // rowids here and the indexer worker (which owns the write handle) drains
  // them each cycle. Without this, HTTP-side deletes orphan vectors
  // permanently (their indexed_documents tracking is gone, so
  // reconcileDeletedDocuments can't find them) and a large resync bloats
  // the index until OOM. See #553.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_vector_deletes (
      chunk_rowid INTEGER PRIMARY KEY,
      generation INTEGER NOT NULL DEFAULT 1
    )
  `);
  ensureColumn(db, "pending_vector_deletes", "generation", "generation INTEGER NOT NULL DEFAULT 1");

  // Durable source-wide purge obligations. A source delete may arrive while
  // the worker is embedding a page it read earlier, so the worker acknowledges
  // the immediate delete and re-applies it after the page settles. Persisting
  // that obligation prevents a shutdown or crash between those two points from
  // losing the privacy cleanup.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_source_index_purges (
      source_id TEXT PRIMARY KEY,
      queued_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_document_index_purges (
      document_id TEXT PRIMARY KEY,
      source_deleted INTEGER NOT NULL DEFAULT 0,
      queued_at INTEGER NOT NULL
    )
  `);

  // FTS5 for BM25 search (populated alongside chunks via triggers).
  //
  // Tokenizer: `porter unicode61 remove_diacritics 2` —
  //   * Porter stemming so `recipe` matches `recipes`, `wedding` matches
  //     `weddings`, `wrote` matches `write` (English morphological folding).
  //   * `unicode61` is the SQLite default Unicode-aware tokenizer.
  //   * `remove_diacritics 2` folds accented characters to ASCII so
  //     `ceremonie` matches `cérémonie` regardless of which side carries
  //     the accent.
  //
  // The `IF NOT EXISTS` clause means this only fires on fresh DBs.
  // Existing installs keep their old `unicode61`-bare tokenizer until
  // the rebuild migration below detects + re-creates the table.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      title,
      content='chunks',
      content_rowid='rowid',
      tokenize='porter unicode61 remove_diacritics 2'
    )
  `);

  // FTS5 vocabulary table for document-frequency lookups. Used by the
  // search pipeline to detect high-frequency tokens that would cause
  // slow BM25 scans and skip them from the MATCH query.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_vocab
      USING fts5vocab(chunks_fts, 'row')
  `);

  // FTS sync triggers
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, title)
      VALUES (new.rowid, new.content, new.title);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, title)
      VALUES ('delete', old.rowid, old.content, old.title);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, title)
      VALUES ('delete', old.rowid, old.content, old.title);
      INSERT INTO chunks_fts(rowid, content, title)
      VALUES (new.rowid, new.content, new.title);
    END
  `);

  // One-shot FTS5 tokenizer migration. Older installs were created with
  // a bare `unicode61` tokenizer (no Porter stemming, no diacritic
  // folding), so `recipe` didn't match `recipes` and `ceremonie` didn't
  // match `cérémonie`. The CREATE above no-ops on existing DBs because
  // of `IF NOT EXISTS`, so we explicitly check the stored DDL and
  // rebuild the FTS index when the tokenizer string lacks `porter`.
  // The `'rebuild'` magic on a contentless/external-content FTS5 table
  // repopulates from the source `chunks` table, so the index is
  // re-tokenized end-to-end. Idempotent: a second boot finds `porter`
  // already in the stored SQL and no-ops.
  const ftsDdl = db
    .prepare<[], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'chunks_fts'")
    .get();
  if (ftsDdl && !ftsDdl.sql.includes("porter")) {
    log.info("Migrating chunks_fts to porter+diacritic-folding tokenizer — rebuilding FTS index");
    db.exec("DROP TABLE chunks_fts");
    db.exec(`
      CREATE VIRTUAL TABLE chunks_fts USING fts5(
        content,
        title,
        content='chunks',
        content_rowid='rowid',
        tokenize='porter unicode61 remove_diacritics 2'
      )
    `);
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    log.info("chunks_fts rebuild complete");
  } else if (!hadChunksFts) {
    // A sanitized or restored database can contain external-content rows while
    // intentionally omitting FTS5's implementation-private shadow tables.
    // Populate the newly created index once so its first boot is searchable.
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
  }

  // Indexer state: which gateway documents have been indexed
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_documents (
      document_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      chunk_count INTEGER NOT NULL,
      indexed_at TEXT NOT NULL,
      source_event_at TEXT NOT NULL DEFAULT '',
      event_indexed_at TEXT NOT NULL DEFAULT '',
      index_version INTEGER NOT NULL DEFAULT 1
    )
  `);
  // Existing index databases predate the event-kind marker. Their current
  // rows are the first observed version; the next UPSERT increments to 2.
  ensureColumn(
    db,
    "indexed_documents",
    "index_version",
    "index_version INTEGER NOT NULL DEFAULT 1",
  );
  ensureColumn(
    db,
    "indexed_documents",
    "source_event_at",
    "source_event_at TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(
    db,
    "indexed_documents",
    "event_indexed_at",
    "event_indexed_at TEXT NOT NULL DEFAULT ''",
  );
  db.exec("UPDATE indexed_documents SET event_indexed_at = indexed_at WHERE event_indexed_at = ''");
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_indexed_documents_event ON indexed_documents(event_indexed_at, document_id)",
  );

  // Watermarks
  db.exec(`
    CREATE TABLE IF NOT EXISTS watermark (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Materialized per-source index stats. `getIndexStatsBySource` (which
  // the portal's Index view calls on every load) does
  // `SELECT source_id, COUNT(DISTINCT document_id), COUNT(*) FROM chunks
  //  GROUP BY source_id` — a ~14s scan at 260k chunks. We cache it here
  // and recompute from the indexer worker after each cycle. Staleness
  // bound == 1 indexer cycle (default 30s), which is fine for a stats
  // display.
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_index_stats (
      source_id TEXT PRIMARY KEY,
      indexed_docs INTEGER NOT NULL DEFAULT 0,
      chunks INTEGER NOT NULL DEFAULT 0,
      earliest_source_date TEXT,
      latest_source_date TEXT,
      last_computed_at TEXT
    )
  `);

  // Single-row totals so /index/stats can skip SELECT COUNT(*) full scans.
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_totals (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_indexed INTEGER NOT NULL DEFAULT 0,
      total_chunks INTEGER NOT NULL DEFAULT 0,
      last_computed_at TEXT
    )
  `);

  // Per-document indexing outcomes that are not a clean full index. Two
  // severities share this table:
  //   - 'error'    — the document threw and is not indexed (transient or
  //                  unrecognised failure); it stays pending for retry.
  //   - 'degraded' — the document IS indexed, but some chunks were truncated
  //                  to fit the embedder's token window or dropped because
  //                  they were unembeddable. `truncated_chunks`/`dropped_chunks`
  //                  carry the per-doc counts for the /index/stats aggregate.
  // In-memory retry sets don't survive a gateway restart, so without this a
  // doc that fails once would never appear anywhere until someone diffed
  // gateway vs index by hand. Rows are cleared on successful (full) index and
  // on reconcile-delete; a degraded row is re-written right after the mark.
  // Surfaced per-source on /index/stats so the portal can show "N failed" /
  // "N degraded" next to the progress bar.
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexing_errors (
      document_id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      error TEXT NOT NULL,
      failed_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 1,
      severity TEXT NOT NULL DEFAULT 'error',
      truncated_chunks INTEGER NOT NULL DEFAULT 0,
      dropped_chunks INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_indexing_errors_source ON indexing_errors(source_id)");
  // Idempotent column adds for index DBs created before the severity split.
  ensureColumn(db, "indexing_errors", "severity", "severity TEXT NOT NULL DEFAULT 'error'");
  ensureColumn(
    db,
    "indexing_errors",
    "truncated_chunks",
    "truncated_chunks INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "indexing_errors",
    "dropped_chunks",
    "dropped_chunks INTEGER NOT NULL DEFAULT 0",
  );

  // Stamp recording which embedding model + dimension produced the live
  // embeddings. On boot the indexer compares the live embedder's (model,
  // dim) against this row and, on mismatch, runs
  // `wipeAndRecreateVectorIndex` before the first cycle.
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Versioned-index registry (epic #1011). One row per index generation —
  // a complete, self-consistent (embedder model, dim, encoding) build.
  // Today there is exactly one row (the active generation) so behaviour is
  // identical to the single-index world; the double-buffered swap (later
  // chunks) adds a transient second `building` row and flips `active`.
  //
  // The `active_version` SCALAR pointer lives in `index_meta` (above), not
  // here, so the search read path can resolve "which generation serves
  // reads" with one cheap PK lookup that is atomically flippable in a single
  // UPDATE. This table holds the per-generation detail.
  db.exec(`
    CREATE TABLE IF NOT EXISTS index_versions (
      version      INTEGER PRIMARY KEY,
      embed_model  TEXT NOT NULL,
      embed_dim    INTEGER NOT NULL,
      encoding     TEXT NOT NULL DEFAULT 'f32',
      state        TEXT NOT NULL,
      docs_total   INTEGER NOT NULL DEFAULT 0,
      docs_built   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      activated_at TEXT
    )
  `);

  // Scratch store for the in-flight BUILDING generation's vectors during a
  // graceful (double-buffered) embedder swap (epic #1011). The builder
  // re-embeds the existing `chunks` corpus under the new model and stages the
  // new vectors here — keyed by the SAME `chunks.rowid` the active index is
  // keyed by — WITHOUT touching `chunks.embedding`, so the active generation
  // stays byte-for-byte intact and keeps serving vector search throughout the
  // rebuild. At the atomic flip these vectors are promoted into
  // `chunks.embedding` (so a post-flip restart/steady-state stays consistent)
  // and the table is cleared. Empty in steady state; bounded to at most one
  // building generation's worth of rows.
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_embeddings_building (
      chunk_rowid INTEGER PRIMARY KEY,
      embedding   BLOB NOT NULL
    )
  `);

  migrateAdoptInPlaceVersion(db);
  // NOTE: a `building` generation left over from a crash mid-rebuild is NOT
  // abandoned here. Crash-safe resume (epic #1011) RESUMES it from its durable
  // progress (`chunk_embeddings_building` + `docs_built`) rather than re-embedding
  // from zero, and that decision needs the live embedder — so it is made by the
  // indexer lifecycle at boot (`IndexerLifecycle.startIndexer`), not in this pure
  // DB-open path. `cleanupStaleBuildingState` is still the genuine-abandon
  // primitive (a build failure, a superseding swap, or a building generation whose
  // recorded model no longer matches the current config and can't be resumed).

  return db;
}

/** Lifecycle state of an index generation. */
export type IndexVersionState = "building" | "active" | "retired";

export interface IndexVersionRow {
  version: number;
  embed_model: string;
  embed_dim: number;
  encoding: string;
  state: IndexVersionState;
  docs_total: number;
  docs_built: number;
  created_at: string;
  activated_at: string | null;
}

/** `index_meta` key holding the version that currently serves reads. */
const ACTIVE_VERSION_KEY = "active_version";

/**
 * Idempotent adopt-in-place migration to the versioned-index model
 * (epic #1011, non-destructive upgrade). When `index_versions` is empty
 * but `index_meta` already carries an embedding-model stamp (i.e. an
 * existing single-index install), record the current index in place as
 * `version = 1, state = 'active'` — copying the stamp's (model, dim) — and
 * point `index_meta['active_version']` at it. NO re-embed: the existing
 * `index.usearch` is already valid under the stamped model, and version 1
 * deliberately keeps living at the legacy `index.usearch` path (see
 * {@link usearchPathForVersion}).
 *
 * Idempotent and append-only per the repo's migration rule: once
 * `index_versions` is non-empty this is a no-op, so it replays cleanly from
 * any prior version. A truly fresh install (no stamp yet) creates no row —
 * the worker stamps `index_meta` on its first boot and this adopts version 1
 * on the next startup; until then the read registry serves the legacy path
 * at the default dimension, exactly today's behaviour.
 */
export function migrateAdoptInPlaceVersion(db: Db): void {
  const existing = db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM index_versions").get();
  if ((existing?.c ?? 0) > 0) return;

  const stamp = getIndexEmbedModel(db);
  if (!stamp) return;

  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT INTO index_versions
         (version, embed_model, embed_dim, encoding, state, docs_total, docs_built, created_at, activated_at)
       VALUES (1, ?, ?, 'f32', 'active', 0, 0, ?, ?)`,
    ).run(stamp.name, stamp.dim, now, now);
    db.prepare(
      `INSERT INTO index_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(ACTIVE_VERSION_KEY, "1", now);
  });
  txn();
  log.info("Adopted existing index as versioned generation 1 (active) — no re-embed");
}

/**
 * Resolve the on-disk usearch file for an index generation. Version 1 (and
 * the pre-versioning fallback) lives at the legacy `index.usearch` path —
 * the indexer worker still writes there — so chunk-2 introduces no rename
 * and no behaviour change. Generations >= 2 (created by the double-buffered
 * rebuild in later chunks) use the per-generation `index-<gen>.usearch`
 * scheme, which is how a building index gets its own file without touching
 * the serving one.
 */
export function usearchPathForVersion(configDir: string, version: number | null): string {
  const sep = configDir.endsWith("/") ? "" : "/";
  if (version == null || version === 1) return `${configDir}${sep}index.usearch`;
  return `${configDir}${sep}index-${version}.usearch`;
}

/**
 * Every file a generation's usearch graph leaves in the config dir: the
 * plaintext graph from {@link usearchPathForVersion}, its encrypted `.enc`
 * persistence, and temp or quarantined copies of either.
 */
export const USEARCH_FILE_NAME = /^index(?:-\d+)?\.usearch(?:\..+)?$/;

/**
 * Secure-storage mode treats USEARCH sidecars as rebuildable cache, not durable
 * encrypted storage. Purge every legacy/versioned sidecar so the worker
 * rebuilds it from encrypted `index.db` on boot.
 */
export function purgeUsearchSidecars(configDir: string): number {
  const sidecarName = /^index(?:-\d+)?\.usearch(?:\.tmp)?(?:\.corrupt-\d+)?$/;
  let removed = 0;
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(configDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !sidecarName.test(entry.name)) continue;
    rmSync(join(configDir, entry.name), { force: true });
    removed += 1;
  }
  return removed;
}

/**
 * The version that currently serves reads, or null on a pre-versioning /
 * fresh install where no generation has been adopted yet. A single cheap PK
 * lookup — the read registry consults it before each search.
 */
export function getActiveIndexVersion(db: Db): number | null {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM index_meta WHERE key = ?")
    .get(ACTIVE_VERSION_KEY);
  if (!row) return null;
  const v = Number(row.value);
  return Number.isInteger(v) && v > 0 ? v : null;
}

/** Point `active_version` at a generation (the atomic-flip primitive). */
export function setActiveIndexVersion(db: Db, version: number): void {
  db.prepare(
    `INSERT INTO index_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(ACTIVE_VERSION_KEY, String(version), new Date().toISOString());
}

/**
 * `index_meta` key: a monotonic counter bumped on every embedding write and
 * source-wide vector deletion. It is the consistency fingerprint for the persisted
 * (encrypted) HNSW sidecar: the sidecar's `.enc` header carries the value
 * at graph-snapshot time, and boot rebuilds the graph iff the header value
 * differs from this. It catches the stale-but-right-count crash the plain
 * `size() >= count(chunks)` check misses (a re-index deletes old rowids and
 * inserts new ones at an unchanged total, but the insert bumps this seq).
 * Deletes deliberately do NOT bump: extra vectors in the graph are harmless
 * (the post-search JOIN to `chunks` filters orphans), so only additions can
 * invalidate the sidecar. Cheap PK read; unused when encryption is off.
 */
const VECTOR_WRITE_SEQ_KEY = "vector_write_seq";

export function getVectorWriteSeq(db: Db): number {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM index_meta WHERE key = ?")
    .get(VECTOR_WRITE_SEQ_KEY);
  if (!row) return 0;
  const n = Number(row.value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Bump the write-seq by one. MUST run inside the same txn as the embedding write. */
function bumpVectorWriteSeq(db: Db): void {
  db.prepare(
    `INSERT INTO index_meta (key, value, updated_at) VALUES (?, '1', ?)
     ON CONFLICT(key) DO UPDATE SET
       value = CAST(CAST(index_meta.value AS INTEGER) + 1 AS TEXT),
       updated_at = excluded.updated_at`,
  ).run(VECTOR_WRITE_SEQ_KEY, new Date().toISOString());
}

/**
 * `index_meta` key: the `vector_write_seq` value the on-disk plaintext HNSW
 * graph was last SAVED at. The indexer worker stamps it after every successful
 * `save()`, so it always describes what the plaintext file actually contains —
 * independent of how the process shuts down. The gateway's shutdown stamps this
 * (not the live `vector_write_seq`) into the encrypted sidecar's fingerprint, so
 * the sidecar's seq is exactly the graph's content seq: a restart restores iff
 * that still equals the live `vector_write_seq` (i.e. no vectors were written
 * after the last save). If the worker's final save was skipped/killed, this
 * value lags the live seq, so boot rebuilds rather than restoring a stale graph.
 */
const USEARCH_SAVED_SEQ_KEY = "usearch_saved_seq";

export function getUsearchSavedSeq(db: Db): number {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM index_meta WHERE key = ?")
    .get(USEARCH_SAVED_SEQ_KEY);
  if (!row) return 0;
  const n = Number(row.value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** Record that the plaintext graph on disk now reflects `seq`. */
export function setUsearchSavedSeq(db: Db, seq: number): void {
  db.prepare(
    `INSERT INTO index_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(USEARCH_SAVED_SEQ_KEY, String(seq), new Date().toISOString());
}

/** Read one index generation's row, or null if absent. */
export function getIndexVersion(db: Db, version: number): IndexVersionRow | null {
  return (
    db
      .prepare<[number], IndexVersionRow>("SELECT * FROM index_versions WHERE version = ?")
      .get(version) ?? null
  );
}

/** All index generations, oldest first. */
export function listIndexVersions(db: Db): IndexVersionRow[] {
  return db.prepare<[], IndexVersionRow>("SELECT * FROM index_versions ORDER BY version ASC").all();
}

/**
 * The in-flight `building` generation, or null when none is in flight. There is
 * at most one (bounded-to-two), so this returns the lowest-version building row
 * defensively. Consulted at boot (epic #1011, crash-safe resume): a building row
 * present at startup means a rebuild was in flight when the gateway last stopped,
 * and the lifecycle decides to resume it (when its recorded model still matches
 * the configured embedder) or abandon it.
 */
export function getBuildingIndexVersion(db: Db): IndexVersionRow | null {
  return (
    db
      .prepare<
        [],
        IndexVersionRow
      >("SELECT * FROM index_versions WHERE state = 'building' ORDER BY version ASC LIMIT 1")
      .get() ?? null
  );
}

/** Summary of an index generation for the status surfaces (epic #1011). */
export interface IndexGenerationSummary {
  version: number;
  embedModel: string;
  embedDim: number;
}

/** A building generation plus its rebuild progress (% and N-of-M). */
export interface BuildingGenerationSummary extends IndexGenerationSummary {
  docsBuilt: number;
  docsTotal: number;
  percent: number;
}

/**
 * The active + building index generations for the status two-readout (epic
 * #1011). Computed entirely here so `/index/stats` and `/status` expose the
 * active-vs-building distinction and the rebuild progress as first-class fields
 * and clients render them with NO client-side inference.
 *
 * - `active` is the generation currently serving every vector search (complete
 *   on its model), or null on a pre-versioning / fresh install.
 * - `building` is a next-generation rebuild in flight (a graceful embedder
 *   swap), with its progress, or null when none is running.
 *
 * `docs_total` (the {@link createBuildingIndexVersion} seed) and `docs_built`
 * (the builder's progress) both count {@link getBuildableDocumentCount} — the
 * same population — so a completed build reads exactly 100%. The percent is
 * still clamped to [0, 100] and `docsBuilt` to `docsTotal` as belt-and-suspenders
 * for the one transient where they legitimately disagree: mid-rebuild ingest
 * fan-out grows the corpus after `docs_total` was snapshotted, so `catchUp` can
 * briefly record a `docs_built` above the original `docs_total` — which must
 * never read as >100%.
 */
export interface IndexGenerationStatus {
  active: IndexGenerationSummary | null;
  building: BuildingGenerationSummary | null;
}

/** Read the active + building index generations for the status surfaces. */
export function getIndexGenerationStatus(db: Db): IndexGenerationStatus {
  const activeVersion = getActiveIndexVersion(db);
  const activeRow = activeVersion != null ? getIndexVersion(db, activeVersion) : null;
  const active: IndexGenerationSummary | null = activeRow
    ? {
        version: activeRow.version,
        embedModel: activeRow.embed_model,
        embedDim: activeRow.embed_dim,
      }
    : null;

  const buildingRow = getBuildingIndexVersion(db);
  let building: BuildingGenerationSummary | null = null;
  if (buildingRow) {
    const docsTotal = Math.max(0, buildingRow.docs_total);
    const docsBuilt = Math.max(
      0,
      Math.min(buildingRow.docs_built, docsTotal || buildingRow.docs_built),
    );
    const percent = docsTotal > 0 ? Math.min(100, Math.round((docsBuilt / docsTotal) * 100)) : 0;
    building = {
      version: buildingRow.version,
      embedModel: buildingRow.embed_model,
      embedDim: buildingRow.embed_dim,
      docsBuilt,
      docsTotal,
      percent,
    };
  }
  return { active, building };
}

/**
 * A page of staged building-generation vectors, keyed by `chunk_rowid` and
 * ordered by it so a `chunk_rowid > afterRowid` cursor walks the whole table.
 * Used by crash-safe resume (epic #1011) to reconstruct a building generation's
 * usearch file from the durable staging table — the file is only flushed every
 * few thousand chunks during a build, so after a crash it may be stale, torn, or
 * truncated, while the staging rows committed transactionally per batch. Rebuilding
 * the file from staging makes it consistent with the persisted progress WITHOUT
 * re-embedding anything.
 */
export function getBuildingEmbeddingsPage(
  db: Db,
  afterRowid: number,
  limit: number,
): Array<{ chunk_rowid: number; embedding: Buffer }> {
  return db
    .prepare<
      [number, number],
      { chunk_rowid: number; embedding: Buffer }
    >("SELECT chunk_rowid, embedding FROM chunk_embeddings_building WHERE chunk_rowid > ? ORDER BY chunk_rowid LIMIT ?")
    .all(afterRowid, limit);
}

/**
 * The next free generation id — one past the highest version ever allocated
 * (including retired rows), so a generation id is never reused while a
 * mmap-view of its old file might linger. Returns 1 on a fresh registry.
 */
export function nextIndexVersion(db: Db): number {
  const row = db
    .prepare<[], { m: number | null }>("SELECT MAX(version) AS m FROM index_versions")
    .get();
  return (row?.m ?? 0) + 1;
}

/**
 * Insert a fresh `building` generation row for a double-buffered rebuild
 * (epic #1011). The caller embeds the corpus under `embedModel` into the
 * version's own usearch file, then {@link flipActiveIndexVersion} promotes it.
 */
export function createBuildingIndexVersion(
  db: Db,
  opts: {
    version: number;
    embedModel: string;
    embedDim: number;
    encoding?: string;
    docsTotal: number;
  },
): void {
  db.prepare(
    `INSERT INTO index_versions
       (version, embed_model, embed_dim, encoding, state, docs_total, docs_built, created_at, activated_at)
     VALUES (?, ?, ?, ?, 'building', ?, 0, ?, NULL)`,
  ).run(
    opts.version,
    opts.embedModel,
    opts.embedDim,
    opts.encoding ?? "f32",
    opts.docsTotal,
    new Date().toISOString(),
  );
}

/** Record rebuild progress for a building generation (numerator of the %). */
export function setIndexVersionProgress(db: Db, version: number, docsBuilt: number): void {
  db.prepare("UPDATE index_versions SET docs_built = ? WHERE version = ?").run(docsBuilt, version);
}

/** Stage one chunk's new-model vector for the in-flight building generation. */
export function upsertBuildingEmbeddings(
  db: Db,
  rows: ReadonlyArray<{ chunkRowid: number; embedding: Float32Array }>,
): void {
  const stmt = db.prepare(
    `INSERT INTO chunk_embeddings_building (chunk_rowid, embedding) VALUES (?, ?)
     ON CONFLICT(chunk_rowid) DO UPDATE SET embedding = excluded.embedding`,
  );
  const txn = db.transaction(
    (batch: ReadonlyArray<{ chunkRowid: number; embedding: Float32Array }>) => {
      for (const r of batch) {
        stmt.run(
          r.chunkRowid,
          Buffer.from(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength),
        );
      }
    },
  );
  txn(rows);
}

/** Number of vectors staged so far for the in-flight building generation. */
export function getBuildingEmbeddingCount(db: Db): number {
  return (
    db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM chunk_embeddings_building").get()?.c ??
    0
  );
}

/**
 * Staged building-generation rowids whose `chunks` row has since vanished —
 * i.e. a document deleted (or re-chunked, which deletes its old rowids and
 * inserts new ones) AFTER it was embedded into the building generation. The
 * mid-rebuild fan-out catch-up ({@link GenerationBuilder.catchUp}) removes
 * these vectors from the building usearch and drops their staging rows BEFORE
 * the flip, so a doc deleted mid-rebuild can never resurrect in the new
 * generation. Empty in the common case. See epic #1011.
 */
export function getOrphanBuildingRowids(db: Db): number[] {
  return db
    .prepare<[], { chunk_rowid: number }>(
      `SELECT b.chunk_rowid
         FROM chunk_embeddings_building b
         LEFT JOIN chunks c ON c.rowid = b.chunk_rowid
        WHERE c.rowid IS NULL`,
    )
    .all()
    .map((r) => r.chunk_rowid);
}

/** Drop the given rowids' staged building-generation vectors. */
export function deleteBuildingEmbeddings(db: Db, rowids: readonly number[]): void {
  if (rowids.length === 0) return;
  const stmt = db.prepare("DELETE FROM chunk_embeddings_building WHERE chunk_rowid = ?");
  const txn = db.transaction((ids: readonly number[]) => {
    for (const id of ids) stmt.run(id);
  });
  txn(rowids);
}

/**
 * The atomic flip (epic #1011): promote a completed building generation to
 * active in a single transaction so search never observes a blended or
 * half-built state. In one commit it:
 *
 *  1. Promotes the staged new-model vectors into `chunks.embedding` (the
 *     canonical column the steady-state worker and a restart's backfill read),
 *     NULLing any chunk the build didn't produce a vector for so no
 *     stale old-dimension vector is ever left behind to mix dimensions.
 *  2. Re-stamps `index_meta` with the new (model, dim) so the restarted worker
 *     sees a matching stamp and does NOT trigger a spurious re-wipe (#698).
 *  3. Marks the new generation `active` (+ `activated_at`) and the previous one
 *     `retired`.
 *  4. Moves the `active_version` pointer — the single read the registry
 *     consults — so its next `maybeRefresh()` serves the new file with no
 *     restart.
 *  5. Clears the building scratch table.
 *
 * The caller is responsible for deleting the retired generation's usearch file
 * AFTER this commits (file cleanup is not transactional).
 */
export function flipActiveIndexVersion(
  db: Db,
  opts: { newVersion: number; oldVersion: number | null; embedModel: string; embedDim: number },
): void {
  const now = new Date().toISOString();
  const txn = db.transaction(() => {
    db.exec(
      `UPDATE chunks
          SET embedding = (
            SELECT b.embedding FROM chunk_embeddings_building b WHERE b.chunk_rowid = chunks.rowid
          )`,
    );
    const upsertMeta = db.prepare(
      `INSERT INTO index_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    upsertMeta.run("embed_model_name", opts.embedModel, now);
    upsertMeta.run("embed_model_dim", String(opts.embedDim), now);
    db.prepare(
      "UPDATE index_versions SET state = 'active', activated_at = ? WHERE version = ?",
    ).run(now, opts.newVersion);
    if (opts.oldVersion != null) {
      db.prepare("UPDATE index_versions SET state = 'retired' WHERE version = ?").run(
        opts.oldVersion,
      );
    }
    upsertMeta.run(ACTIVE_VERSION_KEY, String(opts.newVersion), now);
    db.exec("DELETE FROM chunk_embeddings_building");
  });
  txn();
}

/**
 * Abandon any in-flight building generation: mark every `building` row
 * `retired`, drop its usearch file, and clear the staged vectors. Called at
 * startup (iter-4 does not yet resume a rebuild — crash-safe resume is a later
 * chunk) and when a graceful build fails, so a crashed/aborted rebuild can
 * never leave a dangling building row or an orphan `index-<gen>.usearch` file
 * on disk. The active generation is never touched. Idempotent.
 */
export function cleanupStaleBuildingState(db: Db, indexDbPath: string): void {
  const building = db
    .prepare<[], { version: number }>("SELECT version FROM index_versions WHERE state = 'building'")
    .all();
  const configDir = dirname(indexDbPath);
  for (const { version } of building) {
    db.prepare("UPDATE index_versions SET state = 'retired' WHERE version = ?").run(version);
    const file = usearchPathForVersion(configDir, version);
    for (const p of [file, `${file}.tmp`]) {
      try {
        unlinkSync(p);
      } catch {
        // missing file is fine
      }
    }
  }
  const staged = getBuildingEmbeddingCount(db);
  if (staged > 0) db.exec("DELETE FROM chunk_embeddings_building");
  if (building.length > 0 || staged > 0) {
    log.info(
      `Cleaned up stale building-generation state: ${building.length} retired row(s), ${staged} staged vector(s) dropped`,
    );
  }
}

/**
 * Pre-warm the page caches under BM25 search. Without this, the first
 * search after a restart pays 20-60s to page in the `chunks_fts_data`
 * and `chunks_fts_idx` shadow tables from disk.
 *
 * Mechanism: read every blob of the three tables a BM25 query touches
 * and discard it. The side effect is a warm cache — the connection's own
 * page cache and, underneath it, the kernel page cache every other
 * `index.db` reader shares. Never throws: it answers the number of rows it
 * read and, when a statement failed, the error that ended the scans there,
 * so the caller can log what actually ran.
 */
export interface PrewarmOutcome {
  /** Rows read across the scans that ran. */
  rows: number;
  /** Message of the error that ended the scans early, when one did. */
  stoppedBy?: string;
}

export function prewarmFtsCaches(db: Db): PrewarmOutcome {
  let rows = 0;
  try {
    // Read every page of the FTS5 data shadow table into the SQLite
    // per-connection page cache. FTS5 stores posting lists as blobs
    // in chunks_fts_data.block — reading every blob forces every page
    // into cache. This is expensive (~10-30s for a 445 MB table) but
    // the alternative is a 20-60s cold penalty on the first search.
    //
    // Read every blob from the FTS5 data shadow table. LENGTH()
    // doesn't work — SQLite reads the blob header from the leaf page
    // but skips the overflow pages where the actual posting-list data
    // lives. We must SELECT the blob content itself to pull every
    // overflow page into the per-connection cache. The JS side
    // discards each row immediately so memory stays flat.
    const stmt = db.prepare("SELECT block FROM chunks_fts_data");
    for (const _row of stmt.iterate()) {
      // Touch each blob to force overflow pages into cache.
      rows += 1;
    }
    // Docsize table (used by bm25() for TF-IDF norms).
    for (const _row of db.prepare("SELECT sz FROM chunks_fts_docsize").iterate()) {
      // Same — read and discard.
      rows += 1;
    }
    // The chunks metadata table (2 GB) is JOINed on every BM25 result.
    // Reading every row's content column pulls the overflow pages into
    // the per-connection cache. Without this, the JOIN causes random
    // disk reads on every search even when FTS5 is warm.
    for (const _row of db.prepare("SELECT content FROM chunks").iterate()) {
      // Touch content to pull overflow pages into cache.
      rows += 1;
    }
  } catch (err) {
    // FTS table may not exist yet on a fresh DB.
    return { rows, stoppedBy: err instanceof Error ? err.message : String(err) };
  }
  return { rows };
}

/**
 * Read the stored embedding-model identity (`{ name, dim }`). Returns
 * null on a fresh install where the indexer hasn't stamped anything yet.
 */
export function getIndexEmbedModel(db: Db): { name: string; dim: number } | null {
  const nameRow = db
    .prepare<[], { value: string }>("SELECT value FROM index_meta WHERE key = 'embed_model_name'")
    .get();
  const dimRow = db
    .prepare<[], { value: string }>("SELECT value FROM index_meta WHERE key = 'embed_model_dim'")
    .get();
  if (!nameRow || !dimRow) return null;
  const dim = Number(dimRow.value);
  if (!Number.isInteger(dim) || dim <= 0) return null;
  return { name: nameRow.value, dim };
}

/**
 * Stamp the live embedding model into `index_meta`. Called after a
 * fresh `wipeAndRecreateVectorIndex` and once per boot if the stamp
 * was missing.
 */
export function setIndexEmbedModel(db: Db, name: string, dim: number): void {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO index_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const txn = db.transaction(() => {
    upsert.run("embed_model_name", name, now);
    upsert.run("embed_model_dim", String(dim), now);
  });
  txn();
}

/**
 * Invalidate every vector + the HNSW index + indexer-side scan state so the
 * indexer re-embeds the corpus from scratch under a (potentially different)
 * embedding model.
 *
 * What survives, and why:
 *   - The `chunks` ROWS, with their text and metadata. They are the storage
 *     behind `chunks_fts`, so keeping them is what makes the documented
 *     "keyword-only search until the rebuild finishes" contract true. Each
 *     row is replaced when its document is re-embedded.
 *   - `index_totals` / `source_index_stats`, which describe those retained
 *     chunks and therefore stay accurate.
 *   - The source-event clock in `indexed_documents`: rebuilding an embedding
 *     index is maintenance, not a new document event, and must never replay
 *     historical documents through subscription matching. Emptying the
 *     content hash still forces every surviving gateway document through the
 *     rebuild.
 *
 * #240 (double-buffered) replaces this brute-force invalidation with a
 * parallel index that keeps vector search live during the rebuild.
 * Until then, vector search is unavailable for the duration of the
 * reindex (BM25 still works).
 */
export function wipeAndRecreateVectorIndex(
  db: Db,
  embeddingDim: number,
  embedModelName?: string,
  options?: IndexWriteOptions,
): void {
  if (options?.usearch) options.usearch.clear();
  if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
    throw new Error(`invalid embeddingDim: ${embeddingDim}`);
  }
  const activeVersion = getActiveIndexVersion(db);
  const txn = db.transaction(() => {
    // Drop the derived vectors only — never the chunk TEXT. `chunks_fts` is an
    // external-content FTS5 table over `chunks` (its AFTER DELETE trigger
    // removes the postings) and the BM25 query joins `chunks` for metadata, so
    // deleting rows here would take the keyword lane down with the vector lane.
    // The whole point of this path is "keyword-only search until the rebuild
    // finishes". Nulling `embedding` also stops the usearch backfill — which
    // rebuilds the graph from `chunks.embedding` — from resurrecting
    // old-model vectors when the replacement model shares the old dimension.
    // The chunk rows themselves are replaced document by document as the
    // re-embed walks the corpus (`upsertChunksAndMarkIndexedBatch`).
    db.exec("UPDATE chunks SET embedding = NULL");
    db.exec(
      `UPDATE indexed_documents
          SET content_hash = '',
              indexed_at = CURRENT_TIMESTAMP`,
    );
    db.exec("DELETE FROM indexing_errors");
    db.exec("DELETE FROM watermark");
    if (embedModelName) {
      const now = new Date().toISOString();
      const upsert = db.prepare(
        `INSERT INTO index_meta (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      );
      upsert.run("embed_model_name", embedModelName, now);
      upsert.run("embed_model_dim", String(embeddingDim), now);
      // Keep the active index_versions generation consistent with the stamp.
      // The wipe re-embeds the whole corpus under (embedModelName,
      // embeddingDim); leaving the registry row at the OLD model/dim lets a
      // later boot-resume/adopt read a stale identity and treat the wiped index
      // as still matching the previous model. docs_* reset to 0: no document
      // has been embedded under the new model yet.
      if (activeVersion !== null) {
        db.prepare(
          `UPDATE index_versions
              SET embed_model = ?, embed_dim = ?, docs_built = 0, docs_total = 0
            WHERE version = ?`,
        ).run(embedModelName, embeddingDim, activeVersion);
      }
    }
  });
  txn();
}

const GATEWAY_SCHEMA_RECONCILE_KEY = "gateway_schema_version_reconciled";

export interface GatewaySchemaIndexReconcileResult {
  ran: boolean;
  gatewaySchemaVersion: number;
  removedDocuments: number;
  removedChunks: number;
}

/**
 * Remove index rows whose gateway documents disappeared in a main-store
 * migration. This runs before the search read handle opens, independent of
 * whether an embedder/indexer worker is configured, so stale BM25 content is
 * never served after an upgrade.
 *
 * Deletions commit in bounded batches. The version marker lands only after
 * every batch succeeds; an interrupted boot safely resumes the idempotent
 * reconciliation next time.
 */
export function reconcileIndexForGatewaySchema(
  gatewayDb: Db,
  indexDb: Db,
  batchSize = 500,
): GatewaySchemaIndexReconcileResult {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("Index reconciliation batch size must be a positive integer");
  }
  const gatewaySchemaVersion =
    gatewayDb.prepare<[], { user_version: number }>("PRAGMA user_version").get()?.user_version ?? 0;
  const reconciledSchemaVersion = Number(
    indexDb
      .prepare<[string], { value: string }>("SELECT value FROM index_meta WHERE key = ?")
      .get(GATEWAY_SCHEMA_RECONCILE_KEY)?.value ?? 0,
  );
  if (gatewaySchemaVersion <= reconciledSchemaVersion) {
    return {
      ran: false,
      gatewaySchemaVersion,
      removedDocuments: 0,
      removedChunks: 0,
    };
  }

  const indexedIds = indexDb
    .prepare<[], { document_id: string }>(
      `SELECT document_id FROM indexed_documents
       UNION
       SELECT document_id FROM chunks
       UNION
       SELECT document_id FROM indexing_errors`,
    )
    .all()
    .map((row) => row.document_id);
  let removedDocuments = 0;
  let removedChunks = 0;
  for (let i = 0; i < indexedIds.length; i += batchSize) {
    const candidates = indexedIds.slice(i, i + batchSize);
    const placeholders = candidates.map(() => "?").join(", ");
    const liveIds = new Set(
      gatewayDb
        .prepare<string[], { id: string }>(`SELECT id FROM documents WHERE id IN (${placeholders})`)
        .all(...candidates)
        .map((row) => row.id),
    );
    const staleIds = candidates.filter((id) => !liveIds.has(id));
    if (staleIds.length === 0) continue;
    removedChunks += deleteChunksByDocuments(indexDb, staleIds);
    const clearErrors = indexDb.prepare<[string]>(
      "DELETE FROM indexing_errors WHERE document_id = ?",
    );
    const clearBatch = indexDb.transaction((ids: readonly string[]) => {
      for (const id of ids) clearErrors.run(id);
    });
    clearBatch(staleIds);
    removedDocuments += staleIds.length;
  }

  indexDb
    .prepare(
      `INSERT INTO index_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .run(GATEWAY_SCHEMA_RECONCILE_KEY, String(gatewaySchemaVersion), new Date().toISOString());
  return { ran: true, gatewaySchemaVersion, removedDocuments, removedChunks };
}

// ---------------------------------------------------------------------------
// Watermark operations
// ---------------------------------------------------------------------------

export function getWatermark(db: Db, key: string): string | null {
  const row = db
    .prepare<[string], { value: string }>("SELECT value FROM watermark WHERE key = ?")
    .get(key);
  return row?.value ?? null;
}

export function setWatermark(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO watermark (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

// ---------------------------------------------------------------------------
// Indexed document state
// ---------------------------------------------------------------------------

export function getIndexedDocument(db: Db, documentId: string): IndexedDocumentRow | null {
  return (
    db
      .prepare<
        [string],
        IndexedDocumentRow
      >("SELECT * FROM indexed_documents WHERE document_id = ?")
      .get(documentId) ?? null
  );
}

/**
 * Batch-fetch content hashes from `indexed_documents` for a set of
 * document IDs. Returns a Map keyed by document_id whose values are
 * the stored content_hash. IDs not present in the index are absent
 * from the map.
 *
 * Used by the two-phase fetch optimisation in `indexUpdated()`: the
 * lightweight first pass fetches only `(id, content_hash)` from the
 * gateway DB, then this function tells us which hashes already match,
 * so only the truly-changed docs need a full content fetch.
 */
export function getIndexedContentHashes(db: Db, documentIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (documentIds.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < documentIds.length; i += CHUNK) {
    const chunk = documentIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<
        string[],
        { document_id: string; content_hash: string }
      >(`SELECT document_id, content_hash FROM indexed_documents WHERE document_id IN (${placeholders})`)
      .all(...chunk);
    for (const r of rows) out.set(r.document_id, r.content_hash);
  }
  return out;
}

/**
 * The index-side state needed to distinguish a genuine document event from an
 * index rebuild, and an embedding-affecting update from metadata that can reuse
 * the current vectors.
 */
export interface IndexedDocumentState {
  contentHash: string;
  sourceEventAt: string;
  /**
   * Reconstructed from chunk zero, whose denormalized fields are the canonical
   * inputs to the embedding preamble. Null means no reusable chunk survived, so
   * callers must conservatively re-embed.
   */
  embeddingPreamble: string | null;
}

export function getIndexedDocumentStates(
  db: Db,
  documentIds: string[],
): Map<string, IndexedDocumentState> {
  const out = new Map<string, IndexedDocumentState>();
  if (documentIds.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < documentIds.length; i += CHUNK) {
    const chunk = documentIds.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = db
      .prepare<
        string[],
        {
          document_id: string;
          content_hash: string;
          source_event_at: string;
          document_type: string | null;
          title: string | null;
          author: string | null;
          source_created_at: string | null;
        }
      >(
        `SELECT d.document_id, d.content_hash, d.source_event_at,
                c.document_type, c.title, c.author, c.source_created_at
           FROM indexed_documents d
           LEFT JOIN chunks c
             ON c.document_id = d.document_id AND c.chunk_index = 0
          WHERE d.document_id IN (${placeholders})`,
      )
      .all(...chunk);
    for (const row of rows) {
      out.set(row.document_id, {
        contentHash: row.content_hash,
        sourceEventAt: row.source_event_at,
        embeddingPreamble:
          row.title === null
            ? null
            : buildEmbeddingPreamble({
                documentType: row.document_type,
                title: row.title,
                author: row.author,
                sourceCreatedAt: row.source_created_at,
              }),
      });
    }
  }
  return out;
}

/**
 * Record a real gateway document update that did not change any embedding
 * input. `indexed_at` deliberately remains the time vectors were last built;
 * `event_indexed_at` is the subscription event clock consumed by the semantic
 * evaluator.
 */
export function markIndexedDocumentEvent(
  db: Db,
  documentId: string,
  sourceEventAt: string,
): boolean {
  const eventIndexedAt = nextIndexedEventAt(db, new Date().toISOString());
  const changed = db
    .prepare(
      `UPDATE indexed_documents
          SET source_event_at = ?, event_indexed_at = ?
        WHERE document_id = ? AND source_event_at <> ?`,
    )
    .run(sourceEventAt, eventIndexedAt, documentId, sourceEventAt);
  return changed.changes > 0;
}

/**
 * Initialize the source-event marker on an index row created before that
 * column existed. This is migration bookkeeping, not a new corpus event, so
 * the existing `event_indexed_at` cursor is deliberately preserved.
 */
export function adoptIndexedDocumentSourceEvent(
  db: Db,
  documentId: string,
  sourceEventAt: string,
): boolean {
  const changed = db
    .prepare(
      `UPDATE indexed_documents
          SET source_event_at = ?
        WHERE document_id = ? AND source_event_at = ''`,
    )
    .run(sourceEventAt, documentId);
  return changed.changes > 0;
}

/**
 * `event_indexed_at` participates in a global keyset cursor. Two writes in the
 * same millisecond (or a small wall-clock regression) must therefore still
 * receive increasing clocks, otherwise updating an already-consumed row can
 * leave it behind the evaluator watermark forever.
 */
function nextIndexedEventAt(db: Db, proposed: string): string {
  const current = db
    .prepare<
      [],
      { max_event_at: string | null }
    >("SELECT MAX(event_indexed_at) AS max_event_at FROM indexed_documents")
    .get()?.max_event_at;
  if (!current || proposed > current) return proposed;
  const currentMs = Date.parse(current);
  return Number.isFinite(currentMs) ? new Date(currentMs + 1).toISOString() : proposed;
}

export function setIndexedDocument(
  db: Db,
  documentId: string,
  contentHash: string,
  chunkCount: number,
  sourceEventAt?: string,
): void {
  const indexedAt = new Date().toISOString();
  const eventAt = sourceEventAt ?? indexedAt;
  const eventIndexedAt = nextIndexedEventAt(db, indexedAt);
  db.prepare(
    `INSERT INTO indexed_documents
       (document_id, content_hash, chunk_count, indexed_at, source_event_at,
        event_indexed_at, index_version)
     VALUES (?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(document_id) DO UPDATE SET
       content_hash = excluded.content_hash,
       chunk_count = excluded.chunk_count,
       indexed_at = excluded.indexed_at,
       event_indexed_at = CASE
         WHEN excluded.source_event_at <> indexed_documents.source_event_at
           THEN excluded.event_indexed_at
         ELSE indexed_documents.event_indexed_at
       END,
       source_event_at = excluded.source_event_at,
       index_version = indexed_documents.index_version + 1`,
  ).run(documentId, contentHash, chunkCount, indexedAt, eventAt, eventIndexedAt);
}

export function removeIndexedDocument(db: Db, documentId: string): void {
  db.prepare("DELETE FROM indexed_documents WHERE document_id = ?").run(documentId);
}

export function getAllIndexedDocumentIds(db: Db): Set<string> {
  const rows = db
    .prepare<[], { document_id: string }>("SELECT document_id FROM indexed_documents")
    .all();
  return new Set(rows.map((r) => r.document_id));
}

// ---------------------------------------------------------------------------
// Chunk operations
// ---------------------------------------------------------------------------

export interface ChunkUpsertInput {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  embedding: Float32Array;
  sourceId: string;
  documentType?: string;
  title: string;
  sourceUrl?: string;
  sourceCreatedAt: string;
  author?: string;
  tags?: string[];
  relevanceScore?: number;
}

function embeddingBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export interface IndexWriteOptions {
  usearch?: import("./usearch-index.js").UsearchWriteHandle;
}

/**
 * Remove the given chunk rowids' vectors from the HNSW index when a usearch
 * write handle is in scope, or otherwise enqueue them in
 * `pending_vector_deletes` for the indexer worker to remove on its next
 * cycle (`preparePendingVectorDeletes`). The HTTP delete cascade runs on the
 * main thread without a write handle; enqueueing keeps its deleted vectors
 * from being orphaned forever — the root cause of the resync OOM (#553).
 */
function removeOrEnqueueVectors(
  db: Db,
  rowids: readonly bigint[],
  options?: IndexWriteOptions,
): void {
  if (rowids.length === 0) return;
  if (options?.usearch) {
    options.usearch.removeBatch(rowids as bigint[]);
    return;
  }
  const stmt = db.prepare(
    `INSERT INTO pending_vector_deletes (chunk_rowid, generation) VALUES (?, 1)
     ON CONFLICT(chunk_rowid) DO UPDATE SET generation = generation + 1`,
  );
  for (const rowid of rowids) stmt.run(Number(rowid));
}

export interface PendingVectorDelete {
  chunkRowid: number;
  generation: number;
}

/**
 * Prepare a bounded vector-delete batch without clearing its durable journal.
 * The caller removes the returned generation only after `usearch.save()`
 * publishes the mutation; a crash or save failure therefore leaves the exact
 * obligation available at restart.
 *
 * A rowid freed by a delete can be reused by a later insert. A live `chunks`
 * row means its newly upserted vector already replaced the stale key, so the
 * queued key needs no removal. Completion is generation-checked so another
 * deletion of the same numeric rowid cannot be cleared by an older save.
 * See #553.
 */
export function preparePendingVectorDeletes(
  db: Db,
  usearch: import("./usearch-index.js").UsearchWriteHandle,
  limit?: number,
): PendingVectorDelete[] {
  const bounded = limit === undefined ? null : Math.max(1, Math.floor(limit));
  const rows = db
    .prepare<[number | null], { chunk_rowid: number; generation: number; reused: number }>(
      `SELECT p.chunk_rowid,
              p.generation,
              CASE WHEN c.rowid IS NULL THEN 0 ELSE 1 END AS reused
         FROM pending_vector_deletes p
         LEFT JOIN chunks c ON c.rowid = p.chunk_rowid
        ORDER BY p.chunk_rowid
        LIMIT COALESCE(?, -1)`,
    )
    .all(bounded);
  if (rows.length === 0) return [];
  const remove = rows.filter((row) => row.reused === 0).map((row) => BigInt(row.chunk_rowid));
  if (remove.length > 0) usearch.removeBatch(remove);
  return rows.map((row) => ({
    chunkRowid: row.chunk_rowid,
    generation: row.generation,
  }));
}

/** Clear only vector obligations covered by the graph generation just saved. */
export function completePendingVectorDeletes(
  db: Db,
  entries: readonly PendingVectorDelete[],
): void {
  if (entries.length === 0) return;
  const complete = db.transaction(() => {
    const stmt = db.prepare(
      "DELETE FROM pending_vector_deletes WHERE chunk_rowid = ? AND generation = ?",
    );
    for (const entry of entries) {
      stmt.run(entry.chunkRowid, entry.generation);
    }
  });
  complete();
}

export function upsertChunks(
  db: Db,
  chunks: ChunkUpsertInput[],
  options?: IndexWriteOptions,
): void {
  const upsertChunk = db.prepare(`
    INSERT INTO chunks (id, document_id, chunk_index, content, source_id, document_type, title, source_url, source_created_at, author, tags, relevance_score, embedding)
    VALUES ($id, $document_id, $chunk_index, $content, $source_id, $document_type, $title, $source_url, $source_created_at, $author, $tags, $relevance_score, $embedding)
    ON CONFLICT(document_id, chunk_index) DO UPDATE SET
      id = excluded.id,
      content = excluded.content,
      source_id = excluded.source_id,
      document_type = excluded.document_type,
      title = excluded.title,
      source_url = excluded.source_url,
      source_created_at = excluded.source_created_at,
      author = excluded.author,
      tags = excluded.tags,
      relevance_score = excluded.relevance_score,
      embedding = excluded.embedding
  `);
  const getRowId = options?.usearch
    ? db.prepare<[string, number], { rowid: number }>(
        "SELECT rowid FROM chunks WHERE document_id = ? AND chunk_index = ?",
      )
    : null;

  const insertMany = db.transaction((rows: typeof chunks) => {
    for (const c of rows) {
      upsertChunk.run({
        id: c.id,
        document_id: c.documentId,
        chunk_index: c.chunkIndex,
        content: c.content,
        source_id: c.sourceId,
        document_type: c.documentType ?? null,
        title: c.title,
        source_url: c.sourceUrl ?? null,
        source_created_at: c.sourceCreatedAt,
        author: c.author ?? null,
        tags: c.tags ? JSON.stringify(c.tags) : null,
        relevance_score: c.relevanceScore ?? null,
        embedding: embeddingBlob(c.embedding),
      });

      if (options?.usearch && getRowId) {
        const row = getRowId.get(c.documentId, c.chunkIndex);
        if (row) {
          options.usearch.add(BigInt(row.rowid), c.embedding);
        }
      }
    }
    // Advance the sidecar consistency fingerprint in the SAME transaction as
    // the embedding writes, so the counter can never be ahead of a committed
    // vector or vice versa. Bulk source deletion bumps it too, from
    // `deleteIndexBySource` (see `bumpVectorWriteSeq`).
    if (rows.length > 0) bumpVectorWriteSeq(db);
  });

  insertMany(chunks);
}

/**
 * Atomically adjust the `index_totals` summary row. Callers pass the
 * delta for indexed-document count and chunk count; the function runs
 * a single UPDATE with `total_indexed += delta` semantics. Negative
 * deltas are fine (deletes). A floor of 0 is enforced via MAX so a
 * delete–insert race can't drive counters below zero.
 *
 * Must be called inside the same transaction that writes/removes the
 * underlying rows — the totals stay consistent with the real tables
 * without any expensive COUNT(*) recomputation.
 */
function adjustIndexTotals(db: Db, indexedDelta: number, chunksDelta: number): void {
  // UPDATE only — the row is seeded by `refreshIndexStats` (called at
  // worker startup). If the row doesn't exist yet (tests, fresh DB
  // before the worker runs), the UPDATE is a no-op and
  // `getIndexedDocumentCount`/`getChunkCount` fall back to the live
  // COUNT(*) which is always correct for small tables.
  db.prepare(
    `UPDATE index_totals SET
       total_indexed = MAX(0, total_indexed + ?),
       total_chunks  = MAX(0, total_chunks + ?),
       last_computed_at = ?
     WHERE id = 1`,
  ).run(indexedDelta, chunksDelta, new Date().toISOString());
}

/**
 * Incrementally adjust the `source_index_stats` summary row for one
 * source. Like `adjustIndexTotals`, callers pass deltas; a floor of 0
 * prevents negative counters.
 */
function adjustSourceIndexStats(
  db: Db,
  sourceId: string,
  indexedDelta: number,
  chunksDelta: number,
): void {
  // UPSERT: UPDATE if the row exists (common path after
  // refreshIndexStats), INSERT if it doesn't (first doc for a source
  // that hasn't been seen in a full recomputation yet).
  const updated = db
    .prepare(
      `UPDATE source_index_stats SET
         indexed_docs = MAX(0, indexed_docs + ?),
         chunks       = MAX(0, chunks + ?),
         last_computed_at = ?
       WHERE source_id = ?`,
    )
    .run(indexedDelta, chunksDelta, new Date().toISOString(), sourceId);
  if (updated.changes === 0 && indexedDelta > 0) {
    db.prepare(
      `INSERT OR IGNORE INTO source_index_stats (source_id, indexed_docs, chunks, last_computed_at)
       VALUES (?, ?, ?, ?)`,
    ).run(sourceId, indexedDelta, chunksDelta, new Date().toISOString());
  }
}

/**
 * Atomically upsert a document's chunks + summary row in one
 * transaction. Without this, a process crash between `upsertChunks` and
 * `setIndexedDocument` left chunks present without an `indexed_documents`
 * row — the next cycle treated the doc as un-indexed and re-embedded it,
 * doubling chunk_count.
 *
 * Wraps both writes plus the single-doc `clearIndexError` so the success
 * path is one atomic step. Also incrementally maintains `index_totals`
 * and `source_index_stats` so the `/index/stats` endpoint reflects
 * progress in real time during long indexing cycles rather than waiting
 * for the post-cycle `refreshIndexStats` recomputation.
 */
export function upsertChunksAndMarkIndexed(
  db: Db,
  documentId: string,
  contentHash: string,
  chunks: ChunkUpsertInput[],
  options?: IndexWriteOptions,
  sourceEventAt?: string,
): void {
  const txn = db.transaction(() => {
    // Check whether this is a new document or an update (re-index).
    const existing = db
      .prepare<
        [string],
        { chunk_count: number }
      >("SELECT chunk_count FROM indexed_documents WHERE document_id = ?")
      .get(documentId);

    upsertChunks(db, chunks, options);
    setIndexedDocument(db, documentId, contentHash, chunks.length, sourceEventAt);
    clearIndexError(db, documentId);

    // Incremental stats: new doc → +1 indexed, +N chunks.
    // Update → 0 indexed delta, chunk delta = new - old.
    const indexedDelta = existing ? 0 : 1;
    const chunksDelta = existing ? chunks.length - existing.chunk_count : chunks.length;
    adjustIndexTotals(db, indexedDelta, chunksDelta);

    // Per-source stats (all chunks in one upsert share a sourceId).
    if (chunks.length > 0) {
      adjustSourceIndexStats(db, chunks[0].sourceId, indexedDelta, chunksDelta);
    }
  });
  txn();
}

/**
 * Batch version of `upsertChunksAndMarkIndexed`: wraps multiple
 * documents' upserts in a single SQLite transaction, amortising
 * the ~10ms per-commit overhead. Each document still goes through
 * the same per-doc logic (upsertChunks, setIndexedDocument,
 * clearIndexError, adjustIndexTotals, adjustSourceIndexStats) so
 * correctness is identical to the per-doc path.
 *
 * When `isUpdate` is true for a doc, the old chunks are deleted
 * inside this transaction before inserting new ones — guaranteeing
 * atomicity so a crash between delete and re-write cannot leave a
 * document unsearchable.
 */
export function upsertChunksAndMarkIndexedBatch(
  db: Db,
  docs: Array<{
    documentId: string;
    contentHash: string;
    chunks: ChunkUpsertInput[];
    isUpdate?: boolean;
    sourceEventAt?: string;
  }>,
  options?: IndexWriteOptions,
): void {
  if (docs.length === 0) return;
  const txn = db.transaction(
    (
      items: Array<{
        documentId: string;
        contentHash: string;
        chunks: ChunkUpsertInput[];
        isUpdate?: boolean;
        sourceEventAt?: string;
      }>,
    ) => {
      for (const { documentId, contentHash, chunks, isUpdate, sourceEventAt } of items) {
        const existing = db
          .prepare<
            [string],
            { chunk_count: number }
          >("SELECT chunk_count FROM indexed_documents WHERE document_id = ?")
          .get(documentId);

        if (isUpdate) {
          // Delete old chunks inside the same transaction so a crash
          // between delete and re-write cannot leave the doc unsearchable.
          // Collect rowids before delete so their vectors are removed (or
          // enqueued for removal) too — otherwise re-indexed docs orphan
          // their old vectors (#553).
          const rowids = db
            .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
            .all(documentId)
            .map((r) => BigInt(r.rowid));
          removeOrEnqueueVectors(db, rowids, options);
          db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
        }

        upsertChunks(db, chunks, options);
        setIndexedDocument(db, documentId, contentHash, chunks.length, sourceEventAt);
        clearIndexError(db, documentId);

        const indexedDelta = existing ? 0 : 1;
        const chunksDelta = existing ? chunks.length - existing.chunk_count : chunks.length;
        adjustIndexTotals(db, indexedDelta, chunksDelta);

        if (chunks.length > 0) {
          adjustSourceIndexStats(db, chunks[0].sourceId, indexedDelta, chunksDelta);
        }
      }
    },
  );
  txn(docs);
}

/**
 * Delete index-side rows for a single document: `chunks` and
 * `indexed_documents`. Also removes the corresponding vectors from the
 * HNSW index if a usearch handle is provided.
 *
 * Returns the number of `chunks` rows removed (0 if the document had
 * none indexed yet — perfectly normal during a delete-before-index race).
 *
 * Wrapped in a transaction so a crash between the chunks delete and the
 * indexed_documents delete cannot leave the pair half-cleaned.
 * Incrementally adjusts `index_totals` and `source_index_stats` so the
 * `/index/stats` endpoint stays current without waiting for the next
 * `refreshIndexStats` recomputation.
 */
export function deleteChunksByDocument(
  db: Db,
  documentId: string,
  options?: IndexWriteOptions,
): number {
  let changes = 0;
  let usearchRowids: bigint[] | undefined;
  const txn = db.transaction(() => {
    // Capture the source_id before deleting chunks so we can adjust
    // per-source stats. All chunks for a document share the same source.
    const sourceRow = db
      .prepare<
        [string],
        { source_id: string }
      >("SELECT source_id FROM chunks WHERE document_id = ? LIMIT 1")
      .get(documentId);
    const hadIndexedRow = db
      .prepare<
        [string],
        { document_id: string }
      >("SELECT document_id FROM indexed_documents WHERE document_id = ?")
      .get(documentId);

    const rowids = db
      .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE document_id = ?")
      .all(documentId)
      .map((r) => BigInt(r.rowid));

    const info = db.prepare("DELETE FROM chunks WHERE document_id = ?").run(documentId);
    changes = info.changes;
    // `indexed_documents` is the per-doc summary row used by stats; it
    // has no FK / trigger linking it to chunks, so clear it explicitly.
    db.prepare("DELETE FROM indexed_documents WHERE document_id = ?").run(documentId);

    // With a usearch handle, defer the vector removal until after the txn
    // commits (usearch isn't transactional with SQLite). Without one (the
    // HTTP path), enqueue the rowids atomically with the chunk delete.
    if (options?.usearch) {
      usearchRowids = rowids;
    } else {
      removeOrEnqueueVectors(db, rowids, options);
    }

    // Adjust totals: -1 doc if there was an indexed_documents row, -N chunks.
    const indexedDelta = hadIndexedRow ? -1 : 0;
    if (indexedDelta !== 0 || changes > 0) {
      adjustIndexTotals(db, indexedDelta, -changes);
    }
    if (sourceRow && (indexedDelta !== 0 || changes > 0)) {
      adjustSourceIndexStats(db, sourceRow.source_id, indexedDelta, -changes);
    }
    if (rowids.length > 0) bumpVectorWriteSeq(db);
  });
  txn();
  if (usearchRowids?.length && options?.usearch) {
    options.usearch.removeBatch(usearchRowids);
  }
  return changes;
}

export interface DocumentIndexDeleteBatchResult {
  deletedChunks: number;
  complete: boolean;
  /** The final batch is held until the authoritative source row is gone. */
  readyForSourceDelete: boolean;
}

/**
 * Cooperatively delete at most `limit` chunks for one document.
 *
 * Retention calls this once per scheduler tick. The indexed-document summary
 * row is removed only by the final batch, preserving a crash-safe retry token;
 * vector rowids are removed through the live usearch handle (worker path) or
 * the durable pending-delete queue (direct fallback).
 */
export function deleteChunksByDocumentBatch(
  db: Db,
  documentId: string,
  limit: number,
  sourceDeleted: boolean,
  options?: IndexWriteOptions,
): DocumentIndexDeleteBatchResult {
  const safeLimit = Math.max(1, Math.floor(limit));
  let deletedChunks = 0;
  let complete = false;
  let readyForSourceDelete = false;
  let usearchRowids: bigint[] | undefined;
  const txn = db.transaction(() => {
    const chunkRows = db
      .prepare<
        [string, number],
        { rowid: number; source_id: string }
      >("SELECT rowid, source_id FROM chunks WHERE document_id = ? ORDER BY rowid LIMIT ?")
      .all(documentId, safeLimit + 1);
    if (!sourceDeleted && chunkRows.length <= safeLimit) {
      // Keep the final searchable rows and indexed_documents summary as a
      // retry token. The main writer now tombstones/deletes the source doc;
      // only a subsequent call may finalize this index side.
      readyForSourceDelete = true;
      return;
    }
    const selectedRows = chunkRows.slice(0, safeLimit);
    const rowids = selectedRows.map((row) => BigInt(row.rowid));
    if (rowids.length > 0) {
      const placeholders = rowids.map(() => "?").join(", ");
      deletedChunks = db
        .prepare(`DELETE FROM chunks WHERE rowid IN (${placeholders})`)
        .run(...rowids.map(Number)).changes;
      // Journal every vector removal in the same SQLite transaction as the
      // lexical-row delete. The live worker removes it immediately below, but
      // the durable row survives until a graph save publishes that mutation,
      // so a crash between batches cannot strand an HNSW-only vector.
      removeOrEnqueueVectors(db, rowids);
      if (options?.usearch) usearchRowids = rowids;
      adjustIndexTotals(db, 0, -deletedChunks);
      const sourceId = selectedRows[0]?.source_id;
      if (sourceId) adjustSourceIndexStats(db, sourceId, 0, -deletedChunks);
      bumpVectorWriteSeq(db);
    }

    const remaining =
      db
        .prepare<
          [string],
          { present: number }
        >("SELECT 1 AS present FROM chunks WHERE document_id = ? LIMIT 1")
        .get(documentId) !== undefined;
    complete = sourceDeleted && !remaining;
    if (complete) {
      const indexed = db
        .prepare("DELETE FROM indexed_documents WHERE document_id = ?")
        .run(documentId).changes;
      if (indexed > 0) {
        adjustIndexTotals(db, -1, 0);
        const sourceId = selectedRows[0]?.source_id;
        if (sourceId) adjustSourceIndexStats(db, sourceId, -1, 0);
      }
    }
  });
  txn();
  if (usearchRowids?.length && options?.usearch) {
    options.usearch.removeBatch(usearchRowids);
  }
  return { deletedChunks, complete, readyForSourceDelete };
}

/**
 * Distinct `source_url` values currently stored on a document's chunks.
 * Normally a one-element array (every chunk of a doc shares the doc's URL),
 * but returns the full set so a caller can detect any drift. Used by the
 * indexer to decide whether a URL-only change needs propagating to the
 * denormalized column. See #462.
 */
export function getChunkSourceUrls(db: Db, documentId: string): Array<string | null> {
  return db
    .prepare<[string], { source_url: string | null }>(
      "SELECT DISTINCT source_url FROM chunks WHERE document_id = ?",
    )
    .all(documentId)
    .map((r) => r.source_url);
}

/**
 * Update the denormalized `chunks.source_url` for every chunk of a document
 * in place — no chunk regeneration, no re-embed. Used when a document's
 * canonical source URL changed but its content hash did not (e.g. after a
 * URL-canonicalizer change re-derives `documents.source_url`), so search
 * results stop serving the stale URL. Returns the number of chunk rows
 * touched. See #462.
 */
export function updateChunkSourceUrls(
  db: Db,
  documentId: string,
  sourceUrl: string | null,
): number {
  return db
    .prepare<[string | null, string]>("UPDATE chunks SET source_url = ? WHERE document_id = ?")
    .run(sourceUrl, documentId).changes;
}

/**
 * Refresh denormalized fields that participate in filtering/display but not
 * in the embedding input. The current vectors remain valid.
 */
export function updateChunkNonEmbeddingMetadata(
  db: Db,
  documentId: string,
  metadata: {
    sourceUrl: string | null;
    tags: string[] | undefined;
    relevanceScore: number | undefined;
  },
): number {
  return db
    .prepare(
      `UPDATE chunks
          SET source_url = ?, tags = ?, relevance_score = ?
        WHERE document_id = ?`,
    )
    .run(
      metadata.sourceUrl,
      metadata.tags ? JSON.stringify(metadata.tags) : null,
      metadata.relevanceScore ?? null,
      documentId,
    ).changes;
}

/**
 * Distinct `source_id` values that currently own chunks. The candidate set for
 * the source-attribution reconcile — typically one row per live source, so it
 * stays cheap (`idx_chunks_source` covers the DISTINCT scan).
 */
export function getIndexedSourceIds(db: Db): string[] {
  return db
    .prepare<[], { source_id: string }>("SELECT DISTINCT source_id FROM chunks")
    .all()
    .map((r) => r.source_id);
}

/**
 * Distinct `document_id`s whose chunks are currently attributed to `sourceId`.
 * Used by the source-attribution reconcile to look up each document's current
 * source in the gateway before re-pointing.
 */
export function getChunkDocumentIdsBySource(db: Db, sourceId: string): string[] {
  return db
    .prepare<[string], { document_id: string }>(
      "SELECT DISTINCT document_id FROM chunks WHERE source_id = ?",
    )
    .all(sourceId)
    .map((r) => r.document_id);
}

/**
 * Re-point the denormalized `chunks.source_id` for a set of documents onto a
 * new source in place — no chunk regeneration, no re-embed. Used when a
 * document was re-homed onto a different source without a content change, so
 * the per-source index stats stop counting it under the retired source.
 * Returns the number of chunk rows touched. The `source_id` mismatch guard
 * keeps it idempotent. Chunked under SQLite's per-statement parameter cap.
 */
export function repointChunkSource(db: Db, documentIds: string[], newSourceId: string): number {
  if (documentIds.length === 0) return 0;
  const CHUNK = 500;
  let changed = 0;
  const txn = db.transaction((ids: string[]) => {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      const placeholders = slice.map(() => "?").join(", ");
      changed += db
        .prepare<
          string[]
        >(`UPDATE chunks SET source_id = ? WHERE source_id <> ? AND document_id IN (${placeholders})`)
        .run(newSourceId, newSourceId, ...slice).changes;
    }
  });
  txn(documentIds);
  return changed;
}

/**
 * Bulk version of `deleteChunksByDocument` for the per-doc delete cascade
 * paths. Wraps the loop in a single transaction so a mid-flight crash
 * doesn't leave half-cleaned index state.
 */
export function deleteChunksByDocuments(
  db: Db,
  documentIds: string[],
  options?: IndexWriteOptions,
): number {
  if (documentIds.length === 0) return 0;
  let deleted = 0;
  const txn = db.transaction((ids: string[]) => {
    for (const id of ids) {
      deleted += deleteChunksByDocument(db, id, options);
    }
  });
  txn(documentIds);
  return deleted;
}

/**
 * Delete all index data for a given source: chunks, indexed_documents,
 * indexing_errors, and the source_index_stats summary row.
 * Returns the number of indexed documents removed.
 */
export function deleteIndexBySource(db: Db, sourceId: string, options?: IndexWriteOptions): number {
  return db.transaction(() => deleteIndexBySourceInner(db, sourceId, options))();
}

/** Persist a source-wide index purge obligation before acknowledging it. */
export function enqueueSourceIndexPurge(db: Db, sourceId: string): void {
  db.prepare(
    "INSERT INTO pending_source_index_purges (source_id, queued_at) VALUES (?, ?) ON CONFLICT(source_id) DO NOTHING",
  ).run(sourceId, Date.now());
}

/** Source-wide index purges that must survive a worker restart. */
export function listPendingSourceIndexPurges(db: Db): string[] {
  return db
    .prepare<[], { source_id: string }>(
      "SELECT source_id FROM pending_source_index_purges ORDER BY queued_at, source_id",
    )
    .all()
    .map((row) => row.source_id);
}

/**
 * Remove every queued source from the SQLite/FTS index while retaining the
 * durable obligations until the worker publishes the corresponding HNSW
 * removals. The gateway runs this before opening its search snapshot or
 * listener, so a crash between enqueue and delete cannot make removed content
 * lexically searchable during model or graph startup.
 */
export function scrubPendingSourceIndexPurges(db: Db): {
  sourceIds: string[];
  deletedDocuments: number;
} {
  const sourceIds = listPendingSourceIndexPurges(db);
  let deletedDocuments = 0;
  const scrub = db.transaction(() => {
    for (const sourceId of sourceIds) {
      deletedDocuments += deleteIndexBySourceInner(db, sourceId);
    }
  });
  scrub();
  return { sourceIds, deletedDocuments };
}

/** Clear only obligations whose delete and graph publication both succeeded. */
export function completeSourceIndexPurges(db: Db, sourceIds: readonly string[]): void {
  if (sourceIds.length === 0) return;
  db.prepare(
    "DELETE FROM pending_source_index_purges WHERE source_id IN (SELECT value FROM json_each(?))",
  ).run(JSON.stringify(sourceIds));
}

export interface PendingDocumentIndexPurge {
  documentId: string;
  sourceDeleted: boolean;
}

/** Persist one per-document cleanup before acknowledging a retention batch. */
export function enqueueDocumentIndexPurge(
  db: Db,
  documentId: string,
  sourceDeleted: boolean,
): void {
  db.prepare(
    `INSERT INTO pending_document_index_purges (document_id, source_deleted, queued_at)
     VALUES (?, ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       source_deleted = MAX(source_deleted, excluded.source_deleted)`,
  ).run(documentId, sourceDeleted ? 1 : 0, Date.now());
}

export function listPendingDocumentIndexPurges(
  db: Db,
  options: { limit?: number; sourceDeletedOnly?: boolean } = {},
): PendingDocumentIndexPurge[] {
  const limit = options.limit === undefined ? null : Math.max(1, Math.floor(options.limit));
  return db
    .prepare<[number, number | null], { document_id: string; source_deleted: number }>(
      `SELECT document_id, source_deleted
         FROM pending_document_index_purges
        WHERE (? = 0 OR source_deleted = 1)
        ORDER BY queued_at, document_id
        LIMIT COALESCE(?, -1)`,
    )
    .all(options.sourceDeletedOnly ? 1 : 0, limit)
    .map((row) => ({
      documentId: row.document_id,
      sourceDeleted: row.source_deleted !== 0,
    }));
}

export function completeDocumentIndexPurges(db: Db, documentIds: readonly string[]): void {
  if (documentIds.length === 0) return;
  db.prepare(
    "DELETE FROM pending_document_index_purges WHERE document_id IN (SELECT value FROM json_each(?))",
  ).run(JSON.stringify(documentIds));
}

/**
 * The body of {@link deleteIndexBySource}, run inside one transaction so a
 * failure part-way cannot leave the counters disagreeing with the rows, and so
 * `bumpVectorWriteSeq` commits with the removals it describes.
 */
function deleteIndexBySourceInner(db: Db, sourceId: string, options?: IndexWriteOptions): number {
  // Find document IDs from chunks (chunks has source_id, indexed_documents doesn't)
  const docIds = db
    .prepare<[string], { document_id: string }>(
      "SELECT DISTINCT document_id FROM chunks WHERE source_id = ?",
    )
    .all(sourceId)
    .map((r) => r.document_id);

  // Count chunks before deletion so we can adjust index_totals.
  const chunkCountRow = db
    .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM chunks WHERE source_id = ?")
    .get(sourceId);
  const chunkCount = chunkCountRow?.c ?? 0;

  const usearchRowids = db
    .prepare<[string], { rowid: number }>("SELECT rowid FROM chunks WHERE source_id = ?")
    .all(sourceId)
    .map((r) => BigInt(r.rowid));
  removeOrEnqueueVectors(db, usearchRowids, options);

  // Always wipe the source's stats row and any error rows, even if there
  // are no live chunks (the source could have been partially cleaned by a
  // previous run, or had only failed docs).
  db.prepare("DELETE FROM source_index_stats WHERE source_id = ?").run(sourceId);
  db.prepare("DELETE FROM indexing_errors WHERE source_id = ?").run(sourceId);

  if (docIds.length === 0) return 0;

  db.prepare("DELETE FROM chunks WHERE source_id = ?").run(sourceId);
  // One statement rather than one per document: this runs on the worker's
  // message-handling turn, where a large source would otherwise mean thousands
  // of statement compilations.
  db.prepare(
    "DELETE FROM indexed_documents WHERE document_id IN (SELECT value FROM json_each(?))",
  ).run(JSON.stringify(docIds));

  // Adjust global totals to reflect the bulk removal.
  adjustIndexTotals(db, -docIds.length, -chunkCount);

  // A removal moves the fingerprint too. It guards against an on-disk graph
  // that does not match the database, and a graph still holding vectors whose
  // chunks are gone — a delete that was never saved — is exactly that. Leaving
  // it untouched let a restore accept the stale graph and skip the rebuild.
  bumpVectorWriteSeq(db);

  return docIds.length;
}

/**
 * Single-row reads from index_totals. `SELECT COUNT(*) FROM chunks` on
 * 260k+ rows takes ~400ms and runs on the main thread — swap it for a
 * pre-aggregated row maintained by the indexer worker. When the
 * materialized row isn't there yet (fresh DB before the worker runs,
 * or small in-process test databases without a worker), fall back to
 * the live COUNT — that's cheap on an empty/small table and keeps
 * tests working without having to mock a worker.
 */
export function getChunkCount(db: Db): number {
  const row = db
    .prepare<[], { total_chunks: number }>("SELECT total_chunks FROM index_totals WHERE id = 1")
    .get();
  if (row) return row.total_chunks;
  return (
    db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM chunks").get()?.count ?? 0
  );
}

export function getIndexedDocumentCount(db: Db): number {
  const row = db
    .prepare<[], { total_indexed: number }>("SELECT total_indexed FROM index_totals WHERE id = 1")
    .get();
  if (row) return row.total_indexed;
  return (
    db.prepare<[], { count: number }>("SELECT COUNT(*) as count FROM indexed_documents").get()
      ?.count ?? 0
  );
}

/**
 * The number of documents a generation rebuild will actually embed — distinct
 * `document_id` over `chunks` (the table the builder walks). This is the honest
 * denominator for the migration percentage (epic #1011): both `docs_total` (the
 * {@link createBuildingIndexVersion} seed) and `docs_built` (the builder's
 * progress counter) must count THIS same population, so the percentage reaches
 * exactly 100% at completion. It differs from {@link getIndexedDocumentCount}
 * (which counts `indexed_documents`): a document with no chunk — e.g. empty
 * content — is in `indexed_documents` but never embedded, so seeding the
 * denominator from that count would leave the build stuck below 100%.
 */
export function getBuildableDocumentCount(db: Db): number {
  return (
    db.prepare<[], { c: number }>("SELECT COUNT(DISTINCT document_id) AS c FROM chunks").get()?.c ??
    0
  );
}

/**
 * Get per-source indexed date ranges. Served from source_index_stats —
 * the underlying `MIN/MAX(source_created_at) GROUP BY source_id` over
 * chunks is a ~19s scan at 260k chunks.
 */
export function getIndexDateRangeBySource(
  db: Db,
): Record<string, { earliest: string; latest: string }> {
  const rows = db
    .prepare<
      [],
      { source_id: string; earliest: string | null; latest: string | null }
    >("SELECT source_id, earliest_source_date AS earliest, latest_source_date AS latest FROM source_index_stats")
    .all();
  const result: Record<string, { earliest: string; latest: string }> = {};
  for (const row of rows) {
    if (row.earliest && row.latest) {
      result[row.source_id] = { earliest: row.earliest, latest: row.latest };
    }
  }
  return result;
}

/**
 * Record (or increment) a per-document indexing error. Stored in the
 * `indexing_errors` table so it survives gateway restarts — before this,
 * the in-memory retry set was the only record, and a crash left failed
 * docs stuck behind the watermark with no signal to the user.
 */
export function recordIndexError(
  db: Db,
  documentId: string,
  sourceId: string,
  error: string,
): void {
  db.prepare(
    `INSERT INTO indexing_errors
       (document_id, source_id, error, failed_at, attempts, severity, truncated_chunks, dropped_chunks)
     VALUES (?, ?, ?, ?, 1, 'error', 0, 0)
     ON CONFLICT(document_id) DO UPDATE SET
       source_id = excluded.source_id,
       error = excluded.error,
       failed_at = excluded.failed_at,
       attempts = attempts + 1,
       severity = 'error',
       truncated_chunks = 0,
       dropped_chunks = 0`,
  ).run(documentId, sourceId, error, new Date().toISOString());
}

/**
 * Record that a document was indexed but degraded — some chunks were truncated
 * to fit the embedder's token window and/or dropped because they were
 * unembeddable. Call right after marking the doc indexed (the mark clears any
 * prior row first). The document still counts toward `total_indexed`; this row
 * is purely the data-quality signal surfaced on /index/stats.
 */
export function recordIndexDegraded(
  db: Db,
  documentId: string,
  sourceId: string,
  truncatedChunks: number,
  droppedChunks: number,
): void {
  const parts: string[] = [];
  if (truncatedChunks > 0) parts.push(`${truncatedChunks} chunk(s) truncated to fit token window`);
  if (droppedChunks > 0) parts.push(`${droppedChunks} unembeddable chunk(s) dropped`);
  const message = `degraded: ${parts.join(", ")}`;
  db.prepare(
    `INSERT INTO indexing_errors
       (document_id, source_id, error, failed_at, attempts, severity, truncated_chunks, dropped_chunks)
     VALUES (?, ?, ?, ?, 1, 'degraded', ?, ?)
     ON CONFLICT(document_id) DO UPDATE SET
       source_id = excluded.source_id,
       error = excluded.error,
       failed_at = excluded.failed_at,
       severity = 'degraded',
       truncated_chunks = excluded.truncated_chunks,
       dropped_chunks = excluded.dropped_chunks`,
  ).run(documentId, sourceId, message, new Date().toISOString(), truncatedChunks, droppedChunks);
}

/** Document ids currently recorded as hard errors (severity = 'error'). */
export function getErroredDocumentIds(db: Db): string[] {
  return db
    .prepare<[], { document_id: string }>(
      "SELECT document_id FROM indexing_errors WHERE severity = 'error'",
    )
    .all()
    .map((r) => r.document_id);
}

/** Clear a doc's error/degraded row (call on successful index or on delete). */
export function clearIndexError(db: Db, documentId: string): void {
  db.prepare("DELETE FROM indexing_errors WHERE document_id = ?").run(documentId);
}

/** Per-source count of hard-failing (un-indexed) documents. */
export function getIndexErrorCountsBySource(db: Db): Record<string, number> {
  const rows = db
    .prepare<
      [],
      { source_id: string; count: number }
    >("SELECT source_id, COUNT(*) AS count FROM indexing_errors WHERE severity = 'error' GROUP BY source_id")
    .all();
  const result: Record<string, number> = {};
  for (const row of rows) result[row.source_id] = row.count;
  return result;
}

/**
 * Per-source degraded-document stats: how many indexed docs lost fidelity, and
 * the total chunks truncated / dropped across them.
 */
export function getDegradedStatsBySource(
  db: Db,
): Record<string, { docs: number; truncatedChunks: number; droppedChunks: number }> {
  const rows = db
    .prepare<[], { source_id: string; docs: number; truncated: number; dropped: number }>(
      `SELECT source_id,
              COUNT(*) AS docs,
              COALESCE(SUM(truncated_chunks), 0) AS truncated,
              COALESCE(SUM(dropped_chunks), 0) AS dropped
       FROM indexing_errors
       WHERE severity = 'degraded'
       GROUP BY source_id`,
    )
    .all();
  const result: Record<string, { docs: number; truncatedChunks: number; droppedChunks: number }> =
    {};
  for (const row of rows) {
    result[row.source_id] = {
      docs: row.docs,
      truncatedChunks: row.truncated,
      droppedChunks: row.dropped,
    };
  }
  return result;
}

/**
 * Get per-source indexing stats. Served from source_index_stats — the
 * underlying `COUNT(DISTINCT document_id), COUNT(*) GROUP BY source_id`
 * over chunks is a ~14s scan at 260k chunks.
 */
export function getIndexStatsBySource(
  db: Db,
): Record<string, { indexedDocs: number; chunks: number }> {
  const cached = db
    .prepare<
      [],
      { source_id: string; docs: number; chunks: number }
    >("SELECT source_id, indexed_docs AS docs, chunks FROM source_index_stats")
    .all();
  if (cached.length > 0) {
    const result: Record<string, { indexedDocs: number; chunks: number }> = {};
    for (const row of cached) {
      result[row.source_id] = { indexedDocs: row.docs, chunks: row.chunks };
    }
    return result;
  }
  const live = db
    .prepare<[], { source_id: string; docs: number; chunks: number }>(
      `SELECT source_id, COUNT(DISTINCT document_id) AS docs, COUNT(*) AS chunks
       FROM chunks GROUP BY source_id`,
    )
    .all();
  const result: Record<string, { indexedDocs: number; chunks: number }> = {};
  for (const row of live) {
    result[row.source_id] = { indexedDocs: row.docs, chunks: row.chunks };
  }
  return result;
}

/**
 * Recompute per-source index stats + index totals and upsert into the
 * summary tables. Must run in the indexer worker — the queries are
 * 14-19s scans of the chunks table.
 */
export function refreshIndexStats(db: Db): void {
  const now = new Date().toISOString();

  const perSource = db
    .prepare<
      [],
      {
        source_id: string;
        docs: number;
        chunks: number;
        earliest: string | null;
        latest: string | null;
      }
    >(
      `SELECT source_id,
              COUNT(DISTINCT document_id) AS docs,
              COUNT(*) AS chunks,
              MIN(source_created_at) AS earliest,
              MAX(source_created_at) AS latest
       FROM chunks GROUP BY source_id`,
    )
    .all();

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM source_index_stats").run();
    for (const row of perSource) {
      db.prepare(
        `INSERT INTO source_index_stats (
           source_id, indexed_docs, chunks, earliest_source_date, latest_source_date, last_computed_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(row.source_id, row.docs, row.chunks, row.earliest, row.latest, now);
    }

    const totalsRow = db
      .prepare<
        [],
        { docs: number; chunks: number }
      >("SELECT COUNT(*) AS docs FROM indexed_documents")
      .get();
    const totalIndexed = totalsRow?.docs ?? 0;
    const totalChunks = perSource.reduce((s, r) => s + Number(r.chunks), 0);

    db.prepare(
      `INSERT INTO index_totals (id, total_indexed, total_chunks, last_computed_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         total_indexed = excluded.total_indexed,
         total_chunks = excluded.total_chunks,
         last_computed_at = excluded.last_computed_at`,
    ).run(totalIndexed, totalChunks, now);
  });
  tx();
}
