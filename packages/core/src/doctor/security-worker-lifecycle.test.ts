// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as scans from "./security-worker.js";
import type { EventEmitter } from "node:events";
import type { SecurityData } from "./types.js";

const fixtures = vi.hoisted(() => ({
  workers: [] as EventEmitter[],
  events: [] as string[],
  onCreate: undefined as (() => void) | undefined,
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      constructor() {
        super();
        fixtures.events.push("worker-created");
        fixtures.workers.push(this);
        fixtures.onCreate?.();
      }
      unref() {
        return this;
      }
      ref() {
        return this;
      }
      terminate = vi.fn(async () => 0);
    },
  };
});

interface Scanner {
  collect(): Promise<SecurityData>;
  cleanupFailure(): unknown;
  close(): Promise<void>;
}
function scanner(onOwnershipChanged?: () => void): Scanner {
  const Constructor = (
    scans as typeof scans & {
      DoctorSecurityScanner?: new (options: {
        configDir: string;
        onOwnershipChanged?: () => void;
      }) => Scanner;
    }
  ).DoctorSecurityScanner;
  if (Constructor) return new Constructor({ configDir: "invented-config", onOwnershipChanged });
  // The original public launcher supplies the behavioral RED baseline.
  return {
    collect: () => scans.collectSecurityDataInWorker({ configDir: "invented-config" }),
    cleanupFailure: () => undefined,
    close: async () => {},
  };
}
const security = { configDir: "invented-config", fixPermissions: false } as SecurityData;
const current = () => fixtures.workers.at(-1)!;
beforeEach(() => {
  fixtures.workers.length = 0;
  fixtures.events.length = 0;
  fixtures.onCreate = undefined;
  vi.useFakeTimers();
});
afterEach(() => {
  for (const worker of fixtures.workers) worker.emit("exit", 0);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("a completed payload cannot settle collection or close before natural worker exit", async () => {
  const owner = scanner();
  const collecting = owner.collect();
  let reported = false,
    closed = false;
  void collecting.then(
    () => {
      reported = true;
    },
    () => {},
  );
  current().emit("message", { type: "done", security });
  const closing = owner.close();
  void closing.then(
    () => {
      closed = true;
    },
    () => {},
  );
  await Promise.resolve();
  expect(reported).toBe(false);
  expect(closed).toBe(false);
  expect(owner.cleanupFailure()).toMatchObject({ cleanupPending: true });
  current().emit("exit", 0);
  await expect(collecting).resolves.toBe(security);
  await closing;
  expect(owner.cleanupFailure()).toBeUndefined();
  expect(
    (current() as EventEmitter & { terminate: ReturnType<typeof vi.fn> }).terminate,
  ).not.toHaveBeenCalled();
});

test("the observation deadline remains failed after late positive join and blocks duplicate work", async () => {
  const owner: Scanner = scanner(() => {
    fixtures.events.push(owner.cleanupFailure() ? "ownership-changed" : "ownership-cleared");
  });
  const collecting = owner.collect();
  const timedOut = expect(collecting).rejects.toThrow("timed out after 30000ms");
  await vi.advanceTimersByTimeAsync(30_000);
  await timedOut;
  expect(owner.collect()).toBe(collecting);
  expect(fixtures.workers).toHaveLength(1);
  expect(fixtures.events.slice(0, 2)).toEqual(["ownership-changed", "worker-created"]);
  current().emit("message", { type: "done", security });
  current().emit("exit", 0);
  await expect(collecting).rejects.toThrow("timed out");
  expect(owner.cleanupFailure()).toBeUndefined();
  await owner.close();
});

test.each([false, true])(
  "explicit undefined receipt survives completion and repeated close (%s)",
  async (late) => {
    const owner = scanner();
    const collecting = owner.collect();
    void collecting.catch(() => {});
    if (late) await vi.advanceTimersByTimeAsync(30_000);
    current().emit("message", {
      type: "error",
      error: "Invented private operation was not joined",
      cleanupFailure: undefined,
    });
    expect(owner.cleanupFailure()).toMatchObject({ cleanupFailure: undefined });
    expect(Object.hasOwn(owner.cleanupFailure() as object, "cleanupFailure")).toBe(true);
    const closing = owner.close();
    void closing.catch(() => {});
    expect(owner.close()).toBe(closing);
    current().emit("exit", 0);
    await expect(closing).rejects.toMatchObject({ cleanupFailure: undefined });
    await expect(owner.collect()).rejects.toMatchObject({ cleanupFailure: undefined });
    expect(fixtures.workers).toHaveLength(1);
  },
);

test("a joined ordinary worker error is reportable and permits another scan", async () => {
  const owner = scanner();
  const collecting = owner.collect();
  void collecting.catch(() => {});
  current().emit("message", { type: "error", error: "Invented ordinary unavailable state" });
  current().emit("exit", 0);
  await expect(collecting).rejects.toThrow("Invented ordinary unavailable state");
  expect(owner.cleanupFailure()).toBeUndefined();
  const next = owner.collect();
  current().emit("message", { type: "done", security });
  current().emit("exit", 0);
  await expect(next).resolves.toBe(security);
  await owner.close();
});

test.each(["missing", "invalid", "duplicate", "error"])(
  "%s completion cannot prove Native work joined",
  async (kind) => {
    const owner = scanner();
    const collecting = owner.collect();
    void collecting.catch(() => {});
    if (kind === "invalid") current().emit("message", { type: "unexpected" });
    if (kind === "duplicate") {
      current().emit("message", { type: "done", security });
      current().emit("message", { type: "done", security });
    }
    if (kind === "error") current().emit("error", new Error("Invented worker failure"));
    current().emit("exit", 0);
    await expect(collecting).rejects.toMatchObject({ cleanupFailure: undefined });
    await expect(owner.close()).rejects.toMatchObject({ cleanupFailure: undefined });
  },
);

test("standalone convenience retains its owner until late join and preserves failed observation", async () => {
  const collecting = scans.collectSecurityDataInWorker({
    configDir: "invented-config",
    timeoutMs: 10,
  });
  let settled = false;
  void collecting.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.advanceTimersByTimeAsync(10);
  expect(settled).toBe(false);
  current().emit("message", { type: "done", security });
  current().emit("exit", 0);
  await expect(collecting).rejects.toThrow("timed out after 10ms");
});

test("a failed synchronous ownership notification cannot launch a worker", async () => {
  const owner = scanner(() => {
    throw undefined;
  });
  await expect(owner.collect()).rejects.toBeUndefined();
  expect(fixtures.workers).toHaveLength(0);
  expect(owner.cleanupFailure()).toBeUndefined();
  await owner.close();
});

test("a close triggered by the ownership notification refuses a later worker launch", async () => {
  const owner: Scanner = scanner(() => {
    void owner.close();
  });
  await expect(owner.collect()).rejects.toThrow("closed");
  expect(fixtures.workers).toHaveLength(0);
  await owner.close();
});

test("synchronous setup cannot start a worker after the observation budget is exhausted", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const owner: Scanner = scanner(() => {
    if (owner.cleanupFailure()) now = 30_000;
  });
  await expect(owner.collect()).rejects.toThrow("timed out after 30000ms");
  expect(fixtures.workers).toHaveLength(0);
  expect(owner.cleanupFailure()).toBeUndefined();
  await owner.close();
});

test("worker constructor time consumes the same cumulative observation budget", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  fixtures.onCreate = () => {
    now = 10_000;
  };
  const owner = scanner(),
    collecting = owner.collect();
  let failed = false;
  void collecting.catch(() => {
    failed = true;
  });
  now = 29_999;
  await vi.advanceTimersByTimeAsync(19_999);
  expect(failed).toBe(false);
  now = 30_000;
  await vi.advanceTimersByTimeAsync(1);
  expect(failed).toBe(true);
  current().emit("message", { type: "done", security });
  current().emit("exit", 0);
  await expect(collecting).rejects.toThrow("timed out after 30000ms");
  await owner.close();
});

test("a late exit cannot beat an overdue observation timer and become successful", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const owner = scanner(),
    collecting = owner.collect();
  void collecting.catch(() => {});
  current().emit("message", { type: "done", security });
  // The timer is deliberately not dispatched: event-loop delay cannot extend the budget.
  now = 30_001;
  current().emit("exit", 0);
  await expect(collecting).rejects.toThrow("timed out after 30000ms");
  expect(owner.cleanupFailure()).toBeUndefined();
  await owner.close();
});
