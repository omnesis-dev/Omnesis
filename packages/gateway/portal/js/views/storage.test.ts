// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ getStorage: vi.fn(), setStoragePolicy: vi.fn(), startStorageTrim: vi.fn(), setStorageRetention: vi.fn(), refreshStorage: vi.fn() }));
vi.mock("../api.js", () => api);

// @ts-expect-error — portal modules are plain JS.
import { StorageView } from "./storage.js";
let host: HTMLElement;
const snapshot = {
  policy: { maxBytes: 1024 ** 3 }, pressure: { state: "blocked", reasons: ["Storage limit reached"] },
  physical: { totalBytes: 1024, stores: [{ id: "documents", label: "Main database", bytes: 1024 }] },
  logical: { sources: [{ sourceId: "source-example", documents: 3, payloadBytes: 100, months: [{ month: "2020-01", documents: 3, payloadBytes: 100 }] }], database: { tables: [] } },
};
beforeEach(() => {
  vi.resetAllMocks();
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document); vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  api.getStorage.mockResolvedValue(snapshot);
  api.refreshStorage.mockResolvedValue(snapshot);
});
afterEach(() => { render(null, host); vi.unstubAllGlobals(); });
async function mount() { await act(async () => { render(h(StorageView, {}), host); }); await act(async () => {}); }
async function input(selector: string, value: string) {
  const node = host.querySelector(selector) as HTMLInputElement;
  node.value = value;
  await act(async () => { node.dispatchEvent(new window.Event("input", { bubbles: true })); });
}
async function click(label: string) {
  const node = [...host.querySelectorAll("button")].find((button) => button.textContent === label) as HTMLButtonElement;
  await act(async () => { node.click(); });
}
async function openAction(label: string) {
  await act(async () => {
    const trigger = host.querySelector(".row-action-trigger") as HTMLButtonElement;
    trigger.getBoundingClientRect = () => ({ bottom: 10, top: 0, right: 10 }) as DOMRect;
    trigger.click();
  });
  await act(async () => {
    const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent?.trim() === label);
    item?.click();
  });
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
}
async function submit(selector: string) {
  await act(async () => { host.querySelector(selector)?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
}
test("distinguishes measured physical files, logical estimates and storage protection", async () => {
  await mount();
  expect(host.textContent).toContain("Storage protection is active");
  expect(host.textContent).toContain("Shared database space");
  expect(host.textContent).not.toContain("Database allocation");
  expect(host.textContent).toContain("source-example");
  expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("Omnesis files");
});
test("saves a limit or clears it without accepting invalid values", async () => {
  await mount();
  await input("#storage-limit", "2"); await submit("form");
  expect(api.setStoragePolicy).toHaveBeenLastCalledWith({ maxBytes: 2 * 1024 ** 3 });
  await input("#storage-limit", ""); await submit("form");
  expect(api.setStoragePolicy).toHaveBeenLastCalledWith({ maxBytes: null });
  await input("#storage-limit", "-3"); await submit("form");
  expect(api.setStoragePolicy).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("positive storage limit");
});
test("one confirmation schedules the entire trim and shows durable progress", async () => {
  const job = { id: "trim-one", sourceId: "source-example", before: "2021-01-01T00:00:00.000Z", state: "queued", deleted: 0 };
  api.startStorageTrim.mockResolvedValue(job);
  api.getStorage.mockResolvedValue({ ...snapshot, trimJobs: [job] });
  await mount();
  await openAction("Trim"); await input("#storage-before", "2021-01-01");
  await submit(".storage-dialog form");
  expect(api.startStorageTrim).not.toHaveBeenCalled();
  const checkbox = host.querySelector('[type="checkbox"]') as HTMLInputElement;
  checkbox.checked = true;
  await act(async () => { checkbox.dispatchEvent(new window.Event("change", { bubbles: true })); });
  await submit(".storage-dialog form");
  expect(api.startStorageTrim).toHaveBeenCalledExactlyOnceWith("source-example", "2021-01-01T00:00:00.000Z");
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toContain("Trim queued");
  expect(host.textContent).toContain("All eligible documents");
  expect(api.refreshStorage).not.toHaveBeenCalled();
});
test("changing the cutoff requires renewed confirmation", async () => {
  await mount(); await openAction("Trim"); await input("#storage-before", "2021-01-01");
  const checkbox = host.querySelector('[type="checkbox"]') as HTMLInputElement;
  checkbox.checked = true;
  await act(async () => { checkbox.dispatchEvent(new window.Event("change", { bubbles: true })); });
  await input("#storage-before", "2022-01-01");
  await submit(".storage-dialog form");
  expect(api.startStorageTrim).not.toHaveBeenCalled();
});
test("shows failed reads and allows retry", async () => {
  api.getStorage.mockRejectedValueOnce(new Error("Measurement unavailable"));
  await mount(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Measurement unavailable");
  await click("Try again"); await act(async () => {});
  expect(host.textContent).toContain("Storage protection is active");
});
test("rolling retention requires a source and saves explicit days or disable", async () => {
  await mount();
  await openAction("Set rolling retention");
  await input("#storage-retention-days", "1095");
  await submit(".storage-dialog form");
  expect(api.setStorageRetention).not.toHaveBeenCalled();
  const confirmation = host.querySelector("#storage-retention-confirm") as HTMLInputElement;
  confirmation.checked = true;
  await act(async () => { confirmation.dispatchEvent(new window.Event("change", { bubbles: true })); });
  await submit(".storage-dialog form");
  expect(api.setStorageRetention).toHaveBeenLastCalledWith("source-example", 1095);
  await openAction("Set rolling retention");
  await input("#storage-retention-days", "");
  await submit(".storage-dialog form");
  expect(api.setStorageRetention).toHaveBeenLastCalledWith("source-example", null);
  await openAction("Set rolling retention");
  await input("#storage-retention-days", "0.5");
  await submit(".storage-dialog form");
  expect(api.setStorageRetention).toHaveBeenCalledTimes(2);
});
test("a retention source with no remaining documents can still be selected and disabled", async () => {
  api.getStorage.mockResolvedValue({ ...snapshot, logical: { sources: [], database: { tables: [] } }, retention: [{ sourceId: "empty-source", maxAgeDays: 7 }] });
  await mount();
  await openAction("Set rolling retention");
  expect((host.querySelector("#storage-retention-days") as HTMLInputElement).value).toBe("7");
  await input("#storage-retention-days", "");
  await submit(".storage-dialog form");
  expect(api.setStorageRetention).toHaveBeenCalledExactlyOnceWith("empty-source", null);
});
test("updates cached accounting without a routine refresh button and labels lexical allocation and vector payload", async () => {
  api.getStorage.mockResolvedValue({ ...snapshot, index: { measuredAt: "2020-01-01T00:00:00Z", lexicalBytes: 1024, embeddingBytes: 2048, sources: [{ sourceId: "source-example", month: "2020-01", chunkCount: 2, textBytes: 128, embeddingBytes: 2048 }] } });
  await mount();
  expect(host.textContent).toContain("Indexed text & lexical index");
  expect(host.textContent).toContain("Vectors");
  expect(host.textContent).toContain("Measurements can lag");
  expect(host.textContent).not.toContain("Refresh measurements");
  expect(api.refreshStorage).not.toHaveBeenCalled();
});
test("renders source identifiers as text rather than executable markup", async () => {
  const sourceId = 'source:<img src=x onerror="alert(1)">';
  api.getStorage.mockResolvedValue({ ...snapshot, logical: { ...snapshot.logical, sources: [{ sourceId, documents: 1, payloadBytes: 1, months: [] }] } });
  await mount();
  expect(host.textContent).toContain(sourceId);
  expect(host.querySelector("img")).toBeNull();
  expect(host.querySelector("[onerror]")).toBeNull();
});
test("unavailable accounting never claims the corpus is empty", async () => {
  api.getStorage.mockResolvedValue({ ...snapshot, logical: null });
  await mount();
  expect(host.textContent).toContain("Source accounting is not available yet");
  expect(host.textContent).not.toContain("No source documents are stored");
});
test("explains that trimming may leave physical disk usage unchanged", async () => {
  await mount();
  await openAction("Trim");
  await input("#storage-before", "2021-01-01");
  expect(host.textContent).toContain("database file sizes can remain unchanged");
});

test("shows no custom limit and explains automatic protection without a misleading disk-size placeholder", async () => {
  const gib = 1024 ** 3;
  api.getStorage.mockResolvedValue({ ...snapshot, policy: { maxBytes: null },
    pressure: { state: "normal", usageBytes: 2 * gib, policy: { maxDiskUsedPercent: 95, minFreeBytes: gib },
      volumes: [{ id: "one", availableBytes: 10 * gib, totalBytes: 100 * gib },
        { id: "two", availableBytes: 8 * gib, totalBytes: 100 * gib }] } });
  await mount();
  const limit = host.querySelector<HTMLInputElement>("#storage-limit");
  expect(limit?.placeholder).toBe("No custom limit");
  expect(host.textContent).toContain("sync pauses at 95% disk usage");
  expect(limit?.value).toBe("");
  expect(host.querySelector(".storage-health")).toBeNull();
  await submit(".storage-limit-form");
  expect(api.setStoragePolicy).toHaveBeenLastCalledWith({ maxBytes: null });
});

test("expands source history and keeps the trim graph indicative", async () => {
  await mount();
  await act(async () => { host.querySelector<HTMLElement>(".storage-source-row")!.click(); });
  expect(host.querySelector(".storage-expanded .storage-history")).not.toBeNull();
  await openAction("Trim");
  expect(host.querySelector('[role="dialog"] [data-history-point][role="button"]')).toBeNull();
  expect(host.querySelector<HTMLInputElement>("#storage-before")?.value).toBe("");
});

test("shows the time-of-day cutoff for a rolling window", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-18T18:23:00Z"));
  try {
    await mount();
    await openAction("Set rolling retention");
    expect(host.querySelector("#storage-before")).toBeNull();
    await input("#storage-retention-days", "2");
    await click("−");
    expect((host.querySelector("#storage-retention-days") as HTMLInputElement).value).toBe("1");
    expect(host.querySelector('[role="dialog"] [data-history-point][role="button"]')).toBeNull();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("2026-11-17 18:23 UTC");
  } finally {
    clock.mockRestore();
  }
});

test("toggles from the source row while its action menu remains independent", async () => {
  await mount();
  const row = host.querySelector<HTMLElement>(".storage-source-row")!;
  await act(async () => { row.click(); });
  expect(row.getAttribute("aria-expanded")).toBe("true");
  expect(row.querySelector(".storage-chevron")?.closest("button")).toBeNull();
  await openAction("Trim");
  expect(row.getAttribute("aria-expanded")).toBe("true");
  await click("✕");
  await act(async () => { row.click(); });
  expect(row.getAttribute("aria-expanded")).toBe("false");
});

test("shows orange outstanding trim history on reload, and completed progress without scheduling it", async () => {
  api.getStorage.mockResolvedValue({ ...snapshot, trimJobs: [
    { id: "active", sourceId: "source-example", before: "2021-01-01T00:00:00.000Z", state: "running", deleted: 123 },
    { id: "done", sourceId: "source-example", before: "2022-01-01T00:00:00.000Z", state: "completed", deleted: 300 },
  ] });
  await mount();
  expect(host.textContent).toContain("Trimming · 123 documents removed");
  expect(host.textContent).toContain("Trim completed · 300 documents removed");
  await act(async () => { host.querySelector<HTMLElement>(".storage-source-row")!.click(); });
  expect(host.querySelector(".storage-history-scheduled-area")?.getAttribute("data-cutoff")).toBe("2021-01-01T00:00:00.000Z");
  expect(host.textContent).toContain("Scheduled for trimming");
  expect(host.querySelector(".storage-history-scheduled-area")?.getAttribute("fill")).toContain("--storage-scheduled");
});

test("rolling policy shades its moving cutoff orange and its proposed change red", async () => {
  api.getStorage.mockResolvedValue({ ...snapshot, retention: [{ sourceId: "source-example", maxAgeDays: 7 }] });
  await mount();
  await act(async () => { host.querySelector<HTMLElement>(".storage-source-row")!.click(); });
  expect(host.querySelector(".storage-history-scheduled-area")).not.toBeNull();
  await openAction("Set rolling retention");
  expect(host.querySelector('[role="dialog"] .storage-history-trim-area')?.getAttribute("fill")).toContain("--danger");
  expect(host.querySelector('[role="dialog"] .storage-history-scheduled-area')).toBeNull();
});

test.each([
  ["queued", false, true],
  ["running", false, true],
  ["completed", true, true],
  ["completed", false, false],
  ["failed", false, false],
  ["cancelled", false, false],
])("trim spinner follows %s with cleanup pending=%s", async (state, cleanupPending, active) => {
  api.getStorage.mockResolvedValue({ ...snapshot, trimJobs: [
    { id: "spinner-job", sourceId: "source-example", before: "2021-01-01T00:00:00.000Z", state, cleanupPending, deleted: 123 },
  ] });
  await mount();
  const status = host.querySelector('.storage-trim-status')!;
  expect(status.classList.contains("is-active")).toBe(active);
  expect(status.querySelector('.storage-trim-spinner') !== null).toBe(active);
  if (active) expect(status.querySelector('.storage-trim-spinner')?.getAttribute('aria-hidden')).toBe('true');
});

test("polls job progress, preserves a limit being edited, and stops polling after unmount", async () => {
  vi.useFakeTimers();
  try {
    const job = { id: "poll-job", sourceId: "source-example", before: "2021-01-01T00:00:00.000Z", state: "running", deleted: 10 };
    api.getStorage.mockResolvedValue({ ...snapshot, trimJobs: [job] });
    await mount();
    expect(host.querySelector(".storage-trim-spinner")).not.toBeNull();
    await input("#storage-limit", "42");
    api.getStorage.mockResolvedValue({ ...snapshot, trimJobs: [{ ...job, state: "completed", deleted: 350 }] });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(host.textContent).toContain("Trim completed · 350 documents removed");
    expect(host.querySelector(".storage-trim-spinner")).toBeNull();
    expect(host.querySelector<HTMLInputElement>("#storage-limit")?.value).toBe("42");
    expect(api.getStorage).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(api.getStorage).toHaveBeenCalledTimes(2);
    await act(async () => { render(null, host); });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.getStorage).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

test("measurement failures keep the previous chart and offer a retry", async () => {
  api.getStorage.mockResolvedValue({ ...snapshot, accounting: {error: "Read worker unavailable", refreshing: false} });
  await mount();
  expect(host.textContent).toContain("Read worker unavailable");
  expect(host.querySelector(".storage-source-row")).not.toBeNull();
  await click("Try again");
  expect(api.refreshStorage).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("Read worker unavailable");
});

test("an older polling response cannot overwrite the result of saving a limit", async () => {
  vi.useFakeTimers();
  try {
    let finish!: (result: typeof snapshot) => void;
    api.getStorage.mockResolvedValueOnce(snapshot)
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ ...snapshot, policy: { maxBytes: 2 * 1024 ** 3 }, pressure: {state: "normal", reasons: []} });
    await mount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await input("#storage-limit", "2");
    await submit(".storage-limit-form");
    expect(host.querySelector(".storage-health")).toBeNull();
    await act(async () => { finish(snapshot); });
    expect(host.querySelector(".storage-health")).toBeNull();
    expect(host.querySelector<HTMLInputElement>("#storage-limit")?.value).toBe("2");
  } finally { vi.useRealTimers(); }
});

test("protected-only history never appears scheduled for rolling trimming", async () => {
  api.getStorage.mockResolvedValue({ ...snapshot, retention: [{sourceId: "source-example", maxAgeDays: 7}],
    logical: {sources: [{...snapshot.logical.sources[0], months: [{month: "2020-01", payloadBytes: 100, trimmableDocuments: 0}]}]} });
  await mount();
  await act(async () => { host.querySelector<HTMLElement>(".storage-source-row")!.click(); });
  expect(host.querySelector(".storage-history-line")).not.toBeNull();
  expect(host.querySelector(".storage-history-scheduled-area")).toBeNull();
  expect(host.textContent).toContain("Protected documents are kept");
});

test("keeps file breakdown open across storage polling and shows reconciliation beside the physical pie", async () => {
  vi.useFakeTimers();
  try {
    const measuredAt = "2026-01-01T00:00:00.000Z";
    const complete = {...snapshot,
      physical: {measuredAt, totalBytes: 100, stores: [{id: "documents", label: "Main database", bytes: 60, components: [{id: "database", label: "Database file", bytes: 50}, {id: "write-log", label: "Write log", bytes: 10}]}, {id: "index", label: "Search index", bytes: 40}]},
      logical: {...snapshot.logical, measuredAt, sources: [{sourceId: "source-example", payloadBytes: 20, months: [{month: "2020-01", payloadBytes: 20}]}]},
      index: {measuredAt, tables: [], lexicalBytes: 5, sources: [{sourceId: "source-example", month: "2020-01", embeddingBytes: 10, textBytes: 5}]},
    };
    api.getStorage.mockResolvedValue(complete);
    await mount();
    expect(host.querySelectorAll(".storage-donut")).toHaveLength(1);
    const details = host.querySelector(".storage-file-details")!;
    details.setAttribute("open", "");
    expect(details.textContent).toContain("Write log");
    const totals = [...host.querySelectorAll(".storage-reconciliation-table tfoot td")].map((cell) => cell.textContent);
    expect(totals).toEqual(["100 B", "40 B", "60 B"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(host.querySelector(".storage-file-details")?.hasAttribute("open")).toBe(true);
    expect(host.querySelectorAll(".storage-reconciliation-table")).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

test("invalid physical values never turn into a zero total or invalid pie geometry", async () => {
  api.getStorage.mockResolvedValue({...snapshot, physical: {totalBytes: Infinity, stores: [{id: "documents", label: "Main database", bytes: Infinity}]}});
  await mount();
  expect(host.querySelector(".storage-donut text")?.textContent).toBe("Not measured");
  expect(host.querySelector(".storage-donut")?.outerHTML).not.toContain("NaN");
});
