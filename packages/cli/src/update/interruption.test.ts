// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import { installUpdateSignalHandlers, UpdateInterruptionRouter } from "./interruption.js";

describe("UpdateInterruptionRouter", () => {
  test.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("%s keeps normal exit semantics outside an apply", (signal, code) => {
    const exit = vi.fn();
    const router = new UpdateInterruptionRouter(exit);

    router.dispatch(signal);

    expect(exit).toHaveBeenCalledExactlyOnceWith(code);
  });

  test("routes signals to the claimed transaction until it releases ownership", () => {
    const exit = vi.fn();
    const handler = vi.fn();
    const router = new UpdateInterruptionRouter(exit);
    const release = router.claim(handler);

    router.dispatch("SIGINT");
    expect(handler).toHaveBeenCalledExactlyOnceWith("SIGINT");
    expect(exit).not.toHaveBeenCalled();

    release();
    router.dispatch("SIGTERM");
    expect(exit).toHaveBeenCalledExactlyOnceWith(143);
  });

  test("refuses overlapping owners and makes stale releases identity-safe", () => {
    const router = new UpdateInterruptionRouter(vi.fn());
    const first = vi.fn();
    const releaseFirst = router.claim(first);
    expect(() => router.claim(vi.fn())).toThrow(/already claimed/);
    releaseFirst();

    const second = vi.fn();
    router.claim(second);
    releaseFirst();
    router.dispatch("SIGTERM");
    expect(second).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  });

  test("OS signal routes stay active for repeated signals and clean up exactly", () => {
    const signals = new EventEmitter();
    const router = new UpdateInterruptionRouter(vi.fn());
    const handler = vi.fn();
    router.claim(handler);
    const remove = installUpdateSignalHandlers(router, signals);

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    expect(handler.mock.calls).toEqual([["SIGINT"], ["SIGTERM"]]);

    remove();
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
});
