// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What a sync failure affected, and which quota it was counted against.
 *
 * A failure's kind says what went wrong; it does not say how much stopped
 * working. Those are different questions, and only the second one tells a host
 * what to do next.
 *
 * A rate limit on one calendar and a rate limit on the account behind twelve
 * sources are the same `kind`. Treating them alike means either giving up on
 * eleven healthy calendars, or letting twelve sources each discover the same
 * exhausted quota by spending another request on it. Neither is what the
 * source knew at the moment it threw.
 *
 * ## The asymmetry that decides the default
 *
 * Guessing too narrow costs data: a connection-wide outage read as one item's
 * problem means the page skips that item and marches on, and every item after
 * it fails the same way until the walk ends having stored a fraction of the
 * corpus while reporting success.
 *
 * Guessing too wide costs time: a single malformed item read as a connection
 * failure parks sources that were fine until the next tick.
 *
 * So the default is `source` — wide enough that no page marches through an
 * outage pretending to work, narrow enough that one source's problem is not
 * declared to be its neighbours'. A source narrows it deliberately, and only
 * when it knows.
 */

/**
 * How much a failure took with it.
 *
 * Ordered narrow to wide; {@link widerScope} relies on the order.
 */
export type FailureScope =
  /**
   * One upstream item. The rest of the page is unaffected, so a host may skip
   * it and keep going — the only scope where continuing is correct.
   */
  | "item"
  /**
   * One partition of this source: a calendar, a mailbox, a device's stream.
   * The other partitions are readable, so their pages stand — but a snapshot
   * covering the whole source no longer does, because part of it went unread.
   */
  | "partition"
  /**
   * This configured source. Sources sharing its account are unaffected.
   */
  | "source"
  /**
   * The account or credential behind this source. Every source configured on
   * it is affected, whether or not it has noticed yet.
   */
  | "connection";

const SCOPE_ORDER: readonly FailureScope[] = ["item", "partition", "source", "connection"];

/** The wider of two scopes — what a page reports when several parts failed. */
export function widerScope(a: FailureScope, b: FailureScope): FailureScope {
  return SCOPE_ORDER.indexOf(a) >= SCOPE_ORDER.indexOf(b) ? a : b;
}

/**
 * Whether a page may keep going after this failure.
 *
 * Only an item may be stepped over. A partition failure ends the partition,
 * and anything wider ends the page — continuing past it would spend requests
 * against something already known to be unavailable.
 *
 * The same line decides whether the source may still claim a complete
 * snapshot, since a snapshot says that what it did not name is gone and a
 * failure above an item means part of the corpus went unread. That rule is
 * enforced where snapshots are built — `SnapshotEnumeration` withholds a
 * partition it could not read — rather than restated as a second predicate
 * here.
 */
export function mayContinuePage(scope: FailureScope): boolean {
  return scope === "item";
}

/**
 * What an upstream counts a rate limit against.
 *
 * The distinction is operational, not cosmetic. An `account` limit is escaped
 * by waiting on that account while other accounts keep working. An `app` limit
 * is shared by every account this installation holds for the provider, so
 * backing off one account and letting the others run spends the same exhausted
 * budget from a different direction and keeps it exhausted.
 */
export type QuotaKind =
  /** Counted per authenticated account. Other accounts are unaffected. */
  | "account"
  /** Counted per registered application. Every account shares one budget. */
  | "app";

/**
 * The bucket a limit was counted against, so a host can find everything else
 * drawing on it.
 *
 * Naming the `kind` is usually the whole declaration. A source knows whether
 * the limit it hit was per-account or per-application; it does not reliably
 * know the string a host groups sources by, and requiring it to guess would
 * make the common case wrong in a way nothing reports. So the host derives the
 * bucket from the source that failed, and `id` exists for the case the host
 * cannot derive — two packages sharing one registered application, say — where
 * an explicit value overrides the derivation.
 *
 * `id` is opaque and only ever compared for equality. It is shown to nobody
 * and means nothing beyond grouping.
 */
export interface QuotaBucket {
  kind: QuotaKind;
  id?: string;
}

/**
 * Whether two failures drew on the same budget, and so must back off together.
 *
 * Both sides must name an `id`: a bucket with none has not been resolved
 * against a source yet, and treating two unresolved buckets as equal would
 * back off every source that shares only the *kind* of limit.
 */
export function sameQuotaBucket(a: QuotaBucket | undefined, b: QuotaBucket | undefined): boolean {
  if (!a?.id || !b?.id) return false;
  return a.kind === b.kind && a.id === b.id;
}
