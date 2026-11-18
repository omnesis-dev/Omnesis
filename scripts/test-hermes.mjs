// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForChild } from "./lib/check-process.mjs";
import { bootstrapWindowsPlatform } from "./lib/bootstrap-platform.mjs";
import { installParentShutdownHandler } from "../packages/core/src/parent-shutdown.ts";

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

/** The protocol probe uses the deployed adapter rather than a source-only import. */
export function hermesGatewayProbeInvocation(platform = process.platform, args = []) {
  if (args.length) throw new Error("The gateway probe takes no additional arguments");
  const invocation = hermesTestInvocation(platform);
  invocation.args[1] = fileURLToPath(
    new URL("../packages/agent-integration/test/hermes_gateway_probe.py", import.meta.url),
  );
  return invocation;
}

/** Keep Python and every bridge descendant owned until the suite has joined. */
export async function runHermesInvocation(
  invocation,
  env,
  platform = process.platform,
  runWindows,
) {
  if (platform !== "win32")
    return waitForChild(
      spawn(invocation.command, invocation.args, { stdio: "inherit", env, detached: true }),
    );
  const run = runWindows ?? (await bootstrapWindowsPlatform()).runWindowsJob;
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Hermes tests stopped by their owner"));
  const removeShutdown = installParentShutdownHandler(stop);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of signals) process.on(signal, stop);
  try {
    const result = await run(invocation.command, invocation.args, {
      env,
      signal: controller.signal,
      stdout: "inherit",
      onStderr: (bytes) => process.stderr.write(bytes),
    });
    if (Object.hasOwn(result, "cleanupFailure"))
      throw Object.assign(new Error("Hermes test process cleanup was not confirmed"), {
        cleanupFailure: result.cleanupFailure,
      });
    if (result.failure) {
      process.stderr.write(`Hermes test subprocess ${result.failure}\n`);
      return 1;
    }
    return result.exitCode ?? 1;
  } finally {
    removeShutdown();
    for (const signal of signals) process.removeListener(signal, stop);
  }
}

if (import.meta.main) {
  const gatewayProbe = process.argv[2] === "--gateway-probe";
  const invocation = gatewayProbe
    ? hermesGatewayProbeInvocation(process.platform, process.argv.slice(3))
    : hermesTestInvocation(process.platform, process.argv.slice(2));
  const env = { ...process.env };
  let cleanup = () => {};
  let started = false,
    joined = false;
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
      const entry = join(root, basename(invocation.args[1]));
      cpSync(invocation.args[1], entry);
      invocation.args[1] = entry;
      if (gatewayProbe) env.OMNESIS_HERMES_ADAPTER_PATH = join(root, "adapter.py");
    }
    if (gatewayProbe) {
      delete env.OMNESIS_HERMES_TOOL_CALLS;
      delete env.OMNESIS_HERMES_REAL_MCP;
      env.OMNESIS_HERMES_PROBE_READY = "1";
    }
    started = true;
    process.exitCode = await runHermesInvocation(invocation, env);
    joined = true;
  } finally {
    if (!started || joined) cleanup();
  }
}
