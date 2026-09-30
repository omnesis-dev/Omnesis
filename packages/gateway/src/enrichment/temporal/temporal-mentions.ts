// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The mention layer of the temporal read model: dates written in a document's
 * text, found by the deterministic date recognizer (`enrichment/dates`), read
 * back as temporal items.
 *
 * A mention says only that a document names a day, a span of days or a
 * month. Which dates count, and which state a deadline, is decided at
 * extraction (`enrichment/dates/mention-bounds.ts`). A mention carries no kind
 * of its own, so it reads as an unclassified `event` — or a `deadline` —
 * `asserted` by the document, and always `active`.
 *
 * Three rules keep the layer usable at corpus scale, where a single year of
 * mail holds hundreds of thousands of dated phrases:
 *
 * - A mention matches a window only when it is anchored in it. A day or a span
 *   of days matches when it starts or ends inside the window; a month matches
 *   only a window holding its first day, so a month named in passing does not
 *   answer every window that reaches into it.
 * - Unlike the other layers, mentions are paginated in SQL. Every bound is a
 *   calendar day resolved to local midnight in the caller's zone, and that
 *   mapping preserves order, so the stored `(start day, end day, id)` order is
 *   the query's own order: a page is an ordered index walk that stops at its
 *   limit. The few spans that begin before the window and end inside it sort
 *   ahead of everything else and are read in full from their own index.
 * - The window's total is counted only up to {@link MENTION_COUNT_CAP}.
 *
 * One document naming the same day twice is one mention, and a conversation
 * repeating a date in every reply is one mention, from its latest message.
 *
 * Only the corpus speaks here. Documents the gateway's own cognition wrote
 * (agent transcripts, loop mirrors) are left out, and so is a document whose
 * content changed since it was scanned: its stored dates may name a day the
 * text no longer mentions, and it reappears once the recognizer has re-read it.
 */

import { cognitionAuthoredSqlExclusion } from "../../brain/cognition-authored.js";
import { judgedNotWorthSql } from "../dates/mention-judgements.js";
import { MENTION_MAX_SPAN_DAYS } from "../dates/mention-bounds.js";
import { resolveTemporalRange } from "./temporal-range.js";
import type Database from "better-sqlite3";
import type {
  TemporalItem,
  TemporalKind,
  TemporalModality,
  TemporalPrecision,
  TemporalQueryInput,
} from "@omnesis/core";

type Db = Database.Database;

/** Rank of the mention layer in the shared sort key: after projections (0) and annotations (1). */
export const MENTION_ORIGIN_RANK = 2;

/**
 * The kind a mention reads as. The recognizer finds a date, never what happens
 * on it — except that a phrase bounding it from above ("before 30 September",
 * "by 12 October") states a deadline.
 */
export const MENTION_KIND: TemporalKind = "event";
const MENTION_DEADLINE_KIND: TemporalKind = "deadline";
/** SQL: the mention is written as a deadline (decided at extraction). */
const IS_DEADLINE = "x.mention_deadline = 1";

function kindOf(row: { mention_deadline: number | null }): TemporalKind {
  return row.mention_deadline === 1 ? MENTION_DEADLINE_KIND : MENTION_KIND;
}
/** The modality a mention reads as: the document asserts the date. */
export const MENTION_MODALITY: TemporalModality = "asserted";

const MENTION_ID_PREFIX = "dm_";
const MENTION_ID_DIGITS = 16;
/** Rows read per round trip while walking past a cursor that lands mid-day. */
const MENTION_SCAN_BATCH = 200;
const MAX_LABEL_PHRASE = 80;
const MAX_LABEL_TITLE = 160;
/** How many mentions a query counts before reporting its total as a floor. */
export const MENTION_COUNT_CAP = 500;

export interface MentionSortKey {
  startMs: number;
  endExclusiveMs: number;
  originRank: number;
  id: string;
}

export interface RankedMention {
  item: TemporalItem;
  key: MentionSortKey;
}

export interface MentionPage {
  /** The first `limit + 1` mentions after the cursor, in query order. */
  items: RankedMention[];
  /**
   * The mentions the window matches, across all pages; all are anchored. A
   * floor when `totalCapped` is set.
   */
  total: number;
  totalCapped: boolean;
}

interface MentionRow {
  id: number;
  document_id: string;
  start_day: string;
  end_day: string;
  matched_text: string;
  relative: number;
  mod: string | null;
  mention_deadline: number | null;
  kind: string;
  resolved_start: string | null;
  resolved_end: string | null;
  title: string | null;
  source_id: string;
}

/**
 * Mention ids sort by the row id they are built from. Zero-padding makes the
 * string order the numeric order, so the shared cursor's id comparison and the
 * SQL `ORDER BY` agree on ties.
 *
 * A re-scan rewrites a document's rows, so its mentions get new ids. That is
 * the same best-effort contract every page walk has: a walk spanning a re-scan
 * may repeat or miss that document's mentions.
 */
function mentionId(firstId: number): string {
  return `${MENTION_ID_PREFIX}${String(firstId).padStart(MENTION_ID_DIGITS, "0")}`;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Calendar-day arithmetic in one time zone, memoized for the life of a query:
 * the same few days are resolved once per row otherwise.
 */
class ZonedDays {
  private readonly midnights = new Map<string, number>();
  private readonly formatter: Intl.DateTimeFormat;

  constructor(private readonly timeZone: string) {
    this.formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }

  /** The local calendar day containing `ms`. */
  dayOf(ms: number): string {
    return this.formatter.format(new Date(ms));
  }

  /**
   * The first instant of `day` in the zone (the day's true start across a DST
   * gap). A day the zone skipped outright — a date-line move — starts where the
   * next day does.
   */
  midnight(day: string): number {
    let value = this.midnights.get(day);
    if (value === undefined) {
      try {
        value = resolveTemporalRange({ from: day, timeZone: this.timeZone }).fromMs;
      } catch {
        value = this.midnight(addDays(day, 1));
      }
      this.midnights.set(day, value);
    }
    return value;
  }

  /** True for a day the zone skipped outright. */
  skipped(day: string): boolean {
    return this.midnight(day) === this.midnight(addDays(day, 1));
  }

  /** The earliest day whose start is at or after `ms`. */
  firstStartingAtOrAfter(ms: number): string {
    const day = this.dayOf(ms);
    return this.midnight(day) >= ms ? day : addDays(day, 1);
  }

  /** The latest day whose start is before `ms`. */
  lastStartingBefore(ms: number): string {
    return this.dayOf(ms - 1);
  }
}

function precisionOf(row: MentionRow): TemporalPrecision {
  if (row.resolved_start && row.resolved_end) return "range";
  return row.end_day === addDays(row.start_day, 1) ? "day" : "month";
}

/** A day or a span of days, told apart from a month by its stored bounds. */
const NOT_A_MONTH = `(x.resolved_start IS NOT NULL AND x.resolved_end IS NOT NULL
  OR x.mention_end_day = date(x.mention_start_day, '+1 day'))`;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function labelOf(row: MentionRow): string {
  const phrase = clip(row.matched_text, MAX_LABEL_PHRASE);
  const title = row.title ? clip(row.title, MAX_LABEL_TITLE) : "";
  return title ? `${title} — “${phrase}”` : `“${phrase}”`;
}

const MENTION_COLUMNS = `
  x.id, x.document_id, x.mention_start_day AS start_day, x.mention_end_day AS end_day,
  x.matched_text, x.relative, x.mod, x.kind, x.resolved_start, x.resolved_end,
  x.mention_deadline, d.title, d.source_id`;

/**
 * Two rows state the same mention when they share bounds, shape and whether
 * they are a deadline: a month and a span of days can share bounds and only
 * the span may match by its end, and "before 12 October" says more than
 * "12 October".
 */
const SAME_SHAPE = `(y.resolved_start IS NOT NULL AND y.resolved_end IS NOT NULL)
       = (x.resolved_start IS NOT NULL AND x.resolved_end IS NOT NULL)
     AND y.mention_deadline IS x.mention_deadline`;

/**
 * One document naming the same bounds twice, in the same shape, is one
 * mention: its lowest row stands for it.
 */
const FIRST_OF_ITS_BOUNDS = `NOT EXISTS (
  SELECT 1 FROM document_extracted_dates y
   WHERE y.document_id = x.document_id
     AND y.mention_start_day = x.mention_start_day
     AND y.mention_end_day = x.mention_end_day
     AND ${SAME_SHAPE}
     AND y.id < x.id)`;

/**
 * A conversation repeats itself: every reply quotes the one before and every
 * message carries the same signature. Only the latest message of a thread
 * that names a mention stands for it — unless the caller named the documents
 * it wants, which then speak for themselves.
 */
const LATEST_IN_ITS_THREAD = `(x.thread_key IS NULL OR NOT EXISTS (
  SELECT 1 FROM document_extracted_dates y
    JOIN documents dy ON dy.id = y.document_id
   WHERE y.thread_key = x.thread_key
     AND y.mention_start_day = x.mention_start_day
     AND y.mention_end_day = x.mention_end_day
     AND ${SAME_SHAPE}
     AND y.document_id <> x.document_id
     AND dy.dates_extracted_at IS NOT NULL
     AND (dy.source_created_at > d.source_created_at
          OR (dy.source_created_at = d.source_created_at AND dy.id > d.id))))`;

/**
 * Read one page of mentions for a window.
 *
 * `after` is the shared cursor key; rows at or before it are skipped. It may
 * belong to any layer, so the SQL lower bound is only the cursor's day and the
 * exact comparison happens here.
 */
export function readMentionPage(
  db: Db,
  input: TemporalQueryInput,
  range: { fromMs: number; toExclusiveMs: number },
  after: MentionSortKey | null,
  limit: number,
  compare: (left: MentionSortKey, right: MentionSortKey) => number,
  options: { hideUnworthy?: boolean } = {},
): MentionPage {
  const empty: MentionPage = { items: [], total: 0, totalCapped: false };
  const events = !input.kinds?.length || input.kinds.includes(MENTION_KIND);
  const deadlines = !input.kinds?.length || input.kinds.includes(MENTION_DEADLINE_KIND);
  if (!events && !deadlines) return empty;
  if (input.modalities?.length && !input.modalities.includes(MENTION_MODALITY)) return empty;
  if (input.statuses?.length && !input.statuses.includes("active")) return empty;
  if (input.documentIds?.length === 0 || input.entityIds?.length === 0) return empty;

  const days = new ZonedDays(input.timeZone);
  // Days whose start falls inside the window; days whose end (the next
  // day's start) does. The window's own first day starts inside it only when
  // the window begins at a midnight.
  const firstDay = days.dayOf(range.fromMs);
  const startFrom = days.firstStartingAtOrAfter(range.fromMs);
  const startTo = days.lastStartingBefore(range.toExclusiveMs);
  const endFrom = days.firstStartingAtOrAfter(range.fromMs + 1);
  const endTo = days.lastStartingBefore(range.toExclusiveMs + 1);

  const authored = cognitionAuthoredSqlExclusion("d.source_id");
  const shared = [
    "d.dates_extracted_at IS NOT NULL",
    ...(authored.sql ? [authored.sql] : []),
    FIRST_OF_ITS_BOUNDS,
  ];
  if (!input.documentIds?.length && !input.entityIds?.length) {
    // Documents the caller names speak for themselves, whatever their worth.
    // The primary-key lookup goes before the thread's correlated subquery.
    if (options.hideUnworthy) shared.push(`NOT ${judgedNotWorthSql("x.document_id")}`);
    shared.push(LATEST_IN_ITS_THREAD);
  }
  if (!events) shared.push(IS_DEADLINE);
  if (!deadlines) shared.push(`NOT ${IS_DEADLINE}`);
  const sharedValues: unknown[] = [...authored.params];
  const addIn = (column: string, selected: readonly string[] | undefined) => {
    if (!selected?.length) return;
    shared.push(`${column} IN (${placeholders(selected)})`);
    sharedValues.push(...selected);
  };
  addIn("x.document_id", input.documentIds);
  // A mention is addressed through its document: entity ids that name a
  // document select that document's mentions.
  addIn("x.document_id", input.entityIds);
  addIn("d.source_id", input.sourceIds);

  const from = `FROM document_extracted_dates x JOIN documents d ON d.id = x.document_id`;
  // Starting on the window's first day or later: anchored by its start, or —
  // when the window begins mid-day — a day or span that began earlier that
  // day and ends inside it.
  const walkWhere = [
    "x.mention_start_day BETWEEN ? AND ?",
    `(x.mention_start_day >= ? OR (x.mention_end_day <= ? AND ${NOT_A_MONTH}))`,
    ...shared,
  ].join(" AND ");
  const walkValues = [firstDay, startTo, startFrom, endTo, ...sharedValues];
  // Spans of days that began on an earlier day and end inside the window. No
  // span is longer than the cap, which bounds how early one can begin.
  const earlier = db
    .prepare(
      `SELECT ${MENTION_COLUMNS}
         FROM document_extracted_dates x INDEXED BY idx_document_extracted_dates_mention_range
         JOIN documents d ON d.id = x.document_id
        WHERE x.mention_end_day BETWEEN ? AND ?
          AND x.mention_start_day >= ? AND x.mention_start_day < ?
          AND (x.resolved_start IS NOT NULL AND x.resolved_end IS NOT NULL)
          AND ${shared.join(" AND ")}`,
    )
    .all(
      endFrom,
      endTo,
      addDays(firstDay, -MENTION_MAX_SPAN_DAYS),
      firstDay,
      ...sharedValues,
    ) as MentionRow[];

  const counted = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 ${from} WHERE ${walkWhere} LIMIT ?)`)
      .get(...walkValues, MENTION_COUNT_CAP + 1) as { n: number }
  ).n;
  const totalCapped = counted > MENTION_COUNT_CAP;
  const total = earlier.length + Math.min(counted, MENTION_COUNT_CAP);
  if (total === 0) return empty;

  // A mention beginning on a day the zone skipped is no temporal item: that
  // day starts where the next one does, so it would share the next day's
  // start and break the stored order the walk relies on.
  const toRanked = (row: MentionRow): RankedMention | null => {
    const startMs = days.midnight(row.start_day);
    const endExclusiveMs = days.midnight(row.end_day);
    if (days.skipped(row.start_day) || endExclusiveMs <= startMs) return null;
    const id = mentionId(row.id);
    return {
      key: { startMs, endExclusiveMs, originRank: MENTION_ORIGIN_RANK, id },
      item: {
        id,
        origin: "mention",
        start: new Date(startMs).toISOString(),
        endExclusive: new Date(endExclusiveMs).toISOString(),
        anchored: true,
        precision: precisionOf(row),
        allDay: true,
        timeZone: input.timeZone,
        label: labelOf(row),
        kind: kindOf(row),
        modality: MENTION_MODALITY,
        status: "active",
        mention: {
          documentId: row.document_id,
          sourceId: row.source_id,
          text: row.matched_text,
          relative: row.relative === 1,
          ...(row.mod ? { mod: row.mod } : {}),
        },
      },
    };
  };

  const wanted = limit + 1;
  const items = earlier
    .map(toRanked)
    .filter((entry): entry is RankedMention => entry !== null)
    .filter((entry) => !after || compare(entry.key, after) > 0)
    .sort((left, right) => compare(left.key, right.key))
    .slice(0, wanted);
  if (items.length >= wanted) return { items, total, totalCapped };

  const walk = db.prepare(
    `SELECT ${MENTION_COLUMNS} ${from}
      WHERE ${walkWhere}
        AND x.mention_start_day >= ?
        AND (x.mention_start_day, x.mention_end_day, x.id) > (?, ?, ?)
      ORDER BY x.mention_start_day, x.mention_end_day, x.id
      LIMIT ?`,
  );
  // Resume strictly after this stored key. A mention's own cursor names its
  // row exactly; any other layer's is floored at the day before its start.
  let resume: [string, string, number] = [firstDay, "", -1];
  if (after?.originRank === MENTION_ORIGIN_RANK && after.id.startsWith(MENTION_ID_PREFIX)) {
    resume = [
      days.dayOf(after.startMs),
      days.dayOf(after.endExclusiveMs),
      Number(after.id.slice(MENTION_ID_PREFIX.length)),
    ];
  } else if (after) {
    resume = [maxDay(days.dayOf(after.startMs - 1), firstDay), "", -1];
  }
  for (;;) {
    const rows = walk.all(...walkValues, resume[0], ...resume, MENTION_SCAN_BATCH) as MentionRow[];
    for (const row of rows) {
      const entry = toRanked(row);
      if (!entry || (after && compare(entry.key, after) <= 0)) continue;
      items.push(entry);
      if (items.length >= wanted) return { items, total, totalCapped };
    }
    if (rows.length < MENTION_SCAN_BATCH) return { items, total, totalCapped };
    const last = rows[rows.length - 1];
    resume = [last.start_day, last.end_day, last.id];
  }
}

function maxDay(left: string, right: string): string {
  return left > right ? left : right;
}
