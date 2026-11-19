// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { killWindowsProcessTree } from "./windows-process-tree.js";
import type { ChildProcess } from "node:child_process";
export { killWindowsProcessTree } from "./windows-process-tree.js";

/**
 * Preserve POSIX child signals; stop Windows wrappers and their descendants.
 * Call before a Windows root
 * exits: taskkill cannot identify descendants of a root that has already gone.
 * This is explicit shutdown, not a lifetime job object protecting against a
 * crashed parent. The returned promise owns the taskkill subprocess through exit.
 */
export async function terminateChildProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      await killWindowsProcessTree(child.pid);
    } catch (err) {
      // A child can finish naturally while taskkill starts; preserve that success.
      if (child.exitCode === null && child.signalCode === null) throw err;
    }
  } else {
    child.kill(signal);
  }
}
