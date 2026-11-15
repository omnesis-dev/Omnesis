// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The full-text index's versions in `index.db`: which version is active, and
 * building the next one beside it without interrupting search.
 *
 * `chunks_fts` is always the active index, cut by the version recorded in
 * `lexical_index_state.active_version` (see search/lexical-versions.ts). When
 * the running build targets another version, the indexer builds
 * `chunks_fts_next` with the target's rules while `chunks_fts` keeps serving:
 *
 * 1. **Start.** Create `chunks_fts_next` and record the build with a cursor at
 *    0 and a high-water mark at the largest chunk rowid.
 * 2. **Backfill.** Copy chunks with rowids in (cursor, high-water mark] in
 *    batches, advancing the cursor in the same transaction. Each batch is one
 *    short write, so the indexer interleaves it with its other work and a
 *    restart resumes from the cursor.
 * 3. **Dual writes.** Triggers keep `chunks_fts_next` current for every chunk
 *    the backfill has passed (rowid at or below the cursor) or will never reach
 *    (above the high-water mark); the rows in between are read by the backfill
 *    when it gets to them. A chunk is therefore indexed exactly once, and a
 *    delete removes exactly what was indexed for it.
 * 4. **Switch.** Once backfilled, one transaction moves `chunks_fts` aside as
 *    `chunks_fts_retired`, renames `chunks_fts_next` to `chunks_fts`, points
 *    the active triggers at it and records the new active version. Search
 *    reads the version and the table in one snapshot, so it never cuts a query
 *    for one version and matches it against the other.
 * 5. **Retire.** Later steps empty the retired table in batches, then drop
 *    it; dropping a large index in one statement would hold the write lock
 *    for seconds.
 *
 * A build whose version is no longer the target (a newer version arrived, or
 * the active index already matches) is retired the same way and, when needed,
 * a build of the current target starts from scratch. There is at most one
 * active index and one being built.
 *
 * An active index recorded at a version this build does not know (a newer
 * release built it) and built from rewritten text cannot be kept current, so
 * it keeps no triggers: it stays as it was until the rebuild replaces it.
 *
 * Every step is small and runs on whichever connection owns index.db writes;
 * nothing here blocks startup beyond creating an empty table.
 */

import {
  analyze,
  lexicalVersion,
  targetLexicalVersion,
  unversionedLexicalRules,
  type LexicalVersion,
} from "../search/lexical-versions.js";
import type Database from "better-sqlite3";
type Db = Database.Database;

export const ACTIVE_FTS = "chunks_fts";
export const NEXT_FTS = "chunks_fts_next";
const RETIRED_FTS = "chunks_fts_retired";
const ACTIVE_VOCAB = "chunks_fts_vocab";

/** SQL function: `lexical_text(version, text)` cuts `text` by `version`'s rewrite. */
const LEXICAL_TEXT_FN = "lexical_text";

/**
 * Register the SQL function the full-text triggers and content views call.
 * Every handle that writes chunks or reads a versioned content view needs it.
 */
export function registerLexicalFunctions(db: Db): void {
  db.function(LEXICAL_TEXT_FN, { deterministic: true }, (version: unknown, text: unknown) => {
    if (typeof text !== "string" || typeof version !== "number") return text;
    const rules = lexicalVersion(version);
    return rules ? analyze(rules, text) : text;
  });
}

export interface LexicalBuild {
  version: number;
  /** Largest chunk rowid the backfill has copied. */
  cursor: number;
  /** Largest chunk rowid when the build started; the backfill stops there. */
  highWater: number;
  /** Chunks copied so far. */
  done: number;
  /** Chunks when the build started. */
  total: number;
  startedAt: string;
  /** Set once every chunk is in the new index; the build then waits for the switch. */
  backfilledAt: string | null;
}

export interface LexicalIndexState {
  /** The active index's rules, or null when there is none yet. */
  active: LexicalVersion | null;
  build: LexicalBuild | null;
  target: LexicalVersion;
}

interface StateRow {
  active_version: number | null;
  build_version: number | null;
  build_cursor: number;
  build_hwm: number;
  build_done: number;
  build_total: number;
  build_started_at: string | null;
  build_backfilled_at: string | null;
}

function tableExists(db: Db, name: string): boolean {
  return (
    db
      .prepare<[string], { n: number }>("SELECT count(*) AS n FROM sqlite_master WHERE name = ?")
      .get(name)?.n === 1
  );
}

/** The `tokenize=` argument a full-text table was created with. */
function tokenizeOf(db: Db, table: string): string | null {
  const ddl = db
    .prepare<[string], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = ?")
    .get(table)?.sql;
  const match = ddl?.match(/tokenize\s*=\s*'((?:[^']|'')*)'/i);
  return match ? match[1].replace(/''/g, "'") : null;
}

/** The `content=` table or view a full-text table indexes. */
function contentOf(db: Db, table: string): string | null {
  const ddl = db
    .prepare<[string], { sql: string }>("SELECT sql FROM sqlite_master WHERE name = ?")
    .get(table)?.sql;
  return ddl?.match(/content\s*=\s*'([^']*)'/i)?.[1] ?? null;
}

function readRow(db: Db): StateRow | undefined {
  return db.prepare<[], StateRow>("SELECT * FROM lexical_index_state WHERE id = 1").get();
}

/**
 * The rules an index recorded as `version` is searched with. A version this
 * build does not know (the index was built by a newer release) is searched with
 * its table's tokenizer and no rewrite until it is rebuilt.
 */
function rulesFor(db: Db, version: number, table: string): LexicalVersion {
  return lexicalVersion(version) ?? { version, tokenize: tokenizeOf(db, table) ?? "unicode61" };
}

/** The active index, the build in progress and the target, as recorded. */
export function readLexicalIndexState(db: Db): LexicalIndexState {
  const row = readRow(db);
  const target = targetLexicalVersion();
  const active =
    row?.active_version == null || !tableExists(db, ACTIVE_FTS)
      ? null
      : rulesFor(db, row.active_version, ACTIVE_FTS);
  const build =
    row?.build_version == null
      ? null
      : {
          version: row.build_version,
          cursor: row.build_cursor,
          highWater: row.build_hwm,
          done: row.build_done,
          total: row.build_total,
          startedAt: row.build_started_at ?? "",
          backfilledAt: row.build_backfilled_at,
        };
  return { active, build, target };
}

/** The active index's rules, or null when there is none. */
export function activeLexicalRules(db: Db): LexicalVersion | null {
  const row = db
    .prepare<[], { v: number | null }>(
      "SELECT active_version AS v FROM lexical_index_state WHERE id = 1",
    )
    .get();
  if (row?.v == null) return null;
  return rulesFor(db, row.v, ACTIVE_FTS);
}

/** The rules of the build in progress, for searching `chunks_fts_next` before the switch. */
export function buildingLexicalRules(db: Db): LexicalVersion | null {
  const version = readRow(db)?.build_version;
  return version == null ? null : rulesFor(db, version, NEXT_FTS);
}

/** Name of the content source an index of `rules` reads: `chunks`, or a view applying the rewrite. */
function contentSource(rules: LexicalVersion): string {
  return rules.rewrite ? `chunks_lexical_v${rules.version}` : "chunks";
}

function ensureContentView(db: Db, rules: LexicalVersion): void {
  if (!rules.rewrite) return;
  db.exec(`
    CREATE VIEW IF NOT EXISTS ${contentSource(rules)} AS
      SELECT rowid AS rowid,
             ${LEXICAL_TEXT_FN}(${rules.version}, content) AS content,
             ${LEXICAL_TEXT_FN}(${rules.version}, title) AS title
      FROM chunks
  `);
}

/** SQL for `column` of a chunk row (`new` or `old`) as `rules` index it. */
function analyzed(rules: LexicalVersion, column: string): string {
  return rules.rewrite ? `${LEXICAL_TEXT_FN}(${rules.version}, ${column})` : column;
}

function createFtsTable(db: Db, table: string, rules: LexicalVersion): void {
  ensureContentView(db, rules);
  db.exec(`
    CREATE VIRTUAL TABLE ${table} USING fts5(
      content,
      title,
      content='${contentSource(rules)}',
      content_rowid='rowid',
      tokenize='${rules.tokenize.replace(/'/g, "''")}'
    )
  `);
}

const CHANGED =
  "old.content IS NOT new.content OR old.title IS NOT new.title OR old.rowid != new.rowid";

const ACTIVE_TRIGGERS = ["chunks_ai", "chunks_ad", "chunks_au"] as const;

/** The triggers keeping the active index in step with `chunks`, by name. */
function activeTriggerSql(rules: LexicalVersion): Record<(typeof ACTIVE_TRIGGERS)[number], string> {
  const v = (row: string, col: string) => analyzed(rules, `${row}.${col}`);
  return {
    chunks_ai: `CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO ${ACTIVE_FTS}(rowid, content, title)
      VALUES (new.rowid, ${v("new", "content")}, ${v("new", "title")});
    END`,
    chunks_ad: `CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO ${ACTIVE_FTS}(${ACTIVE_FTS}, rowid, content, title)
      VALUES ('delete', old.rowid, ${v("old", "content")}, ${v("old", "title")});
    END`,
    chunks_au: `CREATE TRIGGER chunks_au AFTER UPDATE ON chunks WHEN ${CHANGED} BEGIN
      INSERT INTO ${ACTIVE_FTS}(${ACTIVE_FTS}, rowid, content, title)
      VALUES ('delete', old.rowid, ${v("old", "content")}, ${v("old", "title")});
      INSERT INTO ${ACTIVE_FTS}(rowid, content, title)
      VALUES (new.rowid, ${v("new", "content")}, ${v("new", "title")});
    END`,
  };
}

function createActiveTriggers(db: Db, rules: LexicalVersion): void {
  for (const sql of Object.values(activeTriggerSql(rules))) db.exec(sql);
}

/**
 * The rules this build can keep the active index current with, or null when
 * it cannot: the index records a version this build does not know (a newer
 * release built it) and indexes rewritten text, so neither new chunks nor
 * deletions could be analyzed the way the index was. An unknown version that
 * indexes `chunks` directly needs no rewrite, so its tokenizer is enough.
 */
function maintainableActiveRules(db: Db, version: number): LexicalVersion | null {
  const known = lexicalVersion(version);
  if (known) return known;
  return contentOf(db, ACTIVE_FTS) === "chunks" ? rulesFor(db, version, ACTIVE_FTS) : null;
}

/**
 * Make the active index's triggers the ones this build would create: the
 * current shape for rules it can maintain, none for an index it cannot. An
 * index without triggers stays as it was, intact but missing later changes,
 * until the rebuild to the target version replaces it. Changes nothing when
 * the triggers already match.
 */
function syncActiveTriggers(db: Db, rules: LexicalVersion | null): void {
  const existing = new Map(
    db
      .prepare<[], { name: string; sql: string }>(
        `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
         AND name IN (${ACTIVE_TRIGGERS.map((n) => `'${n}'`).join(", ")})`,
      )
      .all()
      .map((r) => [r.name, r.sql]),
  );
  const wanted = rules ? activeTriggerSql(rules) : null;
  const matches = ACTIVE_TRIGGERS.every((name) =>
    wanted ? existing.get(name) === wanted[name] : !existing.has(name),
  );
  if (matches) return;
  dropActiveTriggers(db);
  if (rules) createActiveTriggers(db, rules);
}

function dropActiveTriggers(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TRIGGER IF EXISTS chunks_au;
  `);
}

/** A chunk the next index must track now: already backfilled, or past the backfill's end. */
function tracked(rowid: string): string {
  return `(${rowid} <= (SELECT build_cursor FROM lexical_index_state WHERE id = 1)
           OR ${rowid} > (SELECT build_hwm FROM lexical_index_state WHERE id = 1))`;
}

/** Triggers keeping the index being built in step with `chunks` (see the module comment, step 3). */
function createNextTriggers(db: Db, rules: LexicalVersion): void {
  const v = (row: string, col: string) => analyzed(rules, `${row}.${col}`);
  db.exec(`
    CREATE TRIGGER ${NEXT_FTS}_ai AFTER INSERT ON chunks WHEN ${tracked("new.rowid")} BEGIN
      INSERT INTO ${NEXT_FTS}(rowid, content, title)
      VALUES (new.rowid, ${v("new", "content")}, ${v("new", "title")});
    END;
    CREATE TRIGGER ${NEXT_FTS}_ad AFTER DELETE ON chunks WHEN ${tracked("old.rowid")} BEGIN
      INSERT INTO ${NEXT_FTS}(${NEXT_FTS}, rowid, content, title)
      VALUES ('delete', old.rowid, ${v("old", "content")}, ${v("old", "title")});
    END;
    CREATE TRIGGER ${NEXT_FTS}_au AFTER UPDATE ON chunks WHEN ${CHANGED} BEGIN
      INSERT INTO ${NEXT_FTS}(${NEXT_FTS}, rowid, content, title)
      SELECT 'delete', old.rowid, ${v("old", "content")}, ${v("old", "title")}
      WHERE ${tracked("old.rowid")};
      INSERT INTO ${NEXT_FTS}(rowid, content, title)
      SELECT new.rowid, ${v("new", "content")}, ${v("new", "title")}
      WHERE ${tracked("new.rowid")};
    END;
  `);
}

function dropNextTriggers(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS ${NEXT_FTS}_ai;
    DROP TRIGGER IF EXISTS ${NEXT_FTS}_ad;
    DROP TRIGGER IF EXISTS ${NEXT_FTS}_au;
  `);
}

function setActiveVersion(db: Db, version: number | null): void {
  db.prepare(
    `INSERT INTO lexical_index_state (id, active_version) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET active_version = excluded.active_version`,
  ).run(version);
}

function clearBuild(db: Db): void {
  db.exec(`
    UPDATE lexical_index_state
    SET build_version = NULL, build_cursor = 0, build_hwm = 0, build_done = 0, build_total = 0,
        build_started_at = NULL, build_backfilled_at = NULL
    WHERE id = 1
  `);
}

/**
 * Set up the full-text index when `index.db` opens: record the active version
 * of an index that predates versions, and create the index of a new database.
 * Cheap on every path; any rebuild happens later, step by step
 * ({@link lexicalRebuildStep}).
 *
 * `hadChunksFts` is whether `chunks_fts` existed before this open.
 */
export function ensureLexicalIndex(db: Db, hadChunksFts: boolean): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lexical_index_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_version INTEGER,
      build_version INTEGER,
      build_cursor INTEGER NOT NULL DEFAULT 0,
      build_hwm INTEGER NOT NULL DEFAULT 0,
      build_done INTEGER NOT NULL DEFAULT 0,
      build_total INTEGER NOT NULL DEFAULT 0,
      build_started_at TEXT,
      build_backfilled_at TEXT
    );
    INSERT OR IGNORE INTO lexical_index_state (id) VALUES (1);
  `);
  const row = readRow(db)!;
  db.transaction(() => {
    dropBuildIfOrphaned(db);
    if (hadChunksFts) {
      // An index from before versions: its tokenizer says which rules built it.
      let version = row.active_version;
      if (version == null) {
        version = unversionedLexicalRules(tokenizeOf(db, ACTIVE_FTS) ?? "unicode61").version;
        setActiveVersion(db, version);
      }
      syncActiveTriggers(db, maintainableActiveRules(db, version));
    } else {
      // A new database, or a restored or seeded one whose chunks arrived
      // without their full-text index (it is derived data and never copied).
      // Either way the active index is created at the target version; restored
      // chunks are indexed now, as one pass over a copy that is small or
      // already waiting on its first start.
      const target = targetLexicalVersion();
      // Triggers first: renaming the build's table re-reads every trigger,
      // and these name the missing index.
      dropActiveTriggers(db);
      discardNextIndex(db);
      clearBuild(db);
      createFtsTable(db, ACTIVE_FTS, target);
      createActiveTriggers(db, target);
      db.exec(`INSERT INTO ${ACTIVE_FTS}(${ACTIVE_FTS}) VALUES('rebuild')`);
      setActiveVersion(db, target.version);
      clearBuild(db);
    }
    if (tableExists(db, ACTIVE_FTS)) {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${ACTIVE_VOCAB} USING fts5vocab(${ACTIVE_FTS}, 'row')`,
      );
    }
  })();
}

export type LexicalStep =
  | "idle"
  | "retired-batch"
  | "retired-dropped"
  | "stale-build-dropped"
  | "build-started"
  | "backfilled-batch"
  | "backfill-complete";

/**
 * Do one small unit of the work that brings the full-text index to the target
 * version, in its own transaction, and say what it did. The indexer calls this
 * repeatedly, pacing itself between calls; `"idle"` means there is nothing to
 * do until a switch or a new target. A completed backfill waits for
 * {@link switchLexicalIndex}.
 */
export function lexicalRebuildStep(db: Db, opts: { batchSize: number }): LexicalStep {
  if (tableExists(db, RETIRED_FTS)) {
    if (!emptyRetiredBatch(db, opts.batchSize)) return "retired-batch";
    db.exec(`DROP TABLE ${RETIRED_FTS}`);
    dropUnusedContentViews(db);
    return "retired-dropped";
  }
  const { active, build, target } = readLexicalIndexState(db);
  if (build && (build.version !== target.version || active?.version === target.version)) {
    db.transaction(() => {
      discardNextIndex(db);
      clearBuild(db);
    })();
    return "stale-build-dropped";
  }
  if (!build) {
    if (active?.version === target.version) return "idle";
    db.transaction(() => {
      discardNextIndex(db);
      const { hwm, n } = db
        .prepare<[], { hwm: number | null; n: number }>(
          "SELECT max(rowid) AS hwm, count(*) AS n FROM chunks",
        )
        .get()!;
      createFtsTable(db, NEXT_FTS, target);
      db.prepare(
        `UPDATE lexical_index_state
         SET build_version = ?, build_cursor = 0, build_hwm = ?, build_done = 0, build_total = ?,
             build_started_at = ?, build_backfilled_at = NULL
         WHERE id = 1`,
      ).run(target.version, hwm ?? 0, n, new Date().toISOString());
      createNextTriggers(db, target);
    })();
    return "build-started";
  }
  if (build.backfilledAt) return "idle";
  const rules = rulesFor(db, build.version, NEXT_FTS);
  return db.transaction((): LexicalStep => {
    const rows = db
      .prepare<[number, number, number], { rowid: number; content: string; title: string }>(
        `SELECT rowid, content, title FROM chunks
         WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
      )
      .all(build.cursor, build.highWater, opts.batchSize);
    const insert = db.prepare(`INSERT INTO ${NEXT_FTS}(rowid, content, title) VALUES (?, ?, ?)`);
    for (const r of rows) {
      insert.run(r.rowid, analyze(rules, r.content ?? ""), analyze(rules, r.title ?? ""));
    }
    const last = rows.length > 0 ? rows[rows.length - 1].rowid : build.highWater;
    const finished = rows.length < opts.batchSize || last >= build.highWater;
    const cursor = finished ? build.highWater : last;
    db.prepare(
      `UPDATE lexical_index_state
       SET build_cursor = ?, build_done = build_done + ?,
           build_backfilled_at = CASE WHEN ? THEN ? ELSE NULL END
       WHERE id = 1`,
    ).run(cursor, rows.length, finished ? 1 : 0, new Date().toISOString());
    return finished ? "backfill-complete" : "backfilled-batch";
  })();
}

/**
 * Make the backfilled build of `version` the active index, in one
 * transaction. Returns false, changing nothing, when no backfilled build of
 * that version exists (it was superseded meanwhile). The previous index is
 * left as `chunks_fts_retired` for {@link lexicalRebuildStep} to drop.
 */
export function switchLexicalIndex(db: Db, version: number): boolean {
  return db.transaction((): boolean => {
    const { build } = readLexicalIndexState(db);
    if (!build || build.version !== version || !build.backfilledAt) return false;
    // A previous replacement is dropped before any build starts.
    if (tableExists(db, RETIRED_FTS)) return false;
    const rules = rulesFor(db, version, NEXT_FTS);
    dropActiveTriggers(db);
    dropNextTriggers(db);
    db.exec(`DROP TABLE IF EXISTS ${ACTIVE_VOCAB}`);
    if (tableExists(db, ACTIVE_FTS)) db.exec(`ALTER TABLE ${ACTIVE_FTS} RENAME TO ${RETIRED_FTS}`);
    db.exec(`ALTER TABLE ${NEXT_FTS} RENAME TO ${ACTIVE_FTS}`);
    createActiveTriggers(db, rules);
    db.exec(`CREATE VIRTUAL TABLE ${ACTIVE_VOCAB} USING fts5vocab(${ACTIVE_FTS}, 'row')`);
    setActiveVersion(db, version);
    clearBuild(db);
    return true;
  })();
}

/**
 * A build whose table is gone, as in a restored or seeded database, which
 * carries the triggers on `chunks` but never the derived index: drop the
 * triggers, which would fail every chunk write, and forget the build so the
 * indexer starts afresh.
 */
function dropBuildIfOrphaned(db: Db): void {
  if (tableExists(db, NEXT_FTS)) return;
  dropNextTriggers(db);
  clearBuild(db);
}

/**
 * Stop maintaining the index being built and set it aside as the retired
 * index, which {@link lexicalRebuildStep} empties and drops. Only when no
 * retired index is waiting already, which the step order guarantees; otherwise
 * it is dropped at once.
 */
function discardNextIndex(db: Db): void {
  dropNextTriggers(db);
  if (!tableExists(db, NEXT_FTS)) return;
  if (tableExists(db, RETIRED_FTS)) db.exec(`DROP TABLE ${NEXT_FTS}`);
  else db.exec(`ALTER TABLE ${NEXT_FTS} RENAME TO ${RETIRED_FTS}`);
}

/** The retired index's storage tables and each one's key. */
const RETIRED_STORAGE: ReadonlyArray<readonly [table: string, key: string]> = [
  [`${RETIRED_FTS}_data`, "rowid"],
  [`${RETIRED_FTS}_idx`, "segid, term"],
  [`${RETIRED_FTS}_docsize`, "id"],
];

/**
 * Delete up to `batchSize` rows of the retired index's storage, in one short
 * transaction, and say whether it is now empty. Dropping a full index in one
 * statement reads and frees every page under the write lock (seconds for a
 * large encrypted index); emptying it in batches keeps each hold as short as
 * a backfill batch, and the final drop then has nothing left to free. Nothing
 * reads or writes the retired index, so deleting its storage directly is
 * safe; SQLite refuses it outside unsafe mode, which is on only for these
 * deletes.
 */
function emptyRetiredBatch(db: Db, batchSize: number): boolean {
  db.unsafeMode(true);
  try {
    return db.transaction((): boolean => {
      for (const [table, key] of RETIRED_STORAGE) {
        if (!tableExists(db, table)) continue;
        const deleted = db
          .prepare(`DELETE FROM ${table} WHERE (${key}) IN (SELECT ${key} FROM ${table} LIMIT ?)`)
          .run(batchSize).changes;
        if (deleted > 0) return false;
      }
      return true;
    })();
  } finally {
    db.unsafeMode(false);
  }
}

/** Drop content views no remaining index reads. */
function dropUnusedContentViews(db: Db): void {
  const row = readRow(db);
  const keep = new Set(
    [row?.active_version, row?.build_version]
      .filter((v): v is number => v != null)
      .map((v) => `chunks_lexical_v${v}`),
  );
  const views = db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND name LIKE 'chunks_lexical_v%'",
    )
    .all();
  for (const { name } of views) {
    if (!keep.has(name)) db.exec(`DROP VIEW IF EXISTS ${name}`);
  }
}

/** Progress of a keyword-index rebuild, for `/index/stats`. */
export interface LexicalIndexStatus {
  activeVersion: number | null;
  targetVersion: number;
  /** True while a replaced or superseded index is still being deleted. */
  retiring: boolean;
  building: {
    version: number;
    chunksDone: number;
    chunksTotal: number;
    percent: number;
    startedAt: string;
    /** "copying" while chunks are copied; "switching" once copied, until the switch. */
    phase: "copying" | "switching";
  } | null;
}

export function lexicalIndexStatus(db: Db): LexicalIndexStatus {
  const { active, build, target } = readLexicalIndexState(db);
  return {
    activeVersion: active?.version ?? null,
    targetVersion: target.version,
    retiring: tableExists(db, RETIRED_FTS),
    building: build
      ? {
          version: build.version,
          chunksDone: build.done,
          chunksTotal: build.total,
          percent:
            build.backfilledAt || build.total === 0
              ? 100
              : Math.min(99, Math.floor((build.done / build.total) * 100)),
          startedAt: build.startedAt,
          phase: build.backfilledAt ? "switching" : "copying",
        }
      : null,
  };
}
