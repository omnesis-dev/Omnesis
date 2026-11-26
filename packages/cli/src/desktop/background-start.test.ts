// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { startDesktopBackgroundDaemon } from "./background-start.js";
import { desktopProfile } from "./environment.js";
const profile = desktopProfile("/example/home");
function ownerFixture() {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let finish: () => void = () => {},
    confirmed = false;
  const joined = new Promise<void>((resolve) => {
    finish = () => {
      confirmed = true;
      resolve();
    };
  });
  const owner = {
    child,
    ready: Promise.resolve(),
    joined,
    get joinedConfirmed() {
      return confirmed;
    },
    stop: vi.fn(async () => {
      await joined;
    }),
  };
  return {
    owner,
    close: (code: number) => {
      child.emit("exit", code, null);
      finish();
    },
  };
}
test("native helper failure never falls back to detached Node", async () => {
  const f = ownerFixture(),
    sourceSpawn = vi.fn();
  const started = startDesktopBackgroundDaemon(profile, undefined, undefined, {
    invocation: () => ({
      command: "/example/runtime-exec",
      args: ["--background-start", "fixture"],
    }),
    owned: () => f.owner,
    sourceSpawn,
  });
  queueMicrotask(() => f.close(78));
  await expect(started).rejects.toThrow("could not confirm");
  expect(sourceSpawn).not.toHaveBeenCalled();
  expect(f.owner.joinedConfirmed).toBe(true);
});
test("native client cancellation retains physical ownership until actual close", async () => {
  const f = ownerFixture(),
    controller = new AbortController();
  let ended = false;
  const started = startDesktopBackgroundDaemon(profile, undefined, controller.signal, {
    invocation: () => ({ command: "/example/runtime-exec", args: [] }),
    owned: () => f.owner,
  }).finally(() => {
    ended = true;
  });
  void started.catch(() => undefined);
  controller.abort();
  await vi.waitFor(() => expect(f.owner.stop).toHaveBeenCalledOnce());
  expect(ended).toBe(false);
  f.close(78);
  await expect(started).rejects.toThrow();
  expect(f.owner.joinedConfirmed).toBe(true);
});
test("only an explicit source adapter detaches, preserving the exact restore tuple", async () => {
  const child = new ChildProcess();
  const unref = vi.spyOn(child, "unref");
  const sourceSpawn = vi.fn(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
  const activation = {
    operationId: "00000000-0000-4000-8000-000000000001",
    attemptId: "00000000-0000-4000-8000-000000000002",
    epoch: null,
  };
  await startDesktopBackgroundDaemon(profile, activation, undefined, {
    invocation: () => null,
    sourceSpawn,
  });
  const call = sourceSpawn.mock.calls[0] as unknown as [
    string,
    string[],
    { detached: boolean; stdio: string },
  ];
  expect(call[1].slice(-4)).toEqual([
    "desktop",
    "daemon",
    "--restore-start",
    JSON.stringify(activation),
  ]);
  expect(call[2]).toMatchObject({ detached: true, stdio: "ignore" });
  expect(unref).toHaveBeenCalledOnce();
});
