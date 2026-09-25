// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/** DuckDB table for Outlook Calendar events. Per-source (not shared with
 * Google / Apple calendars) so it stays source-encapsulated. */
export const OUTLOOK_CALENDAR_EVENTS_TABLE = "outlook_calendar_events";

/**
 * Structured twin of the Outlook Calendar event document. The row's `id` is the
 * Graph event id that is also the document's `externalId`, so the doc↔row
 * `same-entity` edge is a clean 1:1 `boundDocument`. Derived analytical columns
 * the document body can't aggregate — `duration_minutes`, `attendee_count`,
 * `response_status` — are what make this dual-push worth it ("meeting hours per
 * week", "accept rate", "busiest day").
 */
export const outlookCalendarEventsSchema: AnalyticsTableSchema = {
  tableName: OUTLOOK_CALENDAR_EVENTS_TABLE,
  displayName: "Outlook Calendar Events",
  description: "Events from your Outlook calendar — durations, attendees, and RSVP status.",
  columns: [
    {
      name: "id",
      type: "VARCHAR",
      description:
        "`calendarId:eventId` — equals the event document's externalId. Graph event ids are unique within a calendar, not across them, so the calendar is part of the key",
    },
    {
      name: "source_account",
      type: "VARCHAR",
      description: "Account id of the Outlook Calendar source instance that emitted this row",
    },
    {
      name: "calendar_id",
      type: "VARCHAR",
      description: "The calendar this event belongs to — an account can have several",
    },
    {
      name: "calendar_name",
      type: "VARCHAR",
      description: "Display name of that calendar, e.g. 'Calendar', 'Birthdays', a shared one",
    },
    {
      name: "event_id",
      type: "VARCHAR",
      description: "The Graph event id on its own, without the calendar prefix",
    },
    {
      name: "ical_uid",
      type: "VARCHAR",
      description: "RFC 5545 UID — the same physical meeting across calendars",
      nullable: true,
    },
    { name: "title", type: "VARCHAR", description: "Event title", nullable: true },
    {
      name: "start_time",
      type: "TIMESTAMPTZ",
      description: "Start instant (UTC); for all-day events, midnight of the start date",
      nullable: true,
    },
    { name: "end_time", type: "TIMESTAMPTZ", description: "End instant (UTC)", nullable: true },
    {
      name: "duration_minutes",
      type: "DOUBLE",
      description: "end − start in minutes; null for all-day or open-ended events",
      nullable: true,
    },
    { name: "all_day", type: "BOOLEAN", description: "All-day event" },
    {
      name: "recurring",
      type: "BOOLEAN",
      description: "Part of a recurring series (occurrence, exception, or series master)",
    },
    {
      name: "temporal_projection_eligible",
      type: "BOOLEAN",
      description: "True for concrete occurrences; false for a defensive series-master response",
    },
    {
      name: "organizer_email",
      type: "VARCHAR",
      description: "Organizer email",
      references: "person",
      nullable: true,
    },
    {
      name: "attendee_count",
      type: "INTEGER",
      description: "Distinct attendees on the invite",
      nullable: true,
    },
    {
      name: "response_status",
      type: "VARCHAR",
      description:
        "Your RSVP: accepted | tentativelyAccepted | declined | notResponded | organizer | none. `none` is an event with no invitees — a solo appointment or a block you made for yourself. Null on a calendar shared in from another mailbox, where Graph reports its owner's RSVP rather than yours",
      nullable: true,
    },
    { name: "location", type: "VARCHAR", description: "Location text", nullable: true },
    {
      name: "status",
      type: "VARCHAR",
      description:
        "The event's lifecycle state: confirmed | cancelled. A cancelled event is retracted rather than kept, so a surviving row is confirmed",
      nullable: true,
    },
    {
      name: "show_as",
      type: "VARCHAR",
      description:
        "How the event marks your availability — free | tentative | busy | oof | workingElsewhere | unknown. Separate from `status`: a free placeholder and a booked meeting are both confirmed events, and only this tells them apart. Null when Outlook did not say",
      nullable: true,
    },
  ],
  primaryKey: ["id"],
  // Several Microsoft accounts write this one provider-owned table. Snapshot
  // reconciliation must scope deletions to the emitting account.
  sharedDiscriminatorColumn: "source_account",
  // An event is placed at its start instant.
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["title"],
    keyColumns: ["title", "start_time", "end_time", "location"],
  },
  // The event document's externalId is exactly this row's `id` — declare the
  // 1:1 doc↔row edge. Synthesized at walk time; no edge rows persisted.
  boundDocument: { externalIdColumns: ["id"] },
  temporalProjection: {
    slot: "calendar",
    start: "$semanticTime",
    end: "end_time",
    label: "title",
    // An all-day entry is an observance or a whole-day block; a timed entry is
    // a booking with a counterparty.
    kind: { from: "all_day", map: { true: "event" }, default: "appointment" },
    modality: "scheduled",
    status: {
      from: "status",
      map: {
        confirmed: "active",
        cancelled: "cancelled",
      },
      default: "active",
    },
    allDay: "all_day",
    eligibility: "temporal_projection_eligible",
    correlationKeys: ["ical_uid"],
  },
  exampleQueries: [
    // Hours the calendar actually claimed: timed events you did not decline,
    // minus the free blocks people use to hold time. Declining is the only
    // exclusion, so a solo appointment (`none`) still counts — it is time spent.
    // A cancelled event is retracted before a row exists, so there is nothing
    // to filter there.
    "SELECT date_trunc('week', start_time) AS week, ROUND(SUM(duration_minutes) / 60, 1) AS meeting_hours FROM outlook_calendar_events WHERE all_day = false AND (show_as IS NULL OR show_as != 'free') AND (response_status IS NULL OR response_status != 'declined') GROUP BY week ORDER BY week DESC",
    "SELECT dayname(start_time) AS day, COUNT(*) AS events, ROUND(SUM(duration_minutes) / 60, 1) AS hours FROM outlook_calendar_events WHERE all_day = false GROUP BY day ORDER BY hours DESC",
    "SELECT response_status, COUNT(*) AS n FROM outlook_calendar_events WHERE response_status IS NOT NULL GROUP BY response_status ORDER BY n DESC",
    "SELECT show_as, COUNT(*) AS n, ROUND(SUM(duration_minutes) / 60, 1) AS hours FROM outlook_calendar_events WHERE show_as IS NOT NULL GROUP BY show_as ORDER BY hours DESC",
  ],
};
