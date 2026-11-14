// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { waitForWindowsTreeExit } from "./windows-tree-drain.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

test("retries an unavailable snapshot within the existing grace and requires verified exit", async () => {
  const failure = new Error("Invented unavailable process metadata");
  const refresh = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue(undefined);
  const pending = waitForWindowsTreeExit({ refresh, alive: false }, () => true, 50);
  const verdict = expect(pending).resolves.toBe(true);
  await Promise.all([verdict, vi.runAllTimersAsync()]);
});

test("persistent metadata uncertainty rejects instead of releasing an apparently empty tree", async () => {
  const failure = new Error("Invented persistent process metadata failure");
  const refresh = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
  const pending = waitForWindowsTreeExit({ refresh, alive: false }, () => true, 50);
  const verdict = expect(pending).rejects.toBe(failure);
  await Promise.all([verdict, vi.runAllTimersAsync()]);
  expect(Date.now()).toBeGreaterThanOrEqual(50);
});

test("a successful snapshot still cannot release a living original root", async () => {
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const pending = waitForWindowsTreeExit({ refresh, alive: false }, () => false, 50);
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toBe(false);
});

test("a current live descendant holds the lane until the grace ends", async () => {
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const pending = waitForWindowsTreeExit({ refresh, alive: true }, () => true, 50);
  await vi.runAllTimersAsync();
  await expect(pending).resolves.toBe(false);
});
