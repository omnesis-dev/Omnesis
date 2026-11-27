// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";
import { ManagedDesktopNearbyCleanupError, type OwnedChildProcess } from "@omnesis/core";
import { DesktopNearbyHints, desktopNearbyCleanupRetry } from "./nearby-hints.js";

const profile = {
  configDir: "/example/desktop",
  instance: "desktop-" + "a".repeat(16),
  secretService: "dev.omnesis.desktop." + "a".repeat(64),
};
const invocation = () => ({ command: "/example/runtime-exec", args: ["--background-nearby"] });
function processBoundary() {
  const child = new ChildProcess();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}

test("unconfirmed stop latches the exact owner and blocks every subsequent spawn", async () => {
  const child = processBoundary();
  const refused = new Error("physical close unconfirmed");
  const joined = Promise.reject(refused);
  void joined.catch(() => {});
  const owner: OwnedChildProcess = {
    child,
    ready: Promise.resolve(),
    joined,
    joinedConfirmed: false,
    stop: vi.fn(async () => {
      throw refused;
    }),
  };
  const owned = vi.fn(() => owner);
  const provider = new DesktopNearbyHints(profile, { invocation, owned });
  await expect(provider.snapshot(new AbortController().signal)).rejects.toBeInstanceOf(
    ManagedDesktopNearbyCleanupError,
  );
  await expect(provider.snapshot(new AbortController().signal)).rejects.toBeInstanceOf(
    ManagedDesktopNearbyCleanupError,
  );
  const first = provider.close();
  expect(provider.close()).toBe(first);
  await expect(first).rejects.toBeInstanceOf(ManagedDesktopNearbyCleanupError);
  expect(owned).toHaveBeenCalledTimes(1);
  expect(owner.stop).toHaveBeenCalledTimes(1);
});

test("query elapsed time expires hints rather than renewing their native TTL", async () => {
  const child = processBoundary();
  let complete!: () => void;
  const joined = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let confirmed = false;
  const owner: OwnedChildProcess = {
    child,
    ready: Promise.resolve(),
    joined,
    get joinedConfirmed() {
      return confirmed;
    },
    stop: vi.fn(async () => {}),
  };
  const owned = vi.fn(() => {
    queueMicrotask(() => {
      child.stdout!.emit(
        "data",
        JSON.stringify({
          format: 1,
          generation: randomUUID(),
          sequence: 1,
          state: "ready",
          candidates: [
            { address: "192.168.1.1", port: 443, remainingMs: 50 },
            { address: "192.168.1.2", port: 443, remainingMs: 1000 },
          ],
        }) + "\n",
      );
      child.emit("exit", 0, null);
      confirmed = true;
      complete();
    });
    return owner;
  });
  const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(1100);
  const provider = new DesktopNearbyHints(profile, { invocation, owned, now });
  expect(await provider.snapshot(new AbortController().signal)).toEqual([
    { address: "192.168.1.2", port: 443 },
  ]);
  await provider.close();
  expect(owner.stop).not.toHaveBeenCalled();
});

test("unregistered source adapter is unavailable without creating a native child", async () => {
  const owned = vi.fn();
  const provider = new DesktopNearbyHints(profile, { invocation: () => null, owned });
  expect(await provider.snapshot(new AbortController().signal)).toEqual([]);
  expect(provider.state).toBe("unavailable");
  await provider.close();
  expect(owned).not.toHaveBeenCalled();
});

test("signal error after authoritative physical join does not latch uncertain cleanup", async () => {
  const owned = vi.fn(() => {
    const child = processBoundary();
    let confirmed = false;
    const joined = Promise.reject(new Error("query refused"));
    void joined.catch(() => {});
    return {
      child,
      ready: Promise.resolve(),
      joined,
      get joinedConfirmed() {
        return confirmed;
      },
      stop: vi.fn(async () => {
        confirmed = true;
        throw new Error("signal raced with exit");
      }),
    };
  });
  const provider = new DesktopNearbyHints(profile, { invocation, owned });
  await expect(provider.snapshot(new AbortController().signal)).rejects.toThrow("query refused");
  await expect(provider.snapshot(new AbortController().signal)).rejects.toThrow("query refused");
  expect(owned).toHaveBeenCalledTimes(2);
  await provider.close();
});

test("canceling a query keeps close pending until its owned native child actually joins", async () => {
  const child = processBoundary();
  let joined!: () => void;
  let confirmed = false;
  const physical = new Promise<void>((resolve) => {
    joined = resolve;
  });
  const owner: OwnedChildProcess = {
    child,
    ready: Promise.resolve(),
    joined: physical,
    get joinedConfirmed() {
      return confirmed;
    },
    stop: vi.fn(() => physical),
  };
  const provider = new DesktopNearbyHints(profile, { invocation, owned: () => owner });
  const observed = provider.snapshot(new AbortController().signal).catch((error: unknown) => error);
  let finished = false;
  const closing = provider.close().then(() => {
    finished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(finished).toBe(false);
  expect(owner.stop).toHaveBeenCalledTimes(1);
  child.emit("exit", 0, null);
  confirmed = true;
  joined();
  await closing;
  expect(await observed).toBeInstanceOf(Error);
  expect(finished).toBe(true);
  expect(owner.stop).toHaveBeenCalledTimes(1);
});

test("explicit cleanup retry observes the same owner and can recover only after authoritative join", async () => {
  const child = processBoundary();
  const refused = new Error("owned query join not confirmed");
  const joined = Promise.reject(refused);
  void joined.catch(() => {});
  let confirmed = false;
  const owner: OwnedChildProcess = {
    child,
    ready: Promise.resolve(),
    joined,
    get joinedConfirmed() {
      return confirmed;
    },
    stop: vi.fn(async () => {
      throw refused;
    }),
  };
  const owned = vi.fn(() => owner);
  const provider = new DesktopNearbyHints(profile, { invocation, owned });
  const failure = await provider
    .snapshot(new AbortController().signal)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ManagedDesktopNearbyCleanupError);
  const startup = new Error("the original transport startup failed");
  const original = new AggregateError([startup, failure], "startup plus cleanup");
  const retry = desktopNearbyCleanupRetry(original)!;
  await expect(retry()).rejects.toBe(original);
  await expect(provider.close()).rejects.toBe(failure);
  expect(owned).toHaveBeenCalledTimes(1);
  expect(owner.stop).toHaveBeenCalledTimes(1);
  confirmed = true;
  await retry();
  await provider.close();
  await provider.close();
  expect(owned).toHaveBeenCalledTimes(1);
  expect(owner.stop).toHaveBeenCalledTimes(1);
  expect(() => provider.snapshot(new AbortController().signal)).toThrow();
});

test("opaque cleanup failure stays refused and ordinary startup errors do not acquire a cleanup owner", async () => {
  const ordinary = new Error("ordinary transport startup failure");
  expect(desktopNearbyCleanupRetry(ordinary)).toBeUndefined();
  const opaque = new ManagedDesktopNearbyCleanupError(undefined);
  const retry = desktopNearbyCleanupRetry(new AggregateError([ordinary, opaque]))!;
  await expect(retry()).rejects.toBeInstanceOf(AggregateError);
});

test("truncated aggregate breadth cannot hide a managed owner behind duplicate ordinary errors", async () => {
  const ordinary = new Error("the same ordinary error repeated");
  const prefix = Array.from({ length: 32 }, () => ordinary);
  const managed = new ManagedDesktopNearbyCleanupError(undefined);
  const hidden = new AggregateError([...prefix, managed], "the omitted tail owns cleanup");
  const retry = desktopNearbyCleanupRetry(hidden);
  expect(retry).toBeTypeOf("function");
  await expect(retry!()).rejects.toBe(hidden);
  // Known-complete duplicate graphs remain ordinary; incomplete ordinary graphs fail closed too.
  expect(desktopNearbyCleanupRetry(new AggregateError(prefix))).toBeUndefined();
  const incomplete = new AggregateError([...prefix, ordinary]);
  const refused = desktopNearbyCleanupRetry(incomplete);
  expect(refused).toBeTypeOf("function");
  await expect(refused!()).rejects.toBe(incomplete);
});

test("typed uncertain cleanup preserves both the original query failure and cleanup cause", async () => {
  const child = processBoundary();
  const primary = new Error("the owned query failed before reply");
  const cleanup = new Error("the exact owner cleanup could not be confirmed");
  const joined = Promise.reject(primary);
  void joined.catch(() => {});
  const stop = vi.fn(async () => {
    throw cleanup;
  });
  const provider = new DesktopNearbyHints(profile, {
    invocation,
    owned: () => ({ child, ready: Promise.resolve(), joined, joinedConfirmed: false, stop }),
  });
  const failure = await provider
    .snapshot(new AbortController().signal)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ManagedDesktopNearbyCleanupError);
  const cause = (failure as ManagedDesktopNearbyCleanupError).cause;
  expect(cause).toBeInstanceOf(AggregateError);
  expect((cause as AggregateError).errors).toEqual([primary, cleanup]);
  expect((cause as AggregateError).cause).toBe(cleanup);
  expect(stop).toHaveBeenCalledTimes(1);
  await expect(provider.close()).rejects.toBe(failure);
  expect(stop).toHaveBeenCalledTimes(1);
});

test("an ordinary empty query result cannot suppress unconfirmed owned cleanup", async () => {
  const child = processBoundary();
  const cleanup = new Error("the query root closed without confirmed cleanup");
  const stop = vi.fn(async () => {
    throw cleanup;
  });
  const provider = new DesktopNearbyHints(profile, {
    invocation,
    owned: () => {
      queueMicrotask(() => child.emit("exit", 1, null));
      return {
        child,
        ready: Promise.resolve(),
        joined: Promise.resolve(),
        joinedConfirmed: false,
        stop,
      };
    },
  });
  // A resolved observation or ordinary refused reply alone is not the owner's confirmation flag.
  const failure = await provider
    .snapshot(new AbortController().signal)
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ManagedDesktopNearbyCleanupError);
  expect((failure as ManagedDesktopNearbyCleanupError).cause).toBe(cleanup);
  expect(stop).toHaveBeenCalledTimes(1);
  await expect(provider.close()).rejects.toBe(failure);
});
