// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { killWindowsJob, runWindowsJob, spawnWindowsJob } from "./windows-job.js";
import { execWindowsJob } from "./windows-job-exec.js";

class Helper extends EventEmitter {
  pid = 12345;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdio = [this.stdin, this.stdout, this.stderr];
  rawStderr = this.stderr;
  input: Buffer[] = [];
  exitCode: number | null = null;
  signalCode: string | null = null;
  constructor() {
    super();
    this.stdin.on("data", (bytes: Buffer) => this.input.push(bytes));
  }
  kill = vi.fn(() => {
    void this.close(null, "SIGKILL");
    return true;
  });
  async close(code: number | null = 0, signal: string | null = null): Promise<void> {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.rawStderr.end();
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

let helper: Helper;
beforeEach(() => {
  helper = new Helper();
  mocks.spawn.mockReset().mockReturnValue(helper);
});

describe("Windows job stream protocol", () => {
  it("queues literal configuration before immediate binary RPC input and strips split status", async () => {
    const proc = spawnWindowsJob("fixture executable", ["& literal", "雪"]);
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    proc.stdout.on("data", (bytes: Buffer) => output.push(bytes));
    proc.stderr.on("data", (bytes: Buffer) => errors.push(bytes));
    proc.stdin.write(Buffer.from([0, 255, 10]));
    const input = Buffer.concat(helper.input);
    const length = input.readUInt32LE();
    expect(JSON.parse(input.subarray(4, length + 4).toString("utf8"))).toEqual({
      command: "fixture executable",
      args: ["& literal", "雪"],
      parentPid: process.pid,
    });
    expect(input.subarray(length + 4)).toEqual(Buffer.from([0, 255, 10]));
    helper.rawStderr.write("OMNESIS_J");
    helper.rawStderr.write(Buffer.concat([Buffer.from("OB:0\n"), Buffer.from([0, 254])]));
    helper.stdout.write(Buffer.from([255, 0]));
    await proc.jobReady;
    await helper.close(127);
    expect(Buffer.concat(errors)).toEqual(Buffer.from([0, 254]));
    expect(Buffer.concat(output)).toEqual(Buffer.from([255, 0]));
    expect(proc.exitCode).toBe(127);
    killWindowsJob(helper.pid);
    expect(helper.kill).not.toHaveBeenCalled();
  });

  it.each([
    [2, "ENOENT"],
    [5, "EACCES"],
    [193, "ENOEXEC"],
  ])("reports native creation error %s separately", async (code, name) => {
    const proc = spawnWindowsJob("fixture", []);
    helper.rawStderr.write(`OMNESIS_JOB:${code}\n`);
    await expect(proc.jobReady).rejects.toMatchObject({ code: name });
    await helper.close(1);
  });

  it("retains ownership until close after publication fails, including throw undefined", async () => {
    const run = runWindowsJob("fixture", [], {}, () => {
      throw undefined;
    });
    expect(helper.input).toEqual([]);
    expect(helper.kill).toHaveBeenCalledOnce();
    await expect(run).rejects.toBeUndefined();
  });

  it("shares ready parsing and preserves a real target exit 127 in buffered runs", async () => {
    const run = runWindowsJob("fixture", [], {});
    helper.rawStderr.write("OMNESIS_JOB:0\nwarning");
    helper.stdout.write("result");
    await helper.close(127);
    expect(await run).toEqual({
      exitCode: 127,
      signal: null,
      stdout: Buffer.from("result"),
      stderr: "warning",
    });
  });

  it("rejects a missing helper without leaking an unobserved ready rejection", async () => {
    const run = runWindowsJob("fixture", [], {});
    helper.emit("error", new Error("missing helper"));
    await helper.close(null);
    expect(await run).toMatchObject({ failure: "spawn", failureMessage: "missing helper" });
  });
});

describe("Windows job exec capture", () => {
  it("captures decoded output and preserves native ENOENT", async () => {
    const run = execWindowsJob("fixture", []);
    const rejected = expect(run).rejects.toMatchObject({ code: "ENOENT", stdout: "", stderr: "" });
    helper.rawStderr.write("OMNESIS_JOB:2\n");
    await helper.close(1);
    await rejected;
  });

  it("bounds captured output, kills its retained helper, and joins close", async () => {
    const run = execWindowsJob("fixture", [], { maxBuffer: 3 });
    const rejected = expect(run).rejects.toMatchObject({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      stdout: "abc",
    });
    helper.rawStderr.write("OMNESIS_JOB:0\n");
    helper.stdout.write("abcdef");
    await rejected;
    expect(helper.kill).toHaveBeenCalledOnce();
  });

  it("times out the whole job and waits for helper close", async () => {
    const run = execWindowsJob("fixture", [], { timeout: 1 });
    helper.rawStderr.write("OMNESIS_JOB:0\n");
    await expect(run).rejects.toMatchObject({ code: "ETIMEDOUT", killed: true });
    expect(helper.kill).toHaveBeenCalledOnce();
  });

  it("aborts the whole job through its held helper handle", async () => {
    const signal = new AbortController();
    const run = execWindowsJob("fixture", [], { signal: signal.signal });
    helper.rawStderr.write("OMNESIS_JOB:0\n");
    signal.abort();
    await expect(run).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(helper.kill).toHaveBeenCalledOnce();
  });
});
