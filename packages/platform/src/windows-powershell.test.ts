// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { windowsEnvironmentValue, windowsPowerShellExecutable } from "./windows-powershell.js";

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
