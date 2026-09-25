// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/** DuckDB table for Google Calendar events. Per-source (not shared
 * with Apple Calendar) so it stays source-encapsulated. */
export const GOOGLE_CALENDAR_EVENTS_TABLE = "google_calendar_events";

/**
 * Structured twin of the Google Calendar event document. The row's `id` is the
 * `calendarId:eventId` string that is also the document's `externalId`, so the
 * doc↔row `same-entity` edge is a clean 1:1 `boundDocument`. Derived
 * analytical columns the document body can't aggregate — `duration_minutes`,
 * `attendee_count`, `response_status` — are what make this dual-push worth it
 * ("meeting hours per week", "accept rate", "busiest day").
 */
export const googleCalendarEventsSchema: AnalyticsTableSchema = {
  tableName: GOOGLE_CALENDAR_EVENTS_TABLE,
  displayName: "Google Calendar Events",
  description: "Events across your Google calendars — durations, attendees, and RSVP status.",
  columns: [
    {
      name: "id",
      type: "VARCHAR",
      description: "calendarId:eventId — equals the event document's externalId",
    },
    {
      name: "source_account",
      type: "VARCHAR",
      description: "Account id of the Google Calendar source instance that emitted this row",
    },
    { name: "calendar_id", type: "VARCHAR", description: "Owning calendar id" },
    {
      name: "calendar_name",
      type: "VARCHAR",
      description: "Owning calendar display name",
      nullable: true,
    },
    { name: "event_id", type: "VARCHAR", description: "Google event id" },
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
    { name: "all_day", type: "BOOLEAN", description: "All-day (date-only) event" },
    {
      name: "recurring",
      type: "BOOLEAN",
      description: "Occurrence or exception belonging to a recurring series",
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
      description: "Your RSVP: accepted | tentative | declined | needsAction",
      nullable: true,
    },
    { name: "location", type: "VARCHAR", description: "Location text", nullable: true },
    {
      name: "status",
      type: "VARCHAR",
      description: "confirmed | tentative | cancelled",
      nullable: true,
    },
  ],
  primaryKey: ["id"],
  // Several Google accounts write this one provider-owned table. Snapshot
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
        tentative: "active",
        cancelled: "cancelled",
      },
      default: "active",
    },
    allDay: "all_day",
    eligibility: "temporal_projection_eligible",
    correlationKeys: ["ical_uid"],
  },
  exampleQueries: [
    "SELECT date_trunc('week', start_time) AS week, ROUND(SUM(duration_minutes) / 60, 1) AS meeting_hours FROM google_calendar_events WHERE all_day = false AND status != 'cancelled' AND response_status IN ('accepted', 'needsAction') GROUP BY week ORDER BY week DESC",
    "SELECT dayname(start_time) AS day, COUNT(*) AS events, ROUND(SUM(duration_minutes) / 60, 1) AS hours FROM google_calendar_events WHERE all_day = false GROUP BY day ORDER BY hours DESC",
    "SELECT response_status, COUNT(*) AS n FROM google_calendar_events WHERE response_status IS NOT NULL GROUP BY response_status ORDER BY n DESC",
  ],
};
