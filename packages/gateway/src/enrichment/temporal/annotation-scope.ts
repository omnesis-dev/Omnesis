// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { canonicalTemporalKind, type TemporalQueryInput } from "@omnesis/core";
import { resolveTemporalRange } from "./temporal-range.js";

export function normalizedAnnotationBounds(
  row: {
    precision: string;
    canonical: string | null;
    startMs: number;
    endExclusiveMs: number;
  },
  timeZone: string,
): { startMs: number; endExclusiveMs: number; allDay: boolean } {
  const fallback = {
    startMs: row.startMs,
    endExclusiveMs: row.endExclusiveMs,
    allDay: row.precision !== "instant",
  };
  if (!row.canonical || row.precision === "instant") return fallback;

  const resolve = (value: string) => {
    try {
      return resolveTemporalRange({ from: value.trim(), timeZone });
    } catch {
      return null;
    }
  };
  if (row.precision === "day" || row.precision === "month" || row.precision === "year") {
    const period = resolve(row.canonical);
    return period
      ? {
          startMs: period.fromMs,
          endExclusiveMs: period.toExclusiveMs,
          allDay: true,
        }
      : fallback;
  }
  if (row.precision === "range") {
    const tokens = row.canonical.split(" .. ");
    if (tokens.length !== 2) return fallback;
    const first = resolve(tokens[0]);
    const second = resolve(tokens[1]);
    if (!first || !second) return fallback;
    return {
      startMs: Math.min(first.fromMs, second.fromMs),
      endExclusiveMs: Math.max(first.toExclusiveMs, second.toExclusiveMs),
      allDay: !tokens.every((token) => token.includes("T")),
    };
  }
  return fallback;
}

export interface AnnotationScope extends Omit<
  TemporalQueryInput,
  "from" | "to" | "cursor" | "limit"
> {
  fromMs: number;
  toExclusiveMs: number;
}
export interface ScopedAnnotation {
  id: string;
  intervalStartMs: number;
  intervalEndMs: number;
  precision: string;
  canonical: string | null;
  kind?: string | null;
  documentIds: readonly string[];
  sourceIds: readonly string[];
  personIds: readonly string[];
  loopIds: readonly string[];
  projectionIds: readonly string[];
}
/** Same filter semantics for query results and prospective canonical annotations. */
export function annotationMatchesScope(
  row: ScopedAnnotation,
  scope: AnnotationScope,
  contained = false,
): boolean {
  const bounds = normalizedAnnotationBounds(
    {
      precision: row.precision,
      canonical: row.canonical,
      startMs: row.intervalStartMs,
      endExclusiveMs:
        row.intervalEndMs < Number.MAX_SAFE_INTEGER ? row.intervalEndMs + 1 : row.intervalEndMs,
    },
    scope.timeZone,
  );
  if (
    contained
      ? bounds.startMs < scope.fromMs || bounds.endExclusiveMs > scope.toExclusiveMs
      : bounds.startMs >= scope.toExclusiveMs || bounds.endExclusiveMs <= scope.fromMs
  )
    return false;
  if (scope.origins && !scope.origins.includes("annotation")) return false;
  if (scope.modalities && !scope.modalities.includes("inferred")) return false;
  if (scope.statuses && !scope.statuses.includes("active")) return false;
  if (scope.kinds && !scope.kinds.includes(canonicalTemporalKind(row.kind ?? "event")!))
    return false;
  const intersects = (filter: readonly string[] | undefined, values: readonly string[]) =>
    filter === undefined || filter.some((id) => values.includes(id));
  return (
    intersects(scope.documentIds, row.documentIds) &&
    intersects(scope.sourceIds, row.sourceIds) &&
    intersects(scope.entityIds, [
      row.id,
      ...row.documentIds,
      ...row.personIds,
      ...row.loopIds,
      ...row.projectionIds,
    ])
  );
}
