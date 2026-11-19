// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test, vi } from "vitest";
import { ownedProcessCleanupReceipt, type WindowsJobProcess } from "@omnesis/core";
import { spawnAuthProcess } from "./auth-process.js";

function fakeWindowsOwner() {
  const closure = Promise.withResolvers<void>();
  const readiness = Promise.withResolvers<void>();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    jobReady: readiness.promise,
    jobClosed: closure.promise,
    kill: vi.fn(() => true),
  });
  const spawnJob = vi.fn(() => child as unknown as WindowsJobProcess);
  const owner = spawnAuthProcess(
    "invented-auth.exe",
    ["literal argument"],
    { cwd: process.cwd(), env: {} },
    { platform: "win32", spawnJob },
  );
  readiness.resolve();
  return { child, closure, owner, spawnJob };
}

test("Windows cancellation shares one retained Job join independently of exit and stdout EOF", async () => {
  const { child, closure, owner, spawnJob } = fakeWindowsOwner();
  await owner.ready;
  expect(spawnJob).toHaveBeenCalledWith("invented-auth.exe", ["literal argument"], {
    cwd: process.cwd(),
    env: {},
    completion: "root",
  });
  let stopped = false;
  const stopping = owner.stop().then(() => {
    stopped = true;
  });
  expect(owner.stop()).toBe(owner.stop());
  child.stdout.end();
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  for (let turn = 0; turn < 6; turn++) await Promise.resolve();
  expect(stopped).toBe(false);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  closure.resolve();
  await stopping;
  expect(stopped).toBe(true);
});

test.each([undefined, new Error("invented native closure failure")])(
  "a rejected native closure retains an explicit uncertainty marker (%s)",
  async (failure) => {
    const { closure, owner } = fakeWindowsOwner();
    await owner.ready;
    closure.reject(failure);
    const error: unknown = await owner.joined.catch((reason: unknown) => reason);
    expect(ownedProcessCleanupReceipt(error)).toEqual({ failure, pending: false });
    await expect(owner.stop()).rejects.toBe(error);
  },
);

test("explicit cancellation uncertainty stays terminal even when another join fulfills", async () => {
  const { child, closure, owner } = fakeWindowsOwner();
  await owner.ready;
  const marker = Object.assign(new Error("invented uncertain cancellation"), {
    cleanupFailure: undefined,
  });
  child.kill.mockImplementation(() => {
    throw marker;
  });
  const stopping = owner.stop();
  closure.resolve();
  const error: unknown = await stopping.catch((reason: unknown) => reason);
  expect(ownedProcessCleanupReceipt(error)).toEqual({ failure: undefined, pending: false });
  expect(owner.joinedConfirmed).toBe(false);
});

test("a real auth process stays owned until actual termination joins", async () => {
  const owner = spawnAuthProcess(
    process.execPath,
    ["-e", "process.stdout.end('ready\\n'); setInterval(() => {}, 1000)"],
    { cwd: process.cwd(), env: process.env },
  );
  let joined = false;
  void owner.joined.then(
    () => {
      joined = true;
    },
    () => {},
  );
  try {
    await owner.ready;
    await new Promise<void>((resolve, reject) => {
      let output = "";
      owner.child.stdout!.on("data", (bytes: Buffer) => {
        output += bytes.toString("utf8");
        if (output.includes("ready\n")) resolve();
      });
      owner.child.stdout!.once("error", reject);
    });
    expect(joined).toBe(false);
  } finally {
    await owner.stop();
  }
  expect(joined).toBe(true);
  if (process.platform !== "win32") expect(owner.child.signalCode).toBe("SIGTERM");
}, 30_000);

test("stopping a real process after it has joined preserves its natural exit status", async () => {
  const owner = spawnAuthProcess(process.execPath, ["-e", "process.exit(7)"], {
    cwd: process.cwd(),
    env: process.env,
  });
  await owner.ready;
  await owner.joined;
  expect(owner.child.exitCode).toBe(7);
  await owner.stop();
  expect(owner.child.exitCode).toBe(7);
  expect(owner.joinedConfirmed).toBe(true);
}, 30_000);
