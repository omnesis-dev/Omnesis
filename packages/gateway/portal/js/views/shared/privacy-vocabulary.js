// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The vocabulary every surface of the privacy boundary speaks: error phrasing,
 * the wire-collection normalizer, the date formatters, and the lifecycle status
 * chip. Privacy and Watches are separate features that describe the same
 * boundary, so this sits beside both rather than inside either.
 */

import { html } from "htm/preact";

export function errorMessage(error, { includeRequestId = false } = {}) {
  const suffix = includeRequestId && error?.requestId
    ? ` [id=${String(error.requestId).slice(0, 8)}]`
    : "";
  return `${error?.message ?? String(error)}${suffix}`;
}

export function privacyCollection(payload, key) {
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload?.[key]) ? payload[key] : null;
}

export function formatPrivacyDate(value) {
  if (!Number.isFinite(value)) return "Unknown";
  return new Date(value).toLocaleString();
}

export function formatPrivacyRelativeDate(value, now = Date.now()) {
  if (!Number.isFinite(value)) return "Unknown";
  const seconds = Math.round((value - now) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  if (absolute < 604_800) return formatter.format(Math.round(seconds / 86_400), "day");
  if (absolute < 2_592_000) return formatter.format(Math.round(seconds / 604_800), "week");
  if (absolute < 31_536_000) return formatter.format(Math.round(seconds / 2_592_000), "month");
  return formatter.format(Math.round(seconds / 31_536_000), "year");
}

/**
 * Whether a value names a moment at all.
 *
 * Zero is how a record says it has no instant rather than a moment in 1970, and
 * every surface that prints one has to agree about that or the same record
 * reads differently on each.
 */
export function privacyInstant(value) {
  return Number.isFinite(value) && value > 0;
}

/**
 * The two halves of an instant, for a column of them down the side of a story.
 *
 * A ledger read top to bottom wants the time of day on every line and the date
 * only where it changes: repeating the same date beside twelve steps that all
 * happened inside one minute buries the one number that is actually moving.
 * The day is returned separately so the caller can decide when to print it.
 */
export function formatPrivacyClock(value) {
  if (!privacyInstant(value)) return "—";
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatPrivacyDay(value) {
  if (!privacyInstant(value)) return null;
  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The time of day a feed row shows, under a heading that already carries the
 * date. Minutes, not seconds: a ledger of exchanges minutes or hours apart is
 * read for its order, and a third number on every line only slows that down.
 */
export function formatPrivacyTimeOfDay(value) {
  if (!privacyInstant(value)) return "Unknown";
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Which local day an instant falls on, as a key rows can be grouped by.
 *
 * Local rather than UTC, because the operator reads the feed in their own day:
 * an exchange at 23:40 belongs to the evening they remember, not to the next
 * date. Instants a record never carried group together under their own key so
 * they stay in the list instead of being dropped or dated by guess.
 */
export function privacyDayKey(value) {
  if (!privacyInstant(value)) return "unknown";
  const at = new Date(value);
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const day = `${at.getDate()}`.padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/**
 * The heading over one day's rows. The two days an operator thinks of by name
 * get their names; everything older gets its weekday and date, and the year
 * only once it is no longer the current one — a column of headings that all
 * repeat this year spends its width on the one field that never changes.
 */
export function formatPrivacyDayHeading(value, now = Date.now()) {
  if (!privacyInstant(value)) return "Date unknown";
  const key = privacyDayKey(value);
  if (key === privacyDayKey(now)) return "Today";
  if (key === privacyDayKey(now - 86_400_000)) return "Yesterday";
  const at = new Date(value);
  return at.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * The machine-readable half of a `<time>` element, or null when the record
 * carries no usable instant. `new Date(x).toISOString()` throws on anything
 * non-finite, and an exception raised while rendering one feed row unmounts the
 * whole portal — so a timestamp this weak drops the attribute (preact omits a
 * null one) and leaves the visible text to say "Unknown" on its own.
 */
export function privacyDateTimeAttribute(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

export function shortId(value) {
  if (!value) return "Unknown";
  return value.length > 18 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value;
}

/** Task/approval lifecycle states, used by the Watches surfaces. */
const STATUS_LABELS = {
  pending: "Needs your review",
  approved: "Approved",
  expired: "Not shared",
  released: "Approved for release",
  released_with_reductions: "Approved with details removed",
  approval_required: "Needs your review",
  denied: "Not shared",
  running: "Checking",
  failed: "Nothing shared; check failed",
  canceled: "Canceled",
  pending_approval: "Needs review",
  active: "Active",
  paused: "Paused",
  revoked: "Revoked",
  delivered: "Delivered",
  blocked: "Blocked",
};

/**
 * Lifecycle statuses borrow the outcome tones but answer a narrower question:
 * did the thing this status describes happen? Green where it did — a watch is
 * running, an approval was granted, a wake was delivered — amber where it will
 * not, and grey while it is still in the air.
 *
 * Approval and delivery are separate facts, so `released` and
 * `released_with_reductions` are grey rather than green: the privacy check
 * cleared the answer, but this status cannot know whether the caller collected
 * it, and green here would assert a delivery that may never happen. `delivered`
 * is the one that knows.
 *
 * An unmapped status takes the neutral tone rather than a verdict, so a status
 * a newer gateway invents is never coloured as refused.
 */
const STATUS_TONE = {
  approved: "released",
  active: "released",
  delivered: "released",
  released: "waiting",
  released_with_reductions: "waiting",
  running: "waiting",
  paused: "waiting",
  pending: "review",
  pending_approval: "review",
  approval_required: "review",
  denied: "kept",
  expired: "kept",
  canceled: "kept",
  revoked: "kept",
  blocked: "kept",
  failed: "failed",
};

/** Every lifecycle status this build can put on screen. */
export const PRIVACY_STATUS_CODES = Object.keys(STATUS_LABELS);

/**
 * How one lifecycle status presents, or null for a status this build does not
 * recognise — which renders nothing rather than a chip that guesses.
 */
export function privacyStatusDisplay(status) {
  const label = STATUS_LABELS[status];
  if (!label) return null;
  return { label, tone: STATUS_TONE[status] ?? "waiting" };
}

export function PrivacyStatus({ status }) {
  const display = privacyStatusDisplay(status);
  if (!display) return null;
  return html`<span class=${`privacy-chip privacy-chip--${display.tone}`}>${display.label}</span>`;
}
