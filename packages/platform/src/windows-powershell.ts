// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { win32 } from "node:path";

/** Windows Worker env copies use ordinary case-sensitive JS keys. */
export function windowsEnvironmentValue(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const wanted = name.toLowerCase();
  // Match Node's Windows child-process environment rule for duplicate casing.
  const key = Object.keys(env)
    .sort()
    .find((key) => key.toLowerCase() === wanted && env[key] !== undefined);
  return key === undefined ? undefined : env[key];
}

/** Host tools never resolve from an indexed folder or an update target's PATH. */
export function windowsPowerShellExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const root = windowsEnvironmentValue("SystemRoot", env) ?? windowsEnvironmentValue("WINDIR", env);
  if (!root || !win32.isAbsolute(root)) throw new Error("Windows system directory is unavailable");
  return win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

let ownBirth: string | undefined;

/** Exact UTC creation ticks for durable ownership records; only this process is cached. */
export function windowsProcessStart(pid: number, timeoutMs = 10_000): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid && ownBirth !== undefined) return ownBirth;
  try {
    const birth = execFileSync(
      windowsPowerShellExecutable(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference = 'Stop'; [Console]::Out.Write((Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture))`,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: Math.max(1, Math.min(timeoutMs, 10_000)),
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    if (!/^[0-9]+$/u.test(birth)) return null;
    if (pid === process.pid) ownBirth = birth;
    return birth;
  } catch {
    return null;
  }
}
