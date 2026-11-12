// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { fork, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkerEntry } from "@omnesis/core";
import {
  HostedProcessLauncher,
  directProcessLauncher,
  STDERR_CAPTURE_CHARS,
  type ProcessLauncher,
} from "./index.js";
import type { LauncherRequest } from "../workers/process-launcher-host.js";

const hosts: HostedProcessLauncher[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

function hosted(): HostedProcessLauncher {
  const host = new HostedProcessLauncher();
  hosts.push(host);
  return host;
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString().trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `pid` is still running, as opposed to exited. `alive` also counts a
 * zombie, which the host tests rely on: the launcher's own child stays a
 * zombie until the gateway reaps it, and that reaping is the moment it has
 * noticed the host is gone. A program the host started is not this process's
 * child, so once the host kills it and exits, it waits as a zombie for
 * whatever adopts it to reap it, which a loaded machine may not do at once.
 */
function running(pid: number): boolean {
  return alive(pid) && processState(pid) !== "Z";
}

/** The single-letter state of `pid` (`R`, `S`, `Z`, …), or "" when it cannot be read. */
function processState(pid: number): string {
  if (process.platform === "linux") {
    try {
      // `pid (comm) S …`: the state follows the last ")", since comm may hold one.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    } catch {
      return "";
    }
  }
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return ps.stdout.trim().slice(0, 1);
}
async function eventually(check: () => boolean, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

const launchers: Array<[string, () => ProcessLauncher]> = [
  ["direct", () => directProcessLauncher],
  ["hosted", hosted],
];

describe.each(launchers)("%s launcher", (_name, make) => {
  it("returns a program's exit code, stdout bytes and stderr", async () => {
    const run = await make().run(
      "sh",
      ["-c", "printf 'out\\001\\377'; printf 'warn' >&2; exit 3"],
      { timeoutMs: 10_000 },
    );
    expect(run.exitCode).toBe(3);
    expect(run.failure).toBeUndefined();
    expect([...run.stdout]).toEqual([...Buffer.from("out"), 1, 255]);
    expect(run.stderr).toBe("warn");
  });

  it("feeds the input to stdin", async () => {
    const input = new Uint8Array(1024 * 1024).map((_, i) => i % 251);
    const run = await make().run("cat", [], { input, timeoutMs: 10_000 });
    expect(run.exitCode).toBe(0);
    expect(Buffer.from(run.stdout).equals(Buffer.from(input))).toBe(true);
  });

  it("discards stdout when asked to", async () => {
    const run = await make().run("sh", ["-c", "echo ignored"], {
      timeoutMs: 10_000,
      captureStdout: false,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.byteLength).toBe(0);
  });

  it("caps captured stderr", async () => {
    const run = await make().run(
      "sh",
      ["-c", `head -c ${STDERR_CAPTURE_CHARS * 3} /dev/zero >&2`],
      { timeoutMs: 10_000 },
    );
    expect(run.stderr.length).toBe(STDERR_CAPTURE_CHARS);
  });

  it("reports a program that cannot start", async () => {
    const run = await make().run("/nonexistent/omnesis-test-binary", [], { timeoutMs: 10_000 });
    expect(run).toMatchObject({ exitCode: null, failure: "spawn" });
    expect(run.failureMessage).toMatch(/ENOENT/);
  });

  it("kills a program and the processes it started when it outlives its timeout", async () => {
    const started = Date.now();
    // The background sleep holds the same pipes; the run must not wait for it.
    const run = await make().run("sh", ["-c", "sleep 30 & echo $!; sleep 30"], {
      timeoutMs: 300,
    });
    expect(run).toMatchObject({ exitCode: null, signal: "SIGKILL", failure: "timeout" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await eventually(() => !alive(Number(text(run.stdout))))).toBe(true);
  });

  it("kills a program when the caller aborts", async () => {
    const abort = new AbortController();
    const pending = make().run("sleep", ["30"], { timeoutMs: 30_000, signal: abort.signal });
    setTimeout(() => abort.abort(), 200);
    expect(await pending).toMatchObject({ exitCode: null, failure: "aborted" });
  });

  it("does not start a program for a caller that already stopped waiting", async () => {
    const abort = new AbortController();
    abort.abort();
    const run = await make().run("sh", ["-c", "exit 0"], {
      timeoutMs: 10_000,
      signal: abort.signal,
    });
    expect(run.failure).toBe("aborted");
  });
});

describe("hosted launcher", () => {
  it("forks programs from the host process, not from the caller", async () => {
    const run = await hosted().run("sh", ["-c", "echo $PPID"], { timeoutMs: 10_000 });
    const parent = Number(text(run.stdout));
    expect(parent).toBeGreaterThan(0);
    expect(parent).not.toBe(process.pid);
    const direct = await directProcessLauncher.run("sh", ["-c", "echo $PPID"], {
      timeoutMs: 10_000,
    });
    expect(Number(text(direct.stdout))).toBe(process.pid);
  });

  it("runs programs concurrently", async () => {
    const host = hosted();
    await host.start();
    // Timed here rather than inside the programs, whose clocks differ by
    // platform (BSD date on macOS has no %N) and by what the host inherits.
    const started = Date.now();
    await Promise.all(
      [1, 2, 3].map(() => host.run("sh", ["-c", "sleep 2"], { timeoutMs: 10_000 })),
    );
    // One after another, the three would take six seconds.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("kills a program in flight when its host dies, and starts a host for the next run", async () => {
    const host = hosted();
    const first = await host.run("sh", ["-c", "echo $PPID"], { timeoutMs: 10_000 });
    const hostPid = Number(text(first.stdout));
    const marker = join(mkdtempSync(join(tmpdir(), "omnesis-launcher-")), "pid");
    const pending = host.run("sh", ["-c", `echo $$ > ${marker}; sleep 30`], { timeoutMs: 30_000 });
    expect(await eventually(() => readdirSync(join(marker, "..")).includes("pid"))).toBe(true);
    const programPid = Number(readFileSync(marker, "utf8").trim());
    process.kill(hostPid, "SIGKILL");
    expect(await pending).toMatchObject({
      failure: "spawn",
      failureMessage: "process launcher exited",
    });
    expect(await eventually(() => !alive(programPid))).toBe(true);
    const next = await host.run("sh", ["-c", "echo $PPID"], { timeoutMs: 10_000 });
    expect(Number(text(next.stdout))).not.toBe(process.pid);
    expect(Number(text(next.stdout))).not.toBe(hostPid);
  });

  it("starts programs from the caller for a while once a second host dies soon after starting", async () => {
    const host = hosted();
    const hostPid = async () =>
      Number(text((await host.run("sh", ["-c", "echo $PPID"], { timeoutMs: 10_000 })).stdout));
    const first = await hostPid();
    process.kill(first, "SIGKILL");
    expect(await eventually(() => !alive(first))).toBe(true);
    const second = await hostPid();
    expect(second).not.toBe(process.pid);
    process.kill(second, "SIGKILL");
    expect(await eventually(() => !alive(second))).toBe(true);
    await sleep(100);
    expect(await hostPid()).toBe(process.pid);
  });

  it("keeps running programs through SIGTERM, which a service manager sends the whole group", async () => {
    const host = hosted();
    const first = await host.run("sh", ["-c", "echo $PPID"], { timeoutMs: 10_000 });
    const pending = host.run("sh", ["-c", "sleep 0.5; echo done"], { timeoutMs: 10_000 });
    await sleep(100);
    process.kill(Number(text(first.stdout)), "SIGTERM");
    const run = await pending;
    expect(run.exitCode).toBe(0);
    expect(text(run.stdout)).toBe("done");
  });

  it("stops the programs it is running when disposed", async () => {
    const host = hosted();
    const marker = join(mkdtempSync(join(tmpdir(), "omnesis-launcher-")), "pid");
    const pending = host.run("sh", ["-c", `echo $$ > ${marker}; sleep 30`], { timeoutMs: 30_000 });
    expect(await eventually(() => readdirSync(join(marker, "..")).includes("pid"))).toBe(true);
    const programPid = Number(readFileSync(marker, "utf8").trim());
    host.dispose();
    expect(await pending).toMatchObject({ failure: "spawn" });
    expect(
      await eventually(() => !running(programPid)),
      `program ${programPid} is still running (state ${processState(programPid) || "unknown"})`,
    ).toBe(true);
    // Disposed: later programs start from the caller, and no host is forked again.
    const after = await host.run("sh", ["-c", "echo $PPID"], { timeoutMs: 10_000 });
    expect(Number(text(after.stdout))).toBe(process.pid);
  });

  it("kills a program it could not report because the caller had already disconnected", async () => {
    const entry = resolveWorkerEntry(
      "../workers/process-launcher-host.ts",
      import.meta.url,
      "../workers/register-tsx.mjs",
    );
    const child = fork(fileURLToPath(entry.url), [], {
      execArgv: entry.execArgv,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await new Promise<void>((resolve) => child.once("message", () => resolve()));
    // The program is found by its name ($0), not by a pid it writes down: the
    // host may kill it before it has run a single command.
    const name = `omnesis-launcher-test-${randomUUID()}`;
    const programs = (): number[] =>
      spawnSync("pgrep", ["-f", name], { encoding: "utf8" })
        .stdout.split("\n")
        .filter(Boolean)
        .map(Number)
        .filter(running);
    const run: LauncherRequest = {
      type: "run",
      id: 1,
      command: "sh",
      args: ["-c", "sleep 30", name],
      opts: { timeoutMs: 30_000 },
    };
    // Disconnecting in the same tick closes the channel before the host can
    // report the program it starts: its "started" reply meets a closed pipe.
    child.send(run);
    child.disconnect();
    expect(await exited, stderr).toBe(0);
    expect(
      await eventually(() => programs().length === 0),
      `programs still running: ${programs().join(", ")}`,
    ).toBe(true);
  });

  it("starts programs from the caller while a failed host waits out its back-off", async () => {
    let now = 1_000;
    const real = resolveWorkerEntry(
      "../workers/process-launcher-host.ts",
      import.meta.url,
      "../workers/register-tsx.mjs",
    );
    const failing = join(mkdtempSync(join(tmpdir(), "omnesis-launcher-")), "exits.mjs");
    writeFileSync(failing, "process.exit(1);\n");
    const entry = { modulePath: failing, execArgv: real.execArgv };
    const host = new HostedProcessLauncher(entry, () => now);
    hosts.push(host);
    expect(await host.start()).toBe(false);
    const run = await host.run("sh", ["-c", "echo $PPID"], { timeoutMs: 10_000 });
    expect(Number(text(run.stdout))).toBe(process.pid);
    // A host that could start now is still not tried until the back-off ends.
    entry.modulePath = fileURLToPath(real.url);
    now += 10_000;
    expect(await host.start()).toBe(false);
    now += 60_000;
    expect(await host.start()).toBe(true);
  });
});

it("starts the gateway's per-request programs only through the process launcher", () => {
  const src = fileURLToPath(new URL("..", import.meta.url));
  const files = [
    "ocr/image-prep.ts",
    "ocr/gguf-ocr.ts",
    "ocr/apple-vision-ocr.ts",
    "ocr/tesseract-ocr.ts",
    "transcribe/audio-decode.ts",
  ];
  for (const file of files)
    expect(readFileSync(join(src, file), "utf8"), file).not.toMatch(/node:child_process/);
});
