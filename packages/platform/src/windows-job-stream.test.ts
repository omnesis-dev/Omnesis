// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  workerInvocation: vi.fn(),
  control: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock("./windows-worker-cache.js", () => ({ windowsWorkerInvocation: mocks.workerInvocation }));
vi.mock("./windows-job-control.js", () => ({
  WindowsJobControl: vi.fn(function (parentBirth: string, deadlineUnixMs: number) {
    return mocks.control(parentBirth, deadlineUnixMs);
  }),
}));
import {
  killWindowsJob,
  runWindowsJob,
  runWindowsJobSync,
  spawnWindowsJob,
} from "./windows-job.js";
import { execWindowsJob } from "./windows-job-exec.js";
import { runWindowsOwnedProcessSync } from "./windows-owned-process.js";
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

function joinedSyncResult(status: number, stderr = "", nativeCode = 0) {
  mocks.spawnSync.mockImplementation((_command, _args, options: { input: Buffer }) => {
    const size = options.input.readUInt32LE();
    const config = JSON.parse(options.input.subarray(4, size + 4).toString());
    return {
      pid: 12345,
      status,
      signal: null,
      stdout: Buffer.from([0, 255]),
      stderr: Buffer.from(
        `OMNESIS_JOB:${nativeCode}\n${stderr}\nOMNESIS_JOB_JOINED:${config.syncReceipt}\n`,
      ),
    };
  });
}

let helper: Helper;
beforeEach(() => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  mocks.workerInvocation.mockReset().mockImplementation((mode: string) => ({
    command: "C:\\Windows\\native-worker.exe",
    args: [mode],
    parentBirth: "123456789",
  }));
  mocks.control.mockReset().mockImplementation((parentBirth: string, deadlineUnixMs: number) => {
    let join!: () => void;
    const closed = new Promise<void>((resolve) => {
      join = resolve;
    });
    return {
      configuration: {
        pipe: `omnesis-job-${process.pid}-${"a".repeat(48)}`,
        cookie: "b".repeat(64),
        parentBirth,
        deadlineUnixMs,
      },
      listening: Promise.resolve(),
      failed: new Promise<never>(() => {}),
      closed,
      start: vi.fn(),
      targetStarted: vi.fn(),
      inputAllowed: true,
      attach: (child: Helper, releaseInput: () => Promise<void>) =>
        child.once("close", () => {
          void releaseInput().then(join);
        }),
      abandon: vi.fn(),
    };
  });
  helper = new Helper();
  mocks.spawnSync.mockReset();
  mocks.spawn.mockReset().mockReturnValue(helper);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Windows job stream protocol", () => {
  it.each(["stream", "buffer", "sync"] as const)(
    "preserves bootstrap cleanup markers through %s entrypoint deadline classification",
    async (mode) => {
      for (const expired of [false, true])
        for (const marked of [false, true]) {
          const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
          const failure = Object.assign(
            new Error("invented native bootstrap refusal"),
            marked ? { cleanupFailure: undefined } : {},
          );
          mocks.workerInvocation.mockImplementationOnce(() => {
            if (expired) clock.mockReturnValue(1100);
            throw failure;
          });
          try {
            if (mode === "stream") {
              let caught: unknown;
              try {
                spawnWindowsJob("fixture", [], { startupTimeoutMs: 100 });
              } catch (error) {
                caught = error;
              }
              expect(caught).toBeInstanceOf(Error);
              expect(Object.hasOwn(caught as Error, "cleanupFailure")).toBe(marked);
              if (expired) expect(caught).toMatchObject({ code: "ETIMEDOUT" });
              else expect(caught).toBe(failure);
            } else {
              const result =
                mode === "buffer"
                  ? await runWindowsJob("fixture", [], { timeoutMs: 100 })
                  : runWindowsJobSync("fixture", [], { timeoutMs: 100 });
              expect(result.failure).toBe(expired ? "timeout" : "spawn");
              expect(Object.hasOwn(result, "cleanupFailure")).toBe(marked);
            }
            expect(mocks.spawn).not.toHaveBeenCalled();
            expect(mocks.spawnSync).not.toHaveBeenCalled();
          } finally {
            clock.mockRestore();
          }
        }
    },
  );

  it.each(["buffered", "publication", "exec"] as const)(
    "retains an explicit undefined cleanup rejection for %s consumers",
    async (mode) => {
      const implementation = mocks.control.getMockImplementation()!;
      mocks.control.mockImplementationOnce((...args: unknown[]) => ({
        ...implementation(...args),
        closed: Promise.reject(undefined),
      }));
      const publication = new Error("invented publication refusal");
      const pending =
        mode === "exec"
          ? execWindowsJob("fixture", [])
          : runWindowsJob(
              "fixture",
              [],
              {},
              mode === "publication"
                ? () => {
                    throw publication;
                  }
                : undefined,
            );
      const outcome = pending.then(
        (value) => ({ rejected: false as const, value }),
        (error: unknown) => ({ rejected: true as const, error }),
      );
      if (mode !== "publication") {
        helper.rawStderr.write("OMNESIS_JOB:0\n");
        await helper.close(0);
      }
      const settled = await outcome;
      if (mode === "buffered") {
        expect(settled.rejected).toBe(false);
        if (settled.rejected) throw settled.error;
        expect(Object.hasOwn(settled.value, "cleanupFailure")).toBe(true);
        expect(settled.value).toMatchObject({ failure: "spawn", cleanupFailure: undefined });
      } else {
        expect(settled.rejected).toBe(true);
        if (!settled.rejected) throw new Error("An unjoined command incorrectly succeeded");
        expect(settled.error).toBeInstanceOf(Error);
        expect(Object.hasOwn(settled.error as Error, "cleanupFailure")).toBe(true);
        expect(settled.error).toMatchObject({ cleanupFailure: undefined });
        if (mode === "publication") expect(settled.error).toMatchObject({ cause: publication });
      }
    },
  );

  it("joins both raw and gated stdin after a streaming owner exits without input EOF", async () => {
    const rawInput = helper.stdin;
    const proc = spawnWindowsJob("fixture", []);
    await new Promise<void>((resolve) => setImmediate(resolve));
    helper.rawStderr.write("OMNESIS_JOB:0\n");
    await proc.jobReady;
    expect(proc.stdin.writableEnded).toBe(false);
    await helper.close();
    await proc.jobClosed;
    expect(proc.stdin.closed).toBe(true);
    expect(rawInput.closed).toBe(true);
  });

  it.each(["buffer", "exec"] as const)(
    "preserves %s cancellation and exposes cleanup uncertainty",
    async (mode) => {
      const makeControl = mocks.control.getMockImplementation()!;
      const cleanupFailure = new Error("invented missing native join");
      mocks.control.mockImplementation((...args) => {
        const control = makeControl(...args);
        const closed = control.closed.then(() => {
          throw cleanupFailure;
        });
        void closed.catch(() => {});
        return { ...control, closed };
      });
      const abort = new AbortController();
      const pending =
        mode === "buffer"
          ? runWindowsJob("fixture", [], { signal: abort.signal })
          : execWindowsJob("fixture", [], { signal: abort.signal });
      void pending.catch(() => {});
      await new Promise<void>((resolve) => setImmediate(resolve));
      helper.rawStderr.write("OMNESIS_JOB:0\n");
      abort.abort();
      if (mode === "buffer")
        await expect(pending).resolves.toMatchObject({ failure: "aborted", cleanupFailure });
      else await expect(pending).rejects.toMatchObject({ code: "ABORT_ERR", cleanupFailure });
    },
  );

  it.each(["stream", "buffer"] as const)(
    "anchors %s setup to the start before synchronous cache verification",
    async (mode) => {
      let now = 1_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      mocks.workerInvocation.mockImplementation(() => {
        now += 5_000;
        return { command: "fixture", args: [], parentBirth: "123456789" };
      });
      const pending =
        mode === "stream" ? spawnWindowsJob("fixture", []) : runWindowsJob("fixture", [], {});
      expect(mocks.control).toHaveBeenCalledWith("123456789", 1_030_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      helper.rawStderr.write("OMNESIS_JOB:0\n");
      await helper.close();
      if (mode === "stream") await (pending as ReturnType<typeof spawnWindowsJob>).jobClosed;
      else await pending;
    },
  );

  it.each(["root", "tree"] as const)(
    "frames explicit %s completion before raw input",
    async (completion) => {
      const proc = spawnWindowsJob("fixture", [], { completion });
      proc.stdin.end(Buffer.from([0, 255]));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const input = Buffer.concat(helper.input);
      const length = input.readUInt32LE();
      expect(JSON.parse(input.subarray(4, length + 4).toString("utf8"))).toMatchObject({
        completion,
      });
      expect(input.subarray(length + 4)).toEqual(Buffer.from([0, 255]));
      helper.rawStderr.write("OMNESIS_JOB:0\n");
      await proc.jobReady;
      await helper.close(7);
      await proc.jobClosed;
      expect(proc.exitCode).toBe(7);
    },
  );

  it("carries root completion through buffered and synchronous runs without changing their exit status", async () => {
    const pending = runWindowsJob("fixture", [], { completion: "root" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    let input = Buffer.concat(helper.input);
    expect(JSON.parse(input.subarray(4, input.readUInt32LE() + 4).toString("utf8"))).toMatchObject({
      completion: "root",
    });
    helper.rawStderr.write("OMNESIS_JOB:0\n");
    await helper.close(7);
    expect(await pending).toMatchObject({ exitCode: 7 });
    joinedSyncResult(7);
    expect(runWindowsJobSync("fixture", [], { completion: "root" })).toMatchObject({
      exitCode: 7,
      stdout: Buffer.from([0, 255]),
    });
    input = mocks.spawnSync.mock.calls[0]![2].input;
    expect(JSON.parse(input.subarray(4, input.readUInt32LE() + 4).toString("utf8"))).toMatchObject({
      completion: "root",
    });
  });

  it("rejects an unknown completion policy before preparing or launching a helper", async () => {
    const invalid = { completion: "unowned" as "root" };
    expect(() => spawnWindowsJob("fixture", [], invalid)).toThrow("completion policy");
    expect(await runWindowsJob("fixture", [], invalid)).toMatchObject({ failure: "spawn" });
    expect(runWindowsJobSync("fixture", [], invalid)).toMatchObject({ failure: "spawn" });
    expect(mocks.workerInvocation).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("queues literal configuration before immediate binary RPC input and strips split status", async () => {
    const proc = spawnWindowsJob("fixture executable", ["& literal", "雪"]);
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    proc.stdout.on("data", (bytes: Buffer) => output.push(bytes));
    proc.stderr.on("data", (bytes: Buffer) => errors.push(bytes));
    proc.stdin.write(Buffer.from([0, 255, 10]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const input = Buffer.concat(helper.input);
    const length = input.readUInt32LE();
    expect(JSON.parse(input.subarray(4, length + 4).toString("utf8"))).toEqual({
      command: "fixture executable",
      args: ["& literal", "雪"],
      parentPid: process.pid,
      control: mocks.control.mock.results[0]!.value.configuration,
    });
    expect(input.subarray(length + 4)).toEqual(Buffer.from([0, 255, 10]));
    helper.rawStderr.write("OMNESIS_J");
    helper.rawStderr.write(Buffer.concat([Buffer.from("OB:0\n"), Buffer.from([0, 254])]));
    helper.stdout.write(Buffer.from([255, 0]));
    await proc.jobReady;
    await helper.close(127);
    await proc.jobClosed;
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
    await proc.jobClosed;
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(Date, "now").mockReturnValue(1000);
    helper.kill.mockImplementation(() => true);
    try {
      const run = execWindowsJob("fixture", [], { timeout: 1 });
      const rejected = expect(run).rejects.toMatchObject({ code: "ETIMEDOUT", killed: true });
      let settled = false;
      void run.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      helper.rawStderr.write("OMNESIS_JOB:0\n");
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.spawn).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(helper.kill).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      await helper.close(null, "SIGKILL");
      await rejected;
      expect(settled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out cold initialization before starting a target beyond the probe deadline", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    mocks.workerInvocation.mockImplementationOnce(() => {
      clock.mockReturnValue(1100);
      return { command: "C:\\Windows\\native-worker.exe", args: ["job"], parentBirth: "123456789" };
    });
    await expect(execWindowsJob("fixture", [], { timeout: 100 })).rejects.toMatchObject({
      code: "ETIMEDOUT",
      killed: true,
      stdout: "",
      stderr: "",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("uses only the remaining execution budget after native initialization", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    mocks.workerInvocation.mockImplementationOnce(() => {
      clock.mockReturnValue(1040);
      return { command: "C:\\Windows\\native-worker.exe", args: ["job"], parentBirth: "123456789" };
    });
    try {
      const run = execWindowsJob("fixture", [], { timeout: 100 });
      const rejected = expect(run).rejects.toMatchObject({ code: "ETIMEDOUT", killed: true });
      helper.rawStderr.write("OMNESIS_JOB:0\n");
      vi.advanceTimersByTime(59);
      expect(helper.kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await rejected;
      expect(helper.kill).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
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
  it("keeps independent bootstrap and target receipt nonces out of target input, arguments and environment", () => {
    const program = Buffer.from("invented public bootstrap input"),
      input = Buffer.from([255, 0]);
    joinedSyncResult(0);
    mocks.workerInvocation.mockImplementationOnce(
      (
        _mode: string,
        bootstrap: (request: {
          invocation: { command: string; args: string[] };
          input: Buffer;
        }) => unknown,
      ) => {
        expect(
          bootstrap({
            invocation: {
              command: "powershell.exe",
              args: ["-EncodedCommand", "invented-public-program"],
            },
            input: program,
          }),
        ).toMatchObject({ exitCode: 0, stderr: "" });
        return { command: "native-worker.exe", args: ["job"], parentBirth: "123456789" };
      },
    );
    expect(
      runWindowsJobSync("literal-target.exe", ["literal argument"], {
        input,
        env: { EXAMPLE: "invented" },
      }).exitCode,
    ).toBe(0);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(2);
    const nonces = mocks.spawnSync.mock.calls.map(([command, args, options], index) => {
      const body = options.input as Buffer,
        size = body.readUInt32LE();
      const config = JSON.parse(body.subarray(4, size + 4).toString());
      expect(config.syncReceipt).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify([command, args, options.env])).not.toContain(config.syncReceipt);
      expect(body.subarray(size + 4)).toEqual(index === 0 ? program : input);
      return config.syncReceipt as string;
    });
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it.each([0, 126, 127])(
    "preserves joined target status %s without leaking private metadata",
    (status) => {
      const literal = "literal\0stderr\nOMNESIS_JOB_JOINED:not-a-private-frame";
      joinedSyncResult(status, literal);
      const result = runWindowsJobSync("fixture", ["literal & argument"], {
        input: Buffer.from([255, 0]),
      });
      expect(result).toEqual({
        exitCode: status,
        signal: null,
        stdout: Buffer.from([0, 255]),
        stderr: literal,
      });
      const body = mocks.spawnSync.mock.calls.at(-1)![2].input as Buffer;
      const size = body.readUInt32LE();
      const config = JSON.parse(body.subarray(4, size + 4).toString());
      expect(config.syncReceipt).toMatch(/^[a-f0-9]{64}$/u);
      expect(body.subarray(size + 4)).toEqual(Buffer.from([255, 0]));
      expect(result.stderr).not.toContain(config.syncReceipt);
      expect(Object.hasOwn(result, "cleanupFailure")).toBe(false);
    },
  );
  it("preserves an ordinary native creation refusal with a joined empty Job", () => {
    joinedSyncResult(1, "", 2);
    const result = runWindowsJobSync("missing.exe", []);
    expect(result.failureMessage).toContain("ENOENT");
    expect(result.stderr).toBe("");
    expect(Object.hasOwn(result, "cleanupFailure")).toBe(false);
  });
  it.each(["joined", "missing", "mismatched"] as const)(
    "preserves an input EOF failure with %s cleanup evidence",
    (kind) => {
      mocks.spawnSync.mockImplementation((_command, _args, options: { input: Buffer }) => {
        const length = options.input.readUInt32LE();
        const config = JSON.parse(options.input.subarray(4, length + 4).toString());
        const nonce = kind === "mismatched" ? "f".repeat(64) : config.syncReceipt;
        return {
          pid: 12345,
          status: 1,
          signal: null,
          error: Object.assign(new Error("Input pipe EOF"), { code: "EOF" }),
          stdout: Buffer.alloc(0),
          stderr: Buffer.from(
            "native creation diagnostic" +
              (kind === "missing" ? "" : `\nOMNESIS_JOB_JOINED:${nonce}\n`),
          ),
        };
      });
      const result = runWindowsJobSync("fixture", [], { input: Buffer.alloc(128 * 1024) });
      expect(result.failure).toBe("spawn");
      expect(result.exitCode).toBeNull();
      expect(result.failureMessage).toContain("Input pipe EOF");
      expect(Object.hasOwn(result, "cleanupFailure")).toBe(kind !== "joined");
      if (kind === "joined") {
        expect(result.failureMessage).toBe("Input pipe EOF");
        expect(result.stderr).toBe("native creation diagnostic");
      }
    },
  );
  it("does not demand a child-Job receipt for self-contained filesystem refusals", () => {
    mocks.spawnSync.mockReturnValue({
      pid: 12345,
      status: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("OMNESIS_JOB:0\nEPRIVATE:validate:5"),
    });
    const result = runWindowsOwnedProcessSync(
      { command: "filesystem-worker.exe", args: [] },
      Buffer.alloc(0),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("EPRIVATE:validate:5");
    expect(Object.hasOwn(result, "cleanupFailure")).toBe(false);
  });

  it.each(["missing", "unjoined", "mismatched", "duplicate", "truncated", "trailing"] as const)(
    "requires a nonce-bound completion receipt for %s helper output",
    (kind) => {
      let expectedNonce = "";
      mocks.spawnSync.mockImplementation((_command, _args, options: { input: Buffer }) => {
        const length = options.input.readUInt32LE();
        const config = JSON.parse(options.input.subarray(4, length + 4).toString());
        const nonce = typeof config.syncReceipt === "string" ? config.syncReceipt : "a".repeat(64);
        expectedNonce = nonce;
        const receipt = `\nOMNESIS_JOB_JOINED:${nonce}\n`;
        const tail =
          kind === "missing"
            ? ""
            : kind === "unjoined"
              ? "\nEJOB:unjoined-cleanup\n"
              : kind === "mismatched"
                ? `\nOMNESIS_JOB_JOINED:${"f".repeat(64)}\n`
                : kind === "duplicate"
                  ? receipt + receipt
                  : kind === "trailing"
                    ? receipt + "trailing diagnostic"
                    : receipt.slice(0, -3);
        return {
          pid: 12345,
          status: kind === "unjoined" ? 1 : 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("OMNESIS_JOB:0\nliteral diagnostic" + tail),
        };
      });
      const result = runWindowsJobSync("fixture", []);
      expect(Object.hasOwn(result, "cleanupFailure")).toBe(true);
      expect(result.failure).toBe("spawn");
      expect(result.failureMessage).toMatch(/cleanup/u);
      expect(result.stderr).not.toContain(expectedNonce);
      expect(result.failureMessage).not.toContain(expectedNonce);
    },
  );

  it("shares binary framing and preserves target exit 127", () => {
    joinedSyncResult(127, "warning");
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
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(1000);
  });
  it("charges native initialization time against the caller deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1040).mockReturnValueOnce(1000).mockReturnValueOnce(1000);
    mocks.spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("OMNESIS_JOB:0\n"),
    });
    runWindowsJobSync("fixture", [], { timeoutMs: 100 });
    expect(mocks.spawnSync.mock.calls.at(-1)![2].timeout).toBe(60);
    mocks.spawn.mockClear();
    vi.mocked(Date.now).mockReturnValue(1100).mockReturnValueOnce(1000).mockReturnValueOnce(1000);
    expect(await runWindowsJob("fixture", [], { timeoutMs: 100 })).toMatchObject({
      failure: "timeout",
      exitCode: null,
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("does not initialize a helper for an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runWindowsJob("fixture", [], { signal: controller.signal })).toMatchObject({
      failure: "aborted",
    });
    expect(mocks.workerInvocation).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
  it("marks a forcibly stopped synchronous owner as cleanup-uncertain", () => {
    mocks.spawnSync.mockReturnValue({
      pid: 12345,
      status: null,
      signal: "SIGKILL",
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("OMNESIS_JOB:0\n"),
      error: Object.assign(new Error("invented timeout"), { code: "ETIMEDOUT" }),
    });
    const result = runWindowsJobSync("fixture", []);
    expect(result.failure).toBe("timeout");
    expect(result.cleanupFailure).toBeInstanceOf(Error);
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
    const input = Buffer.concat(helper.input),
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
