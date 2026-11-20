// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { spawnOwnedChildProcess } from "./owned-child-process.js";
import type { ChildProcess, spawn } from "node:child_process";
import type { WindowsJobProcess } from "./windows-job.js";

afterEach(() => vi.useRealTimers());

test.each(["linux", "win32"] as const)(
  "immediate stopping sends SIGKILL once and still waits for actual closure on %s",
  async (platform) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closure = Promise.withResolvers<void>();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      jobReady: Promise.resolve(),
      jobClosed: closure.promise,
      kill: vi.fn(() => true),
    });
    const spawnChild = vi.fn(() => child as unknown as ChildProcess);
    const spawnJob = vi.fn(() => child as unknown as WindowsJobProcess);
    const owner = spawnOwnedChildProcess(
      "invented-worker",
      ["literal argument"],
      { env: {}, stopSignal: "SIGKILL" },
      { platform, spawnChild: spawnChild as unknown as typeof spawn, spawnJob },
    );
    child.emit("spawn");
    await owner.ready;
    let stopped = false;
    const stopping = owner.stop().then(() => {
      stopped = true;
    });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect((platform === "win32" ? spawnJob : spawnChild).mock.calls[0]).not.toBeUndefined();
    const options =
      platform === "win32"
        ? Reflect.get(spawnJob.mock.calls[0]!, "2")
        : Reflect.get(spawnChild.mock.calls[0]!, "2");
    expect(options).not.toHaveProperty("stopSignal");
    await vi.advanceTimersByTimeAsync(5000);
    expect(stopped).toBe(false);
    expect(owner.joinedConfirmed).toBe(false);
    expect(child.kill).toHaveBeenCalledOnce();
    if (platform === "win32") closure.resolve();
    else child.emit("close", null, "SIGKILL");
    await stopping;
    expect(owner.joinedConfirmed).toBe(true);
    expect(stopped).toBe(true);
  },
);
