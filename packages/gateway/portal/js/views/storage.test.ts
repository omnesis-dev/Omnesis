// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ getStorage: vi.fn(), setStoragePolicy: vi.fn(), previewStorageTrim: vi.fn(), applyStorageTrim: vi.fn(), setStorageRetention: vi.fn(), refreshStorage: vi.fn() }));
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
test("requires preview and explicit confirmation, then consumes exactly the preview token", async () => {
  api.previewStorageTrim.mockResolvedValue({ token: "preview-token", documents: 2, payloadBytes: 80 });
  api.applyStorageTrim.mockResolvedValue({ deleted: 2 });
  await mount();
  expect(api.applyStorageTrim).not.toHaveBeenCalled();
  await openAction("Trim"); await input("#storage-before", "2021-01-01");
  await submit(".storage-dialog form");
  expect(api.previewStorageTrim).toHaveBeenCalledWith("source-example", "2021-01-01T00:00:00.000Z");
  const deletion = [...host.querySelectorAll("button")].find((button) => button.textContent === "Delete previewed data") as HTMLButtonElement;
  expect(deletion.disabled).toBe(true);
  const checkbox = host.querySelector('[type="checkbox"]') as HTMLInputElement;
  checkbox.checked = true;
  await act(async () => { checkbox.dispatchEvent(new window.Event("change", { bubbles: true })); });
  expect(deletion.disabled).toBe(false);
  await click("Delete previewed data");
  expect(api.applyStorageTrim).toHaveBeenCalledExactlyOnceWith("preview-token");
  expect(host.querySelector(".storage-trim-preview")).toBeNull();
  expect(host.textContent).toContain("2 documents removed");
});
test("changing the cutoff invalidates a preview before it can be applied", async () => {
  api.previewStorageTrim.mockResolvedValue({ token: "old-token", documents: 2, payloadBytes: 80 });
  await mount(); await openAction("Trim"); await input("#storage-before", "2021-01-01");
  await submit(".storage-dialog form");
  await input("#storage-before", "2022-01-01");
  expect(host.querySelector(".storage-trim-preview")).toBeNull();
  expect(api.applyStorageTrim).not.toHaveBeenCalled();
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
test("refreshes cached accounting explicitly and labels lexical allocation and vector payload", async () => {
  api.getStorage.mockResolvedValue({ ...snapshot, index: { measuredAt: "2020-01-01T00:00:00Z", lexicalBytes: 1024, embeddingBytes: 2048, sources: [{ sourceId: "source-example", month: "2020-01", chunkCount: 2, textBytes: 128, embeddingBytes: 2048 }] } });
  await mount();
  expect(host.textContent).toContain("Lexical index");
  expect(host.textContent).toContain("Vectors");
  expect(host.textContent).toContain("Measurements can lag");
  await click("Refresh measurements");
  expect(api.refreshStorage).toHaveBeenCalledOnce();
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
test("offers existing file reclamation paths and explains trimming may leave quota pressure", async () => {
  await mount();
  expect(host.querySelector('a[href="/portal/settings/models"]')).not.toBeNull();
  expect(host.querySelector('a[href="https://omnesis.dev/docs/updating#backup"]')).not.toBeNull();
  await openAction("Trim");
  await input("#storage-before", "2021-01-01");
  expect(host.textContent).toContain("database file sizes can remain unchanged");
});

test("shows the live disk limit as a placeholder and hides healthy status", async () => {
  const gib = 1024 ** 3;
  api.getStorage.mockResolvedValue({ ...snapshot, policy: { maxBytes: null },
    pressure: { state: "normal", usageBytes: 2 * gib, policy: { maxDiskUsedPercent: 95, minFreeBytes: gib },
      volumes: [{ id: "one", availableBytes: 10 * gib, totalBytes: 100 * gib },
        { id: "two", availableBytes: 8 * gib, totalBytes: 100 * gib }] } });
  await mount();
  const limit = host.querySelector<HTMLInputElement>("#storage-limit");
  expect(limit?.placeholder).toBe("5.000");
  expect(limit?.value).toBe("");
  expect(host.querySelector(".storage-health")).toBeNull();
  await submit(".storage-limit-form");
  expect(api.setStoragePolicy).toHaveBeenLastCalledWith({ maxBytes: null });
});

test("expands the source history and a graph selection sets the trim cutoff", async () => {
  await mount();
  await act(async () => { host.querySelector<HTMLButtonElement>(".storage-expand")?.click(); });
  expect(host.querySelector(".storage-expanded .storage-history")).not.toBeNull();
  await openAction("Trim");
  const point = host.querySelector('[role="dialog"] [data-history-point="0"]');
  await act(async () => { point?.dispatchEvent(new window.Event("click", { bubbles: true })); });
  expect(host.querySelector<HTMLInputElement>("#storage-before")?.value).toBe("2020-02-01");
});

test("shows the time-of-day cutoff for a rolling window", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-18T18:23:00Z"));
  try {
    await mount();
    await openAction("Set rolling retention");
    await input("#storage-before", "2026-11-17");
    expect((host.querySelector("#storage-retention-days") as HTMLInputElement).value).toBe("1");
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain("2026-11-17 18:23 UTC");
  } finally {
    clock.mockRestore();
  }
});
