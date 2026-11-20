// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const TICKS = "638000000000000001";
const MARKER = "OMNESIS_OWNER_QUERY_V1";
const helperPath = fileURLToPath(new URL("./windows-owner-startup-proof.mjs", import.meta.url));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("SystemRoot", "C:\\Windows");
});
afterEach(() => vi.unstubAllEnvs());

async function fixture(result, elapsed = 15_123.5) {
  const { measureWindowsOwnerStartup } = await import("./windows-owner-startup-proof.mjs");
  const execute = vi.fn(() => result);
  const now = vi
    .fn()
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(100 + elapsed);
  return { measureWindowsOwnerStartup, execute, now };
}

describe("isolated Windows owner startup timing", () => {
  test("runs the production trusted command once with a bounded experimental deadline", async () => {
    const { measureWindowsOwnerStartup, execute, now } = await fixture({
      status: 0,
      stdout: `${TICKS}\r\n`,
      stderr: MARKER,
    });
    const original = childProcess.execFileSync;
    expect(await measureWindowsOwnerStartup({ platform: "win32", execute, now })).toEqual({
      elapsedMs: 15_124,
      validIdentity: true,
      phase: "query",
      outcome: "verified",
    });
    expect(execute).toHaveBeenCalledOnce();
    const [executable, args, options] = execute.mock.calls[0];
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    const script = args.at(-1);
    expect(script).toContain(`GetProcessById(${process.pid})`);
    expect(script).toContain(`[Console]::Error.Write('${MARKER}'); [Console]::Error.Flush();`);
    expect(script.indexOf("Error.Flush()")).toBeLessThan(script.indexOf("GetProcessById"));
    expect(options).toMatchObject({
      timeout: 30_000,
      maxBuffer: 65_536,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(childProcess.execFileSync).toBe(original);
    const { execFileSync } = await import("node:child_process");
    expect(execFileSync).toBe(original);
  });

  test.each([
    ["", "before-query"],
    [Buffer.alloc(0), "before-query"],
    [MARKER, "query"],
    [Buffer.from(MARKER), "query"],
    ["invented private output", "unknown"],
    [`${MARKER}invented private output`, "unknown"],
  ])("redacts timeout diagnostics for an observed phase", async (stderr, phase) => {
    const { measureWindowsOwnerStartup, execute, now } = await fixture({
      status: null,
      error: Object.assign(new Error("invented private command"), { code: "ETIMEDOUT" }),
      stdout: "invented private ticks",
      stderr,
    });
    const original = childProcess.execFileSync;
    const measurement = await measureWindowsOwnerStartup({ platform: "win32", execute, now });
    expect(measurement).toEqual({
      elapsedMs: 15_124,
      validIdentity: false,
      phase,
      outcome: "timeout",
    });
    expect(JSON.stringify(measurement)).not.toContain("invented");
    expect(JSON.stringify(measurement)).not.toContain(MARKER);
    expect(childProcess.execFileSync).toBe(original);
    expect(execute).toHaveBeenCalledOnce();
  });

  test.each(["invented private identity", "504911232000000000", "9999999999999999999"])(
    "does not publish invalid identity output",
    async (stdout) => {
      const { measureWindowsOwnerStartup, execute, now } = await fixture({
        status: 0,
        stdout,
        stderr: MARKER,
      });
      expect(await measureWindowsOwnerStartup({ platform: "win32", execute, now })).toEqual({
        elapsedMs: 15_124,
        validIdentity: false,
        phase: "query",
        outcome: "invalid-identity",
      });
    },
  );

  test("refuses a cached identity as a fresh execution measurement", async () => {
    const { measureWindowsOwnerStartup, execute, now } = await fixture({
      status: 0,
      stdout: TICKS,
      stderr: MARKER,
    });
    expect(
      (await measureWindowsOwnerStartup({ platform: "win32", execute, now })).validIdentity,
    ).toBe(true);
    execute.mockClear();
    expect(await measureWindowsOwnerStartup({ platform: "win32", execute, now: () => 0 })).toEqual({
      elapsedMs: 0,
      validIdentity: false,
      phase: "unknown",
      outcome: "probe-not-executed",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("does not change the production default deadline after restoring the adapter", async () => {
    const { measureWindowsOwnerStartup, execute, now } = await fixture({
      status: null,
      error: { code: "ETIMEDOUT" },
      stderr: "",
    });
    await measureWindowsOwnerStartup({ platform: "win32", execute, now });
    const original = childProcess.execFileSync;
    const capture = vi.fn(() => {
      throw new Error("invented refusal");
    });
    childProcess.execFileSync = capture;
    const { syncBuiltinESMExports } = await import("node:module");
    syncBuiltinESMExports();
    try {
      const { windowsProcessStart } =
        await import("../../packages/platform/src/windows-powershell.ts");
      expect(windowsProcessStart(process.pid)).toBeNull();
      expect(capture.mock.calls[0][2].timeout).toBe(10_000);
    } finally {
      childProcess.execFileSync = original;
      syncBuiltinESMExports();
    }
  });

  test("restores builtins and projects no thrown executor details", async () => {
    const { measureWindowsOwnerStartup, now } = await fixture(null);
    const original = childProcess.execFileSync;
    const execute = vi.fn(() => {
      throw new Error("invented private executor details");
    });
    const measurement = await measureWindowsOwnerStartup({ platform: "win32", execute, now });
    expect(measurement).toEqual({
      elapsedMs: 15_124,
      validIdentity: false,
      phase: "unknown",
      outcome: "spawn",
    });
    expect(childProcess.execFileSync).toBe(original);
    expect(execute).toHaveBeenCalledOnce();
  });

  test("projects only an allowlisted outcome for an unsuccessful process exit", async () => {
    const { measureWindowsOwnerStartup, execute, now } = await fixture({
      status: 7,
      stdout: "invented private ticks",
      stderr: "invented private diagnostic",
    });
    expect(await measureWindowsOwnerStartup({ platform: "win32", execute, now })).toEqual({
      elapsedMs: 15_124,
      validIdentity: false,
      phase: "unknown",
      outcome: "exit",
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  test("does not launch when the trusted host executable cannot be resolved", async () => {
    const { measureWindowsOwnerStartup, execute, now } = await fixture(null);
    vi.stubEnv("SystemRoot", "relative");
    expect(await measureWindowsOwnerStartup({ platform: "win32", execute, now })).toEqual({
      elapsedMs: 15_124,
      validIdentity: false,
      phase: "unknown",
      outcome: "host-executable",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test("refuses unsupported platforms without launching anything", async () => {
    const { measureWindowsOwnerStartup, execute, now } = await fixture(null);
    expect(await measureWindowsOwnerStartup({ platform: "linux", execute, now })).toEqual({
      elapsedMs: 0,
      validIdentity: false,
      phase: "unknown",
      outcome: "unsupported-platform",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  test.skipIf(process.platform === "win32")(
    "CLI publishes only its redacted result and fails unsupported execution",
    () => {
      const result = childProcess.spawnSync(process.execPath, [helperPath], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        elapsedMs: 0,
        validIdentity: false,
        phase: "unknown",
        outcome: "unsupported-platform",
      });
    },
  );
});
