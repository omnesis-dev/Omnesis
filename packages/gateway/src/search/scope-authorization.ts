// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { sourceScopeInclusionSql, type ScopeSql } from "../access/scope-sql.js";
import type { ScopePolicy } from "@omnesis/types";
import type { ScopeSourceGeneration } from "../access/scope-generations.js";
import type { Db } from "../data/types.js";

export interface ScopeSearchAuthorization {
  policies: readonly ScopePolicy[];
  excludedSourceIds?: readonly string[];
  generations: readonly ScopeSourceGeneration[];
}
const extras = new WeakMap<Db, ScopeSql>();
export function withScopeSearchPredicate<T>(db: Db, predicate: ScopeSql, body: () => T): T {
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

/** Synchronous candidate SQL shares one index snapshot, including the generation fence. */
export function withScopeSearchAuthorization<T>(
  db: Db,
  authorization: ScopeSearchAuthorization | undefined,
  body: () => T,
): T {
  if (
    !authorization ||
    (!authorization.policies.length && !authorization.excludedSourceIds?.length)
  )
    return body();
  if (contexts.has(db)) throw new Error("Nested scope search authorization.");
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

export function scopeSearchSql(
  db: Db,
  documentColumn = "c.document_id",
  sourceColumn = "c.source_id",
): ScopeSql {
  const authorization = contexts.get(db);
  if (!authorization) return { sql: "1", params: [] };
  const policy = sourceScopeInclusionSql(authorization.policies, documentColumn, sourceColumn);
  const expressions: string[] = [policy.sql];
  const params = [...policy.params];
  if (authorization.excludedSourceIds?.length) {
    expressions.push(`${sourceColumn} NOT IN (SELECT value FROM json_each(?))`);
    params.push(JSON.stringify(authorization.excludedSourceIds));
  }
  for (const entry of authorization.policies) {
    const expected = authorization.generations.find(
      (generation) => generation.sourceId === entry.sourceId,
    );
    expressions.push(`(${sourceColumn} <> ? OR EXISTS (SELECT 1 FROM index_scope_generations isg
      WHERE isg.source_id = ? AND isg.epoch = ? AND isg.generation = ? AND isg.generation >= 0))`);
    params.push(
      entry.sourceId,
      entry.sourceId,
      expected?.epoch ?? "",
      String(expected?.generation ?? -1),
    );
  }
  const extra = extras.get(db);
  if (extra) {
    expressions.push(`(${extra.sql})`);
    params.push(...extra.params);
  }
  return { sql: expressions.join(" AND "), params };
}
