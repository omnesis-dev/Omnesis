// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The harness plugin's half of a fleet update — a second implementation of
 * the device-side contract, because this package runs on a machine with no
 * Omnesis checkout and shares no runtime code with the collector's.
 */

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  AgentIntegrationClient,
  defaultIntegrationCapability,
  type WebSocketFactory,
} from "./client.js";
import { DurableIntegrationInbox } from "./inbox.js";
import {
  createHarnessCliUpdater,
  detachedHarnessRestart,
  lockWaitMinutes,
  resolveCliPath,
  resolveHarnessBinary,
} from "./self-update.js";
import { DEVICE_UPDATE_DETAIL_MAX_CHARS } from "./protocol.js";
import type { RawData } from "ws";
import type { HarnessRestart, HarnessSelfUpdater, HarnessUpdateAttempt } from "./self-update.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  /** Write callbacks not yet called, while `holdWrites` is set. */
  pendingWrites: Array<() => void> = [];
  holdWrites = false;

  send(data: string, written?: (error?: Error) => void): void {
    this.sent.push(data);
    if (!written) return;
    if (this.holdWrites) this.pendingWrites.push(() => written());
    else queueMicrotask(() => written());
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  open(): void {
    this.emit("open");
  }

  message(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)) as RawData);
  }
}

const inboxes: DurableIntegrationInbox[] = [];

afterEach(() => {
  for (const inbox of inboxes.splice(0)) inbox.close();
});

function setup(selfUpdater?: HarnessSelfUpdater): {
  socket: FakeSocket;
  client: AgentIntegrationClient;
} {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const inbox = new DurableIntegrationInbox(":memory:");
  inboxes.push(inbox);
  const client = new AgentIntegrationClient({
    gatewayUrl: "http://127.0.0.1:7600",
    deliveryToken: "omn_delivery_example",
    capability: defaultIntegrationCapability("openclaw"),
    inbox,
    starter: async () => ({ localRunId: "run-1", nativeSessionId: "session-1" }),
    ...(selfUpdater ? { selfUpdater } : {}),
    webSocketFactory: factory,
    now: () => 1_800_000_000_000,
  });
  client.start();
  const socket = sockets[0]!;
  socket.open();
  const hello = JSON.parse(socket.sent[0]!) as { id: string };
  socket.message({
    kind: "response",
    correlationId: hello.id,
    ok: true,
    result: {
      deviceId: "device-fictional",
      scopes: ["subscriptions:receive"],
      deviceName: "Fictional OpenClaw",
      deviceKind: "agent",
      protocolVersion: 1,
    },
  });
  return { socket, client };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The frames the client sent after the hello, parsed. */
function frames(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.slice(1).map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function sendUpdate(socket: FakeSocket, version: string, id = "cmd-1"): void {
  socket.message({ kind: "command", id, type: "device.update", payload: { version } });
}

function sendCommitUpdate(socket: FakeSocket, commit: string, id = "cmd-commit"): void {
  socket.message({ kind: "command", id, type: "device.update", payload: { commit } });
}

describe("the harness plugin's device.update handler", () => {
  test("passes an exact commit to the updater and reports the same target", async () => {
    const commit = "a".repeat(40);
    const updater: HarnessSelfUpdater = {
      run: vi.fn(
        async (): Promise<HarnessUpdateAttempt> => ({
          state: "failed",
          detail: "invented failure",
        }),
      ),
    };
    const { socket } = setup(updater);

    sendCommitUpdate(socket, commit);
    await flush();
    await flush();

    expect(updater.run).toHaveBeenCalledWith({ commit });
    expect(frames(socket)[1]?.payload).toMatchObject({ commit, state: "failed" });
  });

  test("acknowledges, reports installed, then restarts the harness once that is written", async () => {
    let release: (attempt: HarnessUpdateAttempt) => void = () => {};
    const order: string[] = [];
    const restart: HarnessRestart = {
      command: "/opt/example/bin/openclaw gateway restart",
      start: vi.fn(() => {
        order.push("restart");
      }),
    };
    const { socket } = setup({
      run: () => new Promise((resolve) => (release = resolve)),
    });
    sendUpdate(socket, "0.5.0");
    await flush();
    expect(frames(socket)).toEqual([
      { kind: "response", correlationId: "cmd-1", ok: true, result: { accepted: true } },
    ]);

    socket.holdWrites = true;
    release({
      state: "installed",
      detail: "Installed 0.5.0; restarting openclaw now: /opt/example/bin/openclaw gateway restart",
      restart,
    });
    await flush();
    const result = frames(socket)[1];
    expect(result).toMatchObject({ kind: "event", type: "device.update.result" });
    expect(result?.payload).toMatchObject({ version: "0.5.0", state: "installed" });
    // The payload carries the state and detail only, never the restart handle.
    expect(Object.keys(result?.payload as object).sort()).toEqual(["detail", "state", "version"]);
    // Not before the result has reached the operating system.
    expect(restart.start).not.toHaveBeenCalled();

    order.push("written");
    for (const written of socket.pendingWrites.splice(0)) written();
    await flush();
    expect(order).toEqual(["written", "restart"]);
    expect(frames(socket)).toHaveLength(2);
  });

  test("a restart that fails turns the result into restart-pending with the manual command", async () => {
    let onFailure: (detail: string) => void = () => {};
    const { socket } = setup({
      run: () =>
        Promise.resolve({
          state: "installed",
          detail: "Installed 0.5.0; restarting openclaw now: openclaw gateway restart",
          restart: {
            command: "openclaw gateway restart",
            start: (fail) => {
              onFailure = fail;
            },
          },
        }),
    });
    sendUpdate(socket, "0.5.0");
    await flush();
    await flush();
    onFailure(
      "Installed 0.5.0. Restarting openclaw failed: `openclaw gateway restart` exited 1. " +
        "Restart openclaw to load it: openclaw gateway restart",
    );
    const owed = frames(socket)[2];
    expect(owed).toMatchObject({
      kind: "event",
      type: "device.update.result",
      payload: { version: "0.5.0", state: "restart-pending" },
    });
    expect((owed?.payload as { detail: string }).detail).toContain(
      "Restart openclaw to load it: openclaw gateway restart",
    );
  });

  test("a failed update restarts nothing", async () => {
    const { socket } = setup({
      run: () => Promise.resolve({ state: "failed", detail: "`omnesis update` exited 1." }),
    });
    sendUpdate(socket, "0.5.0");
    await flush();
    await flush();
    expect(frames(socket)[1]?.payload).toMatchObject({ state: "failed" });
    expect(frames(socket)).toHaveLength(2);
  });

  test("a plugin stopped while its update ran does not restart the harness", async () => {
    let release: (attempt: HarnessUpdateAttempt) => void = () => {};
    const restart: HarnessRestart = { command: "openclaw gateway restart", start: vi.fn() };
    const { socket, client } = setup({
      run: () => new Promise((resolve) => (release = resolve)),
    });
    sendUpdate(socket, "0.5.0");
    await flush();
    const stopped = client.stop();
    release({ state: "installed", restart });
    await stopped;
    expect(restart.start).not.toHaveBeenCalled();
  });

  test("a plugin with no updater refuses rather than going silent", async () => {
    const { socket } = setup();
    sendUpdate(socket, "0.5.0");
    await flush();
    expect(frames(socket)[0]).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
  });

  test("the version already running is refused", async () => {
    const updater = { run: vi.fn() };
    const { socket } = setup(updater as unknown as HarnessSelfUpdater);
    // INTEGRATION_VERSION is this package's own manifest version.
    const { INTEGRATION_VERSION } = await import("./version.js");
    sendUpdate(socket, INTEGRATION_VERSION);
    await flush();
    expect(frames(socket)[0]).toMatchObject({
      ok: true,
      result: { accepted: false },
    });
    expect(updater.run).not.toHaveBeenCalled();
  });

  test("a second command while one runs is refused, not queued", async () => {
    let runs = 0;
    const { socket } = setup({
      run: () => {
        runs += 1;
        return new Promise(() => {});
      },
    });
    sendUpdate(socket, "0.5.0", "cmd-1");
    await flush();
    sendUpdate(socket, "0.5.0", "cmd-2");
    await flush();
    expect(runs).toBe(1);
    const second = frames(socket)[1] as { result?: { accepted: boolean; reason?: string } };
    expect(second.result?.accepted).toBe(false);
    expect(second.result?.reason).toContain("already running");
  });

  test("a version that is not a release never reaches the updater", async () => {
    // The command schema accepts a release version and nothing else, which is
    // what keeps an arbitrary string out of the argument list of a command
    // this machine runs on itself.
    const updater = { run: vi.fn() };
    const { socket } = setup(updater as unknown as HarnessSelfUpdater);
    for (const [index, version] of ["main", "0.5", "--registry=evil", "; rm -rf /"].entries()) {
      sendUpdate(socket, version, `bad-${index}`);
    }
    await flush();
    for (const frame of frames(socket)) {
      expect(frame).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    }
    expect(updater.run).not.toHaveBeenCalled();
  });
});

describe("createHarnessCliUpdater", () => {
  test("passes an exact commit to the CLI as one argument", async () => {
    const commit = "a".repeat(40);
    const spawnFn = vi.fn(() => fakeChild(1, "invented failure\n"));
    const updater = createHarnessCliUpdater({
      harness: "openclaw",
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
    });

    await updater.run({ commit });

    expect(spawnFn).toHaveBeenCalledWith(
      "omnesis",
      ["update", "--yes", "--no-restart", `--commit=${commit}`, "--wait-for-lock=30"],
      expect.anything(),
    );
  });

  test("the operator's rewind permission becomes --allow-rewind", async () => {
    const spawnFn = vi.fn(() => fakeChild(1, "invented failure\n"));
    const updater = createHarnessCliUpdater({
      harness: "openclaw",
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
    });

    await updater.run({ version: "0.5.0", allowRewind: true });

    expect(spawnFn).toHaveBeenCalledWith(
      "omnesis",
      [
        "update",
        "--yes",
        "--no-restart",
        "--target-version=0.5.0",
        "--allow-rewind",
        "--wait-for-lock=30",
      ],
      expect.anything(),
    );
  });

  test("the CLI restarts nothing, and a clean exit hands back a detached harness restart", async () => {
    const child = { unref: vi.fn(), once: vi.fn() };
    const spawnFn = vi.fn((command: string) =>
      command.endsWith("/omnesis") ? fakeChild(0, "") : child,
    );
    const updater = createHarnessCliUpdater({
      harness: "openclaw",
      cliPath: "/usr/local/bin/omnesis",
      spawnFn: spawnFn as never,
      resolveHarness: () => "/opt/example/bin/openclaw",
    });
    const attempt = await updater.run({ version: "0.5.0" });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).toHaveBeenCalledWith(
      "/usr/local/bin/omnesis",
      ["update", "--yes", "--no-restart", "--target-version=0.5.0", "--wait-for-lock=30"],
      expect.anything(),
    );
    expect(attempt.state).toBe("installed");
    expect(attempt.restart?.command).toBe("/opt/example/bin/openclaw gateway restart");
    expect(attempt.detail).toContain("restarting openclaw now");

    attempt.restart?.start(() => {});
    expect(spawnFn).toHaveBeenCalledTimes(2);
    const [command, args, options] = spawnFn.mock.calls[1] as unknown as [
      string,
      string[],
      { detached: boolean; stdio: string; env: NodeJS.ProcessEnv },
    ];
    expect(command).toBe("/opt/example/bin/openclaw");
    expect(args).toEqual(["gateway", "restart"]);
    expect(options.detached).toBe(true);
    expect(options.stdio).toBe("ignore");
    expect(options.env.PATH?.startsWith("/opt/example/bin")).toBe(true);
    expect(child.unref).toHaveBeenCalled();
  });

  test("an install with no harness executable to restart reports the restart owed", async () => {
    const updater = createHarnessCliUpdater({
      harness: "openclaw",
      cliPath: "omnesis",
      spawnFn: vi.fn(() => fakeChild(0, "")) as never,
      resolveHarness: () => null,
    });
    const attempt = await updater.run({ version: "0.5.0" });
    expect(attempt.state).toBe("restart-pending");
    expect(attempt.restart).toBeUndefined();
    expect(attempt.detail).toBe(
      "Installed 0.5.0. Restarting openclaw failed: `openclaw` was not found on this machine. " +
        "Restart openclaw to load it: openclaw gateway restart",
    );
  });

  test("a non-zero exit carries the CLI's own last line back", async () => {
    const spawnFn = vi.fn(() =>
      fakeChild(1, "Fetching…\nNo release v9.9.9 exists on this installation's remote.\n"),
    );
    const updater = createHarnessCliUpdater({
      harness: "hermes",
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
    });
    const attempt = await updater.run({ version: "9.9.9" });
    expect(attempt.state).toBe("failed");
    expect(attempt.detail).toContain("No release v9.9.9 exists");
    expect(attempt.restart).toBeUndefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  test("a child that never settles is stopped and reported", async () => {
    const killed: string[] = [];
    const spawnFn = vi.fn(() => ({
      stdout: { on: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: (signal: string) => killed.push(signal),
    }));
    const updater = createHarnessCliUpdater({
      harness: "openclaw",
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
      deadlineMs: 5,
    });
    const attempt = await updater.run({ version: "0.5.0" });
    expect(attempt.state).toBe("failed");
    expect(attempt.detail).toContain("did not finish");
    expect(killed).toEqual(["SIGKILL"]);
  });
});

describe("waiting and reporting", () => {
  test("the lock wait is two thirds of the deadline, in whole minutes", () => {
    expect(lockWaitMinutes(45 * 60_000)).toBe(30);
    expect(lockWaitMinutes(5)).toBe(1);
  });

  test("a multi-line refusal on stderr keeps the line that names its cause", async () => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const stream = (text: string) => ({
      on: (event: string, fn: (chunk: Buffer) => void) => {
        if (event === "data") queueMicrotask(() => fn(Buffer.from(text)));
      },
    });
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => queueMicrotask(() => handlers.get("close")?.(1)));
      return {
        stdout: stream("This host will:\n  - refresh the openclaw plugin\n"),
        stderr: stream(
          "collector self-update (PID 42), currently building, was still running on this host " +
            "after waiting 30 minutes.\nRun the update again once it finishes.\n",
        ),
        kill: () => {},
        on: (event: string, fn: (arg: unknown) => void) => handlers.set(event, fn),
      };
    });
    const updater = createHarnessCliUpdater({
      harness: "openclaw",
      cliPath: "omnesis",
      spawnFn: spawnFn as never,
    });
    const attempt = await updater.run({ version: "0.5.0" });
    expect(attempt.detail).toBe(
      "`omnesis update` exited 1. collector self-update (PID 42), currently building, was still " +
        "running on this host after waiting 30 minutes. Run the update again once it finishes.",
    );
  });

  test("the detail sent to the gateway is capped at what the result event accepts", async () => {
    const { socket } = setup({
      run: () => Promise.resolve({ state: "failed", detail: "z".repeat(5_000) }),
    });
    sendUpdate(socket, "0.5.0");
    await flush();
    await flush();
    const result = frames(socket)[1] as { payload: { detail: string } };
    expect(result.payload.detail).toHaveLength(DEVICE_UPDATE_DETAIL_MAX_CHARS);
    expect(result.payload.detail.endsWith("…")).toBe(true);
  });
});

describe("detachedHarnessRestart", () => {
  /** A detached child double whose exit and error events the test fires. */
  function detachedChild(): {
    child: unknown;
    emit: (event: "exit" | "error", value: unknown) => void;
  } {
    const listeners = new Map<string, (value: unknown) => void>();
    return {
      child: {
        unref: () => {},
        once: (event: string, fn: (value: unknown) => void) => listeners.set(event, fn),
      },
      emit: (event, value) => listeners.get(event)?.(value),
    };
  }

  const restartFor = (spawnFn: unknown) =>
    detachedHarnessRestart({
      harness: "openclaw",
      version: "0.5.0",
      binary: "/opt/example/bin/openclaw",
      spawnFn: spawnFn as never,
      env: { PATH: "/usr/bin" },
      execPath: "/opt/example/node/bin/node",
    });

  test("a spawn that throws reports the restart owed with the manual command", () => {
    const failures: string[] = [];
    restartFor(() => {
      throw new Error("EINVAL");
    }).start((detail) => failures.push(detail));
    expect(failures).toEqual([
      "Installed 0.5.0. Restarting openclaw failed: `/opt/example/bin/openclaw gateway restart` " +
        "could not be started (EINVAL). Restart openclaw to load it: openclaw gateway restart",
    ]);
  });

  test("an error event, then a non-zero exit, report once", () => {
    const failures: string[] = [];
    const { child, emit } = detachedChild();
    restartFor(() => child).start((detail) => failures.push(detail));
    emit("error", new Error("EACCES"));
    emit("exit", 1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("could not be started (EACCES)");
  });

  test("a non-zero exit is a failure; a clean exit or a signal is not", () => {
    for (const [code, expected] of [
      [2, 1],
      [0, 0],
      [null, 0],
    ] as const) {
      const failures: string[] = [];
      const { child, emit } = detachedChild();
      restartFor(() => child).start((detail) => failures.push(detail));
      emit("exit", code);
      expect(failures).toHaveLength(expected);
    }
  });

  test("the binary's directory and this Node lead the restart's PATH", () => {
    const spawnFn = vi.fn(() => detachedChild().child);
    restartFor(spawnFn).start(() => {});
    const options = (
      spawnFn.mock.calls[0] as unknown as [string, string[], { env: { PATH: string } }]
    )[2];
    expect(options.env.PATH).toBe("/opt/example/bin:/opt/example/node/bin:/usr/bin");
  });
});

describe("resolveHarnessBinary", () => {
  test("PATH wins, then the directory of the Node running the plugin", () => {
    const present = new Set(["/srv/tools/openclaw", "/opt/example/node/bin/openclaw"]);
    const isExecutable = (path: string) => present.has(path);
    expect(
      resolveHarnessBinary("openclaw", {
        env: { PATH: "/usr/bin:/srv/tools", HOME: "/home/example" },
        execPath: "/opt/example/node/bin/node",
        isExecutable,
      }),
    ).toBe("/srv/tools/openclaw");
    expect(
      resolveHarnessBinary("openclaw", {
        env: { PATH: "/usr/bin:/bin", HOME: "/home/example" },
        execPath: "/opt/example/node/bin/node",
        isExecutable,
      }),
    ).toBe("/opt/example/node/bin/openclaw");
  });

  test("a minimal service PATH still finds the user-local and Homebrew installs", () => {
    const env = { PATH: "/usr/bin:/bin", HOME: "/home/example" };
    const execPath = "/opt/example/node/bin/node";
    expect(
      resolveHarnessBinary("hermes", {
        env,
        execPath,
        isExecutable: (path) => path === "/home/example/.local/bin/hermes",
      }),
    ).toBe("/home/example/.local/bin/hermes");
    expect(
      resolveHarnessBinary("openclaw", {
        env,
        execPath,
        isExecutable: (path) => path === "/opt/homebrew/bin/openclaw",
      }),
    ).toBe("/opt/homebrew/bin/openclaw");
    expect(resolveHarnessBinary("openclaw", { env, execPath, isExecutable: () => false })).toBe(
      null,
    );
  });
});

describe("resolveCliPath", () => {
  test("an explicit override wins", () => {
    expect(resolveCliPath({ OMNESIS_CLI_BIN: "/opt/omnesis/bin/omnesis", HOME: "/home/dev" })).toBe(
      "/opt/omnesis/bin/omnesis",
    );
  });

  test("a machine with no installer wrapper falls back to PATH", () => {
    expect(resolveCliPath({ HOME: "/nonexistent-home-for-this-test" })).toBe("omnesis");
  });
});

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
    kill: () => {},
    on: (event: string, fn: (arg: unknown) => void) => {
      handlers.set(event, fn);
    },
  };
}
