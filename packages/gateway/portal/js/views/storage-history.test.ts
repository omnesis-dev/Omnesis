// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { StorageHistory, storageHistoryData } from "./storage-history.js";

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
