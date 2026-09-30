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
 *   "26 October – 2 November") stays;
 * - a duration counted from the document's own date ("in 20 days", "72
 *   hours", "a month ago"): terms and notices state them constantly;
 * - a day written without a year that the recognizer resolved more than six
 *   months past the document ("23 June" in an autumn contract, "5/8" in a CI
 *   report) — the writer meant an earlier one;
 * - the date of a quoted message or of the document's own header ("On Tue, 22
 *   Sep 2026 at 18:43, … wrote:", "Date: …"): it dates the message, not
 *   something the message points at;
 * - a year before 1900 or after 2100 ("6-1107", "1754.8"), a phrase of a few
 *   letters ("h", "now"), and a match that runs through a tracking token or
 *   across a whole paragraph.
 *
 * Content the user addressed to the assistant (`metadata.addressedToAgent`,
 * such as a note told to it) is read loosely instead: the user is asking to
 * be reminded, so "next week", "in October", "within ten days" or "23 June"
 * is a date to follow up on, not noise. Only digit runs, implausible years,
 * garbled matches and spans past the cap are left out of it.
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
/** A TIMEX whose end is the last day the phrase names: a day count or clock times. */
const INCLUSIVE_END_TIMEX = /^\(.*(?:,P\d+D|T\d.*)\)$/;
/** A year written out in the phrase. */
const WRITTEN_YEAR = /(?<!\p{N})\d{4}(?!\p{N})|年/u;
/** A TIMEX at year or month precision, possibly with an unresolved year. */
const COARSE_TIMEX = /^(?:\d{4}|XXXX)(?:-\d{2})?$/;
/**
 * A duration counted from the document's date: a count — a number, or "a",
 * "next", "last", "few" — then days, weeks, months, hours or minutes ("in 20
 * days", "72 hours", "a month ago", "next day"). "The week of 28 September"
 * names a week, not a duration.
 */
const DURATION_WORD =
  /(?:\p{N}+(?:[.,]\p{N}+)?|\b(?:a|an|one|few|next|last|several|un|une|quelques|unos?|unas?))\s*(?:(?:days?|weeks?|months?|hours?|hrs?|minutes?|mins?|jours?|semaines?|mois|heures?|d[ií]as?|semanas?|meses|horas?)\b|天|周|个月|小时)/iu;
/**
 * A month named in words. A phrase that names one ("the next day, 5 October")
 * is anchored to a written date, not counted from the document's.
 */
const MONTH_NAME = new RegExp(
  `(?<![\\p{L}])(?:${[
    "septiembre",
    "september",
    "septembre",
    "setiembre",
    "noviembre",
    "diciembre",
    "february",
    "november",
    "december",
    "novembre",
    "décembre",
    "decembre",
    "january",
    "october",
    "janvier",
    "février",
    "fevrier",
    "juillet",
    "octobre",
    "febrero",
    "octubre",
    "august",
    "agosto",
    "march",
    "april",
    "avril",
    "enero",
    "marzo",
    "abril",
    "junio",
    "julio",
    "june",
    "july",
    "sept",
    "mars",
    "juin",
    "août",
    "aout",
    "janv",
    "févr",
    "fevr",
    "juil",
    "mayo",
    "may",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
    "mai",
    "avr",
    "déc",
    "ene",
    "abr",
    "dic",
  ].join("|")})\\.?(?![\\p{L}])`,
  "iu",
);
/**
 * A word that bounds a single date from above: "before", "by", "until" and
 * their translations.
 */
const DEADLINE_WORD =
  /(?:^|[\s>(])(?:before|by|until|till|no later than|avant(?: le)?|jusqu['’]au|antes del?|hasta el)\s+\S/iu;
/** A run of letters and digits long enough to be a token, not a word or a number. */
const TOKEN = /[A-Za-z0-9_-]{16,}/g;
/**
 * Longer than any date phrase — "from Monday 28 September 2026 at 9:00 am to
 * Friday 2 October 2026 at 5:00 pm" is 75 — so the recognizer matched across
 * unrelated text. A blank line inside a match says the same at any length.
 */
const MAX_PHRASE_CHARS = 120;
const PARAGRAPH_BREAK = /\n[ \t>]*\r?\n/;
/** Words the recognizer reads as the document's own moment: "now", "h", "min". */
const BARE_MOMENT = /^(?:now|maintenant|ahora|h|min)$/iu;
/** The span of years a mention may fall in. */
const FIRST_YEAR = 1900;
const LAST_YEAR = 2100;
/**
 * How far past the document a day written without a year may resolve before
 * the earlier one is taken instead: "the lease ends 30 June", written in
 * September, means the June just gone.
 */
const YEARLESS_MAX_AHEAD_DAYS = 183;
/** A header field that dates a message: `Date:`, `Sent:` and their translations. */
const HEADER_FIELD = /^[\s>*]*(?:date|sent|envoy[ée]|enviado|fecha|datum)[\s*]*:/iu;
/**
 * The fields a message header carries beside its date. A `Date:` line is a
 * header only among them; alone it is an event's date ("Date: Saturday 10
 * October").
 */
const HEADER_SIBLING =
  /^[\s>*]*(?:from|to|cc|subject|de|à|a|objet|para|asunto|von|an|betreff)[\s*]*:/imu;
/** Lines around a `Date:` line searched for its sibling fields. */
const HEADER_SIBLING_LINES = 3;
/** The opening of a reply's attribution line: "On …", "Le …", "El …", "Am …". */
const REPLY_INTRO = /^[\s>*]*(?:on|le|el|am)\s/iu;
/** Its close: "wrote:" and its translations. */
const REPLY_WROTE = /(?:wrote|a [ée]crit|escribi[óo]|schrieb)\s*:/iu;
/** Lines after an attribution's opening that may still carry its "wrote:". */
const REPLY_WRAP_LINES = 3;

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

/** How strictly a document's dates are read as mentions, and the context of this one. */
export interface MentionReading {
  /** The user addressed the document to the assistant: every date it can place counts. */
  addressed?: boolean;
  /** The day the document's relative dates count from (`YYYY-MM-DD`). */
  anchorDay?: string;
  /** The date sits in a header or reply attribution that dates a message ({@link isMessageHeaderDate}). */
  inMessageHeader?: boolean;
}

/**
 * True when the text from `charStart` to `charEnd` of `content` sits on a
 * line that dates a message: a `Date:` / `Sent:` field among the other header
 * fields, or a reply's attribution ("On Tue, 22 Sep 2026 at 18:43, Maya Reeves
 * wrote:"), whose "wrote:" may wrap onto the next few lines of the same
 * paragraph.
 */
export function isMessageHeaderDate(content: string, charStart: number, charEnd: number): boolean {
  const lines = content.split("\n");
  let index = 0;
  let lineOffset = 0;
  for (; index < lines.length; index++) {
    const next = lineOffset + lines[index]!.length + 1;
    if (charStart < next) break;
    lineOffset = next;
  }
  const line = lines[index] ?? "";
  if (HEADER_FIELD.test(line)) {
    const around = lines
      .slice(Math.max(0, index - HEADER_SIBLING_LINES), index + HEADER_SIBLING_LINES + 1)
      .filter((_, i, all) => all[i] !== line);
    return around.some((other) => HEADER_SIBLING.test(other));
  }
  if (!REPLY_INTRO.test(line)) return false;
  // The attribution ends at its "wrote:"; a blank line or another sentence's
  // opening ends the paragraph it could wrap across.
  const paragraph = [line];
  for (
    let i = index + 1;
    i <= index + REPLY_WRAP_LINES && i < lines.length && !REPLY_WROTE.test(paragraph.at(-1)!);
    i++
  ) {
    const next = lines[i]!.replace(/^[\s>]*/, "");
    if (next.trim() === "" || REPLY_INTRO.test(lines[i]!)) break;
    paragraph.push(next);
  }
  const text = paragraph.join(" ");
  const wrote = text.search(REPLY_WROTE);
  if (wrote < 0) return false;
  // The date sits between the opening and the "wrote:", and nothing follows it.
  return charStart - lineOffset < wrote && /^\s*$/.test(text.slice(wrote).replace(REPLY_WROTE, ""));
}

/** The days a date covers as a mention and whether it is a deadline, or null when it is not one. */
export function mentionDays(date: ExtractedDate, reading: MentionReading = {}): MentionDays | null {
  const addressed = reading.addressed === true;
  if (garbled(date.text)) return null;
  if (!addressed) {
    if (reading.inMessageHeader) return null;
    if (countedFromDocument(date.text)) return null;
  }
  let days = coveredDays(date, addressed);
  if (!days) return null;
  if (
    !addressed &&
    reading.anchorDay &&
    /^\(?XXXX/.test(date.timex) &&
    spanDays(reading.anchorDay, days.startDay) > YEARLESS_MAX_AHEAD_DAYS
  ) {
    days = yearEarlier(days);
    if (!days) return null;
  }
  const year = Number(days.startDay.slice(0, 4));
  if (year < FIRST_YEAR || year > LAST_YEAR) return null;
  return { ...days, deadline: isDeadline(date) };
}

/**
 * The period a yearless open-ended phrase names ("until October", "after
 * October"): the TIMEX's month, in the year of the widened bound — which may
 * already be the next month ("after December" arrives as 1 January).
 */
function namedPeriod(bound: string, timex: string): string {
  if (!MONTH.test(timex.replace("XXXX", "0000"))) return bound.slice(0, timex.length);
  const month = Number(timex.slice(5, 7));
  const year = Number(bound.slice(0, 4)) - (Number(bound.slice(5, 7)) < month ? 1 : 0);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** A duration counted from the document's date, not anchored to a date the phrase writes. */
function countedFromDocument(text: string): boolean {
  return DURATION_WORD.test(text) && !WRITTEN_YEAR.test(text) && !MONTH_NAME.test(text);
}

/** The same days a year earlier, or null when they do not exist then (29 February). */
function yearEarlier(days: Days): Days | null {
  const back = (day: string) => `${Number(day.slice(0, 4)) - 1}${day.slice(4)}`;
  return bounded(back(days.startDay), back(days.endDay));
}

/**
 * The phrase bounds its date from above. The recognizer says so with a
 * `before` modifier, but drops it when a match starts mid-word or after stray
 * whitespace ("e before sept 30th"); the phrase's own word still says it.
 */
function isDeadline(date: ExtractedDate): boolean {
  if (date.mod?.startsWith("before")) return true;
  // A closed range ("from 1 until 5 October") is a span, not a deadline.
  const closedRange = date.resolvedStart !== null && date.resolvedEnd !== null;
  return !closedRange && DEADLINE_WORD.test(date.text);
}

/** Not a date phrase: a bare moment word, a tracking token, or a match across unrelated text. */
function garbled(text: string): boolean {
  const bare = text.replace(/[\s>]+/g, " ").trim();
  if (bare.length > MAX_PHRASE_CHARS || PARAGRAPH_BREAK.test(text)) return true;
  if (BARE_MOMENT.test(bare)) return true;
  for (const token of text.match(TOKEN) ?? []) {
    if (/\d/.test(token) && /[A-Za-z]/.test(token)) return true;
  }
  return false;
}

function coveredDays(date: ExtractedDate, addressed: boolean): Days | null {
  if (DIGITS_ONLY.test(date.text)) return null;
  const { resolvedStart: start, resolvedEnd: end } = date;

  if (start && end) {
    // Clock times within one day ("Thursday between 9 and 1pm") are that day.
    if (start === end) return bounded(start, addDays(start, 1));
    if (!addressed && (!DAY_NUMBER.test(date.text) || countedFromDocument(date.text))) return null;
    return bounded(start, INCLUSIVE_END_TIMEX.test(date.timex) ? addDays(end, 1) : end);
  }

  let point = start ?? end;
  if (!point) return null;
  // An open-ended phrase ("since 2022", "until October", "after Sep 2026")
  // arrives with its one bound widened to a day, possibly past the period it
  // names; its TIMEX keeps the phrase's own period and precision.
  if (date.kind === "range" && COARSE_TIMEX.test(date.timex)) {
    point = date.timex.startsWith("XXXX") ? namedPeriod(point, date.timex) : date.timex;
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
