// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
const api = vi.hoisted(() => ({ previewSourceFilter: vi.fn(), getSourceFilterOptions: vi.fn() }));
vi.mock("../api.js", () => api);
// @ts-expect-error — Portal modules are JavaScript.
import { readFilterPreview, readFilterOptions } from "./source-filter-requests.js";
// @ts-expect-error — Portal modules are JavaScript.
import { clearScopeLabels, scopeDisplayLabel } from "./source-filter-labels.js";
const policy = {
  sourceId: "fictional:one",
  audience: { accessLevel: "new", capability: "answer" },
  rules: [],
  otherwise: "hide",
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  api.previewSourceFilter.mockReset();
  api.getSourceFilterOptions.mockReset();
  clearScopeLabels();
});

test("options and previews share bounded admission while exact in-flight preview readers deduplicate", async () => {
  const pages: ReturnType<typeof deferred<unknown>>[] = [];
  let active = 0,
    maximum = 0;
  const read = (sourceId: string) => {
    const page = deferred<unknown>();
    pages.push(page);
    active++;
    maximum = Math.max(maximum, active);
    return page.promise.then((value) => {
      active--;
      return value;
    });
  };
  api.previewSourceFilter.mockImplementation(read);
  api.getSourceFilterOptions.mockImplementation(read);
  const readers = Array.from({ length: 8 }, (_, i) =>
    readFilterPreview(`fictional:${i}`, { ...policy, sourceId: `fictional:${i}` }),
  );
  readers.push(readFilterOptions("fictional:options", { kind: "label" }));
  const duplicate = readFilterPreview("fictional:0", { ...policy, sourceId: "fictional:0" });
  await flush();
  expect(pages).toHaveLength(2);
  for (let i = 0; i < 9; i++) {
    expect(pages[i]).toBeDefined();
    pages[i]!.resolve({ sourceId: i === 8 ? "fictional:options" : `fictional:${i}`, items: [] });
    await flush();
  }
  await Promise.all([...readers, duplicate]);
  expect(maximum).toBe(2);
  expect(api.previewSourceFilter).toHaveBeenCalledTimes(8);
});

test("one consumer abort cannot cancel another exact-policy reader, and finished results are not cached", async () => {
  const page = deferred<unknown>();
  api.previewSourceFilter
    .mockReturnValueOnce(page.promise)
    .mockResolvedValue({ sourceId: "fictional:one", items: [] });
  const a = new AbortController(),
    b = new AbortController();
  const first = readFilterPreview("fictional:one", policy, a.signal).catch((error: Error) => error);
  const second = readFilterPreview("fictional:one", policy, b.signal);
  await flush();
  a.abort();
  expect(api.previewSourceFilter.mock.calls[0]![2].aborted).toBe(false);
  page.resolve({ sourceId: "fictional:one", items: [] });
  expect(await first).toMatchObject({ name: "AbortError" });
  await second;
  await flush();
  await readFilterPreview("fictional:one", policy);
  expect(api.previewSourceFilter).toHaveBeenCalledTimes(2);
});

test("losing the last consumer retains the running server slot until the real response settles", async () => {
  const first = deferred<unknown>(),
    second = deferred<unknown>(),
    third = deferred<unknown>();
  api.previewSourceFilter
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  const controller = new AbortController();
  const a = readFilterPreview("fictional:a", policy, controller.signal).catch(
    (error: Error) => error,
  );
  const b = readFilterPreview("fictional:b", policy);
  const c = readFilterPreview("fictional:c", policy);
  await flush();
  controller.abort();
  await flush();
  expect(api.previewSourceFilter).toHaveBeenCalledTimes(2);
  expect(api.previewSourceFilter.mock.calls[0]![2].aborted).toBe(false);
  first.resolve({ sourceId: "fictional:a", items: [] });
  await flush();
  expect(api.previewSourceFilter).toHaveBeenCalledTimes(3);
  second.resolve({ sourceId: "fictional:b", items: [] });
  third.resolve({ sourceId: "fictional:c", items: [] });
  await Promise.all([a, b, c]);
});

test("an auth change rejects old reads, skips queued old work, and cannot repopulate labels or coalesce new credentials", async () => {
  const oldA = deferred<unknown>(),
    oldB = deferred<unknown>(),
    fresh = deferred<unknown>();
  api.previewSourceFilter
    .mockReturnValueOnce(oldA.promise)
    .mockReturnValueOnce(oldB.promise)
    .mockReturnValueOnce(fresh.promise);
  const a = readFilterPreview("fictional:one", policy).catch((error: Error) => error);
  const b = readFilterPreview("fictional:two", policy).catch((error: Error) => error);
  const queued = readFilterPreview("fictional:queued", policy).catch((error: Error) => error);
  await flush();
  clearScopeLabels();
  const current = readFilterPreview("fictional:one", policy);
  await flush();
  expect(api.previewSourceFilter).toHaveBeenCalledTimes(2);
  oldA.resolve({
    sourceId: "fictional:one",
    items: [{ ref: { kind: "label", id: "shared" }, label: "Old credential label" }],
  });
  await flush();
  expect(api.previewSourceFilter).toHaveBeenCalledTimes(3);
  expect(scopeDisplayLabel("fictional:one", { kind: "label", id: "shared" }).label).not.toBe(
    "Old credential label",
  );
  oldB.resolve({ sourceId: "fictional:two", items: [] });
  fresh.resolve({
    sourceId: "fictional:one",
    items: [{ ref: { kind: "label", id: "shared" }, label: "Current credential label" }],
  });
  expect(await a).toMatchObject({ name: "AbortError" });
  expect(await b).toMatchObject({ name: "AbortError" });
  expect(await queued).toMatchObject({ name: "AbortError" });
  await current;
  expect(scopeDisplayLabel("fictional:one", { kind: "label", id: "shared" }).label).toBe(
    "Current credential label",
  );
});

test("an identical request immediately after awaiting completion starts a fresh read", async () => {
  api.previewSourceFilter.mockResolvedValue({ sourceId: "fictional:one", items: [] });
  await readFilterPreview("fictional:one", policy);
  const fresh = readFilterPreview("fictional:one", policy);
  await flush();
  expect(api.previewSourceFilter).toHaveBeenCalledTimes(2);
  await fresh;
});
