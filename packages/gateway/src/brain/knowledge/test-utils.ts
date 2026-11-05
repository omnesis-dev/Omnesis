// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Query-plan audits for knowledge code that must stay bounded on a large
 * store: record the statements a handle runs, then explain each one and
 * report every step that reads a ledger by a scan, or by a seek that is one
 * in practice.
 */

import type Database from "better-sqlite3";

/** Tables that grow with the corpus or with every maintenance batch ever run. */
export const LEDGERS = [
  "documents",
  "knowledge_work",
  "knowledge_frontier",
  "knowledge_batches",
  "knowledge_batch_regions",
  "knowledge_changes",
  "knowledge_discovery_coverage",
  "knowledge_discovery_targets",
  "knowledge_dependencies",
  "source_inventory_documents",
];

/**
 * A seek on a whole-table index that narrows only by a kind column, which has
 * a handful of values, still walks most of a ledger. A partial index is
 * already bounded by its own condition, such as pending work.
 */
const BROAD_SEEK = /USING (?:COVERING )?INDEX (\w+) \((?:subject_kind|target_kind|kind)=\?\)$/;

/** The table each alias in a statement names, the tables themselves included. */
function aliases(sql: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const [, table, alias] of sql.matchAll(
    /\b(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(?!ON\b|WHERE\b|JOIN\b|LEFT\b|CROSS\b|INNER\b|USING\b|GROUP\b|ORDER\b|LIMIT\b)(\w+))?/gi,
  )) {
    names.set(table!, table!);
    if (alias) names.set(alias, table!);
  }
  return names;
}

/**
 * A document row holds its content before its revision, so a seek that reads
 * document rows other than one by id walks content overflow pages per row. An
 * index that covers the read never touches the rows.
 */
const DOCUMENT_ROW_RANGE = / USING INDEX (?!sqlite_autoindex_documents_1 \(id=\?\))/;

/** Whether a plan step reads a ledger by a scan or by a seek that is one in practice. */
function scansLedger(
  db: Database.Database,
  detail: string,
  names: Map<string, string>,
  ledgers: readonly string[],
): boolean {
  const step = /^(SCAN|SEARCH) (\w+)/.exec(detail);
  const table = step && (names.get(step[2]!) ?? step[2]!);
  if (!step || !ledgers.includes(table!)) return false;
  // A step that names no index reads every row, whichever word the plan uses.
  if (step[1] === "SCAN" || !/ USING /.test(detail)) return true;
  if (table === "documents" && DOCUMENT_ROW_RANGE.test(detail)) return true;
  const index = BROAD_SEEK.exec(detail)?.[1];
  if (!index) return false;
  const definition = db
    .prepare<[string], { sql: string | null }>("SELECT sql FROM sqlite_master WHERE name=?")
    .get(index);
  return !/\bWHERE\b/i.test(definition?.sql ?? "");
}

/** The plan of `sql` as `db` would run it with `params`, one detail line per step. */
export function queryPlan(db: Database.Database, sql: string, params: unknown[]): string[] {
  return db
    .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => row.detail);
}

/**
 * Every plan step of the recorded reads that scans a ledger, each with the
 * statement it belongs to. Explain on a handle that is not recording.
 */
export function ledgerScans(
  db: Database.Database,
  statements: Map<string, unknown[]>,
  ledgers: readonly string[] = LEDGERS,
): string[] {
  const scans: string[] = [];
  for (const [sql, params] of statements) {
    if (!/^\s*(WITH|SELECT)/i.test(sql)) continue;
    for (const detail of queryPlan(db, sql, params))
      if (scansLedger(db, detail, aliases(sql), ledgers))
        scans.push(`${detail}\n  in: ${sql.replace(/\s+/g, " ")}`);
  }
  return scans;
}

/**
 * Record every statement `handle` runs, with the parameters of its first run.
 * The returned `stop` restores the handle's own `prepare`.
 */
export function recordStatements(handle: Database.Database): {
  statements: Map<string, unknown[]>;
  stop: () => void;
} {
  const statements = new Map<string, unknown[]>();
  const prepare = handle.prepare.bind(handle);
  handle.prepare = ((sql: string) => {
    const statement = prepare(sql);
    const record =
      (run: (...params: unknown[]) => unknown) =>
      (...params: unknown[]) => {
        if (!statements.has(sql)) statements.set(sql, params);
        return run(...params);
      };
    return new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== "function") return value;
        const bound = (value as (...args: unknown[]) => unknown).bind(target);
        return ["get", "all", "run", "iterate"].includes(String(key)) ? record(bound) : bound;
      },
    });
  }) as typeof handle.prepare;
  return { statements, stop: () => (handle.prepare = prepare) };
}
