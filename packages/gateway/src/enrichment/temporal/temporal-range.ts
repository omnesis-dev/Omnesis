// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

const OFFSET_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const RELATIVE = /^([+-])(\d+)([dwMy])$/;

interface CalendarParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error(`Invalid IANA time zone: ${timeZone}`);
  }
}

function zonedParts(ms: number, timeZone: string): CalendarParts {
  const parts = formatter(timeZone).formatToParts(new Date(ms));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
    millisecond: new Date(ms).getUTCMilliseconds(),
  };
}

function partsAsUtc(parts: CalendarParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
}

/**
 * The widest gap a spring-forward transition has ever opened, with room to
 * spare. A residual larger than this is not a clock shift, so it is treated as
 * corrupt input rather than quietly rounded away.
 */
const MAX_DST_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * Convert a wall-clock value in an IANA zone to its UTC instant.
 *
 * A spring-forward transition deletes an interval of local time, so some
 * wall-clock values name an instant that never happened — a zone that shifts
 * at midnight (Chile, for one) has no 00:00 on that date, which is exactly the
 * value an all-day row resolves through. Such a value is *asked for* in good
 * faith by anyone requesting that day's calendar, so it resolves forward to
 * the first instant that does exist, which is the day's true first moment.
 * Refusing would deny a whole day of results to justify a distinction nobody
 * asked about, and the loop above has already computed that instant.
 */
export function zonedDateTimeToMs(parts: CalendarParts, timeZone: string): number {
  let candidate = partsAsUtc(parts);
  for (let iteration = 0; iteration < 4; iteration++) {
    const actual = zonedParts(candidate, timeZone);
    const delta = partsAsUtc(parts) - partsAsUtc(actual);
    if (delta === 0) break;
    candidate += delta;
  }
  const final = zonedParts(candidate, timeZone);
  const residual = partsAsUtc(final) - partsAsUtc(parts);
  if (residual === 0) return candidate;
  if (Math.abs(residual) > MAX_DST_GAP_MS) {
    throw new Error("Local time does not exist in the requested time zone");
  }
  // The loop settles on the instant just *before* the deleted interval, whose
  // wall clock still reads the previous day. Stepping over the gap lands on
  // the first instant that exists — the day's true start. Settling for the
  // near miss would begin "the 6th" an hour into the 5th and sweep in the
  // previous evening's rows.
  return candidate - residual;
}

function validDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function atStartOfDay(year: number, month: number, day: number): CalendarParts {
  if (!validDate(year, month, day)) throw new Error("Invalid calendar date");
  return { year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 };
}

function addCalendar(
  parts: CalendarParts,
  amount: number,
  unit: "d" | "w" | "M" | "y",
): CalendarParts {
  const date = new Date(partsAsUtc(parts));
  if (unit === "d") date.setUTCDate(date.getUTCDate() + amount);
  else if (unit === "w") date.setUTCDate(date.getUTCDate() + amount * 7);
  else if (unit === "M") date.setUTCMonth(date.getUTCMonth() + amount);
  else date.setUTCFullYear(date.getUTCFullYear() + amount);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}

function relativeMs(expression: string, baseMs: number, timeZone: string): number | null {
  const match = RELATIVE.exec(expression);
  if (!match) return null;
  const amount = Number(match[2]) * (match[1] === "-" ? -1 : 1);
  const base = zonedParts(baseMs, timeZone);
  return zonedDateTimeToMs(addCalendar(base, amount, match[3] as "d" | "w" | "M" | "y"), timeZone);
}

function coarsePeriod(
  expression: string,
  timeZone: string,
): { startMs: number; endExclusiveMs: number } | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expression);
  if (day) {
    const start = atStartOfDay(Number(day[1]), Number(day[2]), Number(day[3]));
    return {
      startMs: zonedDateTimeToMs(start, timeZone),
      endExclusiveMs: zonedDateTimeToMs(addCalendar(start, 1, "d"), timeZone),
    };
  }
  const month = /^(\d{4})-(\d{2})$/.exec(expression);
  if (month) {
    const year = Number(month[1]);
    const monthNumber = Number(month[2]);
    const start = atStartOfDay(year, monthNumber, 1);
    if (monthNumber < 1 || monthNumber > 12) throw new Error("Invalid calendar month");
    return {
      startMs: zonedDateTimeToMs(start, timeZone),
      endExclusiveMs: zonedDateTimeToMs(addCalendar(start, 1, "M"), timeZone),
    };
  }
  const year = /^(\d{4})$/.exec(expression);
  if (year) {
    const start = atStartOfDay(Number(year[1]), 1, 1);
    return {
      startMs: zonedDateTimeToMs(start, timeZone),
      endExclusiveMs: zonedDateTimeToMs(addCalendar(start, 1, "y"), timeZone),
    };
  }
  return null;
}

function instant(expression: string, nowMs: number, timeZone: string): number | null {
  if (expression === "now") return nowMs;
  const relative = relativeMs(expression, nowMs, timeZone);
  if (relative !== null) return relative;
  if (!OFFSET_INSTANT.test(expression)) return null;
  const parsed = Date.parse(expression);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ResolvedTemporalRange {
  fromMs: number;
  toExclusiveMs: number;
}

/**
 * Resolve the public temporal-query range. Bare dates are wall-clock periods
 * in `timeZone`; `to` is always an exclusive boundary; relative calendar
 * arithmetic observes DST rather than adding fixed milliseconds.
 */
export function resolveTemporalRange(
  input: { from: string; to?: string; timeZone: string },
  nowMs = Date.now(),
): ResolvedTemporalRange {
  // Validate eagerly even when both bounds are offset instants.
  formatter(input.timeZone);
  const coarseFrom = coarsePeriod(input.from, input.timeZone);
  const fromMs = coarseFrom?.startMs ?? instant(input.from, nowMs, input.timeZone);
  if (fromMs === null) {
    throw new Error(
      "Invalid from; use an offset ISO instant, YYYY[-MM[-DD]], now, or a relative calendar offset",
    );
  }

  let toExclusiveMs: number;
  if (input.to === undefined) {
    toExclusiveMs = coarseFrom?.endExclusiveMs ?? fromMs + 1;
  } else {
    const relative = relativeMs(input.to, fromMs, input.timeZone);
    const coarse = coarsePeriod(input.to, input.timeZone);
    const resolved = relative ?? coarse?.startMs ?? instant(input.to, nowMs, input.timeZone);
    if (resolved === null) {
      throw new Error(
        "Invalid to; use an offset ISO instant, YYYY[-MM[-DD]], now, or a relative calendar offset",
      );
    }
    toExclusiveMs = resolved;
  }
  if (toExclusiveMs <= fromMs) {
    throw new Error("Temporal query `to` must be later than `from`");
  }
  return { fromMs, toExclusiveMs };
}
