// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-nocheck — exercises the plain-JS portal renderer from vitest.
import { h, render } from "preact";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskUsageStat, diskUsageReadout } from "./index-hero.js";

describe("the on-disk stat", () => {
  let host: HTMLElement;
  let originalDocument: typeof globalThis.document | undefined;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalDocument = globalThis.document;
    originalWindow = globalThis.window;
    const parsed = parseHTML("<html><body><main id='root'></main></body></html>");
    Object.assign(globalThis, { document: parsed.document, window: parsed.window });
    host = parsed.document.querySelector("#root") as unknown as HTMLElement;
  });

  afterEach(() => {
    render(null, host);
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
  });

  it("shows the total and one breakdown row per store, then the total row", () => {
    const readout = diskUsageReadout({
      dbSizeBytes: 1024 * 1024,
      diskUsage: {
        totalBytes: 4 * 1024 * 1024,
        stores: [
          { id: "documents", label: "Main database", bytes: 1024 * 1024 },
          { id: "index", label: "Search index", bytes: 3 * 1024 * 1024 },
        ],
      },
    });
    render(h(DiskUsageStat, { readout }), host);

    const stat = host.querySelector(".overview-disk");
    expect(stat.querySelector("strong").textContent).toBe("4 MB");
    const popover = stat.querySelector(".overview-disk-popover");
    expect(stat.getAttribute("tabindex")).toBe("0");
    expect(stat.getAttribute("aria-describedby")).toBe(popover.getAttribute("id"));
    const rows = [...popover.querySelectorAll(".overview-disk-row")].map((row) => [
      row.querySelector(".overview-disk-label").textContent,
      row.querySelector(".overview-disk-value").textContent,
    ]);
    expect(rows).toEqual([
      ["Main database", "1 MB"],
      ["Search index", "3 MB"],
      ["Total", "4 MB"],
    ]);
    const widths = [...popover.querySelectorAll(".overview-disk-bar > span")].map((bar) =>
      bar.getAttribute("style"),
    );
    expect(widths).toEqual(["width: 25%", "width: 75%"]);
  });

  it("falls back to a plain, non-focusable stat with no breakdown", () => {
    render(h(DiskUsageStat, { readout: diskUsageReadout({ dbSizeBytes: 1024 * 1024 }) }), host);

    const stat = host.querySelector(".overview-stat");
    expect(stat.textContent).toContain("1 MB");
    expect(stat.classList.contains("overview-disk")).toBe(false);
    expect(stat.hasAttribute("tabindex")).toBe(false);
    expect(host.querySelector(".overview-disk-popover")).toBeNull();
  });

  it("renders nothing when no size is known", () => {
    render(h(DiskUsageStat, { readout: diskUsageReadout({}) }), host);
    expect(host.innerHTML).toBe("");
  });
});
