// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { killWindowsJob, runWindowsJob, spawnWindowsJob } from "./windows-job.js";
import { execWindowsJob } from "./windows-job-exec.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function eventually(check: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (check()) return true;
    await sleep(50);
  } while (Date.now() < deadline);
  return check();
}

const treeProgram = `
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'});
child.unref();
fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));
setTimeout(()=>{},60000);
`;

describe.skipIf(process.platform !== "win32")("Windows native job containment", () => {
  it.each([0, 7])(
    "root completion joins a persistent descendant, drains bytes and preserves root exit %s",
    async (exitCode) => {
      const dir = mkdtempSync(join(tmpdir(), "omnesis-job-finite-root-"));
      const marker = join(dir, "members.json");
      const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const unrelatedClosed = new Promise<void>((resolve) =>
        unrelated.once("close", () => resolve()),
      );
      try {
        const program = `
const fs=require('node:fs');
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e', 'require("node:fs").writeSync(1,"child-ready\\n");process.send("ready");setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit','ipc']});
child.once('message',()=>{
  fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid]));
  fs.writeSync(1,Buffer.from([0,255,42]));fs.writeSync(2,'root-finished\\n');
  process.exit(${exitCode});
});
`;
        const result = await runWindowsJob(process.execPath, ["-e", program, marker], {
          completion: "root",
          timeoutMs: 20_000,
        });
        expect(result.failure, result.failureMessage ?? result.stderr).toBeUndefined();
        expect(result.exitCode).toBe(exitCode);
        expect(Buffer.from(result.stdout)).toEqual(
          Buffer.concat([Buffer.from("child-ready\n"), Buffer.from([0, 255, 42])]),
        );
        expect(result.stderr).toBe("root-finished\n");
        const members: number[] = JSON.parse(readFileSync(marker, "utf8"));
        expect(members.every((pid) => !alive(pid))).toBe(true);
        expect(alive(unrelated.pid!)).toBe(true);
      } finally {
        unrelated.kill("SIGKILL");
        await unrelatedClosed;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("root completion still cancels the entire owned tree while its root is running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-job-root-abort-"));
    const marker = join(dir, "members.json");
    const controller = new AbortController();
    const pending = runWindowsJob(process.execPath, ["-e", treeProgram, marker], {
      completion: "root",
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    try {
      expect(await eventually(() => existsSync(marker))).toBe(true);
      const members: number[] = JSON.parse(readFileSync(marker, "utf8"));
      expect(members.every(alive)).toBe(true);
      controller.abort();
      expect(await pending).toMatchObject({ failure: "aborted", exitCode: null });
      expect(await eventually(() => members.every((pid) => !alive(pid)))).toBe(true);
    } finally {
      controller.abort();
      await pending;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves immediate streaming input and filters only the helper status", async () => {
    const proc = spawnWindowsJob(process.execPath, [
      "-e",
      "process.stderr.write('target warning\\n');process.stdin.pipe(process.stdout)",
    ]);
    const chunks: Buffer[] = [];
    let stderr = "";
    proc.stdout.on("data", (bytes: Buffer) => chunks.push(bytes));
    proc.stderr.on("data", (bytes: Buffer) => {
      stderr += bytes.toString("utf8");
    });
    const closed = new Promise<number | null>((resolve) => proc.once("close", resolve));
    const bytes = Buffer.from([0, 255, 1, 128, 10]);
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    try {
      proc.stdin.end(bytes);
      await proc.jobReady;
      expect(await closed).toBe(0);
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect(stderr).toBe("target warning\n");
    } finally {
      clearTimeout(timer);
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      await closed;
    }
  });

  it("bounds a probe whose exited wrapper leaves inherited pipes in a child", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-job-probe-orphan-"));
    const pidPath = join(dir, "child.pid");
    let pid: number | undefined;
    try {
      const probe = execWindowsJob(
        process.execPath,
        [
          "-e",
          `
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const child=spawn(process.execPath,['-e','process.stdout.write("ready");setInterval(()=>{},1000)'],{detached:true,stdio:'inherit'});
child.once('spawn',()=>{fs.writeFileSync(process.argv[1],String(child.pid));child.unref();process.exit(0)});
`,
          pidPath,
        ],
        { timeout: 15_000 },
      );
      const rejected = expect(probe).rejects.toMatchObject({ code: "ETIMEDOUT" });
      expect(await eventually(() => existsSync(pidPath))).toBe(true);
      pid = Number(readFileSync(pidPath, "utf8"));
      await rejected;
      expect(await eventually(() => !alive(pid!))).toBe(true);
    } finally {
      if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the system helper even when the target cwd contains a conflicting executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-job-cwd-"));
    try {
      writeFileSync(join(dir, "powershell.exe"), "This is an invented non-executable fixture.");
      const run = await runWindowsJob(
        process.execPath,
        [
          "-e",
          "process.stdout.write(JSON.stringify([process.cwd(),process.env.OMNESIS_JOB_FIXTURE]))",
        ],
        {
          cwd: dir,
          env: { ...process.env, OMNESIS_JOB_FIXTURE: "literal value" },
          timeoutMs: 20_000,
        },
      );
      expect(run.failure, run.failureMessage ?? run.stderr).toBeUndefined();
      expect(JSON.parse(Buffer.from(run.stdout).toString("utf8"))).toEqual([dir, "literal value"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves literal argv including quotes, backslashes, empty strings and Unicode", async () => {
    const args = [
      "",
      "a b",
      'quote"value',
      "trailing\\",
      'slashes\\\\"quote',
      "& $(echo unexpected)",
      "λ雪",
    ];
    const run = await runWindowsJob(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args],
      { timeoutMs: 20_000 },
    );
    expect(run.failure, run.failureMessage ?? run.stderr).toBeUndefined();
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(Buffer.from(run.stdout).toString("utf8"))).toEqual(args);
  });

  it("keeps the first binary stdin bytes intact after the configuration frame", async () => {
    const bytes = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const run = await runWindowsJob(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { input: bytes, timeoutMs: 20_000 },
    );
    expect(run.failure, run.failureMessage ?? run.stderr).toBeUndefined();
    expect(run.exitCode).toBe(0);
    expect(Buffer.from(run.stdout)).toEqual(bytes);
  });

  it("forwards an input stream without losing the first or final bytes", async () => {
    const chunks = [Buffer.from([0, 255, 1]), Buffer.alloc(65_537, 254), Buffer.from([255, 0])];
    const run = await runWindowsJob(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout)"],
      { inputStream: Readable.from(chunks), timeoutMs: 20_000 },
    );
    expect(run.failure, run.failureMessage ?? run.stderr).toBeUndefined();
    expect(run.exitCode).toBe(0);
    expect(Buffer.from(run.stdout)).toEqual(Buffer.concat(chunks));
  });

  it.each([0, 126, 127])(
    "preserves a real target exit code %s as a target outcome",
    async (code) => {
      const run = await runWindowsJob(process.execPath, ["-e", `process.exit(${code})`], {
        timeoutMs: 20_000,
      });
      expect(run.exitCode).toBe(code);
      expect(run.failure).toBeUndefined();
    },
  );

  it("reports a failed CreateProcess separately from target exit 127", async () => {
    const run = await runWindowsJob(join(tmpdir(), "nonexistent-omnesis-job-program.exe"), [], {
      timeoutMs: 20_000,
    });
    expect(run).toMatchObject({ exitCode: null, failure: "spawn" });
    expect(run.failureMessage).toContain("ENOENT");
  });

  it("owns an inherited-pipe descendant even when its root exits immediately", async () => {
    const program = `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:['ignore',1,2]});
      process.stdout.write(String(child.pid)); process.exit(7);
    `;
    const run = await runWindowsJob(process.execPath, ["-e", program], { timeoutMs: 5_000 });
    expect(run).toMatchObject({ exitCode: null, failure: "timeout" });
    const pid = Number(Buffer.from(run.stdout).toString("utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(await eventually(() => !alive(pid))).toBe(true);
  });

  it("terminates the complete job when the helper is killed outright", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-job-helper-"));
    const marker = join(dir, "ready");
    let helperPid: number | undefined;
    const pending = runWindowsJob(
      process.execPath,
      ["-e", treeProgram, marker],
      { timeoutMs: 30_000 },
      (pid) => {
        helperPid = pid;
      },
    );
    try {
      expect(await eventually(() => existsSync(marker))).toBe(true);
      const pids: number[] = JSON.parse(readFileSync(marker, "utf8"));
      expect(pids.every(alive)).toBe(true);
      process.kill(helperPid!, "SIGKILL");
      await pending;
      expect(await eventually(() => pids.every((pid) => !alive(pid)))).toBe(true);
    } finally {
      if (helperPid !== undefined) killWindowsJob(helperPid);
      await pending;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([undefined, "root"] as const)(
    "closes the job when its launcher parent crashes without cleanup (completion=%s)",
    async (completion) => {
      const dir = mkdtempSync(join(tmpdir(), "omnesis-job-parent-"));
      const marker = join(dir, "ready");
      const moduleUrl = new URL("./windows-job.ts", import.meta.url).href;
      const script = `
      import {runWindowsJob} from ${JSON.stringify(moduleUrl)};
      await runWindowsJob(process.execPath,['-e',${JSON.stringify(treeProgram)},${JSON.stringify(marker)}],${JSON.stringify({ timeoutMs: 60000, completion })});
    `;
      const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
      const parent = spawn(
        process.execPath,
        ["--import", loader, "--input-type=module", "-e", script],
        {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      let stderr = "";
      parent.stderr!.on("data", (bytes: Buffer) => {
        stderr += bytes.toString("utf8");
      });
      const exited = new Promise<void>((resolve, reject) => {
        parent.once("close", () => resolve());
        parent.once("error", reject);
      });
      try {
        expect(
          await Promise.race([
            eventually(() => existsSync(marker)),
            exited.then(() => {
              throw new Error("Fixture parent exited before starting its program: " + stderr);
            }),
          ]),
        ).toBe(true);
        const pids: number[] = JSON.parse(readFileSync(marker, "utf8"));
        parent.kill("SIGKILL");
        await exited;
        expect(await eventually(() => pids.every((pid) => !alive(pid)))).toBe(true);
      } finally {
        if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
        await exited;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("does not execute the payload after publication fails and reaps the helper before rejecting", async () => {
    const failure = new Error("Synthetic publication failure");
    let helperPid: number | undefined;
    await expect(
      runWindowsJob(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 20_000 }, (pid) => {
        helperPid = pid;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(helperPid).toBeGreaterThan(0);
    expect(alive(helperPid!)).toBe(false);
  });

  it("honors an abort raised synchronously while publishing the helper", async () => {
    const controller = new AbortController();
    let helperPid: number | undefined;
    const run = await runWindowsJob(
      process.execPath,
      ["-e", "setTimeout(()=>{},60000)"],
      { signal: controller.signal, timeoutMs: 20_000 },
      (pid) => {
        helperPid = pid;
        controller.abort();
      },
    );
    expect(run).toMatchObject({ exitCode: null, failure: "aborted" });
    expect(alive(helperPid!)).toBe(false);
  });
});
