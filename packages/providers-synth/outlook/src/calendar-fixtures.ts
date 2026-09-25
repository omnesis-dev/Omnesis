// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Synthetic backend for the Outlook calendar source.
 *
 * Mirrors the OneDrive twin: rather than re-implement calendar sync (which would
 * let fixture semantics drift from production), the synth provider feeds canned
 * Microsoft-Graph `event` pages into the REAL `OutlookCalendarSource` via an
 * injected `CalendarGraphClientLike`. The real source still enumerates
 * `/me/calendars`, walks each one's `calendarView/delta`, normalizes
 * `event`→`DocumentInput` (plus the
 * `outlook_calendar_events` analytics row), tombstones `@removed`/cancelled
 * events, and re-bootstraps on a 410 — so the synth path exercises the
 * production delta machine, normalizer, keying, and cursor recovery unchanged.
 * Only the network is replaced.
 *
 * The fixtures are an array of events loaded from the active universe
 * (`sources/outlook-calendar/events.json`). All ids, titles, locations, and
 * bodies are invented; attendee/organizer refs resolve through the cast so the
 * people graph wires events to the same personas the email/chat fixtures use.
 * An entry's optional `calendar` names which of the account's calendars holds
 * it, so a universe can put the account on more than one.
 *
 * Four env switches let an E2E drive the mutation + recovery paths against a
 * single running gateway, changing the synthetic calendar between sync ticks
 * (mirroring the OneDrive twin):
 *
 * - `OMNESIS_OUTLOOK_CALENDAR_SYNTH_UPDATE=<externalId>` — that event's
 *   subject, body, location and time are edited and `lastModifiedDateTime`
 *   bumped, so the next tick re-emits it with new content under the same id.
 * - `OMNESIS_OUTLOOK_CALENDAR_SYNTH_CANCEL=<externalId>` — that event comes
 *   back with `isCancelled`, the shape Outlook uses when an organizer cancels
 *   a meeting rather than deleting it.
 * - `OMNESIS_OUTLOOK_CALENDAR_SYNTH_REMOVE=<externalId>` — that event is gone
 *   from the calendar and the next tick carries its `@removed` tombstone.
 * - `OMNESIS_OUTLOOK_CALENDAR_SYNTH_EXPIRE_DELTA=1` — the next deltaLink fetch
 *   throws a 410 `DeltaExpiredError`, forcing the re-bootstrap.
 *
 * The switches are level-triggered, not edge-triggered: while a variable is
 * set, every incremental tick re-reports its mutation, where real Graph delta
 * reports a change once. A caller that wants "mutate, then assert the next tick
 * is quiet" must clear the variable between the two ticks. In exchange, a later
 * phase can hold an earlier phase's mutation in force simply by leaving its
 * variable set, which is what keeps a multi-phase E2E from drifting.
 */

import {
  resolvePerson,
  loadActiveUniverse,
  loadSourceFixtureJson,
} from "@omnesis/providers-synth-common";
import { DeltaExpiredError } from "@omnesis/provider-outlook";
import type {
  CalendarDeltaResponse,
  CalendarGraphClientLike,
  GraphEvent,
} from "@omnesis/provider-outlook";

/** One synthetic calendar event as authored in the universe fixture. */
export interface CalendarEventEntry {
  externalId: string;
  /** RFC 5545 UID — the cross-source identity an email-attached invite shares. */
  iCalUId: string;
  subject: string;
  body: string;
  location: string;
  /** ISO 8601 UTC instant. */
  startTime: string;
  endTime: string;
  /** Cast person ref organizing the event. */
  organizer: string;
  /** Cast person refs invited to the event. */
  attendees: string[];
  createdAt: string;
  updatedAt: string;
  categories?: string[];
  /**
   * Which of the account's calendars holds this event, by display name.
   * Absent means the default calendar. Event ids are unique within a calendar
   * and not across them, so this is also what lets a universe author the same
   * id on two calendars.
   */
  calendar?: string;
  /**
   * Turns the entry into a recurring series: a master plus this many weekly
   * occurrences. The occurrences are served the way Graph serves them — sparse,
   * carrying only an id, a time range and their `seriesMasterId` — so the real
   * source has to fill them in from the master or produce empty documents.
   */
  weeklyOccurrences?: number;
}

let cached: CalendarEventEntry[] | null = null;

export function loadCalendarEvents(): CalendarEventEntry[] {
  if (cached) return cached;
  cached = loadSourceFixtureJson<CalendarEventEntry[]>(
    loadActiveUniverse(),
    "outlook-calendar",
    "events.json",
  );
  return cached;
}

/** Reset the per-process fixture cache (test-only). */
export function resetCalendarFixtureCache(): void {
  cached = null;
}

/** Resolve a cast person ref to a Graph `{ name, address }` actor, or null. */
function castActor(ref: string): { name: string; address: string } | null {
  const person = resolvePerson(ref);
  const email = person.emails[0];
  return email ? { name: person.name, address: email } : null;
}

/** Build a Graph `event` from a fixture entry (all single-instance). */
function toGraphEvent(e: CalendarEventEntry): GraphEvent {
  const organizer = castActor(e.organizer);
  const attendees: NonNullable<GraphEvent["attendees"]> = [];
  for (const ref of e.attendees) {
    const actor = castActor(ref);
    if (actor) {
      attendees.push({
        type: "required",
        emailAddress: { name: actor.name, address: actor.address },
      });
    }
  }
  return {
    id: e.externalId,
    iCalUId: e.iCalUId,
    subject: e.subject,
    body: { contentType: "text", content: e.body },
    bodyPreview: e.body.slice(0, 255),
    start: { dateTime: e.startTime, timeZone: "UTC" },
    end: { dateTime: e.endTime, timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    showAs: "busy",
    type: "singleInstance",
    location: { displayName: e.location },
    attendees,
    organizer: organizer
      ? { emailAddress: { name: organizer.name, address: organizer.address } }
      : undefined,
    categories: e.categories ?? [],
    webLink: `https://outlook.office.com/calendar/0/view/event?itemid=${e.externalId}`,
    createdDateTime: e.createdAt,
    lastModifiedDateTime: e.updatedAt,
  };
}

/** One week, in milliseconds — the step between generated occurrences. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Expand a recurring fixture entry into the shapes Graph really sends: a fully
 * populated `seriesMaster`, then N occurrences carrying almost nothing.
 */
function toSeries(e: CalendarEventEntry): GraphEvent[] {
  const master: GraphEvent = {
    ...toGraphEvent(e),
    type: "seriesMaster",
    recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] } },
  };
  const events: GraphEvent[] = [master];
  const startMs = Date.parse(e.startTime);
  const endMs = Date.parse(e.endTime);
  for (let i = 0; i < (e.weeklyOccurrences ?? 0); i++) {
    events.push({
      id: `${e.externalId}-occ-${i + 1}`,
      type: "occurrence",
      seriesMasterId: e.externalId,
      start: { dateTime: new Date(startMs + (i + 1) * WEEK_MS).toISOString(), timeZone: "UTC" },
      end: { dateTime: new Date(endMs + (i + 1) * WEEK_MS).toISOString(), timeZone: "UTC" },
      isAllDay: false,
    });
  }
  return events;
}

/** Marker the synth delta-link carries so the fake recognizes an incremental tick. */
const DELTA_TOKEN = "synth-outlook-calendar-delta";

/** The display name of the calendar an entry with no `calendar` lives on. */
const DEFAULT_CALENDAR_NAME = "Calendar";

/**
 * The calendar id the twin gives a calendar, derived from its name so a
 * fixture and an assertion can both name it without a lookup table.
 */
export function calendarIdFor(name: string = DEFAULT_CALENDAR_NAME): string {
  return `cal-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

/** The delta link for one calendar — it has to name which, to route the tick. */
function deltaLinkFor(calendarId: string): string {
  return `https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=${DELTA_TOKEN}&calendar=${calendarId}`;
}

/** The edit the UPDATE switch applies, so an E2E can assert on exact strings. */
export const CALENDAR_UPDATE_OVERRIDE = {
  subject: "Vendor evaluation sync — rescheduled",
  body: "Moved an hour later so the compliance numbers land first. Same agenda.",
  location: "Atlas room",
  startTime: "2025-09-03T18:00:00Z",
  endTime: "2025-09-03T19:00:00Z",
  updatedAt: "2025-09-02T16:30:00Z",
} as const;

/** Apply the UPDATE switch to the matching entry, leaving the rest untouched. */
function applyUpdate(entry: CalendarEventEntry): CalendarEventEntry {
  if (process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_UPDATE !== entry.externalId) return entry;
  return { ...entry, ...CALENDAR_UPDATE_OVERRIDE };
}

/** A Graph `@removed` tombstone — the shape a deleted event arrives as. */
function removedEvent(externalId: string): GraphEvent {
  return { id: externalId, "@removed": { reason: "deleted" } };
}

/**
 * A fixture-backed `CalendarGraphClientLike`. Serves one bootstrap page
 * enumerating every live event (then a deltaLink), and empty incremental ticks
 * thereafter — proving idempotency end-to-end, mirroring the synthetic OneDrive
 * graph. The synth graph ignores the requested `calendarView` window so the
 * fixtures' fixed dates never age out of a "now"-relative window over time.
 * The env switches above mutate what it serves between ticks.
 */
export function syntheticCalendarGraph(events: CalendarEventEntry[]): CalendarGraphClientLike {
  /**
   * The account's calendars, default first, then the rest in fixture order —
   * every distinct name any entry claims.
   */
  function calendars(): Array<{ id: string; name: string }> {
    const names = [DEFAULT_CALENDAR_NAME];
    for (const e of events) {
      const name = e.calendar ?? DEFAULT_CALENDAR_NAME;
      if (!names.includes(name)) names.push(name);
    }
    return names.map((name) => ({ id: calendarIdFor(name), name }));
  }

  /** The entries held by one calendar. */
  function onCalendar(calendarId: string): CalendarEventEntry[] {
    return events.filter((e) => calendarIdFor(e.calendar ?? DEFAULT_CALENDAR_NAME) === calendarId);
  }

  /**
   * Events still on the calendar — everything but the REMOVE target. When one
   * id carries both CANCEL and UPDATE, cancel wins: a cancelled event is
   * retracted, so there is nothing left for an edit to apply to.
   */
  function liveEvents(calendarId: string): GraphEvent[] {
    const removed = process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_REMOVE;
    const cancelled = process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_CANCEL;
    return onCalendar(calendarId)
      .filter((e) => e.externalId !== removed)
      .flatMap((e) => {
        if (e.weeklyOccurrences) {
          const series = toSeries(applyUpdate(e));
          // Cancelling a series cancels its occurrences, which is how Outlook
          // reports it: each instance comes back individually cancelled.
          return e.externalId === cancelled
            ? series.map((ev) => ({ ...ev, isCancelled: true }))
            : series;
        }
        const event = toGraphEvent(applyUpdate(e));
        return [e.externalId === cancelled ? { ...event, isCancelled: true } : event];
      });
  }

  /** Only what changed since the last delta — the shape an incremental tick has. */
  function changedEvents(calendarId: string): GraphEvent[] {
    const removed = process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_REMOVE;
    const cancelled = process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_CANCEL;
    const updated = process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_UPDATE;
    const held = onCalendar(calendarId);
    const changed: GraphEvent[] = [];
    // Exactly one tombstone, for the entry itself. Observed against live Graph:
    // deleting a series announces the MASTER as removed and says nothing about
    // its occurrences, so the source has to reconcile them away rather than
    // being told. A twin that tombstoned each occurrence would describe an API
    // that does not exist, and would hide that gap.
    if (removed && held.some((e) => e.externalId === removed)) {
      changed.push(removedEvent(removed));
    }
    for (const entry of held) {
      if (entry.externalId === removed) continue;
      if (entry.externalId === cancelled) {
        changed.push({ ...toGraphEvent(entry), isCancelled: true });
      } else if (entry.externalId === updated) {
        changed.push(toGraphEvent(applyUpdate(entry)));
      }
    }
    return changed;
  }

  /**
   * The series masters one calendar holds, by event id. Scoped per calendar
   * because Graph event ids are unique within a calendar and not across them:
   * a global map would answer a lookup on one calendar with another calendar's
   * master, which is exactly the collision the real ids permit.
   */
  function mastersOn(calendarId: string): Map<string, GraphEvent> {
    const map = new Map<string, GraphEvent>();
    for (const e of onCalendar(calendarId)) {
      if (e.weeklyOccurrences) map.set(e.externalId, toSeries(applyUpdate(e))[0]!);
    }
    return map;
  }

  return {
    async get<T>(path: string): Promise<T> {
      if (
        path.startsWith("/me/calendars") &&
        !path.includes("/calendarView") &&
        !/\/events\//.test(path)
      ) {
        return { value: calendars() } as T;
      }
      // The source reads a master directly when the enumeration did not carry
      // one. This must answer with an event and not a delta page: a page has no
      // id and no subject, merges to nothing, and would let an
      // empty-document regression pass as success.
      //
      // `/me/events/{id}` addresses the account's own mailbox, so it finds a
      // master only on a calendar the account owns; the calendar-scoped route
      // is what reaches one on a calendar shared in from elsewhere. Modelling
      // both is what keeps the source's fallback honest.
      const scoped = path.match(/^\/me\/calendars\/([^/]+)\/events\/([^/?]+)/);
      if (scoped) {
        const master = mastersOn(decodeURIComponent(scoped[1]!)).get(
          decodeURIComponent(scoped[2]!),
        );
        if (!master) throw new Error(`Graph API error 404: no event ${scoped[2]}`);
        return master as T;
      }
      const byId = path.match(/^\/me\/events\/([^/?]+)/);
      if (byId) {
        const master = mastersOn(calendarIdFor()).get(decodeURIComponent(byId[1]!));
        if (!master) throw new Error(`Graph API error 404: no event ${byId[1]}`);
        return master as T;
      }
      if (path.includes(DELTA_TOKEN)) {
        // The persisted deltaLink — an incremental tick, or a forced 410. The
        // link names its calendar, which is what routes the tick back to it.
        if (process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_EXPIRE_DELTA === "1") {
          throw new DeltaExpiredError();
        }
        const calendarId = path.match(/[?&]calendar=([^&]+)/)?.[1] ?? calendarIdFor();
        return {
          value: changedEvents(calendarId),
          "@odata.deltaLink": deltaLinkFor(calendarId),
        } as CalendarDeltaResponse as T;
      }
      // A calendar's own `calendarView/delta` — its full enumeration in one
      // page. The 410 re-walk lands here too, and wants the same live calendar.
      const viewed = path.match(/^\/me\/calendars\/([^/]+)\/calendarView/);
      const calendarId = viewed ? decodeURIComponent(viewed[1]!) : calendarIdFor();
      return {
        value: liveEvents(calendarId),
        "@odata.deltaLink": deltaLinkFor(calendarId),
      } as CalendarDeltaResponse as T;
    },
  };
}
