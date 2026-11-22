// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({startStorageCleanup: vi.fn()}));
vi.mock("../api.js", () => api);
// @ts-expect-error — portal modules are plain JS.
import { StorageHistoryCleanupDialog } from "./storage-history-cleanup-dialog.js";

let host: HTMLElement;
const saved = vi.fn(), close = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  const parsed = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("document", parsed.document); vi.stubGlobal("window", parsed.window);
  host = parsed.document.querySelector("main") as unknown as HTMLElement;
  api.startStorageCleanup.mockResolvedValue({job: {id: "cleanup-one", state: "queued"}});
});
afterEach(() => {render(null, host); vi.unstubAllGlobals();});
async function mount(target = "backups") {
  await act(async () => {render(h(StorageHistoryCleanupDialog, {target, onClose: close, onSaved: saved}), host);});
}
async function date(value: string) {
  const input = host.querySelector<HTMLInputElement>("#storage-cleanup-before")!;
  input.value = value;
  await act(async () => {input.dispatchEvent(new window.Event("input", {bubbles: true}));});
}
async function check(selector: string, checked: boolean) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  input.checked = checked;
  await act(async () => {input.dispatchEvent(new window.Event("change", {bubbles: true}));});
}
async function submit() {
  await act(async () => {host.querySelector("form")!.dispatchEvent(new window.Event("submit", {bubbles: true, cancelable: true}));});
  await act(async () => {});
}

test("defaults to preserving the newest backup and requires date-specific consent", async () => {
  await mount();
  expect(host.querySelector("#storage-cleanup-keep-newest")?.hasAttribute("checked")).toBe(true);
  await submit(); expect(api.startStorageCleanup).not.toHaveBeenCalled();
  await date("2024-01-01"); await submit(); expect(api.startStorageCleanup).not.toHaveBeenCalled();
  await check("#storage-cleanup-confirm", true); await submit();
  expect(api.startStorageCleanup).toHaveBeenCalledExactlyOnceWith({target: "backups", before: "2024-01-01T00:00:00.000Z", keepNewest: true});
  expect(saved).toHaveBeenCalledWith(expect.stringContaining("All eligible items"), {id: "cleanup-one", state: "queued"});
});

test("changing the cutoff or newest-copy protection clears consent", async () => {
  await mount(); await date("2024-01-01"); await check("#storage-cleanup-confirm", true);
  await date("2024-02-01"); await submit(); expect(api.startStorageCleanup).not.toHaveBeenCalled();
  await check("#storage-cleanup-confirm", true); await check("#storage-cleanup-keep-newest", false);
  await submit(); expect(api.startStorageCleanup).not.toHaveBeenCalled();
  expect(host.textContent).toContain("You may have no backup left to restore");
  await check("#storage-cleanup-confirm", true); await submit();
  expect(api.startStorageCleanup).toHaveBeenCalledExactlyOnceWith({target: "backups", before: "2024-02-01T00:00:00.000Z", keepNewest: false});
});

test.each(["brain-transcripts", "conversations"])("%s sends no backup-only setting and changes no policy", async (target) => {
  await mount(target); await date("2024-01-01"); await check("#storage-cleanup-confirm", true); await submit();
  expect(host.querySelector("#storage-cleanup-keep-newest")).toBeNull();
  expect(api.startStorageCleanup).toHaveBeenCalledExactlyOnceWith({target, before: "2024-01-01T00:00:00.000Z"});
  expect(host.textContent).toContain("Existing retention settings stay the same");
  expect(host.textContent).toContain("Removed file bytes do not guarantee");
});

test("invalid dates and unknown categories cannot schedule cleanup", async () => {
  await mount(); await date("2025-02-29"); await check("#storage-cleanup-confirm", true); await submit();
  expect(api.startStorageCleanup).not.toHaveBeenCalled();
  await mount("__proto__"); expect(host.querySelector('[role="dialog"]')).toBeNull();
});

test("switching cleanup categories cannot inherit the previous scope or consent", async () => {
  await mount(); await date("2024-01-01"); await check("#storage-cleanup-confirm", true);
  await mount("conversations"); await submit();
  expect(host.querySelector<HTMLInputElement>("#storage-cleanup-before")?.value).toBe("");
  expect(api.startStorageCleanup).not.toHaveBeenCalled();
});

test("serializes duplicate submissions and protects a job accepted before a page-update error", async () => {
  let finish!: (value: unknown) => void;
  api.startStorageCleanup.mockImplementationOnce(() => new Promise((resolve) => {finish = resolve;}));
  saved.mockRejectedValueOnce(new Error("Page update failed"));
  await mount(); await date("2024-01-01"); await check("#storage-cleanup-confirm", true);
  await submit(); await submit(); expect(api.startStorageCleanup).toHaveBeenCalledTimes(1);
  await act(async () => {finish({job: {id: "cleanup-one", state: "queued"}});});
  await act(async () => {});
  expect(host.textContent).toContain("Cleanup is scheduled");
  expect(host.textContent).toContain("Page update failed");
  await submit(); expect(api.startStorageCleanup).toHaveBeenCalledTimes(1);
});

test("request failures retain the selected scope for a deliberate retry and escape error text", async () => {
  api.startStorageCleanup.mockRejectedValueOnce(new Error('<img src=x onerror="alert(1)">'));
  await mount(); await date("2024-01-01"); await check("#storage-cleanup-confirm", true); await submit();
  expect(host.textContent).toContain('<img src=x onerror="alert(1)">');
  expect(host.querySelector("img")).toBeNull();
  await submit(); expect(api.startStorageCleanup).toHaveBeenCalledTimes(2);
});
