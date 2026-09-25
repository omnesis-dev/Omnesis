// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/** DuckDB table for Apple Calendar events (#450 / #5). Per-source (not shared
 * with Google Calendar) so it stays source-encapsulated. */
export const APPLE_CALENDAR_EVENTS_TABLE = "apple_calendar_events";

/**
 * Structured twin of the Apple Calendar event document. The row's `id` is the
 * event UUID that is also the document's `externalId`, so the doc↔row
 * `same-entity` edge (#450) is a clean 1:1 `boundDocument`. Subscribed feeds
 * (holiday / birthday calendars) are excluded from the table so they don't
 * pollute meeting-time analytics. `response_status` stays null: Apple's local
 * store doesn't surface the viewer's RSVP in the columns we read.
 */
export const appleCalendarEventsSchema: AnalyticsTableSchema = {
  tableName: APPLE_CALENDAR_EVENTS_TABLE,
  displayName: "Apple Calendar Events",
  description: "Events from your Apple (iCloud/local) calendars — durations and attendees.",
  columns: [
    {
      name: "id",
      type: "VARCHAR",
      description: "Event UUID — equals the event document's externalId",
    },
    { name: "calendar_id", type: "VARCHAR", description: "Owning calendar UUID", nullable: true },
    {
      name: "calendar_name",
      type: "VARCHAR",
      description: "Owning calendar title",
      nullable: true,
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
    { name: "recurring", type: "BOOLEAN", description: "Part of a recurring series" },
    {
      name: "temporal_projection_eligible",
      type: "BOOLEAN",
      description:
        "True for concrete events and detached occurrences; false for unexpanded recurring masters",
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
      description: "Your RSVP (null — not surfaced by the local Apple store)",
      nullable: true,
    },
    { name: "location", type: "VARCHAR", description: "Location text", nullable: true },
    {
      name: "status",
      type: "VARCHAR",
      description: "confirmed | tentative | cancelled (from EKEventStatus)",
      nullable: true,
    },
  ],
  primaryKey: ["id"],
  // An event is placed at its start instant.
  semanticTimeColumn: "start_time",
  record: {
    titleColumns: ["title"],
    keyColumns: ["title", "start_time", "end_time", "location"],
  },
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
    "SELECT date_trunc('week', start_time) AS week, ROUND(SUM(duration_minutes) / 60, 1) AS meeting_hours FROM apple_calendar_events WHERE all_day = false AND status != 'cancelled' GROUP BY week ORDER BY week DESC",
    "SELECT dayname(start_time) AS day, COUNT(*) AS events FROM apple_calendar_events WHERE all_day = false GROUP BY day ORDER BY events DESC",
  ],
};
