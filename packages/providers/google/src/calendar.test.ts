// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, vi } from "vitest";
import { type SyncCursor, type MappedProjectionField } from "@omnesis/source-sdk";
import { rowsFor, tablesWritten, deletionsFor, writesFor } from "@omnesis/source-sdk/testing";
import {
  SourceId,
  ProviderId,
  TEMPORAL_KINDS,
  TEMPORAL_STATUSES,
  type DocumentInput,
} from "@omnesis/types";
import {
  createMockCalendar,
  createCalendarSource,
  makeCalendarEvent,
  makeCalendarListEntry,
} from "./testing/mock-google.js";
import { googleCalendarAppUrl, type GoogleCalendarSource } from "./calendar.js";

/**
 * Calendar's sync now processes one (calendar, page) per call. Tests that
 * want the post-cycle effect (all calendars drained, syncTokens captured)
 * call this helper.
 */
async function drainSync(
  source: GoogleCalendarSource,
  initial: SyncCursor | null,
): Promise<{
  documents: DocumentInput[];
  deletedExternalIds: string[];
  cursor: SyncCursor;
  callCount: number;
}> {
  let cursor: SyncCursor | null = initial;
  const documents: DocumentInput[] = [];
  const deletedExternalIds: string[] = [];
  let callCount = 0;
  while (true) {
    const res = await source.sync(cursor);
    documents.push(...res.documents);
    deletedExternalIds.push(...res.deletedExternalIds);
    cursor = res.cursor;
    callCount++;
    if (!res.hasMore) break;
    if (callCount > 100) throw new Error("drainSync runaway");
  }
  return { documents, deletedExternalIds, cursor: cursor as SyncCursor, callCount };
}

/** Every vocabulary value a projection field can resolve to. */
function mappedValues<T extends string>(field: MappedProjectionField<T, string>): T[] {
  return typeof field === "string" ? [field] : [...Object.values(field.map), field.default];
}

/**
 * Resolve a projection field against one emitted analytics row, with the same
 * semantics the gateway's derivation uses: the raw column value is stringified
 * to key the map, and an unmapped value falls back to the declared default.
 * Driving the declaration with real rows is what proves the map keys match the
 * values this source actually writes.
 */
function resolveMapped<T extends string>(
  field: MappedProjectionField<T, string>,
  row: Record<string, unknown>,
): T {
  if (typeof field === "string") return field;
  const raw = row[field.from];
  const mapped = raw === null || raw === undefined ? undefined : field.map[String(raw)];
  return mapped ?? field.default;
}

describe("GoogleCalendarSource", () => {
  let calendar: ReturnType<typeof createMockCalendar>;
  let source: GoogleCalendarSource;

  beforeEach(() => {
    calendar = createMockCalendar();
    source = createCalendarSource(calendar);
  });

  test("has correct sourceId format", () => {
    expect(source.id).toBe(SourceId("google-calendar:test@example.com"));
    expect(source.providerId).toBe(ProviderId("google:test@example.com"));
  });

  test("declares a source-owned calendar temporal projection", () => {
    expect(source.analyticsSchemas[0].sharedDiscriminatorColumn).toBe("source_account");
    expect(source.analyticsSchemas[0].temporalProjection).toMatchObject({
      slot: "calendar",
      start: "$semanticTime",
      end: "end_time",
      label: "title",
      modality: "scheduled",
      allDay: "all_day",
      eligibility: "temporal_projection_eligible",
      correlationKeys: ["ical_uid"],
    });
  });

  test("projects kinds and statuses that are inside the temporal vocabulary", () => {
    const projection = source.analyticsSchemas[0].temporalProjection;
    expect(projection).toBeDefined();
    for (const kind of mappedValues(projection!.kind)) {
      expect(TEMPORAL_KINDS).toContain(kind);
    }
    for (const status of mappedValues(projection!.status ?? "active")) {
      expect(TEMPORAL_STATUSES).toContain(status);
    }
  });

  describe("bootstrap sync", () => {
    test("fetches all calendars via calendarList.list", async () => {
      const cal = makeCalendarListEntry("cal-1", { summary: "My Calendar" });
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [], nextSyncToken: "sync-tok-1" },
        }),
      );

      await source.sync(null);

      expect(calendar.calendarList.list).toHaveBeenCalled();
    });

    test("fetches events per calendar with singleEvents and orderBy", async () => {
      const cal = makeCalendarListEntry("cal-1");
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [], nextSyncToken: "sync-tok-1" },
        }),
      );

      await source.sync(null);

      const call = calendar.events.list.mock.calls[0][0];
      expect(call.calendarId).toBe("cal-1");
      expect(call.showDeleted).toBe(true);
      expect(call.singleEvents).toBe(true);
      expect(call.timeMin).toBeDefined();
      expect(call.timeMax).toBeDefined();
    });

    test("handles pagination via nextPageToken", async () => {
      const cal = makeCalendarListEntry("cal-1");
      const event1 = makeCalendarEvent("evt-1", { summary: "Event 1" });
      const event2 = makeCalendarEvent("evt-2", { summary: "Event 2" });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));

      let callCount = 0;
      calendar.events.list = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            data: { items: [event1], nextPageToken: "page-2" },
          });
        }
        return Promise.resolve({
          data: {
            items: [event2],
            nextPageToken: undefined,
            nextSyncToken: "sync-tok-1",
          },
        });
      });

      const result = await drainSync(source, null);

      expect(result.documents).toHaveLength(2);
      expect(result.documents[0].externalId).toBe("cal-1:evt-1");
      expect(result.documents[1].externalId).toBe("cal-1:evt-2");
    });

    test("emits one complete presentIds snapshot only after every page drains", async () => {
      const cal = makeCalendarListEntry("cal-1");
      const event1 = makeCalendarEvent("evt-1", { summary: "Event 1" });
      const event2 = makeCalendarEvent("evt-2", { summary: "Event 2" });
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi
        .fn()
        .mockResolvedValueOnce({ data: { items: [event1], nextPageToken: "page-2" } })
        .mockResolvedValueOnce({
          data: { items: [event2], nextSyncToken: "sync-tok-1" },
        });

      const first = await source.syncStructured(null);
      expect(first.hasMore).toBe(true);
      expect(writesFor(first, "google_calendar_events")[0]?.presentIds).toBeUndefined();
      const second = await source.syncStructured(first.cursor);
      expect(second.hasMore).toBe(false);
      expect(writesFor(second, "google_calendar_events")[0]?.presentIds).toEqual([
        "cal-1:evt-1",
        "cal-1:evt-2",
      ]);
    });

    test("an empty calendar list withholds the snapshot instead of emptying the account", async () => {
      // A cycle with no sync tokens opens a fresh occurrence generation, which
      // starts the accumulator at []. If the calendar list is also empty the
      // cycle finishes with nothing pending and would publish `presentIds: []`
      // — "this account has no events" — deleting every stored occurrence. An
      // account always owns its primary calendar, so an empty list is a read
      // that failed, not an account that emptied.
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({ data: { items: [], nextSyncToken: "sync-tok-1" } }),
      );

      const degraded = await source.syncStructured(null);
      expect(degraded.hasMore).toBe(false);
      expect(writesFor(degraded, "google_calendar_events")[0]?.presentIds).toBeUndefined();
      expect(deletionsFor(degraded, "google_calendar_events")).toEqual([]);
      expect(degraded.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
      calendar.calendarList.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [makeCalendarListEntry("primary")] },
        }),
      );
      const recovered = await source.syncStructured(degraded.cursor);
      expect(recovered.issues).toEqual([]);
      // A later clean cycle must state its verdict even with nothing to vouch
      // with. An incremental tick accumulates no occurrence ids, so leaving it
      // unsaid kept the `snapshot-withheld` above alive after the empty list
      // was gone — a permanent warning about a calendar that never vanished,
      // with nothing the operator could do to clear it.
      const incremental = await source.syncStructured(recovered.cursor);
      expect(incremental.issues).toEqual([]);
    });

    test("a calendar that vanishes mid-cycle withholds the snapshot for that cycle", async () => {
      // Two calendars are queued; the second disappears from the list before it
      // is walked. The accumulated enumeration then holds none of its events,
      // which on the wire is indistinguishable from those events having been
      // deleted.
      const cal1 = makeCalendarListEntry("cal-1", { summary: "Work" });
      const cal2 = makeCalendarListEntry("cal-2", { summary: "Personal" });
      const event1 = makeCalendarEvent("evt-1", { summary: "Standup" });

      let listCalls = 0;
      calendar.calendarList.list = vi.fn(() => {
        listCalls++;
        return Promise.resolve({ data: { items: listCalls === 1 ? [cal1, cal2] : [cal1] } });
      });
      calendar.events.list = vi.fn(() =>
        Promise.resolve({ data: { items: [event1], nextSyncToken: "sync-tok-1" } }),
      );

      // First call walks cal-1 and leaves cal-2 pending.
      const first = await source.syncStructured(null);
      expect(first.hasMore).toBe(true);
      expect(writesFor(first, "google_calendar_events")[0]?.presentIds).toBeUndefined();
      // A page in the middle of a walk is withholding by construction — it has
      // not reached the rest of the calendars yet. Publishing that as an issue
      // raises "deletion detection is incomplete" on every routine multi-page
      // sync and retracts it moments later, so the operator sees a fault where
      // there is only work in progress. Only a finished cycle has a verdict.
      expect(first.issues, "a mid-cycle page states no verdict").toBeUndefined();

      // cal-2 is gone from the listing on the next call, so it is dropped from
      // `pending` without ever being read.
      let result = await source.syncStructured(first.cursor);
      let guard = 6;
      while (result.hasMore && guard-- > 0) {
        result = await source.syncStructured(result.cursor);
      }
      expect(result.hasMore).toBe(false);
      expect(
        writesFor(result, "google_calendar_events")[0]?.presentIds,
        "the cycle never read cal-2's events",
      ).toBeUndefined();
      expect(deletionsFor(result, "google_calendar_events")).toEqual([]);
    });

    test("a calendar list that comes back reconciles as usual", async () => {
      const cal = makeCalendarListEntry("cal-1");
      const event1 = makeCalendarEvent("evt-1", { summary: "Event 1" });
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({ data: { items: [event1], nextSyncToken: "sync-tok-1" } }),
      );

      const healthy = await source.syncStructured(null);
      expect(writesFor(healthy, "google_calendar_events")[0]?.presentIds).toEqual(["cal-1:evt-1"]);
    });

    test("the calendar list is followed past its first page", async () => {
      const cal1 = makeCalendarListEntry("cal-1", { summary: "Work" });
      const cal2 = makeCalendarListEntry("cal-2", { summary: "Personal" });
      calendar.calendarList.list = vi.fn((params?: { pageToken?: string }) =>
        Promise.resolve(
          params?.pageToken === "cl-page-2"
            ? { data: { items: [cal2] } }
            : { data: { items: [cal1], nextPageToken: "cl-page-2" } },
        ),
      );
      calendar.events.list = vi.fn(() =>
        Promise.resolve({ data: { items: [], nextSyncToken: "sync-tok-1" } }),
      );

      await drainSync(source, null);

      // A calendar sitting past the first page of the list is not a calendar
      // whose events have been deleted.
      const listed = calendar.events.list.mock.calls.map(
        (c: [{ calendarId: string }]) => c[0].calendarId,
      );
      expect(listed).toContain("cal-1");
      expect(listed).toContain("cal-2");
    });

    test("multi-calendar: events from all calendars appear", async () => {
      const cal1 = makeCalendarListEntry("cal-1", { summary: "Work" });
      const cal2 = makeCalendarListEntry("cal-2", { summary: "Personal" });
      const event1 = makeCalendarEvent("evt-1", { summary: "Meeting" });
      const event2 = makeCalendarEvent("evt-2", { summary: "Lunch" });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal1, cal2] } }));

      let callCount = 0;
      calendar.events.list = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            data: { items: [event1], nextSyncToken: "sync-1" },
          });
        }
        return Promise.resolve({
          data: { items: [event2], nextSyncToken: "sync-2" },
        });
      });

      const result = await drainSync(source, null);

      expect(result.documents).toHaveLength(2);
      expect(result.documents[0].externalId).toBe("cal-1:evt-1");
      expect(result.documents[1].externalId).toBe("cal-2:evt-2");
    });

    test("saves per-calendar syncTokens in cursor", async () => {
      const cal1 = makeCalendarListEntry("cal-1");
      const cal2 = makeCalendarListEntry("cal-2");

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal1, cal2] } }));

      let callCount = 0;
      calendar.events.list = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            data: { items: [], nextSyncToken: "sync-tok-A" },
          });
        }
        return Promise.resolve({
          data: { items: [], nextSyncToken: "sync-tok-B" },
        });
      });

      const result = await drainSync(source, null);
      const cursor = result.cursor as any;

      expect(cursor.calendarSyncTokens["cal-1"]).toBe("sync-tok-A");
      expect(cursor.calendarSyncTokens["cal-2"]).toBe("sync-tok-B");
    });

    test("returns hasMore=true while calendars remain in the cycle", async () => {
      const cal1 = makeCalendarListEntry("cal-1");
      const cal2 = makeCalendarListEntry("cal-2");

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal1, cal2] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({ data: { items: [], nextSyncToken: "tok" } }),
      );

      const first = await source.sync(null);
      expect(first.hasMore).toBe(true);

      const second = await source.sync(first.cursor);
      expect(second.hasMore).toBe(false);
    });

    test("transient API failure on one calendar does not lose other calendars' tokens", async () => {
      const cal1 = makeCalendarListEntry("cal-1");
      const cal2 = makeCalendarListEntry("cal-2");

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal1, cal2] } }));

      let callCount = 0;
      calendar.events.list = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          // cal-1 succeeds.
          return Promise.resolve({
            data: { items: [], nextSyncToken: "tok-A" },
          });
        }
        // cal-2 5xx — surfaces as a transient SyncError.
        const err: any = new Error("Service Unavailable");
        err.code = 503;
        return Promise.reject(err);
      });

      const first = await source.sync(null);
      expect(first.hasMore).toBe(true);
      const firstCursor = first.cursor as any;
      // cal-1's syncToken is captured even though cal-2 will throw next.
      expect(firstCursor.calendarSyncTokens["cal-1"]).toBe("tok-A");

      await expect(source.sync(first.cursor)).rejects.toThrow(/Service Unavailable/);
    });
  });

  describe("incremental sync", () => {
    test("uses syncToken from cursor while retaining occurrence expansion", async () => {
      const cal = makeCalendarListEntry("cal-1");
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [], nextSyncToken: "sync-tok-new" },
        }),
      );

      const cursor = {
        calendarSyncTokens: { "cal-1": "sync-tok-old" },
        occurrenceExpansion: true as const,
      };
      await source.sync(cursor);

      const call = calendar.events.list.mock.calls[0][0];
      expect(call.syncToken).toBe("sync-tok-old");
      expect(call.singleEvents).toBe(true);
      expect(call.orderBy).toBeUndefined();
    });

    test("preserves a pre-projection token generation without re-enumerating history", async () => {
      const cal = makeCalendarListEntry("cal-1");
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({ data: { items: [], nextSyncToken: "legacy-token-next" } }),
      );

      // The host's state migration stamps `occurrenceExpansion: false` onto a
      // cursor that predates the flag before `sync` ever sees it — this is
      // what that migrated value looks like.
      const result = await source.sync({
        calendarSyncTokens: { "cal-1": "legacy-master-token" },
        occurrenceExpansion: false,
      });

      const call = calendar.events.list.mock.calls[0][0];
      expect(call.syncToken).toBe("legacy-master-token");
      expect(call.singleEvents).toBeUndefined();
      expect(call.timeMin).toBeUndefined();
      expect(call.timeMax).toBeUndefined();
      expect(result.cursor).toMatchObject({
        calendarSyncTokens: { "cal-1": "legacy-token-next" },
      });
      // Every page carries the flag explicitly, settled or not, so a
      // mid-cycle value never gets mistaken for a pre-migration one.
      expect((result.cursor as Record<string, unknown>).occurrenceExpansion).toBe(false);
    });

    test("rolls an expired bounded occurrence window before following its sync token", async () => {
      const cal = makeCalendarListEntry("cal-1");
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({ data: { items: [], nextSyncToken: "fresh-token" } }),
      );

      await source.sync({
        calendarSyncTokens: { "cal-1": "stale-token" },
        windowStart: "2024-01-01T00:00:00.000Z",
        windowEnd: "2025-01-01T00:00:00.000Z",
        windowRefreshAfter: "2020-01-01T00:00:00.000Z",
        occurrenceExpansion: true,
      });

      const call = calendar.events.list.mock.calls[0][0];
      expect(call.syncToken).toBeUndefined();
      expect(call.singleEvents).toBe(true);
      expect(new Date(call.timeMax).getTime()).toBeGreaterThan(Date.now());
    });

    test("410 error clears syncToken for that calendar", async () => {
      const cal = makeCalendarListEntry("cal-1");
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));

      const error: any = new Error("Gone");
      error.code = 410;
      calendar.events.list = vi.fn(() => Promise.reject(error));

      const cursor = {
        calendarSyncTokens: { "cal-1": "expired-token" },
        occurrenceExpansion: true as const,
      };
      const result = await source.sync(cursor);

      // Should have cleared the sync token
      const newCursor = result.cursor as any;
      expect(newCursor.calendarSyncTokens["cal-1"]).toBeUndefined();
    });

    test("an expired calendar token carries withholding through a later successful sibling", async () => {
      calendar.calendarList.list = vi.fn(() =>
        Promise.resolve({
          data: {
            items: [makeCalendarListEntry("cal-1"), makeCalendarListEntry("cal-2")],
          },
        }),
      );
      calendar.events.list = vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error("Gone"), { code: 410 }))
        .mockResolvedValueOnce({ data: { items: [], nextSyncToken: "current" } });
      const first = await source.syncStructured({
        calendarSyncTokens: { "cal-1": "expired", "cal-2": "old" },
        occurrenceExpansion: true,
      });
      expect(first.hasMore).toBe(true);
      expect(first.issues).toBeUndefined();
      const final = await source.syncStructured(first.cursor);
      expect(final.hasMore).toBe(false);
      expect(final.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
      expect(writesFor(final, "google_calendar_events")[0]?.presentIds).toBeUndefined();
    });

    test("cancelled events produce deletedExternalIds", async () => {
      const cal = makeCalendarListEntry("cal-1");
      const cancelledEvent = makeCalendarEvent("evt-del", {
        status: "cancelled",
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [cancelledEvent], nextSyncToken: "sync-2" },
        }),
      );

      const cursor = {
        calendarSyncTokens: { "cal-1": "sync-1" },
        occurrenceExpansion: true as const,
      };
      const result = await source.sync(cursor);

      expect(result.documents).toHaveLength(0);
      expect(result.deletedExternalIds).toContain("cal-1:evt-del");
    });

    test("new calendar between syncs gets bootstrapped", async () => {
      const cal1 = makeCalendarListEntry("cal-1");
      const cal2 = makeCalendarListEntry("cal-new");
      const newEvent = makeCalendarEvent("evt-new", { summary: "New Event" });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal1, cal2] } }));

      let callCount = 0;
      calendar.events.list = vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          // cal-1 incremental
          return Promise.resolve({
            data: { items: [], nextSyncToken: "sync-1-new" },
          });
        }
        // cal-new bootstrap (no syncToken exists)
        return Promise.resolve({
          data: { items: [newEvent], nextSyncToken: "sync-new-1" },
        });
      });

      const cursor = {
        calendarSyncTokens: { "cal-1": "sync-1" },
        occurrenceExpansion: true as const,
      };
      const result = await drainSync(source, cursor);

      // cal-new should have been bootstrapped (no syncToken)
      const secondCall = calendar.events.list.mock.calls[1][0];
      expect(secondCall.calendarId).toBe("cal-new");
      expect(secondCall.syncToken).toBeUndefined();
      expect(secondCall.timeMin).toBeDefined();

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("cal-new:evt-new");

      const newCursor = result.cursor as any;
      expect(newCursor.calendarSyncTokens["cal-new"]).toBe("sync-new-1");
    });

    test("updates syncToken after incremental sync", async () => {
      const cal = makeCalendarListEntry("cal-1");
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [], nextSyncToken: "sync-tok-updated" },
        }),
      );

      const cursor = {
        calendarSyncTokens: { "cal-1": "sync-tok-old" },
        occurrenceExpansion: true as const,
      };
      const result = await source.sync(cursor);

      const newCursor = result.cursor as any;
      expect(newCursor.calendarSyncTokens["cal-1"]).toBe("sync-tok-updated");
    });
  });

  describe("event normalization", () => {
    test("all-day events use date format", async () => {
      const cal = makeCalendarListEntry("cal-1", { summary: "Work" });
      const event = makeCalendarEvent("evt-1", {
        summary: "Day Off",
        start: { date: "2025-01-15" },
        end: { date: "2025-01-16" },
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [event], nextSyncToken: "sync-1" },
        }),
      );

      const result = await source.sync(null);

      expect(result.documents[0].content).toContain("2025-01-15");
      expect(result.documents[0].content).toContain("2025-01-16");
    });

    test("timed events use dateTime format", async () => {
      const cal = makeCalendarListEntry("cal-1");
      const event = makeCalendarEvent("evt-1", {
        start: { dateTime: "2025-01-15T10:00:00+01:00" },
        end: { dateTime: "2025-01-15T11:30:00+01:00" },
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [event], nextSyncToken: "sync-1" },
        }),
      );

      const result = await source.sync(null);

      expect(result.documents[0].content).toContain("2025-01-15T10:00:00+01:00");
      expect(result.documents[0].content).toContain("2025-01-15T11:30:00+01:00");
    });

    test("recurring event instance uses correct externalId", async () => {
      const cal = makeCalendarListEntry("cal-1");
      const event = makeCalendarEvent("base-id_20250115T100000Z", {
        summary: "Weekly Standup",
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [event], nextSyncToken: "sync-1" },
        }),
      );

      const result = await source.sync(null);

      expect(result.documents[0].externalId).toBe("cal-1:base-id_20250115T100000Z");
    });

    test("event with attendees, location, description → correct content", async () => {
      const cal = makeCalendarListEntry("cal-1", { summary: "Work" });
      const event = makeCalendarEvent("evt-1", {
        summary: "Team Meeting",
        location: "Room 42",
        description: "Discuss roadmap priorities.",
        attendees: [
          { displayName: "Alice", email: "alice@example.com" },
          { email: "bob@example.com" },
        ],
        organizer: { displayName: "Alice", email: "alice@example.com" },
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [event], nextSyncToken: "sync-1" },
        }),
      );

      const result = await source.sync(null);
      const doc = result.documents[0];

      expect(doc.title).toBe("Team Meeting");
      expect(doc.content).toContain("# Team Meeting");
      expect(doc.content).toContain("**Calendar:** Work");
      expect(doc.content).toContain("**Location:** Room 42");
      expect(doc.content).toContain("**Attendees:** Alice, bob@example.com");
      expect(doc.content).toContain("Discuss roadmap priorities.");
      expect(doc.metadata.extra?.calendarId).toBe("cal-1");
      expect(doc.metadata.extra?.calendarName).toBe("Work");
      expect(doc.metadata.extra?.location).toBe("Room 42");
      expect(doc.metadata.documentType).toBe("event");
      expect(doc.metadata.appUrl).toBe("googlecalendar://event?eid=evt-1");
    });

    test("documentType is set to 'event' on every emitted doc", async () => {
      // Reproduces google-calendar-missing-documenttype: previously every
      // calendar doc had documentType undefined, so portal type:event filters
      // missed them.
      const cal = makeCalendarListEntry("cal-1");
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: {
            items: [makeCalendarEvent("evt-a"), makeCalendarEvent("evt-b")],
            nextSyncToken: "sync-1",
          },
        }),
      );
      const result = await source.sync(null);
      expect(result.documents.every((d) => d.metadata.documentType === "event")).toBe(true);
    });

    test("people field includes organizer as author and attendees", async () => {
      const cal = makeCalendarListEntry("cal-1", { summary: "Work" });
      const event = makeCalendarEvent("evt-1", {
        summary: "Standup",
        attendees: [
          { displayName: "Alice", email: "alice@example.com" },
          { email: "bob@example.com" },
        ],
        organizer: { displayName: "Alice", email: "alice@example.com" },
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [event], nextSyncToken: "sync-1" },
        }),
      );

      const result = await source.sync(null);
      const doc = result.documents[0];

      expect(doc.metadata.people).toBeDefined();
      expect(doc.metadata.people).toHaveLength(2);
      // Organizer as author
      expect(doc.metadata.people![0]).toEqual({
        role: "author",
        name: "Alice",
        emails: ["alice@example.com"],
      });
      // Attendee (Alice is deduped, only bob remains)
      expect(doc.metadata.people![1]).toEqual({
        role: "attendee",
        name: undefined,
        emails: ["bob@example.com"],
      });
    });

    test("people field extracts mentioned emails from description", async () => {
      const cal = makeCalendarListEntry("cal-1");
      const event = makeCalendarEvent("evt-1", {
        summary: "Planning",
        description: "Please invite charlie@example.com to the next one.",
        attendees: [{ displayName: "Alice", email: "alice@example.com" }],
        organizer: { displayName: "Alice", email: "alice@example.com" },
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [event], nextSyncToken: "sync-1" },
        }),
      );

      const result = await source.sync(null);
      const doc = result.documents[0];
      const people = doc.metadata.people!;

      // organizer (author) + mentioned from description (alice deduped)
      expect(people).toHaveLength(2);
      expect(people[0].role).toBe("author");
      expect(people[1]).toEqual({
        role: "mentioned",
        emails: ["charlie@example.com"],
      });
    });

    test("people field skips duplicate emails from description", async () => {
      const cal = makeCalendarListEntry("cal-1");
      const event = makeCalendarEvent("evt-1", {
        summary: "Review",
        description: "Organizer alice@example.com will lead.",
        organizer: { displayName: "Alice", email: "alice@example.com" },
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [event], nextSyncToken: "sync-1" },
        }),
      );

      const result = await source.sync(null);
      const doc = result.documents[0];

      // Only organizer, no duplicate from description
      expect(doc.metadata.people).toHaveLength(1);
      expect(doc.metadata.people![0].role).toBe("author");
    });
  });

  describe("data cutoff", () => {
    test("bootstrap uses cutoff date as timeMin when more recent", async () => {
      const cutoff = "2025-06-01T00:00:00Z";
      const sourceWithCutoff = createCalendarSource(calendar, {
        dataCutoff: cutoff,
      });

      const cal = makeCalendarListEntry("cal-1");
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [], nextSyncToken: "sync-1" },
        }),
      );

      await sourceWithCutoff.sync(null);

      const call = calendar.events.list.mock.calls[0][0];
      expect(call.timeMin).toBe(new Date(cutoff).toISOString());
    });

    test("incremental sync filters events that occur before the cutoff post-fetch", async () => {
      const cutoff = "2025-01-01T00:00:00Z";
      const sourceWithCutoff = createCalendarSource(calendar, {
        dataCutoff: cutoff,
      });

      const cal = makeCalendarListEntry("cal-1");
      const oldEvent = makeCalendarEvent("old-evt", {
        summary: "Old",
        created: "2024-06-01T00:00:00Z",
        start: { dateTime: "2024-06-10T10:00:00Z" },
        end: { dateTime: "2024-06-10T11:00:00Z" },
      });
      const newEvent = makeCalendarEvent("new-evt", {
        summary: "New",
        created: "2025-06-01T00:00:00Z",
        start: { dateTime: "2025-06-10T10:00:00Z" },
        end: { dateTime: "2025-06-10T11:00:00Z" },
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [oldEvent, newEvent], nextSyncToken: "sync-2" },
        }),
      );

      const cursor = {
        calendarSyncTokens: { "cal-1": "sync-1" },
        occurrenceExpansion: true as const,
      };
      const result = await sourceWithCutoff.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("cal-1:new-evt");
    });

    test("cutoff keeps a future single event created before the cutoff", async () => {
      const cutoff = "2025-01-01T00:00:00Z";
      const sourceWithCutoff = createCalendarSource(calendar, {
        dataCutoff: cutoff,
      });

      const cal = makeCalendarListEntry("cal-1");
      // Created two years before the cutoff but scheduled well after it — the
      // event is still upcoming, so a creation-time filter would wrongly drop it.
      const futureEvent = makeCalendarEvent("future-evt", {
        summary: "Future single event",
        created: "2023-01-01T00:00:00Z",
        start: { dateTime: "2026-06-01T10:00:00Z" },
        end: { dateTime: "2026-06-01T11:00:00Z" },
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [futureEvent], nextSyncToken: "sync-1" },
        }),
      );

      const cursor = {
        calendarSyncTokens: { "cal-1": "sync-old" },
        occurrenceExpansion: true as const,
      };
      const result = await sourceWithCutoff.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("cal-1:future-evt");
    });

    test("cutoff keeps a recurring series whose master was created before the cutoff", async () => {
      const cutoff = "2025-01-01T00:00:00Z";
      const sourceWithCutoff = createCalendarSource(calendar, {
        dataCutoff: cutoff,
      });

      const cal = makeCalendarListEntry("cal-1");
      // A weekly meeting series created three years ago that still recurs. The
      // API (windowed by timeMin) returns the master event because it has
      // occurrences in-window; the master's `created` predates the cutoff, so a
      // creation-time filter would drop the user's active recurring meeting.
      const recurringMaster = makeCalendarEvent("weekly-sync", {
        summary: "Weekly team sync",
        created: "2022-01-01T00:00:00Z",
        start: { dateTime: "2022-01-03T10:00:00Z" },
        end: { dateTime: "2022-01-03T11:00:00Z" },
      });
      recurringMaster.recurrence = ["RRULE:FREQ=WEEKLY;BYDAY=MO"];

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [recurringMaster], nextSyncToken: "sync-1" },
        }),
      );

      const cursor = {
        calendarSyncTokens: { "cal-1": "sync-old" },
        occurrenceExpansion: true as const,
      };
      const result = await sourceWithCutoff.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("cal-1:weekly-sync");
    });

    test("bootstrap honors cutoff older than the 1-year default", async () => {
      // Previously, calendar capped timeMin at oneYearAgo even when the user
      // set maxAge=2y or wider — silently shrinking history below the
      // configured retention window.
      const cutoff = "2022-01-01T00:00:00Z";
      const sourceWithCutoff = createCalendarSource(calendar, { dataCutoff: cutoff });

      const cal = makeCalendarListEntry("cal-1");
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({ data: { items: [], nextSyncToken: "sync-1" } }),
      );

      await sourceWithCutoff.sync(null);

      const call = calendar.events.list.mock.calls[0][0];
      expect(call.timeMin).toBe(new Date(cutoff).toISOString());
    });

    test("bootstrap falls back to 1-year-ago timeMin when no cutoff set", async () => {
      const cal = makeCalendarListEntry("cal-1");
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({ data: { items: [], nextSyncToken: "sync-1" } }),
      );

      await source.sync(null);

      const call = calendar.events.list.mock.calls[0][0];
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      // Within 5s of "1 year ago at sync time".
      expect(Math.abs(new Date(call.timeMin).getTime() - oneYearAgo.getTime())).toBeLessThan(5000);
    });

    test("events exactly at cutoff boundary are kept", async () => {
      const cutoff = "2025-01-15T00:00:00Z";
      const sourceWithCutoff = createCalendarSource(calendar, {
        dataCutoff: cutoff,
      });

      const cal = makeCalendarListEntry("cal-1");
      const boundaryEvent = makeCalendarEvent("boundary-evt", {
        summary: "Boundary",
        created: "2025-01-15T00:00:00Z",
      });

      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [boundaryEvent], nextSyncToken: "sync-1" },
        }),
      );

      const cursor = {
        calendarSyncTokens: { "cal-1": "sync-old" },
        occurrenceExpansion: true as const,
      };
      const result = await sourceWithCutoff.sync(cursor);

      expect(result.documents).toHaveLength(1);
      expect(result.documents[0].externalId).toBe("cal-1:boundary-evt");
    });
  });

  describe("edge cases", () => {
    test("empty calendar list returns no documents", async () => {
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [] } }));

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(0);
      expect(result.deletedExternalIds).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    test("calendar with 0 events is skipped gracefully", async () => {
      const cal = makeCalendarListEntry("empty-cal", { summary: "Empty" });
      calendar.calendarList.list = vi.fn(() => Promise.resolve({ data: { items: [cal] } }));
      calendar.events.list = vi.fn(() =>
        Promise.resolve({
          data: { items: [], nextSyncToken: "sync-1" },
        }),
      );

      const result = await source.sync(null);

      expect(result.documents).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      const cursor = result.cursor as any;
      expect(cursor.calendarSyncTokens["empty-cal"]).toBe("sync-1");
    });
  });
});

describe("googleCalendarAppUrl", () => {
  test("extracts eid and returns deep link", () => {
    expect(googleCalendarAppUrl("https://calendar.google.com/event?eid=abc123")).toBe(
      "googlecalendar://event?eid=abc123",
    );
  });

  test("extracts eid when it is not the first query param", () => {
    expect(googleCalendarAppUrl("https://calendar.google.com/event?foo=bar&eid=xyz789")).toBe(
      "googlecalendar://event?eid=xyz789",
    );
  });

  test("returns undefined for null", () => {
    expect(googleCalendarAppUrl(null)).toBeUndefined();
  });

  test("returns undefined for undefined", () => {
    expect(googleCalendarAppUrl(undefined)).toBeUndefined();
  });

  test("returns undefined when htmlLink has no eid param", () => {
    expect(googleCalendarAppUrl("https://calendar.google.com/event?other=value")).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(googleCalendarAppUrl("")).toBeUndefined();
  });

  test("extracts first eid when multiple exist", () => {
    expect(googleCalendarAppUrl("https://cal.google.com/event?eid=first&eid=second")).toBe(
      "googlecalendar://event?eid=first",
    );
  });
});

describe("GoogleCalendarSource.syncStructured", () => {
  let calendar: ReturnType<typeof createMockCalendar>;
  let source: GoogleCalendarSource;

  beforeEach(() => {
    calendar = createMockCalendar();
    source = createCalendarSource(calendar);
  });

  function listOnce(items: unknown[]) {
    calendar.calendarList.list = vi.fn(() =>
      Promise.resolve({ data: { items: [makeCalendarListEntry("cal-1", { summary: "Work" })] } }),
    );
    calendar.events.list = vi.fn(() => Promise.resolve({ data: { items, nextSyncToken: "tok" } }));
  }

  test("emits a google_calendar_events row with derived duration/attendees/RSVP", async () => {
    listOnce([
      makeCalendarEvent("evt-1", {
        summary: "Standup",
        start: { dateTime: "2025-01-15T10:00:00Z" },
        end: { dateTime: "2025-01-15T10:30:00Z" },
        attendees: [
          { email: "me@example.com", self: true, responseStatus: "accepted" },
          { email: "maya@example.com", responseStatus: "needsAction" },
        ],
        organizer: { email: "boss@example.com", displayName: "The Boss" },
      }),
    ]);

    const res = await source.syncStructured(null);
    expect(tablesWritten(res)).toEqual(["google_calendar_events"]);
    const rows = rowsFor(res, "google_calendar_events");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "cal-1:evt-1",
      source_account: "test@example.com",
      calendar_id: "cal-1",
      calendar_name: "Work",
      event_id: "evt-1",
      title: "Standup",
      duration_minutes: 30,
      all_day: false,
      recurring: false,
      temporal_projection_eligible: true,
      organizer_email: "boss@example.com",
      attendee_count: 2,
      response_status: "accepted",
    });
    // The row id is exactly the co-emitted document's externalId — the
    // boundDocument 1:1 edge keys on it.
    expect(res.documents?.[0]?.externalId).toBe(rows[0].id);
  });

  test("all-day event: all_day true, duration null", async () => {
    listOnce([
      makeCalendarEvent("evt-allday", {
        start: { date: "2025-02-01" },
        end: { date: "2025-02-02" },
      }),
    ]);
    const res = await source.syncStructured(null);
    expect(rowsFor(res, "google_calendar_events")[0]).toMatchObject({
      all_day: true,
      duration_minutes: null,
    });
  });

  test("a timed row projects an appointment, an all-day row projects an event", async () => {
    listOnce([
      makeCalendarEvent("evt-timed", {
        summary: "Design review",
        start: { dateTime: "2025-01-15T10:00:00Z" },
        end: { dateTime: "2025-01-15T11:00:00Z" },
      }),
      makeCalendarEvent("evt-allday", {
        summary: "Company holiday",
        start: { date: "2025-02-01" },
        end: { date: "2025-02-02" },
      }),
    ]);

    const res = await source.syncStructured(null);
    const rows = rowsFor(res, "google_calendar_events");
    const projection = source.analyticsSchemas[0].temporalProjection!;
    const timed = rows.find((row) => row.event_id === "evt-timed")!;
    const allDay = rows.find((row) => row.event_id === "evt-allday")!;

    expect(resolveMapped(projection.kind, timed)).toBe("appointment");
    expect(resolveMapped(projection.kind, allDay)).toBe("event");
  });

  test("a tentative row still projects an active fact", async () => {
    listOnce([makeCalendarEvent("evt-tentative", { status: "tentative" })]);

    const res = await source.syncStructured(null);
    const rows = rowsFor(res, "google_calendar_events");
    const projection = source.analyticsSchemas[0].temporalProjection!;
    expect(rows[0]).toMatchObject({ status: "tentative" });
    expect(resolveMapped(projection.status ?? "active", rows[0])).toBe("active");
  });

  test("cancelled event: tombstoned via deletedExternalIds, no row emitted", async () => {
    listOnce([makeCalendarEvent("evt-x", { status: "cancelled" })]);
    const res = await source.syncStructured(null);
    expect(res.deletedExternalIds).toContain("cal-1:evt-x");
    expect(deletionsFor(res, "google_calendar_events")).toContain("cal-1:evt-x");
    expect(rowsFor(res, "google_calendar_events")).toHaveLength(0);
  });

  test("marks expanded instances eligible and defensive series masters ineligible", async () => {
    const occurrence = makeCalendarEvent("evt-occurrence");
    occurrence.recurringEventId = "series-1";
    const master = makeCalendarEvent("series-1");
    master.recurrence = ["RRULE:FREQ=WEEKLY;BYDAY=MO"];
    listOnce([occurrence, master]);

    const res = await source.syncStructured(null);
    const rows = rowsFor(res, "google_calendar_events");
    const occurrenceRow = rows.find((row) => row.event_id === "evt-occurrence");
    const masterRow = rows.find((row) => row.event_id === "series-1");
    expect(occurrenceRow).toMatchObject({
      recurring: true,
      temporal_projection_eligible: true,
    });
    expect(masterRow).toMatchObject({
      recurring: true,
      temporal_projection_eligible: false,
    });
  });
});
