// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  acquireUpdateLock,
  DEVICE_UPDATE_DETAIL_MAX_CHARS,
  deviceUpdateResultEvent,
  UpdateLockBusyError,
  type WsEventPayload,
} from "@omnesis/core";
import { createCommandDispatch } from "./ws-command-dispatch.js";
import {
  createCliUpdater,
  createRecordingUpdater,
  registerSelfUpdateCommand,
  resolveCliPath,
  SELF_UPDATE_DEADLINE_MS,
  updateInvocation,
  type SelfUpdateAttempt,
} from "./self-update.js";

const testLock = () => ({ id: "test-update-lock", release: vi.fn() });
const directHost = { env: {}, platform: "linux" as const };
const systemdHost = { env: { INVOCATION_ID: "collector-unit" }, platform: "linux" as const };

interface Bench {
  ask(version: string): Promise<{ accepted: boolean; reason?: string }>;
  results: Array<WsEventPayload<"device.update.result">>;
  handOvers: number;
  updater: ReturnType<typeof createRecordingUpdater>;
}

function bench(opts: { currentVersion?: string; answer?: SelfUpdateAttempt } = {}): Bench {
  const dispatch = createCommandDispatch();
  const updater = createRecordingUpdater(opts.answer ?? { state: "installed" });
  const results: Array<WsEventPayload<"device.update.result">> = [];
  let handOvers = 0;
  registerSelfUpdateCommand(dispatch, {
    updater,
    currentVersion: opts.currentVersion ?? "0.4.0",
    acquireLock: testLock,
    emitResult: (payload) => results.push(payload),
    handOver: () => {
      handOvers += 1;
    },
  });
  return {
    ask: async (version) =>
      (await dispatch.handle({ type: "device.update", payload: { version } })) as {
        accepted: boolean;
        reason?: string;
      },
    results,
    get handOvers() {
      return handOvers;
    },
    updater,
  };
}

/** Let the fire-and-forget update settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("device.update handler", () => {
  test("a rewind permission reaches the updater but not the reported result", async () => {
    const dispatch = createCommandDispatch();
    const seen: unknown[] = [];
    const results: Array<WsEventPayload<"device.update.result">> = [];
    registerSelfUpdateCommand(dispatch, {
      updater: {
        run: async ({ lockId: _lockId, budgetMs: _budgetMs, ...target }) => {
          seen.push(target);
          return { state: "failed", detail: "invented failure" };
        },
      },
      currentVersion: "0.5.4",
      acquireLock: testLock,
      emitResult: (payload) => results.push(payload),
    });
    expect(
      await dispatch.handle({
        type: "device.update",
        payload: { version: "0.5.5", allowRewind: true },
      }),
    ).toEqual({ accepted: true });
    await settle();
    expect(seen).toEqual([{ version: "0.5.5", allowRewind: true }]);
    // The result event's schema is strict: an extra field would be dropped by
    // the gateway, leaving the row reading "dispatched" with no result.
    expect(results).toEqual([{ version: "0.5.5", state: "failed", detail: "invented failure" }]);
  });

  test("an exact commit is passed through and reported unchanged", async () => {
    const commit = "a".repeat(40);
    const dispatch = createCommandDispatch();
    const updater = createRecordingUpdater();
    const results: Array<WsEventPayload<"device.update.result">> = [];
    registerSelfUpdateCommand(dispatch, {
      updater,
      currentVersion: "0.5.4",
      acquireLock: testLock,
      emitResult: (payload) => results.push(payload),
    });
    expect(await dispatch.handle({ type: "device.update", payload: { commit } })).toEqual({
      accepted: true,
    });
    await settle();
    expect(updater.calls).toEqual([commit]);
    expect(results).toEqual([{ commit, state: "installed", detail: undefined }]);
  });
  test("acknowledges before the update finishes, then reports and hands over", async () => {
    // The acknowledgement is a receipt: it lands while the update is still
    // running, which is the whole reason the outcome is an event.
    let release: (attempt: SelfUpdateAttempt) => void = () => {};
    const dispatch = createCommandDispatch();
    const results: Array<WsEventPayload<"device.update.result">> = [];
    let handOvers = 0;
    registerSelfUpdateCommand(dispatch, {
      updater: {
        run: () => new Promise<SelfUpdateAttempt>((resolve) => (release = resolve)),
      },
      currentVersion: "0.4.0",
      acquireLock: testLock,
      emitResult: (payload) => results.push(payload),
      handOver: () => (handOvers += 1),
    });
    expect(await dispatch.handle({ type: "device.update", payload: { version: "0.5.0" } })).toEqual(
      { accepted: true },
    );
    expect(results).toEqual([]);
    expect(handOvers).toBe(0);

    release({ state: "installed", detail: "Installed 0.5.0; restarting." });
    await settle();
    expect(results).toEqual([
      { version: "0.5.0", state: "installed", detail: "Installed 0.5.0; restarting." },
    ]);
    expect(handOvers).toBe(1);
  });

  test("the version is passed to the updater unchanged", async () => {
    const b = bench();
    expect(await b.ask("0.5.0")).toEqual({ accepted: true });
    await settle();
    expect(b.updater.calls).toEqual(["0.5.0"]);
    expect(b.results).toEqual([{ version: "0.5.0", state: "installed", detail: undefined }]);
    expect(b.handOvers).toBe(1);
  });

  test("the result is reported before the process is handed over", async () => {
    // The hand-over ends the process, so a result emitted after it would
    // never leave the machine.
    const order: string[] = [];
    const dispatch = createCommandDispatch();
    registerSelfUpdateCommand(dispatch, {
      updater: createRecordingUpdater(),
      currentVersion: "0.4.0",
      acquireLock: testLock,
      emitResult: () => order.push("result"),
      handOver: () => order.push("handOver"),
    });
    await dispatch.handle({ type: "device.update", payload: { version: "0.5.0" } });
    await settle();
    expect(order).toEqual(["result", "handOver"]);
  });

  test("refuses another command while a completed update is handing over", async () => {
    const b = bench();
    expect(await b.ask("0.5.0")).toEqual({ accepted: true });
    await settle();
    expect(await b.ask("0.6.0")).toEqual({
      accepted: false,
      reason: "This host is restarting after its completed update.",
    });
    expect(b.updater.calls).toEqual(["0.5.0"]);
  });

  test("a failed update reports it and stays running", async () => {
    const b = bench({ answer: { state: "failed", detail: "No release v0.5.0 exists" } });
    expect(await b.ask("0.5.0")).toEqual({ accepted: true });
    await settle();
    expect(b.results[0]).toMatchObject({ state: "failed", detail: "No release v0.5.0 exists" });
    expect(b.handOvers).toBe(0);
  });

  test("a failure that cannot prove the updater stopped retains the host fence", async () => {
    const dispatch = createCommandDispatch();
    const lock = testLock();
    const results: Array<WsEventPayload<"device.update.result">> = [];
    let stopped!: () => void;
    const releaseFenceWhenStopped = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    registerSelfUpdateCommand(dispatch, {
      updater: {
        run: () =>
          Promise.resolve({
            state: "failed",
            detail: "The updater could not be proven stopped.",
            retainLock: true,
            releaseFenceWhenStopped,
          }),
      },
      currentVersion: "0.4.0",
      acquireLock: () => lock,
      emitResult: (payload) => results.push(payload),
    });

    expect(await dispatch.handle({ type: "device.update", payload: { version: "0.5.0" } })).toEqual(
      { accepted: true },
    );
    await settle();
    expect(results).toEqual([
      {
        version: "0.5.0",
        state: "failed",
        detail: "The updater could not be proven stopped.",
      },
    ]);
    expect(lock.release).not.toHaveBeenCalled();
    stopped();
    await releaseFenceWhenStopped;
    await settle();
    expect(lock.release).toHaveBeenCalledOnce();
  });

  test("an updater that throws is reported rather than swallowed", async () => {
    const dispatch = createCommandDispatch();
    const results: Array<WsEventPayload<"device.update.result">> = [];
    registerSelfUpdateCommand(dispatch, {
      updater: {
        run: () => Promise.reject(new Error("spawn ENOENT")),
      },
      currentVersion: "0.4.0",
      acquireLock: testLock,
      emitResult: (payload) => results.push(payload),
    });
    await dispatch.handle({ type: "device.update", payload: { version: "0.5.0" } });
    await settle();
    expect(results[0]).toMatchObject({ state: "failed", detail: "spawn ENOENT" });
  });

  test("a version that is not a release never reaches the handler", async () => {
    // The request schema accepts a release version and nothing else, so the
    // dispatch rejects the payload before any handler runs — which is what
    // keeps an arbitrary string from becoming a command argument.
    const b = bench();
    for (const version of ["main", "0.5", "; rm -rf /", "0.5.0 --exec", "--registry=evil"]) {
      await expect(b.ask(version)).rejects.toThrow(/invalid device.update payload/);
    }
    expect(b.updater.calls).toEqual([]);
  });

  test("the version already running is refused", async () => {
    const b = bench({ currentVersion: "0.5.0" });
    expect(await b.ask("0.5.0")).toMatchObject({
      accepted: false,
      reason: "Already running 0.5.0.",
    });
    expect(b.updater.calls).toEqual([]);
  });

  test("a second command while one is running is refused, not queued", async () => {
    // Two `npm ci` runs in one checkout corrupt each other, and the gateway
    // asks again on the next reconnect.
    let release: (attempt: SelfUpdateAttempt) => void = () => {};
    const dispatch = createCommandDispatch();
    let runs = 0;
    let held = false;
    registerSelfUpdateCommand(dispatch, {
      updater: {
        run: () => {
          runs += 1;
          return new Promise<SelfUpdateAttempt>((resolve) => {
            release = resolve;
          });
        },
      },
      currentVersion: "0.4.0",
      acquireLock: () => {
        if (held) {
          throw new Error(
            "Concurrent update: collector self-update (PID 42), started today, currently applying.",
          );
        }
        held = true;
        return { id: "shared-lock", release: () => (held = false) };
      },
      emitResult: () => {},
    });
    const first = await dispatch.handle({ type: "device.update", payload: { version: "0.5.0" } });
    const second = await dispatch.handle({ type: "device.update", payload: { version: "0.5.0" } });
    expect(first).toEqual({ accepted: true });
    expect(second).toEqual({
      accepted: false,
      reason: "An update is already running on this collector.",
    });
    expect(runs).toBe(1);
    release({ state: "installed" });
  });

  test("a malformed payload is rejected by the dispatch's schema, not the handler", async () => {
    const b = bench();
    await expect(
      // A version field of the wrong type never reaches the handler.
      (async () => b.ask(undefined as unknown as string))(),
    ).rejects.toThrow(/invalid device.update payload/);
  });
});

describe("resolveCliPath", () => {
  test("an explicit override wins", () => {
    expect(resolveCliPath({ OMNESIS_CLI_BIN: "/opt/omnesis/bin/omnesis", HOME: "/home/dev" })).toBe(
      "/opt/omnesis/bin/omnesis",
    );
  });

  test("without one, a host with no installer wrapper falls back to PATH", () => {
    // A service manager starts a daemon with a minimal PATH, so this is the
    // last resort rather than the first choice.
    expect(resolveCliPath({ HOME: "/nonexistent-home-for-this-test" })).toBe("omnesis");
  });
});

describe("updateInvocation", () => {
  test("the operator's rewind permission becomes --allow-rewind, and only when given", () => {
    expect(
      updateInvocation("/bin/omnesis", { version: "0.5.0", allowRewind: true }, {}, "darwin").args,
    ).toEqual([
      "update",
      "--yes",
      "--no-restart",
      "--target-version=0.5.0",
      "--allow-rewind",
      "--wait-for-lock=30",
    ]);
    expect(updateInvocation("/bin/omnesis", { version: "0.5.0" }, {}, "darwin").args).not.toContain(
      "--allow-rewind",
    );
  });

  test("an exact commit is one CLI argument", () => {
    const commit = "b".repeat(40);
    expect(
      updateInvocation("/bin/omnesis", { commit }, directHost.env, directHost.platform).args,
    ).toContain(`--commit=${commit}`);
  });
  test("the version is one argv token, so it can never be read as a flag", () => {
    const { command, args } = updateInvocation("/usr/local/bin/omnesis", "0.5.0", {}, "darwin");
    expect(command).toBe("/usr/local/bin/omnesis");
    expect(args).toEqual([
      "update",
      "--yes",
      "--no-restart",
      "--target-version=0.5.0",
      "--wait-for-lock=30",
    ]);
  });

  test("under systemd the update is started by the manager, outside the unit sandbox", () => {
    // A collector unit runs with ProtectSystem=strict and
    // ProtectHome=read-only, and a child inherits that mount namespace — so a
    // forked update would meet a read-only checkout.
    const { command, args } = updateInvocation(
      "/home/dev/.local/bin/omnesis",
      "0.5.0",
      { INVOCATION_ID: "abc123" },
      "linux",
    );
    expect(command).toBe("systemd-run");
    expect(args).toEqual([
      "--user",
      "--wait",
      "--pipe",
      "--quiet",
      "--collect",
      "--setenv=NO_COLOR=1",
      "--",
      "/home/dev/.local/bin/omnesis",
      "update",
      "--yes",
      "--no-restart",
      "--target-version=0.5.0",
      "--wait-for-lock=30",
    ]);
  });

  test("what the update cannot do without is carried into the transient unit", () => {
    // A transient unit starts from the user manager's environment, and the
    // collector unit deliberately bakes in a PATH that can find node and the
    // config directory that says which installation this is. Losing either
    // builds with the wrong node or inspects the wrong install.
    const { args } = updateInvocation(
      "/home/dev/.local/bin/omnesis",
      "0.5.0",
      {
        INVOCATION_ID: "abc123",
        HOME: "/home/dev",
        PATH: "/opt/node/bin:/usr/bin",
        OMNESIS_CONFIG_DIR: "/home/dev/.config/omnesis-two",
        OMNESIS_UPDATE_LOCK_ID: "owner-123",
        NODE_EXTRA_CA_CERTS: "/home/dev/.config/omnesis-two/tls/cert.pem",
      },
      "linux",
    );
    expect(args).toContain("--setenv=PATH=/opt/node/bin:/usr/bin");
    expect(args).toContain("--setenv=OMNESIS_CONFIG_DIR=/home/dev/.config/omnesis-two");
    expect(args).toContain("--setenv=OMNESIS_UPDATE_LOCK_ID=owner-123");
    expect(args).toContain("--setenv=HOME=/home/dev");
    expect(args).toContain(
      "--setenv=NODE_EXTRA_CA_CERTS=/home/dev/.config/omnesis-two/tls/cert.pem",
    );
  });

  test("a collector update gets a unique systemd unit that can be stopped as one job", () => {
    const invocation = updateInvocation(
      "/home/dev/.local/bin/omnesis",
      "0.5.0",
      { INVOCATION_ID: "abc123", OMNESIS_UPDATE_LOCK_ID: "owner-123" },
      "linux",
    );
    expect(invocation.args).toContain("--unit=omnesis-update-owner-123.service");
    expect(invocation.args).toContain("--property=KillMode=control-group");
    expect(invocation.stop).toEqual({
      command: "systemctl",
      args: ["--user", "stop", "omnesis-update-owner-123.service"],
      force: {
        command: "systemctl",
        args: [
          "--user",
          "kill",
          "--kill-whom=all",
          "--signal=SIGKILL",
          "omnesis-update-owner-123.service",
        ],
      },
    });
  });

  test("a credential is left behind rather than written into a unit property", () => {
    // `systemctl show` reads a transient unit's properties back, and nothing
    // the update does needs a secret — the CLI reads its credentials from the
    // config directory it is given.
    const { args } = updateInvocation(
      "/home/dev/.local/bin/omnesis",
      "0.5.0",
      {
        INVOCATION_ID: "abc123",
        OMNESIS_TOKEN: "omn_should_not_appear",
        OMNESIS_KEYRING_PASSPHRASE: "should-not-appear",
        // A path to a secret is not a secret, and the update needs it.
        OMNESIS_KEYRING_PASSPHRASE_FILE: "/home/dev/.config/omnesis/keyring.pass",
        UNRELATED_TOKEN: "not-ours-either",
      },
      "linux",
    );
    expect(args.join(" ")).not.toContain("should_not_appear");
    expect(args.join(" ")).not.toContain("should-not-appear");
    expect(args.join(" ")).not.toContain("not-ours-either");
    expect(args).toContain(
      "--setenv=OMNESIS_KEYRING_PASSPHRASE_FILE=/home/dev/.config/omnesis/keyring.pass",
    );
  });

  test("a value carrying a newline is not carried at all", () => {
    // `--setenv=NAME=value` is one argv token; a newline would end the unit
    // property early.
    const { args } = updateInvocation(
      "omnesis",
      "0.5.0",
      { INVOCATION_ID: "abc", OMNESIS_CONFIG_DIR: "/tmp/one\nExecStart=/bin/false" },
      "linux",
    );
    expect(args.join(" ")).not.toContain("ExecStart");
  });

  test("a daemon started by hand on Linux runs the CLI directly", () => {
    const { command } = updateInvocation("/usr/local/bin/omnesis", "0.5.0", {}, "linux");
    expect(command).toBe("/usr/local/bin/omnesis");
  });

  test("launchd has no such sandbox, so macOS never wraps", () => {
    const { command } = updateInvocation(
      "/usr/local/bin/omnesis",
      "0.5.0",
      { INVOCATION_ID: "abc123" },
      "darwin",
    );
    expect(command).toBe("/usr/local/bin/omnesis");
  });
});

describe("createCliUpdater", () => {
  test("runs the host's own update pinned to the version, without restarting", async () => {
    const spawnFn = vi.fn(() => fakeChild(0, ""));
    const updater = createCliUpdater({
      ...directHost,
      cliPath: "/usr/local/bin/omnesis",
      spawnFn: spawnFn as never,
    });
    const attempt = await updater.run({ version: "0.5.0", lockId: "owner-123" });
    const [command, args, options] = spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect([command, ...args].join(" ")).toContain(
      "update --yes --no-restart --target-version=0.5.0",
    );
    expect(options.env.OMNESIS_UPDATE_LOCK_ID).toBe("owner-123");
    expect(attempt.state).toBe("installed");
  });

  test("a non-zero exit carries the CLI's own last line back to the gateway", async () => {
    const spawnFn = vi.fn(() =>
      fakeChild(1, "Fetching…\nNo release v9.9.9 exists on this installation's remote.\n"),
    );
    const updater = createCliUpdater({
      ...directHost,
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
    });
    const attempt = await updater.run({ version: "9.9.9", lockId: "owner-123" });
    expect(attempt.state).toBe("failed");
    expect(attempt.detail).toContain("No release v9.9.9 exists");
  });

  test("a spawn that never resolves is stopped and reported rather than hanging", async () => {
    // An unbounded child means no result event ever leaves this host and the
    // gateway's row reads `dispatched` forever.
    const killed: string[] = [];
    const handlers = new Map<string, (arg: unknown) => void>();
    const spawnFn = vi.fn(() => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, fn: (arg: unknown) => void) => handlers.set(event, fn),
      kill: (signal: string) => {
        killed.push(signal);
        queueMicrotask(() => handlers.get("close")?.(143));
      },
    }));
    const updater = createCliUpdater({
      ...directHost,
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
      deadlineMs: 5,
      stopGraceMs: 50,
    });
    const attempt = await updater.run({ version: "0.5.0", lockId: "owner-123" });
    expect(attempt.state).toBe("failed");
    expect(attempt.detail).toContain("did not finish");
    expect(killed).toEqual(["SIGTERM"]);
  });

  test.skipIf(process.platform === "win32")(
    "force-stops the apply process group published by an unresponsive CLI",
    async () => {
      const configDir = mkdtempSync(join(tmpdir(), "omnesis-self-update-"));
      const lock = acquireUpdateLock(configDir, { owner: "collector self-update" });
      lock.setProcessGroup(process.pid);
      const childSignals: string[] = [];
      const groupSignals: Array<[number, string | number | undefined]> = [];
      const handlers = new Map<string, (arg: unknown) => void>();
      let groupAlive = true;
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        groupSignals.push([pid, signal]);
        if (pid === -process.pid && signal === "SIGKILL") groupAlive = false;
        if (pid === -process.pid && signal === 0 && !groupAlive) {
          throw Object.assign(new Error("process group exited"), { code: "ESRCH" });
        }
        return true;
      });
      const spawnFn = vi.fn(() => ({
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, fn: (arg: unknown) => void) => handlers.set(event, fn),
        kill: (signal: string) => {
          childSignals.push(signal);
          if (signal === "SIGKILL") queueMicrotask(() => handlers.get("close")?.(137));
        },
      }));
      try {
        const updater = createCliUpdater({
          ...directHost,
          cliPath: "omnesis",
          spawnFn: spawnFn as never,
          deadlineMs: 5,
          stopGraceMs: 5,
          configDir,
        });
        const attempt = await updater.run({ version: "0.5.0", lockId: lock.id });
        expect(attempt.detail).toContain("did not finish");
        expect(groupSignals).toContainEqual([-process.pid, "SIGKILL"]);
        expect(childSignals).toEqual(["SIGTERM", "SIGKILL"]);
      } finally {
        killSpy.mockRestore();
        lock.release();
        rmSync(configDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "keeps the fence when the updater wrapper closes before its apply group",
    async () => {
      const configDir = mkdtempSync(join(tmpdir(), "omnesis-self-update-"));
      const lock = acquireUpdateLock(configDir, { owner: "collector self-update" });
      lock.setProcessGroup(process.pid);
      const handlers = new Map<string, (arg: unknown) => void>();
      const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
      const spawnFn = vi.fn(() => ({
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, fn: (arg: unknown) => void) => handlers.set(event, fn),
        kill: () => queueMicrotask(() => handlers.get("close")?.(143)),
      }));
      try {
        const updater = createCliUpdater({
          ...directHost,
          cliPath: "omnesis",
          spawnFn: spawnFn as never,
          deadlineMs: 5,
          stopGraceMs: 50,
          configDir,
        });
        const attempt = await updater.run({ version: "0.5.0", lockId: lock.id });
        expect(attempt).toMatchObject({ state: "failed", retainLock: true });
        expect(attempt.detail).toContain("detached apply process has not been proven stopped");
      } finally {
        killSpy.mockRestore();
        lock.release();
        rmSync(configDir, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "retains the fence rather than signaling an unverifiable apply process group",
    async () => {
      const configDir = mkdtempSync(join(tmpdir(), "omnesis-self-update-"));
      const lock = acquireUpdateLock(configDir, { owner: "collector self-update" });
      lock.setProcessGroup(2_147_483_647);
      const childSignals: string[] = [];
      const realKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -2_147_483_647) return true;
        return realKill(pid, signal);
      });
      const spawnFn = vi.fn(() => ({
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: () => {},
        kill: (signal: string) => childSignals.push(signal),
      }));
      try {
        const updater = createCliUpdater({
          ...directHost,
          cliPath: "omnesis",
          spawnFn: spawnFn as never,
          deadlineMs: 5,
          stopGraceMs: 5,
          configDir,
        });
        const attempt = await updater.run({ version: "0.5.0", lockId: lock.id });
        expect(attempt).toMatchObject({ state: "failed", retainLock: true });
        expect(attempt.detail).toContain("could not be safely identified");
        expect(childSignals).toEqual(["SIGTERM"]);
      } finally {
        killSpy.mockRestore();
        lock.release();
        rmSync(configDir, { recursive: true, force: true });
      }
    },
  );

  test("a forced systemd timeout stays fenced until the waiter confirms exit", async () => {
    const killed: string[] = [];
    const handlers = new Map<string, (arg: unknown) => void>();
    const spawnFn = vi.fn((command: string, args: string[]) => {
      if (command !== "systemd-run") {
        return {
          on: (event: string, fn: (arg: unknown) => void) => {
            if (event === "close") {
              const code = args.includes("stop") ? 1 : 0;
              queueMicrotask(() => fn(code));
            }
          },
        };
      }
      return {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, fn: (arg: unknown) => void) => handlers.set(event, fn),
        kill: (signal: string) => {
          killed.push(signal);
          queueMicrotask(() => handlers.get("close")?.(137));
        },
      };
    });
    const updater = createCliUpdater({
      ...systemdHost,
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
      deadlineMs: 5,
      stopGraceMs: 5,
    });
    const attempt = await updater.run({ version: "0.5.0", lockId: "owner-123" });
    expect(attempt).toMatchObject({ state: "failed", retainLock: true });
    expect(attempt.detail).toContain("systemd could not prove its transient unit stopped");
    expect(spawnFn.mock.calls.map((call) => call[0])).toEqual([
      "systemd-run",
      "systemctl",
      "systemctl",
    ]);
    expect(spawnFn.mock.calls[1]?.[1]).toEqual([
      "--user",
      "stop",
      "omnesis-update-owner-123.service",
    ]);
    expect(spawnFn.mock.calls[2]?.[1]).toContain("--signal=SIGKILL");
    expect(killed).toEqual([]);
    handlers.get("close")?.(137);
    await expect(attempt.releaseFenceWhenStopped).resolves.toBeUndefined();
  });

  test.each(["error", "nonzero"] as const)(
    "a timed-out systemd update retains its fence when forced stop ends with %s",
    async (forceOutcome) => {
      let waiterClose: ((code: number) => void) | undefined;
      const spawnFn = vi.fn((command: string, args: string[]) => {
        if (command === "systemd-run") {
          return {
            stdout: { on: () => {} },
            stderr: { on: () => {} },
            on: (event: string, fn: (code: number) => void) => {
              if (event === "close") waiterClose = fn;
            },
            kill: () => {},
          };
        }
        const force = args.includes("--kill-whom=all");
        return {
          on: (event: string, fn: (arg: unknown) => void) => {
            if (!force && event === "close") queueMicrotask(() => fn(1));
            if (force && forceOutcome === "nonzero" && event === "close") {
              queueMicrotask(() => fn(1));
            }
            if (force && forceOutcome === "error" && event === "error") {
              queueMicrotask(() => fn(new Error("systemctl unavailable")));
            }
          },
        };
      });
      const updater = createCliUpdater({
        ...systemdHost,
        cliPath: "omnesis",
        spawnFn: spawnFn as never,
        deadlineMs: 5,
        stopGraceMs: 5,
      });
      const attempt = await updater.run({ version: "0.5.0", lockId: "owner-123" });
      expect(attempt).toMatchObject({ state: "failed", retainLock: true });
      expect(attempt.detail).toContain("systemd could not prove its transient unit stopped");
      const releaseFence = attempt.releaseFenceWhenStopped;
      expect(releaseFence).toBeInstanceOf(Promise);
      waiterClose?.(1);
      await expect(releaseFence).resolves.toBeUndefined();
    },
  );

  test("a CLI that cannot be spawned names the override that fixes it", async () => {
    const spawnFn = vi.fn(() => failingChild("spawn omnesis ENOENT"));
    const updater = createCliUpdater({
      ...directHost,
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
    });
    const attempt = await updater.run({ version: "0.5.0", lockId: "owner-123" });
    expect(attempt.state).toBe("failed");
    expect(attempt.detail).toContain("OMNESIS_CLI_BIN");
  });
});

/** A child process double that fails to spawn. */
function failingChild(message: string): unknown {
  const handlers = new Map<string, (arg: unknown) => void>();
  queueMicrotask(() => queueMicrotask(() => handlers.get("error")?.(new Error(message))));
  return {
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: (event: string, fn: (arg: unknown) => void) => {
      handlers.set(event, fn);
    },
  };
}

/** A child process double: emits `output` on stdout, then closes with `code`. */
function fakeChild(code: number, output: string): unknown {
  const handlers = new Map<string, (arg: unknown) => void>();
  const stream = {
    on: (event: string, fn: (chunk: Buffer) => void) => {
      if (event === "data" && output) queueMicrotask(() => fn(Buffer.from(output)));
    },
  };
  queueMicrotask(() => queueMicrotask(() => handlers.get("close")?.(code)));
  return {
    stdout: stream,
    stderr: { on: () => {} },
    on: (event: string, fn: (arg: unknown) => void) => {
      handlers.set(event, fn);
    },
  };
}

/** A child that writes `stdout` and `stderr` separately, then exits with `code`. */
function childWriting(code: number, streams: { stdout?: string; stderr?: string }): unknown {
  const handlers = new Map<string, (arg: unknown) => void>();
  const stream = (text: string | undefined) => ({
    on: (event: string, fn: (chunk: Buffer) => void) => {
      if (event === "data" && text) queueMicrotask(() => fn(Buffer.from(text)));
    },
  });
  queueMicrotask(() => queueMicrotask(() => handlers.get("close")?.(code)));
  return {
    stdout: stream(streams.stdout),
    stderr: stream(streams.stderr),
    on: (event: string, fn: (arg: unknown) => void) => {
      handlers.set(event, fn);
    },
  };
}

describe("another update already running on this host", () => {
  test("is waited for, and the update runs on what is left of its deadline", async () => {
    // A harness plugin on the same machine, told to update by the same fleet
    // update, took the host lock first.
    const dispatch = createCommandDispatch();
    const results: Array<WsEventPayload<"device.update.result">> = [];
    const runs: Array<{ lockId: string; budgetMs?: number }> = [];
    let held = true;
    let naps = 0;
    registerSelfUpdateCommand(dispatch, {
      updater: {
        run: ({ lockId, budgetMs }) => {
          runs.push({ lockId, ...(budgetMs === undefined ? {} : { budgetMs }) });
          return Promise.resolve({ state: "installed" });
        },
      },
      currentVersion: "0.4.0",
      acquireLock: () => {
        if (held) {
          throw new UpdateLockBusyError(
            null,
            "harness self-update (PID 42) holds the host update lock.",
          );
        }
        return { id: "taken-after-waiting", release: vi.fn() };
      },
      emitResult: (payload) => results.push(payload),
      handOver: () => {},
      sleep: async () => {
        naps += 1;
        if (naps === 2) held = false;
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });

    expect(await dispatch.handle({ type: "device.update", payload: { version: "0.5.0" } })).toEqual(
      { accepted: true },
    );
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ state: "installed" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.lockId).toBe("taken-after-waiting");
    expect(runs[0]!.budgetMs).toBeLessThan(SELF_UPDATE_DEADLINE_MS);
    expect(runs[0]!.budgetMs).toBeGreaterThan(SELF_UPDATE_DEADLINE_MS - 60_000);
  });

  test("a second command while one waits is refused", async () => {
    const dispatch = createCommandDispatch();
    registerSelfUpdateCommand(dispatch, {
      updater: createRecordingUpdater(),
      currentVersion: "0.4.0",
      acquireLock: () => {
        throw new UpdateLockBusyError(null);
      },
      emitResult: () => {},
      sleep: () => new Promise(() => {}),
    });
    const ask = () => dispatch.handle({ type: "device.update", payload: { version: "0.5.0" } });
    expect(await ask()).toEqual({ accepted: true });
    expect(await ask()).toEqual({
      accepted: false,
      reason: "An update is already running on this collector.",
    });
  });

  test("a wait that outlasts its limit is reported, naming the update still running", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-self-update-"));
    const holder = acquireUpdateLock(configDir, {
      owner: "harness self-update",
      currentStep: "building",
    });
    const dispatch = createCommandDispatch();
    const results: Array<WsEventPayload<"device.update.result">> = [];
    const updater = createRecordingUpdater();
    try {
      registerSelfUpdateCommand(dispatch, {
        updater,
        currentVersion: "0.4.0",
        acquireLock: () => acquireUpdateLock(configDir, { owner: "collector self-update" }),
        emitResult: (payload) => results.push(payload),
        handOver: () => {},
        lockWaitMs: 20,
      });
      const ask = () => dispatch.handle({ type: "device.update", payload: { version: "0.5.0" } });
      expect(await ask()).toEqual({ accepted: true });
      await vi.waitFor(() => expect(results).toHaveLength(1));
      expect(results[0]).toMatchObject({ state: "failed" });
      expect(results[0]!.detail).toMatch(
        /harness self-update \(PID \d+\), started .*, currently building, was still running on this host after waiting/,
      );
      expect(updater.calls).toEqual([]);

      // The failure released nothing it did not hold, and a later command runs.
      holder.release();
      expect(await ask()).toEqual({ accepted: true });
      await vi.waitFor(() => expect(updater.calls).toEqual(["0.5.0"]));
    } finally {
      holder.release();
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("what a failed self-update reports", () => {
  test("a multi-line refusal keeps the line that names its cause", async () => {
    const spawnFn = vi.fn(() =>
      childWriting(1, {
        stdout: "This host will:\n  - back up the gateway's databases through its API\n",
        stderr:
          "Could not take a backup through https://gateway.example.org:7600 before updating: fetch failed\n" +
          "This upgrade runs forward-only schema migrations, so the backup is the only way back.\n",
      }),
    );
    const updater = createCliUpdater({
      ...directHost,
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
    });
    const attempt = await updater.run({ version: "0.5.0", lockId: "owner-123" });
    expect(attempt).toEqual({
      state: "failed",
      detail:
        "`omnesis … update` exited 1. Could not take a backup through https://gateway.example.org:7600 " +
        "before updating: fetch failed This upgrade runs forward-only schema migrations, so the " +
        "backup is the only way back.",
    });
  });

  test("with nothing on stderr, the end of everything printed is the summary", async () => {
    const spawnFn = vi.fn(() =>
      childWriting(2, { stdout: "Fetching…\nNo release v9.9.9 exists.\n" }),
    );
    const updater = createCliUpdater({
      ...directHost,
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
    });
    const attempt = await updater.run({ version: "9.9.9", lockId: "owner-123" });
    expect(attempt.detail).toBe("`omnesis … update` exited 2. Fetching… No release v9.9.9 exists.");
  });

  test("a budget shortened by a lock wait is the deadline the update runs under", async () => {
    const killed: string[] = [];
    const handlers = new Map<string, (arg: unknown) => void>();
    const spawnFn = vi.fn(() => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: (event: string, fn: (arg: unknown) => void) => handlers.set(event, fn),
      kill: (signal: string) => {
        killed.push(signal);
        queueMicrotask(() => handlers.get("close")?.(143));
      },
    }));
    const updater = createCliUpdater({
      ...directHost,
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
      deadlineMs: 60 * 60_000,
      stopGraceMs: 50,
    });
    const attempt = await updater.run({ version: "0.5.0", lockId: "owner-123", budgetMs: 5 });
    expect(attempt.detail).toContain("did not finish");
    expect(killed).toEqual(["SIGTERM"]);
    const args = (spawnFn.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toContain("--wait-for-lock=1");
  });

  test("the detail sent to the gateway is capped at what the result event accepts", async () => {
    // The gateway drops a longer detail with its event, and the device row
    // would then read "dispatched" with no result at all.
    const b = bench({ answer: { state: "failed", detail: "x".repeat(5_000) } });
    await b.ask("0.5.0");
    await settle();
    const detail = b.results[0]!.detail!;
    expect(detail).toHaveLength(DEVICE_UPDATE_DETAIL_MAX_CHARS);
    expect(deviceUpdateResultEvent.safeParse(b.results[0]).success).toBe(true);
  });
});
