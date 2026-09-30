// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Which extracted dates the temporal query reads as mentions, and the days
 * each covers.
 *
 * Every date the recognizer finds is stored and shown on its document; only
 * the ones that read as a day, a named span of days or an explicit month the
 * document points at become mentions. The rest would bury the useful ones in
 * any real mailbox:
 *
 * - a bare digit run ("204815") the recognizer reads as a date;
 * - a year, which answers every window inside it;
 * - a month named without a year ("October", "next month") — newsletters and
 *   statements name the coming month constantly and point at nothing in it;
 * - a span that names no day ("Q4", "the next few weeks", "to date",
 *   "mid-2022"), or counts days from the document's own date ("the next 7
 *   days"). A span the phrase lays out day by day ("1 to 3 October",
 *   "26 October – 2 November") stays.
 *
 * Content the user addressed to the assistant (`metadata.addressedToAgent`,
 * such as a note told to it) is read loosely instead: the user is asking to
 * be reminded, so "next week", "in October" or "within ten days" is a date to
 * follow up on, not noise. Only digit runs, years and spans past the cap are
 * left out of it.
 */

import type { ExtractedDate } from "@omnesis/types";

/** A mention's first day and the day after its last, `YYYY-MM-DD`, half-open. */
export interface MentionDays {
  startDay: string;
  endDay: string;
  /**
   * The phrase bounds its date from above ("before 30 September", "by 12
   * October", "cancel free until 6 October"): a deadline.
   */
  deadline: boolean;
}

/**
 * The longest span, in days, a mention may cover and still read as a date the
 * document points at.
 */
export const MENTION_MAX_SPAN_DAYS = 92;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
/** Nothing but digits (and quoting): an identifier, not a written date. */
const DIGITS_ONLY = /^[\s>\d]+$/;
/**
 * A day of the month written as a number. A Latin letter before it is a code
 * ("Q4"); a digit on either side makes it part of a year or an identifier.
 * CJK characters around it are how those languages write dates ("9月30日").
 */
const DAY_NUMBER = /(?<![A-Za-z\p{N}])\d{1,2}(?!\p{N})/u;
/** A count of days, weeks or months from the document's own date. */
const DURATION =
  /\d+\s*(?:days?|weeks?|months?|jours?|semaines?|mois|d[ií]as?|semanas?|meses|天|周|个月)/iu;
/** A TIMEX whose end is the last day the phrase names: a day count or clock times. */
const INCLUSIVE_END_TIMEX = /^\(.*(?:,P\d+D|T\d.*)\)$/;
/** A year written out in the phrase. */
const WRITTEN_YEAR = /(?<!\p{N})\d{4}(?!\p{N})|年/u;
/** A TIMEX at year or month precision, possibly with an unresolved year. */
const COARSE_TIMEX = /^(?:\d{4}|XXXX)(?:-\d{2})?$/;

/** `day` moved by `days`; a day that does not parse is returned as is, for `bounded` to refuse. */
function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextMonth(month: string): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  return mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, "0")}-01`;
}

function validDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const parsed = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}

function spanDays(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}

type Days = Omit<MentionDays, "deadline">;

function bounded(startDay: string, endDay: string): Days | null {
  if (!validDay(startDay) || !validDay(endDay)) return null;
  const span = spanDays(startDay, endDay);
  return span > 0 && span <= MENTION_MAX_SPAN_DAYS ? { startDay, endDay } : null;
}

/** How strictly a document's dates are read as mentions. */
export interface MentionReading {
  /** The user addressed the document to the assistant: every date it can place counts. */
  addressed?: boolean;
}

/** The days a date covers as a mention and whether it is a deadline, or null when it is not one. */
export function mentionDays(date: ExtractedDate, reading: MentionReading = {}): MentionDays | null {
  const days = coveredDays(date, reading.addressed === true);
  if (!days) return null;
  return { ...days, deadline: Boolean(date.mod?.startsWith("before")) };
}

function coveredDays(date: ExtractedDate, addressed: boolean): Days | null {
  if (DIGITS_ONLY.test(date.text)) return null;
  const { resolvedStart: start, resolvedEnd: end } = date;

  if (start && end) {
    // Clock times within one day ("Thursday between 9 and 1pm") are that day.
    if (start === end) return bounded(start, addDays(start, 1));
    if (!addressed && (!DAY_NUMBER.test(date.text) || DURATION.test(date.text))) return null;
    return bounded(start, INCLUSIVE_END_TIMEX.test(date.timex) ? addDays(end, 1) : end);
  }

  let point = start ?? end;
  if (!point) return null;
  // An open-ended phrase ("since 2022", "until October") arrives with its one
  // bound widened to a day; its TIMEX keeps the phrase's own precision.
  if (date.kind === "range" && COARSE_TIMEX.test(date.timex)) {
    point = point.slice(0, date.timex.length);
  }
  if (DAY.test(point)) return bounded(point, addDays(point, 1));
  if (MONTH.test(point)) {
    // A month counts only when the phrase writes its year: "October 2026",
    // not "October", "next month" or "in 2 months".
    const named = MONTH.test(date.timex) && WRITTEN_YEAR.test(date.text);
    return named || addressed ? bounded(`${point}-01`, nextMonth(point)) : null;
  }
  return null;
}
