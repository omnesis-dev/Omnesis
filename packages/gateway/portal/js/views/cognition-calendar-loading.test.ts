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
  getCognitionCalendarWindow: mocks.getWindow,
  getDocumentSummariesBulk: mocks.getDocuments,
  getCognitionCalendarAnnotation: mocks.getAnnotation,
  getStatus: mocks.getStatus,
}));
vi.mock("../lib/router.js", () => ({ navigate: mocks.navigate, replaceRoute: mocks.replaceRoute }));
vi.mock("../lib/format.js", () => ({
  sourceIconUrl: (sourceId) => sourceId ? `/icons/${encodeURIComponent(sourceId)}.svg` : null,
}));

import { CalendarTab } from "./cognition-calendar.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flushEffects() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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
      : { projection: { sourceId: "fictional-calendar:account", slot: "event" } }),
  };
}

describe("Cognition Calendar loading and addressability", () => {
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

  it("ignores a stale period response after a newer request wins", async () => {
    const first = deferred();
    const second = deferred();
    mocks.getWindow.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    await act(async () => { render(h(CalendarTab), host); });
    await act(async () => { host.querySelectorAll(".calendar-zoom button")[1].click(); });
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
      .mockResolvedValueOnce({ items: [entry("tp_week", "Previous week entry")], nowMs: Date.now() })
      .mockImplementationOnce(() => upcoming.promise);
    await act(async () => { render(h(CalendarTab), host); });
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
      await act(async () => { host.querySelectorAll(".calendar-zoom button")[3].click(); });
      await flushEffects();
    } finally {
      options.diffed = previousDiffed;
    }

    expect(frames).not.toContainEqual(expect.objectContaining({
      activeZoom: "Upcoming",
      text: expect.stringContaining("Previous week entry"),
    }));
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

    await act(async () => { render(h(CalendarTab), host); });
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
    await act(async () => { render(h(CalendarTab, { developer: true }), host); });
    await flushEffects();

    expect(host.querySelector(".dev-annotate-inline")).toBeNull();
    const rows = [...host.querySelectorAll(".calendar-entry")];
    await act(async () => { rows.find((row) => row.textContent.includes("Agent note")).click(); });
    expect(mocks.navigate).toHaveBeenLastCalledWith("/portal/debug/cognition/calendar/ta_1");
    expect(host.querySelector(".modal-panel .dev-annotate-inline")).not.toBeNull();

    await act(async () => { host.querySelector(".modal-close").click(); });
    expect(mocks.replaceRoute).toHaveBeenCalledWith("/portal/debug/cognition/calendar");
    mocks.navigate.mockClear();
    await act(async () => { rows.find((row) => row.textContent.includes("Source fact")).click(); });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(host.querySelector(".modal-panel .dev-annotate-inline")).toBeNull();
  });

  it("loads an arbitrary routed annotation and clears it when browser Back clears the route", async () => {
    mocks.getWindow.mockResolvedValue({ items: [], nowMs: Date.now() });
    mocks.getAnnotation.mockResolvedValue({ item: entry("ta_old", "Archived agent note", "annotation") });

    await act(async () => { render(h(CalendarTab, { selectedId: "ta_old" }), host); });
    await flushEffects();
    expect(mocks.getAnnotation).toHaveBeenCalledWith("ta_old", expect.any(String));
    expect(host.querySelector(".modal-panel")?.textContent).toContain("Archived agent note");

    await act(async () => { render(h(CalendarTab, { selectedId: null }), host); });
    await flushEffects();
    expect(host.querySelector(".modal-panel")).toBeNull();
  });

  it("exposes the selected zoom state to assistive technology", async () => {
    mocks.getWindow.mockResolvedValue({ items: [], nowMs: Date.now() });
    await act(async () => { render(h(CalendarTab), host); });
    await flushEffects();
    const buttons = [...host.querySelectorAll(".calendar-zoom button")];
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "true", "false", "false", "false",
    ]);
    await act(async () => { buttons[1].click(); });
    expect(buttons.map((button) => button.getAttribute("aria-pressed"))).toEqual([
      "false", "true", "false", "false",
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
    await act(async () => { render(h(CalendarTab), host); });
    await flushEffects();
    await act(async () => { host.querySelector(".calendar-entry").click(); });

    expect(host.querySelector(".calendar-evidence").textContent).toContain("Renewal terms");
    expect(host.querySelector(".calendar-evidence img").getAttribute("src")).toBe(
      "/icons/fictional-mail%3Aaccount.svg",
    );
    expect(host.querySelector(".modal-panel").textContent).toContain("Agent note");
    expect(host.querySelector(".modal-panel").textContent).not.toMatch(/ask|talk|fix/i);
  });
});
