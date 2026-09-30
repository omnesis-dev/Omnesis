// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Query-string parsing shared by the HTTP routes that read time windows: a
 * unix-ms window bounded by the calendar's widest span, and CSV facet filters
 * checked against the vocabulary they draw from.
 */

import { BadRequestError } from "./errors.js";

/** Hard cap on a window's span — a year-plus view is a misuse, not a zoom. */
export const TEMPORAL_WINDOW_MAX_SPAN_MS = 400 * 24 * 60 * 60 * 1000;

/** The most values one facet filter may name. */
export const FACET_FILTER_MAX = 12;

interface QueryReader {
  req: { query(name: string): string | undefined };
}

/** The window's unix-ms `from` and `to`; `from` before `to`, at most the widest span. */
export function parseTemporalWindowMs(c: QueryReader): { fromMs: number; toMs: number } {
  const parseMs = (name: string): number => {
    const raw = c.req.query(name);
    const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
    if (!Number.isSafeInteger(n)) {
      throw new BadRequestError(`"${name}" must be a unix-ms integer`);
    }
    return n;
  };
  const fromMs = parseMs("from");
  const toMs = parseMs("to");
  if (fromMs >= toMs) throw new BadRequestError(`"from" must be earlier than "to"`);
  if (toMs - fromMs > TEMPORAL_WINDOW_MAX_SPAN_MS) {
    throw new BadRequestError(
      `window too wide (max ${TEMPORAL_WINDOW_MAX_SPAN_MS / 86_400_000} days)`,
    );
  }
  return { fromMs, toMs };
}

/**
 * Parse one CSV facet filter against the vocabulary it draws from.
 * `normalize` resolves each accepted spelling to the canonical one the query
 * layer matches on, so two spellings of the same value collapse to a single
 * filter entry rather than being passed down twice.
 */
export function parseCsvFacet<T extends string>(
  raw: string | undefined,
  allowed: ReadonlySet<string>,
  name: string,
  normalize?: (value: string) => T | null,
): T[] | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const values = [
    ...new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (values.length > FACET_FILTER_MAX) throw new BadRequestError(`too many "${name}"`);
  const invalid = values.find((value) => !allowed.has(value));
  if (invalid) throw new BadRequestError(`invalid "${name}" value: ${invalid}`);
  if (!normalize) return values as T[];
  const canonical: T[] = [];
  for (const value of values) {
    // Membership in `allowed` is already established, so this resolves.
    const resolved = normalize(value);
    if (resolved !== null) canonical.push(resolved);
  }
  return [...new Set(canonical)];
}
