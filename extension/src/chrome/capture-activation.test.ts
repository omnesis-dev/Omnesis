// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { CaptureActivation } from "./capture-activation.js";

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve: (value: T) => resolve?.(value) };
}

describe("CaptureActivation", () => {
  it("starts an already-open tab when config arrives after host permission", async () => {
    let allowed = false;
    const start = vi.fn();
    const activation = new CaptureActivation({
      readAllowed: () => Promise.resolve(allowed),
      start,
      stop: vi.fn(),
      markInactive: vi.fn(),
    });

    await activation.refresh();
    expect(start).not.toHaveBeenCalled();
    allowed = true;
    await activation.refresh();
    expect(start).toHaveBeenCalledOnce();
    expect(activation.active).toBe(true);
  });

  it("does not start from a stale authorization read after unpair", async () => {
    const read = deferred<boolean>();
    const start = vi.fn();
    const activation = new CaptureActivation({
      readAllowed: () => read.promise,
      start,
      stop: vi.fn(),
      markInactive: vi.fn(),
    });

    const refresh = activation.refresh();
    activation.deactivate();
    read.resolve(true);
    await refresh;
    expect(start).not.toHaveBeenCalled();
  });

  it("permanently stops after Chrome revokes page access", async () => {
    const stop = vi.fn();
    const start = vi.fn();
    const activation = new CaptureActivation({
      readAllowed: () => Promise.resolve(true),
      start,
      stop,
      markInactive: vi.fn(),
    });

    await activation.refresh();
    activation.terminate();
    await activation.refresh();
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(activation.active).toBe(false);
  });

  it("restarts active capture after config replacement", async () => {
    const start = vi.fn();
    const stop = vi.fn();
    const activation = new CaptureActivation({
      readAllowed: () => Promise.resolve(true),
      start,
      stop,
      markInactive: vi.fn(),
    });

    await activation.refresh();
    await activation.reconcile();

    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("stays inactive when replacement config is no longer authorized", async () => {
    let allowed = true;
    const start = vi.fn();
    const stop = vi.fn();
    const activation = new CaptureActivation({
      readAllowed: () => Promise.resolve(allowed),
      start,
      stop,
      markInactive: vi.fn(),
    });

    await activation.refresh();
    allowed = false;
    await activation.reconcile();

    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(activation.active).toBe(false);
  });

  it("retries a transient authorization read without marking the page excluded", async () => {
    let attempts = 0;
    let retry: (() => void) | undefined;
    const start = vi.fn();
    const markInactive = vi.fn();
    const activation = new CaptureActivation({
      readAllowed: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("storage unavailable"))
          : Promise.resolve(true);
      },
      start,
      stop: vi.fn(),
      markInactive,
      setTimer: (callback) => {
        retry = callback;
        return 7;
      },
      clearTimer: vi.fn(),
    });

    await activation.refresh();
    expect(markInactive).not.toHaveBeenCalled();
    expect(retry).toBeDefined();
    retry?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();
  });

  it("cancels a pending authorization retry on terminal teardown", async () => {
    const clearTimer = vi.fn();
    const activation = new CaptureActivation({
      readAllowed: () => Promise.reject(new Error("storage unavailable")),
      start: vi.fn(),
      stop: vi.fn(),
      markInactive: vi.fn(),
      setTimer: () => 9,
      clearTimer,
    });

    await activation.refresh();
    activation.terminate();
    expect(clearTimer).toHaveBeenCalledWith(9);
  });

  it("terminates instead of retrying an invalidated extension context", async () => {
    const setTimer = vi.fn(() => 11);
    const onTerminalError = vi.fn();
    const error = new Error("Extension context invalidated.");
    const activation = new CaptureActivation({
      readAllowed: () => Promise.reject(error),
      start: vi.fn(),
      stop: vi.fn(),
      markInactive: vi.fn(),
      setTimer,
      isTerminalError: (candidate) => candidate === error,
      onTerminalError,
    });

    await activation.refresh();
    await activation.refresh();

    expect(setTimer).not.toHaveBeenCalled();
    expect(onTerminalError).toHaveBeenCalledOnce();
    expect(onTerminalError).toHaveBeenCalledWith(error);
    expect(activation.active).toBe(false);
  });
});
