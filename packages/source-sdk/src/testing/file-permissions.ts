// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { win32 } from "node:path";

/** Root bypasses POSIX modes; Windows fixtures deny their own user's read access. */
export const canDenyFixtureReads = process.platform === "win32" || process.getuid?.() !== 0;
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
