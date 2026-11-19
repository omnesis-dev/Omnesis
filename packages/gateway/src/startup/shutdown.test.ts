// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStartupShutdown, StartupOwnership } from "./shutdown.js";
import { StartupOperations } from "./operations.js";
import { OptionalServiceCleanup } from "../optional-service-cleanup.js";

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
  it("does not fulfill shared completion ahead of an asynchronous terminal ownership proof", async () => {
    const proof = deferred();
    const finish = vi.fn(() => proof.promise);
    const shutdown = createStartupShutdown({
      drain: async () => {},
      finish,
      onFailure: vi.fn(),
      onTimeout: vi.fn(),
      timeoutMs: 1000,
    });
    let complete = false;
    const stopping = shutdown().then(() => {
      complete = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(finish).toHaveBeenCalledOnce();
    expect(complete).toBe(false);
    proof.resolve();
    await stopping;
    expect(complete).toBe(true);
  });

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

describe("startup ownership across partial runtime initialization", () => {
  it.each(["late service", "conversation lifecycle"] as const)(
    "closes an asynchronously installed %s only after its factory settles",
    async (kind) => {
      const operations = new StartupOperations();
      const factory = deferred();
      const cleanupStarted = deferred();
      const cleanupAllowed = deferred();
      const ownership = new StartupOwnership({
        drainOperations: () => operations.drain(),
        onUncertain: vi.fn(),
        onCleanupFailure: vi.fn(),
      });
      let installed = false;
      const service = {
        cleanupFailure: () => undefined,
        close: vi.fn(async () => {
          expect(installed).toBe(true);
          cleanupStarted.resolve();
          await cleanupAllowed.promise;
        }),
      };
      // A conversation owner exists before bootAgent installs its service;
      // an async factory's service object itself is assigned only on return.
      let assigned = kind === "conversation lifecycle" ? service : undefined;
      const owner = new OptionalServiceCleanup("Example async service", () => assigned);
      const boot = operations.track(
        (async () => {
          try {
            await factory.promise;
            installed = true;
            assigned = service;
          } finally {
            ownership.own(owner);
          }
        })(),
      );
      ownership.abort();
      ownership.closePartial();
      const lock = { release: vi.fn() };
      ownership.fence.releaseLock(lock);
      const exit = vi.fn((): never => {
        throw new Error("Example process exit");
      });
      const finishing = ownership.fence.finish(exit).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      expect(service.close).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      factory.resolve();
      await boot;
      await cleanupStarted.promise;
      expect(service.close).toHaveBeenCalledOnce();
      expect(lock.release).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      cleanupAllowed.resolve();
      await finishing;
      expect(lock.release).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
    },
  );

  it("retains a rejected factory's cleanup receipt even when it never assigns a service", async () => {
    const operations = new StartupOperations();
    const factory = deferred();
    const uncertain = vi.fn();
    const ownership = new StartupOwnership({
      drainOperations: () => operations.drain(),
      onUncertain: uncertain,
      onCleanupFailure: vi.fn(),
    });
    const owner = new OptionalServiceCleanup("Example async service", () => undefined);
    const failure = Object.assign(new Error("Example rejected factory"), {
      cleanupFailure: new Error("Example owned process closure is unconfirmed"),
    });
    const boot = operations.track(
      (async () => {
        try {
          await factory.promise;
        } catch (error) {
          owner.captureFailure(error);
          throw error;
        } finally {
          ownership.own(owner);
        }
      })(),
    );
    const rejected = expect(boot).rejects.toBe(failure);
    ownership.abort();
    ownership.closePartial();
    const lock = { release: vi.fn() };
    ownership.fence.releaseLock(lock);
    const exit = vi.fn((): never => {
      throw new Error("Example process exit");
    });
    void ownership.fence.finish(exit);
    factory.reject(failure);
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    expect(uncertain).toHaveBeenCalledOnce();
    expect(lock.release).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("joins a late enrolled child after the boot budget expires before releasing the install lock", async () => {
    const operations = new StartupOperations();
    const initialization = deferred();
    const childClosed = deferred();
    const childCleanup = vi.fn(() => childClosed.promise);
    const uncertain = vi.fn();
    const ownership = new StartupOwnership({
      drainOperations: () => operations.drain(),
      onUncertain: uncertain,
      onCleanupFailure: vi.fn(),
    });
    const boot = operations.track(
      initialization.promise.then(() => {
        ownership.own({ receipt: () => undefined, settle: childCleanup });
      }),
    );
    ownership.abort();
    ownership.closePartial();
    const lock = { release: vi.fn() };
    ownership.fence.releaseLock(lock);
    const exit = vi.fn((): never => {
      throw new Error("Example process exit");
    });
    const timeout = vi.fn();
    const shutdown = createStartupShutdown({
      drain: () => operations.drain(),
      finish: () => ownership.fence.finish(exit),
      onFailure: vi.fn(),
      onTimeout: timeout,
      timeoutMs: 1000,
    });
    let complete = false;
    const stopping = shutdown().then(() => {
      complete = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(timeout).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
    expect(complete).toBe(false);
    initialization.resolve();
    await boot;
    await vi.advanceTimersByTimeAsync(0);
    expect(childCleanup).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
    childClosed.resolve();
    await stopping;
    expect(exit).toHaveBeenCalledOnce();
    expect(lock.release).toHaveBeenCalledOnce();
    expect(uncertain).not.toHaveBeenCalled();
  });

  it("lets an interrupted tracked runtime unwind without awaiting its own operations-drain proof", async () => {
    const operations = new StartupOperations();
    const runtimeEntered = deferred();
    const unwindRuntime = deferred();
    const childClosed = deferred();
    const childCleanup = vi.fn(() => childClosed.promise);
    const ownership = new StartupOwnership({
      drainOperations: () => operations.drain(),
      onUncertain: vi.fn(),
      onCleanupFailure: vi.fn(),
    });
    const child = ownership.own({ receipt: () => undefined, settle: childCleanup });
    const runtime = operations.track(
      (async () => {
        runtimeEntered.resolve();
        await unwindRuntime.promise;
        // Runtime cancellation returns to its caller, rather than awaiting
        // shutdown inside the operation that the ownership proof is joining.
      })(),
    );
    const exit = vi.fn((): never => {
      throw new Error("Example process exit");
    });
    const shutdown = createStartupShutdown({
      async drain() {
        ownership.abort();
        const cleanup = ownership.fence.join(child);
        unwindRuntime.resolve();
        await cleanup;
      },
      finish: () => ownership.fence.finish(exit),
      onFailure: vi.fn(),
      onTimeout: vi.fn(),
      timeoutMs: 1000,
    });
    await runtimeEntered.promise;
    const stopping = shutdown();
    await runtime;
    expect(exit).not.toHaveBeenCalled();
    childClosed.resolve();
    await stopping;
    expect(childCleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("retains the PID and lease for terminal cleanup uncertainty even after timeout", async () => {
    const uncertain = vi.fn();
    const ownership = new StartupOwnership({
      drainOperations: async () => {},
      onUncertain: uncertain,
      onCleanupFailure: vi.fn(),
    });
    const failure = Object.assign(new Error("Example unconfirmed issuer cleanup"), {
      cleanupFailure: new Error("Example owned process closure is unconfirmed"),
    });
    ownership.captureFailure(failure);
    ownership.abort();
    ownership.closePartial();
    const lock = { release: vi.fn() };
    ownership.fence.releaseLock(lock);
    const exit = vi.fn((): never => {
      throw new Error("Example process exit");
    });
    const shutdown = createStartupShutdown({
      drain: () => new Promise<void>(() => {}),
      finish: () => ownership.fence.finish(exit),
      onFailure: vi.fn(),
      onTimeout: vi.fn(),
      timeoutMs: 1000,
    });
    let complete = false;
    void shutdown().then(() => {
      complete = true;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(uncertain).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
    expect(complete).toBe(false);
  });
});
