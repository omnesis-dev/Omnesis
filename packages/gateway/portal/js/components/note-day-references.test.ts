// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal component in a lightweight DOM.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getProvenance: vi.fn(), navigate: vi.fn() }));
vi.mock("../api.js", () => ({ getNotesProvenance: mocks.getProvenance }));
vi.mock("../lib/router.js", () => ({ navigate: mocks.navigate }));
import { NoteDayReferences } from "./note-day-references.js";

const day = "2026-09-11";
const mention = { id: "dm_example/1", label: "next Tuesday", start: "2026-09-15T12:00:00Z" };
const annotation = {
  id: "ta_example",
  label: "Submit the entry form",
  start: "2026-09-15T12:00:00Z",
};
const loop = { id: "loop_example", title: "Send the registration", status: "open" };
const empty = { day, mentions: [], annotations: [], loops: [] };
let host;
let originalDocument;
let originalWindow;

async function mount(props = {}) {
  await act(async () => {
    render(h(NoteDayReferences, { day, revision: "first", ...props }), host);
  });
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  originalDocument = globalThis.document;
  originalWindow = globalThis.window;
  const parsed = parseHTML("<html><body><div id='host'></div></body></html>");
  Object.assign(globalThis, { document: parsed.document, window: parsed.window });
  host = parsed.document.querySelector("#host");
  mocks.getProvenance.mockResolvedValue(empty);
});

afterEach(() => {
  render(null, host);
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  vi.useRealTimers();
});

describe("daily note references", () => {
  test("separates deterministic mentions, Brain annotations and loops with direct links", async () => {
    mocks.getProvenance.mockResolvedValue({
      day,
      mentions: [mention],
      annotations: [annotation],
      loops: [loop],
    });
    await mount({ experimental: true });
    expect(host.textContent).toContain("this day's combined notes");
    expect(
      Array.from(host.querySelectorAll(".note-reference-heading")).map((el) => el.textContent),
    ).toEqual(["Time mentions", "Brain time annotations", "Open loops"]);
    const links = Array.from(host.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/portal/debug/calendar/dm_example%2F1",
      "/portal/debug/calendar/ta_example",
      "/portal/debug/cognition/loops/loop_example",
    ]);
    await act(async () => {
      links[0].click();
    });
    expect(mocks.navigate).toHaveBeenCalledWith("/portal/debug/calendar/dm_example%2F1");
    expect(mocks.getProvenance).toHaveBeenCalledWith(day, expect.any(String));
  });

  test("shows deterministic mentions with experimental mode off and hides Brain discovery", async () => {
    mocks.getProvenance.mockResolvedValue({
      day,
      mentions: [mention],
      annotations: [annotation],
      loops: [loop],
    });
    await mount();
    expect(host.querySelectorAll("a")).toHaveLength(1);
    expect(host.textContent).toContain("next Tuesday");
    expect(host.textContent).not.toContain("Brain");
    expect(host.textContent).not.toContain("Open loops");
  });

  test("polls new references in place, avoids overlapping reads and pauses while hidden", async () => {
    vi.useFakeTimers();
    await mount();
    expect(host.textContent).toContain("No linked time index entries yet");
    let resolve;
    mocks.getProvenance.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(mocks.getProvenance).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolve({ ...empty, mentions: [mention] });
    });
    expect(host.textContent).toContain("next Tuesday");
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new window.Event("visibilitychange"));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(mocks.getProvenance).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => {
      document.dispatchEvent(new window.Event("visibilitychange"));
    });
    expect(mocks.getProvenance).toHaveBeenCalledTimes(3);
  });

  test("an edit or day change ignores the old in-flight reference response", async () => {
    let resolve;
    mocks.getProvenance.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await mount();
    await mount({ day: "2026-09-12", revision: "edited" });
    expect(host.textContent).toContain("No linked time index entries yet");
    await act(async () => {
      resolve({ ...empty, mentions: [mention] });
    });
    expect(host.textContent).not.toContain("next Tuesday");
    expect(mocks.getProvenance).toHaveBeenLastCalledWith("2026-09-12", expect.any(String));
  });

  test("a failed reference lookup offers its own retry and never claims an empty result", async () => {
    mocks.getProvenance.mockRejectedValueOnce(new Error("unavailable"));
    await mount();
    expect(host.textContent).toContain("Couldn't load references");
    expect(host.textContent).not.toContain("No linked");
    mocks.getProvenance.mockResolvedValueOnce({ ...empty, mentions: [mention] });
    await act(async () => {
      host.querySelector("button").click();
    });
    expect(host.textContent).toContain("next Tuesday");
    expect(host.textContent).not.toContain("Couldn't load references");
  });
});
