// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { waitForChild } from "./lib/check-process.mjs";

/** Native Python executable and argv; no shell or platform-specific launcher shim. */
export function hermesTestInvocation(platform = process.platform, args = []) {
  return {
    command: platform === "win32" ? "python" : "python3",
    args: [
      "-B",
      fileURLToPath(
        new URL("../packages/agent-integration/hermes/test_adapter.py", import.meta.url),
      ),
      ...args,
    ],
  };
}

if (import.meta.main) {
  const invocation = hermesTestInvocation(process.platform, process.argv.slice(2));
  process.exitCode = await waitForChild(
    spawn(invocation.command, invocation.args, {
      stdio: "inherit",
      env: process.env,
      detached: process.platform !== "win32",
    }),
  );
}
