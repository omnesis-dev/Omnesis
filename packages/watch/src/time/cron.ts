// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The recurring-time surface of `source.time`.
 *
 * The spelling is five-field cron (`minute hour day-of-month month day-of-week`)
 * because it is the notation everyone already reads. It is *not* a cron daemon:
 * there is no cron anywhere in Omnesis. A recurring time source compiles to a
 * persisted due-gate — "what is the next boundary at or after instant T?" — that
 * a coarse tick interrogates. This module answers exactly that question, and
 * answers it from an instant the caller supplies, never from the machine clock.
 *
 * Supported per field: `*`, a number, a comma list, a range (`1-5`), and a step
 * (`*\/15`, `1-5/2`). Day-of-week accepts `SUN`..`SAT` as well as `0`..`6`
 * (with `7` meaning Sunday). The non-standard `@`-macros are not supported —
 * a compiler that wants "daily at 9" writes `0 9 * * *`.
 */

import { lookup } from "../internal/lookup.js";

export interface CronExpression {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /**
   * Whether day-of-month and day-of-week were both restricted. Cron's historical
   * rule is that two restricted day fields are OR'd, not AND'd; a schedule that
   * relies on it should be readable back out of the parsed form.
   */
  readonly bothDayFieldsRestricted: boolean;
}

const DAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

interface FieldSpec {
  min: number;
  max: number;
  names?: Record<string, number>;
  /** Cron lets 7 mean Sunday in the day-of-week field. */
  wrapMaxTo?: number;
}

const FIELDS: readonly FieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES },
  { min: 0, max: 7, names: DAY_NAMES, wrapMaxTo: 0 },
];

/** Parse a five-field cron expression. Returns `null` on anything malformed. */
export function parseCron(text: string): CronExpression | null {
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const parsed: Set<number>[] = [];
  for (let i = 0; i < FIELDS.length; i++) {
    const values = parseField(fields[i]!, FIELDS[i]!);
    if (!values) return null;
    parsed.push(values);
  }

  // Cron's OR rule applies when both day fields are *restricted*. A field that
  // begins with `*` is not: `*/2` still spans the whole range, it just steps
  // through it. Treating it as restricted turns "Mondays" into "every day".
  const dayOfMonthRestricted = !fields[2]!.startsWith("*");
  const dayOfWeekRestricted = !fields[4]!.startsWith("*");

  return {
    minutes: parsed[0]!,
    hours: parsed[1]!,
    daysOfMonth: parsed[2]!,
    months: parsed[3]!,
    daysOfWeek: parsed[4]!,
    bothDayFieldsRestricted: dayOfMonthRestricted && dayOfWeekRestricted,
  };
}

function parseField(field: string, spec: FieldSpec): Set<number> | null {
  const out = new Set<number>();

  for (const part of field.split(",")) {
    if (part.length === 0) return null;

    const [rangePart, stepPart, ...rest] = part.split("/");
    if (rest.length > 0) return null;

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) return null;
      step = Number(stepPart);
      if (step < 1) return null;
    }

    let low: number;
    let high: number;
    if (rangePart === "*") {
      low = spec.min;
      high = spec.max;
    } else {
      const bounds = rangePart!.split("-");
      if (bounds.length > 2) return null;
      const first = parseValue(bounds[0]!, spec);
      if (first === null) return null;
      if (bounds.length === 1) {
        // A bare number with a step means "from here to the end of the range".
        low = first;
        high = stepPart === undefined ? first : spec.max;
      } else {
        const second = parseValue(bounds[1]!, spec);
        if (second === null || second < first) return null;
        low = first;
        high = second;
      }
    }

    for (let v = low; v <= high; v += step) out.add(normalize(v, spec));
  }

  return out.size > 0 ? out : null;
}

function parseValue(token: string, spec: FieldSpec): number | null {
  const named = spec.names ? lookup(spec.names, token.toUpperCase()) : undefined;
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) return null;
  const value = Number(token);
  if (value < spec.min || value > spec.max) return null;
  return value;
}

function normalize(value: number, spec: FieldSpec): number {
  if (spec.wrapMaxTo !== undefined && value === spec.max) return spec.wrapMaxTo;
  return value;
}

/** Civil (timezone-local) breakdown of an instant. */
interface CivilTime {
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const MINUTE_MS = 60_000;

/**
 * The first instant strictly after `afterEpochMs` that the expression matches,
 * evaluated in the timezone `timeZoneOffsetMinutes` describes.
 *
 * Returns `null` if no boundary exists within the search horizon — a schedule
 * like `0 0 30 2 *` (February 30th) never fires, and saying so beats looping.
 * The horizon is eight years, which spans the longest real gap a five-field
 * expression can have: February 29th skips a century non-leap year, so
 * 2096 → 2104.
 */
export function nextCronOccurrence(
  cron: CronExpression,
  afterEpochMs: number,
  timeZoneOffsetMinutes = 0,
): number | null {
  const offsetMs = timeZoneOffsetMinutes * MINUTE_MS;
  // Cron resolution is one minute; start from the next whole minute boundary.
  let cursor = Math.floor(afterEpochMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;

  const limit = afterEpochMs + 8 * 366 * 86_400_000;
  while (cursor <= limit) {
    const civil = toCivil(cursor + offsetMs);
    if (matches(cron, civil)) return cursor;

    // Skip whole days when the day itself cannot match — turns the worst case
    // (a yearly schedule) from ~2M minute probes into ~1.5k day probes.
    if (!matchesDay(cron, civil)) {
      const startOfNextLocalDay =
        cursor + (86_400_000 - (civil.hour * 60 + civil.minute) * MINUTE_MS);
      cursor = startOfNextLocalDay;
      continue;
    }
    cursor += MINUTE_MS;
  }

  return null;
}

function matches(cron: CronExpression, civil: CivilTime): boolean {
  return cron.minutes.has(civil.minute) && cron.hours.has(civil.hour) && matchesDay(cron, civil);
}

function matchesDay(cron: CronExpression, civil: CivilTime): boolean {
  if (!cron.months.has(civil.month)) return false;

  const dayOfMonthMatch = cron.daysOfMonth.has(civil.day);
  const dayOfWeekMatch = cron.daysOfWeek.has(civil.weekday);

  // Classic cron: when both day fields are restricted they are OR'd.
  return cron.bothDayFieldsRestricted
    ? dayOfMonthMatch || dayOfWeekMatch
    : dayOfMonthMatch && dayOfWeekMatch;
}

function toCivil(localEpochMs: number): CivilTime {
  const d = new Date(localEpochMs);
  return {
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}
