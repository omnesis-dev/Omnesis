// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Planner statistics: `sqlite_stat1`, kept current the way SQLite recommends
 * for a long-lived connection — `PRAGMA optimize` with the all-tables bit,
 * periodically, under an analysis limit. Off unless the operator sets
 * `gateway.backfill.plannerStatistics.interval`.
 *
 * Without `sqlite_stat1` the planner assumes every index is equally selective,
 * so an equality on a column every row shares (`algo_version`, `status`,
 * `source_id`) rates the same as one on a near-unique column, and a covering
 * key can win over the index that actually narrows the read. The gateway had
 * never analyzed its database, which is how the near-dup bucket delete came to
 * read every bucket row of the active algo per document.
 *
 * `PRAGMA optimize` itself runs every ANALYZE it decides on inside one write
 * transaction, and on a database that has never been analyzed it decides on
 * every indexed table at once. So the writer asks it which tables need work
 * (its debug bit, which only reads row-count estimates) and does that work one
 * index at a time, each under the analysis limit, giving the writer back
 * between them. A table already analyzed is reanalyzed only when its row count
 * has moved tenfold; an index-less table too small for its row count to steer
 * a plan is left alone, so a caught-up pass analyzes nothing.
 *
 * ANALYZE writes `sqlite_stat1` and so runs on the writer, whose own plans use
 * the new statistics at once. A read connection loads them when it loads the
 * schema: when it opens, and again whenever the schema cookie has moved. The
 * first ANALYZE of a database creates the statistics tables and so moves the
 * cookie after one unit; a later ANALYZE does not. So a pass that analyzed
 * anything ends by moving the cookie itself (`reloadReaderStatistics`), and
 * every open reader moves to the finished statistics together rather than
 * keeping whatever part of a pass it happened to load.
 */

import type Database from "better-sqlite3";
type Db = Database.Database;

/**
 * `PRAGMA optimize` mask for the plan: debugging (0x1, report instead of
 * running), ANALYZE where it helps (0x2), under a temporary analysis limit
 * (0x10), checking every table rather than only those this connection has
 * queried (0x10000).
 */
export const OPTIMIZE_PLAN_MASK = 0x10013;

/**
 * Rows ANALYZE visits per index. SQLite recommends 100 to 1000 for
 * `analysis_limit`; at 1000 an index whose key repeats more than a thousand
 * times still reads as far less selective than a near-unique one, which is
 * the distinction the planner was missing.
 */
export const PLANNER_ANALYSIS_LIMIT = 1000;

/**
 * An index-less table's only statistic is its row count, which matters to a
 * plan only once the table is large. `PRAGMA optimize` keeps proposing tiny
 * index-less tables, so below this size they are not analyzed at all.
 */
export const INDEXLESS_MIN_ROWS = 1000;

const ANALYZE_TARGET = /^ANALYZE "main"\."((?:[^"]|"")+)"$/;

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The tables `PRAGMA optimize` would analyze now, in its own order. */
export function planPlannerStatistics(db: Db): string[] {
  const rows = db.prepare(`PRAGMA optimize(${OPTIMIZE_PLAN_MASK})`).all() as Array<{
    optimize: string;
  }>;
  const tables: string[] = [];
  for (const row of rows) {
    const match = ANALYZE_TARGET.exec(row.optimize);
    if (match) tables.push(match[1].replaceAll('""', '"'));
  }
  return tables;
}

/**
 * The units one table is analyzed in. ANALYZE accepts an index name and then
 * visits only that index, so a table is split into its indexes: the documents
 * table carries over thirty, and analyzing them together is one long hold. A
 * WITHOUT ROWID table, whose primary key is the table itself rather than an
 * index ANALYZE can name, is analyzed whole, and so is an index-less table of
 * at least `INDEXLESS_MIN_ROWS` rows; a smaller index-less table has none.
 */
export function analysisUnits(db: Db, table: string): string[] {
  const row = db
    .prepare<[string], { sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
  if (!row) return [];
  if (/\bWITHOUT\s+ROWID\b/i.test(row.sql ?? "")) return [table];
  const indexes = db
    .prepare<[string], { name: string }>("SELECT name FROM pragma_index_list(?) ORDER BY name")
    .all(table)
    .map((r) => r.name);
  if (indexes.length > 0) return indexes;
  const rows = db
    .prepare<[], { n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM "main".${quoted(table)} LIMIT ${INDEXLESS_MIN_ROWS})`,
    )
    .get()!.n;
  return rows >= INDEXLESS_MIN_ROWS ? [table] : [];
}

/** Analyze one table or index under the analysis limit, restoring the connection's own. */
export function analyzeUnit(db: Db, unit: string, limit = PLANNER_ANALYSIS_LIMIT): void {
  const previous = db.pragma("analysis_limit", { simple: true }) as number;
  db.pragma(`analysis_limit = ${limit}`);
  try {
    db.exec(`ANALYZE "main".${quoted(unit)}`);
  } finally {
    db.pragma(`analysis_limit = ${previous}`);
  }
}

/**
 * Move the schema cookie with a create-and-drop of a scratch table, so every
 * open read connection reloads its schema, and with it `sqlite_stat1`, before
 * its next statement. The statistics themselves are rows and do not move it.
 */
export function reloadReaderStatistics(db: Db): void {
  db.transaction(() => {
    db.exec("CREATE TABLE planner_statistics_reload (x INTEGER)");
    db.exec("DROP TABLE planner_statistics_reload");
  })();
}

export interface PlannerStatisticsProgress {
  /** Tables or indexes analyzed by this call. */
  analyzed: string[];
  /** The tables those units belong to. */
  tables: string[];
  /** Units still owed, for the next call. */
  remaining: string[];
}

/**
 * Analyze `units` (every unit of every planned table when omitted) one at a
 * time, asking `shouldStop` between them. A unit dropped since the plan was
 * taken is skipped. The call that finishes a pass which analyzed anything
 * moves the schema cookie so readers reload the finished statistics.
 */
export function refreshPlannerStatistics(
  db: Db,
  units: readonly string[] | undefined,
  options: { shouldStop?: () => boolean; limit?: number } = {},
): PlannerStatisticsProgress {
  const targets = units ?? planPlannerStatistics(db).flatMap((table) => analysisUnits(db, table));
  const tableOf = db.prepare<[string], { tbl: string }>(
    "SELECT tbl_name AS tbl FROM sqlite_master WHERE type IN ('table', 'index') AND name = ?",
  );
  const analyzed: string[] = [];
  const tables = new Set<string>();
  let next = 0;
  while (next < targets.length) {
    if (analyzed.length > 0 && options.shouldStop?.()) break;
    const unit = targets[next++];
    const owner = tableOf.get(unit);
    if (!owner) continue;
    analyzeUnit(db, unit, options.limit);
    analyzed.push(unit);
    tables.add(owner.tbl);
  }
  const remaining = targets.slice(next);
  if (remaining.length === 0 && targets.length > 0) reloadReaderStatistics(db);
  return { analyzed, tables: [...tables], remaining };
}
