// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Wall-clock annotations for the instants a tool hands the model.
 *
 * Tool output carries machine timestamps — `2026-10-18T17:28:00Z`, or an
 * instant with whatever offset the source stored it in — and the user reads
 * clock times in their own zone. Asking the model to do that conversion is
 * unreliable: it sometimes repeats the UTC hour as if it were local. So the
 * model-facing text names the local time next to each instant,
 * `2026-10-18T17:28:00Z (18:28 Sun 18 Oct, Europe/London)`, and the model
 * reads it instead of deriving it.
 *
 * Only an instant is annotated: a date and a time with a `Z` or `±HH:MM`
 * offset. A date alone is a day, not a moment, and a time without an offset
 * names no moment at all. An instant embedded in a URL, a path or a longer
 * identifier token is part of that token and stays untouched, and an instant
 * that already carries an annotation is not annotated again.
 *
 * The annotation exists only in what the model reads. Strings the model sends
 * back as tool arguments are stripped of it before a tool runs (see
 * `AgentSession`), so a quote, a SQL literal or a saved note copied from
 * annotated output reaches the tool exactly as the source stored it.
 */

const INSTANT =
  /(?<![\w\-/:.=?&#%+])\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:Z|[+-](?:0\d|1[0-4]):?\d{2})(?![\w/:+-])/gu;

/** The annotation this module writes, recognised when it directly follows an instant. */
const ANNOTATION =
  /(?<=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?(?:Z|[+-](?:0\d|1[0-4]):?\d{2})) \(\d{2}:\d{2} [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2,3}, [A-Za-z0-9_+\-/]+\)/gu;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** `18:28 Sun 18 Oct, Europe/London` for one instant in one zone. */
function localTimeLabel(instant: Date, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) parts[part.type] = part.value;
  return `${parts.hour}:${parts.minute} ${parts.weekday} ${parts.day} ${parts.month}, ${timeZone}`;
}

/** Whether the text before `offset` is a URL token the instant belongs to. */
function insideUrl(text: string, offset: number): boolean {
  const tokenStart = Math.max(
    text.lastIndexOf(" ", offset - 1),
    text.lastIndexOf("\n", offset - 1),
    text.lastIndexOf("\t", offset - 1),
  );
  const token = text.slice(tokenStart + 1, offset);
  return token.includes("://") || /^\(?<?www\./iu.test(token);
}

/**
 * `Date` rolls an impossible day forward (`02-30` becomes 2 March), which
 * would annotate a time on a day the text never named.
 */
function calendarDateExists(match: string): boolean {
  const year = Number(match.slice(0, 4));
  const month = Number(match.slice(5, 7));
  const day = Number(match.slice(8, 10));
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * Append the wall-clock time in `timeZone` to every instant in `text`.
 * `timeZone` must already be a resolved IANA name (see `normalizeTimeZone`).
 */
export function annotateLocalTimes(text: string, timeZone: string): string {
  if (!text.includes("T")) return text;
  return text.replace(INSTANT, (match: string, offset: number) => {
    const end = offset + match.length;
    if (text.startsWith(" (", end)) {
      ANNOTATION.lastIndex = 0;
      // An annotation is at most ~55 characters: the label plus the longest
      // zone name in the database.
      const rest = text.slice(offset, end + 64);
      const already = ANNOTATION.exec(rest);
      if (already && already.index === match.length) return match;
    }
    if (insideUrl(text, offset)) return match;
    const instant = new Date(match.replace(",", "."));
    if (Number.isNaN(instant.getTime()) || !calendarDateExists(match)) return match;
    return `${match} (${localTimeLabel(instant, timeZone)})`;
  });
}

/**
 * An ISO date and time, with or without its offset: the run a cut must not
 * split. Its clock is matched loosely so that a run an earlier bound already
 * shortened (`2026-10-18T17:2`) still counts.
 */
const DATE_TIME_RUN = /\d{4}-\d{2}-\d{2}T[\d:.,]*(?:Z|[+-](?:0\d|1[0-4]):?\d{2})?/gu;

/** The longest such run: `2026-10-18T17:28:00.123456789+01:00`. */
const LONGEST_DATE_TIME_RUN = 35;

/**
 * Where to end a slice of `text` that starts at `start` and should end at
 * `end`, so that it does not cut an instant in two.
 *
 * A slice ending inside `2026-10-18T17:28:00Z` keeps `2026-10-18T17:28` and
 * drops the `Z`: what is left names a clock time in no zone, which the
 * annotator cannot place and a reader takes for local time. When `end` falls
 * inside such a run, the slice ends just before it instead, and the next slice
 * carries it whole. A run that begins at `start` is kept whole only if the
 * slice can hold it; otherwise `end` stands.
 */
export function instantSafeEnd(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) return end;
  const from = Math.max(start, end - LONGEST_DATE_TIME_RUN);
  const window = text.slice(from, end + LONGEST_DATE_TIME_RUN);
  for (const match of window.matchAll(DATE_TIME_RUN)) {
    const runStart = from + match.index;
    const runEnd = runStart + match[0].length;
    if (runStart < end && end < runEnd) return runStart > start ? runStart : end;
  }
  return end;
}

/** A date and time at the very end of a text, its offset not reached. */
const CUT_DATE_TIME_AT_END = /\d{4}-\d{2}-\d{2}T[\d:.,]*$/u;

/**
 * `text` without a date and time it ends on before reaching an offset: the
 * tail an upstream cut left of an instant (a fixed-width chunk ending in
 * `2026-10-18T17:28` whose `:00Z` went to the next chunk). Kept, it would name
 * a clock time in no zone.
 */
export function withoutCutInstantAtEnd(text: string): string {
  const cut = CUT_DATE_TIME_AT_END.exec(text);
  return cut ? text.slice(0, cut.index) : text;
}

/**
 * Remove the annotations {@link annotateLocalTimes} writes, restoring the text
 * as stored. Used where model-supplied text must match stored text verbatim,
 * such as a citation quote copied from an annotated tool result.
 */
export function stripLocalTimeAnnotations(text: string): string {
  return text.includes(" (") ? text.replace(ANNOTATION, "") : text;
}

/**
 * {@link stripLocalTimeAnnotations} over every string in a JSON-shaped value,
 * for tool arguments a model may have copied from annotated tool output.
 */
export function stripLocalTimeAnnotationsDeep(value: unknown): unknown {
  if (typeof value === "string") return stripLocalTimeAnnotations(value);
  if (Array.isArray(value)) return value.map(stripLocalTimeAnnotationsDeep);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, stripLocalTimeAnnotationsDeep(entry)]),
    );
  }
  return value;
}
