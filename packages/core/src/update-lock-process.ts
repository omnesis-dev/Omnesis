// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { windowsProcessStart } from "./windows-process-tree.js";

export function processStart(pid: number): string | null {
  if (process.platform === "win32") return windowsProcessStart(pid);
  if (process.platform === "darwin") {
    try {
      return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  }
  if (process.platform !== "linux") return null;
  try {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const start = stat.slice(close + 2).split(" ")[19];
    return bootId && start ? `${bootId}:${start}` : null;
  } catch {
    return null;
  }
}

export function sameProcess(pid: number, expectedStart: string | null): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return expectedStart === null || processStart(pid) === expectedStart;
}

export function processGroupExists(pid: number): boolean {
  try {
    // Windows publishes the job owner's PID; POSIX publishes a process group.
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
