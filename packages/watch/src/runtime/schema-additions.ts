// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Bringing a store written by an older build up to the current shape.
 *
 * Every watch store builds itself with `CREATE TABLE IF NOT EXISTS`, which
 * builds a new file correctly and does **nothing at all** to one that already
 * exists. So a column added to a table that has shipped is invisible in every
 * store on disk, and the first query naming it fails — on the operator's
 * install, never on a test, because every test boots a fresh config dir and the
 * live install boots yesterday's.
 *
 * That makes each store's schema two halves that have to agree: the `CREATE`
 * statements, which only a fresh file reads, and the additions below them,
 * which only an existing file reads. Neither half sees the other's mistakes.
 *
 * Only additive columns belong here, and only ones whose absence means "not
 * recorded" — a nullable column, or one with a default. Anything that has to
 * *transform* existing rows is a gateway migration, where the version chain can
 * order it.
 */

import type { Database } from "better-sqlite3";

/** A table's added columns, by name, with the type each is declared as. */
export type ColumnAdditions = Readonly<Record<string, string>>;

/** The column names a table currently has on disk. */
export function tableColumns(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

/**
 * Add whatever `table` is missing of `additions`, and nothing else.
 *
 * Idempotent by construction: a column already present is stepped over, so
 * running this on every open costs one `PRAGMA` per table and changes nothing
 * on a file that is already current.
 *
 * A table that does not exist is left alone rather than raised on. This runs
 * from a store constructor, after that store's own `CREATE TABLE IF NOT
 * EXISTS` — so the only way to reach a missing table is to name one the schema
 * does not build, and taking the whole subsystem down at boot is a far worse
 * answer to that than doing nothing.
 */
export function addMissingColumns(db: Database, table: string, additions: ColumnAdditions): void {
  const present = tableColumns(db, table);
  if (present.size === 0) return;
  for (const [column, type] of Object.entries(additions)) {
    if (present.has(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
