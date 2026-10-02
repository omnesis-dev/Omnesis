// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal component in a lightweight DOM.

import { h, options, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWindow: vi.fn(),
  getDocuments: vi.fn(async () => ({ docs: {} })),
  getAnnotation: vi.fn(),
  getStatus: vi.fn(async () => ({ brain: { active: true, visible: true } })),
  navigate: vi.fn(),
  replaceRoute: vi.fn(),
}));

vi.mock("../api.js", () => ({
  getCalendarWindow: mocks.getWindow,
  getDocumentSummariesBulk: mocks.getDocuments,
  getCalendarItem: mocks.getAnnotation,
  getStatus: mocks.getStatus,
}));
vi.mock("../lib/router.js", () => ({ navigate: mocks.navigate, replaceRoute: mocks.replaceRoute }));
vi.mock("../lib/format.js", () => ({
  sourceIconUrl: (sourceId) => (sourceId ? `/icons/${encodeURIComponent(sourceId)}.svg` : null),
}));

import { CalendarTab } from "./calendar.js";
import { DaySection, CalendarEntryRow } from "./calendar-agenda.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushEffects() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function entry(id, label, origin = "projection") {
  const now = new Date();
  return {
    id,
    origin,
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    endExclusive: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    precision: "month",
    allDay: true,
    label,
    kind: "event",
    status: "active",
    ...(origin === "annotation"
      ? { annotation: { documentIds: [], revision: 1 } }
      : origin === "mention"
        ? { mention: { documentId: "notes-document", text: label } }
        : { projection: { sourceId: "fictional-calendar:account", slot: "event" } }),
  };
}

describe("Calendar loading and addressability", () => {
  let host;
  let originalDocument;
  let originalWindow;

  beforeEach(() => {
    vi.clearAllMocks();
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root");
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });

  it("shows activities and visits in an always-visible category", async () => {
    const day = new Date(2026, 9, 15);
    await act(async () => {
      render(h(DaySection, {
        day, today: "2026-10-15", timeZone: "UTC", documents: {},
        entries: [
          { ...entry("activity", "Practice session", "annotation"), kind: "episode" },
          { ...entry("visit", "Studio visit"), kind: "visit" },
        ],
      }), host);
    });
    const group = host.querySelector(".calendar-entry-group");
    expect(group.querySelector("h3").textContent).toBe("Activities & visits");
    expect(group.querySelectorAll(".calendar-entry")).toHaveLength(2);
    expect(group.closest("details")).toBeNull();
    expect(host.querySelector(".calendar-activity-group")).toBeNull();
  });

  it("opens a whole entry once", async () => {
    const onOpen = vi.fn();
    const value = entry("source-click", "Workshop planning");
    await act(async () => {
      render(h(CalendarEntryRow, { entry: value, onOpen }), host);
    });
    for (const selector of [".calendar-item", ".calendar-entry"]) {
      await act(async () => { host.querySelector(selector).dispatchEvent(new window.Event("click", { bubbles: true })); });
    }
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenLastCalledWith(value);
  });

  it("ignores a stale period response after a newer request wins", async () => {
    const first = deferred();
    const second = deferred();
    mocks.getWindow
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    await act(async () => {
      render(h(CalendarTab), host);
    });
    await act(async () => {
      host.querySelectorAll(".calendar-zoom button")[1].click();
    });
    await flushEffects();

    await act(async () => {
      second.resolve({ items: [entry("tp_new", "Newer period")], nowMs: Date.now() });
      await second.promise;
    });
    await flushEffects();
    expect(host.textContent).toContain("Newer period");

    await act(async () => {
      first.resolve({ items: [entry("tp_old", "Stale period")], nowMs: Date.now() });
      await first.promise;
    });
    await flushEffects();
    expect(host.textContent).toContain("Newer period");
    expect(host.textContent).not.toContain("Stale period");
  });

  it("never commits rows from the previous query under a newly selected zoom", async () => {
    const upcoming = deferred();
    mocks.getWindow
      .mockResolvedValueOnce({
        items: [entry("tp_week", "Previous week entry")],
        nowMs: Date.now(),
      })
      .mockImplementationOnce(() => upcoming.promise);
    await act(async () => {
      render(h(CalendarTab), host);
    });
    await flushEffects();

    const frames = [];
    const previousDiffed = options.diffed;
    options.diffed = (vnode) => {
      previousDiffed?.(vnode);
      if (vnode.type === CalendarTab) {
        frames.push({
          activeZoom: host.querySelector('.calendar-zoom button[aria-pressed="true"]')?.textContent,
          text: host.textContent,
        });
      }
    };
    try {
      await act(async () => {
        host.querySelectorAll(".calendar-zoom button")[3].click();
      });
      await flushEffects();
    } finally {
      options.diffed = previousDiffed;
    }

    expect(frames).not.toContainEqual(
      expect.objectContaining({
        activeZoom: "Upcoming",
        text: expect.stringContaining("Previous week entry"),
      }),
    );
    expect(host.textContent).toContain("Loading calendar…");
    expect(host.textContent).not.toContain("Previous week entry");

    await act(async () => {
      upcoming.resolve({ items: [entry("tp_upcoming", "Upcoming entry")], nowMs: Date.now() });
      await upcoming.promise;
    });
    await flushEffects();
    expect(host.textContent).toContain("Upcoming entry");
    expect(mocks.getWindow).toHaveBeenCalledTimes(2);
  });

  it("renders temporal entries before evidence summaries finish", async () => {
    const summaries = deferred();
    const item = entry("tp_fast", "Visible immediately");
    item.projection.documentId = "doc-slow";
    mocks.getWindow.mockResolvedValue({ items: [item], nowMs: Date.now() });
    mocks.getDocuments.mockReturnValue(summaries.promise);

    await act(async () => {
      render(h(CalendarTab), host);
    });
    await flushEffects();
    expect(host.textContent).toContain("Visible immediately");
    expect(host.textContent).not.toContain("Loading calendar…");

    await act(async () => {
      summaries.resolve({ docs: {} });
      await summaries.promise;
    });
  });

  it("offers annotation only in an agent note detail modal and never for projections", async () => {
    mocks.getWindow.mockResolvedValue({
      items: [entry("ta_1", "Agent note", "annotation"), entry("tp_1", "Source fact")],
      nowMs: Date.now(),
    });
    await act(async () => {
      render(h(CalendarTab, { developer: true }), host);
    });
    await flushEffects();

    expect(host.querySelector(".dev-annotate-inline")).toBeNull();
    const rows = [...host.querySelectorAll(".calendar-entry")];
    await act(async () => {
      rows.find((row) => row.textContent.includes("Agent note")).click();
    });
    expect(mocks.navigate).toHaveBeenLastCalledWith("/portal/debug/calendar/ta_1");
    expect(host.querySelector(".modal-panel .dev-annotate-inline")).not.toBeNull();

    await act(async () => {
      host.querySelector(".modal-close").click();
    });
    expect(mocks.replaceRoute).toHaveBeenCalledWith("/portal/debug/calendar");
    mocks.navigate.mockClear();
    await act(async () => {
      rows.find((row) => row.textContent.includes("Source fact")).click();
    });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(host.querySelector(".modal-panel .dev-annotate-inline")).toBeNull();
  });

  it("loads an arbitrary routed annotation and clears it when browser Back clears the route", async () => {
    mocks.getWindow.mockResolvedValue({ items: [], nowMs: Date.now() });
    mocks.getAnnotation.mockResolvedValue({
      item: entry("ta_old", "Archived agent note", "annotation"),
    });

    await act(async () => {
      render(h(CalendarTab, { selectedId: "ta_old" }), host);
    });
    await flushEffects();
    expect(mocks.getAnnotation).toHaveBeenCalledWith("ta_old", expect.any(String));
    expect(host.querySelector(".modal-panel")?.textContent).toContain("Archived agent note");

    await act(async () => {
      render(h(CalendarTab, { selectedId: null }), host);
    });
    await flushEffects();
    expect(host.querySelector(".modal-panel")).toBeNull();
  });

  it("loads a routed deterministic mention outside the visible period and clears it on Back", async () => {
    mocks.getWindow.mockResolvedValue({ items: [], nowMs: Date.now() });
    mocks.getAnnotation.mockResolvedValue({ item: entry("dm_old", "September date", "mention") });
    await act(async () => { render(h(CalendarTab, { selectedId: "dm_old" }), host); });
    await flushEffects();
    expect(mocks.getAnnotation).toHaveBeenCalledWith("dm_old", expect.any(String));
    expect(host.querySelector(".modal-panel")?.textContent).toContain("Date mention");
    expect(host.querySelector(".modal-panel")?.textContent).toContain("September date");
    await act(async () => { render(h(CalendarTab, { selectedId: null }), host); });
    await flushEffects();
    expect(host.querySelector(".modal-panel")).toBeNull();
  });

  it("makes mentions in the visible calendar directly addressable and opens their local detail", async () => {
    const mention = entry("dm_visible", "Visible date", "mention");
    mocks.getWindow.mockResolvedValue({ items: [mention], nowMs: Date.now() });
    await act(async () => { render(h(CalendarTab), host); });
    await flushEffects();
    await act(async () => { host.querySelector(".calendar-entry").click(); });
    expect(mocks.navigate).toHaveBeenCalledWith("/portal/debug/calendar/dm_visible");
    await act(async () => { render(h(CalendarTab, { selectedId: "dm_visible" }), host); });
    await flushEffects();
    expect(host.querySelector(".modal-panel")?.textContent).toContain("Visible date");
    expect(mocks.getAnnotation).not.toHaveBeenCalled();
    await act(async () => { host.querySelector(".modal-close").click(); });
    expect(mocks.replaceRoute).toHaveBeenCalledWith("/portal/debug/calendar");
  });

  it("exposes the selected zoom state to assistive technology", async () => {
    mocks.getWindow.mockResolvedValue({ items: [], nowMs: Date.now() });
    await act(async () => {
      render(h(CalendarTab), host);
    });
    await flushEffects();
    const buttons = [...host.querySelectorAll(".calendar-zoom button")];
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    await act(async () => {
      buttons[1].click();
    });
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
  });

  it("renders hydrated evidence with its source icon and no talkback controls", async () => {
    const note = entry("ta_evidence", "Renewal note", "annotation");
    note.annotation.documentIds = ["doc-1"];
    mocks.getWindow.mockResolvedValue({ items: [note], nowMs: Date.now() });
    mocks.getDocuments.mockResolvedValue({
      docs: {
        "doc-1": {
          id: "doc-1",
          title: "Renewal terms",
          source_id: "fictional-mail:account",
        },
      },
    });
    await act(async () => {
      render(h(CalendarTab), host);
    });
    await flushEffects();
    await act(async () => {
      host.querySelector(".calendar-entry").click();
    });

    expect(host.querySelector(".calendar-evidence").textContent).toContain("Renewal terms");
    expect(host.querySelector(".calendar-evidence img").getAttribute("src")).toBe(
      "/icons/fictional-mail%3Aaccount.svg",
    );
    expect(host.querySelector(".modal-panel").textContent).toContain("Agent interpretation");
    expect(host.querySelector(".modal-panel").textContent).not.toMatch(/ask|talk|fix/i);
  });
  it("collapses mentions by document while keeping counts and possible deadlines visible", async () => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
    const phrase = (id, kind, text) => ({
      ...entry(id, "Registration dates"),
      start,
      endExclusive: end,
      precision: "day",
      kind,
      origin: "mention",
      projection: undefined,
      mention: { documentId: "doc-registration", text, relative: false },
    });
    mocks.getWindow.mockResolvedValue({
      items: [phrase("dm-a", "event", "15 October"), phrase("dm-b", "deadline", "by 16 October")],
      nowMs: Date.now(),
    });
    mocks.getDocuments.mockResolvedValue({
      docs: { "doc-registration": { title: "Registration dates", sourceId: "fictional-mail:account" } },
    });
    await act(async () => {
      render(h(CalendarTab), host);
    });
    await flushEffects();
    const section = host.querySelector(".calendar-mentions");
    expect(section.hasAttribute("open")).toBe(false);
    expect(section.querySelector("summary").textContent).toContain("2");
    expect(section.querySelector("summary").textContent).toContain("1 possible deadline");
    expect(section.querySelectorAll(".calendar-mention-document")).toHaveLength(1);
    const title = section.querySelector(".calendar-mention-document h4");
    expect(title.firstElementChild.tagName).toBe("IMG");
    expect(title.firstElementChild.getAttribute("src")).toBe("/icons/fictional-mail%3Aaccount.svg");
    expect(title.lastElementChild.textContent).toBe("Registration dates");
    expect(section.querySelectorAll(".calendar-entry")).toHaveLength(2);
    expect(section.querySelectorAll(".calendar-entry img")).toHaveLength(0);
    expect(section.querySelectorAll('[title="Linked supporting documents"]')).toHaveLength(0);
    expect(section.querySelectorAll(".calendar-entry-meta")).toHaveLength(0);
    expect(host.querySelector(".calendar-day-counts")).toBeNull();
    await act(async () => {
      host.querySelectorAll(".calendar-origin-filters button")[3].click();
    });
    await flushEffects();
    expect(mocks.getWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ origins: "mention" }),
    );
    expect(host.querySelector(".calendar-mentions").hasAttribute("open")).toBe(true);
  });

  it("fetches origin filters without painting stale results or filtered empty-state text", async () => {
    const pending = deferred();
    mocks.getWindow
      .mockResolvedValueOnce({ items: [entry("all-entry", "All origin entry")], nowMs: Date.now() })
      .mockImplementationOnce(() => pending.promise);
    await act(async () => {
      render(h(CalendarTab), host);
    });
    await flushEffects();
    expect(host.querySelector(".calendar-due-filter")).toBeNull();
    const mentionFilter = [...host.querySelectorAll(".calendar-origin-filters button")].find(
      (button) => button.textContent.trim() === "Mentions",
    );
    await act(async () => {
      mentionFilter.click();
    });
    await flushEffects();
    expect(mocks.getWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ origins: "mention" }),
    );
    expect(host.textContent).not.toContain("All origin entry");
    await act(async () => {
      pending.resolve({ items: [], nowMs: Date.now() });
      await pending.promise;
    });
    await flushEffects();
    expect(host.textContent).not.toContain("No entries match these filters.");
    expect(host.querySelector(".calendar-day-empty")).toBeNull();
  });

  it("uses native hover help on adjacent origin and kind pills without custom popups", async () => {
    mocks.getWindow.mockResolvedValue({ items: [entry("tp-help", "Source record")], nowMs: Date.now() });
    await act(async () => { render(h(CalendarTab), host); });
    await flushEffects();
    const pair = host.querySelector(".calendar-entry-pills");
    expect(pair.children[0].className).toContain("calendar-origin-pill");
    expect(pair.children[1].className).toBe("calendar-kind");
    expect(pair.children[0].getAttribute("title")).toBe("Taken from a structured date field supplied by this source");
    expect(pair.children[1].getAttribute("title")).toBeTruthy();
    expect(pair.children[0].tagName).toBe("SPAN");
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("does not attach stale supporting quotes to a different opened interpretation", async () => {
    const first = deferred();
    const second = deferred();
    mocks.getWindow.mockResolvedValue({
      items: [
        entry("ta-a", "First interpretation", "annotation"),
        entry("ta-b", "Second interpretation", "annotation"),
      ],
      nowMs: Date.now(),
    });
    mocks.getAnnotation
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    await act(async () => {
      render(h(CalendarTab), host);
    });
    await flushEffects();
    const rows = [...host.querySelectorAll(".calendar-entry")];
    await act(async () => {
      rows.find((row) => row.textContent.includes("First interpretation")).click();
    });
    await flushEffects();
    await act(async () => {
      host.querySelector(".modal-close").click();
    });
    await act(async () => {
      rows.find((row) => row.textContent.includes("Second interpretation")).click();
    });
    await flushEffects();
    await act(async () => {
      second.resolve({ evidence: [] });
      await second.promise;
    });
    await flushEffects();
    await act(async () => {
      first.resolve({ evidence: [{ documentId: "doc-a", quote: "Stale passage" }] });
      await first.promise;
    });
    await flushEffects();
    expect(host.querySelector(".modal-panel").textContent).toContain("Second interpretation");
    expect(host.querySelector(".modal-panel").textContent).not.toContain("Stale passage");
  });
});
