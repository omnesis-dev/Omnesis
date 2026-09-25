// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The caller's IANA time zone — the one piece of context that cannot be
 * derived server-side.
 *
 * The gateway and the person talking to it are not necessarily in the same
 * place: the gateway sits on a machine at home while its owner opens the app
 * from another continent. Anything the gateway renders as a wall-clock time
 * ("your film is at 19:40") is only correct in the zone of whoever is reading
 * it, so clients send theirs and the gateway speaks in it. Falling back to the
 * host's zone silently answers in the wrong one — the same hour, a different
 * meaning.
 */

/**
 * Longest identifier accepted. The longest name in the zone database is
 * 32 characters (`America/Argentina/ComodRivadavia`); the bound exists so a
 * hostile client cannot push an unbounded string into `Intl`. Exported so the
 * HTTP boundary can reject an oversized value at its schema without repeating
 * the number.
 */
export const MAX_TIME_ZONE_LENGTH = 64;

/**
 * Validate a named IANA time-zone identifier, returning it when the runtime
 * can resolve it and `undefined` otherwise.
 *
 * There is no list to check against — the zone database ships with the runtime
 * and changes with it — so the check is to ask `Intl` to build a formatter and
 * see whether it throws. A rejected value is not an error: the caller falls
 * back to the gateway's own zone.
 *
 * Two properties make the result safe to render into a model prompt. `Intl`
 * accepts only names already in the database, and the value returned is its
 * *resolved* identifier rather than the string passed in — so the output is
 * drawn from a fixed vocabulary of `[-/A-Za-z_]` and digits, and no caller
 * text (markup, newlines, instructions) can survive the round trip. Resolution
 * also canonicalizes link spellings, so `Asia/Calcutta` comes back as the name
 * the database prefers.
 *
 * Bare UTC offsets (`+05:30`, `-08:00`) are rejected even though `Intl`
 * accepts them: an offset is not a zone. It carries no daylight-saving rules,
 * so a client sending one would drift by an hour at the next transition —
 * exactly the failure this module exists to prevent. Fixed-offset *names*
 * (`Etc/GMT+5`, `UTC`) are database entries and pass.
 */
export function normalizeTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TIME_ZONE_LENGTH) return undefined;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  // `Intl` resolves an offset form to itself, so a leading sign is the tell.
  return /^[+-]/.test(resolved) ? undefined : resolved;
}

/**
 * The zone of the host this process runs on. The fallback for every path with
 * no caller zone — a background job, a client that sends none — and itself
 * falling back to UTC on the unusual host whose runtime resolves none.
 */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The zone's offset from UTC at a given instant, as `+01:00` / `-07:00` /
 * `+00:00`. Rendered alongside the zone name so a model reading the prompt can
 * convert the UTC instants that tools return without having to know the zone
 * database or which side of a daylight-saving boundary the date falls on —
 * exactly the step that turns 18:40Z into the wrong local hour when it is
 * skipped.
 *
 * Reading the offset at an instant rather than treating it as a property of
 * the zone is what makes it correct year-round: the same zone is +01:00 in
 * August and +00:00 in February.
 */
export function utcOffsetLabel(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(instant);
  const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
  // `longOffset` yields "GMT+01:00". Some ICU builds shorten a zero offset to
  // a bare "GMT", which would leave nothing after the prefix is stripped.
  const offset = name.replace(/^GMT/, "");
  return offset.length > 0 ? offset : "+00:00";
}
