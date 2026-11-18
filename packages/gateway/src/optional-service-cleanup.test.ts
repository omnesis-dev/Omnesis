// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { closeOptionalServices, OptionalServiceCleanup } from "./optional-service-cleanup.js";
import { ownedProcessCleanupReceipt } from "./owned-process-cleanup.js";
import { OwnedProcessShutdownFence } from "./owned-process-shutdown-fence.js";

afterEach(() => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
});

test("independent service owners all close while another peer remains pending or fails", async () => {
  let finish!: () => void;
  const deferred = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ordinary = new Error("Invented DNS close failure");
  const marker = { cleanupFailure: undefined };
  const closes = [
    vi.fn(() => deferred),
    vi.fn(async () => {
      throw ordinary;
    }),
    vi.fn(async () => {
      throw marker;
    }),
  ];
  const owners = closes.map((close) => {
    const service = { close, cleanupFailure: () => undefined };
    return new OptionalServiceCleanup("Optional fixture", () => service);
  });
  const joined = closeOptionalServices(owners).catch((error: unknown) => error);
  await Promise.resolve();
  await Promise.resolve();
  for (const close of closes) expect(close).toHaveBeenCalledOnce();
  finish();
  const error = await joined;
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toContain(ordinary);
  expect(ownedProcessCleanupReceipt(error)).toEqual({ failure: undefined, pending: false });
});

test("ordinary independent close failures remain unmarked and joined services succeed", async () => {
  const errors = [
    new Error("Invented first close failure"),
    new Error("Invented second close failure"),
  ];
  const owners = errors.map((error) => {
    const service = {
      cleanupFailure: () => undefined,
      close: async () => {
        throw error;
      },
    };
    return new OptionalServiceCleanup("Optional fixture", () => service);
  });
  const observed: unknown = await closeOptionalServices(owners).catch((error: unknown) => error);
  expect(observed).toBeInstanceOf(AggregateError);
  expect(ownedProcessCleanupReceipt(observed)).toBeUndefined();
  await expect(closeOptionalServices([])).resolves.toBeUndefined();
});

test.each([undefined, new Error("Invented join failure")])(
  "retains startup uncertainty without a constructed service: %s",
  async (failure) => {
    const marker = { cleanupFailure: failure, cleanupPending: true };
    const startup = new Error("Invented startup failure", { cause: marker });
    const owner = new OptionalServiceCleanup("Optional fixture", () => undefined);
    expect(owner.captureFailure(startup)).toBe(true);
    expect(owner.hasTerminalFailure()).toBe(true);
    expect(ownedProcessCleanupReceipt(owner.receipt())).toEqual({ failure, pending: false });
    await expect(owner.settle()).rejects.toHaveProperty("cause", startup);
  },
);

test("ordinary unavailable services and joined cleanup errors remain unmarked", async () => {
  const error = new Error("Invented network outage");
  const empty = new OptionalServiceCleanup("Optional fixture", () => undefined);
  expect(empty.captureFailure(error)).toBe(false);
  expect(empty.receipt()).toBeUndefined();
  await expect(empty.settle()).resolves.toBeUndefined();
  const close = vi.fn(async () => {
    throw error;
  });
  const owner = new OptionalServiceCleanup("Optional fixture", () => ({
    cleanupFailure: () => undefined,
    close,
  }));
  await expect(owner.settle()).rejects.toBe(error);
  expect(owner.receipt()).toBeUndefined();
});

test("a retained successful close proof clears the service's real pending receipt", async () => {
  let resolve!: () => void;
  let receipt: unknown = { cleanupFailure: undefined, cleanupPending: true };
  const joined = new Promise<void>((done) => {
    resolve = done;
  });
  const service = {
    cleanupFailure: () => receipt,
    close: vi.fn(async () => {
      await joined;
      receipt = undefined;
    }),
  };
  const owner = new OptionalServiceCleanup("Optional fixture", () => service);
  const first = owner.settle(),
    second = owner.settle();
  expect(ownedProcessCleanupReceipt(owner.receipt())?.pending).toBe(true);
  expect(owner.hasTerminalFailure()).toBe(false);
  resolve();
  await Promise.all([first, second]);
  expect(service.close).toHaveBeenCalledOnce();
  expect(owner.receipt()).toBeUndefined();
});

test("startup uncertainty survives an independent ordinary close failure", async () => {
  const startup = { cleanupFailure: undefined };
  const closeFailure = new Error("Invented DNS cleanup failure");
  const service = {
    cleanupFailure: () => undefined,
    close: vi.fn(async () => {
      throw closeFailure;
    }),
  };
  const owner = new OptionalServiceCleanup("Optional fixture", () => service);
  owner.captureFailure(startup);
  const error: unknown = await owner.settle().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toContain(closeFailure);
  expect(ownedProcessCleanupReceipt(error)).toEqual({ failure: undefined, pending: false });
  expect(service.close).toHaveBeenCalledOnce();
});

test("a rejected service close cannot leave a recoverable pending receipt", async () => {
  const marker = { cleanupFailure: undefined, cleanupPending: true };
  const service = {
    cleanupFailure: () => marker,
    close: vi.fn(async () => {
      throw marker;
    }),
  };
  const owner = new OptionalServiceCleanup("Optional fixture", () => service);
  await expect(owner.settle()).rejects.toBeInstanceOf(AggregateError);
  expect(ownedProcessCleanupReceipt(owner.receipt())).toEqual({
    failure: undefined,
    pending: false,
  });
});

test("unassigned startup uncertainty fences both normal and watchdog exits", async () => {
  vi.useFakeTimers();
  const owner = new OptionalServiceCleanup("Optional fixture", () => undefined);
  owner.captureFailure({ cleanupFailure: undefined });
  const report = vi.fn(),
    release = vi.fn();
  const review = vi.fn(() => new Promise<never>(() => {}));
  const fence = new OwnedProcessShutdownFence(report, [owner], review);
  await fence.join(owner);
  fence.releaseLock({ release });
  const exit = vi.fn((): never => {
    throw new Error("Unexpected fixture exit");
  });
  expect(fence.finish(exit)).toBe(fence.finish(exit));
  expect(release).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledOnce();
  expect(review).toHaveBeenCalledOnce();
});
