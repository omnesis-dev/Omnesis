// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as owned from "./e2e-owned-process.js";

import {
  spawnConnect,
  spawnCliProcess,
  terminateConnect,
  waitForExit,
  type SpawnedConnect,
} from "./connect-process.js";

import * as reaper from "./subprocess-reaper.js";

function acceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function joinPhysicalFixture(running: SpawnedConnect): Promise<void> {
  if (Object.hasOwn(running.child, "jobClosed")) await Reflect.get(running.child, "jobClosed");
  else await reaper.killSubprocessGroup(running.child);
}

/**
 * Wait, within a bound, for a terminated descendant's listener to stop accepting.
 * Cleanup returns once the Windows job object reports no active processes, and the
 * kernel drops a process from that count before it closes the process's handles,
 * so the descendant's listening socket can still accept for a moment after a
 * cleanup that positively joined its job.
 */
async function waitForPortReleased(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await acceptsConnections(port))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/** File creation can precede its contents; only a complete TCP port is ready. */
async function waitForFixturePort(path: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8").trim();
      const port = Number(text);
      if (/^[1-9]\d*$/.test(text) && Number.isSafeInteger(port) && port <= 65535) return port;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture did not write a TCP port to ${path}`);
}

describe("spawned connect process cleanup", () => {
  const roots: string[] = [];
  const runningProcesses: SpawnedConnect[] = [];

  afterEach(async () => {
    const results = await Promise.allSettled(runningProcesses.splice(0).map(terminateConnect));
    vi.restoreAllMocks();
    if (results.some((result) => result.status === "rejected")) {
      // A failed ownership proof retains every fixture rather than deleting live inputs.
      await Promise.all(
        results.map(async (result) => {
          if (result.status === "rejected") return Promise.reject(result.reason);
        }),
      );
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  test.each(["", "0", "not a port", "65536"])(
    "waits for valid port contents after file creation (%s)",
    async (initial) => {
      const root = mkdtempSync(join(tmpdir(), "omnesis-connect-port-"));
      roots.push(root);
      const path = join(root, "descendant.port");
      writeFileSync(path, initial);
      vi.useFakeTimers();
      try {
        let settled = false;
        const port = waitForFixturePort(path, 1000).then((value) => {
          settled = true;
          return value;
        });
        await vi.advanceTimersByTimeAsync(25);
        expect(settled).toBe(false);
        writeFileSync(path, "34567");
        await vi.advanceTimersByTimeAsync(25);
        await expect(port).resolves.toBe(34567);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  function fixture(
    program: string,
    registration?: (ready: Promise<void>) => Promise<void>,
  ): { root: string; running: SpawnedConnect } {
    const root = mkdtempSync(join(tmpdir(), "omnesis-connect literal-"));
    roots.push(root);
    const cliDir = join(root, "packages", "cli", "src");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(join(cliDir, "index.ts"), program);
    const running = spawnConnect(
      {
        repositoryRoot: root,
        args: ["literal space", "quote'\"", "&$;", "雪"],
        fakeBin: join(root, "bin"),
        cliConfigDir: join(root, "config"),
      },
      { registration },
    );
    runningProcesses.push(running);
    return { root, running };
  }

  test("waits for registration and captures literal argv and final UTF-8 output", async () => {
    let registered!: () => void;
    const registration = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const holdRegistration = (ready: Promise<void>) =>
      Promise.all([ready, registration]).then(() => {});
    const { running } = fixture(
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
      holdRegistration,
    );
    let settled = false;
    const result = waitForExit(running, 10_000).finally(() => {
      settled = true;
    });
    try {
      await expect
        .poll(() => running.output.join("").includes("雪"), { timeout: 10_000 })
        .toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      registered();
    }
    expect(await result).toEqual({
      code: 0,
      output: JSON.stringify(["connect", "literal space", "quote'\"", "&$;", "雪"]),
    });
  }, 20_000);

  test("owns a general CLI command through its real nonzero exit and separate split UTF-8 streams", async () => {
    const root = mkdtempSync(join(tmpdir(), "omnesis-cli literal-"));
    roots.push(root);
    const cliDir = join(root, "packages", "cli", "src");
    mkdirSync(cliDir, { recursive: true });
    writeFileSync(
      join(cliDir, "index.ts"),
      `void (async () => {
  const streams = [[process.stdout, JSON.stringify({args: process.argv.slice(2), config: process.env.OMNESIS_CONFIG_DIR})], [process.stderr, 'invented stderr 雪']];
  for (const [stream, text] of streams) {
    for (const byte of Buffer.from(text)) {
      stream.write(Buffer.from([byte]));
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  process.exitCode = 7;
})();`,
    );
    const args = ["cloud", "connect", "literal space", "雪", "&$;"];
    const config = join(root, "custom profile");
    const running = spawnCliProcess({
      repositoryRoot: root,
      args,
      env: { OMNESIS_CONFIG_DIR: config },
    });
    runningProcesses.push(running);
    expect(running.closed()).toBe(false);
    expect((await running.exit).code).toBe(7);
    expect(JSON.parse(running.stdout())).toEqual({ args, config });
    expect(running.stderr()).toBe("invented stderr 雪");
    expect(running.closed()).toBe(true);
    await running.stop();
    expect(running.closed()).toBe(true);
  }, 20_000);

  test.each([undefined, new Error("fixed unconfirmed registration")])(
    "retains explicit registration uncertainty after physical cleanup (%s)",
    async (receipt) => {
      let rejectRegistration!: (error: unknown) => void;
      const registration = new Promise<void>((_resolve, reject) => {
        rejectRegistration = reject;
      });
      void registration.catch(() => {});
      const holdRegistration = (ready: Promise<void>) =>
        Promise.all([ready, registration]).then(() => {});
      const { running } = fixture('process.stdout.write("finished");', holdRegistration);
      await new Promise<void>((resolve) => running.child.once("close", () => resolve()));
      await joinPhysicalFixture(running);
      const error = Object.assign(new Error("fixed registration failure"), {
        cleanupFailure: receipt,
      });
      rejectRegistration(error);
      await expect(waitForExit(running, 10_000)).rejects.toHaveProperty("cleanupFailure");
      await expect(terminateConnect(running)).rejects.toHaveProperty("cleanupFailure");
      // The artificial marker is injected only after this real fixture was joined.
      runningProcesses.splice(runningProcesses.indexOf(running), 1);
    },
    20_000,
  );

  test("an ordinary registration refusal still permits positively joined teardown", async () => {
    let rejectRegistration!: (error: unknown) => void;
    const registration = new Promise<void>((_yes, no) => {
      rejectRegistration = no;
    });
    void registration.catch(() => {});
    const holdRegistration = (ready: Promise<void>) =>
      Promise.all([ready, registration]).then(() => {});
    const { running } = fixture('process.stdout.write("finished");', holdRegistration);
    const closed = new Promise<void>((resolve) => running.child.once("close", () => resolve()));
    try {
      await closed;
      await joinPhysicalFixture(running);
      const failure = new Error("invented joined registration refusal");
      rejectRegistration(failure);
      await expect(waitForExit(running, 10_000)).rejects.toBe(failure);
      await expect(terminateConnect(running)).resolves.toBeUndefined();
    } finally {
      rejectRegistration(new Error("invented registration fixture cleanup"));
      await terminateConnect(running);
    }
  }, 20_000);

  test.each(["registration", "child"] as const)(
    "a later %s receipt dominates an earlier ordinary child error",
    async (producer) => {
      let rejectRegistration!: (error: unknown) => void;
      const registration = new Promise<void>((_yes, no) => {
        rejectRegistration = no;
      });
      void registration.catch(() => {});
      const holdRegistration = (ready: Promise<void>) =>
        Promise.all([ready, registration]).then(() => {});
      const { running } = fixture('process.stdout.write("finished");', holdRegistration);
      try {
        await new Promise<void>((resolve) => running.child.once("close", () => resolve()));
        await joinPhysicalFixture(running);
        running.child.emit("error", new Error("invented ordinary child failure"));
        const marker = Object.assign(new Error("invented later registration uncertainty"), {
          cleanupFailure: undefined,
        });
        if (producer === "registration") rejectRegistration(marker);
        else {
          running.child.emit("error", marker);
          rejectRegistration(new Error("invented joined registration refusal"));
        }
        await expect(waitForExit(running, 10_000)).rejects.toMatchObject({
          cleanupFailure: undefined,
          cause: marker,
        });
        await expect(terminateConnect(running)).rejects.toHaveProperty("cleanupFailure");
      } finally {
        rejectRegistration(new Error("invented registration fixture cleanup"));
        // This synthetic failure is injected only after positive physical cleanup.
        runningProcesses.splice(runningProcesses.indexOf(running), 1);
      }
    },
    20_000,
  );

  test("capture preserves a UTF-8 character split across stream chunks", async () => {
    const stream = new PassThrough();
    vi.spyOn(owned, "e2eProcessOutput").mockReturnValueOnce({ stdout: stream, stderr: null });
    const { running } = fixture('process.stdout.write("unused real output");');
    const bytes = Buffer.from("雪");
    stream.write(bytes.subarray(0, 1));
    stream.end(bytes.subarray(1));
    await expect(waitForExit(running, 10_000)).resolves.toEqual({ code: 0, output: "雪" });
  }, 20_000);

  test("a copied record cannot replace its opaque process owner", async () => {
    const { running } = fixture('process.stdout.write("finished");');
    await expect(waitForExit(running, 10_000)).resolves.toEqual({ code: 0, output: "finished" });
    await expect(terminateConnect({ ...running })).rejects.toHaveProperty("cleanupFailure");
  }, 20_000);

  test.each([false, true])(
    "descendant ports are released after command termination (leaderExited=%s)",
    async (leaderExited) => {
      const root = mkdtempSync(join(tmpdir(), "omnesis-connect-process-"));
      roots.push(root);
      const cliDir = join(root, "packages", "cli", "src");
      const fakeBin = join(root, "bin");
      const configDir = join(root, "config");
      const descendantPortPath = join(root, "descendant.port");
      for (const directory of [cliDir, fakeBin, configDir]) {
        mkdirSync(directory, { recursive: true });
      }
      const descendantProgram = [
        "process.on('SIGINT', () => {});",
        "process.on('SIGTERM', () => {});",
        "const { createServer } = require('node:net');",
        "const server = createServer();",
        "server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port)));",
        "setInterval(() => {}, 1000);",
      ].join("");
      writeFileSync(
        join(cliDir, "index.ts"),
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantProgram)}], { stdio: ["ignore", "pipe", "ignore"] });`,
          `child.stdout!.once("data", (data) => {
          writeFileSync(process.env.DESCENDANT_PORT_PATH!, data);
          ${leaderExited ? 'process.stdout.write("leader finished"); process.exit(7);' : ""}
        });`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );

      const running = spawnConnect({
        repositoryRoot: root,
        args: ["hermes"],
        fakeBin,
        cliConfigDir: configDir,
        env: {
          PATH: process.env.PATH,
          DESCENDANT_PORT_PATH: descendantPortPath,
        },
        inheritEnv: false,
      });
      runningProcesses.push(running);
      const port = await waitForFixturePort(descendantPortPath, 10_000);
      if (!leaderExited) expect(await acceptsConnections(port)).toBe(true);
      if (leaderExited) {
        await expect(waitForExit(running, 10_000)).resolves.toEqual({
          code: 7,
          output: "leader finished",
        });
      } else await terminateConnect(running);
      expect(await waitForPortReleased(port, 5_000)).toBe(true);
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", resolve);
        });
      } finally {
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    20_000,
  );
});
