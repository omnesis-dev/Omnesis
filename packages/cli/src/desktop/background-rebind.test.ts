// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdtemp, realpath, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { desktopProfile, type DesktopProfile } from "./environment.js";
import { prepareDesktopBackgroundHandoff } from "./background-rebind.js";
import { withDesktopInstallLease } from "./bootstrap.js";
let home: string, profile: DesktopProfile;
const epoch = "a".repeat(64),
  signal = () => new AbortController().signal;
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "omnesis-rebind-command-")));
  profile = desktopProfile(home);
  await mkdir(`${profile.configDir}.bootstrap`, { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
function owner(output: string, code = 0) {
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let confirmed = false,
    finish = () => {};
  const joined = new Promise<void>((resolve) => {
    finish = () => {
      confirmed = true;
      resolve();
    };
  });
  queueMicrotask(() => {
    child.stdout.write(output);
    child.emit("exit", code, null);
    finish();
  });
  return {
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
}
function fixture() {
  const binding = {
    version: 1,
    scope: { format: 1, ...profile },
    epoch: "b".repeat(64),
    pid: 123,
    birth: { seconds: "1", microseconds: "2" },
    origin: { state: "verified" as const },
  };
  const command = { command: "/example/runtime-exec", args: ["fixture"] };
  return {
    binding,
    command,
    dependencies: {
      query: vi.fn(() => command),
      invocation: vi.fn(() => command),
      epoch: () => epoch,
      validate: vi.fn(async () => ({ kind: "candidate" as const, mode: "home" as const })),
      owned: vi.fn(() => owner(JSON.stringify(binding))),
    },
  };
}
test("native rebind executes after install lease release and joins both commands", async () => {
  const f = fixture();
  let calls = 0;
  f.dependencies.owned.mockImplementation(() => {
    if (calls++ === 0) return owner(JSON.stringify(f.binding));
    const child = owner("");
    child.ready = withDesktopInstallLease(profile, signal(), async () => {});
    return child;
  });
  expect(await prepareDesktopBackgroundHandoff(profile, signal(), f.dependencies)).toEqual({
    kind: "candidate",
    mode: "home",
  });
  expect(f.dependencies.invocation).toHaveBeenCalledExactlyOnceWith(
    profile,
    f.binding,
    expect.any(String),
  );
  expect(f.dependencies.owned).toHaveBeenCalledTimes(2);
});
test("refused portable policy cannot call native rebind", async () => {
  const f = fixture();
  f.dependencies.validate.mockRejectedValue(new Error("Fixture handoff refused"));
  await expect(prepareDesktopBackgroundHandoff(profile, signal(), f.dependencies)).rejects.toThrow(
    "handoff refused",
  );
  expect(f.dependencies.invocation).not.toHaveBeenCalled();
});
test.each(["x".repeat(4097), "not-json"])(
  "bounded malformed native observation cannot reach policy %#",
  async (output) => {
    const f = fixture();
    f.dependencies.owned.mockImplementation(() => owner(output));
    await expect(
      prepareDesktopBackgroundHandoff(profile, signal(), f.dependencies),
    ).rejects.toThrow();
    expect(f.dependencies.validate).not.toHaveBeenCalled();
  },
);
test("native query failure never falls back or calls portable admission", async () => {
  const f = fixture();
  f.dependencies.owned.mockImplementation(() => owner("", 78));
  await expect(
    prepareDesktopBackgroundHandoff(profile, signal(), f.dependencies),
  ).rejects.toThrow();
  expect(f.dependencies.validate).not.toHaveBeenCalled();
});
test("explicit source adapter performs no native work or lifecycle mutation", async () => {
  const f = fixture();
  expect(
    await prepareDesktopBackgroundHandoff(profile, signal(), {
      ...f.dependencies,
      query: () => null,
    }),
  ).toBeNull();
  expect(f.dependencies.owned).not.toHaveBeenCalled();
  expect(f.dependencies.validate).not.toHaveBeenCalled();
});

test("cancellation cannot return before the actual native query has drained", async () => {
  const f = fixture(),
    controller = new AbortController();
  const child = Object.assign(new ChildProcess(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  let finish = () => {},
    confirmed = false,
    returned = false;
  const joined = new Promise<void>((resolve) => {
    finish = () => {
      confirmed = true;
      resolve();
    };
  });
  const owned = {
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
  const pending = prepareDesktopBackgroundHandoff(profile, controller.signal, {
    ...f.dependencies,
    owned: () => owned,
  }).finally(() => {
    returned = true;
  });
  void pending.catch(() => undefined);
  controller.abort();
  await vi.waitFor(() => expect(owned.stop).toHaveBeenCalled());
  expect(returned).toBe(false);
  child.emit("exit", 78, null);
  finish();
  await expect(pending).rejects.toThrow();
  expect(f.dependencies.validate).not.toHaveBeenCalled();
});

test.each(["pending", "unavailable"] as const)(
  "matching metadata-only %s origin cannot return before explicit native repair",
  async (state) => {
    const f = fixture();
    const metadata = {
      ...f.binding,
      epoch,
      origin:
        state === "pending"
          ? { state, client: { pid: 456, birth: { seconds: "3", microseconds: "4" } } }
          : { state },
    };
    f.dependencies.owned
      .mockImplementationOnce(() => owner(JSON.stringify(metadata)))
      .mockImplementationOnce(() => owner(""));
    await expect(
      prepareDesktopBackgroundHandoff(profile, signal(), f.dependencies),
    ).resolves.toEqual({ kind: "candidate", mode: "home" });
    expect(f.dependencies.invocation).toHaveBeenCalledExactlyOnceWith(
      profile,
      metadata,
      expect.any(String),
    );
    expect(f.dependencies.owned).toHaveBeenCalledTimes(2);
  },
);

test("ack loss after adoption is resolved only by authenticated verified-origin observation", async () => {
  const f = fixture();
  f.dependencies.owned.mockImplementationOnce(() => owner(JSON.stringify({ ...f.binding, epoch })));
  await prepareDesktopBackgroundHandoff(profile, signal(), f.dependencies);
  expect(f.dependencies.invocation).not.toHaveBeenCalled();
  expect(f.dependencies.owned).toHaveBeenCalledTimes(1);
});

test("native refusal for a live pending client remains a failed repair rather than same-binding success", async () => {
  const f = fixture();
  const metadata = {
    ...f.binding,
    epoch,
    origin: { state: "pending", client: { pid: 456, birth: { seconds: "3", microseconds: "4" } } },
  };
  f.dependencies.owned
    .mockImplementationOnce(() => owner(JSON.stringify(metadata)))
    .mockImplementationOnce(() => owner("", 78));
  await expect(prepareDesktopBackgroundHandoff(profile, signal(), f.dependencies)).rejects.toThrow(
    "could not finish",
  );
  expect(f.dependencies.invocation).toHaveBeenCalledOnce();
});
