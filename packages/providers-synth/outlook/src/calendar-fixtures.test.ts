// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { resolvePerson } from "@omnesis/providers-synth-common";
import {
  OUTLOOK_CALENDAR_EVENTS_TABLE,
  OutlookCalendarSource,
  type CalendarDeltaResponse,
  type CalendarGraphClientLike,
  type GraphEvent,
  type OutlookCalendarCursor,
} from "@omnesis/provider-outlook";
import { deletionsFor, rowsFor, tablesWritten, writesFor } from "@omnesis/source-sdk/testing";
import {
  CALENDAR_UPDATE_OVERRIDE,
  calendarIdFor,
  loadCalendarEvents,
  resetCalendarFixtureCache,
  syntheticCalendarGraph,
  type CalendarEventEntry,
} from "./calendar-fixtures.js";
import type { MappedProjectionField } from "@omnesis/source-sdk";

/**
 * Direct, gateway-free coverage of the synthetic Outlook-calendar Graph backend.
 * The full sync path through a real gateway is proved by the synth-pipeline /
 * golden-corpus E2Es; this asserts the fake transport's contract (bootstrap
 * enumeration, cast-resolved organizer/attendees, empty incremental tick) in
 * isolation so the E2E's preconditions are pinned without booting a gateway.
 */

/** The account's calendars: the default one, and the fixture's second. */
const MAIN = calendarIdFor();
const PERSONAL = calendarIdFor("Personal");

const DELTA_LINK = `https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=synth-outlook-calendar-delta&calendar=${MAIN}`;

/** The `calendarView` path for one calendar. */
function viewPath(calendarId = MAIN): string {
  return `/me/calendars/${calendarId}/calendarView/delta`;
}

/**
 * The key an event is stored under. Graph event ids are unique within a
 * calendar and not across them, so everything downstream is namespaced.
 */
function key(eventId: string, calendarId = MAIN): string {
  return `${calendarId}:${eventId}`;
}

/** The calendar an entry lives on, and the ids its documents take. */
function idsFor(entry: CalendarEventEntry): string[] {
  const calendarId = calendarIdFor(entry.calendar);
  return entry.weeklyOccurrences
    ? Array.from({ length: entry.weeklyOccurrences }, (_, i) =>
        key(`${entry.externalId}-occ-${i + 1}`, calendarId),
      )
    : [key(entry.externalId, calendarId)];
}

let events: CalendarEventEntry[];

/** The real Outlook calendar source, fed by a fixture-backed Graph transport. */
function calendarSource(graph: CalendarGraphClientLike): OutlookCalendarSource {
  return new OutlookCalendarSource(
    async () => "synthetic-token",
    "outlook-calendar:john.smith@acme.example",
    "microsoft:john.smith@acme.example",
    undefined,
    { graph },
  );
}

/**
 * A Graph transport serving one bootstrap page of hand-authored events, on a
 * single calendar — enough to isolate normalization from the calendar queue.
 */
function graphServing(value: GraphEvent[]): CalendarGraphClientLike {
  return {
    async get<T>(path: string): Promise<T> {
      if (path.startsWith("/me/calendars?")) {
        return { value: [{ id: MAIN, name: "Calendar" }] } as T;
      }
      return { value, "@odata.deltaLink": DELTA_LINK } as CalendarDeltaResponse as T;
    },
  };
}

/**
 * Drain a whole sync cycle — one call per calendar-page plus the one that finds
 * the queue empty — and merge the pages, so a test can assert on what the cycle
 * produced without restating how many calendars the fixture spreads over.
 */
async function drain(
  source: OutlookCalendarSource,
  cursor: OutlookCalendarCursor | null = null,
): Promise<{
  documents: Array<{ externalId: string; title: string; content: string }>;
  records: Record<string, unknown>[];
  deletedExternalIds: string[];
  deletedIds: string[];
  presentIds?: string[];
  /** Absent when the terminal page wrote nothing — a walk that found no work. */
  tableName?: string;
  cursor: OutlookCalendarCursor;
}> {
  const pages = [];
  let next: OutlookCalendarCursor | null = cursor;
  for (let i = 0; i < 12; i++) {
    const page = await source.syncStructured(next);
    pages.push(page);
    if (!page.hasMore) break;
    next = page.cursor;
  }
  const last = pages.at(-1)!;
  // Outlook's calendar writes one table, so the walk collapses to one view of
  // it; the snapshot and the table name come from the terminal page, which is
  // the only one entitled to claim a complete read.
  const lastWrite = writesFor(last, OUTLOOK_CALENDAR_EVENTS_TABLE).at(-1);
  return {
    documents: pages.flatMap((p) => p.documents ?? []),
    records: pages.flatMap((p) => rowsFor(p, OUTLOOK_CALENDAR_EVENTS_TABLE)),
    deletedExternalIds: pages.flatMap((p) => p.deletedExternalIds ?? []),
    deletedIds: pages.flatMap((p) => deletionsFor(p, OUTLOOK_CALENDAR_EVENTS_TABLE)),
    presentIds: lastWrite?.presentIds,
    tableName: tablesWritten(last).at(-1),
    cursor: last.cursor,
  };
}

/**
 * Resolve a projection field against one emitted row exactly as the projector
 * does — a constant passes through, a mapped field reads its column and falls
 * back to the declared default. Keeps the assertions below tied to the spec the
 * source actually ships rather than to a restated copy of it.
 */
function resolveProjectionField<T extends string>(
  field: MappedProjectionField<T, string>,
  row: Record<string, unknown>,
): T {
  if (typeof field === "string") return field;
  const raw = row[field.from];
  if (raw === null || raw === undefined) return field.default;
  return field.map[String(raw)] ?? field.default;
}

beforeAll(() => {
  // The fixtures load from the active universe; e2e-minimal carries the
  // outlook-calendar corpus this twin was authored against.
  process.env.OMNESIS_SYNTH_UNIVERSE = "e2e-minimal";
  resetCalendarFixtureCache();
  events = loadCalendarEvents();
});

describe("syntheticCalendarGraph", () => {
  test("the fixture corpus loads with the expected events", () => {
    expect(events.map((e) => e.externalId).sort()).toEqual([
      "synth-outlook-cal-001",
      "synth-outlook-cal-002",
      "synth-outlook-cal-003",
    ]);
    // Exactly one entry is recurring; the twin expands it into a master plus
    // sparse occurrences, which is the shape the hydration path exists for.
    // It reuses one of the three rather than adding a fourth, because
    // e2e-minimal caps a source at three entries to keep the fast lane fast.
    expect(events.filter((e) => e.weeklyOccurrences).map((e) => e.externalId)).toEqual([
      "synth-outlook-cal-003",
    ]);
    // The corpus spreads over two calendars, which is what gives the E2E a
    // second delta stream to visit rather than one it can assume away.
    expect(events.map((e) => calendarIdFor(e.calendar))).toEqual([MAIN, PERSONAL, MAIN]);
  });

  test("/me/calendars reports every calendar the fixture uses, default first", async () => {
    const graph = syntheticCalendarGraph(events);
    const list = await graph.get<{ value: Array<{ id: string; name: string }> }>(
      "/me/calendars?$select=id,name,owner",
    );
    expect(list.value).toEqual([
      { id: MAIN, name: "Calendar" },
      { id: PERSONAL, name: "Personal" },
    ]);
  });

  test("each calendar's view returns its own events plus a deltaLink", async () => {
    const graph = syntheticCalendarGraph(events);
    const page = await graph.get<CalendarDeltaResponse>(viewPath(), {
      startDateTime: "2025-01-01T00:00:00Z",
      endDateTime: "2027-01-01T00:00:00Z",
    });
    expect(page.value.map((e) => e.id).sort()).toEqual([
      "synth-outlook-cal-001",
      "synth-outlook-cal-003",
      "synth-outlook-cal-003-occ-1",
      "synth-outlook-cal-003-occ-2",
      "synth-outlook-cal-003-occ-3",
    ]);
    expect(page["@odata.deltaLink"]).toBeDefined();
    // One one-off event, one series master, and three occurrences of it. A view
    // that also carried the other calendar's event would let a source that
    // never visits the second calendar still look complete.
    const byType = page.value.reduce<Record<string, number>>((acc, e) => {
      acc[e.type ?? "?"] = (acc[e.type ?? "?"] ?? 0) + 1;
      return acc;
    }, {});
    expect(byType).toEqual({ singleInstance: 1, seriesMaster: 1, occurrence: 3 });

    const second = await graph.get<CalendarDeltaResponse>(viewPath(PERSONAL));
    expect(second.value.map((e) => e.id)).toEqual(["synth-outlook-cal-002"]);

    // The occurrences are served the way Graph serves them — a time range and
    // a pointer to the master, and nothing else. A twin that populated them
    // would let an empty-document regression pass as success.
    const occ = page.value.find((e) => e.id === "synth-outlook-cal-003-occ-1")!;
    expect(occ.seriesMasterId).toBe("synth-outlook-cal-003");
    expect(occ.subject).toBeUndefined();
    expect(occ.location).toBeUndefined();
    expect(occ.attendees).toBeUndefined();
    const first = page.value.find((e) => e.id === "synth-outlook-cal-001");
    expect(first?.subject).toBe("Vendor evaluation sync");
    expect(first?.location?.displayName).toBe("Mercury room");
    expect(first?.iCalUId).toBe("synth-ocal-uid-001");
  });

  test("organizer and attendees resolve to cast identities", async () => {
    const graph = syntheticCalendarGraph(events);
    const page = await graph.get<CalendarDeltaResponse>(viewPath());
    const ev = page.value.find((e) => e.id === "synth-outlook-cal-001");
    // The organizer/attendee emails resolve from the cast (the `self` / `p_jane`
    // refs in the fixture), not literals — so the assertion tracks the active
    // universe's cast rather than restating raw addresses here.
    expect(ev?.organizer?.emailAddress?.address).toBe(resolvePerson("self").emails[0]);
    const attendeeEmails = (ev?.attendees ?? []).map((a) => a.emailAddress?.address);
    expect(attendeeEmails).toContain(resolvePerson("p_jane").emails[0]);
  });

  test("an incremental tick (deltaLink) is empty by default", async () => {
    const graph = syntheticCalendarGraph(events);
    const page = await graph.get<CalendarDeltaResponse>(DELTA_LINK);
    expect(page.value).toHaveLength(0);
    expect(page["@odata.deltaLink"]).toBeDefined();
  });

  test("the real hybrid normalizer emits projection-eligible bound rows", async () => {
    const source = calendarSource(syntheticCalendarGraph(events));
    const projection = source.analyticsSchemas[0]?.temporalProjection;
    expect(projection).toMatchObject({
      slot: "calendar",
      start: "$semanticTime",
      end: "end_time",
      label: "title",
      modality: "scheduled",
      allDay: "all_day",
      eligibility: "temporal_projection_eligible",
    });
    if (!projection) throw new Error("the calendar table must declare a temporal projection");

    const result = await drain(source);
    expect(result.tableName).toBe("outlook_calendar_events");
    // One document per one-off event, plus one per occurrence. The series
    // master is a template rather than an event, so it contributes none.
    const expectedCount = events.reduce((n, e) => n + (e.weeklyOccurrences ?? 1), 0);
    expect(result.records).toHaveLength(expectedCount);
    expect(result.documents).toHaveLength(expectedCount);
    expect(result.presentIds?.slice().sort()).toEqual(events.flatMap(idsFor).sort());
    for (const [index, row] of result.records.entries()) {
      expect(row.id).toBe(result.documents[index]?.externalId);
      expect(row.temporal_projection_eligible).toBe(true);
      expect(row.status).toBe("confirmed");
      // Every fixture event is a timed booking, so the kind mapping resolves
      // through its default rather than its all-day branch.
      expect(row.all_day).toBe(false);
      expect(resolveProjectionField(projection.kind, row)).toBe("appointment");
      expect(resolveProjectionField(projection.status ?? "active", row)).toBe("active");
    }
  });

  test("an all-day entry projects the other side of the kind mapping", async () => {
    const source = calendarSource(
      graphServing([
        {
          id: "synth-outlook-cal-allday",
          iCalUId: "synth-ocal-uid-allday",
          subject: "Office closed",
          body: { contentType: "text", content: "Building maintenance — no access." },
          start: { dateTime: "2026-03-17T00:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-03-18T00:00:00.0000000", timeZone: "UTC" },
          isAllDay: true,
          isCancelled: false,
          type: "singleInstance",
          createdDateTime: "2026-02-01T09:00:00Z",
          lastModifiedDateTime: "2026-02-01T09:00:00Z",
        },
      ]),
    );
    const projection = source.analyticsSchemas[0]?.temporalProjection;
    if (!projection) throw new Error("the calendar table must declare a temporal projection");

    const result = await drain(source);
    expect(result.records).toHaveLength(1);
    const row = result.records[0]!;
    expect(row.all_day).toBe(true);
    expect(row.temporal_projection_eligible).toBe(true);
    expect(resolveProjectionField(projection.kind, row)).toBe("event");
  });

  test("a cancelled entry is retracted rather than projected", async () => {
    const source = calendarSource(
      graphServing([
        {
          id: "synth-outlook-cal-cancelled",
          iCalUId: "synth-ocal-uid-cancelled",
          subject: "Budget review",
          start: { dateTime: "2026-03-20T14:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-03-20T15:00:00.0000000", timeZone: "UTC" },
          isAllDay: false,
          isCancelled: true,
          type: "singleInstance",
          createdDateTime: "2026-02-02T09:00:00Z",
          lastModifiedDateTime: "2026-02-10T09:00:00Z",
        },
      ]),
    );
    // A cancelled event deletes both halves of the pair, so no row — and hence
    // no lingering projection — survives it.
    const result = await drain(source);
    expect(result.records).toHaveLength(0);
    expect(result.documents).toHaveLength(0);
    expect(result.deletedIds).toEqual([key("synth-outlook-cal-cancelled")]);
    expect(result.deletedExternalIds).toEqual([key("synth-outlook-cal-cancelled")]);
  });
});

// ── Mutation switches ─────────────────────────────────────────────────

/**
 * The env switches an E2E flips between sync ticks. Asserting them here pins
 * the fake's contract without a gateway, so a broken switch surfaces as a fast
 * unit failure rather than a puzzling E2E.
 */
describe("synthetic Outlook calendar — mutation switches", () => {
  const SWITCHES = [
    "OMNESIS_OUTLOOK_CALENDAR_SYNTH_UPDATE",
    "OMNESIS_OUTLOOK_CALENDAR_SYNTH_CANCEL",
    "OMNESIS_OUTLOOK_CALENDAR_SYNTH_REMOVE",
    "OMNESIS_OUTLOOK_CALENDAR_SYNTH_EXPIRE_DELTA",
  ];

  afterEach(() => {
    for (const key of SWITCHES) delete process.env[key];
  });

  test("the universe carries the three events these phases address", () => {
    // The phases below index events[0..2] by position; fail here with a
    // readable message rather than on a property of undefined.
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  /** Drain a bootstrap, then a full incremental cycle off the delta links. */
  async function incrementalTick(
    graph: CalendarGraphClientLike,
  ): Promise<Awaited<ReturnType<typeof drain>>> {
    const source = calendarSource(graph);
    const bootstrap = await drain(source);
    return drain(source, bootstrap.cursor);
  }

  test("an unswitched incremental tick is empty — no re-emission", async () => {
    const result = await incrementalTick(syntheticCalendarGraph(events));
    expect(result.documents).toEqual([]);
    expect(result.records).toEqual([]);
    expect(result.deletedExternalIds).toEqual([]);
  });

  test("UPDATE re-emits exactly that event with edited content under the same id", async () => {
    const target = events[0]!.externalId;
    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_UPDATE = target;

    const result = await incrementalTick(syntheticCalendarGraph(events));
    expect(result.documents.map((d) => d.externalId)).toEqual([key(target)]);
    expect(result.documents[0]?.title).toBe(CALENDAR_UPDATE_OVERRIDE.subject);
    expect(result.documents[0]?.content).toContain(CALENDAR_UPDATE_OVERRIDE.body);
    expect(result.records[0]?.location).toBe(CALENDAR_UPDATE_OVERRIDE.location);
    expect(result.records[0]?.start_time).toBe(
      new Date(CALENDAR_UPDATE_OVERRIDE.startTime).toISOString(),
    );
  });

  test("CANCEL tombstones both halves of the pair, on the calendar that holds it", async () => {
    // This entry lives on the second calendar, so the tick has to have reached
    // it — and the tombstone has to carry that calendar's key or it retracts
    // nothing.
    const target = events[1]!;
    expect(calendarIdFor(target.calendar)).toBe(PERSONAL);
    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_CANCEL = target.externalId;

    const result = await incrementalTick(syntheticCalendarGraph(events));
    expect(result.deletedExternalIds).toEqual([key(target.externalId, PERSONAL)]);
    expect(result.deletedIds).toEqual([key(target.externalId, PERSONAL)]);
    expect(result.documents).toEqual([]);
  });

  test("REMOVE tombstones the master alone — occurrences are never announced", async () => {
    // Observed against live Graph: deleting a series says the master is gone
    // and nothing about its instances. Pinning that here is what keeps the
    // source honest, since the master is not a document and this tombstone
    // therefore removes nothing on its own.
    const target = events[2]!.externalId;
    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_REMOVE = target;

    const result = await incrementalTick(syntheticCalendarGraph(events));
    expect(result.deletedExternalIds).toContain(key(target));

    // The master is never a document, so asserting its absence proves nothing.
    // What the tombstone has to clear is its OCCURRENCES, and only the
    // re-enumeration's snapshot can do that.
    const occurrences = idsFor(events[2]!);
    expect(occurrences.length).toBeGreaterThan(0);
    const fresh = await drain(calendarSource(syntheticCalendarGraph(events)));
    for (const id of occurrences) {
      expect(fresh.documents.map((d) => d.externalId)).not.toContain(id);
      expect(fresh.presentIds).not.toContain(id);
    }
  });

  test("a master is reachable through the calendar-scoped route as well as the mailbox one", async () => {
    // `/me/events/{id}` addresses the account's own mailbox, so it cannot find
    // a master on a calendar shared in from another one. The source falls back
    // to the calendar-scoped route, and the twin has to answer both or the
    // fallback is never exercised.
    const graph = syntheticCalendarGraph(events);
    const series = events[2]!;
    const calendarId = calendarIdFor(series.calendar);

    const scoped = await graph.get<GraphEvent>(
      `/me/calendars/${calendarId}/events/${series.externalId}`,
    );
    expect(scoped.id).toBe(series.externalId);
    expect(scoped.subject).toBe(series.subject);

    // And a lookup against a calendar that does not hold it is a 404, not
    // another calendar's master — Graph event ids are unique per calendar.
    await expect(
      graph.get<GraphEvent>(`/me/calendars/${PERSONAL}/events/${series.externalId}`),
    ).rejects.toThrow(/404/);
  });

  test("EXPIRE_DELTA 410s the deltaLink, and the re-bootstrap recovers the calendar", async () => {
    const graph = syntheticCalendarGraph(events);
    const source = calendarSource(graph);
    const bootstrap = await drain(source);

    process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_EXPIRE_DELTA = "1";
    const expired = await source.syncStructured(bootstrap.cursor);
    // The source swallows the 410 rather than throwing: it drops that
    // calendar's stale link, which is what sends it back to a full walk.
    expect(expired.documents).toEqual([]);
    expect((expired.cursor as OutlookCalendarCursor).calendarLinks?.[MAIN]).toBeUndefined();

    delete process.env.OMNESIS_OUTLOOK_CALENDAR_SYNTH_EXPIRE_DELTA;
    const recovered = await drain(source, expired.cursor as OutlookCalendarCursor);
    // Only the calendar whose token expired is re-walked. The other one keeps
    // its link and answers with a quiet tick, so its documents are not churned
    // through the gateway for a failure that was never theirs.
    const expectedIds = events.filter((e) => !e.calendar).flatMap(idsFor);
    expect(recovered.documents.map((d) => d.externalId).sort()).toEqual(expectedIds.sort());
  });
});
