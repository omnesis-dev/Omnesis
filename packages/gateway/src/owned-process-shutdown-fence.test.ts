// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, expect, test, vi } from "vitest";
import { OwnedProcessShutdownFence } from "./owned-process-shutdown-fence.js";
import { TlsIssuerCleanupUnconfirmedError } from "./tls-lifecycle/issuer-cleanup.js";
import { CodexGenerationCleanupError } from "./models/codex-runtime-cleanup.js";

afterEach(() => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test("joined shutdown releases the lease and invokes its ordinary exit synchronously", async () => {
  const report = vi.fn(),
    release = vi.fn();
  const participant = { receipt: () => undefined, settle: () => Promise.resolve() };
  const fence = new OwnedProcessShutdownFence(report, [participant]);
  await fence.join(participant);
  fence.releaseLock({ release });
  const exit = new Error("invented process exit");
  expect(() =>
    fence.finish(() => {
      throw exit;
    }),
  ).toThrow(exit);
  expect(release).toHaveBeenCalledOnce();
  expect(report).not.toHaveBeenCalled();
});

test.each([
  ["TLS", new TlsIssuerCleanupUnconfirmedError(new Error("invented join failure"), undefined)],
  ["Codex", new CodexGenerationCleanupError(new Error("invented generation join failure"))],
])(
  "explicit %s uncertainty permits other teardown but prevents lease release and timeout exit",
  async (_kind, cleanup) => {
    vi.useFakeTimers();
    const events: string[] = [],
      review = vi.fn(() => new Promise<never>(() => {}));
    const participant = { receipt: () => cleanup, settle: () => Promise.reject(cleanup) };
    const fence = new OwnedProcessShutdownFence(
      () => events.push("reported"),
      [participant],
      review,
    );
    await fence.join(participant);
    events.push("other accepted cleanup");
    const release = vi.fn();
    fence.releaseLock({ release });
    const exit = vi.fn((): never => {
      throw new Error("must not exit after timeout");
    });
    const first = fence.finish(exit),
      second = fence.finish(exit);
    expect(first).toBe(second);
    expect(events).toEqual(["reported", "other accepted cleanup"]);
    expect(release).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(review).toHaveBeenCalledOnce();
  },
);

test("ordinary close errors remain visible rather than being inferred from error text", async () => {
  const review = vi.fn(() => new Promise<never>(() => {})),
    report = vi.fn();
  const failure = new Error("ordinary cleanup failure");
  const participant = { receipt: () => undefined, settle: () => Promise.reject(failure) };
  const fence = new OwnedProcessShutdownFence(report, [participant], review);
  await expect(fence.join(participant)).rejects.toBe(failure);
  expect(report).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
});

test("the default terminal review hold retains one referenced timer without polling services", async () => {
  vi.useFakeTimers();
  const timers = vi.spyOn(globalThis, "setInterval");
  const failure = { cleanupFailure: new Error("invented join failure") };
  const participant = { receipt: () => failure, settle: () => Promise.reject(failure) };
  const fence = new OwnedProcessShutdownFence(vi.fn(), [participant]);
  await fence.join(participant);
  const exit = vi.fn((): never => {
    throw new Error("must remain held");
  });
  void fence.finish(exit);
  void fence.finish(exit);
  expect(timers).toHaveBeenCalledOnce();
  expect(timers.mock.results[0]!.value.hasRef()).toBe(true);
  expect(exit).not.toHaveBeenCalled();
});

test("a pending disposal later joins without becoming a permanent review hold and keeps the timeout verdict", async () => {
  let resolve!: () => void;
  let receipt: unknown = { cleanupFailure: true, cleanupPending: true };
  const settle = vi.fn(
    () =>
      new Promise<void>((yes) => {
        resolve = yes;
      }),
  );
  const participant = { receipt: () => receipt, settle };
  const report = vi.fn(),
    review = vi.fn(() => new Promise<never>(() => {})),
    release = vi.fn();
  const fence = new OwnedProcessShutdownFence(report, [participant], review);
  fence.releaseLock({ release });
  const timedOut = true,
    exit = vi.fn((): never => {
      throw new Error(`exit ${timedOut ? 1 : 0}`);
    });
  const completion = fence.finish(exit);
  const rejected = expect(completion).rejects.toThrow("exit 1");
  await vi.waitFor(() => expect(settle).toHaveBeenCalledOnce());
  expect(release).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
  receipt = undefined;
  resolve();
  await rejected;
  expect(release).toHaveBeenCalledOnce();
  expect(exit).toHaveBeenCalledOnce();
  expect(report).not.toHaveBeenCalled();
  expect(review).not.toHaveBeenCalled();
});

test("tracked TLS close remains joined even before a terminal receipt exists", async () => {
  vi.useFakeTimers();
  const timers = vi.spyOn(globalThis, "setInterval");
  let resolve!: () => void;
  const participant = {
    receipt: () => undefined,
    settle: () =>
      new Promise<void>((yes) => {
        resolve = yes;
      }),
  };
  const fence = new OwnedProcessShutdownFence(vi.fn(), [participant]);
  const closing = fence.join(participant);
  expect(timers.mock.results[0]!.value.hasRef()).toBe(true);
  const exit = vi.fn((): never => {
    throw new Error("joined after deadline");
  });
  const completion = fence.finish(exit),
    rejected = expect(completion).rejects.toThrow("joined after deadline");
  await Promise.resolve();
  expect(exit).not.toHaveBeenCalled();
  resolve();
  await closing;
  await rejected;
  expect(exit).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

test.each([false, true])(
  "pending cleanup that rejects with pending tag %s retains its PID and lease for review",
  async (pendingTag) => {
    vi.useFakeTimers();
    let reject!: (error: unknown) => void;
    let receipt: unknown = { cleanupFailure: true, cleanupPending: true };
    const participant = {
      receipt: () => receipt,
      settle: () =>
        new Promise<void>((_yes, no) => {
          reject = no;
        }),
    };
    const report = vi.fn(),
      review = vi.fn(() => new Promise<never>(() => {})),
      release = vi.fn();
    const fence = new OwnedProcessShutdownFence(report, [participant], review);
    const closing = fence.join(participant);
    const exit = vi.fn((): never => {
      throw new Error("must not exit");
    });
    void fence.finish(exit);
    fence.releaseLock({ release });
    await Promise.resolve();
    const failed = {
      cleanupFailure: new Error("invented rejected join"),
      cleanupPending: pendingTag,
    };
    receipt = failed;
    reject(failed);
    await closing;
    await Promise.resolve();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledOnce();
    expect(review).toHaveBeenCalledOnce();
  },
);

test("accepted cleanup references the PID immediately and releases that reference after a positive join", async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  const timers = vi.spyOn(globalThis, "setInterval");
  const participant = {
    receipt: () => undefined,
    settle: () =>
      new Promise<void>((yes) => {
        resolve = yes;
      }),
  };
  const fence = new OwnedProcessShutdownFence(vi.fn(), [participant]);
  const closing = fence.join(participant);
  expect(timers).toHaveBeenCalledOnce();
  expect(timers.mock.results[0]!.value.hasRef()).toBe(true);
  await Promise.resolve();
  resolve();
  await closing;
  expect(vi.getTimerCount()).toBe(0);
});

test("an early Codex receipt is checked before its later disposal stage without starting a new command", async () => {
  vi.useFakeTimers();
  const cleanup = new CodexGenerationCleanupError(new Error("invented earlier generation failure"));
  const early = { receipt: () => undefined, settle: () => Promise.resolve() };
  const later = { receipt: () => cleanup, settle: vi.fn(() => Promise.resolve()) };
  const report = vi.fn(),
    release = vi.fn(),
    review = vi.fn(() => new Promise<never>(() => {}));
  const fence = new OwnedProcessShutdownFence(report, [early, later], review);
  await fence.join(early);
  fence.releaseLock({ release });
  const exit = vi.fn((): never => {
    throw new Error("must not exit");
  });
  void fence.finish(exit);
  expect(release).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
  expect(later.settle).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledOnce();
  expect(review).toHaveBeenCalledOnce();
});
