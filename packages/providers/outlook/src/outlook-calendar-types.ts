// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { isSnapshotLedger, makeCursorValidator } from "@omnesis/source-sdk";
import type { SnapshotLedger, SyncCursor } from "@omnesis/source-sdk";

/** Microsoft Graph `dateTimeTimeZone` (start/end of an event). */
export interface GraphDateTimeTimeZone {
  /** Local wall-clock time, e.g. `"2024-01-15T10:00:00.0000000"` (no offset). */
  dateTime?: string;
  /** IANA / Windows zone the `dateTime` is expressed in. Graph defaults to UTC. */
  timeZone?: string;
}

/** Microsoft Graph `emailAddress` (the actor on an organizer/attendee field). */
export interface GraphEmailAddressField {
  name?: string;
  address?: string;
}

/** Microsoft Graph attendee — a recipient plus their RSVP. */
export interface GraphAttendee {
  type?: "required" | "optional" | "resource";
  status?: { response?: string; time?: string };
  emailAddress?: GraphEmailAddressField;
}

/** Microsoft Graph recipient wrapper (organizer). */
export interface GraphRecipientField {
  emailAddress?: GraphEmailAddressField;
}

/** Microsoft Graph `recurrencePattern` — the shape of a recurring series. */
export interface GraphRecurrencePattern {
  type?: string;
  interval?: number;
  daysOfWeek?: string[];
  dayOfMonth?: number;
  month?: number;
  firstDayOfWeek?: string;
  index?: string;
}

/** Microsoft Graph `recurrenceRange`. */
export interface GraphRecurrenceRange {
  type?: string;
  startDate?: string;
  endDate?: string;
  numberOfOccurrences?: number;
}

/** Microsoft Graph `patternedRecurrence` (present on a series master only). */
export interface GraphPatternedRecurrence {
  pattern?: GraphRecurrencePattern;
  range?: GraphRecurrenceRange;
}

/**
 * Microsoft Graph `event` (the subset calendar normalization reads).
 *
 * `/me/calendarView/delta` expands recurring series into individual instances:
 * each `occurrence` / `exception` arrives as its own event with a distinct `id`
 * and a shared `seriesMasterId`. The `recurrence` object is populated only on a
 * `seriesMaster`. Delta pages additionally carry `@removed` tombstones.
 *
 * See https://learn.microsoft.com/graph/api/resources/event.
 */
export interface GraphEvent {
  id: string;
  /** RFC 5545 UID. Shared by every system that exposes this event. */
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { contentType?: "text" | "html"; content?: string };
  start?: GraphDateTimeTimeZone;
  end?: GraphDateTimeTimeZone;
  isAllDay?: boolean;
  isCancelled?: boolean;
  /** free | tentative | busy | oof | workingElsewhere | unknown */
  showAs?: string;
  type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  seriesMasterId?: string;
  location?: { displayName?: string };
  attendees?: GraphAttendee[];
  organizer?: GraphRecipientField;
  /** The viewer's own RSVP to this event. */
  responseStatus?: { response?: string; time?: string };
  /**
   * Whether the signed-in account organised this event.
   *
   * Load-bearing for identity. Outlook reports the organizer of the account's
   * own events as an opaque `outlook_…@outlook.com` alias rather than the
   * address the person actually uses, so the mention on its own resolves to
   * somebody who is not the user. This flag is what says otherwise.
   *
   * Graph defines it against the *calendar's owner*, so it means the account
   * holder — including when a delegate arranged the meeting on their behalf —
   * only on a calendar the account owns. On one shared in from another mailbox
   * the same flag names that person, so the source honours it only for its own
   * calendars.
   */
  isOrganizer?: boolean;
  recurrence?: GraphPatternedRecurrence | null;
  onlineMeeting?: { joinUrl?: string } | null;
  webLink?: string;
  categories?: string[];
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  /** Present (with otherwise sparse fields) when the event was removed. */
  "@removed"?: { reason?: string };
}

/** A page of one calendar's `calendarView/delta`. */
export interface CalendarDeltaResponse {
  value: GraphEvent[];
  /** More pages of this calendar's delta to read before it is drained. */
  "@odata.nextLink"?: string;
  /** This calendar is drained — re-issue this link to read its next changes. */
  "@odata.deltaLink"?: string;
}

/**
 * Outlook Calendar sync cursor.
 *
 * An account holds several calendars and each has its own delta stream over a
 * bounded date window, so the cursor tracks a queue of calendars to visit and
 * one follow-up link per calendar — closer to the per-folder
 * `OutlookEmailCursor` than to `OneDriveCursor`'s single stream. A calendar
 * with no link yet gets a fresh bounded `calendarView`; Graph hands back an
 * `@odata.deltaLink` once that enumeration drains, which is persisted and
 * re-issued each tick. `@odata.nextLink` mid-enumeration is carried separately
 * as `resumeLink`, because it belongs to the calendar at the head of the queue
 * rather than to a finished stream.
 */
export interface OutlookCalendarCursor extends SyncCursor {
  /**
   * The `@odata.deltaLink` for each calendar that has finished enumerating,
   * keyed by calendar id. A calendar absent from this map has never drained,
   * so its next page is a fresh bounded `calendarView` rather than a delta.
   */
  calendarLinks?: Record<string, string>;
  /**
   * Calendars still to visit in this cycle, oldest first. `undefined` means no
   * cycle is in progress and the next call starts one.
   *
   * One calendar-page per `sync()` call rather than draining everything at
   * once: a transient Graph failure on a busy account then costs one page of
   * work instead of the whole cycle's progress.
   */
  pendingCalendars?: string[];
  /** The `@odata.nextLink` mid-way through the calendar at the head of the queue. */
  resumeLink?: string;
  /**
   * The past edge of the enumerated window, fixed at the first cycle.
   *
   * The future edge rolls forward so newly scheduled events come into view, but
   * the past edge must not: the source publishes each completed cycle as a
   * whole-source snapshot, and the gateway deletes whatever the snapshot omits.
   * A past edge that advanced would drop older events out of the enumeration
   * while their documents stayed indexed, turning each roll into a silent
   * retention policy. Anchoring it keeps the enumerated range a superset of the
   * indexed one, which is what makes the snapshot a reconciliation.
   */
  windowStart?: string;
  /** Roll the bounded calendarView window after this instant. */
  windowRefreshAfter?: string;
  /**
   * The calendars a full enumeration opened with, frozen when it began. This is
   * the definition of "everything" the ledger below is judged against; the
   * account's calendar list is re-read every call and a cycle must not be
   * judged against a list that changed under it.
   */
  snapshotCalendars?: string[];
  /**
   * The in-flight enumeration, one partition per calendar. Set only by a cycle
   * that reads every calendar in full — a cycle resuming from delta links
   * leaves it unset, because a change feed is not a snapshot.
   *
   * A calendar that reached its delta link is covered and becomes a claim; one
   * this account cannot read is a gap and is vouched for by nothing. The
   * account-wide form is published only when every calendar was covered.
   */
  snapshot?: SnapshotLedger;
  /**
   * Series whose masters this account owns, as `calendarId:masterId`.
   *
   * Graph announces a deleted series by tombstoning its master and nothing
   * else, and a master is not itself a document — so that tombstone removes
   * nothing while the series' occurrences stay indexed. Remembering which ids
   * are masters lets the source recognise such a tombstone and re-enumerate,
   * which is what produces the snapshot that clears them. One id per series
   * rather than per occurrence, and a completed cycle replaces the set.
   */
  knownMasters?: string[];
  /** Series ids accumulated while a cycle drains, the counterpart to `snapshot`. */
  enumeratedMasters?: string[];
}

/**
 * `calendarView/delta` page size (`$top`).
 *
 * Graph's server default is small enough that a year of a busy calendar takes
 * many round-trips, and each is a page the queue has to spend a `sync()` call
 * on. Matches the sibling Outlook sources rather than Google's calendar-only
 * 250: the ceiling here is a Graph one.
 */
export const CALENDAR_PAGE_SIZE = 100;

/** One calendar in `/me/calendars`. */
export interface GraphCalendar {
  id: string;
  name?: string;
  /**
   * The mailbox that owns the calendar, by primary SMTP address. Set when the
   * calendar was shared in from another mailbox; Graph may omit it for one that
   * lives in the account's own.
   */
  owner?: { name?: string; address?: string };
  /** True for the account's own primary calendar — its ownership is not in doubt. */
  isDefaultCalendar?: boolean;
}

/** A page of `/me/calendars`. */
export interface CalendarListResponse {
  value: GraphCalendar[];
  "@odata.nextLink"?: string;
}

/**
 * The Graph transport surface `OutlookCalendarSource` depends on — a structural
 * subset of `GraphClient`. Declared as an interface (not the concrete class) so
 * a test can inject a fixture-backed transport that drives the REAL delta walk /
 * 410 re-bootstrap / normalization without a live Graph.
 */
export interface CalendarGraphClientLike {
  get<T>(
    path: string,
    params?: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<T>;
}

export interface OutlookCalendarSourceOptions {
  /**
   * Inject a Graph transport in place of the default real `GraphClient`. Tests
   * pass a fixture-backed implementation so the production sync path runs
   * unchanged over canned delta pages.
   */
  graph?: CalendarGraphClientLike;
}

function isStringArray(v: unknown): boolean {
  return Array.isArray(v) && v.every((entry) => typeof entry === "string");
}

function isIsoInstant(v: unknown): boolean {
  return typeof v === "string" && Number.isFinite(Date.parse(v));
}

export function isOutlookCalendarCursor(v: unknown): v is OutlookCalendarCursor {
  if (!v || typeof v !== "object") return false;
  const c = v as Record<string, unknown>;
  // A cursor carrying `phase`/`link` is the single-calendar format: its events
  // are keyed on the bare Graph event id, which does not match what this source
  // emits, so resuming from one would leave those documents unreferenced and
  // unreconciled. Rejecting it starts a clean cycle, and the snapshot that
  // cycle publishes is what retires them.
  if ("phase" in c || "link" in c) return false;
  if (c.calendarLinks !== undefined) {
    const links = c.calendarLinks;
    if (typeof links !== "object" || links === null || Array.isArray(links)) return false;
    if (!Object.values(links).every((entry) => typeof entry === "string")) return false;
  }
  if (c.pendingCalendars !== undefined && !isStringArray(c.pendingCalendars)) return false;
  if (c.resumeLink !== undefined && typeof c.resumeLink !== "string") return false;
  if (c.windowStart !== undefined && !isIsoInstant(c.windowStart)) return false;
  if (c.windowRefreshAfter !== undefined && !isIsoInstant(c.windowRefreshAfter)) return false;
  if (c.snapshotCalendars !== undefined && !isStringArray(c.snapshotCalendars)) return false;
  if (c.snapshot !== undefined && !isSnapshotLedger(c.snapshot)) return false;
  // A cursor written before the per-calendar ledger carries `snapshotPresentIds`,
  // a flat account-wide list with no record of which calendar each id came from.
  // It is ACCEPTED and the field simply ignored: every return here rebuilds the
  // cursor rather than spreading it, so the stale key is gone after one page,
  // and the enumeration it belonged to is abandoned — the cycle finishes
  // incrementally and the next window roll starts a fresh one.
  //
  // Refusing it instead would re-bootstrap, and this source cannot afford that:
  // `windowStart` is the fixed past edge of the enumerated range, carried on
  // the cursor precisely because the enumeration doubles as a whole-account
  // snapshot. Discarding it recomputes the edge as "a year ago", and every
  // event between the original edge and the new one falls out of the range,
  // out of the snapshot, and is deleted.
  if (c.knownMasters !== undefined && !isStringArray(c.knownMasters)) return false;
  if (c.enumeratedMasters !== undefined && !isStringArray(c.enumeratedMasters)) return false;
  return true;
}

/**
 * Validate a persisted cursor, returning null when it is absent or malformed —
 * the caller then starts a fresh cycle (mirrors `validateOneDriveCursor`).
 */
export const validateOutlookCalendarCursor = makeCursorValidator(isOutlookCalendarCursor);
