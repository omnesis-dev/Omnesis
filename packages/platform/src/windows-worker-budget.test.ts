// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowsBootstrapRequest } from "./windows-worker-cache.js";

const state = vi.hoisted(() => ({ run: vi.fn(), data: new Map<string, unknown>(), now: 0 }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: state.run,
}));
vi.mock("node:worker_threads", async (original) => ({
  ...(await original<typeof import("node:worker_threads")>()),
  getEnvironmentData: (key: string) => state.data.get(key),
  setEnvironmentData: (key: string, value: unknown) => state.data.set(key, value),
}));

beforeEach(() => {
  vi.resetModules();
  state.run.mockReset();
  state.data.clear();
  state.now = 0;
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.stubEnv("LOCALAPPDATA", "C:\\example\\Local");
  vi.spyOn(performance, "now").mockImplementation(() => state.now);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function slowIdentity(elapsedMs = 15_000) {
  state.run.mockImplementation((_command, _args, options: { timeout: number }) => {
    if (options.timeout < elapsedMs) {
      state.now += options.timeout;
      throw Object.assign(new Error("Invented identity deadline"), {
        code: "ETIMEDOUT",
        stderr: "",
        status: null,
      });
    }
    state.now += elapsedMs;
    return "638000000000000001";
  });
}

function verified(request: WindowsBootstrapRequest) {
  const input = Buffer.from(request.input);
  const start = input.readUInt32LE(0) + 4;
  const size = input.readUInt32LE(start);
  const metadata = JSON.parse(input.subarray(start + 4, start + 4 + size).toString("utf8")) as {
    root: string;
    sourceHash: string;
    ownerPid: number;
    ownerBirth: string;
  };
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

describe("one Windows native initialization budget", () => {
  it.each([undefined, 180_000])(
    "allows a 15s identity plus 5s compile within the existing 30s budget (%s)",
    async (timeoutMs) => {
      slowIdentity();
      const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
      const bootstrap = vi.fn((request: WindowsBootstrapRequest, remainingMs: number) => {
        expect(remainingMs).toBe(15_000);
        state.now += 5_000;
        return verified(request);
      });
      expect(windowsWorkerInvocation("job", bootstrap, { timeoutMs }).parentBirth).toBe(
        "133088768000000001",
      );
      expect(state.run.mock.calls[0]![2].timeout).toBe(30_000);
      expect(state.now).toBe(20_000);
      expect(bootstrap).toHaveBeenCalledOnce();
    },
  );

  it("deducts owner verification from a shorter caller budget", async () => {
    slowIdentity();
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn((request: WindowsBootstrapRequest, remainingMs: number) => {
      expect(remainingMs).toBe(5_000);
      state.now += 4_000;
      return verified(request);
    });
    windowsWorkerInvocation("job", bootstrap, { timeoutMs: 20_000 });
    expect(state.run.mock.calls[0]![2].timeout).toBe(20_000);
    expect(state.now).toBe(19_000);
  });

  it("never starts bootstrap when the owner consumes the caller deadline", async () => {
    slowIdentity(20_000);
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn(verified);
    expect(() => windowsWorkerInvocation("job", bootstrap, { timeoutMs: 20_000 })).toThrow(
      /initialization timed out/u,
    );
    expect(bootstrap).not.toHaveBeenCalled();
    expect(state.data.size).toBe(0);
  });

  it("refuses a caller deadline shorter than the identity without starting bootstrap", async () => {
    slowIdentity();
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn(verified);
    expect(() => windowsWorkerInvocation("job", bootstrap, { timeoutMs: 12_000 })).toThrow(
      /owner-birth:timeout/u,
    );
    expect(state.now).toBe(12_000);
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it.each([0, -1])(
    "never probes or bootstraps an expired %s ms initialization",
    async (timeoutMs) => {
      slowIdentity();
      const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
      const bootstrap = vi.fn(verified);
      expect(() => windowsWorkerInvocation("job", bootstrap, { timeoutMs })).toThrow(
        /initialization timed out/u,
      );
      expect(state.run).not.toHaveBeenCalled();
      expect(bootstrap).not.toHaveBeenCalled();
    },
  );

  it("charges request framing before deciding whether bootstrap may start", async () => {
    slowIdentity();
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const concat = Buffer.concat;
    vi.spyOn(Buffer, "concat").mockImplementation((list, length) => {
      state.now = 20_000;
      return concat(list, length);
    });
    const bootstrap = vi.fn(verified);
    expect(() => windowsWorkerInvocation("job", bootstrap, { timeoutMs: 20_000 })).toThrow(
      /initialization timed out/u,
    );
    expect(bootstrap).not.toHaveBeenCalled();
    expect(state.data.size).toBe(0);
  });

  it.each([-1, Number.NaN])(
    "refuses an invalid monotonic-clock observation %s before bootstrap",
    async (observation) => {
      state.run.mockImplementation(() => {
        state.now = observation;
        return "638000000000000001";
      });
      const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
      const bootstrap = vi.fn(verified);
      expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow(/initialization timed out/u);
      expect(bootstrap).not.toHaveBeenCalled();
      expect(state.data.size).toBe(0);
    },
  );

  it("does not accept a successful bootstrap response after the initialization deadline", async () => {
    slowIdentity();
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn((request: WindowsBootstrapRequest) => {
      state.now += 16_000;
      return verified(request);
    });
    const overrun =
      "Windows native worker initialization timed out (owner 15000 ms, bootstrap 16000 ms, 30000 ms allowance)";
    expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow(overrun);
    expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow(overrun);
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(state.data.size).toBe(0);
  });

  it("names the phase durations when the owner probe exhausts the whole allowance", async () => {
    slowIdentity(35_000);
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn(verified);
    expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow(
      "Cannot verify Windows native worker owner (EPRIVATE:owner-birth:timeout:before-query; owner 30000 ms, 30000 ms allowance)",
    );
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it("names the phase durations when bootstrap times out within the allowance", async () => {
    slowIdentity(12_000);
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn((_request: WindowsBootstrapRequest, remainingMs: number) => {
      state.now += remainingMs;
      return {
        exitCode: null,
        signal: null,
        stderr: "",
        stdout: Buffer.alloc(0),
        failure: "timeout" as const,
      };
    });
    expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow(
      "Cannot initialize the protected Windows native worker (timeout; owner 12000 ms, bootstrap 18000 ms, 30000 ms allowance)",
    );
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("preserves pending cleanup authority even when bootstrap exhausts the deadline", async () => {
    slowIdentity();
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn((request: WindowsBootstrapRequest) => {
      state.now = 30_000;
      return { ...verified(request), cleanupFailure: undefined };
    });
    let failure: unknown;
    try {
      windowsWorkerInvocation("job", bootstrap);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(Object.hasOwn(failure as Error, "cleanupFailure")).toBe(true);
    expect(() => windowsWorkerInvocation("job", bootstrap)).toThrow(failure as Error);
    expect(bootstrap).toHaveBeenCalledOnce();
  });

  it("keeps cached and inherited metadata independent of a fresh initialization budget", async () => {
    slowIdentity();
    const { windowsWorkerInvocation } = await import("./windows-worker-cache.js");
    const bootstrap = vi.fn(verified);
    const invocation = windowsWorkerInvocation("job", bootstrap);
    state.now = 1_000_000;
    expect(windowsWorkerInvocation("job", bootstrap, { timeoutMs: 0 })).toEqual(invocation);
    vi.resetModules();
    const inherited = await import("./windows-worker-cache.js");
    expect(inherited.windowsWorkerInvocation("job", bootstrap, { timeoutMs: 0 })).toEqual(
      invocation,
    );
    expect(state.run).toHaveBeenCalledOnce();
    expect(bootstrap).toHaveBeenCalledOnce();
  });
});
