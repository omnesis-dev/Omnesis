// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Temporal intent of a search query: the calendar windows a query's own words
 * point at ("last week", "in March 2025", "15 juin", "tomorrow"), read with
 * the same Microsoft Recognizers-Text model the document date extractor uses.
 *
 * A query is not a document, so the reading differs from the extractor's:
 *
 * - **Reference time is now, in the asker's time zone.** "Last week" is the
 *   calendar week before the current one (the recognizer's semantics), not
 *   the seven days before the document was written.
 * - **No forward bias.** A year-less date ("15 July", "March", "Monday")
 *   arrives with a past and a future reading. Words that name a direction
 *   ("last", "ago", "paid", "next", "upcoming", "prochain", …) choose one.
 *   Without them, a month or longer keeps both ("receipts November" in
 *   October may be last year's receipts or next month's renewals), as does a
 *   day whose two occurrences are both within a month ("Monday"); otherwise
 *   the nearer one wins, with the future charged double — a personal corpus
 *   is mostly history.
 * - **Culture by evidence, not detection.** Language detection is meaningless
 *   on a handful of words, and running every culture is a precision disaster
 *   (Spanish reads "ago" as agosto, French reads "Sam" as samedi). English
 *   always runs; French and Spanish run only when the query carries one of
 *   their full date words, and the culture whose accepted matches cover the
 *   most characters wins (ties go to English).
 * - **Only windows a lane can use.** Durations with no anchor ("2 weeks"),
 *   clock times, sets ("every Monday"), unresolved fragments, partial reads
 *   ("le mois" of "le mois prochain") and spans with no near edge ("before
 *   June", "until Friday") carry no window and are dropped; so is any window
 *   longer than {@link MAX_WINDOW_DAYS}. Date words that are ordinary words
 *   or names ("may", "march", "June Carter", "email from April") and four
 *   digits that are identifiers ("order 2025", "INV-2024") are not dates.
 * - **Spans the recognizer misses** are read directly: two named months
 *   ("March to May 2025", "between June and August") and ISO days it merged.
 *
 * Pure apart from the shared per-culture model cache; runs on whichever thread
 * calls it. The search pipeline calls it on the main thread: a warm parse of
 * a short query costs one to a few milliseconds per culture, and the input is
 * capped at {@link MAX_QUERY_CHARS} characters.
 */

import {
  dateTimeModel,
  type RtModelResult,
  type RtResolutionValue,
} from "../enrichment/dates/recognizer.js";
import {
  englishCulture,
  type DateCulture,
  type NumericDateOrder,
} from "../enrichment/dates/language-route.js";
import { zonedDateTimeToMs } from "../enrichment/temporal/temporal-range.js";

/** One calendar window a query points at, half-open. */
export interface TemporalWindow {
  /** First day, `YYYY-MM-DD`, wall clock in the query's time zone. */
  startDay: string;
  /** The day after the last day, `YYYY-MM-DD`. */
  endDay: string;
  /** `startDay` at midnight in the query's time zone, epoch ms. */
  startMs: number;
  /** `endDay` at midnight in the query's time zone, epoch ms. */
  endExclusiveMs: number;
  /** The query words that named the window. */
  text: string;
}

export interface TemporalIntent {
  windows: TemporalWindow[];
  /** The query with the temporal phrases (and their leading prepositions) removed. */
  strippedText: string;
  /** The recognizer culture that read the query. */
  culture: DateCulture;
  timeZone: string;
}

export interface TemporalIntentOptions {
  /** The moment the query is asked. */
  nowMs: number;
  /** IANA zone the asker's calendar lives in. */
  timeZone: string;
  /** How an all-numeric English date ("10/07/2026") reads. */
  numericDateOrder: NumericDateOrder;
}

/** The longest window a query may name and still be a time constraint worth a lane. */
const MAX_WINDOW_DAYS = 400;
/**
 * Characters of a query read for time phrases. The recognizer's cost grows
 * faster than its input — a dense run of dates costs tens of milliseconds per
 * hundred characters — and a query's time phrase sits in its first words.
 */
const MAX_QUERY_CHARS = 200;
/** At most this many windows per query ("garden photos 2016 2017", two readings of "Monday"). */
const MAX_WINDOWS = 4;
/** Plausible years: a four-digit number outside this range is an identifier, not a year. */
const FIRST_YEAR = 1950;
const YEARS_AHEAD = 10;
/** The future reading of a year-less date counts at this multiple of its distance. */
const FUTURE_DISTANCE_PENALTY = 2;
/**
 * A year-less day's other reading is kept too when it lies within this many
 * days of today: "Monday" two days ago and five days ahead are both "Monday".
 */
const BOTH_READINGS_WITHIN_DAYS = 31;
/**
 * A year-less reading at least this long (a month, a season) keeps both its
 * past and future occurrences when the query names no direction: "receipts
 * November" in October may be last November's receipts or next month's
 * renewals, and the lane ranks within both.
 */
const MONTH_SCALE_DAYS = 28;

/**
 * Full date words of each non-English culture. Only a query carrying one of
 * them runs that culture; abbreviations are left out because they collide with
 * English words and names ("sam", "mar", "dim").
 */
const CULTURE_EVIDENCE: ReadonlyArray<[DateCulture, RegExp]> = [
  [
    "fr-fr",
    /(?<!\p{L})(?:janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|aujourd['’]hui|demain|hier|semaine|mois|ann[ée]e|prochaine?|derni[eè]re?|pass[ée]e?)(?!\p{L})/iu,
  ],
  [
    "es-es",
    /(?<!\p{L})(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|lunes|martes|mi[ée]rcoles|jueves|viernes|s[áa]bado|domingo|hoy|mañana|ayer|semana|año|pr[óo]xim[oa]|pasad[oa])(?!\p{L})/iu,
  ],
];

/**
 * Date words that are also ordinary words ("may I", "march protest", "sun
 * cream", "slip and fall", "Mai Tai"). Alone, they are dates only after a word
 * that introduces one.
 */
const HOMOGRAPH = /^(?:may|march|mar|sun|sat|wed|fall|spring|mai|mayo)$/i;
/** "From" introduces a month ("invoice from March"), but "from May" may be a person. */
const FROM_NOT_A_NAME = /^(?:march|mar|fall|spring)$/i;
/**
 * Date words that are also given names ("Jan", "June", "April", "August",
 * "Julio", "Domingo"). They are dates unless their place says person: after
 * a word that introduces one ("email from June", "lunch with Domingo") or
 * before a capitalized surname ("June Carter").
 */
const NAME = /^(?:jan|june|april|august|julio|domingo)$/i;
const PERSON_CONTEXT =
  /(?:^|\s)(?:from|with|to|cc|by|and|dear|hi|hello|thanks|de|con|avec|et|y)\s*$/i;
/** A word right before a phrase that makes a bare homograph a date ("in May", "since March"). */
const DATE_PREPOSITION =
  /(?:^|\s)(?:in|during|since|until|till|before|after|by|of|early|late|mid|last|next|this|en|depuis|avant|apr[eè]s|durante|desde|hasta)\s*$/i;
const FROM = /(?:^|\s)from\s*$/i;
/**
 * A word right after a match that the recognizer left out but that changes
 * it: "le mois prochain" read as "le mois", "the month before last" read as
 * "the month", "last day of February" read as "last day".
 */
const UNCONSUMED_QUALIFIER =
  /^\s*(?:prochaine?s?|derni[eè]re?s?|pass[ée]e?s?|que\s+viene|pasad[oa]s?|pr[óo]xim[oa]s?|before\s+last|after\s+next|of\b|de\b)/i;
/** A unit with only an article: what is left of a phrase the recognizer read in part. */
const BARE_UNIT =
  /^(?:the|le|la|el)\s+(?:day|week|month|year|jour|semaine|mois|ann[ée]e|an|d[ií]a|semana|mes|año)$/i;
/** A week by its number ("week 3 notes"): a label in a personal corpus, rarely a calendar week. */
const WEEK_NUMBER = /^(?:week|semaine|semana)\s+\d{1,2}$/i;
/** Words that bound a date from above only: "until Friday", "up to yesterday" name no window. */
const UPPER_BOUND = /(?:^|\s)(?:until|till|before|up\s+to|jusqu['’]?(?:au|à)|avant|hasta)\s*$/i;
/** Words that make the four digits after them an identifier, not a year ("order 2025"). */
const IDENTIFIER_WORD =
  /(?:^|\s)(?:#|no\.?|nr\.?|num(?:ber)?|ref(?:erence)?|order|inv(?:oice)?|room|flight|ticket|account|acct|po|id|code|unit|model)\s*#?\s*$/i;
/** Quarters and halves: two characters, but a period ("Q3", "H2"). */
const PERIOD_CODE = /^(?:the\s+)?[QH][1-4]$/i;
/** A span counted back or forward from today: "last 7 days", "past 2 weeks", "next 3 months". */
const RELATIVE_SPAN =
  /^(?:the\s+)?(last|past|previous|next|coming|following)\s+(?:\d+|a\s+few|few|several|couple(?:\s+of)?|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i;
/** A day counted back in weeks, months or years: "2 years ago" means that year, not one day. */
const AGO_UNIT = /\b(weeks?|months?|years?)\s+ago\b/i;
/** "Last summer" is the most recent one that has ended, even when that is this year's. */
const LAST_SEASON = /^last\s+(?:summer|spring|winter|fall|autumn)$/i;
/** Prepositions, articles and connectors stripped together with the phrase they introduce. */
const LEADING_FILLER =
  /(?:^|\s)(?:(?:in|on|at|during|since|from|for|of|around|over|between|through|throughout|en|le|la|les|du|de|depuis|el|del|desde|the)\s*)+$/i;
/** Connectors left dangling at either end once the phrases they joined are stripped. */
const DANGLING = /^(?:to|and|or|-|–|between|from|et|y|à|au|a)$/i;

/** Words that point the query at the past or the future. */
const PAST_WORDS =
  /(?<!\p{L})(?:last|past|previous|ago|was|were|did|had|went|sent|received|paid|yesterday|dernier|derni[eè]re|pass[ée]e?|hier|pasad[oa]|ayer)(?!\p{L})/iu;
const FUTURE_WORDS =
  /(?<!\p{L})(?:next|upcoming|coming|tomorrow|prochaine?|demain|pr[óo]xim[oa]|mañana)(?!\p{L})/iu;

const MONTHS: Record<string, number> = {};
for (const [names, n] of [
  ["january jan janvier enero", 1],
  ["february feb février fevrier febrero", 2],
  ["march mar mars marzo", 3],
  ["april apr avril abril", 4],
  ["may mai mayo", 5],
  ["june jun juin junio", 6],
  ["july jul juillet julio", 7],
  ["august aug août aout agosto", 8],
  ["september sep sept septembre septiembre", 9],
  ["october oct octobre octubre", 10],
  ["november nov novembre noviembre", 11],
  ["december dec décembre decembre diciembre", 12],
] as const) {
  for (const name of names.split(" ")) MONTHS[name] = n;
}
const MONTH_WORD = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");
/**
 * A span between two named months, which the recognizer reads as two separate
 * months or not at all: "March to May 2025", "from Jan to March", "between
 * June and August", "mars à mai".
 */
const MONTH_RANGE = new RegExp(
  `(?<!\\p{L})(?:(from|between|de|entre|desde)\\s+)?(${MONTH_WORD})\\.?(?:\\s+(\\d{4}))?\\s*(?:(to|through|until|till|-|–|à|au|a|hasta)|(and|et|y))\\s*(${MONTH_WORD})\\.?(?:\\s+(\\d{4}))?(?!\\p{L})`,
  "giu",
);

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}/;
/** A range TIMEX whose end is the last day it names, not the day after it ("1 to 5 October"). */
const INCLUSIVE_END_TIMEX = /^\(.*(?:,P\d+D|T\d.*)\)$/;
/** A season TIMEX, with or without its year: `2025-SU`, `XXXX-WI`, `FA`. */
const SEASON_TIMEX = /^(?:(\d{4}|XXXX)-)?(SP|SU|FA|WI)$/;
/** A year the recognizer writes as month zero (French "l'année dernière"). */
const YEAR_TIMEX = /^(\d{4})-00$/;
const SEASON_MONTHS: Record<string, [number, number]> = {
  SP: [3, 6],
  SU: [6, 9],
  FA: [9, 12],
  WI: [12, 15],
};

interface Days {
  startDay: string;
  endDay: string;
}

interface Reading {
  start: number;
  end: number;
  text: string;
  windows: Days[];
}

/** What one culture made of the query. */
interface CultureReading {
  readings: Reading[];
  /** Spans the recognizer resolved, kept or not — no ISO day inside one is read again. */
  resolved: Array<{ start: number; end: number }>;
}

/**
 * The temporal intent of a query, or null when its words name no usable window.
 */
export function parseTemporalIntent(
  text: string,
  opts: TemporalIntentOptions,
): TemporalIntent | null {
  text = text.slice(0, MAX_QUERY_CHARS);
  if (text.trim() === "") return null;
  const today = wallClockDay(opts.nowMs, opts.timeZone);
  // The recognizer resolves against the reference's LOCAL calendar day, so
  // build it from the asker's wall-clock day at local noon — independent of
  // the host's own zone and clear of DST edges.
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const reference = new Date(y, m - 1, d, 12, 0, 0, 0);
  const direction = queryDirection(text);

  const english = englishCulture(opts.numericDateOrder);
  const cultures: DateCulture[] = [english];
  for (const [culture, evidence] of CULTURE_EVIDENCE)
    if (evidence.test(text)) cultures.push(culture);

  let best: { culture: DateCulture; readings: Reading[]; covered: number } | null = null;
  for (const culture of cultures) {
    const { readings } = readCulture(culture, text, reference, today, direction);
    const covered = readings.reduce((sum, r) => sum + (r.end - r.start), 0);
    if (readings.length > 0 && (!best || covered > best.covered)) {
      best = { culture, readings, covered };
    }
  }
  if (!best) return null;

  const seen = new Set<string>();
  const windows: TemporalWindow[] = [];
  const contributing: Reading[] = [];
  for (const reading of best.readings) {
    let contributed = false;
    for (const w of reading.windows) {
      const key = `${w.startDay}/${w.endDay}`;
      if (seen.has(key)) {
        contributed = true;
        continue;
      }
      if (windows.length >= MAX_WINDOWS) continue;
      seen.add(key);
      contributed = true;
      windows.push({
        ...w,
        startMs: dayStartMs(w.startDay, opts.timeZone),
        endExclusiveMs: dayStartMs(w.endDay, opts.timeZone),
        text: reading.text,
      });
    }
    if (contributed) contributing.push(reading);
  }
  if (windows.length === 0) return null;
  return {
    windows,
    strippedText: stripReadings(text, contributing),
    culture: best.culture,
    timeZone: opts.timeZone,
  };
}

function readCulture(
  culture: DateCulture,
  text: string,
  reference: Date,
  today: string,
  direction: Direction,
): CultureReading {
  let results: RtModelResult[];
  try {
    results = dateTimeModel(culture).parse(text, reference);
  } catch {
    return { readings: [], resolved: [] };
  }
  const thisYear = Number(today.slice(0, 4));
  const readings: Reading[] = [];
  const resolved: CultureReading["resolved"] = [];
  for (const r of results) {
    const start = r.start;
    const end = r.end + 1;
    if (r.resolution?.values?.some((v) => v.timex)) resolved.push({ start, end });
    const phrase = text.slice(start, end);
    if (!plausiblePhrase(phrase, text.slice(0, start), text.slice(end), thisYear)) continue;
    const windows = windowsOf(r, phrase, today, direction);
    if (windows.length > 0) readings.push({ start, end, text: phrase, windows });
  }
  // A span between two months replaces the separate month readings inside it.
  const ranges = monthRanges(text, today, direction);
  const kept = readings.filter((r) => !ranges.some((g) => g.start < r.end && r.start < g.end));
  const all = [...kept, ...ranges];
  return {
    readings: [...all, ...unreadIsoDays(text, [...all, ...resolved])]
      .filter((r) => !insideQuotedPhrase(text, r))
      .sort((a, b) => a.start - b.start),
    resolved,
  };
}

/**
 * Whether a reading sits inside a quoted phrase that is more than the date: a
 * quoted phrase asks for its literal words ("Quarterly notes 2022-23"), not
 * for a time. A quoted date on its own ("22 May 2026") is still one.
 */
function insideQuotedPhrase(text: string, r: Reading): boolean {
  for (const m of text.matchAll(/"([^"]*)"/g)) {
    const start = m.index! + 1;
    const end = start + m[1]!.length;
    if (r.start < end && start < r.end) return m[1]!.trim() !== r.text.trim();
  }
  return false;
}

/**
 * ISO days nothing the recognizer resolved covers. Two adjacent ISO dates
 * ("2026-07-08 2026-07-29") can merge into one unresolvable match that
 * swallows the second; an ISO day is unambiguous, so it is read directly. A
 * day inside a resolved phrase that was set aside ("before 2026-09-01") stays
 * set aside.
 */
function unreadIsoDays(
  text: string,
  covered: ReadonlyArray<{ start: number; end: number }>,
): Reading[] {
  const found: Reading[] = [];
  for (const m of text.matchAll(/(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (covered.some((r) => r.start < end && start < r.end)) continue;
    const day = m[0];
    if (Number.isNaN(Date.parse(`${day}T00:00:00Z`))) continue;
    if (UPPER_BOUND.test(text.slice(0, start))) continue;
    found.push({ start, end, text: day, windows: [{ startDay: day, endDay: addDays(day, 1) }] });
  }
  return found;
}

/** Spans between two named months, as one window each. */
function monthRanges(text: string, today: string, direction: Direction): Reading[] {
  const found: Reading[] = [];
  for (const m of text.matchAll(MONTH_RANGE)) {
    const [whole, opener, fromName, fromYear, toWord, andWord, toName, toYear] = m;
    // "June and August" lists two months; only "between June and August" spans them.
    if (andWord && !/^(?:between|entre)$/i.test(opener ?? "")) continue;
    if (!toWord && !andWord) continue;
    const from = MONTHS[fromName!.toLowerCase()]!;
    const to = MONTHS[toName!.toLowerCase()]!;
    const span = (endYear: number): Days => {
      const startYear = fromYear ? Number(fromYear) : from <= to ? endYear : endYear - 1;
      return { startDay: monthDay(startYear, from), endDay: monthDay(endYear, to + 1) };
    };
    const thisYear = Number(today.slice(0, 4));
    const endYear = toYear
      ? Number(toYear)
      : fromYear
        ? Number(fromYear) + (from <= to ? 0 : 1)
        : null;
    const windows =
      endYear !== null
        ? [span(endYear)]
        : pickReadings([span(thisYear - 1), span(thisYear), span(thisYear + 1)], today, direction);
    const ok = windows.filter((w) => spanDays(w.startDay, w.endDay) <= MAX_WINDOW_DAYS);
    if (ok.length > 0) {
      const start = m.index!;
      found.push({ start, end: start + whole!.length, text: whole!, windows: ok });
    }
  }
  return found;
}

/**
 * Build every culture's recognizer model and run its first parse, which is
 * where most of the one-time cost lies (up to about a second for French);
 * paid at boot, it never lands on a search.
 */
export function warmTemporalIntent(): void {
  const reference = new Date();
  for (const culture of ["en-us", "en-*", "fr-fr", "es-es"] as const) {
    dateTimeModel(culture).parse(
      "du 1 au 3 mars 2026, la semaine prochaine, next Monday",
      reference,
    );
  }
}

/**
 * Whether a match reads as a date in its place: not a number that is an
 * identifier, not a homograph or name without a word that introduces a date,
 * not a part of a phrase the recognizer did not finish reading, and not an
 * upper bound with no near edge.
 */
function plausiblePhrase(phrase: string, before: string, after: string, thisYear: number): boolean {
  const bare = phrase.trim();
  if (UNCONSUMED_QUALIFIER.test(after) || BARE_UNIT.test(bare) || WEEK_NUMBER.test(bare)) {
    return false;
  }
  if (UPPER_BOUND.test(before)) return false;
  if (/^\d+$/.test(bare)) {
    if (bare.length !== 4) return false;
    const year = Number(bare);
    if (year < FIRST_YEAR || year > thisYear + YEARS_AHEAD) return false;
    // Glued to other characters ("#2025", "2024/0012", "2022/23") or named
    // as one ("order 2025"), four digits are an identifier.
    if (/[#/.\p{L}\p{N}-]$/u.test(before) || /^[/.-]\d/.test(after)) return false;
    return !IDENTIFIER_WORD.test(before);
  }
  if (HOMOGRAPH.test(bare)) {
    if (DATE_PREPOSITION.test(before)) return true;
    return FROM.test(before) && FROM_NOT_A_NAME.test(bare);
  }
  if (NAME.test(bare) && PERSON_CONTEXT.test(before)) return false;
  // Capitalized date words followed by a capitalized word are a name or a
  // title: "June Carter", "Sunday Times", "Saturday Night Live".
  if (/^\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)*$/u.test(bare) && /^\s+\p{Lu}\p{Ll}/u.test(after)) {
    return false;
  }
  if (PERIOD_CODE.test(bare)) return true;
  // A phrase of a letter or two ("h", "an") is a token the recognizer over-read.
  return bare.replace(/[^\p{L}\p{N}]/gu, "").length >= 3;
}

type Direction = "past" | "future" | "nearest";

function queryDirection(text: string): Direction {
  const past = PAST_WORDS.test(text);
  const future = FUTURE_WORDS.test(text);
  if (past === future) return "nearest";
  return past ? "past" : "future";
}

/** The windows one recognizer match names, after choosing among its past and future readings. */
function windowsOf(r: RtModelResult, phrase: string, today: string, direction: Direction): Days[] {
  const type = r.typeName.replace(/^datetimeV2\./, "");
  if (!["date", "daterange", "datetime", "datetimerange"].includes(type)) return [];
  const candidates: Days[] = [];
  for (const v of r.resolution?.values ?? []) {
    const w = valueWindow(v, type, phrase, today);
    if (w && spanDays(w.startDay, w.endDay) <= MAX_WINDOW_DAYS) candidates.push(w);
  }
  if (candidates.length <= 1) return candidates;
  return pickReadings(candidates, today, direction);
}

/** One resolution value as a half-open day window, or null when it names none. */
function valueWindow(
  v: RtResolutionValue,
  type: string,
  phrase: string,
  today: string,
): Days | null {
  const timex = v.timex ?? "";
  if (timex === "" || timex === "PRESENT_REF") return null;

  const season = SEASON_TIMEX.exec(timex);
  if (season) return seasonWindow(season[1] ?? "XXXX", season[2]!, LAST_SEASON.test(phrase), today);
  const year = YEAR_TIMEX.exec(timex);
  if (year) return { startDay: `${year[1]}-01-01`, endDay: `${Number(year[1]) + 1}-01-01` };

  if (type === "date" || type === "datetime") {
    if (!v.value || !DAY.test(v.value)) return null;
    const day = v.value.slice(0, 10);
    const unit = AGO_UNIT.exec(phrase)?.[1];
    return unit ? containing(day, unit) : { startDay: day, endDay: addDays(day, 1) };
  }

  const start = v.start && DAY.test(v.start) ? v.start.slice(0, 10) : null;
  const end = v.end && DAY.test(v.end) ? v.end.slice(0, 10) : null;
  if (start && end) {
    const relative = RELATIVE_SPAN.exec(phrase);
    if (relative) {
      // The recognizer's span is already half-open. One counted back from
      // today stops short of it; today is part of "the last 2 weeks".
      const back = /^(?:last|past|previous)$/i.test(relative[1]!);
      const tomorrow = addDays(today, 1);
      return { startDay: start, endDay: back && end < tomorrow ? tomorrow : end };
    }
    if (type === "datetimerange" || start === end)
      return { startDay: start, endDay: addDays(end, 1) };
    return { startDay: start, endDay: INCLUSIVE_END_TIMEX.test(timex) ? addDays(end, 1) : end };
  }
  // An open span counts only up to now: "since March", "after 1 January".
  // "Before June" and an open span starting in the future name no near edge.
  if (start && !end && /^(?:since|after)/.test(v.Mod ?? "") && start <= today) {
    return { startDay: start, endDay: addDays(today, 1) };
  }
  return null;
}

/** The week (from Monday), month or year containing a day. */
function containing(day: string, unit: string): Days {
  if (/^week/i.test(unit)) {
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    const monday = addDays(day, -weekday);
    return { startDay: monday, endDay: addDays(monday, 7) };
  }
  const [y, m] = day.split("-").map(Number) as [number, number];
  if (/^month/i.test(unit)) return { startDay: monthDay(y, m), endDay: monthDay(y, m + 1) };
  return { startDay: `${y}-01-01`, endDay: `${y + 1}-01-01` };
}

/**
 * A season's months (northern hemisphere), in the named year or, without one,
 * the current or most recent one. "Last summer" is the most recent that has
 * ended.
 */
function seasonWindow(year: string, season: string, last: boolean, today: string): Days {
  const [from, to] = SEASON_MONTHS[season]!;
  const at = (y: number) => ({ startDay: monthDay(y, from), endDay: monthDay(y, to) });
  const thisYear = Number(today.slice(0, 4));
  if (last) return at(at(thisYear).endDay <= today ? thisYear : thisYear - 1);
  if (year !== "XXXX") return at(Number(year));
  return at(at(thisYear).startDay > today ? thisYear - 1 : thisYear);
}

function monthDay(year: number, month: number): string {
  const y = year + Math.floor((month - 1) / 12);
  const m = ((month - 1) % 12) + 1;
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

/**
 * The readings a query means among a year-less date's past and future
 * candidates: the one its direction words point at; without any, the nearer
 * (the future at double distance) — and the other as well when it is close
 * too, or when the reading spans a month or more.
 */
function pickReadings(candidates: Days[], today: string, direction: Direction): Days[] {
  const past = candidates.filter((c) => c.startDay <= today);
  const future = candidates.filter((c) => c.startDay > today);
  const latestPast = past[past.length - 1];
  const nextFuture = future[0];
  if (direction === "past" && latestPast) return [latestPast];
  if (direction === "future" && nextFuture) return [nextFuture];
  if (!latestPast || !nextFuture) return [(latestPast ?? nextFuture)!];
  const pastDistance = latestPast.endDay > today ? 0 : spanDays(latestPast.endDay, today);
  const futureDistance = spanDays(today, nextFuture.startDay);
  const monthScale = spanDays(latestPast.startDay, latestPast.endDay) >= MONTH_SCALE_DAYS;
  if (monthScale || Math.max(pastDistance, futureDistance) <= BOTH_READINGS_WITHIN_DAYS) {
    return [latestPast, nextFuture];
  }
  return [pastDistance <= futureDistance * FUTURE_DISTANCE_PENALTY ? latestPast : nextFuture];
}

/** The query with each read phrase, and the words introducing or joining it, removed. */
function stripReadings(text: string, readings: Reading[]): string {
  let out = "";
  let cursor = 0;
  for (const r of readings) {
    let head = text.slice(cursor, r.start);
    const filler = LEADING_FILLER.exec(head);
    if (filler) head = head.slice(0, filler.index);
    out += `${head} `;
    cursor = r.end;
  }
  out += text.slice(cursor).replace(/^'s\b/, "");
  const words = out.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  while (words.length > 0 && DANGLING.test(words[0]!)) words.shift();
  while (words.length > 0 && DANGLING.test(words[words.length - 1]!)) words.pop();
  return words.join(" ");
}

function wallClockDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

function dayStartMs(day: string, timeZone: string): number {
  const [year, month, d] = day.split("-").map(Number) as [number, number, number];
  return zonedDateTimeToMs(
    { year, month, day: d, hour: 0, minute: 0, second: 0, millisecond: 0 },
    timeZone,
  );
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}
