// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { h, render } from "preact";
import { act } from "preact/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
// @ts-expect-error — portal modules are plain JS.
import { SourcesView } from "./sources.js";

let host: HTMLElement;
let stalled: string | null;
let reads: AbortSignal[];
let failed: string | null;

beforeEach(() => {
  vi.useFakeTimers();
  const dom = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.document);
  vi.stubGlobal("Event", dom.window.Event);
  host = dom.document.querySelector("main") as unknown as HTMLElement;
  stalled = "/admin/sources";
  reads = [];
  failed = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, options: RequestInit = {}) => {
    if (url === "/admin/sources") reads.push(options.signal as AbortSignal);
    if (url === failed) return Response.json({ error: "Unavailable" }, { status: 503 });
    if (url === stalled) return new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
    return Response.json({ items: [] });
  }));
});

afterEach(() => {
  render(null, host);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a stalled source read ends loading, cancels its requests and a later refresh recovers", async () => {
  await act(async () => render(h(SourcesView, { demo: true }), host));
  expect(host.textContent).toContain("Loading…");
  Object.defineProperty(document, "hidden", { value: true, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(reads[0].aborted).toBe(true);
  expect(host.textContent).toContain("Sources took too long to load");
  expect(host.textContent).not.toContain("Loading…");
  stalled = null;
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(reads).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(host.textContent).not.toContain("Sources took too long to load");
  expect(host.textContent).toContain("No sources yet.");
});

test("leaving Sources aborts its in-flight refresh instead of occupying a browser connection", async () => {
  await act(async () => render(h(SourcesView, { demo: true }), host));
  expect(reads[0].aborted).toBe(false);
  await act(async () => render(null, host));
  expect(reads[0].aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(reads).toHaveLength(1);
});

test("a failed required read cancels its still-pending siblings", async () => {
  failed = "/status";
  await act(async () => render(h(SourcesView, { demo: true }), host));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(reads[0].aborted).toBe(true);
  expect(host.textContent).toContain("503");
  expect(host.textContent).not.toContain("Loading…");
});
