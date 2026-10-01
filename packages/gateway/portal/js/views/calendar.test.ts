// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — the portal ships plain browser JavaScript.

import { render } from "preact";
import { parseHTML } from "linkedom";
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
} from "./calendar.js";

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
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const { document, window } = parseHTML("<html><body><main></main></body></html>");
  const host = document.querySelector("main");
  Object.assign(globalThis, { document, window });
  try {
    render(vnode, host);
    return host.textContent;
  } finally {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
}

describe("Calendar", () => {
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
    expect(
      entryDayKeys({
        ...projection,
        id: "ta_1",
        origin: "annotation",
        kind: "expiry",
        precision: "range",
        start: day("2026-01-01"),
        endExclusive: day("2027-01-01"),
        annotation: { documentIds: ["doc-2"] },
      }),
    ).toEqual(["2026-12-31"]);
  });

  it("places all-day facts by the requested timezone across offsets and DST", () => {
    expect(dayKeyInTimeZone("2026-07-14T10:00:00.000Z", "Pacific/Kiritimati")).toBe("2026-07-15");
    expect(dayKeyInTimeZone("2026-07-15T07:00:00.000Z", "America/Los_Angeles")).toBe("2026-07-15");

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
    expect(
      calendarDateLabel(
        {
          ...projection,
          precision: "range",
          start: "2026-03-08T05:00:00.000Z",
          endExclusive: "2026-03-10T04:00:00.000Z",
        },
        "America/New_York",
      ),
    ).toBe("2026-03-08 – 2026-03-09");
  });

  it("only classifies semantic coarse ranges as banners", () => {
    const paddedOrdinaryDay = {
      ...projection,
      start: day("2026-07-14"),
      endExclusive: day("2026-07-15"),
    };
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
    expect(
      evidenceDocumentIds({
        ...projection,
        origin: "annotation",
        annotation: { documentIds: ["doc-2", "doc-2", "doc-3"] },
      }),
    ).toEqual(["doc-2", "doc-3"]);
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
    expect(text).not.toMatch(/\b(ask|talk|fix)\b/i);

    const annotationText = renderedText(
      CalendarEntryRow({
        entry: {
          ...projection,
          id: "ta_2",
          origin: "annotation",
          annotation: { documentIds: ["doc-2"], revision: 2 },
        },
        showDate: true,
        timeZone: "Pacific/Kiritimati",
        onOpen: () => {},
      }),
    );
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

  it("labels a date mention as one and links the document that wrote it", () => {
    const mention = {
      ...projection,
      id: "dm_0000000000000001",
      origin: "mention",
      kind: "deadline",
      label: "Renewal notice — “by 15 July”",
      projection: undefined,
      mention: {
        documentId: "doc-9",
        sourceId: "fictional-mail:primary",
        text: "by 15 July",
        relative: false,
      },
    };
    expect(evidenceDocumentIds(mention)).toEqual(["doc-9"]);
    const text = renderedText(CalendarEntryRow({ entry: mention, onOpen: () => {} }));
    expect(text).toContain("Date mention");
    expect(text).not.toContain("Agent");
    expect(text).toContain("▤ 1");
  });

  it("banners a long mention span while keeping short source spans on their days", () => {
    const mention = (id, documentId, start, end) => ({
      ...projection,
      id,
      origin: "mention",
      precision: "range",
      allDay: true,
      start: day(start),
      endExclusive: day(end),
      projection: undefined,
      mention: { documentId, text: "phrase", relative: false },
    });
    expect(isSemanticBanner(mention("dm_1", "doc-1", "2026-09-01", "2026-10-01"))).toBe(true);
    expect(isSemanticBanner(mention("dm_2", "doc-1", "2026-09-01", "2026-09-04"))).toBe(false);
    // A projection's month-long span stays on its days, as before.
    expect(
      isSemanticBanner({
        ...projection,
        precision: "range",
        start: day("2026-09-01"),
        endExclusive: day("2026-10-01"),
      }),
    ).toBe(false);
  });

  it("stops after its page budget and says the view is capped, keeping the first coverage", async () => {
    let page = 0;
    const result = await fetchCalendarPages(
      { from: 1, to: 2, timeZone: "UTC" },
      {
        maxPages: 2,
        fetchPage: async () => {
          page += 1;
          return {
            items: [{ ...projection, id: `tp_${page}` }],
            nextCursor: `next-${page}`,
            coverage: { mentions: { pendingDocuments: 0, unworthyHidden: true } },
          };
        },
      },
    );
    expect(page).toBe(2);
    expect(result.capped).toBe(true);
    expect(result.items.map((entry) => entry.id)).toEqual(["tp_1", "tp_2"]);
    expect(result.coverage.mentions.unworthyHidden).toBe(true);
  });

  it("fails loudly on a cursor cycle instead of silently returning a partial calendar", async () => {
    await expect(
      fetchCalendarPages(
        { from: 1, to: 2, timeZone: "UTC" },
        {
          fetchPage: async () => ({ items: [], nextCursor: "same" }),
        },
      ),
    ).rejects.toThrow("cursor cycle");
  });
});
