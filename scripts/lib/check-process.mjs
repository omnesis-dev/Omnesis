// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  WindowsProcessTree,
  killWindowsProcessTree,
} from "../../packages/core/src/windows-process-tree.ts";
import { requestChildShutdown } from "../../packages/core/src/parent-shutdown.ts";
import {
  waitForChild as waitForOwnedChild,
  signalChildTree as signalPosixChildTree,
} from "./check-process-runtime.mjs";
export { childGroupIsAlive } from "./check-process-runtime.mjs";

async function signalChildTree(child, signal) {
  if (process.platform === "win32" && typeof child.pid === "number") {
    if (signal !== "SIGKILL" && (await requestChildShutdown(child))) return;
    await killWindowsProcessTree(child.pid);
    return;
  }
  return signalPosixChildTree(child, signal);
}

/** Platform adapter; the generic runner can also load before dependencies exist. */
export function waitForChild(child, opts = {}) {
  const {
    signalFn = signalChildTree,
    windowsTree = process.platform === "win32" && child.spawnfile && child.pid
      ? new WindowsProcessTree(child.pid, {
          rootIsAlive: () => child.exitCode === null && child.signalCode === null,
        })
      : null,
    ...rest
  } = opts;
  return waitForOwnedChild(child, { ...rest, signalFn, windowsTree });
}
