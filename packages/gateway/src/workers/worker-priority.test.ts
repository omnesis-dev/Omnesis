// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import os from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_BACKGROUND_WORKER_NICE,
  deprioritizeBackgroundWorker,
  resolveBackgroundWorkerNice,
} from "./worker-priority.js";

afterEach(() => vi.restoreAllMocks());

describe("resolveBackgroundWorkerNice", () => {
  test("defaults to the background nice when neither config nor env is set", () => {
    expect(resolveBackgroundWorkerNice(undefined, {})).toBe(DEFAULT_BACKGROUND_WORKER_NICE);
    expect(resolveBackgroundWorkerNice(undefined, { OMNESIS_BACKGROUND_WORKER_NICE: "" })).toBe(
      DEFAULT_BACKGROUND_WORKER_NICE,
    );
  });

  test("uses the resolved config value when no env override is present", () => {
    expect(resolveBackgroundWorkerNice(7, {})).toBe(7);
    expect(resolveBackgroundWorkerNice(0, {})).toBe(0);
    // An empty env string is not an override — resolution falls through to config.
    expect(resolveBackgroundWorkerNice(7, { OMNESIS_BACKGROUND_WORKER_NICE: "" })).toBe(7);
  });

  test("env override wins over the config value", () => {
    expect(resolveBackgroundWorkerNice(7, { OMNESIS_BACKGROUND_WORKER_NICE: "5" })).toBe(5);
    expect(resolveBackgroundWorkerNice(undefined, { OMNESIS_BACKGROUND_WORKER_NICE: "5" })).toBe(5);
  });

  test("clamps to the valid nice range (-20..19)", () => {
    expect(resolveBackgroundWorkerNice(undefined, { OMNESIS_BACKGROUND_WORKER_NICE: "99" })).toBe(
      19,
    );
    expect(resolveBackgroundWorkerNice(undefined, { OMNESIS_BACKGROUND_WORKER_NICE: "-99" })).toBe(
      -20,
    );
    expect(resolveBackgroundWorkerNice(99, {})).toBe(19);
  });

  test("a malformed env value falls through to config, then to the default", () => {
    // Non-numeric env with no config → default.
    expect(resolveBackgroundWorkerNice(undefined, { OMNESIS_BACKGROUND_WORKER_NICE: "low" })).toBe(
      DEFAULT_BACKGROUND_WORKER_NICE,
    );
    // Non-numeric env with config → the garbage override is ignored, config wins
    // (it never silently discards a deliberately-set config value).
    expect(resolveBackgroundWorkerNice(7, { OMNESIS_BACKGROUND_WORKER_NICE: "low" })).toBe(7);
  });
});

describe("deprioritizeBackgroundWorker", () => {
  const asPlatform = (platform: NodeJS.Platform) =>
    vi.stubGlobal("process", { ...process, platform });

  afterEach(() => vi.unstubAllGlobals());

  test("on Linux, renices the calling thread to the given nice and returns it", () => {
    asPlatform("linux");
    const spy = vi.spyOn(os, "setPriority").mockImplementation(() => undefined);
    expect(deprioritizeBackgroundWorker(5, "cpu")).toBe(5);
    // pid 0 = the calling thread on Linux (per-thread nice).
    expect(spy).toHaveBeenCalledWith(0, 5);
  });

  test("is a no-op off Linux — setpriority is per-process there, never called", () => {
    asPlatform("darwin");
    const spy = vi.spyOn(os, "setPriority").mockImplementation(() => undefined);
    expect(deprioritizeBackgroundWorker(DEFAULT_BACKGROUND_WORKER_NICE, "cpu")).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test("on Linux is best-effort — a setPriority failure is reported and swallowed, returns null", () => {
    asPlatform("linux");
    vi.spyOn(os, "setPriority").mockImplementation(() => {
      throw new Error("EPERM");
    });
    const errors: string[] = [];
    expect(deprioritizeBackgroundWorker(10, "io", (m) => errors.push(m))).toBeNull();
    expect(errors[0]).toMatch(/could not renice io worker/);
  });
});
