// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — the portal ships plain browser JavaScript.

import { describe, expect, it } from "vitest";
import {
  CALENDAR_KINDS,
  CalendarEntryRow,
  calendarDateLabel,
  dayKeyInTimeZone,
  entryDayKeys,
  evidenceDocumentIds,
  evidenceSourceId,
  fetchCalendarEvidence,
  fetchCalendarPages,
  isSemanticBanner,
  overlapsVisibleDays,
  visibleCalendarDays,
} from "./cognition-calendar.js";

const day = (value) => `${value}T00:00:00.000Z`;

const projection = {
  id: "tp_1",
  origin: "projection",
  start: day("2026-07-15"),
  endExclusive: day("2026-07-16"),
  precision: "day",
  allDay: true,
  label: "Project review",
  kind: "calendar_event",
  status: "active",
  projection: { documentId: "doc-1", sourceId: "fictional-calendar:account", slot: "event" },
};

function renderedText(vnode) {
  if (vnode == null || typeof vnode === "boolean") return "";
  if (Array.isArray(vnode)) return vnode.map(renderedText).join("");
  if (typeof vnode === "string" || typeof vnode === "number") return String(vnode);
  if (typeof vnode.type === "function") return renderedText(vnode.type(vnode.props ?? {}));
  return renderedText(vnode.props?.children);
}

describe("Cognition Calendar", () => {
  it("uses a Monday-first week and a complete six-week month grid", () => {
    const anchor = new Date(2026, 6, 15);
    const week = visibleCalendarDays("week", anchor);
    expect(week).toHaveLength(7);
    expect(week[0].getDay()).toBe(1);
    const month = visibleCalendarDays("month", anchor);
    expect(month).toHaveLength(42);
    expect(month[0].getDay()).toBe(1);
  });

  it("places a wide expiry window on its endpoint instead of every covered day", () => {
    expect(entryDayKeys({
      ...projection,
      id: "ta_1",
      origin: "annotation",
      kind: "expiry",
      precision: "range",
      start: day("2026-01-01"),
      endExclusive: day("2027-01-01"),
      annotation: { documentIds: ["doc-2"] },
    })).toEqual(["2026-12-31"]);
  });

  it("places all-day facts by the requested timezone across offsets and DST", () => {
    expect(dayKeyInTimeZone("2026-07-14T10:00:00.000Z", "Pacific/Kiritimati")).toBe(
      "2026-07-15",
    );
    expect(dayKeyInTimeZone("2026-07-15T07:00:00.000Z", "America/Los_Angeles")).toBe(
      "2026-07-15",
    );

    const springForwardDay = {
      ...projection,
      start: "2026-03-08T05:00:00.000Z",
      endExclusive: "2026-03-09T04:00:00.000Z",
    };
    expect(entryDayKeys(springForwardDay, null, "America/New_York")).toEqual(["2026-03-08"]);

    const fallBackDay = {
      ...projection,
      start: "2026-11-01T04:00:00.000Z",
      endExclusive: "2026-11-02T05:00:00.000Z",
    };
    expect(entryDayKeys(fallBackDay, null, "America/New_York")).toEqual(["2026-11-01"]);
    expect(isSemanticBanner(fallBackDay)).toBe(false);
    expect(calendarDateLabel({
      ...projection,
      precision: "range",
      start: "2026-03-08T05:00:00.000Z",
      endExclusive: "2026-03-10T04:00:00.000Z",
    }, "America/New_York")).toBe("2026-03-08 – 2026-03-09");
  });

  it("only classifies semantic coarse ranges as banners", () => {
    const paddedOrdinaryDay = { ...projection, start: day("2026-07-14"), endExclusive: day("2026-07-15") };
    expect(isSemanticBanner(paddedOrdinaryDay)).toBe(false);
    expect(entryDayKeys(paddedOrdinaryDay, new Set(["2026-07-15"]), "UTC")).toEqual([]);

    const ambientRange = {
      ...projection,
      precision: "range",
      start: day("2026-01-01"),
      endExclusive: day("2026-04-01"),
      kind: "event",
    };
    expect(isSemanticBanner(ambientRange)).toBe(true);
    expect(overlapsVisibleDays(ambientRange, new Set(["2026-02-01"]), "UTC")).toBe(true);
    expect(overlapsVisibleDays(ambientRange, new Set(["2026-04-02"]), "UTC")).toBe(false);
  });

  it("collects evidence from both provenance shapes without duplicates", () => {
    expect(evidenceDocumentIds(projection)).toEqual(["doc-1"]);
    expect(evidenceDocumentIds({
      ...projection,
      origin: "annotation",
      annotation: { documentIds: ["doc-2", "doc-2", "doc-3"] },
    })).toEqual(["doc-2", "doc-3"]);
    expect(evidenceSourceId({ source_id: "fictional-calendar:account" })).toBe(
      "fictional-calendar:account",
    );
  });

  it("renders distinct kind and provenance labels with an evidence count", () => {
    const vnode = CalendarEntryRow({
      entry: projection,
      documents: { "doc-1": { id: "doc-1", title: "Project agenda" } },
      onOpen: () => {},
    });
    const text = renderedText(vnode);
    expect(CALENDAR_KINDS.deadline.color).not.toBe(CALENDAR_KINDS.event.color);
    expect(text).toContain("Calendar");
    expect(text).toContain("Source");
    expect(text).toContain("Project review");
    expect(text).toContain("▤ 1");
    expect(text).not.toMatch(/ask|talk|fix/i);

    const annotationText = renderedText(CalendarEntryRow({
      entry: {
        ...projection,
        id: "ta_2",
        origin: "annotation",
        annotation: { documentIds: ["doc-2"], revision: 2 },
      },
      showDate: true,
      timeZone: "Pacific/Kiritimati",
      onOpen: () => {},
    }));
    expect(annotationText).toContain("Agent");
    expect(annotationText).toContain("2026-07-15");
  });

  it("deduplicates paginated entries and hydrates each evidence id once", async () => {
    const queries = [];
    const hydrated = [];
    const result = await fetchCalendarPages(
      { from: 1, to: 2, timeZone: "UTC" },
      {
        fetchPage: async (query) => {
          queries.push(query);
          return query.cursor
            ? {
                nowMs: 2,
                items: [
                  {
                    ...projection,
                    annotation: { revision: 2, documentIds: ["doc-1"] },
                    origin: "annotation",
                  },
                  { ...projection, id: "tp_2", projection: { documentId: "doc-2" } },
                ],
              }
            : { nowMs: 1, items: [projection], nextCursor: "next-1" };
        },
      },
    );
    expect(queries.map((query) => query.cursor)).toEqual([undefined, "next-1"]);
    expect(result.items.map((entry) => entry.id)).toEqual(["tp_1", "tp_2"]);
    expect(result.items[0].annotation.revision).toBe(2);
    await fetchCalendarEvidence(result.items, {
      fetchDocuments: async (ids) => {
        hydrated.push(...ids);
        return { docs: {} };
      },
    });
    expect(hydrated).toEqual(["doc-1", "doc-2"]);
  });

  it("fails loudly on a cursor cycle instead of silently returning a partial calendar", async () => {
    await expect(fetchCalendarPages(
      { from: 1, to: 2, timeZone: "UTC" },
      {
        fetchPage: async () => ({ items: [], nextCursor: "same" }),
      },
    )).rejects.toThrow("cursor cycle");
  });
});
