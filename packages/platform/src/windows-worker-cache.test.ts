// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowsWorkerOwnerStart } from "./windows-powershell.js";
import type { WindowsBootstrapRequest } from "./windows-worker-cache.js";
const inherited = vi.hoisted(() => ({ data: new Map<string, unknown>() }));
vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  getEnvironmentData: (key: string) => inherited.data.get(key),
  setEnvironmentData: (key: string, value?: unknown) => {
    if (value === undefined) inherited.data.delete(key);
    else inherited.data.set(key, value);
  },
}));
vi.mock("./windows-powershell.js", async (original) => ({
  ...(await original<typeof import("./windows-powershell.js")>()),
  windowsWorkerOwnerStart: vi.fn(() => "638000000000000001"),
}));

beforeEach(() => {
  vi.resetModules();
  inherited.data.clear();
  vi.mocked(windowsWorkerOwnerStart).mockClear();
  vi.mocked(windowsWorkerOwnerStart).mockReturnValue("638000000000000001");
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.stubEnv("LOCALAPPDATA", "C:\\example folder\\literal & $()\\Local");
});
afterEach(() => vi.unstubAllEnvs());
function decode(request: WindowsBootstrapRequest) {
  const input = Buffer.from(request.input);
  const programSize = input.readUInt32LE();
  const program = input.subarray(4, programSize + 4).toString("utf8");
  const metadataStart = programSize + 4;
  const metadataSize = input.readUInt32LE(metadataStart);
  const sourceStart = metadataStart + 4 + metadataSize;
  const metadata = JSON.parse(input.subarray(metadataStart + 4, sourceStart).toString("utf8")) as {
    root: string;
    sourceHash: string;
    ownerPid: number;
    ownerBirth: string;
    length: number;
    runtimeConfig: string;
    manifest: string;
  };
  return {
    program,
    metadata,
    source: input.subarray(sourceStart, sourceStart + metadata.length).toString("utf8"),
    trailer: input.subarray(sourceStart + metadata.length),
  };
}
function verified(request: WindowsBootstrapRequest) {
  const { metadata } = decode(request);
  return {
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout: Buffer.from(
      JSON.stringify({
        executable: win32.join(metadata.root, metadata.sourceHash, "worker.exe"),
        sourceHash: metadata.sourceHash,
        binaryHash: "a".repeat(64),
        ownerPid: metadata.ownerPid,
        ownerBirth: metadata.ownerBirth,
        pinsTransferred: true,
      }),
    ),
  };
}
describe("Windows native worker cache boundary", () => {
  it("retains only a safe owner-birth failure reason and never starts a bootstrap", async () => {
    vi.mocked(windowsWorkerOwnerStart).mockImplementation((_timeout, unavailable) => {
      unavailable?.("timeout:query");
      return null;
    });
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn(verified);
    const refusal =
      /^Cannot verify Windows native worker owner \(EPRIVATE:owner-birth:timeout:query; owner [0-9]+ ms, 30000 ms allowance\)$/u;
    expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow(refusal);
    expect(() => windowsWorkerInvocation("filesystem", bootstrap)).toThrow(refusal);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(windowsWorkerOwnerStart).toHaveBeenCalledOnce();
  });
  it.each(["success-shaped", "failure-shaped"] as const)(
    "rejects and retains %s bootstrap cleanup uncertainty",
    async (kind) => {
      const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
      const cleanup =
        kind === "success-shaped" ? undefined : new Error("invented private bootstrap detail");
      const bootstrap = vi.fn((request: WindowsBootstrapRequest) => ({
        ...verified(request),
        cleanupFailure: cleanup,
        ...(kind === "failure-shaped"
          ? { failure: "spawn" as const, stderr: "invented input must not be echoed" }
          : {}),
      }));
      let failure: unknown;
      try {
        windowsWorkerInvocation("job", bootstrap);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(Object.hasOwn(failure as Error, "cleanupFailure")).toBe(true);
      expect(failure).toMatchObject({
        cleanupFailure: cleanup,
        message: expect.stringMatching(/^Cannot initialize the protected Windows native worker/u),
      });
      expect((failure as Error).message).not.toContain("invented");
      expect((failure as Error).cause).toMatchObject({
        message: "Windows native bootstrap cleanup was not confirmed",
      });
      expect(() => windowsWorkerInvocation("filesystem", bootstrap)).toThrow(failure as Error);
      expect(bootstrap).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["504911232000000001", "1"],
    ["621355968000000001", "116444736000000001"],
  ])(
    "converts reference .NET epoch ticks %s to FILETIME %s without dropping a 100ns tick",
    async (ticks, expected) => {
      // Calendar anchors: 1601-01-01 and 1970-01-01. Expected values are
      // independent of the implementation's epoch constant.
      vi.mocked(windowsWorkerOwnerStart).mockReturnValue(ticks);
      const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
      const bootstrap = vi.fn(verified);
      windowsWorkerInvocation("job", bootstrap);
      expect(decode(bootstrap.mock.calls[0]![0]).metadata.ownerBirth).toBe(expected);
    },
  );

  it("returns bounded native stage/compiler diagnostics without echoing arbitrary bootstrap output", async () => {
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    expect(() =>
      windowsWorkerInvocation("job", () => ({
        exitCode: 1,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr:
          "invented-private-input\nOMNESIS_NATIVE_COMPILE:CS1002:17:3\n" +
          `OMNESIS_NATIVE_COMPILE:CS1002:${"1".repeat(10000)}:3\n` +
          "EPRIVATE:cache-owner:5",
      })),
    ).toThrow("EPRIVATE:cache-owner:5; OMNESIS_NATIVE_COMPILE:CS1002:17:3");
    expect(() => windowsWorkerInvocation("job", verified)).toThrow(
      /^Cannot initialize the protected Windows native worker \(EPRIVATE:cache-owner:5; OMNESIS_NATIVE_COMPILE:CS1002:17:3\)$/u,
    );
  });
  it("frames exact public sources and verifies once before reusing the generation", async () => {
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn(verified);
    const job = windowsWorkerInvocation("job", bootstrap);
    const request = bootstrap.mock.calls[0]![0];
    const payload = decode(request);
    expect(payload.metadata.root).toBe(
      "C:\\example folder\\literal & $()\\Local\\Omnesis\\platform-native-v1",
    );
    expect(payload.metadata.ownerPid).toBe(process.pid);
    expect(payload.metadata.ownerBirth).toBe("133088768000000001");
    expect(payload.program).toContain("CompileAssemblyFromSource");
    expect(payload.source).toContain("class WindowsWorker");
    expect(
      createHash("sha256")
        .update(
          payload.source +
            "\0" +
            payload.metadata.runtimeConfig +
            "\0" +
            payload.metadata.manifest +
            "\0v1",
        )
        .digest("hex"),
    ).toBe(payload.metadata.sourceHash);
    expect(payload.trailer.toString("ascii")).toBe("\0OMNESIS_PRIVATE_COMMIT_V1\0");
    expect(job.command).toBe(
      win32.join(payload.metadata.root, payload.metadata.sourceHash, "worker.exe"),
    );
    expect(job.args).toEqual(["job"]);
    expect(job.parentBirth).toBe(payload.metadata.ownerBirth);
    expect(request.invocation.args.join(" ")).not.toContain("literal");
    expect(
      request.invocation.command.length +
        request.invocation.args.reduce((sum, arg) => sum + arg.length + 3, 3),
    ).toBeLessThan(32767);
    expect(windowsWorkerInvocation("filesystem", bootstrap)).toEqual({
      command: job.command,
      args: ["filesystem", String(process.pid)],
    });
    expect(bootstrap).toHaveBeenCalledOnce();
    expect([...inherited.data.values()]).toEqual([
      {
        format: 2,
        ownerPid: process.pid,
        ownerBirth: payload.metadata.ownerBirth,
        sourceHash: payload.metadata.sourceHash,
        executable: job.command,
      },
    ]);
  });
  it.each([
    "wrong-executable",
    "wrong-generation",
    "invalid-binary-hash",
    "truncated-json",
    "failed-verification",
    "wrong-owner",
    "wrong-birth",
    "untransferred-pins",
  ])("refuses %s and memoizes failure without repeated handle transfers", async (variant) => {
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn((request: WindowsBootstrapRequest) => {
      const result = verified(request);
      const record = JSON.parse(result.stdout.toString("utf8")) as Record<string, unknown>;
      if (variant === "wrong-executable") record.executable = "C:\\unverified\\worker.exe";
      if (variant === "wrong-generation") record.sourceHash = "b".repeat(64);
      if (variant === "invalid-binary-hash") record.binaryHash = "not-a-hash";
      if (variant === "wrong-owner") record.ownerPid = process.pid + 1;
      if (variant === "wrong-birth") record.ownerBirth = "133088768000000000";
      if (variant === "untransferred-pins") record.pinsTransferred = false;
      return {
        ...result,
        exitCode: variant === "failed-verification" ? 1 : 0,
        stdout:
          variant === "truncated-json" ? Buffer.from("{") : Buffer.from(JSON.stringify(record)),
      };
    });
    expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow(/native worker/u);
    expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow(/native worker/u);
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(inherited.data.size).toBe(0);
  });
  it.each(["relative-cache", "\\drive-relative-cache"])(
    "rejects cwd-dependent cache directory %s before initialization",
    async (path) => {
      vi.stubEnv("LOCALAPPDATA", path);
      const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
      const bootstrap = vi.fn(verified);
      expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow(
        "application directory is unavailable",
      );
      expect(bootstrap).not.toHaveBeenCalled();
    },
  );
});

async function primedSeed() {
  const cache = await import("./windows-worker-cache.js");
  const invocation = cache.windowsWorkerInvocation("job", verified);
  const [key, value] = [...inherited.data.entries()][0]!;
  const seed = value as Record<string, unknown>;
  vi.resetModules();
  vi.mocked(windowsWorkerOwnerStart).mockClear();
  return { key, seed, invocation };
}

describe("process-local verified cache inheritance", () => {
  it("reuses verified metadata in a fresh isolate without process lookup or bootstrap", async () => {
    const { invocation, seed } = await primedSeed();
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn(() => {
      throw new Error("Unexpected repeated bootstrap");
    });
    expect(windowsWorkerInvocation("filesystem", bootstrap)).toEqual({
      command: invocation.command,
      args: ["filesystem", String(process.pid)],
    });
    expect(windowsWorkerInvocation("job", bootstrap)).toEqual(invocation);
    expect(windowsWorkerOwnerStart).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect([...inherited.data.values()]).toEqual([seed]);
  });

  it.each([
    "pid",
    "birth-shape",
    "birth-range",
    "birth-zero",
    "birth-missing",
    "hash",
    "root",
    "relative",
    "format",
    "shape",
    "missing",
    "extra",
    "array",
    "null",
  ])("ignores an invalid inherited %s and performs full trusted verification", async (variant) => {
    const { key, seed, invocation } = await primedSeed();
    const invalid = { ...seed };
    if (variant === "pid") invalid.ownerPid = process.pid + 1;
    if (variant === "birth-shape") invalid.ownerBirth = 123;
    if (variant === "birth-range") invalid.ownerBirth = "9223372036854775808";
    if (variant === "birth-zero") invalid.ownerBirth = "0";
    if (variant === "birth-missing") delete invalid.ownerBirth;
    if (variant === "hash") invalid.sourceHash = "b".repeat(64);
    if (variant === "root") invalid.executable = "C:\\unverified\\worker.exe";
    if (variant === "relative") invalid.executable = "worker.exe";
    if (variant === "format") invalid.format = 3;
    if (variant === "shape") invalid.ownerPid = String(process.pid);
    if (variant === "missing") delete invalid.ownerPid;
    if (variant === "extra") invalid.unexpected = "invented task input";
    inherited.data.set(key, variant === "null" ? null : variant === "array" ? [invalid] : invalid);
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn(verified);
    expect(windowsWorkerInvocation("job", bootstrap)).toEqual(invocation);
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(windowsWorkerOwnerStart).toHaveBeenCalledOnce();
    expect(inherited.data.get(key)).toEqual(seed);
  });

  it("never bypasses a sticky local initialization failure with a later valid seed", async () => {
    const { key, seed } = await primedSeed();
    inherited.data.clear();
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn(() => ({
      exitCode: 1,
      signal: null,
      stdout: Buffer.alloc(0),
      stderr: "EPRIVATE",
    }));
    expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow("native worker");
    expect(inherited.data.size).toBe(0);
    inherited.data.set(key, seed);
    expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow("native worker");
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(windowsWorkerOwnerStart).toHaveBeenCalledOnce();
  });
});
