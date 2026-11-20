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
const OWNER_QUERY_MARKER = "OMNESIS_OWNER_QUERY_V1";

export type WindowsProcessStartFailure =
  | "invalid-pid"
  | "host-executable"
  | "timeout:before-query"
  | "timeout:query"
  | "timeout:unknown-phase"
  | "spawn"
  | "invalid-output"
  | `exit:${number}`;

function processStartFailure(error: unknown): WindowsProcessStartFailure {
  if (error && typeof error === "object") {
    if ("code" in error && error.code === "ETIMEDOUT") {
      const stderr = "stderr" in error ? error.stderr : undefined;
      if (stderr === "" || (Buffer.isBuffer(stderr) && stderr.length === 0))
        return "timeout:before-query";
      if (
        stderr === OWNER_QUERY_MARKER ||
        (Buffer.isBuffer(stderr) && stderr.equals(Buffer.from(OWNER_QUERY_MARKER)))
      )
        return "timeout:query";
      return "timeout:unknown-phase";
    }
    if (
      "status" in error &&
      typeof error.status === "number" &&
      Number.isSafeInteger(error.status) &&
      error.status >= 0 &&
      error.status <= 0xffffffff
    )
      return `exit:${error.status}`;
  }
  return "spawn";
}

function processStart(
  pid: number,
  timeoutMs: number,
  unavailable?: (reason: WindowsProcessStartFailure) => void,
): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    unavailable?.("invalid-pid");
    return null;
  }
  if (pid === process.pid && ownBirth !== undefined) return ownBirth;
  let executable: string;
  try {
    executable = windowsPowerShellExecutable();
  } catch {
    unavailable?.("host-executable");
    return null;
  }
  let output: string;
  try {
    output = execFileSync(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // Process identity must not depend on cmdlet/module discovery paths.
        `$ErrorActionPreference = 'Stop'; [Console]::Error.Write('${OWNER_QUERY_MARKER}'); [Console]::Error.Flush(); [Console]::Out.Write(([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture))`,
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    // Report only a fixed failure category; never the command or its output.
    unavailable?.(processStartFailure(error));
    return null;
  }
  const birth = output.trim();
  if (!/^[0-9]+$/u.test(birth)) {
    unavailable?.("invalid-output");
    return null;
  }
  if (pid === process.pid) ownBirth = birth;
  return birth;
}

/** Exact UTC creation ticks for lock ownership; arbitrary process probes stay capped at ten seconds. */
export function windowsProcessStart(
  pid: number,
  timeoutMs = 10_000,
  unavailable?: (reason: WindowsProcessStartFailure) => void,
): string | null {
  return processStart(pid, Math.max(1, Math.min(timeoutMs, 10_000)), unavailable);
}

/** Verify only this process within the native worker's remaining initialization budget. */
export function windowsWorkerOwnerStart(
  timeoutMs: number,
  unavailable?: (reason: WindowsProcessStartFailure) => void,
): string | null {
  const remainingMs = Math.floor(Math.min(timeoutMs, 30_000));
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    unavailable?.("timeout:before-query");
    return null;
  }
  return processStart(process.pid, remainingMs, unavailable);
}
