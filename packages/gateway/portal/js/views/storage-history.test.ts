// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { StorageHistory, storageHistoryData, storageHistoryArea } from "./storage-history.js";

const now = new Date("2024-04-18T15:30:00.000Z");
const months = [{ month: "2024-03", bytes: 300 }, { month: "2024-01", bytes: 70 }, { month: "2024-01", bytes: 30 }];

describe("source storage history data", () => {
  test("fills calendar gaps and carries cumulative bytes through the actual current month", () => {
    const data = storageHistoryData(months, now);
    expect(data.buckets.map((bucket: { startMonth: string }) => bucket.startMonth)).toEqual(["2024-01", "2024-02", "2024-03", "2024-04"]);
    expect(data.buckets.map((bucket: { bytes: number; cumulativeBytes: number }) => [bucket.bytes, bucket.cumulativeBytes])).toEqual([[100, 100], [0, 100], [300, 400], [0, 400]]);
    expect(data.buckets.map((bucket: { cutoff: string }) => bucket.cutoff)).toEqual(["2024-02-01", "2024-03-01", "2024-04-01", "2024-04-18"]);
    expect(data.end).toBe(now.getTime());
    expect(data.totalBytes).toBe(400);
    expect(data.coarsened).toBe(false);
  });

  test("bounds very old sparse histories and preserves every byte and the current endpoint", () => {
    const data = storageHistoryData([{ month: "0001-01", bytes: 1 }, { month: "2024-04", bytes: 2 }], now);
    expect(data.buckets).toHaveLength(120);
    expect(data.coarsened).toBe(true);
    expect(data.buckets[0].startMonth).toBe("0001-01");
    expect(data.buckets.at(-1)).toMatchObject({ endMonth: "2024-04", cutoff: "2024-04-18", cumulativeBytes: 3 });
    expect(data.buckets.reduce((sum: number, bucket: { bytes: number }) => sum + bucket.bytes, 0)).toBe(3);
  });

  test("keeps undated and future payload outside the timeline and ignores invalid byte values", () => {
    const data = storageHistoryData([{ month: "unknown", bytes: 5 }, { month: "2024-13", bytes: 7 }, { month: "2025-01", bytes: 9 }, { month: "2024-01", bytes: -5 }, { month: "2024-02", bytes: NaN }], now);
    expect(data).toMatchObject({ totalBytes: 0, undatedBytes: 12, futureBytes: 9 });
  });

  test("an empty history remains finite", () => {
    const data = storageHistoryData([], now);
    expect(data.buckets).toHaveLength(1);
    expect(data.totalBytes).toBe(0);
    expect(data.buckets[0]).toMatchObject({ startMonth: "2024-04", cutoff: "2024-04-18" });
  });
});

describe("source storage history graph", () => {
  let host: HTMLElement;
  beforeEach(() => {
    const parsed = parseHTML("<html><body><main></main></body></html>");
    vi.stubGlobal("document", parsed.document); vi.stubGlobal("window", parsed.window);
    host = parsed.document.querySelector("main") as unknown as HTMLElement;
  });
  afterEach(() => { render(null, host); vi.unstubAllGlobals(); });

  test("renders monthly bars and a cumulative line, and selecting a point sets its exclusive cutoff", async () => {
    const onSelectCutoff = vi.fn();
    await act(async () => { render(h(StorageHistory, { months, now, selectedCutoff: "2024-02-01", onSelectCutoff }), host); });
    expect(host.querySelectorAll(".storage-history-bar")).toHaveLength(4);
    expect(host.querySelector(".storage-history-line")?.getAttribute("d")).toMatch(/^M /);
    expect(host.querySelector('[aria-pressed="true"]')?.getAttribute("aria-label")).toContain("2024-02-01");
    const point = host.querySelector('[data-history-point="2"]')!;
    await act(async () => { point.dispatchEvent(new window.Event("click", { bubbles: true })); });
    expect(onSelectCutoff).toHaveBeenCalledExactlyOnceWith("2024-04-01");
    expect(host.querySelector(".storage-history-cutoff")).not.toBeNull();
    expect(host.querySelector(".storage-history-caption")?.textContent).toContain("database file sizes can remain unchanged");
  });

  test("keyboard navigation moves between points and Enter or Space selects, without trapping Tab", async () => {
    const onSelectCutoff = vi.fn();
    await act(async () => { render(h(StorageHistory, { months, now, onSelectCutoff }), host); });
    const points = [...host.querySelectorAll("[data-history-point]")];
    const focuses = points.map((point) => { const focus = vi.fn(); Object.defineProperty(point, "focus", { configurable: true, value: focus }); return focus; });
    function press(index: number, key: string) {
      const event = new window.Event("keydown", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "key", { value: key });
      points[index]!.dispatchEvent(event);
      return event;
    }
    expect(press(3, "Home").defaultPrevented).toBe(true);
    expect(focuses[0]).toHaveBeenCalledOnce();
    expect(points[0]?.getAttribute("tabindex")).toBe("0");
    expect(points[3]?.getAttribute("tabindex")).toBe("-1");
    press(0, "ArrowRight"); expect(focuses[1]).toHaveBeenCalledOnce();
    press(0, "ArrowLeft"); expect(focuses[0]).toHaveBeenCalledTimes(2);
    press(0, "End"); expect(focuses[3]).toHaveBeenCalledOnce();
    await act(async () => { press(1, "Enter"); press(3, " "); });
    expect(onSelectCutoff.mock.calls).toEqual([["2024-03-01"], ["2024-04-18"]]);
    expect(press(0, "Tab").defaultPrevented).toBe(false);
    for (const key of ["constructor", "__proto__", "toString"]) {
      expect(press(0, key).defaultPrevented).toBe(false);
    }
    expect(onSelectCutoff).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  test("read-only charts expose descriptions without actionable buttons", async () => {
    await act(async () => { render(h(StorageHistory, { months, now }), host); });
    expect(host.querySelector('[role="button"]')).toBeNull();
    expect(host.querySelector("[data-history-point]")?.getAttribute("aria-label")).not.toContain("Select cutoff");
  });

  test("unknown and future totals stay visible even when no dated graph exists", async () => {
    await act(async () => { render(h(StorageHistory, { months: [{ month: "unknown", bytes: 2048 }, { month: "2025-01", bytes: 1024 }], now }), host); });
    expect(host.textContent).toContain("No dated storage to plot");
    expect(host.textContent).toContain("2 KiB has no usable month");
    expect(host.textContent).toContain("1 KiB is dated after the current month");
    expect(host.querySelector("svg")).toBeNull();
  });
});


describe("cutoff shading", () => {
  test("interpolates the cumulative curve within a month at the precise rolling instant", () => {
    const data = storageHistoryData(months, now);
    const instant = "2024-01-16T12:00:00.000Z";
    const area = storageHistoryArea(data, instant);
    expect(area.time).toBe(Date.parse(instant));
    expect(area.bytes).toBeCloseTo(50);
    expect(area.points).toEqual([{ time: data.start, bytes: 0 }, { time: Date.parse(instant), bytes: 50 }]);
    expect(storageHistoryArea(data, "2024-01-16").bytes).toBeLessThan(area.bytes);
  });
  test("keeps flat gaps flat, shades the complete curve for a later cutoff, and rejects malformed dates", () => {
    const data = storageHistoryData(months, now);
    expect(storageHistoryArea(data, "2024-02-15").bytes).toBe(100);
    expect(storageHistoryArea(data, "2025-01-01")).toMatchObject({ time: data.end, bytes: 400 });
    for (const cutoff of [null, "", "invalid", "2024-02-31", "2024-01-01", "2023-12-31", "2024-02-01T00:00:00+02:00"]) {
      expect(storageHistoryArea(data, cutoff)).toBeNull();
    }
  });
});

describe("source history hover card", () => {
  let host: HTMLElement;
  beforeEach(() => {
    const parsed = parseHTML("<html><body><main></main></body></html>");
    vi.stubGlobal("document", parsed.document); vi.stubGlobal("window", parsed.window);
    host = parsed.document.querySelector("main") as unknown as HTMLElement;
  });
  afterEach(() => { render(null, host); vi.unstubAllGlobals(); });

  test("shows cumulative storage on hover in a read-only chart and stays inside the plot's right edge", async () => {
    await act(async () => { render(h(StorageHistory, { months, now }), host); });
    const plot = host.querySelector(".storage-history-plot") as HTMLElement;
    plot.getBoundingClientRect = () => ({ left: 10, top: 20, width: 300 }) as DOMRect;
    const point = host.querySelector('[data-history-point="2"]') as SVGElement;
    point.getBoundingClientRect = () => ({ left: 300, top: 100, width: 20 }) as DOMRect;
    await act(async () => { point.dispatchEvent(new window.Event("pointerenter")); });
    const card = host.querySelector('[role="tooltip"]') as HTMLElement;
    expect(card.textContent).toContain("400 B");
    expect(card.textContent).toContain("Cumulative storage");
    expect(card.textContent).toContain("300 B in this period");
    expect(card.style.left).toBe("68px");
    expect(point.getAttribute("aria-describedby")).toBe(card.id);
    expect(host.querySelector('[role="button"]')).toBeNull();
    expect(host.querySelector("svg title")).toBeNull();
    await act(async () => { point.dispatchEvent(new window.Event("pointerleave")); });
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });

  test("flips above a point near the viewport bottom and permits a negative plot-relative offset", async () => {
    await act(async () => { render(h(StorageHistory, { months, now }), host); });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const plot = host.querySelector(".storage-history-plot") as HTMLElement;
    plot.getBoundingClientRect = () => ({ left: 0, top: 700, width: 300 }) as DOMRect;
    const point = host.querySelector('[data-history-point="0"]') as SVGElement;
    point.getBoundingClientRect = () => ({ left: 100, top: 760, bottom: 766, width: 6, height: 6 }) as DOMRect;
    await act(async () => { point.dispatchEvent(new window.Event("pointerenter")); });
    const top = parseFloat((host.querySelector('[role="tooltip"]') as HTMLElement).style.top);
    expect(top).toBeLessThan(0);
    expect(700 + top).toBeGreaterThanOrEqual(12);
    expect(700 + top + 128).toBeLessThan(760);
  });

  test("read-only points support focus inspection and ignore activation keys", async () => {
    await act(async () => { render(h(StorageHistory, { months, now }), host); });
    const point = host.querySelector('[data-history-point="0"]') as SVGElement;
    await act(async () => { point.dispatchEvent(new window.Event("focus")); });
    expect(host.querySelector('[role="tooltip"]')?.textContent).toContain("100 B");
    const event = new window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: "Enter" });
    await act(async () => { point.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(false);
    await act(async () => { point.dispatchEvent(new window.Event("blur")); });
    expect(host.querySelector('[role="tooltip"]')).toBeNull();
  });

  test("precise cutoffInstant shades through the middle of the curve and an empty instant falls back to the chosen date", async () => {
    const instant = "2024-01-16T12:00:00.000Z";
    await act(async () => { render(h(StorageHistory, { months, now, selectedCutoff: "2024-01-16", cutoffInstant: instant }), host); });
    const area = host.querySelector(".storage-history-trim-area");
    expect(area?.getAttribute("data-cutoff")).toBe(instant);
    expect(area?.getAttribute("fill")).toContain("--danger");
    const preciseX = Number(host.querySelector(".storage-history-cutoff line")?.getAttribute("x1"));
    await act(async () => { render(h(StorageHistory, { months, now, selectedCutoff: "2024-01-16", cutoffInstant: "" }), host); });
    expect(host.querySelector(".storage-history-trim-area")?.getAttribute("data-cutoff")).toBe("2024-01-16");
    const dayX = Number(host.querySelector(".storage-history-cutoff line")?.getAttribute("x1"));
    expect(dayX).toBeLessThan(preciseX);
  });
});
