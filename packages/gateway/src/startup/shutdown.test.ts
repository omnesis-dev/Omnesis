// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStartupShutdown } from "./shutdown.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("shared startup shutdown", () => {
  it("shares one completion and drains once while preserving the first caller's exit code", async () => {
    const gate = deferred();
    const drain = vi.fn(() => gate.promise);
    const finish = vi.fn();
    const onFailure = vi.fn();
    const onTimeout = vi.fn();
    const shutdown = createStartupShutdown({
      drain,
      finish,
      onFailure,
      onTimeout,
      timeoutMs: 1000,
    });
    const first = shutdown(7);
    const repeated = shutdown(0);
    expect(repeated).toBe(first);
    await Promise.resolve();
    expect(drain).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
    gate.resolve();
    await expect(first).resolves.toBeUndefined();
    expect(finish).toHaveBeenCalledExactlyOnceWith(7);
    expect(shutdown(1)).toBe(first);
    expect(drain).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(onFailure).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("reports a rejected drain once and fulfills shared completion instead of recursively rejecting", async () => {
    const gate = deferred();
    const failure = new Error("Example cleanup failure");
    const events: string[] = [];
    const onFailure = vi.fn((error: unknown) => {
      expect(error).toBe(failure);
      events.push("failure");
    });
    const finish = vi.fn((code: number) => events.push(`finish:${code}`));
    const onTimeout = vi.fn();
    const shutdown = createStartupShutdown({
      drain: () => gate.promise,
      finish,
      onFailure,
      onTimeout,
      timeoutMs: 1000,
    });
    const first = shutdown();
    const second = shutdown();
    gate.reject(failure);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(events).toEqual(["failure", "finish:1"]);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(shutdown()).toBe(first);
    await vi.advanceTimersByTimeAsync(1000);
    expect(finish).toHaveBeenCalledOnce();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turns a synchronous drain throw into the same terminal failure", async () => {
    const failure = new Error("Example synchronous failure");
    const onFailure = vi.fn();
    const finish = vi.fn();
    const shutdown = createStartupShutdown({
      drain: () => {
        throw failure;
      },
      finish,
      onFailure,
      onTimeout: vi.fn(),
      timeoutMs: 1000,
    });
    await expect(shutdown()).resolves.toBeUndefined();
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(finish).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"] as const)(
    "times out once and ignores a late drain %s",
    async (settlement) => {
      const gate = deferred();
      const finish = vi.fn();
      const onTimeout = vi.fn();
      const onFailure = vi.fn();
      const shutdown = createStartupShutdown({
        drain: () => gate.promise,
        finish,
        onTimeout,
        onFailure,
        timeoutMs: 1000,
      });
      const first = shutdown();
      await vi.advanceTimersByTimeAsync(1000);
      await expect(first).resolves.toBeUndefined();
      expect(onTimeout).toHaveBeenCalledOnce();
      expect(finish).toHaveBeenCalledExactlyOnceWith(1);
      if (settlement === "resolve") gate.resolve();
      else gate.reject(new Error("Example late failure"));
      await Promise.resolve();
      await Promise.resolve();
      expect(shutdown()).toBe(first);
      expect(finish).toHaveBeenCalledOnce();
      expect(onFailure).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("still finishes when failure reporting throws", async () => {
    const finish = vi.fn();
    const shutdown = createStartupShutdown({
      drain: async () => {
        throw new Error("Example drain failure");
      },
      finish,
      onFailure: () => {
        throw new Error("Example reporter failure");
      },
      onTimeout: vi.fn(),
      timeoutMs: 1000,
    });
    await expect(shutdown()).resolves.toBeUndefined();
    expect(finish).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still finishes when timeout reporting throws", async () => {
    const gate = deferred();
    const finish = vi.fn();
    const shutdown = createStartupShutdown({
      drain: () => gate.promise,
      finish,
      onFailure: vi.fn(),
      onTimeout: () => {
        throw new Error("Example reporter failure");
      },
      timeoutMs: 1000,
    });
    const completion = shutdown();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(completion).resolves.toBeUndefined();
    expect(finish).toHaveBeenCalledExactlyOnceWith(1);
    gate.resolve();
    await Promise.resolve();
    expect(finish).toHaveBeenCalledOnce();
  });

  it("publishes shared completion before a drain synchronously re-enters shutdown", async () => {
    const finish = vi.fn();
    let repeated: Promise<void> | undefined;
    const shutdown = createStartupShutdown({
      drain: async () => {
        repeated = shutdown(1);
      },
      finish,
      onFailure: vi.fn(),
      onTimeout: vi.fn(),
      timeoutMs: 1000,
    });
    const completion = shutdown(0);
    await completion;
    expect(repeated).toBe(completion);
    expect(finish).toHaveBeenCalledExactlyOnceWith(0);
  });
});
