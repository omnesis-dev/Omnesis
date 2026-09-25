// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The interval algebra every temporal fact is canonicalized through.
 *
 * Both projection planes — analytics rows and documents — reduce a declared
 * start (and optional end) to the same half-open interval here, so a calendar
 * day means the same thing whichever plane produced it.
 *
 * Three invariants are worth stating because the obvious alternatives are wrong:
 *
 * 1. **Intervals are half-open, `[start, endExclusive)`.** An instant-precision
 *    fact with no duration is empty: `endExclusive === start`. Padding it to one
 *    millisecond would make every duration computed downstream wrong by 1 ms and
 *    hide the "instantaneous" signal behind a separate `precision` field the
 *    caller has to remember to check.
 * 2. **A day-precision interval is never empty.** A day names a 24-hour span, so
 *    the smallest day interval is one whole day. Writing a degenerate day
 *    (`endExclusive === start`) would leave the fact indistinguishable from an
 *    instant to every reader that windows on the bounds, and windowing is the
 *    only thing the bounds exist for.
 * 3. **Day-precision values stay calendar days.** A day is canonicalized to
 *    `YYYY-MM-DD`, not to an instant, because which instants it covers depends
 *    on the reader's time zone and is resolved at query time.
 */

export type TemporalIntervalPrecision = "instant" | "day";

export interface CanonicalInterval {
  /** UTC-anchored bounds, for indexing and windowing. */
  startMs: number;
  endExclusiveMs: number;
  /** `YYYY-MM-DD` for a day, a full ISO instant otherwise. */
  startCanonical: string;
  endCanonical: string;
  precision: TemporalIntervalPrecision;
  allDay: boolean;
}

const DAY_MS = 86_400_000;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An ISO-8601 instant carrying an explicit zone designator: `Z` or `±HH:MM`.
 * Seconds and a fractional part are optional; the designator is not.
 *
 * Every value that legitimately reaches here already has one. A projection's
 * instant bounds come from a `TIMESTAMPTZ` analytics column or from a document
 * date field, both of which are contractually offset-bearing, and a `Date`
 * renders as UTC. A wall-clock string without a designator names a different
 * instant in every zone, so accepting one means silently anchoring a fact to
 * whichever zone the gateway process happens to run in.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * How far a stored UTC-canonical day boundary can sit from the same calendar
 * day in a reader's zone. Real offsets span -12:00 to +14:00, so one day is a
 * safe bound; a window query widens by this much before filtering, then applies
 * the exact overlap test in the reader's zone.
 *
 * Exported because the widening happens in more than one store, and two copies
 * of the constant that drift would silently drop facts at window edges.
 */
export const MAX_TIME_ZONE_SHIFT_MS = DAY_MS;

/** True when the value is a bare calendar day rather than an instant. */
export function isCalendarDay(value: unknown): boolean {
  return typeof value === "string" && ISO_DAY.test(value);
}

function toRawString(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function canonicalDay(value: unknown, label: string): string {
  const raw = toRawString(value);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (!match) throw new Error(`Temporal ${label} must contain an ISO date`);
  const day = match[1];
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day) {
    throw new Error(`Temporal ${label} is not a valid date`);
  }
  return day;
}

/**
 * Reduce a fractional-second capture to whole milliseconds, the resolution the
 * canonical form carries. Sub-millisecond digits are truncated, not rounded, so
 * the stored instant never moves past the declared one.
 */
function fractionToMs(fraction: string | undefined): number {
  return fraction === undefined ? 0 : Number(fraction.padEnd(3, "0").slice(0, 3));
}

/**
 * Parse an instant, rejecting anything whose shape or calendar does not hold.
 *
 * The parse is deliberately not `Date.parse`: that accepts implementation-defined
 * forms and rolls impossible components over instead of refusing them, so
 * `2026-02-30T08:00:00Z` would be stored as March 2nd. Components are read from
 * the ISO grammar and rebuilt into a UTC date, then compared back field by field
 * — a rolled-over month, day, hour, minute, or second fails the comparison.
 */
/**
 * Reduce a single value to one canonical UTC instant, rejecting anything that
 * is not an unambiguous ISO-8601 instant. Exported so a caller needing one
 * timestamp rather than an interval validates it the same way.
 */
export function canonicalInstant(value: unknown, label: string): { iso: string; ms: number } {
  const raw = toRawString(value);
  const match = ISO_INSTANT.exec(raw);
  if (!match) {
    throw new Error(`Temporal ${label} must be an ISO instant with a UTC offset or Z`);
  }
  const [, year, month, day, hour, minute, second, fraction, sign, offsetHour, offsetMinute] =
    match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: second === undefined ? 0 : Number(second),
  };

  // `setUTCFullYear` rather than `Date.UTC`, which remaps years 0–99 into the
  // 20th century and would reject a valid year 0026 on the round-trip below.
  const utc = new Date(0);
  utc.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  utc.setUTCHours(parts.hour, parts.minute, parts.second, fractionToMs(fraction));
  const rolled =
    utc.getUTCFullYear() !== parts.year ||
    utc.getUTCMonth() !== parts.month - 1 ||
    utc.getUTCDate() !== parts.day ||
    utc.getUTCHours() !== parts.hour ||
    utc.getUTCMinutes() !== parts.minute ||
    utc.getUTCSeconds() !== parts.second;
  if (rolled) throw new Error(`Temporal ${label} is not a valid instant`);

  if (sign !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) {
    throw new Error(`Temporal ${label} is not a valid instant`);
  }
  // A `+05:30` value is 5h30 ahead of UTC, so its UTC instant is that much earlier.
  const offsetMinutes =
    sign === undefined
      ? 0
      : (sign === "-" ? -1 : 1) * (Number(offsetHour) * 60 + Number(offsetMinute));
  const ms = utc.getTime() - offsetMinutes * 60_000;
  if (!Number.isFinite(ms)) throw new Error(`Temporal ${label} is not a valid instant`);
  return { iso: new Date(ms).toISOString(), ms };
}

/**
 * An instant as some datastore chose to render it on the way back out.
 *
 * The strict grammar above is what a caller *declares*; this is what one
 * actually receives. A `TIMESTAMPTZ` column written as `2026-07-31T14:09:00Z`
 * comes back from SQL and DuckDB as `2026-07-31 15:09:00+01` — a space where
 * ISO wants `T`, a two-digit offset where ISO wants `±HH:MM`, and the reader's
 * offset rather than the writer's. It is the same instant spelled differently,
 * and only the spelling differs.
 */
const RENDERED_INSTANT =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** The same, for a zoneless column: any designator is noise rather than data. */
const RENDERED_WALL_CLOCK =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * The input to a tolerant canonicalizer, or null when there is no string to read.
 *
 * Deliberately narrower than `toRawString`: that one calls `toISOString()`,
 * which throws on an invalid `Date`, and coerces anything else through
 * `String()` — so a one-element array would arrive looking like its element.
 * Both defeat the null contract these functions promise, and the promise is
 * what lets a caller normalize a stream of values from sources it does not
 * control without one bad value costing the batch.
 */
function renderedString(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return typeof value === "string" ? value : null;
}

/**
 * Reduce an offset-bearing value to one canonical UTC instant, tolerating the
 * renderings a datastore hands back.
 *
 * This is what a `TIMESTAMPTZ` value is canonicalized through. Two spellings of
 * one instant collapse to one string, which is the whole point: a consumer that
 * hashes or compares the rendered value must not see a change where the clock
 * did not move. Re-spelling into the strict grammar and delegating leaves one
 * copy of the calendar validation rather than two that can drift.
 *
 * Returns `null` instead of throwing, because callers here are normalizing a
 * stream of values from sources they do not control and a single unparseable
 * one must not abort the batch — the caller keeps the original and moves on.
 */
export function toCanonicalInstant(value: unknown): string | null {
  const raw = renderedString(value);
  if (raw === null) return null;
  const match = RENDERED_INSTANT.exec(raw);
  if (!match) return null;
  const [, day, clock, zone] = match;
  // `+01` → `+01:00`, `+0100` → `+01:00`; `Z` is already strict.
  const designator =
    zone === "Z"
      ? "Z"
      : zone.length === 3
        ? `${zone}:00`
        : zone.includes(":")
          ? zone
          : `${zone.slice(0, 3)}:${zone.slice(3)}`;
  try {
    return canonicalInstant(`${day}T${clock}${designator}`, "value").iso;
  } catch {
    return null;
  }
}

/**
 * Reduce a zoneless value to one canonical wall-clock spelling.
 *
 * This is what a `TIMESTAMP` value is canonicalized through. The column is
 * declared without a zone, so the digits *are* the value and any designator on
 * them is spurious — a source rendering a local stamp with a trailing `Z` has
 * not said "UTC", it has said nothing, and shifting the digits to honour it
 * would move a wall-clock reading to a different wall clock. So the designator
 * is dropped and the digits are kept, which is also what makes two renderings
 * of one reading compare equal.
 *
 * The designator is not validated on the way out, because it carries no
 * meaning here: `2026-07-31 08:00:00+99:00` is accepted for a zoneless column
 * and yields `2026-07-31T08:00:00.000`, where {@link toCanonicalInstant} would
 * refuse the same string. Nothing reads the offset, so an impossible one is
 * noise like any other.
 */
export function toCanonicalWallClock(value: unknown): string | null {
  const raw = renderedString(value);
  if (raw === null) return null;
  const match = RENDERED_WALL_CLOCK.exec(raw);
  if (!match) return null;
  const [, day, clock] = match;
  // Validated against the strict grammar as UTC, purely to reject an
  // impossible calendar date; the designator is not part of the result.
  try {
    canonicalInstant(`${day}T${clock}Z`, "value");
  } catch {
    return null;
  }
  const [hours, minutes, rest = "00"] = clock.split(":");
  const [seconds, fraction = ""] = rest.split(".");
  const millis = fraction === "" ? "000" : fraction.padEnd(3, "0").slice(0, 3);
  return `${day}T${hours}:${minutes}:${seconds}.${millis}`;
}

function nextUtcDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
}

/**
 * Reduce a declared start/end pair to a canonical half-open interval.
 *
 * `allDay` may be stated explicitly (an analytics row carrying a boolean
 * column) or left undefined, in which case it is inferred from whether the
 * start value is a bare calendar day. Inference is what lets the document plane
 * work without a boolean field of its own: a source that writes `2026-03-04`
 * has said "all day" precisely by writing a day.
 */
export function canonicalizeInterval(args: {
  start: unknown;
  end?: unknown;
  allDay?: boolean;
  /** Prefix for error messages, e.g. a table and record key. */
  context?: string;
}): CanonicalInterval {
  const { start, end, context } = args;
  const where = context ? `${context}: ` : "";
  const allDay = args.allDay ?? isCalendarDay(start);

  if (allDay) {
    const startCanonical = canonicalDay(start, `${where}start`);
    const declaredEnd = end === undefined || end === null ? null : canonicalDay(end, `${where}end`);
    if (declaredEnd !== null && declaredEnd < startCanonical) {
      throw new Error(`${where}temporal end must not precede start`);
    }
    // A day's end is exclusive: a fact occupying March 4th ends on the 5th. A
    // fact that declares no end, or declares an end that does not advance past
    // its start, covers exactly its start day — never zero time, because a day
    // is a 24-hour span and an empty interval reads as an instantaneous point.
    const endCanonical =
      declaredEnd === null || declaredEnd === startCanonical
        ? nextUtcDay(startCanonical)
        : declaredEnd;
    const startMs = Date.parse(`${startCanonical}T00:00:00.000Z`);
    const endExclusiveMs = Date.parse(`${endCanonical}T00:00:00.000Z`);
    return {
      startMs,
      endExclusiveMs,
      startCanonical,
      endCanonical,
      precision: "day",
      allDay: true,
    };
  }

  const from = canonicalInstant(start, `${where}start`);
  // No declared end means the fact is a point in time. It is stored as an empty
  // interval rather than widened, so `endExclusive - start` is honestly zero.
  const to =
    end === undefined || end === null
      ? { iso: from.iso, ms: from.ms }
      : canonicalInstant(end, `${where}end`);
  if (to.ms < from.ms) throw new Error(`${where}temporal end must not precede start`);
  return {
    startMs: from.ms,
    endExclusiveMs: to.ms,
    startCanonical: from.iso,
    endCanonical: to.iso,
    precision: "instant",
    allDay: false,
  };
}

/**
 * Half-open overlap between a stored interval and a query window.
 *
 * An empty interval is a point: it overlaps when the point itself falls inside
 * the window. Without this branch every zero-duration fact would be invisible,
 * since `endExclusive > fromMs` is false for an empty interval at the window's
 * own start. Only an instant-precision fact is ever empty — `canonicalizeInterval`
 * gives a day-precision fact its full 24 hours — so reading empty as a point
 * never collapses a calendar day to its opening midnight.
 */
export function intervalOverlapsWindow(
  interval: { startMs: number; endExclusiveMs: number },
  window: { fromMs: number; toExclusiveMs: number },
): boolean {
  if (interval.endExclusiveMs <= interval.startMs) {
    return interval.startMs >= window.fromMs && interval.startMs < window.toExclusiveMs;
  }
  return interval.startMs < window.toExclusiveMs && interval.endExclusiveMs > window.fromMs;
}
