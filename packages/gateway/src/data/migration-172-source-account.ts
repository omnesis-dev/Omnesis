// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Migration 172 — a source row can carry what its source says about the
 * account, rather than leaving every consumer to infer it from the id.
 *
 * One nullable JSON column. Null is the honest value for every existing row
 * and for every source that has nothing more to say than a name, so there is
 * nothing to backfill: a descriptor arrives the next time the collector
 * announces its sources, and until then consumers fall back to exactly what
 * they read today, which is the id.
 *
 * JSON rather than columns because the shape is the SDK's and will gain
 * fields — aliases, a tenant label — that no consumer of this table filters or
 * joins on. Nothing here is ever a query predicate: the addressable identity
 * is still `account_id`, which keeps its own column.
 */

import type { Db } from "./types.js";

export function addSourceAccountDescriptor(db: Db): void {
  const columns = db
    .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('sources')")
    .all();
  // An install that has not yet created the table has nothing to alter; the
  // idempotent CREATE already carries the column.
  if (columns.length === 0) return;
  if (columns.some((c: { name: string }) => c.name === "account")) return;

  db.exec(`ALTER TABLE sources ADD COLUMN account TEXT`);
}
