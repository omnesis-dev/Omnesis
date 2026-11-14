// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  let cleanup = () => {};
  try {
    if (process.platform === "win32") {
      // Exercise the same fresh generated runtime that source Hermes installs
      // deploy. Never rely on ambient dist or a source-only package alias.
      const { prepareHermesRuntimeAssets } =
        await import("../packages/cli/src/commands/integration-runtime.ts");
      const packageRoot = fileURLToPath(new URL("../packages/agent-integration", import.meta.url));
      const runtime = prepareHermesRuntimeAssets(
        { packageRoot, entry: join(packageRoot, "src", "index.ts") },
        "win32",
      );
      const root = mkdtempSync(join(tmpdir(), "hermes-test-runtime-"));
      cleanup = () => {
        runtime.cleanup();
        rmSync(root, { recursive: true, force: true });
      };
      for (const { file, content } of runtime.files) {
        const destination = join(root, file);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, content);
      }
      cpSync(invocation.args[1], join(root, "test_adapter.py"));
      invocation.args[1] = join(root, "test_adapter.py");
    }
    process.exitCode = await waitForChild(
      spawn(invocation.command, invocation.args, {
        stdio: "inherit",
        env: process.env,
        detached: process.platform !== "win32",
      }),
    );
  } finally {
    cleanup();
  }
}
