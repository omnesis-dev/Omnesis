// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { CollectorOwnedProcessShutdown } from "./owned-process-shutdown.js";
import { claimWatchdogExit, releaseWatchdogExit } from "./event-loop-watchdog-shared.js";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  const exited = new Error("invented process exit");
  const exit = vi.fn((_code: number): never => {
    throw exited;
  });
  const uncertain = vi.fn();
  const review = vi.fn(() => new Promise<never>(() => {}));
  return {
    shutdown: new CollectorOwnedProcessShutdown(uncertain, exit, review),
    exit,
    uncertain,
    review,
    exited,
  };
}

test("process exit closes admission and waits for the actual owner to join", async () => {
  const f = fixture();
  let resolve!: () => void;
  const joined = new Promise<void>((done) => (resolve = done));
  let receipt: unknown = Object.assign(new Error("invented active probe"), {
    cleanupFailure: undefined,
    cleanupPending: true,
  });
  const close = vi.fn(async () => {
    await joined;
    receipt = undefined;
    f.shutdown.ownershipChanged();
  });
  f.shutdown.attach({ cleanupFailure: () => receipt, close });
  expect(claimWatchdogExit(f.shutdown.exitHold)).toBe(false);
  const result = f.shutdown.finish(1);
  const verdict = expect(result).rejects.toBe(f.exited);
  await Promise.resolve();
  expect(close).toHaveBeenCalledOnce();
  expect(f.exit).not.toHaveBeenCalled();
  resolve();
  await verdict;
  expect(f.exit).toHaveBeenCalledWith(1);
  expect(Atomics.load(f.shutdown.exitHold, 0)).toBe(0);
});

test("terminal own undefined receipt retains the process after an ordinary close fulfillment", async () => {
  const f = fixture();
  const marker = Object.assign(new Error("invented uncertain operation"), {
    cleanupFailure: undefined,
  });
  f.shutdown.attach({ cleanupFailure: () => marker, close: async () => {} });
  void f.shutdown.finish(0);
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  expect(f.review).toHaveBeenCalledOnce();
  expect(f.uncertain).toHaveBeenCalledWith(marker);
  expect(f.exit).not.toHaveBeenCalled();
  expect(claimWatchdogExit(f.shutdown.exitHold)).toBe(false);
});

test("a claimed watchdog exit vetoes new ownership and cannot be cleared by a late idle notification", () => {
  const f = fixture();
  let receipt: unknown;
  f.shutdown.attach({ cleanupFailure: () => receipt, close: async () => {} });
  expect(claimWatchdogExit(f.shutdown.exitHold)).toBe(true);
  receipt = Object.assign(new Error("invented proposed operation"), {
    cleanupFailure: undefined,
    cleanupPending: true,
  });
  const launch = vi.fn();
  expect(() => {
    f.shutdown.ownershipChanged();
    launch();
  }).toThrow("already claimed");
  expect(launch).not.toHaveBeenCalled();
  receipt = undefined;
  f.shutdown.ownershipChanged();
  releaseWatchdogExit(f.shutdown.exitHold);
  expect(Atomics.load(f.shutdown.exitHold, 0)).toBe(-1);
});

test("explicit fatal cleanup markers remain owned even before Doctor construction", async () => {
  const f = fixture();
  const marker = new Error("invented startup failure", {
    cause: Object.assign(new Error("invented operation"), { cleanupFailure: undefined }),
  });
  expect(f.shutdown.observeFailure(marker)).toBe(true);
  void f.shutdown.finish(1);
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  expect(f.exit).not.toHaveBeenCalled();
  expect(f.review).toHaveBeenCalledOnce();
  expect(f.shutdown.cleanupFailure()).toBe(marker);
});

test("an idle owner is still closed before normal process exit", async () => {
  const f = fixture();
  const close = vi.fn(async () => {});
  f.shutdown.attach({ cleanupFailure: () => undefined, close });
  await expect(f.shutdown.finish(0)).rejects.toBe(f.exited);
  expect(close).toHaveBeenCalledOnce();
  expect(f.exit).toHaveBeenCalledWith(0);
});
