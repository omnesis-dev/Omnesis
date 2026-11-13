// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { waitForChild } from "../lib/check-process.mjs";

/** Installation is outside the Windows runtime compatibility contract. */
export const INSTALLER_TEST_EXCLUSIONS = [
  { pattern: "scripts/install-e2e/**", reason: "Installer acceptance harness and its fixtures" },
  { pattern: "scripts/release/install-sh-*.test.mjs", reason: "POSIX shell installer behavior" },
  { pattern: "scripts/release/install-e2e-gate.test.mjs", reason: "Installer release gate" },
  {
    pattern: "scripts/release/installer-cli-contract.test.mjs",
    reason: "Shell installer CLI contract",
  },
  {
    pattern: "scripts/release/hardened-gateway-sh.test.mjs",
    reason: "Linux hardened installer script",
  },
  { pattern: "scripts/release/docker-install-context.test.mjs", reason: "Docker installer layout" },
];

export const FOCUSED_UNIT_FILES = [
  "packages/core/src/gateway-lock.test.ts",
  "packages/core/src/atomic-write.test.ts",
  "packages/core/src/worker-entry.test.ts",
  "packages/core/src/node-command.test.ts",
  "packages/core/src/npm-command.test.ts",
  "packages/core/src/windows-job.test.ts",
  "packages/core/src/windows-job-stream.test.ts",
  "packages/core/src/parent-shutdown.test.ts",
  "packages/core/src/windows-process-tree.test.ts",
  "packages/core/src/child-termination.test.ts",
  "packages/config/src/load-dotenv.test.ts",
  "packages/source-sdk/src/path-probe-node.test.ts",
  "packages/collector/src/e2e/gateway-env.test.ts",
  "packages/collector/src/e2e/subprocess-reaper.test.ts",
  "packages/collector/src/file-watcher-manager.test.ts",
  "packages/collector/src/source-descriptors.test.ts",
  "packages/gateway-client/src",
  "packages/gateway/src/process-launcher/process-launcher.test.ts",
  "packages/gateway/src/widget-renderers.test.ts",
  "packages/cli/src/credentials-wizard.test.ts",
  "packages/cli/src/commands/devices.test.ts",
  "packages/cli/src/commands/push.test.ts",
  "packages/cli/src/service/exec-resolver.test.ts",
  "packages/cli/src/update/build-tools.test.ts",
  "packages/providers/obsidian",
  "packages/providers/local-files",
  "packages/providers/browser-history/src/paths.test.ts",
];

export const FOCUSED_E2E_FILES = [
  "packages/collector/src/e2e/gateway-lifecycle.e2e.test.ts",
  "packages/collector/src/e2e/synth-pipeline.e2e.test.ts",
  "packages/collector/src/e2e/source-descriptors.e2e.test.ts",
];

/** Every entry is argv for Node, never a command interpreted by a shell. */
export function windowsCheckTasks(lane, shard) {
  if (shard !== undefined && (lane !== "e2e" || !/^[12]\/2$/u.test(shard))) {
    throw new Error("Only the E2E lane takes --shard=1/2 or --shard=2/2");
  }
  switch (lane) {
    case "focused":
      return [
        ["scripts/run-check.mjs", "unit", ...FOCUSED_UNIT_FILES],
        ["scripts/run-check.mjs", "e2e", ...FOCUSED_E2E_FILES],
      ];
    case "unit":
      return [
        [
          "scripts/run-check.mjs",
          "unit",
          ...INSTALLER_TEST_EXCLUSIONS.flatMap(({ pattern }) => ["--exclude", pattern]),
        ],
        // The generic unit runner keeps the script smoke phase separate.
        ["scripts/run-check.mjs", "smoke"],
        ["packages/agent-integration/test/openclaw_gateway_probe.mjs"],
        ["scripts/test-hermes.mjs"],
      ];
    case "e2e":
      return [["scripts/run-check.mjs", "e2e", ...(shard ? [`--shard=${shard}`] : [])]];
    case "portal":
      return [["scripts/run-check.mjs", "portal"]];
    default:
      throw new Error("Expected Windows lane: focused, unit, e2e, portal");
  }
}

async function main(args) {
  const [lane, ...options] = args;
  if (options.some((option) => option !== "--list" && !option.startsWith("--shard="))) {
    throw new Error("Expected --list or --shard=1/2 or --shard=2/2");
  }
  if (options.filter((option) => option.startsWith("--shard=")).length > 1) {
    throw new Error("Pass one E2E shard");
  }
  const shard = options.find((option) => option.startsWith("--shard="))?.slice("--shard=".length);
  const tasks = windowsCheckTasks(lane, shard);
  if (options.includes("--list")) {
    process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
    return 0;
  }
  for (const task of tasks) {
    const code = await waitForChild(
      spawn(process.execPath, task, {
        stdio: "inherit",
        env: process.env,
        detached: process.platform !== "win32",
      }),
    );
    if (code !== 0) return code;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
