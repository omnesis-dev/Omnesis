// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { AnalyticsTableSchema } from "@omnesis/source-sdk";

/**
 * One row per Granola meeting note. The prose (summary + transcript) rides in
 * as a searchable document on the same hybrid sync; this table holds the
 * structured facets the agent can `run_sql` over — who, when, how long, how
 * many attendees.
 */
export const granolaMeetingsSchema: AnalyticsTableSchema = {
  tableName: "granola_meetings",
  displayName: "Granola Meetings",
  description: "Meeting notes captured by Granola — title, owner, attendees, duration, summary",
  columns: [
    { name: "id", type: "VARCHAR", description: "Granola note ID (not_…)" },
    { name: "title", type: "VARCHAR", description: "Meeting title", nullable: true },
    {
      name: "owner_name",
      type: "VARCHAR",
      description: "Display name of the note owner",
      nullable: true,
    },
    {
      name: "owner_email",
      type: "VARCHAR",
      description: "Email of the note owner",
      nullable: true,
      references: "person",
    },
    { name: "created_at", type: "TIMESTAMPTZ", description: "When the note was created (UTC)" },
    {
      name: "updated_at",
      type: "TIMESTAMPTZ",
      description: "When the note was last updated (UTC)",
    },
    {
      name: "started_at",
      type: "TIMESTAMPTZ",
      description: "Meeting start — calendar event start, else first transcript segment",
      nullable: true,
    },
    {
      name: "duration_seconds",
      type: "DOUBLE",
      description: "Meeting duration from transcript span (last end − first start)",
      nullable: true,
    },
    {
      name: "attendee_count",
      type: "INTEGER",
      description: "Number of attendees on the note",
    },
    {
      name: "attendees",
      type: "JSON",
      description: "Attendee list as [{name, email}]",
      nullable: true,
    },
    {
      name: "has_summary",
      type: "BOOLEAN",
      description: "Whether Granola produced an AI summary",
    },
    {
      name: "summary_text",
      type: "VARCHAR",
      description: "Plain-text AI summary",
      nullable: true,
    },
    {
      name: "transcript_segment_count",
      type: "INTEGER",
      description: "Number of transcript segments (0 if no transcript)",
      nullable: true,
    },
    {
      name: "calendar_event_title",
      type: "VARCHAR",
      description: "Linked calendar event title, if any",
      nullable: true,
    },
    {
      name: "folder_names",
      type: "JSON",
      description: "Names of folders the note belongs to",
      nullable: true,
    },
    {
      name: "web_url",
      type: "VARCHAR",
      description: "Direct link to the note in Granola",
      references: "url",
    },
    {
      name: "synced_at",
      type: "TIMESTAMPTZ",
      description: "When Omnesis last ingested this row",
      volatile: true,
    },
    {
      name: "source_account_id",
      type: "VARCHAR",
      nullable: true,
      sourceColumnId: "omnesis:source_account_id",
      description:
        "Which Omnesis account wrote this row — discriminates sibling connections sharing the table",
    },
  ],
  primaryKey: ["id"],
  // Several Granola accounts share this table, so a removal must delete only
  // the leaving account's rows. Not part of the primary key: widening a live
  // table's key is not something schema evolution can do.
  sharedDiscriminatorColumn: "source_account_id",
  // A meeting is placed at when it started (the real-world event time).
  // Nullable per row — a row whose started_at is null is not timeline-eligible.
  semanticTimeColumn: "started_at",
  record: {
    titleColumns: ["title"],
    keyColumns: ["title", "started_at", "duration_seconds", "attendee_count"],
  },
  // Each row co-describes the meeting-note document whose externalId is the
  // same note id (#450). 1:1; the same-entity edge is synthesized at walk time.
  boundDocument: { externalIdColumns: ["id"] },
  exampleQueries: [
    "SELECT date_trunc('month', started_at) AS month, COUNT(*) AS meetings, ROUND(SUM(duration_seconds)/3600, 1) AS hours FROM granola_meetings GROUP BY month ORDER BY month DESC",
    "SELECT title, started_at, ROUND(duration_seconds/60, 0) AS minutes, attendee_count FROM granola_meetings ORDER BY started_at DESC LIMIT 20",
    "SELECT owner_email, COUNT(*) AS n, ROUND(AVG(duration_seconds)/60, 0) AS avg_minutes FROM granola_meetings GROUP BY owner_email ORDER BY n DESC",
    "SELECT title, summary_text FROM granola_meetings WHERE has_summary ORDER BY started_at DESC LIMIT 10",
  ],
};

export const allSchemas = [granolaMeetingsSchema];
