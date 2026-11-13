// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The source filters of one search, applied to the index's own copy of each
 * record's filter details while candidates are generated.
 *
 * The copy can be a moment behind the corpus. That only ever costs results:
 * the pipeline checks every result against the corpus before anything is
 * ranked, counted or returned, and drops what the corpus refuses.
 */

import { registerFilterSqlFunctions } from "../access/filter-people.js";
import {
  INDEX_FILTER_TABLES,
  sourceFilterInclusionSql,
  type CompiledFilter,
  type FilterSql,
} from "../access/filter-sql.js";
import type { Db } from "../data/types.js";

export interface ScopeSearchAuthorization {
  /** The grant's filters, compiled by the caller against each source's declaration. */
  filters: readonly CompiledFilter[];
  /** Sources a filtered search reads nothing from. */
  excludedSourceIds?: readonly string[];
}

const extras = new WeakMap<Db, FilterSql>();

/** Narrow every candidate statement run inside `body` by one more predicate on chunk alias `c`. */
export function withScopeSearchPredicate<T>(db: Db, predicate: FilterSql, body: () => T): T {
  const previous = extras.get(db);
  extras.set(
    db,
    previous
      ? {
          sql: `(${previous.sql}) AND (${predicate.sql})`,
          params: [...previous.params, ...predicate.params],
        }
      : predicate,
  );
  try {
    return body();
  } finally {
    if (previous) extras.set(db, previous);
    else extras.delete(db);
  }
}

const contexts = new WeakMap<Db, ScopeSearchAuthorization>();

/** Run candidate generation for a filtered search inside one index snapshot. */
export function withScopeSearchAuthorization<T>(
  db: Db,
  authorization: ScopeSearchAuthorization | undefined,
  body: () => T,
): T {
  if (!authorization?.filters.length) return body();
  if (contexts.has(db)) throw new Error("Nested scope search authorization.");
  registerFilterSqlFunctions(db);
  return db.transaction(() => {
    contexts.set(db, authorization);
    try {
      return body();
    } finally {
      contexts.delete(db);
    }
  })();
}

export function scopeSearchActive(db: Db): boolean {
  return contexts.has(db);
}

/** The predicate a candidate statement adds while a filtered search runs; `1` otherwise. */
export function scopeSearchSql(
  db: Db,
  documentColumn = "c.document_id",
  sourceColumn = "c.source_id",
): FilterSql {
  const authorization = contexts.get(db);
  if (!authorization) return { sql: "1", params: [] };
  const filter = sourceFilterInclusionSql(authorization.filters, documentColumn, sourceColumn, {
    map: INDEX_FILTER_TABLES,
  });
  const expressions: string[] = [filter.sql];
  const params = [...filter.params];
  if (authorization.excludedSourceIds?.length) {
    expressions.push(`${sourceColumn} NOT IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(authorization.excludedSourceIds));
  }
  const extra = extras.get(db);
  if (extra) {
    expressions.push(`(${extra.sql})`);
    params.push(...extra.params);
  }
  return { sql: expressions.join(" AND "), params };
}
