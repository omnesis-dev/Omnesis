// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The temporal vocabulary — declared exactly once, derived everywhere.
 *
 * Every TypeScript union, zod enum, runtime guard and SQL `CHECK` that
 * constrains a temporal fact is built from the `const` arrays below. Nothing
 * downstream re-spells these values; a divergent copy is a bug the conformance
 * test in `temporal-vocabulary.test.ts` fails on.
 *
 * The governing invariant is that **a kind describes the nature of a fact,
 * never its origin**. Where a fact came from lives in its provenance, so the
 * same vocabulary is available to a deterministic source projection and to an
 * agent-authored annotation alike. Without that rule the union of the two
 * producers develops origin-only spellings, and a caller filtering on a kind
 * silently also filters on who wrote it.
 */

export const TEMPORAL_ORIGINS = ["projection", "annotation"] as const;

/**
 * What a temporal fact *is*. Deliberately small, and deliberately free of any
 * value that names a source, a table, or a producer.
 */
export const TEMPORAL_KINDS = [
  "visit",
  "appointment",
  "event",
  "deadline",
  "reminder",
  "expiry",
  "episode",
] as const;

/** How the fact came to be known — asserted ahead of time, or witnessed. */
export const TEMPORAL_MODALITIES = ["scheduled", "observed", "asserted", "inferred"] as const;

export const TEMPORAL_STATUSES = ["active", "completed", "cancelled"] as const;

/**
 * How precisely the interval is known. Projections currently emit only
 * `instant` and `day`; the coarser values exist for annotations, which
 * routinely assert a fact about a month or a year.
 */
export const TEMPORAL_PRECISIONS = ["instant", "day", "month", "year", "range"] as const;

export type TemporalOrigin = (typeof TEMPORAL_ORIGINS)[number];
export type TemporalKind = (typeof TEMPORAL_KINDS)[number];
export type TemporalModality = (typeof TEMPORAL_MODALITIES)[number];
export type TemporalStatus = (typeof TEMPORAL_STATUSES)[number];
export type TemporalPrecision = (typeof TEMPORAL_PRECISIONS)[number];

/**
 * Retired spellings that resolve to a canonical kind.
 *
 * `calendar_event` names a provenance rather than a nature, so a calendar
 * source maps its rows onto `appointment` or `event` explicitly. `episodic` is
 * a redundant second spelling of `episode`.
 *
 * Kept permanently: a migration rewrites stored rows, but an older client may
 * still send a retired spelling on the wire, and rejecting it outright would be
 * a needless incompatibility.
 *
 * The table has a **null prototype** and is frozen. It is indexed by strings
 * arriving from the wire and from storage, so inheriting `Object.prototype`
 * would make `constructor`, `toString`, `__proto__` and friends look like
 * vocabulary members and hand a caller a function where it expects a kind.
 */
export const RETIRED_TEMPORAL_KINDS: Readonly<Record<string, TemporalKind>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, TemporalKind>, {
    calendar_event: "appointment",
    episodic: "episode",
  } satisfies Record<string, TemporalKind>),
);

export function isTemporalOrigin(value: unknown): value is TemporalOrigin {
  return typeof value === "string" && (TEMPORAL_ORIGINS as readonly string[]).includes(value);
}

export function isTemporalKind(value: unknown): value is TemporalKind {
  return typeof value === "string" && (TEMPORAL_KINDS as readonly string[]).includes(value);
}

export function isTemporalModality(value: unknown): value is TemporalModality {
  return typeof value === "string" && (TEMPORAL_MODALITIES as readonly string[]).includes(value);
}

export function isTemporalStatus(value: unknown): value is TemporalStatus {
  return typeof value === "string" && (TEMPORAL_STATUSES as readonly string[]).includes(value);
}

export function isTemporalPrecision(value: unknown): value is TemporalPrecision {
  return typeof value === "string" && (TEMPORAL_PRECISIONS as readonly string[]).includes(value);
}

/**
 * Resolve a wire/stored kind to its canonical spelling, accepting the retired
 * aliases. Returns null for anything outside the vocabulary — callers reading
 * their own storage should treat that as corruption and throw, rather than
 * substituting a default that silently relabels the fact.
 */
export function canonicalTemporalKind(value: unknown): TemporalKind | null {
  if (isTemporalKind(value)) return value;
  // `Object.hasOwn`, never `in`: membership must be decided by the table's own
  // keys, not by whatever the prototype chain happens to answer for.
  if (typeof value === "string" && Object.hasOwn(RETIRED_TEMPORAL_KINDS, value)) {
    return RETIRED_TEMPORAL_KINDS[value];
  }
  return null;
}

/** Every spelling a client may legitimately send, canonical plus retired. */
export const ACCEPTED_TEMPORAL_KINDS: readonly string[] = [
  ...TEMPORAL_KINDS,
  ...Object.keys(RETIRED_TEMPORAL_KINDS),
];

/**
 * Render a SQL `CHECK` membership clause from a vocabulary array, so a table
 * constraint cannot drift from the TypeScript union it mirrors. Values are
 * compile-time constants from this module; the quote-doubling is belt-and-braces
 * so this never becomes an injection seam if that ever stops being true.
 */
export function temporalVocabularyCheck(column: string, values: readonly string[]): string {
  const list = values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
  return `${column} IN (${list})`;
}
