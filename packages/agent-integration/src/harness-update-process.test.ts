// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runHarnessUpdateProcess } from "./harness-update-process.js";
import type { WindowsCommandProcess } from "./windows-commands.js";

function ownedChild() {
  const events = new EventEmitter();
  const child = Object.assign(events, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    jobReady: Promise.resolve(),
    kill: vi.fn(() => true),
  });
  return { child, spawn: vi.fn(() => child as unknown as WindowsCommandProcess) };
}
afterEach(() => {
  vi.useRealTimers();
});
it("kills the retained owner on timeout but waits for close before reporting failure", async () => {
  vi.useFakeTimers();
  const { child, spawn } = ownedChild();
  let complete = false;
  const result = runHarnessUpdateProcess("invented.exe", ["literal & argument"], {
    deadlineMs: 10,
    spawnJobFn: spawn,
  }).then((value) => {
    complete = true;
    return value;
  });
  expect(spawn).toHaveBeenCalledWith(
    "invented.exe",
    ["literal & argument"],
    expect.objectContaining({ completion: "root", startupTimeoutMs: 10 }),
  );
  expect(child.stdin.writableEnded).toBe(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(complete).toBe(false);
  child.emit("close", null);
  await expect(result).resolves.toMatchObject({ failure: "timeout", code: null });
  expect(vi.getTimerCount()).toBe(0);
});
it("joins explicit cancellation and retains bounded output tails", async () => {
  const { child, spawn } = ownedChild(),
    abort = new AbortController();
  const result = runHarnessUpdateProcess("invented.exe", [], {
    deadlineMs: 60_000,
    signal: abort.signal,
    spawnJobFn: spawn,
  });
  child.stdout.write("a".repeat(20_000) + "retained stdout");
  child.stderr.write("b".repeat(20_000) + "retained diagnostic");
  abort.abort();
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  let complete = false;
  void result.then(() => {
    complete = true;
  });
  await Promise.resolve();
  expect(complete).toBe(false);
  child.emit("close", null);
  const outcome = await result;
  expect(outcome.failure).toBe("cancelled");
  expect(outcome.output).toHaveLength(8_000);
  expect(outcome.output.endsWith("retained diagnostic")).toBe(true);
  expect(outcome.errors).toHaveLength(8_000);
  expect(outcome.errors.endsWith("retained diagnostic")).toBe(true);
});
it("does not launch after cancellation or an already expired budget", async () => {
  const { spawn } = ownedChild(),
    abort = new AbortController();
  abort.abort();
  await expect(
    runHarnessUpdateProcess("invented.exe", [], {
      deadlineMs: 10,
      signal: abort.signal,
      spawnJobFn: spawn,
    }),
  ).resolves.toMatchObject({ failure: "cancelled" });
  await expect(
    runHarnessUpdateProcess("invented.exe", [], { deadlineMs: 0, spawnJobFn: spawn }),
  ).resolves.toMatchObject({ failure: "timeout" });
  expect(spawn).not.toHaveBeenCalled();
});
it("preserves a startup error and joins the owned helper before returning it", async () => {
  const { child, spawn } = ownedChild(),
    cause = new Error("invented spawn refusal");
  child.jobReady = Promise.reject(cause);
  const result = runHarnessUpdateProcess("invented.exe", [], {
    deadlineMs: 60_000,
    spawnJobFn: spawn,
  });
  await Promise.resolve();
  child.emit("close", 255);
  await expect(result).resolves.toMatchObject({ failure: "spawn", cause, code: 255 });
});
it("a failed input close retires and joins an already created owned helper", async () => {
  const { child, spawn } = ownedChild(),
    cause = new Error("invented input close refusal");
  vi.spyOn(child.stdin, "end").mockImplementation(() => {
    throw cause;
  });
  const result = runHarnessUpdateProcess("invented.exe", [], {
    deadlineMs: 60_000,
    spawnJobFn: spawn,
  });
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  child.emit("close", null);
  await expect(result).resolves.toMatchObject({ failure: "spawn", cause });
});
