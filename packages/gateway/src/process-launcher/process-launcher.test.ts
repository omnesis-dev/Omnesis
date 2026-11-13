// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { fork, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

/** Never turn an empty/failed parent probe into kill(0) or signal the test worker. */
function checkedHostPid(run: Awaited<ReturnType<ProcessLauncher["run"]>>): number {
  expect(run.failure, run.failureMessage ?? run.stderr).toBeUndefined();
  const pid = Number(text(run.stdout));
  expect(
    Number.isSafeInteger(pid) && pid > 0,
    `Invalid launcher host PID: ${text(run.stdout)}`,
  ).toBe(true);
  expect(pid).not.toBe(process.pid);
  return pid;
}

// Windows programs are contained by a native job owned by a helper process.
// Query the helper's physical parent to verify the actual Node launcher host.
const reportLauncherParent =
  process.platform === "win32"
    ? `const {execFileSync}=require('node:child_process'); process.stdout.write(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','(Get-CimInstance Win32_Process -Filter "ProcessId='+process.ppid+'").ParentProcessId'],{encoding:'utf8'}).trim());`
    : "console.log(process.ppid)";
const processBudget = process.platform === "win32" ? 20_000 : 10_000;
const timeoutBudget = process.platform === "win32" ? 5_000 : 1_000;

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
  if (process.platform === "win32") return "";
  const ps = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  return ps.stdout.trim().slice(0, 1);
}
/**
 * A complete newline-delimited process ID, or 0 until the whole line is there.
 * A program creates the file before it writes to it, so a file
 * that exists can still be empty, and `Number("")` is 0, a process ID that
 * `kill(0, 0)` reports alive whatever happened to the program.
 */
function pidIn(path: string): number {
  try {
    const line = readFileSync(path, "utf8");
    return /^[1-9]\d*\n$/.test(line) ? Number(line) : 0;
  } catch {
    return 0;
  }
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
      process.execPath,
      [
        "-e",
        "process.stdout.write(Buffer.from([111,117,116,1,255])); process.stderr.write('warn'); process.exitCode=3;",
      ],
      { timeoutMs: processBudget },
    );
    expect(run.exitCode).toBe(3);
    expect(run.failure).toBeUndefined();
    expect([...run.stdout]).toEqual([...Buffer.from("out"), 1, 255]);
    expect(run.stderr).toBe("warn");
  });

  it("feeds the input to stdin", async () => {
    const input = new Uint8Array(1024 * 1024).map((_, i) => i % 251);
    const run = await make().run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      input,
      timeoutMs: 10_000,
    });
    expect(run.exitCode).toBe(0);
    expect(Buffer.from(run.stdout).equals(Buffer.from(input))).toBe(true);
  });

  it("discards stdout when asked to", async () => {
    const run = await make().run(process.execPath, ["-e", "process.stdout.write('ignored')"], {
      timeoutMs: 10_000,
      captureStdout: false,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout.byteLength).toBe(0);
  });

  it("caps captured stderr", async () => {
    const run = await make().run(
      process.execPath,
      ["-e", `process.stderr.write(Buffer.alloc(${STDERR_CAPTURE_CHARS * 3}))`],
      { timeoutMs: processBudget },
    );
    expect(run.stderr.length).toBe(STDERR_CAPTURE_CHARS);
  });

  it("reports a program that cannot start", async () => {
    const run = await make().run("/nonexistent/omnesis-test-binary", [], {
      timeoutMs: processBudget,
    });
    expect(run).toMatchObject({ exitCode: null, failure: "spawn" });
    expect(run.failureMessage).toMatch(/ENOENT/);
  });

  it("kills a program and the processes it started when it outlives its timeout", async () => {
    const started = Date.now();
    // The descendant holds the same pipes; the run must not wait for it.
    const run = await make().run(
      process.execPath,
      [
        "-e",
        `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:['ignore',1,2]});
      console.log(child.pid);
      setTimeout(()=>{},30000);
    `,
      ],
      { timeoutMs: timeoutBudget },
    );
    expect(run.failure).toBe("timeout");
    if (process.platform !== "win32")
      expect(run).toMatchObject({ exitCode: null, signal: "SIGKILL" });
    expect(Date.now() - started).toBeLessThan(processBudget);
    expect(await eventually(() => !alive(Number(text(run.stdout))))).toBe(true);
  });

  it("kills a program when the caller aborts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-launcher-abort-"));
    const marker = join(dir, "ready");
    const abort = new AbortController();
    const pending = make().run(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],String(process.pid)+'\\n'); setTimeout(()=>{},30000)",
        marker,
      ],
      {
        timeoutMs: 30_000,
        signal: abort.signal,
      },
    );
    try {
      expect(await eventually(() => pidIn(marker) > 0, processBudget)).toBe(true);
      const pid = pidIn(marker);
      abort.abort();
      expect(await pending).toMatchObject({ exitCode: null, failure: "aborted" });
      expect(await eventually(() => !alive(pid))).toBe(true);
    } finally {
      abort.abort();
      await pending;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not start a program for a caller that already stopped waiting", async () => {
    const abort = new AbortController();
    abort.abort();
    const run = await make().run(process.execPath, ["-e", "process.exit(0)"], {
      timeoutMs: 10_000,
      signal: abort.signal,
    });
    expect(run.failure).toBe("aborted");
  });
});

describe("hosted launcher", () => {
  it("forks programs from the host process, not from the caller", async () => {
    const run = await hosted().run(process.execPath, ["-e", reportLauncherParent], {
      timeoutMs: 10_000,
    });
    const parent = Number(text(run.stdout));
    expect(parent).toBeGreaterThan(0);
    expect(parent).not.toBe(process.pid);
    const direct = await directProcessLauncher.run(process.execPath, ["-e", reportLauncherParent], {
      timeoutMs: 10_000,
    });
    expect(Number(text(direct.stdout))).toBe(process.pid);
  });

  it("runs programs concurrently", async () => {
    const host = hosted();
    await host.start();
    const dir = mkdtempSync(join(tmpdir(), "omnesis-launcher-concurrent-"));
    const release = join(dir, "release");
    const runs = [1, 2, 3].map((id) =>
      host.run(
        process.execPath,
        [
          "-e",
          `
      const fs=require('node:fs'); fs.writeFileSync(process.argv[1],'ready');
      const poll=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(poll);setTimeout(()=>{},2000)}},10);
    `,
          join(dir, String(id)),
          release,
        ],
        { timeoutMs: 30_000 },
      ),
    );
    try {
      // All programs must be alive together; exclude helper startup from timing.
      expect(
        await eventually(
          () => [1, 2, 3].every((id) => existsSync(join(dir, String(id)))),
          processBudget,
        ),
      ).toBe(true);
      const started = Date.now();
      writeFileSync(release, "go");
      const results = await Promise.all(runs);
      expect(results.map((run) => run.exitCode)).toEqual([0, 0, 0]);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      writeFileSync(release, "go");
      await Promise.all(runs);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills a program in flight when its host dies, and starts a host for the next run", async () => {
    const host = hosted();
    const first = await host.run(process.execPath, ["-e", reportLauncherParent], {
      timeoutMs: 10_000,
    });
    const hostPid = checkedHostPid(first);
    const marker = join(mkdtempSync(join(tmpdir(), "omnesis-launcher-")), "pid");
    const pending = host.run(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],String(process.pid)+'\\n'); setTimeout(()=>{},30000)",
        marker,
      ],
      { timeoutMs: 30_000 },
    );
    expect(await eventually(() => pidIn(marker) > 0, processBudget)).toBe(true);
    const programPid = pidIn(marker);
    process.kill(hostPid, "SIGKILL");
    expect(await pending).toMatchObject({
      failure: "spawn",
      failureMessage: "process launcher exited",
    });
    expect(await eventually(() => !alive(programPid))).toBe(true);
    const next = await host.run(process.execPath, ["-e", reportLauncherParent], {
      timeoutMs: 10_000,
    });
    expect(Number(text(next.stdout))).not.toBe(process.pid);
    expect(Number(text(next.stdout))).not.toBe(hostPid);
  });

  it("starts programs from the caller for a while once a second host dies soon after starting", async () => {
    const host = hosted();
    const hostPid = async () =>
      checkedHostPid(
        await host.run(process.execPath, ["-e", reportLauncherParent], {
          timeoutMs: processBudget,
        }),
      );
    const first = await hostPid();
    process.kill(first, "SIGKILL");
    expect(await eventually(() => !alive(first))).toBe(true);
    const second = await hostPid();
    expect(second).not.toBe(process.pid);
    process.kill(second, "SIGKILL");
    expect(await eventually(() => !alive(second))).toBe(true);
    await sleep(100);
    const fallback = await host.run(process.execPath, ["-e", reportLauncherParent], {
      timeoutMs: processBudget,
    });
    expect(fallback.failure, fallback.failureMessage ?? fallback.stderr).toBeUndefined();
    expect(Number(text(fallback.stdout))).toBe(process.pid);
  });

  it.skipIf(process.platform === "win32")(
    "keeps running programs through SIGTERM, which a service manager sends the whole group",
    async () => {
      const host = hosted();
      const first = await host.run(process.execPath, ["-e", reportLauncherParent], {
        timeoutMs: 10_000,
      });
      const pending = host.run(
        process.execPath,
        ["-e", "setTimeout(()=>console.log('done'),500)"],
        { timeoutMs: processBudget },
      );
      await sleep(100);
      process.kill(checkedHostPid(first), "SIGTERM");
      const run = await pending;
      expect(run.exitCode).toBe(0);
      expect(text(run.stdout)).toBe("done");
    },
  );

  it("stops the programs it is running when disposed", async () => {
    const host = hosted();
    const marker = join(mkdtempSync(join(tmpdir(), "omnesis-launcher-")), "pid");
    const pending = host.run(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],String(process.pid)+'\\n'); setTimeout(()=>{},30000)",
        marker,
      ],
      { timeoutMs: 30_000 },
    );
    expect(await eventually(() => pidIn(marker) > 0, processBudget)).toBe(true);
    const programPid = pidIn(marker);
    host.dispose();
    expect(await pending).toMatchObject({ failure: "spawn" });
    expect(
      await eventually(() => !running(programPid)),
      `program ${programPid} is still running (state ${processState(programPid) || "unknown"})`,
    ).toBe(true);
    // Disposed: later programs start from the caller, and no host is forked again.
    const after = await host.run(process.execPath, ["-e", reportLauncherParent], {
      timeoutMs: 10_000,
    });
    expect(Number(text(after.stdout))).toBe(process.pid);
  });

  it("kills a program it could not report because the caller had already disconnected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-launcher-disconnect-"));
    const marker = join(dir, "program-pid");
    const spawned = join(dir, "spawned-pids");
    const preload = join(dir, "record-spawn.mjs");
    // Record ownership in the host at spawn(), before its IPC publication can
    // fail. This also observes a program killed before its JavaScript starts.
    writeFileSync(
      preload,
      `
      import childProcess from 'node:child_process';
      import {appendFileSync} from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const original=childProcess.spawn;
      childProcess.spawn=(...args)=>{
        const child=original(...args);
        if(child.pid)appendFileSync(${JSON.stringify(spawned)},String(child.pid)+'\\n');
        return child;
      };
      syncBuiltinESMExports();
    `,
    );
    const controls = (): number[] => {
      try {
        return readFileSync(spawned, "utf8")
          .split("\n")
          .filter((line) => /^[1-9]\d*$/u.test(line))
          .map(Number);
      } catch {
        return [];
      }
    };
    const entry = resolveWorkerEntry(
      "../workers/process-launcher-host.ts",
      import.meta.url,
      "../workers/register-tsx.mjs",
    );
    const child = fork(fileURLToPath(entry.url), [], {
      execArgv: [...entry.execArgv, "--import", pathToFileURL(preload).href],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(new Error(`Launcher exited before ready: ${stderr}`)));
      });
      const run: LauncherRequest = {
        type: "run",
        id: 1,
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1],String(process.pid)+'\\n'); setTimeout(()=>{},30000)",
          marker,
        ],
        opts: { timeoutMs: 30_000 },
      };
      // Close in the same tick, before the host can publish the control PID.
      child.send(run);
      child.disconnect();
      expect(await exited, stderr).toBe(0);
      expect(controls().length).toBeGreaterThan(0);
      expect(
        await eventually(() => controls().every((pid) => !running(pid)), processBudget),
        `owned controls still running: ${controls().join(", ")}`,
      ).toBe(true);
      const payloadPid = pidIn(marker);
      if (payloadPid > 0)
        expect(await eventually(() => !running(payloadPid), processBudget)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
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
    const run = await host.run(process.execPath, ["-e", reportLauncherParent], {
      timeoutMs: 10_000,
    });
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
