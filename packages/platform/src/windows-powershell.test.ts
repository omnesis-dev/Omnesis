// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { windowsEnvironmentValue, windowsPowerShellExecutable } from "./windows-powershell.js";

const commands = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFileSync: commands.run,
}));

describe("Windows host environment in Worker copies", () => {
  it.each([
    { SYSTEMROOT: "C:\\Windows" },
    { systemroot: "C:\\Windows" },
    { windir: "C:\\Windows" },
    { WiNdIr: "C:\\Windows" },
  ])("resolves the trusted host executable with case-sensitive Worker keys %o", (env) => {
    expect(windowsPowerShellExecutable(env)).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
  it.each([
    { localappdata: "C:\\example\\Local" },
    { LocalAppData: "C:\\example\\Local" },
    { LOCALAPPDATA: "C:\\example\\Local" },
  ])("resolves local application data without relying on the main-thread env proxy %o", (env) => {
    expect(windowsEnvironmentValue("LOCALAPPDATA", env)).toBe("C:\\example\\Local");
  });
  it("resolves mixed-case user profile fallback and ignores absent variables", () => {
    const env = { UserProfile: "C:\\example", LOCALAPPDATA: undefined };
    expect(windowsEnvironmentValue("USERPROFILE", env)).toBe("C:\\example");
    expect(windowsEnvironmentValue("LOCALAPPDATA", env)).toBeUndefined();
  });
  it("matches Windows child-process ordering when a Worker supplies duplicate casing", () => {
    expect(
      windowsEnvironmentValue("SystemRoot", { SystemRoot: "D:\\other", SYSTEMROOT: "C:\\Windows" }),
    ).toBe("C:\\Windows");
  });
  it("fails closed instead of resolving a missing or relative system directory", () => {
    expect(() => windowsPowerShellExecutable({})).toThrow("system directory is unavailable");
    expect(() => windowsPowerShellExecutable({ systemroot: "relative" })).toThrow(
      "system directory is unavailable",
    );
  });
});

describe("Windows creation-time identity", () => {
  beforeEach(() => {
    vi.resetModules();
    commands.run.mockReset();
    vi.stubEnv("SystemRoot", "C:\\Windows");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [
      Object.assign(new Error("invented private command"), { code: "ETIMEDOUT", status: null }),
      "timeout",
    ],
    [Object.assign(new Error("invented private command"), { code: "ENOENT" }), "spawn"],
    [
      Object.assign(new Error("invented private command"), {
        status: 7,
        stderr: "invented secret",
      }),
      "exit:7",
    ],
    [Object.assign(new Error("invented private command"), { status: "invented secret" }), "spawn"],
    [Object.assign(new Error("invented private command"), { status: -1 }), "spawn"],
    [Object.assign(new Error("invented private command"), { status: 1.5 }), "spawn"],
    [Object.assign(new Error("invented private command"), { status: 0x100000000 }), "spawn"],
  ])("preserves a safe reason for an unavailable identity", async (error, reason) => {
    const { windowsProcessStart } = await import("./windows-powershell.js");
    commands.run.mockImplementation(() => {
      throw error;
    });
    const unavailable = vi.fn();
    expect(windowsProcessStart(process.pid, 10_000, unavailable)).toBeNull();
    expect(unavailable).toHaveBeenCalledExactlyOnceWith(reason);
  });

  it("recognizes an actual Node timeout without exposing its command or captured output", async () => {
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { windowsProcessStart } = await import("./windows-powershell.js");
    commands.run.mockImplementation(() =>
      real.execFileSync(
        process.execPath,
        ["-e", 'process.stdout.write("invented private output");setInterval(()=>{},1000)'],
        {
          timeout: 100,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    );
    const unavailable = vi.fn();
    expect(windowsProcessStart(process.pid, 10_000, unavailable)).toBeNull();
    expect(unavailable).toHaveBeenCalledExactlyOnceWith("timeout");
  });

  it("distinguishes invalid output from an unresolvable trusted executable", async () => {
    const { windowsProcessStart } = await import("./windows-powershell.js");
    const unavailable = vi.fn();
    commands.run.mockReturnValue("invented private output");
    expect(windowsProcessStart(process.pid, 10_000, unavailable)).toBeNull();
    expect(unavailable).toHaveBeenLastCalledWith("invalid-output");
    vi.stubEnv("SystemRoot", "relative");
    expect(windowsProcessStart(process.pid, 10_000, unavailable)).toBeNull();
    expect(unavailable).toHaveBeenLastCalledWith("host-executable");
    expect(commands.run).toHaveBeenCalledOnce();
  });

  it("keeps exact ticks beyond Number precision and never caches another process", async () => {
    const { windowsProcessStart } = await import("./windows-powershell.js");
    commands.run
      .mockReturnValueOnce("638000000000000001\r\n")
      .mockReturnValueOnce("638000000000000002\r\n");
    expect(windowsProcessStart(process.pid + 1)).toBe("638000000000000001");
    expect(windowsProcessStart(process.pid + 1)).toBe("638000000000000002");
    expect(commands.run).toHaveBeenCalledTimes(2);
  });

  it("retries an unavailable self identity and caches only the successful observation", async () => {
    const { windowsProcessStart } = await import("./windows-powershell.js");
    commands.run
      .mockImplementationOnce(() => {
        throw new Error("Invented metadata refusal");
      })
      .mockReturnValueOnce("638000000000000003\n");
    expect(windowsProcessStart(process.pid)).toBeNull();
    expect(windowsProcessStart(process.pid)).toBe("638000000000000003");
    expect(windowsProcessStart(process.pid)).toBe("638000000000000003");
    expect(commands.run).toHaveBeenCalledTimes(2);
  });

  it.each(["", "0x123", "638.5", "123\ninvalid"])(
    "refuses malformed identity output %j",
    async (output) => {
      const { windowsProcessStart } = await import("./windows-powershell.js");
      commands.run.mockReturnValue(output);
      expect(windowsProcessStart(process.pid)).toBeNull();
    },
  );

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "never probes an invalid process id %s",
    async (pid) => {
      const { windowsProcessStart } = await import("./windows-powershell.js");
      expect(windowsProcessStart(pid)).toBeNull();
      expect(commands.run).not.toHaveBeenCalled();
    },
  );

  it.each([
    [1, 1],
    [0, 1],
    [25_000, 10_000],
  ])("keeps the requested %s ms deadline bounded at %s ms", async (requested, expected) => {
    const { windowsProcessStart } = await import("./windows-powershell.js");
    commands.run.mockReturnValue("638000000000000004\n");
    expect(windowsProcessStart(process.pid, requested)).toBe("638000000000000004");
    expect(commands.run.mock.calls[0]?.[2]).toMatchObject({ timeout: expected, windowsHide: true });
  });
});
