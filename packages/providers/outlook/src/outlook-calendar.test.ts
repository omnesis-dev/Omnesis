// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, test, expect, beforeEach, vi } from "vitest";
import { SourceId, ProviderId, SyncError } from "@omnesis/types";
import { LogLevel, setLogLevel } from "@omnesis/core";
import { rowsFor, deletionsFor, writesFor, tablesWritten } from "@omnesis/source-sdk/testing";
import { OutlookCalendarSource } from "./outlook-calendar.js";
import { DeltaExpiredError, AuthError } from "./graph-client.js";
import { OUTLOOK_CALENDAR_EVENTS_TABLE } from "./outlook-calendar-schema.js";
import type { PersonMention } from "@omnesis/types";
import type { SyncCursor } from "@omnesis/source-sdk";
import type {
  CalendarDeltaResponse,
  CalendarGraphClientLike,
  GraphCalendar,
  GraphEvent,
  OutlookCalendarCursor,
} from "./outlook-calendar-types.js";

// ── Test helpers ──────────────────────────────────────────────────────

interface MockGraph {
  get: ReturnType<typeof vi.fn>;
  /** Queue one event page, in the order the source will ask for them. */
  page: (response: unknown) => MockGraph;
  /** Queue a rejection where the next event page would have been. */
  fail: (error: unknown) => MockGraph;
  /** The calendars `/me/calendars` reports; writable for multi-calendar tests. */
  calendars: GraphCalendar[];
  /**
   * Serve `/me/calendars` as two pages, the way Graph does for an account with
   * more calendars than the default page size. The second page is an absolute
   * URL, which is the shape Graph actually issues.
   */
  pageCalendars: (firstPageSize: number) => MockGraph;
}

/** The single calendar a test gets unless it says otherwise. */
const DEFAULT_CALENDAR = { id: "cal-1", name: "Calendar" };

/** Namespace an event id the way the source keys documents and rows. */
function k(eventId: string, calendarId = DEFAULT_CALENDAR.id): string {
  return `${calendarId}:${eventId}`;
}

/**
 * A Graph transport that answers `/me/calendars` on its own and serves event
 * pages from a queue, so a test states what the events are without restating
 * that the account has a calendar. `calendars` is writable for the tests that
 * are about having more than one.
 */
function makeMockGraph(): MockGraph {
  const pages: unknown[] = [];
  let calendarPageSize: number | undefined;
  const graph = {
    calendars: [DEFAULT_CALENDAR] as GraphCalendar[],
    /** Queue one event page, in the order the source will ask for them. */
    page(response: unknown) {
      pages.push(response);
      return graph;
    },
    /** Queue a rejection where the next event page would have been. */
    fail(error: unknown) {
      pages.push({ __throw: error });
      return graph;
    },
    /**
     * Serve `/me/calendars` as two pages, the way Graph does for an account
     * with more calendars than the default page size.
     */
    pageCalendars(firstPageSize: number) {
      calendarPageSize = firstPageSize;
      return graph;
    },
    get: vi.fn((path: string) => {
      if (path.startsWith(CALENDARS_NEXT_LINK)) {
        return Promise.resolve({ value: graph.calendars.slice(calendarPageSize!) });
      }
      if (path.startsWith("/me/calendars?")) {
        if (calendarPageSize === undefined) return Promise.resolve({ value: graph.calendars });
        return Promise.resolve({
          value: graph.calendars.slice(0, calendarPageSize),
          "@odata.nextLink": CALENDARS_NEXT_LINK,
        });
      }
      const next = pages.shift();
      if (next && typeof next === "object" && "__throw" in next) {
        return Promise.reject((next as { __throw: unknown }).__throw);
      }
      return Promise.resolve(next ?? ({ value: [], "@odata.deltaLink": DELTA_LINK } as unknown));
    }),
  };
  return graph as unknown as MockGraph;
}

const DELTA_LINK = "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=served";

/** The absolute `@odata.nextLink` Graph issues for a second page of calendars. */
const CALENDARS_NEXT_LINK = "https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=cal-page-2";

/** The `calendarView` path for one calendar. */
function viewPath(calendarId = DEFAULT_CALENDAR.id): string {
  return `/me/calendars/${calendarId}/calendarView/delta`;
}

/**
 * Run a whole sync cycle: one call per calendar-page, then the call that finds
 * the queue empty and publishes the snapshot. Returns every page in order, so a
 * test can assert on the pages or on the final one as it needs.
 */
async function runCycle(
  source: OutlookCalendarSource,
  cursor: SyncCursor | null = null,
  limit = 12,
): Promise<Array<Awaited<ReturnType<OutlookCalendarSource["syncStructured"]>>>> {
  const pages = [];
  let next = cursor;
  for (let i = 0; i < limit; i++) {
    const page = await source.syncStructured(next);
    pages.push(page);
    if (!page.hasMore) return pages;
    next = page.cursor;
  }
  throw new Error("cycle did not finish within the page limit");
}

function makeEvent(id: string, overrides: Partial<GraphEvent> = {}): GraphEvent {
  return {
    id,
    iCalUId: overrides.iCalUId ?? `ical-${id}`,
    subject: overrides.subject ?? `Event ${id}`,
    bodyPreview: overrides.bodyPreview ?? "",
    start: overrides.start ?? { dateTime: "2024-06-01T10:00:00.0000000", timeZone: "UTC" },
    end: overrides.end ?? { dateTime: "2024-06-01T11:00:00.0000000", timeZone: "UTC" },
    isAllDay: overrides.isAllDay ?? false,
    type: overrides.type ?? "singleInstance",
    organizer: overrides.organizer ?? {
      emailAddress: { name: "Maya Reeves", address: "maya@example.com" },
    },
    attendees: overrides.attendees ?? [
      {
        type: "required",
        status: { response: "accepted" },
        emailAddress: { name: "Jamie Lopez", address: "jamie@example.com" },
      },
    ],
    responseStatus: overrides.responseStatus ?? { response: "organizer" },
    webLink: overrides.webLink ?? `https://outlook.live.com/calendar/0/view/x?itemid=${id}`,
    createdDateTime: overrides.createdDateTime ?? "2024-05-01T00:00:00Z",
    lastModifiedDateTime: overrides.lastModifiedDateTime ?? "2024-05-02T00:00:00Z",
    ...overrides,
  };
}

/**
 * An occurrence as `calendarView/delta` actually sends one: a delta against its
 * master carrying an id, a time range, and essentially nothing else. Built by
 * hand rather than from `makeEvent`, because what makes this shape interesting
 * is precisely the fields that are missing.
 */
function sparseOccurrence(
  id: string,
  seriesMasterId: string,
  overrides: Partial<GraphEvent> = {},
): GraphEvent {
  return {
    id,
    type: "occurrence",
    seriesMasterId,
    start: { dateTime: "2024-06-03T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2024-06-03T09:15:00.0000000", timeZone: "UTC" },
    isAllDay: false,
    ...overrides,
  };
}

function createSource(graph: MockGraph, dataCutoff?: string): OutlookCalendarSource {
  return new OutlookCalendarSource(
    async () => "mock-token",
    "outlook-calendar:user@example.com",
    "microsoft:user@example.com",
    dataCutoff,
    // The vi.fn() mock's signature can't structurally match the generic
    // `get<T>` method; cast through the transport interface for the test seam.
    { graph: graph as unknown as CalendarGraphClientLike },
  );
}

// ── Identity ──────────────────────────────────────────────────────────

describe("OutlookCalendarSource — identity", () => {
  test("sets id and providerId from constructor args", () => {
    const source = createSource(makeMockGraph());
    expect(source.id).toBe(SourceId("outlook-calendar:user@example.com"));
    expect(source.providerId).toBe(ProviderId("microsoft:user@example.com"));
  });

  test("exposes the outlook_calendar_events analytics schema", () => {
    const source = createSource(makeMockGraph());
    expect(source.analyticsSchemas).toHaveLength(1);
    expect(source.analyticsSchemas[0].tableName).toBe(OUTLOOK_CALENDAR_EVENTS_TABLE);
    expect(source.analyticsSchemas[0].semanticTimeColumn).toBe("start_time");
    expect(source.analyticsSchemas[0].sharedDiscriminatorColumn).toBe("source_account");
    expect(source.analyticsSchemas[0].temporalProjection?.eligibility).toBe(
      "temporal_projection_eligible",
    );
  });
});

// ── Bootstrap ─────────────────────────────────────────────────────────

describe("OutlookCalendarSource — bootstrap", () => {
  let graph: MockGraph;
  beforeEach(() => {
    graph = makeMockGraph();
  });

  test("reads each calendar's own calendarView over a bounded window", async () => {
    graph.page({
      value: [makeEvent("evt-1")],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=delta-1",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const pages = await runCycle(source);

    expect(graph.get).toHaveBeenCalledWith(
      viewPath(),
      expect.objectContaining({
        startDateTime: expect.any(String),
        endDateTime: expect.any(String),
      }),
      expect.anything(),
    );
    expect(pages[0]!.documents).toHaveLength(1);
    expect(pages[0]!.documents![0]!.externalId).toBe(k("evt-1"));
    // The deltaLink is kept against the calendar that issued it, so the next
    // cycle asks that calendar for changes rather than re-enumerating it.
    const cursor = pages.at(-1)!.cursor as OutlookCalendarCursor;
    expect(cursor.calendarLinks?.[DEFAULT_CALENDAR.id]).toContain("token=delta-1");
    expect(cursor.pendingCalendars).toBeUndefined();
  });

  test("paginates via @odata.nextLink, keeping the calendar at the head of the queue", async () => {
    graph.page({
      value: [makeEvent("evt-1")],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=page-2",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync(null);

    expect(result.hasMore).toBe(true);
    const cursor = result.cursor as OutlookCalendarCursor;
    expect(cursor.pendingCalendars).toEqual([DEFAULT_CALENDAR.id]);
    expect(cursor.resumeLink).toContain("$skiptoken=page-2");

    // Next call follows the nextLink (not the calendar's root endpoint).
    graph.page({
      value: [makeEvent("evt-2")],
      "@odata.deltaLink":
        "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=delta-final",
    } as CalendarDeltaResponse);
    const second = await source.sync(cursor);
    expect(graph.get).toHaveBeenLastCalledWith(cursor.resumeLink);
    expect(second.documents[0].externalId).toBe(k("evt-2"));
    const drained = second.cursor as OutlookCalendarCursor;
    expect(drained.pendingCalendars).toEqual([]);
    expect(drained.resumeLink).toBeUndefined();
    expect(drained.calendarLinks?.[DEFAULT_CALENDAR.id]).toContain("token=delta-final");
  });

  test("emits a complete presentIds snapshot only once the cycle drains", async () => {
    graph
      .page({
        value: [makeEvent("evt-1")],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=page-2",
      } as CalendarDeltaResponse)
      .page({
        value: [makeEvent("evt-2")],
        "@odata.deltaLink":
          "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=delta-final",
      } as CalendarDeltaResponse);

    const source = createSource(graph);
    const pages = await runCycle(source);
    // A partial page claiming to be a snapshot would read as "everything else
    // is gone" and delete the rest of the calendar.
    for (const page of pages.slice(0, -1))
      expect(writesFor(page, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toBeUndefined();
    const last = pages.at(-1)!;
    expect(last.hasMore).toBe(false);
    expect(writesFor(last, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toEqual([
      k("evt-1"),
      k("evt-2"),
    ]);
  });
});

// ── Incremental ───────────────────────────────────────────────────────

describe("OutlookCalendarSource — incremental", () => {
  let graph: MockGraph;
  beforeEach(() => {
    graph = makeMockGraph();
  });

  test("follows the persisted deltaLink and returns new + removed events", async () => {
    graph.page({
      value: [
        makeEvent("evt-new"),
        { id: "evt-gone", "@removed": { reason: "deleted" } } as GraphEvent,
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=delta-2",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const link = "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=delta-1";
    const cursor: OutlookCalendarCursor = {
      calendarLinks: { [DEFAULT_CALENDAR.id]: link },
    };
    const result = await source.sync(cursor);

    expect(graph.get).toHaveBeenCalledWith(link);
    expect(result.documents.map((d) => d.externalId)).toEqual([k("evt-new")]);
    expect(result.deletedExternalIds).toEqual([k("evt-gone")]);
    expect((result.cursor as OutlookCalendarCursor).calendarLinks?.[DEFAULT_CALENDAR.id]).toContain(
      "token=delta-2",
    );
  });

  test("rolls an expired bounded window, abandoning every calendar's stale link", async () => {
    // Graph bakes the calendarView bounds into every delta link it issues, so
    // the future edge only advances by abandoning that generation — for all
    // calendars at once, since they were all minted against the same window.
    const second = { id: "cal-2", name: "Side projects" };
    graph.calendars = [DEFAULT_CALENDAR, second];
    graph
      .page({
        value: [makeEvent("evt-1")],
        "@odata.deltaLink": DELTA_LINK,
      } as CalendarDeltaResponse)
      .page({ value: [], "@odata.deltaLink": DELTA_LINK } as CalendarDeltaResponse);

    const source = createSource(graph);
    const pages = await runCycle(source, {
      calendarLinks: {
        [DEFAULT_CALENDAR.id]: "https://graph.microsoft.com/v1.0/stale-one",
        [second.id]: "https://graph.microsoft.com/v1.0/stale-two",
      },
      windowRefreshAfter: "2020-01-01T00:00:00.000Z",
    } as OutlookCalendarCursor);

    // Neither stale link is followed; both calendars are re-read over a fresh
    // bounded window.
    expect(graph.get).not.toHaveBeenCalledWith("https://graph.microsoft.com/v1.0/stale-one");
    expect(graph.get).not.toHaveBeenCalledWith("https://graph.microsoft.com/v1.0/stale-two");
    for (const calendarId of [DEFAULT_CALENDAR.id, second.id]) {
      expect(graph.get).toHaveBeenCalledWith(
        viewPath(calendarId),
        expect.objectContaining({
          startDateTime: expect.any(String),
          endDateTime: expect.any(String),
        }),
        expect.anything(),
      );
    }
    // Re-reading every calendar in full is an enumeration, so the cycle carries
    // a snapshot — which is what makes the roll reconcile rather than just
    // re-ingest.
    const last = pages.at(-1)!;
    expect(writesFor(last, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toEqual([k("evt-1")]);
    // And the refreshed deadline is carried forward, or the next call would
    // roll again and the source would never leave bootstrap.
    const cursor = last.cursor as OutlookCalendarCursor;
    expect(Date.parse(cursor.windowRefreshAfter!)).toBeGreaterThan(Date.now());
  });

  test("a window roll does not advance the past edge, so the snapshot never culls history", async () => {
    graph.page({ value: [], "@odata.deltaLink": DELTA_LINK } as CalendarDeltaResponse);
    const source = createSource(graph);
    const anchored = "2020-06-01T00:00:00.000Z";
    await source.sync({
      calendarLinks: { [DEFAULT_CALENDAR.id]: "https://graph.microsoft.com/v1.0/stale" },
      windowStart: anchored,
      windowRefreshAfter: "2020-01-01T00:00:00.000Z",
    } as OutlookCalendarCursor);

    const enumerate = graph.get.mock.calls.find((call) => call[0] === viewPath());
    expect((enumerate![1] as { startDateTime: string }).startDateTime).toBe(anchored);
  });

  test("tombstones cancelled events", async () => {
    graph.page({
      value: [makeEvent("evt-cancelled", { isCancelled: true })],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=delta-3",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync({
      phase: "incremental",
      link: "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=delta-1",
    });

    expect(result.documents).toHaveLength(0);
    expect(result.deletedExternalIds).toEqual([k("evt-cancelled")]);
  });
});

// ── Normalization ─────────────────────────────────────────────────────

describe("OutlookCalendarSource — normalization", () => {
  test("normalizes title, body, when, location, attendees, and people", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("evt-1", {
          subject: "Q4 budget review",
          location: { displayName: "Riverside Estate" },
          body: { contentType: "html", content: "<p>Bring the deck. Ping sarah@example.com.</p>" },
          onlineMeeting: { joinUrl: "https://teams.example.com/meet/abc" },
        }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync(null);
    const doc = result.documents[0];

    expect(doc.title).toBe("Q4 budget review");
    expect(doc.content).toContain("# Q4 budget review");
    expect(doc.content).toContain("**Location:** Riverside Estate");
    expect(doc.content).toContain("**Meeting link:** https://teams.example.com/meet/abc");
    expect(doc.content).toContain("Bring the deck");
    expect(doc.metadata.documentType).toBe("event");
    expect(doc.metadata.sourceUrl).toContain("itemid=evt-1");

    // Organizer is an author, attendee an attendee, a body email a mention.
    const people = doc.metadata.people ?? [];
    expect(people.find((p) => p.emails?.includes("maya@example.com"))?.role).toBe("author");
    expect(people.find((p) => p.emails?.includes("jamie@example.com"))?.role).toBe("attendee");
    expect(people.find((p) => p.emails?.includes("sarah@example.com"))?.role).toBe("mentioned");
  });

  test("persists Graph iCalUId under metadata.extra.iCalUID for cross-source linking", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [makeEvent("evt-1", { iCalUId: "040000008200E00074C5B7101A82E008" })],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync(null);
    expect(result.documents[0].metadata.extra?.iCalUID).toBe("040000008200E00074C5B7101A82E008");
  });

  test("normalizes UTC wall-clock times to ISO-8601 Z instants", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("evt-1", {
          start: { dateTime: "2024-06-01T10:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2024-06-01T11:30:00.0000000", timeZone: "UTC" },
        }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync(null);
    expect(result.documents[0].metadata.extra?.start).toBe("2024-06-01T10:00:00.000Z");
    expect(result.documents[0].metadata.extra?.end).toBe("2024-06-01T11:30:00.000Z");
  });

  test("flags all-day events, and an occurrence carries its series' recurrence", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("evt-allday", { isAllDay: true }),
        makeEvent("evt-series", {
          type: "seriesMaster",
          recurrence: {
            pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday", "wednesday"] },
            range: { type: "noEnd", startDate: "2024-06-01" },
          },
        }),
        sparseOccurrence("occ-1", "evt-series"),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.sync(null);
    expect(
      result.documents.find((d) => d.externalId === k("evt-allday"))?.metadata.extra?.allDay,
    ).toBe(true);
    // The pattern lives only on the master, and the master is not itself a
    // document — so the occurrence has to carry it or it is lost.
    const occ = result.documents.find((d) => d.externalId === k("occ-1"));
    expect(occ?.content).toContain("**Recurrence:** weekly every 1 on monday, wednesday");
  });
});

// ── Structured (hybrid) sync ──────────────────────────────────────────

describe("OutlookCalendarSource — syncStructured", () => {
  test("emits one analytics row per event, keyed 1:1 with the document", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("evt-1", {
          subject: "Standup",
          start: { dateTime: "2024-06-01T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2024-06-01T09:30:00.0000000", timeZone: "UTC" },
          responseStatus: { response: "accepted" },
          location: { displayName: "Studio Northstar" },
        }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.syncStructured(null);

    expect(tablesWritten(result)).toEqual([OUTLOOK_CALENDAR_EVENTS_TABLE]);
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)).toHaveLength(1);
    const row = rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)[0];
    expect(row.id).toBe(k("evt-1"));
    expect(row.source_account).toBe("user@example.com");
    // Row id equals the co-emitted document externalId (1:1 bound document).
    expect(result.documents?.[0].externalId).toBe(row.id);
    expect(row.title).toBe("Standup");
    expect(row.start_time).toBe("2024-06-01T09:00:00.000Z");
    expect(row.duration_minutes).toBe(30);
    expect(row.all_day).toBe(false);
    expect(row.recurring).toBe(false);
    expect(row.temporal_projection_eligible).toBe(true);
    expect(row.organizer_email).toBe("maya@example.com");
    expect(row.attendee_count).toBe(1);
    expect(row.response_status).toBe("accepted");
    expect(row.location).toBe("Studio Northstar");
    expect(row.status).toBe("confirmed");
    expect(row.ical_uid).toBe("ical-evt-1");
  });

  test("leaves duration null for all-day events and marks series members recurring", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("evt-allday", { isAllDay: true }),
        makeEvent("evt-occ", { type: "occurrence" }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.syncStructured(null);
    const allday = rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE).find(
      (r) => r.id === k("evt-allday"),
    );
    const occ = rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE).find((r) => r.id === k("evt-occ"));
    expect(allday?.duration_minutes).toBeNull();
    expect(allday?.all_day).toBe(true);
    expect(occ?.recurring).toBe(true);
    expect(occ?.temporal_projection_eligible).toBe(true);
  });

  test("a series master produces no row and no document — it is a template", async () => {
    // `calendarView` expands the series, so the master duplicates whichever
    // occurrence shares its start. It is retracted rather than emitted, which
    // also clears masters indexed before that was true.
    const graph = makeMockGraph();
    graph.page({
      value: [makeEvent("evt-series", { type: "seriesMaster" })],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.syncStructured(null);
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)).toEqual([]);
    expect(result.documents).toEqual([]);
    expect(result.deletedExternalIds).toEqual([k("evt-series")]);
    expect(deletionsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)).toEqual([k("evt-series")]);
  });

  test("tombstones cancelled events on the structured side too", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [makeEvent("evt-x", { isCancelled: true })],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.syncStructured(null);
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)).toHaveLength(0);
    expect(result.deletedExternalIds).toEqual([k("evt-x")]);
    expect(deletionsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)).toEqual([k("evt-x")]);
  });
});

// ── Error handling ────────────────────────────────────────────────────

describe("OutlookCalendarSource — error handling", () => {
  test("re-reads a calendar in full on a 410 delta-token expiry, without throwing", async () => {
    const graph = makeMockGraph();
    graph.fail(new DeltaExpiredError());

    const source = createSource(graph);
    const result = await source.sync({
      calendarLinks: {
        [DEFAULT_CALENDAR.id]: "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=stale",
      },
      pendingCalendars: [DEFAULT_CALENDAR.id],
    } as OutlookCalendarCursor);

    expect(result.documents).toHaveLength(0);
    expect(result.hasMore).toBe(true);
    const cursor = result.cursor as OutlookCalendarCursor;
    // The stale link is dropped and the calendar stays at the head of the
    // queue, so the next call re-reads that one calendar in full.
    expect(cursor.calendarLinks).toEqual({});
    expect(cursor.pendingCalendars).toEqual([DEFAULT_CALENDAR.id]);

    // The next call re-enumerates from the calendar's root with a fresh window.
    graph.page({
      value: [makeEvent("evt-1")],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=fresh",
    } as CalendarDeltaResponse);
    const second = await source.sync(cursor);
    expect(graph.get).toHaveBeenLastCalledWith(
      viewPath(),
      expect.objectContaining({ startDateTime: expect.any(String) }),
      expect.anything(),
    );
    expect(second.documents[0].externalId).toBe(k("evt-1"));
  });

  test("a 410 on one calendar does not send the cycle back to the first", async () => {
    // Restarting would re-walk every calendar already visited — quadratic on an
    // account whose tokens all expired together, which is the normal case since
    // they were minted at the same window roll.
    const graph = makeMockGraph();
    const second = { id: "cal-2", name: "Side projects" };
    graph.calendars = [DEFAULT_CALENDAR, second];
    graph.fail(new DeltaExpiredError());

    const source = createSource(graph);
    const result = await source.sync({
      calendarLinks: {
        [DEFAULT_CALENDAR.id]: "https://graph/one",
        [second.id]: "https://graph/two",
      },
      pendingCalendars: [second.id],
      windowRefreshAfter: "2999-01-01T00:00:00Z",
    } as OutlookCalendarCursor);

    const cursor = result.cursor as OutlookCalendarCursor;
    expect(cursor.pendingCalendars).toEqual([second.id]);
    // The calendar that already drained keeps its link — it was not the one
    // that expired, and re-walking it would be work for nothing.
    expect(cursor.calendarLinks).toEqual({ [DEFAULT_CALENDAR.id]: "https://graph/one" });
  });

  test("a calendar this account cannot read is skipped, not allowed to starve the rest", async () => {
    // `/me/calendars` lists subscribed feeds and calendars shared in with
    // limited rights; some of those reject a delta query outright. Letting that
    // escape would abort the cycle at the same calendar on every tick, and
    // nothing behind it in the queue would ever sync again.
    const graph = makeMockGraph();
    const second = { id: "cal-2", name: "Team feed" };
    graph.calendars = [DEFAULT_CALENDAR, second];
    graph
      .page({
        value: [makeEvent("evt-1")],
        "@odata.deltaLink": DELTA_LINK,
      } as CalendarDeltaResponse)
      .fail(new Error("Graph API error 403: Access is denied"));

    const source = createSource(graph);
    const pages = await runCycle(source);

    const ids = pages.flatMap((p) => (p.documents ?? []).map((d) => d.externalId));
    expect(ids).toEqual([k("evt-1")]);
    // The account-wide forms go with it: a cycle that could not read a calendar
    // has not enumerated the account, and publishing either would delete that
    // calendar's events and rows.
    expect(writesFor(pages.at(-1)!, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toBeUndefined();
    expect(pages.at(-1)!.presentExternalIds).toBeUndefined();
    expect(pages.at(-1)!.issues).toEqual([expect.objectContaining({ code: "snapshot-withheld" })]);
    // The calendar that WAS read is still vouched for by name, so a meeting
    // deleted in it is found on this cycle rather than after the unreadable one
    // is fixed — which, for a feed shared in with the wrong rights, is never.
    expect(pages.at(-1)!.presentClaims).toEqual([
      { partition: DEFAULT_CALENDAR.id, ids: [k("evt-1")] },
    ]);
    // Every document says which calendar it is in, or the claim above would
    // name a partition holding nothing.
    expect(pages.flatMap((p) => p.documents ?? []).map((d) => d.partitionKey)).toEqual([
      DEFAULT_CALENDAR.id,
    ]);
  });

  test("names the calendar it could not vouch for, and what Graph said", async () => {
    // The calendar would be withheld anyway — a partition nobody covered is one
    // nobody vouched for — so the explicit record buys only the reason, and the
    // operator's log is the only place it surfaces. "cal-2 was not read this
    // cycle" and "cal-2 answered 403: Access is denied" are the difference
    // between a line worth acting on and a line worth ignoring.
    const graph = makeMockGraph();
    graph.calendars = [DEFAULT_CALENDAR, { id: "cal-2", name: "Team feed" }];
    graph
      .page({
        value: [makeEvent("evt-1")],
        "@odata.deltaLink": DELTA_LINK,
      } as CalendarDeltaResponse)
      .fail(new Error("Graph API error 403: Access is denied"));

    setLogLevel(LogLevel.INFO);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await runCycle(createSource(graph));
      // One line, not two: the skip is logged either way, and the enumeration's
      // own account of why it is withholding is what has to name the reason.
      // Split across two lines it reads as "cal-2 was not read this cycle" next
      // to an unrelated 403, and nothing connects them.
      const withheld = warn.mock.calls
        .flat()
        .map(String)
        .find((line) => line.includes("Snapshot withheld"));
      expect(withheld).toContain("cal-2");
      expect(withheld).toContain("Access is denied");
    } finally {
      warn.mockRestore();
      setLogLevel(LogLevel.WARN);
    }
  });

  test("an auth failure on a calendar still escapes, so the collector can see it", async () => {
    // `needs-auth` and the sync backoff are both decided from what escapes, and
    // every calendar behind this one would fail the same way — Mail and
    // OneDrive read through the same account token, so `sync` reports the
    // failure as `connection`-scoped rather than a fact about this calendar.
    const graph = makeMockGraph();
    graph.fail(new AuthError("token expired"));

    const error = await createSource(graph)
      .sync(null)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).kind).toBe("auth");
    expect((error as SyncError).scope).toBe("connection");
    expect((error as SyncError).cause).toBeInstanceOf(AuthError);
  });

  test("propagates non-delta errors", async () => {
    const graph = makeMockGraph();
    graph.get.mockRejectedValueOnce(new Error("Graph API error 500: boom"));
    const source = createSource(graph);
    await expect(source.sync(null)).rejects.toThrow(/boom/);
  });
});

// ── Data cutoff & cursor validation ───────────────────────────────────

describe("OutlookCalendarSource — cutoff and cursor", () => {
  test("filters events (docs and rows) that OCCUR before the data cutoff", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("evt-past", {
          start: { dateTime: "2022-03-01T10:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2022-03-01T11:00:00.0000000", timeZone: "UTC" },
        }),
        makeEvent("evt-inside", {
          start: { dateTime: "2024-06-01T10:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2024-06-01T11:00:00.0000000", timeZone: "UTC" },
        }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph, "2023-01-01T00:00:00Z");
    const result = await source.syncStructured(null);
    expect(result.documents?.map((d) => d.externalId)).toEqual([k("evt-inside")]);
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE).map((r) => r.id)).toEqual([
      k("evt-inside"),
    ]);
  });

  test("keeps an in-window occurrence of a series created long before the cutoff", async () => {
    // The failure the occurrence-based cutoff exists to prevent: `calendarView`
    // stamps every expanded occurrence with the SERIES' creation date, so a
    // creation-time filter erases a standing weekly meeting outright.
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("occ-this-week", {
          type: "occurrence",
          seriesMasterId: "series-standup",
          createdDateTime: "2019-02-01T00:00:00Z",
          lastModifiedDateTime: "2019-02-01T00:00:00Z",
          start: { dateTime: "2024-06-03T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2024-06-03T09:15:00.0000000", timeZone: "UTC" },
        }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph, "2023-01-01T00:00:00Z");
    const result = await source.syncStructured(null);
    expect(result.documents?.map((d) => d.externalId)).toEqual([k("occ-this-week")]);
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE).map((r) => r.id)).toEqual([
      k("occ-this-week"),
    ]);
  });

  test("marks an occurrence recurring from seriesMasterId when the page omits `type`", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [makeEvent("occ-sparse", { type: undefined, seriesMasterId: "series-standup" })],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.syncStructured(null);
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.recurring).toBe(true);
  });

  test("keeps an event that straddles the cutoff (starts before, ends after)", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("evt-straddling", {
          start: { dateTime: "2022-12-30T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2023-01-02T17:00:00.0000000", timeZone: "UTC" },
        }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph, "2023-01-01T00:00:00Z");
    const result = await source.syncStructured(null);
    expect(result.documents?.map((d) => d.externalId)).toEqual([k("evt-straddling")]);
  });

  test("retracts an event rescheduled from inside the window to before the cutoff", async () => {
    // Bounding by occurrence means an event can LEAVE the window. The document
    // is already in the index showing the old time, so the drop must retract
    // it — nothing else reconciles documents on this source.
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("evt-moved-back", {
          start: { dateTime: "2019-04-02T10:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2019-04-02T11:00:00.0000000", timeZone: "UTC" },
        }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph, "2023-01-01T00:00:00Z");
    const result = await source.syncStructured({
      phase: "incremental",
      link: "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=prev",
      windowRefreshAfter: "2999-01-01T00:00:00Z",
    } as OutlookCalendarCursor);

    expect(result.documents).toEqual([]);
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)).toEqual([]);
    expect(result.deletedExternalIds).toEqual([k("evt-moved-back")]);
    expect(deletionsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)).toEqual([k("evt-moved-back")]);
  });

  test("an in-window occurrence of a pre-cutoff series survives, master and all", async () => {
    // The master's own dates describe only the series' first instance, years
    // before the cutoff. The occurrence is what must be judged, and it is in
    // window — so it survives while the master is retracted as a template.
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("series-standup", {
          type: "seriesMaster",
          subject: "Monday standup",
          start: { dateTime: "2019-02-04T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2019-02-04T09:15:00.0000000", timeZone: "UTC" },
          recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] } },
        }),
        sparseOccurrence("occ-this-week", "series-standup", {
          start: { dateTime: "2024-06-03T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2024-06-03T09:15:00.0000000", timeZone: "UTC" },
        }),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph, "2023-01-01T00:00:00Z");
    const result = await source.syncStructured(null);
    expect(result.documents?.map((d) => d.externalId)).toEqual([k("occ-this-week")]);
    expect(result.documents?.[0]?.title).toBe("Monday standup");
    expect(result.deletedExternalIds).toEqual([k("series-standup")]);
  });

  test("keeps an event with missing start and end rather than silently dropping it", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [makeEvent("evt-undated", { start: undefined, end: undefined })],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph, "2023-01-01T00:00:00Z");
    const result = await source.syncStructured(null);
    expect(result.documents?.map((d) => d.externalId)).toEqual([k("evt-undated")]);
  });

  test("a cutoff-dropped event is left out of the presentIds snapshot", async () => {
    // presentIds reconciles the analytics table by absence, so an event the
    // cutoff drops must not be claimed present.
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("evt-past", {
          start: { dateTime: "2022-03-01T10:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2022-03-01T11:00:00.0000000", timeZone: "UTC" },
        }),
        makeEvent("evt-inside"),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph, "2023-01-01T00:00:00Z");
    const pages = await runCycle(source);
    expect(writesFor(pages.at(-1)!, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toEqual([
      k("evt-inside"),
    ]);
  });

  test("no cutoff keeps every event regardless of when it occurred", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("evt-ancient", {
          start: { dateTime: "2015-01-01T10:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2015-01-01T11:00:00.0000000", timeZone: "UTC" },
        }),
        makeEvent("evt-recent"),
      ],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const result = await source.syncStructured(null);
    expect(result.documents?.map((d) => d.externalId)).toEqual([k("evt-ancient"), k("evt-recent")]);
  });

  test("a malformed cursor falls back to a fresh bootstrap", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [makeEvent("evt-1")],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d",
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    // `phase` is not a valid literal → cursor rejected → bootstrap.
    const result = await source.sync({ phase: "nonsense" } as unknown as OutlookCalendarCursor);
    expect(graph.get).toHaveBeenCalledWith(viewPath(), expect.any(Object), expect.anything());
    expect(result.documents[0].externalId).toBe(k("evt-1"));
  });
});

// ── Recurring occurrences ─────────────────────────────────────────────

describe("OutlookCalendarSource — recurring occurrences", () => {
  const DELTA = "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d";

  function master(id: string, overrides: Partial<GraphEvent> = {}): GraphEvent {
    return makeEvent(id, {
      type: "seriesMaster",
      subject: "Monday standup",
      location: { displayName: "Harbourview room" },
      recurrence: { pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] } },
      ...overrides,
    });
  }

  test("an occurrence inherits everything descriptive from its master", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [master("series-1"), sparseOccurrence("occ-1", "series-1")],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const result = await createSource(graph).syncStructured(null);
    expect(result.documents?.map((d) => d.externalId)).toEqual([k("occ-1")]);

    const doc = result.documents![0]!;
    expect(doc.title).toBe("Monday standup");
    expect(doc.metadata.extra?.location).toBe("Harbourview room");
    expect(doc.metadata.extra?.seriesMasterId).toBe("series-1");
    // Organizer and attendees come from the master too, so the occurrence
    // reaches the people graph rather than arriving anonymous.
    expect((doc.metadata.people ?? []).length).toBeGreaterThan(0);

    const row = rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]!;
    expect(row.title).toBe("Monday standup");
    expect(row.location).toBe("Harbourview room");
    expect(row.recurring).toBe(true);
    expect(row.temporal_projection_eligible).toBe(true);
  });

  test("the occurrence keeps its OWN times — those are never inherited", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        master("series-1", {
          start: { dateTime: "2019-02-04T09:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2019-02-04T09:15:00.0000000", timeZone: "UTC" },
        }),
        sparseOccurrence("occ-1", "series-1", {
          start: { dateTime: "2026-09-07T08:30:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-09-07T09:00:00.0000000", timeZone: "UTC" },
        }),
      ],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const result = await createSource(graph).syncStructured(null);
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]!.start_time).toBe(
      "2026-09-07T08:30:00.000Z",
    );
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]!.end_time).toBe(
      "2026-09-07T09:00:00.000Z",
    );
  });

  test("an occurrence that overrides a field keeps its own value", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        master("series-1"),
        sparseOccurrence("occ-moved", "series-1", {
          subject: "Monday standup — moved to the annex",
          location: { displayName: "Annex" },
        }),
      ],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const result = await createSource(graph).syncStructured(null);
    expect(result.documents![0]!.title).toBe("Monday standup — moved to the annex");
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]!.location).toBe("Annex");
  });

  test("a cancelled occurrence is not resurrected by a live master", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        master("series-1"),
        { ...sparseOccurrence("occ-off", "series-1"), isCancelled: true },
      ],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const result = await createSource(graph).syncStructured(null);
    expect(result.documents).toEqual([]);
    expect([...(result.deletedExternalIds ?? [])].sort()).toEqual([k("occ-off"), k("series-1")]);
  });

  test("a master outside the window is fetched once, however many occurrences need it", async () => {
    // The ordinary shape for a standing meeting: the series began years before
    // the bounded window, so the enumeration never sends its master.
    const graph = makeMockGraph();
    graph.get.mockImplementation((path: string) => {
      if (path.startsWith("/me/calendars?")) {
        return Promise.resolve({ value: graph.calendars });
      }
      if (path.startsWith("/me/events/")) return Promise.resolve(master("series-old"));
      return Promise.resolve({
        value: [
          sparseOccurrence("occ-1", "series-old"),
          sparseOccurrence("occ-2", "series-old"),
          sparseOccurrence("occ-3", "series-old"),
        ],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse);
    });

    const result = await createSource(graph).syncStructured(null);
    expect(result.documents?.map((d) => d.title)).toEqual([
      "Monday standup",
      "Monday standup",
      "Monday standup",
    ]);
    const masterFetches = graph.get.mock.calls.filter((c) =>
      String(c[0]).startsWith("/me/events/"),
    );
    expect(masterFetches, "three occurrences, one series, one request").toHaveLength(1);
  });

  test("an unreadable master leaves the occurrence emitted rather than dropped", async () => {
    const graph = makeMockGraph();
    graph.get.mockImplementation((path: string) => {
      if (path.startsWith("/me/calendars?")) {
        return Promise.resolve({ value: graph.calendars });
      }
      if (path.startsWith("/me/events/")) return Promise.reject(new Error("Graph API error 404"));
      return Promise.resolve({
        value: [sparseOccurrence("occ-1", "series-gone")],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse);
    });

    const result = await createSource(graph).syncStructured(null);
    // Still emitted with the times it does have — strictly better than losing it.
    expect(result.documents?.map((d) => d.externalId)).toEqual([k("occ-1")]);
    expect(result.documents![0]!.title).toBe("(no title)");
  });

  test("a dead token propagates instead of being cached as a broken series", async () => {
    const graph = makeMockGraph();
    graph.get.mockImplementation((path: string) => {
      if (path.startsWith("/me/calendars?")) {
        return Promise.resolve({ value: graph.calendars });
      }
      if (path.startsWith("/me/events/")) {
        // What GraphClient actually throws once its retry budget is spent —
        // not a hand-made SyncError the transport never constructs.
        return Promise.reject(new AuthError());
      }
      return Promise.resolve({
        value: [sparseOccurrence("occ-1", "series-1")],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse);
    });

    // Swallowing this would hide the failure from the collector, which decides
    // `needs-auth` from what escapes, and would cache a miss that outlives the
    // re-authorization meant to fix it.
    const error = await createSource(graph)
      .syncStructured(null)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).scope).toBe("connection");
  });

  test("a single event with no seriesMasterId never triggers a master fetch", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [makeEvent("evt-solo")],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    await createSource(graph).syncStructured(null);
    expect(graph.get.mock.calls.some((c) => String(c[0]).startsWith("/me/events/"))).toBe(false);
  });

  test("the whole inherited field set survives, not just the title", async () => {
    // Every field hydrateFromMaster copies, so dropping one from that list
    // fails here rather than silently nulling a column for every recurring
    // event in the corpus.
    const graph = makeMockGraph();
    graph.page({
      value: [
        master("series-1", {
          bodyPreview: "Bring the open questions",
          body: { contentType: "text", content: "Bring the open questions rather than answers." },
          categories: ["Design", "Recurring"],
          onlineMeeting: { joinUrl: "https://teams.example.com/meet/1" },
          webLink: "https://outlook.office.com/calendar/0/view/event?itemid=series-1",
          responseStatus: { response: "organizer" },
          iCalUId: "ical-series-1",
        }),
        sparseOccurrence("occ-1", "series-1"),
      ],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const result = await createSource(graph).syncStructured(null);
    const doc = result.documents![0]!;
    expect(doc.metadata.tags).toEqual(["Design", "Recurring"]);
    expect(doc.metadata.sourceUrl).toContain("itemid=series-1");
    expect(doc.metadata.extra?.iCalUID).toBe("ical-series-1");
    expect(doc.content).toContain("Bring the open questions");
    expect(doc.content).toContain("https://teams.example.com/meet/1");
    expect(rowsFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]!.response_status).toBe("organizer");
  });

  test("a master listed AFTER its occurrence is still found", async () => {
    // Graph guarantees no ordering within a page, which is the entire reason
    // masters are indexed in a prepass rather than as the loop reaches them.
    const graph = makeMockGraph();
    graph.page({
      value: [sparseOccurrence("occ-1", "series-1"), master("series-1")],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const result = await createSource(graph).syncStructured(null);
    expect(result.documents![0]!.title).toBe("Monday standup");
    // Found in the page, so no round-trip was needed.
    expect(graph.get.mock.calls.some((c) => String(c[0]).startsWith("/me/events/"))).toBe(false);
  });

  test("an exception overriding only its subject still inherits the rest", async () => {
    // Graph sends an edited single instance carrying its times and just the
    // changed property. Judging by the subject alone would leave this one
    // occurrence without the room, attendees and body its siblings keep.
    const graph = makeMockGraph();
    graph.page({
      value: [
        master("series-1"),
        sparseOccurrence("occ-exception", "series-1", {
          type: "exception",
          subject: "Monday standup — skipped, offsite",
        }),
      ],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const result = await createSource(graph).syncStructured(null);
    const doc = result.documents![0]!;
    expect(doc.title).toBe("Monday standup — skipped, offsite");
    expect(doc.metadata.extra?.location).toBe("Harbourview room");
    expect((doc.metadata.people ?? []).length).toBeGreaterThan(0);
  });

  test("an empty-string subject is treated as missing, not as a title", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [master("series-1"), sparseOccurrence("occ-1", "series-1", { subject: "" })],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const result = await createSource(graph).syncStructured(null);
    expect(result.documents![0]!.title).toBe("Monday standup");
  });

  test("a master seen in one page hydrates occurrences arriving in the next", async () => {
    const graph = makeMockGraph();
    graph
      .page({
        value: [master("series-1")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?page=2",
      } as CalendarDeltaResponse)
      .page({
        value: [sparseOccurrence("occ-2", "series-1")],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse);

    const source = createSource(graph);
    const first = await source.syncStructured(null);
    const second = await source.syncStructured(first.cursor);

    expect(second.documents![0]!.title).toBe("Monday standup");
    // Carried across the page boundary rather than re-fetched.
    expect(graph.get.mock.calls.some((c) => String(c[0]).startsWith("/me/events/"))).toBe(false);
  });

  test("a fresh enumeration re-reads the master, so a renamed series is picked up", async () => {
    const graph = makeMockGraph();
    graph
      .page({
        value: [master("series-1"), sparseOccurrence("occ-1", "series-1")],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse)
      .page({
        value: [
          master("series-1", { subject: "Monday standup (biweekly)" }),
          sparseOccurrence("occ-1", "series-1"),
        ],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse);

    const source = createSource(graph);
    const first = await source.syncStructured(null);
    expect(first.documents![0]!.title).toBe("Monday standup");

    // A bootstrap with no link is a fresh enumeration — the cache must not
    // outlive it, or the rename is invisible until the process restarts.
    const second = await source.syncStructured(null);
    expect(second.documents![0]!.title).toBe("Monday standup (biweekly)");
  });

  test("an incremental tick does not retract the master it re-sends", async () => {
    // The tombstone costs a stats recompute and reports a deletion whether or
    // not anything matched, and an incremental tick carries a master only when
    // the series was edited — so the cleanup belongs to enumeration.
    const graph = makeMockGraph();
    graph.page({
      value: [master("series-1"), sparseOccurrence("occ-1", "series-1")],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const result = await createSource(graph).syncStructured({
      calendarLinks: { [DEFAULT_CALENDAR.id]: DELTA },
      windowRefreshAfter: "2999-01-01T00:00:00Z",
    } as OutlookCalendarCursor);

    expect(result.deletedExternalIds).toEqual([]);
    expect(result.documents?.map((d) => d.externalId)).toEqual([k("occ-1")]);
  });
});

// ── Deleting a whole series ───────────────────────────────────────────

describe("OutlookCalendarSource — a deleted series", () => {
  const DELTA = "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d";

  function master(id: string, overrides: Partial<GraphEvent> = {}): GraphEvent {
    return makeEvent(id, { type: "seriesMaster", subject: "Monday standup", ...overrides });
  }

  test("a finished enumeration publishes the document snapshot, a partial one does not", async () => {
    // Graph announces a deleted series by tombstoning its master alone, and the
    // master is not a document — so the snapshot is the only thing that can
    // clear the occurrences left behind.
    const graph = makeMockGraph();
    graph
      .page({
        value: [makeEvent("evt-1")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?page=2",
      } as CalendarDeltaResponse)
      .page({
        value: [makeEvent("evt-2")],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse);

    const source = createSource(graph);
    const pages = await runCycle(source);
    // A partial page claiming to be a snapshot would read as "everything else
    // is gone" and delete the rest of the calendar.
    for (const partial of pages.slice(0, -1)) {
      expect(partial.hasMore).toBe(true);
      expect(partial.presentExternalIds).toBeUndefined();
    }

    const complete = pages.at(-1)!;
    expect(complete.presentExternalIds).toEqual([k("evt-1"), k("evt-2")]);
    // Documents and rows are reconciled against the same set.
    expect(writesFor(complete, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toEqual([
      k("evt-1"),
      k("evt-2"),
    ]);
  });

  test("the document-only sync surfaces the snapshot too", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [makeEvent("evt-1")],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const source = createSource(graph);
    const first = await source.sync(null);
    expect(first.presentExternalIds).toBeUndefined();
    const second = await source.sync(first.cursor);
    expect(second.presentExternalIds).toEqual([k("evt-1")]);
  });

  test("tombstoning a known master forces a re-enumeration", async () => {
    const graph = makeMockGraph();
    graph
      .page({
        value: [master("series-1"), sparseOccurrence("occ-1", "series-1")],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse)
      .page({
        value: [{ id: "series-1", "@removed": { reason: "deleted" } } as GraphEvent],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse);

    const source = createSource(graph);
    const enumeration = await runCycle(source);
    // The master was recorded, so a later tombstone for it can be recognised.
    expect((enumeration.at(-1)!.cursor as OutlookCalendarCursor).knownMasters).toEqual([
      k("series-1"),
    ]);

    const tick = await source.syncStructured(enumeration.at(-1)!.cursor);
    const cursor = tick.cursor as OutlookCalendarCursor;
    // Rolled back to a fresh enumeration, which republishes the snapshot that
    // reconciles the orphaned occurrences away. Waiting for the 30-day window
    // roll would leave them reading as meetings that still exist.
    expect(cursor.calendarLinks).toEqual({});
    expect(cursor.pendingCalendars).toBeUndefined();
    expect(tick.hasMore).toBe(true);
    expect(cursor.knownMasters).toEqual([]);
    // The branch must not claim a snapshot of a page it did not enumerate.
    expect(tick.presentExternalIds).toBeUndefined();

    // Drive the re-enumeration and confirm it publishes the set that clears
    // the orphans — the point of the whole mechanism.
    graph.page({
      value: [makeEvent("evt-survivor")],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);
    const reenumeration = await runCycle(source, cursor);
    expect(reenumeration.at(-1)!.presentExternalIds).toEqual([k("evt-survivor")]);
  });

  test("a series learned only from its occurrences is still recognised when deleted", async () => {
    // The ordinary shape for a standing meeting: the series began before the
    // window, so the enumeration never carries its master and the id can only
    // be learned from the occurrences that point at it.
    const graph = makeMockGraph();
    let eventPages = 0;
    graph.get.mockImplementation((path: string) => {
      if (path.startsWith("/me/calendars?")) {
        return Promise.resolve({ value: graph.calendars });
      }
      if (path.startsWith("/me/events/")) return Promise.resolve(master("series-old"));
      eventPages++;
      return Promise.resolve({
        value:
          eventPages === 1
            ? [sparseOccurrence("occ-1", "series-old")]
            : [{ id: "series-old", "@removed": { reason: "deleted" } } as GraphEvent],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse);
    });

    const source = createSource(graph);
    const enumeration = await runCycle(source);
    expect((enumeration.at(-1)!.cursor as OutlookCalendarCursor).knownMasters).toEqual([
      k("series-old"),
    ]);

    const tick = await source.syncStructured(enumeration.at(-1)!.cursor);
    expect((tick.cursor as OutlookCalendarCursor).calendarLinks).toEqual({});
  });

  test("a finished enumeration replaces the master set rather than growing it", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [makeEvent("evt-1")],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    // A series whose last occurrence has aged out is no longer in the window,
    // so a complete enumeration drops it — nothing else ever would.
    const pages = await runCycle(createSource(graph), {
      knownMasters: [k("series-long-gone")],
      pendingCalendars: [DEFAULT_CALENDAR.id],
      snapshotCalendars: [DEFAULT_CALENDAR.id],
      snapshot: {},
      enumeratedMasters: [],
      windowRefreshAfter: "2999-01-01T00:00:00Z",
    } as OutlookCalendarCursor);
    expect((pages.at(-1)!.cursor as OutlookCalendarCursor).knownMasters).toEqual([]);
  });

  test("the past edge of the window is fixed, so the snapshot never culls history", async () => {
    // The enumeration doubles as a whole-source snapshot. If its past edge
    // advanced with "now", each roll would drop another month of events out of
    // the snapshot while their documents stayed indexed — and the gateway
    // deletes what a snapshot omits.
    const graph = makeMockGraph();
    const source = createSource(graph);
    const first = await runCycle(source);
    const anchored = (first.at(-1)!.cursor as OutlookCalendarCursor).windowStart;
    expect(anchored).toBeDefined();

    graph.get.mockClear();
    await source.syncStructured({
      windowStart: anchored,
      windowRefreshAfter: "2999-01-01T00:00:00Z",
    } as OutlookCalendarCursor);
    const enumerate = graph.get.mock.calls.find((call) => call[0] === viewPath());
    expect(enumerate).toBeDefined();
    expect((enumerate![1] as { startDateTime: string }).startDateTime).toBe(anchored);
  });

  test("tombstoning an ordinary event does not force a re-enumeration", async () => {
    const graph = makeMockGraph();
    graph
      .page({
        value: [makeEvent("evt-1"), master("series-1")],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse)
      .page({
        value: [{ id: "evt-1", "@removed": { reason: "deleted" } } as GraphEvent],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse);

    const source = createSource(graph);
    const enumeration = await runCycle(source);
    const tick = await source.syncStructured(enumeration.at(-1)!.cursor);

    // A one-off deletion is fully expressed by its own tombstone; re-walking
    // the window for it would be a needless full enumeration on every delete.
    expect(tick.deletedExternalIds).toEqual([k("evt-1")]);
    const cursor = tick.cursor as OutlookCalendarCursor;
    expect(cursor.calendarLinks?.[DEFAULT_CALENDAR.id]).toBe(DELTA);
    expect(cursor.snapshot).toBeUndefined();
  });

  test("known masters survive an incremental tick that carries none", async () => {
    const graph = makeMockGraph();
    graph
      .page({
        value: [master("series-1")],
        "@odata.deltaLink": DELTA,
      } as CalendarDeltaResponse)
      .page({ value: [], "@odata.deltaLink": DELTA } as CalendarDeltaResponse);

    const source = createSource(graph);
    const enumeration = await runCycle(source);
    const tick = await source.syncStructured(enumeration.at(-1)!.cursor);
    // Forgetting them on a quiet tick would leave the next deletion
    // unrecognised, which is the whole failure this guards.
    expect((tick.cursor as OutlookCalendarCursor).knownMasters).toEqual([k("series-1")]);
  });
});

// ── Organizer identity ────────────────────────────────────────────────

describe("OutlookCalendarSource — the account's own events", () => {
  const DELTA = "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=d";

  /** Outlook's opaque stand-in for the account holder on their own events. */
  const OPAQUE = "outlook_ABCDEF0123456789@example.com";

  function organized(overrides: Partial<GraphEvent> = {}): GraphEvent {
    return makeEvent("evt-mine", {
      organizer: { emailAddress: { name: "Maya Reeves", address: OPAQUE } },
      attendees: [],
      ...overrides,
    });
  }

  function authorOf(result: { documents: Array<{ metadata: { people?: PersonMention[] } }> }) {
    return (result.documents[0]!.metadata.people ?? []).find((p) => p.role === "author");
  }

  test("an event the account organised is marked as the user's own", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [organized({ isOrganizer: true })],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const author = authorOf(await createSource(graph).sync(null));
    // `isSelf` resolves to the canonical self whatever aliases already exist.
    // Joining the two addresses instead would merge them only on a corpus where
    // neither is known yet — which is never true of an install that has already
    // synced this calendar.
    expect(author?.isSelf).toBe(true);
    // The alias is still recorded, so the document says what Graph said.
    expect(author?.emails).toEqual([OPAQUE]);
  });

  test("an event somebody else organised is not claimed", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        organized({
          isOrganizer: false,
          organizer: { emailAddress: { name: "Jamie Lopez", address: "jamie@example.com" } },
        }),
      ],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const author = authorOf(await createSource(graph).sync(null));
    expect(author?.isSelf).toBeUndefined();
    expect(author?.emails).toEqual(["jamie@example.com"]);
  });

  test("an absent isOrganizer is treated as somebody else's event", async () => {
    // Graph omits the flag on some payloads. Absence must not read as
    // ownership, or a sparse event would claim the account holder.
    const graph = makeMockGraph();
    graph.page({
      value: [organized({ isOrganizer: undefined })],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    expect(authorOf(await createSource(graph).sync(null))?.isSelf).toBeUndefined();
  });

  test("every occurrence of a series the account organised is marked too", async () => {
    // The master is a template and never becomes a document, so if the flag did
    // not survive hydration then EVERY document a recurring meeting produces
    // would deny that the user organised it — and recurring meetings are most
    // of a working calendar.
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("series-1", {
          type: "seriesMaster",
          isOrganizer: true,
          organizer: { emailAddress: { name: "Maya Reeves", address: OPAQUE } },
        }),
        sparseOccurrence("occ-1", "series-1"),
        sparseOccurrence("occ-2", "series-1"),
      ],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const result = await createSource(graph).sync(null);
    expect(result.documents.map((d) => d.externalId)).toEqual([k("occ-1"), k("occ-2")]);
    for (const doc of result.documents) {
      const author = (doc.metadata.people ?? []).find((p) => p.role === "author");
      expect(author?.isSelf, `${doc.externalId} should be marked self`).toBe(true);
    }
  });

  test("occurrences of somebody else's series are not claimed", async () => {
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("series-2", {
          type: "seriesMaster",
          isOrganizer: false,
          organizer: { emailAddress: { name: "Jamie Lopez", address: "jamie@example.com" } },
        }),
        sparseOccurrence("occ-1", "series-2"),
      ],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    expect(authorOf(await createSource(graph).sync(null))?.isSelf).toBeUndefined();
  });

  test("an occurrence that names its own organizer keeps it", async () => {
    // An exception the user was invited to, inside a series they own.
    const graph = makeMockGraph();
    graph.page({
      value: [
        makeEvent("series-3", { type: "seriesMaster", isOrganizer: true }),
        sparseOccurrence("occ-1", "series-3", {
          isOrganizer: false,
          organizer: { emailAddress: { name: "Jamie Lopez", address: "jamie@example.com" } },
        }),
      ],
      "@odata.deltaLink": DELTA,
    } as CalendarDeltaResponse);

    const author = authorOf(await createSource(graph).sync(null));
    expect(author?.isSelf).toBeUndefined();
    expect(author?.emails).toEqual(["jamie@example.com"]);
  });
});

// ── Availability, deep links, page size ───────────────────────────────

describe("OutlookCalendarSource — what an event says beyond its time", () => {
  let graph: MockGraph;
  beforeEach(() => {
    graph = makeMockGraph();
  });

  test("showAs is carried on both halves, because status cannot express it", async () => {
    // A free placeholder and a booked meeting are both confirmed events. Only
    // this separates them, so "how many hours was I actually in meetings" has
    // no honest answer without it.
    graph.page({
      value: [
        makeEvent("evt-busy", { showAs: "busy" }),
        makeEvent("evt-free", { showAs: "free" }),
        makeEvent("evt-away", { showAs: "oof" }),
      ],
      "@odata.deltaLink": DELTA_LINK,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));
    const rows = new Map(
      rowsFor(pages[0]!, OUTLOOK_CALENDAR_EVENTS_TABLE).map((r) => [String(r.id), r]),
    );
    expect(rows.get(k("evt-busy"))?.show_as).toBe("busy");
    expect(rows.get(k("evt-free"))?.show_as).toBe("free");
    expect(rows.get(k("evt-away"))?.show_as).toBe("oof");

    const docs = new Map(pages[0]!.documents!.map((d) => [d.externalId, d]));
    expect(docs.get(k("evt-free"))?.metadata.extra?.showAs).toBe("free");
    // Status stays the lifecycle answer — the two axes must not be conflated.
    expect(docs.get(k("evt-free"))?.metadata.extra?.status).toBe("confirmed");
  });

  test("a free block is indexed but does not become a booking on the timeline", async () => {
    // The timeline is an index of bookings, and a free block is time the
    // calendar is explicitly not claiming. It stays searchable and countable;
    // it just does not occupy the hours it names. A tentative hold does.
    graph.page({
      value: [
        makeEvent("evt-free", { showAs: "free" }),
        makeEvent("evt-held", { showAs: "tentative" }),
        makeEvent("evt-away", { showAs: "oof" }),
      ],
      "@odata.deltaLink": DELTA_LINK,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));
    const rows = new Map(
      rowsFor(pages[0]!, OUTLOOK_CALENDAR_EVENTS_TABLE).map((r) => [String(r.id), r]),
    );
    expect(rows.get(k("evt-free"))?.temporal_projection_eligible).toBe(false);
    expect(rows.get(k("evt-held"))?.temporal_projection_eligible).toBe(true);
    expect(rows.get(k("evt-away"))?.temporal_projection_eligible).toBe(true);
    // Still a document — excluded from the timeline, not from the corpus.
    expect(pages[0]!.documents!.map((d) => d.externalId)).toContain(k("evt-free"));
  });

  test("an unrecognised or absent showAs is null rather than invented", async () => {
    graph.page({
      value: [makeEvent("evt-new", { showAs: "hotDesking" }), makeEvent("evt-quiet")],
      "@odata.deltaLink": DELTA_LINK,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));
    for (const row of rowsFor(pages[0]!, OUTLOOK_CALENDAR_EVENTS_TABLE))
      expect(row.show_as).toBeNull();
  });

  test("an event carries no appUrl, so a phone opens the event rather than the app", async () => {
    // Verified on a device: `ms-outlook://` is registered, so iOS hands the URL
    // to Outlook and Outlook opens — on the inbox, whatever path or query the
    // URL carried. An appUrl would therefore trade "the event you tapped, in a
    // browser" for "the app, showing something else", which is a worse answer
    // to the tap. iOS falls back to `sourceUrl` when it is absent, the same way
    // it does for Gmail's compose-only scheme.
    graph.page({
      value: [makeEvent("evt-1")],
      "@odata.deltaLink": DELTA_LINK,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));
    const doc = pages[0]!.documents![0]!;
    expect(doc.metadata.appUrl).toBeUndefined();
    expect(doc.metadata.sourceUrl).toContain("itemid=evt-1");
  });

  test("the calendar's name reaches the document, not just its id", async () => {
    // A watch on "events on my Birthdays calendar" has nothing to match on
    // otherwise: an opaque Graph calendar id is not something anyone types.
    graph.calendars = [{ id: "cal-1", name: "Side projects" }];
    graph.page({
      value: [makeEvent("evt-1")],
      "@odata.deltaLink": DELTA_LINK,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));
    expect(pages[0]!.documents![0]!.metadata.extra?.calendarName).toBe("Side projects");
  });

  test("the delta request asks for a full page the way a change-tracked view accepts", async () => {
    // Each page costs the queue a sync() call, so a small server-side default
    // turns a year of a busy calendar into many round-trips.
    graph.page({ value: [], "@odata.deltaLink": DELTA_LINK } as CalendarDeltaResponse);
    await runCycle(createSource(graph));

    const enumerate = graph.get.mock.calls.find((call) => call[0] === viewPath());
    // The literal, not the constant that produced it: the claim is that a full
    // page is asked for, which a test reading the same constant cannot check.
    expect((enumerate![2] as Record<string, string>).Prefer).toBe("odata.maxpagesize=100");
    // Graph refuses `$top` on a change-tracked calendarView — it cannot
    // guarantee a page size there — and rejects the whole request, which this
    // source reports as an enumeration it could not complete. Asking that way
    // therefore costs every calendar its deletion detection, silently.
    expect((enumerate![1] as Record<string, string>).$top).toBeUndefined();
  });
});

// ── More than one calendar ────────────────────────────────────────────

describe("OutlookCalendarSource — every calendar on the account", () => {
  const SECOND = { id: "cal-2", name: "Side projects" };
  const DELTA_1 = "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=one";
  const DELTA_2 = "https://graph.microsoft.com/v1.0/me/calendarView/delta?token=two";

  let graph: MockGraph;
  beforeEach(() => {
    graph = makeMockGraph();
    graph.calendars = [DEFAULT_CALENDAR, SECOND];
  });

  test("enumerates each calendar in turn, one per sync call", async () => {
    graph
      .page({ value: [makeEvent("evt-a")], "@odata.deltaLink": DELTA_1 } as CalendarDeltaResponse)
      .page({ value: [makeEvent("evt-b")], "@odata.deltaLink": DELTA_2 } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));

    // One calendar-page per call: a transient Graph failure on a busy account
    // then costs one page rather than the whole cycle's progress.
    expect(pages).toHaveLength(3);
    expect(graph.get).toHaveBeenCalledWith(
      viewPath(DEFAULT_CALENDAR.id),
      expect.anything(),
      expect.anything(),
    );
    expect(graph.get).toHaveBeenCalledWith(
      viewPath(SECOND.id),
      expect.anything(),
      expect.anything(),
    );
    expect(pages[0]!.documents![0]!.externalId).toBe(k("evt-a"));
    expect(pages[1]!.documents![0]!.externalId).toBe(k("evt-b", SECOND.id));

    // Each calendar's delta link is filed against the calendar that issued it,
    // so the next cycle asks each of them for its own changes.
    const cursor = pages.at(-1)!.cursor as OutlookCalendarCursor;
    expect(cursor.calendarLinks).toEqual({ [DEFAULT_CALENDAR.id]: DELTA_1, [SECOND.id]: DELTA_2 });
  });

  test("the same event id in two calendars is two events, not one overwriting the other", async () => {
    // Graph event ids are unique within a calendar, not across them. Keying on
    // the bare id would make the second calendar's event replace the first's.
    graph
      .page({
        value: [makeEvent("shared-id", { subject: "Standup" })],
        "@odata.deltaLink": DELTA_1,
      } as CalendarDeltaResponse)
      .page({
        value: [makeEvent("shared-id", { subject: "Board review" })],
        "@odata.deltaLink": DELTA_2,
      } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));

    const ids = pages.flatMap((p) => (p.documents ?? []).map((d) => d.externalId));
    expect(ids).toEqual([k("shared-id"), k("shared-id", SECOND.id)]);
    expect(new Set(ids).size).toBe(2);
    expect(writesFor(pages.at(-1)!, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toEqual(
      [...ids].sort(),
    );
  });

  test("the snapshot spans every calendar and is published only once all of them drained", async () => {
    graph
      .page({ value: [makeEvent("evt-a")], "@odata.deltaLink": DELTA_1 } as CalendarDeltaResponse)
      .page({ value: [makeEvent("evt-b")], "@odata.deltaLink": DELTA_2 } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));

    // A snapshot published after the first calendar would name only its events
    // and the gateway would delete every event of every other calendar.
    for (const partial of pages.slice(0, -1)) {
      expect(partial.presentExternalIds).toBeUndefined();
      expect(writesFor(partial, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toBeUndefined();
    }
    const complete = pages.at(-1)!;
    expect(complete.presentExternalIds).toEqual([k("evt-a"), k("evt-b", SECOND.id)]);
    expect(writesFor(complete, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toEqual([
      k("evt-a"),
      k("evt-b", SECOND.id),
    ]);
  });

  test("a calendar the user deleted leaves the queue and takes its delta link with it", async () => {
    const cursor: OutlookCalendarCursor = {
      calendarLinks: { [DEFAULT_CALENDAR.id]: DELTA_1, [SECOND.id]: DELTA_2 },
      pendingCalendars: [DEFAULT_CALENDAR.id, SECOND.id],
      windowRefreshAfter: "2999-01-01T00:00:00Z",
    };
    graph.calendars = [DEFAULT_CALENDAR];
    graph.page({ value: [], "@odata.deltaLink": DELTA_1 } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph), cursor);

    // Following a link for a calendar that no longer exists would 404 the cycle
    // on every tick from here on.
    const after = pages.at(-1)!.cursor as OutlookCalendarCursor;
    expect(after.calendarLinks).toEqual({ [DEFAULT_CALENDAR.id]: DELTA_1 });
    expect(graph.get).not.toHaveBeenCalledWith(viewPath(SECOND.id), expect.anything());
  });

  test("a calendar added since the last cycle is enumerated by the next one", async () => {
    const source = createSource(graph);
    graph.calendars = [DEFAULT_CALENDAR];
    graph.page({
      value: [makeEvent("evt-a")],
      "@odata.deltaLink": DELTA_1,
    } as CalendarDeltaResponse);
    const first = await runCycle(source);

    // The calendar list is re-resolved every call, which is what notices one
    // added since the last cycle.
    graph.calendars = [DEFAULT_CALENDAR, SECOND];
    graph
      .page({ value: [], "@odata.deltaLink": DELTA_1 } as CalendarDeltaResponse)
      .page({ value: [makeEvent("evt-b")], "@odata.deltaLink": DELTA_2 } as CalendarDeltaResponse);
    const second = await runCycle(source, first.at(-1)!.cursor);

    expect(graph.get).toHaveBeenCalledWith(
      viewPath(SECOND.id),
      expect.anything(),
      expect.anything(),
    );
    const ids = second.flatMap((p) => (p.documents ?? []).map((d) => d.externalId));
    expect(ids).toEqual([k("evt-b", SECOND.id)]);
  });

  test("the row records which calendar the event came from", async () => {
    graph.calendars = [SECOND];
    graph.page({
      value: [makeEvent("evt-b")],
      "@odata.deltaLink": DELTA_2,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));

    const row = rowsFor(pages[0]!, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]!;
    expect(row.id).toBe(k("evt-b", SECOND.id));
    expect(row.calendar_id).toBe(SECOND.id);
    expect(row.calendar_name).toBe(SECOND.name);
    // The bare Graph id is kept alongside the namespaced key so a deep link or
    // a support question can still be traced back to the event Graph knows.
    expect(row.event_id).toBe("evt-b");
  });

  test("a cursor in the single-calendar format starts a clean cycle", async () => {
    // A cursor carrying `phase`/`link` keys its events on the bare Graph id,
    // which does not match what this source emits — resuming from it would
    // leave those documents unreferenced. A clean cycle publishes the snapshot
    // that retires them.
    graph.calendars = [DEFAULT_CALENDAR];
    graph.page({
      value: [makeEvent("evt-a")],
      "@odata.deltaLink": DELTA_1,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph), {
      phase: "incremental",
      link: DELTA_1,
    } as unknown as OutlookCalendarCursor);

    expect(graph.get).toHaveBeenCalledWith(
      viewPath(DEFAULT_CALENDAR.id),
      expect.anything(),
      expect.anything(),
    );
    expect(pages.at(-1)!.presentExternalIds).toEqual([k("evt-a")]);
  });

  test("an event on a calendar shared in from another mailbox is not claimed as the account's", async () => {
    // Graph's `isOrganizer` is defined against the calendar's owner, so on a
    // calendar belonging to someone else it names THAT person. Honouring it
    // there would attach the user's identity to another person's events.
    graph.calendars = [{ ...SECOND, owner: { name: "David Lin", address: "david@example.com" } }];
    graph.page({
      value: [
        makeEvent("evt-theirs", {
          isOrganizer: true,
          organizer: { emailAddress: { name: "David Lin", address: "david@example.com" } },
        }),
      ],
      "@odata.deltaLink": DELTA_2,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));

    const author = pages[0]!.documents![0]!.metadata.people?.find((p) => p.role === "author");
    expect(author?.emails).toEqual(["david@example.com"]);
    expect(author?.isSelf).toBeUndefined();
  });

  test("a calendar deleted while it was mid-enumeration does not replay its page under another id", async () => {
    // The resume link belongs to the calendar that issued it. Handing it to
    // whichever calendar is now at the head would key one calendar's events
    // under another's id, file its delta link against the wrong stream, and —
    // on an enumerating cycle — publish a snapshot that names none of the new
    // head's real events, deleting every one of them.
    graph
      .page({
        value: [makeEvent("evt-a1")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/cal-1-page-2",
      } as CalendarDeltaResponse)
      .page({ value: [makeEvent("evt-b1")], "@odata.deltaLink": DELTA_2 } as CalendarDeltaResponse);

    const source = createSource(graph);
    const first = await source.syncStructured(null);
    expect((first.cursor as OutlookCalendarCursor).resumeLink).toContain("cal-1-page-2");

    // The user deletes the calendar that was mid-enumeration.
    graph.calendars = [SECOND];
    const second = await source.syncStructured(first.cursor);

    expect(graph.get).not.toHaveBeenCalledWith("https://graph.microsoft.com/v1.0/cal-1-page-2");
    expect(graph.get).toHaveBeenCalledWith(
      viewPath(SECOND.id),
      expect.anything(),
      expect.anything(),
    );
    expect(second.documents?.map((d) => d.externalId)).toEqual([k("evt-b1", SECOND.id)]);
  });

  test("a queue holding a calendar the enumeration never opened with is trimmed, not walked", async () => {
    // The queue and the enumeration's partition list are born together and
    // written together, so this shape only arrives on a cursor that has been
    // tampered with or written by another build. Walking the extra calendar
    // would ask the enumeration to add ids for a partition it was not opened
    // with, which it refuses by throwing — a page that fails the same way on
    // every tick, with a cursor valid enough that no policy replaces it.
    graph.calendars = [DEFAULT_CALENDAR, SECOND];
    graph.page({
      value: [makeEvent("evt-a1")],
      "@odata.deltaLink": DELTA_1,
    } as CalendarDeltaResponse);

    const page = await createSource(graph).syncStructured({
      pendingCalendars: [DEFAULT_CALENDAR.id, SECOND.id],
      snapshotCalendars: [DEFAULT_CALENDAR.id],
      snapshot: {},
      windowStart: "2026-01-01T00:00:00.000Z",
      windowRefreshAfter: "2999-01-01T00:00:00Z",
    } as OutlookCalendarCursor);

    expect(page.documents?.map((d) => d.externalId)).toEqual([k("evt-a1")]);
    expect((page.cursor as OutlookCalendarCursor).pendingCalendars).toEqual([]);
  });

  test("a calendar deleted mid-enumeration is an empty partition, not an unread one", async () => {
    // The account listing says it holds nothing, so covering it with no ids is
    // the honest reading — and it is what keeps the cycle able to vouch for the
    // whole account. Left merely uncovered it would be an unaccounted partition,
    // the account-wide form would be withheld, and nothing would re-enumerate
    // until the window rolls: its events would read as meetings that still
    // exist for up to a month.
    graph
      .page({
        value: [makeEvent("evt-a1")],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/cal-1-page-2",
      } as CalendarDeltaResponse)
      .page({ value: [makeEvent("evt-b1")], "@odata.deltaLink": DELTA_2 } as CalendarDeltaResponse);

    const source = createSource(graph);
    const first = await source.syncStructured(null);
    expect((first.cursor as OutlookCalendarCursor).resumeLink).toContain("cal-1-page-2");

    graph.calendars = [SECOND];
    let page = await source.syncStructured(first.cursor);
    for (let i = 0; i < 5 && page.hasMore; i++) {
      page = await source.syncStructured(page.cursor);
    }

    // The account-wide form still comes out: every calendar that exists was
    // read, and the one that does not holds nothing.
    expect(page.presentExternalIds).toEqual([k("evt-b1", SECOND.id)]);
    expect(page.presentClaims).toBeUndefined();
  });

  test("a calendar that leaves the account triggers the cycle that retires its events", async () => {
    // Dropping the link stops the source reading a calendar that is gone, but
    // its events stay indexed and searchable. Only a whole-source snapshot
    // retires them, so the source starts the cycle that produces one rather
    // than waiting up to a window roll.
    graph.calendars = [DEFAULT_CALENDAR];
    const result = await createSource(graph).syncStructured({
      calendarLinks: { [DEFAULT_CALENDAR.id]: DELTA_1, [SECOND.id]: DELTA_2 },
      windowRefreshAfter: "2999-01-01T00:00:00Z",
    } as OutlookCalendarCursor);

    const cursor = result.cursor as OutlookCalendarCursor;
    expect(result.hasMore).toBe(true);
    expect(cursor.calendarLinks).toEqual({});
    expect(cursor.pendingCalendars).toBeUndefined();
    // Not a snapshot of a page it never read.
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("an empty calendar list withholds the snapshot rather than reconciling to nothing", async () => {
    // The gateway deletes every document and row a snapshot omits, so an empty
    // one reads as "this account has no events". An empty `/me/calendars` is
    // far likelier to be a transient read than an account that genuinely lost
    // every calendar.
    graph.calendars = [];
    const result = await createSource(graph).syncStructured(null);

    expect(result.hasMore).toBe(false);
    expect(writesFor(result, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toBeUndefined();
    expect(result.presentExternalIds).toBeUndefined();
  });

  test("follows @odata.nextLink through a paged /me/calendars", async () => {
    // Graph pages Outlook collections at ten by default, and the source asks
    // for no larger page — so any account past that only reveals its later
    // calendars through the nextLink.
    graph.pageCalendars(1);
    graph
      .page({ value: [makeEvent("evt-a")], "@odata.deltaLink": DELTA_1 } as CalendarDeltaResponse)
      .page({ value: [makeEvent("evt-b")], "@odata.deltaLink": DELTA_2 } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));

    expect(graph.get).toHaveBeenCalledWith(
      viewPath(SECOND.id),
      expect.anything(),
      expect.anything(),
    );
    expect(writesFor(pages.at(-1)!, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]?.presentIds).toEqual([
      k("evt-a"),
      k("evt-b", SECOND.id),
    ]);
  });

  test("the account's own default calendar is claimed even when Graph names its mailbox differently", async () => {
    // The account id is the sign-in name — on a work account the UPN, where
    // Graph reports the mailbox's primary SMTP address. Those differ in many
    // tenants, and comparing them alone would deny the user their own calendar
    // and attribute their events to the opaque organizer alias.
    graph.calendars = [
      {
        ...DEFAULT_CALENDAR,
        isDefaultCalendar: true,
        owner: { name: "Account", address: "a.user@mail.example.com" },
      },
    ];
    graph.page({
      value: [makeEvent("evt-mine", { isOrganizer: true })],
      "@odata.deltaLink": DELTA_1,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));
    const author = pages[0]!.documents![0]!.metadata.people?.find((p) => p.role === "author");
    expect(author?.isSelf).toBe(true);
  });

  test("a shared calendar's RSVP is not recorded as the account's", async () => {
    // Graph reports `responseStatus` against the calendar's owner, like
    // `isOrganizer`. Recording it under a column that means "the account's
    // RSVP" would answer "how many meetings did I decline" with somebody
    // else's answer.
    graph.calendars = [{ ...SECOND, owner: { name: "David Lin", address: "david@example.com" } }];
    graph.page({
      value: [makeEvent("evt-theirs", { responseStatus: { response: "declined" } })],
      "@odata.deltaLink": DELTA_2,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));
    expect(rowsFor(pages[0]!, OUTLOOK_CALENDAR_EVENTS_TABLE)[0]!.response_status).toBeNull();
  });

  test("an event the account organized on its own calendar is still marked as the account's", async () => {
    graph.calendars = [
      { ...DEFAULT_CALENDAR, owner: { name: "Account", address: "USER@example.com" } },
    ];
    graph.page({
      value: [makeEvent("evt-mine", { isOrganizer: true })],
      "@odata.deltaLink": DELTA_1,
    } as CalendarDeltaResponse);

    const pages = await runCycle(createSource(graph));

    const author = pages[0]!.documents![0]!.metadata.people?.find((p) => p.role === "author");
    expect(author?.isSelf).toBe(true);
  });
});
