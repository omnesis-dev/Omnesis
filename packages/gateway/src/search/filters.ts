// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Filter merging utilities used by the search pipeline.
 *
 * Owned here (not in `pipeline.ts`) so the pipeline
 * orchestrator stays narrowly responsible for "run the stages in
 * order"; reusable filter manipulation lives next to the SQL filter
 * builders in `metadata.ts`.
 */

import type { PersonFilter, SearchFilters } from "./types.js";

/**
 * Merge two filter sets. The second set takes precedence for scalar
 * fields (dateFrom, dateTo); array fields are concatenated. Used by
 * the pipeline to combine the configured `defaultFilters` with the
 * caller-supplied filters and the parser-extracted inline filters.
 */
export function mergeFilters(a: SearchFilters, b?: SearchFilters): SearchFilters {
  if (!b) return { ...a };
  return {
    sourceIds: mergeArrays(a.sourceIds, b.sourceIds),
    documentTypes: mergeArrays(a.documentTypes, b.documentTypes),
    dateFrom: b.dateFrom ?? a.dateFrom,
    dateTo: b.dateTo ?? a.dateTo,
    tags: mergeArrays(a.tags, b.tags),
    personFilters: mergePersonFilters(a.personFilters, b.personFilters),
  };
}

/**
 * Concatenate two optional string arrays. Returns `undefined` when
 * both are absent so `mergeFilters` can roundtrip absent fields.
 */
export function mergeArrays(a?: string[], b?: string[]): string[] | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return [...a, ...b];
}

/**
 * Merge two `PersonFilter[]` lists by role bucket. Entries with the
 * same `roles` signature collapse into one (refs OR'd together);
 * entries with different signatures remain separate (AND'd at query
 * time). Mirrors the parser's bucketing rule so a caller-supplied
 * filter merged onto the parser output stays well-formed.
 */
export function mergePersonFilters(
  a?: PersonFilter[],
  b?: PersonFilter[],
): PersonFilter[] | undefined {
  if (!a && !b) return undefined;
  const out: PersonFilter[] = [];
  for (const src of [a, b]) {
    if (!src) continue;
    for (const pf of src) {
      const existing = out.find((o) => sameRoles(o.roles, pf.roles));
      if (existing) existing.refs.push(...pf.refs);
      else out.push({ refs: [...pf.refs], roles: pf.roles });
    }
  }
  return out;
}

/**
 * True when two person-filter role tuples are equal (same length, same order).
 * Used to decide whether two `PersonFilter` buckets can merge — by
 * `mergePersonFilters` here and by the query parser's `pushPersonRef`
 * bucketing, which must agree on bucket identity or person filters diverge.
 */
export function sameRoles(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
