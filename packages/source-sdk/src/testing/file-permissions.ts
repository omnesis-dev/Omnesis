// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, win32 } from "node:path";

let currentSid: string | undefined;
function ownSid(): string {
  if (currentSid) return currentSid;
  const result = execFileSync(
    win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  const found = result.match(/\bS-1-\d+(?:-\d+)+\b/gu);
  if (found?.length !== 1)
    throw new Error("Cannot identify the owned Windows permission fixture user");
  currentSid = found[0]!;
  return currentSid;
}

/**
 * Set modes only on owned fixtures. Windows stages real read/list denial with
 * an explicit current-user DACL entry; restoring read access removes that denial.
 * Write/execute mode bits remain POSIX-only and are not simulated on Windows.
 */
export function setFixtureMode(path: string, mode: number): void {
  if (process.platform !== "win32") {
    chmodSync(path, mode);
    return;
  }
  const sid = `*${ownSid()}`;
  const args = mode & 0o444 ? [path, "/remove:d", sid, "/Q"] : [path, "/deny", `${sid}:(RD)`, "/Q"];
  execFileSync(
    win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"),
    args,
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
}

/** Probe only owned data: backup privilege can bypass Windows read-denial DACLs. */
export function probeFixtureReadDenial(
  read: (path: string) => unknown = readFileSync,
  setMode: (path: string, mode: number) => void = setFixtureMode,
): boolean {
  const root = mkdtempSync(join(tmpdir(), "owned-read-capability-"));
  const file = join(root, "probe.txt");
  const errors: unknown[] = [];
  let created = false;
  let denied = false;
  try {
    writeFileSync(file, "Invented permission probe", { mode: 0o600 });
    created = true;
    setMode(file, 0o000);
    try {
      read(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw error;
      denied = true;
    }
  } catch (error) {
    errors.push(error);
  } finally {
    if (created) {
      try {
        setMode(file, 0o600);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      rmSync(root, { recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Permission capability probe failed");
  return denied;
}

/** Root bypasses POSIX modes; Windows tests require an effective owned-file denial. */
export const canDenyFixtureReads =
  process.platform === "win32" ? probeFixtureReadDenial() : process.getuid?.() !== 0;
