// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type Database from "better-sqlite3";

/**
 * Column-introspection helpers shared by the iOS and Android backup parsers,
 * both of which must tolerate schema drift across WhatsApp releases: an
 * optional column present on some builds and absent on others should degrade
 * to NULL rather than fail the whole import.
 */

/** The set of column names a table actually has, via `PRAGMA table_info`. Always called with a fixed, hardcoded table name — never user input. */
export function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Emit `alias.col AS out` when the join is present AND the column exists,
 * else `NULL AS out`. `joined` guards against referencing an alias that
 * isn't actually in the query's FROM/JOIN clause.
 */
export function pick(
  joined: boolean,
  cols: Set<string>,
  alias: string,
  col: string,
  out: string,
): string {
  return `${joined && cols.has(col) ? `${alias}.${col}` : "NULL"} AS ${out}`;
}
