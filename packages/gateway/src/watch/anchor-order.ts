// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which of a watch's subscription records answers for it, and which of them
 * still stands.
 *
 * A watch that wakes an agent accumulates records: its delivery block changes,
 * an approval is refused, a record reaches its expiry. Two surfaces read that
 * set for different questions — where the watch wakes through *now*, and what
 * it has ever been authorised to say — and if they order the set differently
 * they can describe one watch two ways on two screens.
 *
 * ## Three standings, not two
 *
 * A record is in one of three states, and the difference between the second and
 * the third is the one that matters:
 *
 * - **Carrying.** `active`: a firing reported into it reaches somebody.
 * - **Standing.** `pending_approval` and `paused` carry nothing today, but the
 *   record is still the watch's: one is waiting on a person, the other is a
 *   decision somebody made. Neither may be replaced. Minting a fresh record
 *   beside a paused one would hand back the wake the operator just stopped,
 *   and leave the paused record behind with nobody able to see it.
 * - **Spent.** `revoked`, `denied` and `expired` are over. The record keeps its
 *   history, and its idempotency key is free for the next one.
 *
 * Collapsing "standing" into "spent" is the tempting simplification and it is
 * wrong in both directions: it silently un-pauses a watch, and it reports one
 * waiting on its approval as a watch that wakes nobody.
 *
 * ## The ordering
 *
 * Three parts, each load-bearing:
 *
 * - **Standing above spent.** A delivery change revokes and mints inside one
 *   request, so the two rows carry the same millisecond and recency alone
 *   cannot separate them.
 * - **Carrying above merely standing.** Between two records that both stand,
 *   the one already carrying wakes is the answer.
 * - **A deterministic tail.** Recency, then insertion order. Never the id: ids
 *   are `randomUUID` draws, so ranking on them is a coin flip that shows the
 *   operator a different record on different installs from identical history.
 *
 * The two surfaces agree whenever anything still stands, which is the case
 * worth guaranteeing. They read different row sets otherwise — the wake path
 * drops revoked and denied records, the disclosure keeps them so an egress
 * entry always has an account of what caused it — so a watch whose records are
 * *all* spent can be described by one row here and another there. Nothing
 * wakes either way.
 */

/** A record in one of these carries a watch's wake, or may come to. */
const STANDING_ANCHOR_STATUSES = ["active", "pending_approval", "paused"] as const;

/**
 * Whether the record is still the watch's — carrying its wake, waiting on an
 * approval, or deliberately held.
 *
 * The negation is what frees an idempotency key: see {@link isSpentAnchorStatus}.
 */
export function isStandingAnchorStatus(status: string): boolean {
  return (STANDING_ANCHOR_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether the record is over, and its idempotency key free for the next one.
 *
 * Written as the negation of standing rather than as its own list, so a status
 * added to the schema is treated as spent only by a deliberate edit here — the
 * safe direction is to assume an unrecognised status still belongs to somebody.
 */
export function isSpentAnchorStatus(status: string): boolean {
  return !isStandingAnchorStatus(status);
}

const STANDING_LIST = STANDING_ANCHOR_STATUSES.map((status) => `'${status}'`).join(", ");

/**
 * A SQL predicate over the `subscriptions` alias `s` selecting the records that
 * still stand. Shares its list with {@link isStandingAnchorStatus}, so a status
 * cannot come to mean one thing in TypeScript and another in a query.
 */
export const STANDING_ANCHOR_SQL = `s.status IN (${STANDING_LIST})`;

/**
 * The ORDER BY that puts a watch's answering record first.
 *
 * Written against the `subscriptions` table aliased `s`, which both readers
 * already use. The `rowid` tail is a last resort for rows that agree on both
 * instants; it is stable within an install but not across a `VACUUM INTO`
 * backup, which renumbers it.
 */
export const ANCHOR_ORDER = `ORDER BY (s.status IN (${STANDING_LIST})) DESC,
         (s.status = 'active') DESC,
         s.updated_at DESC,
         s.created_at DESC,
         s.rowid DESC`;
