// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ownedProcessCleanupReceipt } from "@omnesis/core";
import { TunnelSessionRenewal } from "./tunnel-session-renewal.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const helpers = new Set<TunnelSessionRenewal>();
function fixture(expiresAt = 3600) {
  const callbacks = {
    expiresAt,
    session: "initial-routing-session",
    acquire: vi.fn(async (_controller: AbortController) => "fresh-routing-session"),
    joined: vi.fn(async () => {}),
    invalidate: vi.fn(),
    send: vi.fn(),
    adopt: vi.fn(),
    observe: vi.fn(),
    terminate: vi.fn(),
  };
  const renewal = new TunnelSessionRenewal(callbacks);
  helpers.add(renewal);
  return { renewal, ...callbacks };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const helper of helpers) helper.stop();
  helpers.clear();
  vi.useRealTimers();
});

const due = () => vi.advanceTimersByTimeAsync(3_540_000);
const flush = () => vi.advanceTimersByTimeAsync(0);

test("fresh proof is requested before the deadline and becomes usable only after acknowledgement", async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(3_539_999);
  expect(f.acquire).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.invalidate).toHaveBeenCalledTimes(1);
  expect(f.acquire).toHaveBeenCalledTimes(1);
  expect(f.send).toHaveBeenCalledExactlyOnceWith("fresh-routing-session");
  expect(f.adopt).not.toHaveBeenCalled();
  expect(f.terminate).not.toHaveBeenCalled();
  expect(f.renewal.accept(7200)).toBe(true);
  expect(f.adopt).toHaveBeenCalledExactlyOnceWith("fresh-routing-session");
  await vi.advanceTimersByTimeAsync(60_001);
  expect(f.terminate).not.toHaveBeenCalled();
});

test("multiple acknowledged renewals preserve authority across both original deadlines", async () => {
  const f = fixture();
  f.acquire.mockResolvedValueOnce("second-session").mockResolvedValueOnce("third-session");
  await due();
  expect(f.renewal.accept(7200)).toBe(true);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(f.send.mock.calls).toEqual([["second-session"], ["third-session"]]);
  expect(f.renewal.accept(10_800)).toBe(true);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(f.adopt.mock.calls).toEqual([["second-session"], ["third-session"]]);
  expect(f.terminate).not.toHaveBeenCalled();
});

test("unsolicited, unchanged, malformed and replayed acknowledgements cannot install credentials", async () => {
  const f = fixture();
  expect(f.renewal.accept(7200)).toBe(false);
  await due();
  for (const expiry of [3600, 3599, NaN, Infinity, 7200.5, Number.MAX_SAFE_INTEGER])
    expect(f.renewal.accept(expiry)).toBe(false);
  expect(f.adopt).not.toHaveBeenCalled();
  expect(f.renewal.accept(7200)).toBe(true);
  expect(f.renewal.accept(7200)).toBe(false);
  expect(f.renewal.accept(10_800)).toBe(false);
  expect(f.adopt).toHaveBeenCalledTimes(1);
  f.acquire.mockResolvedValueOnce("next-routing-session");
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(f.renewal.accept(7200)).toBe(false);
  expect(f.adopt).toHaveBeenCalledTimes(1);
  expect(f.renewal.accept(10_800)).toBe(true);
});

test("a missing acknowledgement closes the tunnel without adopting the unaccepted token", async () => {
  const f = fixture();
  await due();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(f.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.terminate).toHaveBeenCalledTimes(1);
  expect(f.adopt).not.toHaveBeenCalled();
  expect(f.renewal.accept(7200)).toBe(false);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(f.acquire).toHaveBeenCalledTimes(1);
  expect(f.terminate).toHaveBeenCalledTimes(1);
});

test("an externally supplied unchanged credential keeps its original deadline and is never submitted as renewal", async () => {
  const f = fixture(90);
  f.acquire.mockResolvedValue("initial-routing-session");
  await vi.advanceTimersByTimeAsync(89_999);
  expect(f.acquire).toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.adopt).not.toHaveBeenCalled();
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.terminate).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.terminate).toHaveBeenCalledTimes(1);
});

test("the original expiry closes and cancels an unresolved proof; late success cannot revive it", async () => {
  const f = fixture(90);
  const proof = deferred<string>();
  f.acquire.mockImplementationOnce(() => proof.promise);
  await vi.advanceTimersByTimeAsync(60_000);
  const controller = f.acquire.mock.calls[0]![0];
  expect(controller.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(controller.signal.aborted).toBe(true);
  expect(f.terminate).toHaveBeenCalledTimes(1);
  proof.resolve("too-late-session");
  await flush();
  expect(f.send).not.toHaveBeenCalled();
  expect(f.adopt).not.toHaveBeenCalled();
  expect(f.renewal.accept(7200)).toBe(false);
});

test("transient proof failure retries only after the underlying credential work has joined", async () => {
  const f = fixture();
  const joined = deferred<void>();
  const failure = new Error("fictional proof service unavailable");
  f.acquire.mockRejectedValueOnce(failure).mockResolvedValueOnce("recovered-session");
  f.joined.mockReturnValueOnce(joined.promise);
  await due();
  expect(f.observe).toHaveBeenCalledExactlyOnceWith(failure);
  expect(f.send).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(f.acquire).toHaveBeenCalledTimes(1);
  joined.resolve();
  await flush();
  await vi.advanceTimersByTimeAsync(999);
  expect(f.acquire).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.acquire).toHaveBeenCalledTimes(2);
  expect(f.send).toHaveBeenCalledExactlyOnceWith("recovered-session");
  expect(f.renewal.accept(7200)).toBe(true);
  expect(f.terminate).not.toHaveBeenCalled();
});

test.each(["resolve", "reject"])(
  "stop cancels proof and ignores a late %s without scheduling a retry",
  async (outcome) => {
    const f = fixture();
    const proof = deferred<string>();
    f.acquire.mockImplementationOnce(() => proof.promise);
    await due();
    f.renewal.stop();
    expect(f.acquire.mock.calls[0]![0].signal.aborted).toBe(true);
    if (outcome === "resolve") proof.resolve("late-session");
    else proof.reject(new Error("cancelled fixture proof"));
    await flush();
    await vi.advanceTimersByTimeAsync(3_600_000);
    await f.renewal.close();
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(f.send).not.toHaveBeenCalled();
    expect(f.adopt).not.toHaveBeenCalled();
    expect(f.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("close waits for accepted proof work after cancellation rather than reporting premature cleanup", async () => {
  const f = fixture();
  const proof = deferred<string>();
  f.acquire.mockImplementationOnce(() => proof.promise);
  await due();
  const closed = vi.fn();
  const close = f.renewal.close().then(closed);
  await flush();
  expect(closed).not.toHaveBeenCalled();
  proof.resolve("late-joined-session");
  await close;
  expect(closed).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.adopt).not.toHaveBeenCalled();
});

test("close waits for the retained underlying join when cancellation rejects the caller first", async () => {
  const f = fixture();
  const proof = deferred<string>();
  const joined = deferred<void>();
  f.acquire.mockImplementationOnce(() => proof.promise);
  f.joined.mockReturnValueOnce(joined.promise);
  await due();
  const closed = vi.fn();
  const close = f.renewal.close().then(closed);
  proof.reject(new Error("caller cancelled before fixture work joined"));
  await flush();
  expect(f.joined).toHaveBeenCalledTimes(1);
  expect(closed).not.toHaveBeenCalled();
  joined.resolve();
  await close;
  expect(closed).toHaveBeenCalledTimes(1);
  expect(f.acquire).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
});

test("uncertain acquisition cleanup reaches the owner's observer and a failed join remains a close failure", async () => {
  const f = fixture();
  const acquisitionFailure = Object.assign(new Error("fixture acquisition cleanup is uncertain"), {
    cleanupFailure: undefined,
  });
  const joinFailure = Object.assign(new Error("fixture credential work could not be joined"), {
    cleanupFailure: undefined,
  });
  f.acquire.mockRejectedValueOnce(acquisitionFailure);
  f.joined.mockRejectedValueOnce(joinFailure);
  await due();
  expect(f.observe).toHaveBeenCalledExactlyOnceWith(acquisitionFailure);
  expect(ownedProcessCleanupReceipt(f.observe.mock.calls[0]![0])).toEqual({
    failure: undefined,
    pending: false,
  });
  await expect(f.renewal.close()).rejects.toBe(joinFailure);
  expect(f.terminate).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.adopt).not.toHaveBeenCalled();
});

test("a synchronously acknowledged send cancels its deadline before the next renewal", async () => {
  const f = fixture();
  f.send.mockImplementationOnce(() => {
    expect(f.renewal.accept(7200)).toBe(true);
  });
  await due();
  expect(f.adopt).toHaveBeenCalledExactlyOnceWith("fresh-routing-session");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.terminate).not.toHaveBeenCalled();
});

test("proof resolved after a forward clock jump cannot send before the delayed expiry timer runs", async () => {
  const f = fixture(90);
  const proof = deferred<string>();
  f.acquire.mockImplementationOnce(() => proof.promise);
  await vi.advanceTimersByTimeAsync(60_000);
  // The wall clock can move while credential work is awaiting I/O. Expiry must
  // be checked at handoff even if the event loop has not dispatched its timer.
  vi.setSystemTime(90_000);
  proof.resolve("expired-before-handoff");
  await flush();
  expect(f.terminate).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.adopt).not.toHaveBeenCalled();
});

test("an acknowledgement cannot extend authority after a forward clock jump past the accepted deadline", async () => {
  const f = fixture();
  await due();
  vi.setSystemTime(3_600_000);
  expect(f.renewal.accept(7200)).toBe(false);
  expect(f.adopt).not.toHaveBeenCalled();
});

test("a backward clock adjustment re-arms timers until their actual renewal and expiry deadlines", async () => {
  const f = fixture();
  vi.setSystemTime(-3_600_000);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(Date.now()).toBe(0);
  expect(f.acquire).not.toHaveBeenCalled();
  expect(f.terminate).not.toHaveBeenCalled();
  await due();
  expect(f.send).toHaveBeenCalledExactlyOnceWith("fresh-routing-session");
  expect(f.renewal.accept(7200)).toBe(true);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(f.terminate).not.toHaveBeenCalled();
});

test("re-delivered renewal timer callbacks cannot overlap proofs, resend a pending token or restart after stop", async () => {
  const scheduled = vi.spyOn(globalThis, "setTimeout");
  try {
    const f = fixture();
    const callback = scheduled.mock.calls.find((call) => call[1] === 3_540_000)![0];
    const proof = deferred<string>();
    f.acquire.mockImplementationOnce(() => proof.promise);
    await due();
    callback();
    expect(f.acquire).toHaveBeenCalledTimes(1);
    proof.resolve("single-pending-session");
    await flush();
    callback();
    expect(f.send).toHaveBeenCalledExactlyOnceWith("single-pending-session");
    f.renewal.stop();
    callback();
    // A cancelled callback already queued before a backward clock adjustment
    // must neither re-arm its timer nor create a new credential operation.
    vi.setSystemTime(0);
    callback();
    expect(f.acquire).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    scheduled.mockRestore();
  }
});

test("stopping while an unchanged credential's underlying work joins prevents a later retry", async () => {
  const f = fixture();
  const joined = deferred<void>();
  f.acquire.mockResolvedValueOnce("initial-routing-session");
  f.joined.mockReturnValueOnce(joined.promise);
  await due();
  const closed = vi.fn();
  const close = f.renewal.close().then(closed);
  await flush();
  expect(closed).not.toHaveBeenCalled();
  joined.resolve();
  await close;
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(f.acquire).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.adopt).not.toHaveBeenCalled();
  expect(f.terminate).not.toHaveBeenCalled();
});

test("a send failure retries a freshly acquired proof without adopting the refused handoff", async () => {
  const f = fixture();
  const failure = new Error("fictional control socket write failed");
  f.send.mockImplementationOnce(() => {
    throw failure;
  });
  f.acquire.mockResolvedValueOnce("failed-handoff-session").mockResolvedValueOnce("retry-session");
  await due();
  expect(f.observe).toHaveBeenCalledExactlyOnceWith(failure);
  expect(f.renewal.accept(7200)).toBe(false);
  expect(f.adopt).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.send.mock.calls).toEqual([["failed-handoff-session"], ["retry-session"]]);
  expect(f.renewal.accept(7200)).toBe(true);
  expect(f.adopt).toHaveBeenCalledExactlyOnceWith("retry-session");
  expect(f.terminate).not.toHaveBeenCalled();
});

test("expiry and a later credential join failure close only once while retaining the cleanup failure", async () => {
  const f = fixture(90);
  const proof = deferred<string>();
  const joinFailure = Object.assign(new Error("fixture expired proof could not be joined"), {
    cleanupFailure: undefined,
  });
  f.acquire.mockImplementationOnce(() => proof.promise);
  f.joined.mockRejectedValueOnce(joinFailure);
  await vi.advanceTimersByTimeAsync(90_000);
  expect(f.terminate).toHaveBeenCalledTimes(1);
  const close = f.renewal.close();
  const rejected = expect(close).rejects.toBe(joinFailure);
  proof.reject(new Error("fixture proof rejected after expiry"));
  await rejected;
  await flush();
  expect(f.terminate).toHaveBeenCalledTimes(1);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.adopt).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
