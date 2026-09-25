// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One spelling per instant, decided where the journal is written.
 *
 * A provider hands the analytics store a timestamp as a string, and the store
 * hands it back in whatever form it prefers. Both are the same reading:
 * `2026-07-31T14:09:00Z` written, `2026-07-31 15:09:00+01` read back. A source
 * whose phases mix the two — one writing what an API sent, another writing what
 * it re-read — emits a row that alternates between two spellings while its
 * clock never moves. Every consumer comparing rendered values then sees a
 * change that did not happen: the journal's dedup hash counts it as an update,
 * a watch predicate on the column matches differently, and a reader diffing two
 * events reports a difference in a field nobody touched.
 *
 * Canonicalizing here, once, as the event is built, is what keeps that from
 * needing to be solved again. The dedup hash, the stored payload, and every
 * future consumer read the same string, and no later reader has to remember to
 * normalize. The alternative — normalizing inside the hash — would leave the
 * payload carrying the raw spelling, so the hash and the thing it summarizes
 * would disagree, and a third place would eventually have to be taught the
 * same rule.
 *
 * **The declared type decides.** Nothing here matches on a column name or a
 * source: a source declares `TIMESTAMPTZ` and gets one UTC instant, declares
 * `TIMESTAMP` and gets wall-clock digits, declares `DATE` and gets a calendar
 * day. A column the schema does not describe is left exactly as it arrived,
 * for the same reason the row hash includes undeclared columns — absence is
 * not a declaration, and guessing at an undescribed column would silently
 * rewrite data on a source's behalf.
 *
 * A value that will not parse is also left alone. Refusing to canonicalize it
 * costs a spelling; replacing it with null would cost the reading.
 *
 * A provider may also canonicalize its own writes, and that is not redundant
 * with this. The two protect different things: a provider doing it keeps its
 * own stored table self-consistent, which matters because its later phases
 * read that table back and compare what they find; doing it here keeps the
 * journal correct for every source, including ones written by people who will
 * never read this file. Neither makes the other unnecessary, and removing this
 * one would put the journal's correctness in the hands of every current and
 * future provider being internally consistent about formatting forever.
 */

import { toCanonicalInstant, toCanonicalWallClock } from "@omnesis/core";
import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/** The column types whose values name a moment and therefore have spellings. */
type TemporalColumnType = "TIMESTAMPTZ" | "TIMESTAMP" | "DATE";

function canonicalFor(type: TemporalColumnType, value: unknown): string | null {
  switch (type) {
    case "TIMESTAMPTZ":
      return toCanonicalInstant(value);
    case "TIMESTAMP":
      return toCanonicalWallClock(value);
    case "DATE": {
      // A day has one spelling of its own, and a store may render it with a
      // time of day attached. Take the calendar date and drop the rest.
      const wall = toCanonicalWallClock(value) ?? toCanonicalInstant(value);
      return wall === null ? null : wall.slice(0, 10);
    }
  }
}

function temporalTypeOf(declared: string | undefined): TemporalColumnType | null {
  return declared === "TIMESTAMPTZ" || declared === "TIMESTAMP" || declared === "DATE"
    ? declared
    : null;
}

/**
 * Re-spell every declared-temporal column of a row into its canonical form.
 *
 * Returns the row unchanged (the same object) when nothing needed rewriting,
 * so the common case allocates nothing.
 */
export function canonicalizeDeclaredTemporals(
  row: Readonly<Record<string, unknown>>,
  schema: Pick<AnalyticsTableSchema, "columns"> | undefined,
): Readonly<Record<string, unknown>> {
  const columns = schema?.columns;
  if (!columns || columns.length === 0) return row;

  let rewritten: Record<string, unknown> | null = null;
  for (const column of columns) {
    const type = temporalTypeOf(column.type);
    if (type === null) continue;
    const value = row[column.name];
    if (value === null || value === undefined) continue;
    const canonical = canonicalFor(type, value);
    if (canonical === null || canonical === value) continue;
    rewritten ??= { ...row };
    rewritten[column.name] = canonical;
  }
  return rewritten ?? row;
}
