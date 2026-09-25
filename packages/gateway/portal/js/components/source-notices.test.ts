// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal component from vitest.
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  SourceNoticeIcons,
  noticeGroups,
  noticesForDevice,
  noticesLabel,
  popoverPlacement,
} from "./source-notices.js";

const info = {
  kind: "coverage-unknown",
  severity: "info",
  title: "History from before May 2026 may be incomplete",
};
const warning = { kind: "sync-issue", severity: "warning", title: "Two rows were skipped." };
const error = { kind: "error", severity: "error", title: "The last sync failed", detail: "boom" };

describe("noticesForDevice", () => {
  test("a single-device source's notices belong to the device that reported them", () => {
    const status = { state: "synced", deviceId: "dev-a", notices: [info] };
    expect(noticesForDevice(status, "dev-a")).toEqual([info]);
    expect(noticesForDevice(status, "dev-b")).toEqual([]);
    expect(noticesForDevice({ state: "synced", notices: [info] }, "dev-a")).toEqual([info]);
    expect(noticesForDevice(null, "dev-a")).toEqual([]);
    expect(noticesForDevice({ state: "synced" }, "dev-a")).toEqual([]);
  });

  test("with members, a device sees only its own, and an unlisted device sees nothing", () => {
    const status = {
      state: "synced",
      members: [
        { deviceId: "dev-a", notices: [info] },
        { deviceId: "dev-b", notices: [warning] },
      ],
    };
    expect(noticesForDevice(status, "dev-a")).toEqual([info]);
    expect(noticesForDevice(status, "dev-b")).toEqual([warning]);
    expect(noticesForDevice(status, "dev-c")).toEqual([]);
  });

  test("a chip standing for the whole source shows every member's notices once", () => {
    const otherError = { ...error, detail: "another cause" };
    const status = {
      state: "synced",
      members: [
        { deviceId: "dev-a", notices: [info, error] },
        { deviceId: "dev-b", notices: [info, otherError] },
      ],
    };
    // Same wording is one notice; the same title with a different cause is two.
    expect(noticesForDevice(status, null)).toEqual([info, error, otherError]);
  });
});

describe("noticeGroups and labels", () => {
  test("one group per severity present, most severe first, counted", () => {
    expect(noticeGroups([info, warning, info, error])).toEqual([
      { severity: "error", count: 1 },
      { severity: "warning", count: 1 },
      { severity: "info", count: 2 },
    ]);
    expect(noticeGroups([])).toEqual([]);
  });

  test("an unknown severity is shown as a warning, never dropped", () => {
    expect(noticeGroups([{ ...warning, severity: "critical" }])).toEqual([
      { severity: "warning", count: 1 },
    ]);
  });

  test("the label counts every group and names the device", () => {
    expect(noticesLabel([warning, warning], "studio-desk")).toBe("2 warnings for studio-desk");
    expect(noticesLabel([info], null)).toBe("1 note");
    expect(noticesLabel([error, warning, info, info], "studio-desk")).toBe(
      "1 problem, 1 warning and 2 notes for studio-desk",
    );
  });
});

describe("popoverPlacement", () => {
  const viewport = { width: 1200, height: 800 };
  const rect = (top: number, left = 100) => ({ top, bottom: top + 20, left, right: left + 30 });

  test("opens below when there is room, capped to the room it has", () => {
    const p = popoverPlacement(rect(100), viewport);
    expect(p.top).toBe(126);
    expect(p.maxHeight).toBe(800 - 120 - 6 - 12);
  });

  test("opens above near the bottom of the viewport", () => {
    const p = popoverPlacement(rect(700), viewport);
    expect(p.top).toBeUndefined();
    expect(p.bottom).toBe(800 - 700 + 6);
    expect(p.maxHeight).toBe(700 - 6 - 12);
  });

  test("never runs past the right edge", () => {
    const p = popoverPlacement(rect(100, 1150), viewport);
    expect(p.left + p.width).toBeLessThanOrEqual(1200 - 12);
  });
});

describe("SourceNoticeIcons", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let originalNode: typeof globalThis.Node | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    originalNode = globalThis.Node;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(parsed.window, { innerWidth: 1200, innerHeight: 800 });
    Object.assign(globalThis, {
      document: parsed.document,
      window: parsed.window,
      Node: parsed.window.Node,
    });
    host = parsed.document.querySelector("#root");
  });

  afterEach(() => {
    render(null, host);
    for (const [key, value] of [
      ["document", originalDocument],
      ["window", originalWindow],
      ["Node", originalNode],
    ] as const) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });

  const mount = async (notices) => {
    await act(async () => {
      render(h(SourceNoticeIcons, { notices, deviceName: "studio-desk" }), host);
    });
  };
  const trigger = () => host.querySelector(".source-notice-trigger");
  const popover = () => host.querySelector(".source-notice-popover");

  test("renders nothing when the device has nothing to say", async () => {
    await mount([]);
    expect(host.innerHTML).toBe("");
  });

  test("one button carries a glyph per severity and opens the notes", async () => {
    await mount([error, info]);
    expect(host.querySelectorAll(".source-notice-trigger")).toHaveLength(1);
    expect(host.querySelectorAll(".source-notice-icon")).toHaveLength(2);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-label")).toBe("1 problem and 1 note for studio-desk");

    await act(async () => trigger().click());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(popover().id);
    const titles = [...host.querySelectorAll(".source-notice-entry-title")].map((n) => n.textContent);
    expect(titles).toEqual(["The last sync failed", info.title]);
    expect(host.querySelector(".source-notice-entry-detail").textContent).toBe("boom");
  });

  test("Escape closes the notes", async () => {
    await mount([warning]);
    await act(async () => trigger().click());
    expect(popover()).not.toBeNull();
    await act(async () => {
      const event = new window.Event("keydown");
      Object.assign(event, { key: "Escape" });
      document.dispatchEvent(event);
    });
    expect(popover()).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  test("a refresh that empties the list closes the notes for good", async () => {
    await mount([warning]);
    await act(async () => trigger().click());
    await mount([]);
    expect(host.innerHTML).toBe("");
    await mount([warning]);
    expect(popover()).toBeNull();
  });
});
