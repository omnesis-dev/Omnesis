// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The calendar events a recording overlaps, for its suggestions: timed
 * entries the owner's calendars schedule (Google, Outlook and Apple project
 * them as `appointment`, `scheduled`), read through the time index the
 * portal's Calendar and the agent read, with who was invited to each.
 */

import { eventAttendees } from "./suggestion-reads.js";
import type { CalendarEventCandidate } from "./suggestions.js";
import type { TemporalItem, TemporalQueryInput } from "@omnesis/core";
import type Database from "better-sqlite3";

/** Calendar entries longer than this are blocks of time, not a conversation. */
const MAX_EVENT_MS = 12 * 60 * 60 * 1000;
/** Entries read per recording: a day is rarely more crowded than this. */
const LIMIT = 20;

/** The slice of the time index this reads; `TemporalQueryService` in production. */
export interface TemporalWindowReader {
  query(input: TemporalQueryInput): Promise<{ items: TemporalItem[] }>;
}

/** Calendar events overlapping a window, each with its attendees, the owner left out. */
export function calendarEventsFrom(
  db: Database.Database,
  temporal: () => TemporalWindowReader,
): (from: string, toExclusive: string) => Promise<CalendarEventCandidate[]> {
  return async (from, toExclusive) => {
    const { items } = await temporal().query({
      from,
      to: toExclusive,
      timeZone: "UTC",
      origins: ["projection"],
      kinds: ["appointment"],
      modalities: ["scheduled"],
      statuses: ["active"],
      limit: LIMIT,
    });
    const events: CalendarEventCandidate[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const documentId = item.projection?.documentId;
      if (!documentId || seen.has(documentId) || item.allDay) continue;
      if (Date.parse(item.endExclusive) - Date.parse(item.start) > MAX_EVENT_MS) continue;
      seen.add(documentId);
      events.push({
        documentId,
        title: item.label,
        start: item.start,
        end: item.endExclusive,
        attendees: eventAttendees(db, documentId),
      });
    }
    return events;
  };
}
