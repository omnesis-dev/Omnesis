// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
import {
  killWindowsJob,
  runWindowsJob,
  runWindowsJobSync,
  spawnWindowsJob,
} from "./windows-job.js";
import { execWindowsJob } from "./windows-job-exec.js";
import { writeWindowsPrivateFileAtomicStream } from "./windows-private-file.js";

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
  vi.stubEnv("SystemRoot", "C:\\Windows");
  helper = new Helper();
  mocks.spawn.mockReset().mockReturnValue(helper);
});

afterEach(() => vi.unstubAllEnvs());

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

describe("synchronous Windows job framing", () => {
  it("shares binary framing and preserves target exit 127", () => {
    mocks.spawnSync.mockReturnValue({
      status: 127,
      signal: null,
      stdout: Buffer.from([0, 255]),
      stderr: Buffer.from("OMNESIS_JOB:0\nwarning"),
    });
    const run = runWindowsJobSync("literal fixture", ["& argument"], {
      input: Buffer.from([255, 0]),
      timeoutMs: 1000,
    });
    expect(run).toEqual({
      exitCode: 127,
      signal: null,
      stdout: Buffer.from([0, 255]),
      stderr: "warning",
    });
    const options = mocks.spawnSync.mock.calls.at(-1)![2] as {
      input: Buffer;
      timeout: number;
      killSignal: string;
    };
    const length = options.input.readUInt32LE();
    expect(JSON.parse(options.input.subarray(4, length + 4).toString("utf8"))).toMatchObject({
      command: "literal fixture",
      args: ["& argument"],
    });
    expect(options.input.subarray(length + 4)).toEqual(Buffer.from([255, 0]));
    expect(options.killSignal).toBe("SIGKILL");
    expect(options.timeout).toBe(1000);
  });
  it("classifies native creation failure and timeout separately", () => {
    mocks.spawnSync.mockReturnValue({
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("OMNESIS_JOB:2\n"),
    });
    expect(runWindowsJobSync("fixture", [])).toMatchObject({
      failure: "spawn",
      failureMessage: expect.stringContaining("ENOENT"),
    });
    mocks.spawnSync.mockReturnValue({
      status: null,
      signal: "SIGKILL",
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("OMNESIS_JOB:0\n"),
      error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    });
    expect(runWindowsJobSync("fixture", [])).toMatchObject({ failure: "timeout", exitCode: null });
  });
});

describe("private streaming commit gate", () => {
  function privateBody(): { metadata: Record<string, unknown>; body: Buffer } {
    const frame = Buffer.concat(helper.input),
      outer = frame.readUInt32LE();
    const input = frame.subarray(outer + 4),
      size = input.readUInt32LE();
    return {
      metadata: JSON.parse(input.subarray(4, size + 4).toString("utf8")) as Record<string, unknown>,
      body: input.subarray(size + 4),
    };
  }
  it("does not send commit when authentication fails after every plaintext byte", async () => {
    const failure = new Error("invented late authentication failure");
    const source = Readable.from(
      (async function* () {
        yield Buffer.from("plaintext");
        throw failure;
      })(),
    );
    const pending = writeWindowsPrivateFileAtomicStream("C:\\example\\plain.bin", source, 9);
    let settled = false;
    const rejected = pending.catch((error: unknown) => {
      settled = true;
      return error;
    });
    helper.rawStderr.write("OMNESIS_JOB:0\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(privateBody().body).toEqual(Buffer.from("plaintext"));
    expect(settled).toBe(false);
    await helper.close(1);
    expect(await rejected).toBe(failure);
    expect(mocks.spawn).toHaveBeenCalledOnce();
  });
  it.each([new Error("invented authentication failure"), undefined])(
    "preserves source failure %s when receipted cleanup also fails",
    async (failure) => {
      let sent = false;
      const source = new Readable({
        read() {
          if (!sent) {
            sent = true;
            this.push(Buffer.from("x"));
          }
        },
      });
      const pending = writeWindowsPrivateFileAtomicStream("C:\\example\\plain.bin", source, 1);
      const observed = pending.catch((error: unknown) => error);
      helper.rawStderr.write("OMNESIS_JOB:0\nOMNESIS_PRIVATE_CREATED:1:2:3\n");
      await new Promise<void>((resolve) => setImmediate(resolve));
      source.emit("error", failure);
      source.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const cleanup = new Helper();
      cleanup.pid = 23456;
      mocks.spawn.mockReturnValueOnce(cleanup);
      await helper.close(1);
      cleanup.rawStderr.write("OMNESIS_JOB:0\nEPRIVATE");
      await cleanup.close(1);
      const error = await observed;
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      expect(aggregate.message).toBe("Private write failed and staging cleanup failed");
      expect(aggregate.errors[0]).toBe(failure);
      expect(aggregate.errors[1]).toMatchObject({ code: "EPRIVATE" });
    },
  );
  it("observes source destruction errors when the helper fails before consuming input", async () => {
    const source = new Readable({
      read() {},
      destroy(_error, callback) {
        setImmediate(() => callback(new Error("invented stream destruction failure")));
      },
    });
    const pending = writeWindowsPrivateFileAtomicStream("C:\\example\\plain.bin", source, 1);
    const observed = pending.catch((error: unknown) => error);
    await helper.close(1);
    expect(await observed).toMatchObject({ code: "EPRIVATE" });
    await new Promise<void>((resolve) => source.once("close", resolve));
    expect(source.destroyed).toBe(true);
  });
  it("sends commit only after successful exact-length completion", async () => {
    const pending = writeWindowsPrivateFileAtomicStream(
      "C:\\example\\plain.bin",
      Readable.from([Buffer.from([0, 255])]),
      2,
      { replaceExisting: false },
    );
    helper.rawStderr.write("OMNESIS_JOB:0\n");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const frame = privateBody();
    expect(frame.metadata).toMatchObject({
      action: "atomic",
      length: 2,
      receipt: true,
      replaceExisting: false,
    });
    expect(frame.body).toEqual(
      Buffer.concat([Buffer.from([0, 255]), Buffer.from("\0OMNESIS_PRIVATE_COMMIT_V1\0")]),
    );
    await helper.close(0);
    await pending;
  });
});
