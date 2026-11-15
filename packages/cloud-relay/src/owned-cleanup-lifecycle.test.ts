// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, test, vi } from "vitest";
import { OwnedCleanupLifecycle } from "./owned-cleanup-lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

test("close owns accepted work, refuses new admission and retains one proof", async () => {
  const lifecycle = new OwnedCleanupLifecycle();
  const gate = deferred(),
    started = deferred();
  const work = lifecycle.run(async () => {
    started.resolve();
    await gate.promise;
  });
  await started.promise;
  expect(lifecycle.receipt()).toMatchObject({ cleanupPending: true });
  const cleanup = vi.fn(async () => {});
  const close = lifecycle.close(cleanup);
  expect(lifecycle.close()).toBe(close);
  await expect(lifecycle.run(async () => {})).rejects.toThrow("closed");
  expect(cleanup).not.toHaveBeenCalled();
  gate.resolve();
  await work;
  await close;
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(lifecycle.receipt()).toBeUndefined();
});

test("an ordinary rejected operation remains joined and permits retry", async () => {
  const lifecycle = new OwnedCleanupLifecycle();
  const error = new Error("ordinary fixture error");
  await expect(
    lifecycle.run(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(lifecycle.receipt()).toBeUndefined();
  await expect(lifecycle.run(async () => 7)).resolves.toBe(7);
  await expect(lifecycle.close()).resolves.toBeUndefined();
});

test("terminal undefined markers survive close and independent cleanup errors", async () => {
  const lifecycle = new OwnedCleanupLifecycle();
  const marker = Object.assign(new Error("fixture uncertain"), { cleanupFailure: undefined });
  const error = new Error("wrapper", { cause: marker });
  await expect(
    lifecycle.run(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(lifecycle.receipt()).toBe(error);
  const first = vi.fn(async () => {
    throw new Error("ordinary close failure");
  });
  const second = vi.fn(async () => {});
  const close = lifecycle.close(first, second);
  await expect(close).rejects.toMatchObject({ cleanupFailure: undefined });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  expect(lifecycle.close()).toBe(close);
  await expect(lifecycle.run(async () => {})).rejects.toBe(error);
  expect(lifecycle.receipt()).toBe(error);
});

test("a rejected pending marker is terminal without an exposed late join proof", async () => {
  const lifecycle = new OwnedCleanupLifecycle();
  const marker = Object.assign(new Error("fixture source rejected"), {
    cleanupFailure: undefined,
    cleanupPending: true,
  });
  await expect(
    lifecycle.run(async () => {
      throw marker;
    }),
  ).rejects.toBe(marker);
  expect(lifecycle.receipt()).toMatchObject({ cleanupFailure: undefined, cause: marker });
  expect(Object.hasOwn(lifecycle.receipt()!, "cleanupPending")).toBe(false);
  await expect(lifecycle.close()).rejects.toBe(lifecycle.receipt());
});
