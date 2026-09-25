// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The event journal — the runtime's only feed, and its only clock.
 *
 * A watch does not subscribe to anything live. It consumes a durable, ordered,
 * enriched journal, and that single decision is what makes live evaluation and
 * backtesting the same loop reading the same bytes. Three properties the raw
 * substrate cannot offer are what force it:
 *
 * - **Ordering and durability.** An in-memory bus is at-most-once: a consumer
 *   that starts late or crashes loses events with no way to know it did.
 * - **People settlement.** People are resolved asynchronously *after* a
 *   document is written, so an event emitted at write time carries no person
 *   ids at all, and every person-keyed predicate would be undefined. The
 *   journal's producer holds a document event until people settle, and marks it
 *   `degraded` if they never do.
 * - **A second clock.** Embeddings land later than documents, so semantic
 *   matching structurally cannot ride the document event. `doc.indexed` is the
 *   separate clock it rides instead.
 *
 * Every event carries two times. `occurredAt` is **semantic** — when the thing
 * happened in the world. `observedAt` is **processing** — when the journal saw
 * it. They diverge whenever a source backfills, and windowed operators evaluate
 * on the semantic one while `seq` and `observedAt` only ever move forward.
 */

import { z } from "zod";

/**
 * An ISO-8601 instant with an explicit zone.
 *
 * The shape check is not enough on its own: `2026-99-99T00:00:00Z` matches the
 * pattern and parses to `NaN`, and every ordering comparison against a NaN is
 * false — so a single impossible date would silently switch off the journal's
 * monotonicity checks rather than failing them.
 */
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const instant = z
  .string()
  .regex(INSTANT_PATTERN, "expected an ISO-8601 instant with an explicit zone")
  .refine((value) => !Number.isNaN(Date.parse(value)), "expected a real calendar instant");

/**
 * A timestamp as the journal spells one, or `null` when it is not an instant.
 *
 * The journal's canonical form is ISO-8601 with an explicit zone, and that is
 * deliberately strict — every windowed operator orders on these, and a value
 * that parses to `NaN` makes every comparison against it silently false.
 *
 * But the instants a document event carries are copied from corpus columns,
 * and a source is free to have stored one in some other perfectly valid
 * spelling. A real install had a source writing `2026-07-31 15:09:00+01`: a
 * space where the separator should be, and a two-digit offset. Every event that
 * source produced was refused by the reader and silently invisible to every
 * watch.
 *
 * So the two jobs are separated. The schema still defines one canonical form
 * and still refuses anything else; this maps the spellings we have actually
 * seen onto it, before parsing rather than instead of it. Both the writer and
 * the reader run it, so an event is normalized on the way in and an event
 * written before the normalizer existed is recovered on the way out.
 *
 * Deliberately not `Date.parse`: its behaviour on non-standard input is
 * implementation-defined, and a journal whose semantic clock depends on which
 * engine parsed it is worse than one that refuses the value outright.
 */
export function toJournalInstant(value: string): string | null {
  if (INSTANT_PATTERN.test(value)) {
    return Number.isNaN(Date.parse(value)) ? null : value;
  }
  // A single space where ISO-8601 wants `T`, as SQL and Postgres render one.
  let candidate = value.replace(" ", "T");
  // A zone given as `+01` or `+0100` rather than `+01:00`.
  candidate = candidate.replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!INSTANT_PATTERN.test(candidate) || Number.isNaN(Date.parse(candidate))) return null;
  return candidate;
}

/**
 * A person as the journal carries them: already resolved to a canonical id,
 * because an unresolved mention is not something a predicate can key on.
 */
const personMentionSchema = z
  .object({
    personId: z.uuid().nullable(),
    role: z.string().min(1),
    isSelf: z.boolean(),
  })
  .strict();

/**
 * `doc.event` — a document arrived or changed.
 *
 * `metadata` carries profile-declared fields only. A journal that shipped
 * whatever the source happened to write would let a watch depend on a field no
 * source ever promised.
 */
const docEventSchema = z
  .object({
    op: z.enum(["created", "updated"]),
    docId: z.uuid(),
    sourceId: z.string().min(1),
    providerId: z.string().min(1),
    /**
     * What kind of thing the document is, as its source declared it — `null`
     * when the source declared nothing. Optional in the document metadata, so
     * a journal that required one would have to drop those documents or invent
     * a type for them, and both are worse than saying so. A `documentType`
     * filter simply does not match a document that has none.
     */
    documentType: z.string().min(1).nullable(),
    title: z.string(),
    /** Revision fence for any host that reads body context outside the journal. */
    contentHash: z.string().min(1).optional(),
    /** The document's own event time — `source_created_at`. */
    semanticTime: instant,
    /** Which fields moved on an update. Empty on a creation. */
    changedFields: z.array(z.string()).default([]),
    contentChanged: z.boolean().default(false),
    metadata: z.record(z.string(), z.unknown()).default({}),
    people: z.array(personMentionSchema).default([]),
    /** Set when people never settled and the event shipped without them. */
    degraded: z.boolean().optional(),
  })
  .strict();

/**
 * `doc.indexed` — a document's embeddings exist.
 *
 * Consumed only by semantic-match sources. It is a separate event precisely
 * because it lands on a different clock from the document itself.
 */
const docIndexedSchema = z
  .object({
    docId: z.uuid(),
    eventIndexedAt: instant,
  })
  .strict();

/**
 * `analytics.row` — a row appeared or changed in the analytics store.
 *
 * Already deduplicated: the raw ingest signal re-fires for every row on every
 * sync page, so a naive count would climb on each re-sync. By the time a row
 * reaches here, `updated` means it genuinely changed.
 *
 * `inserted` means **this journal had not seen the row's key before** — which
 * is not the same as the row having just been created upstream, and the
 * difference is load-bearing for anyone writing a watch. Keys are learned as
 * they arrive, so the first event about a long-existing record says `inserted`
 * whatever its age: an old calendar entry edited today had never been
 * journaled, so its edit arrives as an insert. Read it as "new to me", never
 * as "new in the world".
 */
const analyticsRowSchema = z
  .object({
    op: z.enum(["inserted", "updated"]),
    table: z.string().min(1),
    sourceId: z.string().min(1),
    pk: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    row: z.record(z.string(), z.unknown()),
    /**
     * The row arrived from a phase that is replaying history rather than
     * reporting something new: a source's first sync, or an import of an
     * archive.
     *
     * Arrival is not occurrence. A watch waiting for the next payment over
     * five hundred wants the payment that just happened, not the four years of
     * them that land the day the account is connected — and the difference is
     * invisible in the row itself, since a backfilled row and a live one are
     * the same shape with the same semantic time. Absent means live.
     */
    backfill: z.boolean().optional(),
  })
  .strict();

/** A snapshot of an open loop, as `loop.event` carries it. */
const loopSnapshotSchema = z
  .object({
    state: z.enum(["open", "snoozed", "done", "dismissed"]),
    title: z.string(),
    deadline: instant.nullable().default(null),
    actors: z.array(z.uuid()).default([]),
    involved: z.array(z.uuid()).default([]),
    /** Prerequisite loops, by id — not people. */
    blockedBy: z.array(z.string()).default([]),
  })
  .strict();

/** `loop.event` — cognitive state changed. `before` is null on a creation. */
const loopEventSchema = z
  .object({
    op: z.enum(["created", "updated", "resolved"]),
    loopId: z.string().min(1),
    before: loopSnapshotSchema.nullable(),
    after: loopSnapshotSchema,
  })
  .strict();

/**
 * `timer.fired` — a due-gate came due.
 *
 * Journaled like everything else, which is what lets a backtest replay time
 * rather than approximate it: the timer is an event in the sequence, not a
 * side effect of running.
 */
const timerFiredSchema = z
  .object({
    timerId: z.string().min(1),
    dueAt: instant,
  })
  .strict();

export const JOURNAL_EVENT_KINDS = [
  "doc.event",
  "doc.indexed",
  "analytics.row",
  "loop.event",
  "timer.fired",
] as const;

export type JournalEventKind = (typeof JOURNAL_EVENT_KINDS)[number];

const envelope = {
  /** Dense, strictly increasing. The journal's identity and its resume point. */
  seq: z.number().int().positive(),
  /** Semantic time — when it happened. */
  occurredAt: instant,
  /** Processing time — when the journal saw it. Never moves backwards. */
  observedAt: instant,
};

export const journalEventSchema = z.discriminatedUnion("kind", [
  z.object({ ...envelope, kind: z.literal("doc.event"), payload: docEventSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("doc.indexed"), payload: docIndexedSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("analytics.row"), payload: analyticsRowSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("loop.event"), payload: loopEventSchema }).strict(),
  z.object({ ...envelope, kind: z.literal("timer.fired"), payload: timerFiredSchema }).strict(),
]);

export type JournalEvent = z.infer<typeof journalEventSchema>;

/**
 * Payloads are projections of the event union rather than separate inferences,
 * so the union stays the single place an event's shape is declared.
 */
type PayloadOf<K extends JournalEventKind> = Extract<JournalEvent, { kind: K }>["payload"];

export type DocEvent = PayloadOf<"doc.event">;
export type DocIndexedEvent = PayloadOf<"doc.indexed">;
export type AnalyticsRowEvent = PayloadOf<"analytics.row">;
export type LoopEvent = PayloadOf<"loop.event">;
export type TimerFiredEvent = PayloadOf<"timer.fired">;
export type LoopSnapshot = LoopEvent["after"];
export type PersonMention = DocEvent["people"][number];

/** Narrow an event to one kind, for a consumer that only handles that kind. */
export function isKind<K extends JournalEventKind>(
  event: JournalEvent,
  kind: K,
): event is Extract<JournalEvent, { kind: K }> {
  return event.kind === kind;
}
