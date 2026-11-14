// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { waitForChild } from "../lib/check-process.mjs";

/** Installation is outside the Windows runtime compatibility contract. */
export const INSTALLER_TEST_EXCLUSIONS = [
  {
    pattern: "packages/cli/src/update/build-heap-install-shell.test.ts",
    reason: "POSIX installer shell parity; portable build policy remains covered",
  },
  {
    pattern: "packages/cli/src/update/source-launcher-install-shell.test.ts",
    reason:
      "POSIX installer/frontdoor execution; portable renderer and Node lock logic remain covered",
  },
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
  "packages/platform/src/windows-storage-directory.windows.test.ts",
  "packages/relay/src/store.windows.test.ts",
  "packages/relay/src/windows-storage.test.ts",
  "packages/relay/src/store.test.ts",
  "packages/relay/src/credentials.test.ts",
  "packages/relay/src/admin.test.ts",
  "packages/relay/src/carriers/carriers.test.ts",
  "packages/cloud-relay/src/google-credentials.test.ts",
  "packages/cloud-relay/src/device-key-file.test.ts",
  "packages/cloud-relay/src/runtime.test.ts",
  "packages/cloud-relay/src/runtime-key.test.ts",
  "packages/cloud-relay/src/runtime-acme.test.ts",
  "packages/cli/src/commands/connect.test.ts",
  "packages/cli/src/commands/connect.integration.test.ts",
  "packages/gateway/src/workers/indexer-worker-boot.test.ts",
  "packages/collector/src/e2e/windows-tree-drain.test.ts",
  "scripts/ci/test-shell.test.mjs",
  "scripts/pii-scan.test.mjs",
  "packages/gateway/src/disk-usage-identity.test.ts",
  "packages/gateway/src/workers/search-pool.respawn.test.ts",
  "packages/gateway/src/indexer/usearch-validation.test.ts",
  "packages/core/src/default-config-dir.test.ts",
  "packages/core/src/sqlite-snapshot-races.test.ts",
  "packages/core/src/sqlite-snapshot.test.ts",
  "packages/core/src/collector-pairing-state.test.ts",
  "evals/briefs/src/deepseek-lane.test.ts",
  "packages/types/src/temporal-vocabulary.test.ts",
  "packages/eval/src/suite.test.ts",
  "packages/cli/src/commands/uninstall.test.ts",
  "packages/cli/src/uninstall/path-containment.test.ts",
  "packages/gateway/src/disk-usage.test.ts",
  "packages/cli/src/update/source-launcher.test.ts",
  "packages/cli/src/update/build-heap.test.ts",
  "packages/cli/src/commands/secure-docker.test.ts",
  "packages/agent/src/codex-private-state.test.ts",
  "packages/platform/src/windows-private-traversal.windows.test.ts",
  "packages/agent/src/codex-runtime-pool.test.ts",
  "packages/core/src/backup-layout.test.ts",
  "packages/gateway/src/http/services/BackupService.test.ts",
  "packages/gateway/src/privacy/policy-store.test.ts",
  "packages/gateway/src/instructions/store.test.ts",
  "packages/gateway/src/http/routes/instructions.test.ts",
  "packages/gateway/src/data/repositories/TokenRepository.test.ts",
  "packages/gateway/src/models/codex-runtime-installer.test.ts",
  "packages/gateway/src/http/routes/push.test.ts",
  "packages/gateway/src/http/services/PushAdminService.test.ts",
  "packages/gateway/src/workers/worker-module-graph.test.ts",
  "packages/gateway/src/observability/stall-monitor.test.ts",
  "packages/gateway/src/observability/flight-recorder.test.ts",
  "packages/core/src/subpath/subpath.test.ts",
  "packages/gateway/src/config-store.test.ts",
  "packages/collector/src/source-host-builder.test.ts",
  "packages/collector/src/auth-subprocess-session.test.ts",
  "packages/cloud-relay/src/client-defaults.test.ts",
  "packages/cloud-relay/src/google-desktop.test.ts",
  "packages/cloud-relay/src/gateway-key-client.test.ts",
  "packages/cloud-relay/src/key-routes.test.ts",
  "packages/cloud-relay/src/server-recovery.test.ts",
  "packages/watch/src/runtime/adversarial.test.ts",
  "packages/platform/src/windows-private-copy.test.ts",
  "packages/near-dupes/src/runner/runner.boundary.test.ts",
  "packages/near-dupes/src/runner/runner.test.ts",
  "packages/near-dupes/src/paths.test.ts",
  "packages/collector/src/service-restart.test.ts",
  "packages/collector/src/event-loop-watchdog.test.ts",
  "packages/collector/src/windows-process-probe.test.ts",
  "packages/collector/src/freshness-probe.test.ts",
  "packages/near-dupes/src/store/repository.paths.test.ts",
  "packages/near-dupes/src/filters/annotate.boundary.test.ts",
  "packages/near-dupes/src/filters/annotate.test.ts",
  "packages/gateway/portal/js/views/portal-entities.test.ts",
  "packages/gateway/src/transcribe/audio-decode.test.ts",
  "packages/core/src/tls-material.test.ts",
  "packages/core/src/tls-distrust.test.ts",
  "packages/gateway/src/storage-encryption.test.ts",
  "packages/core/src/storage-readiness.test.ts",
  "packages/core/src/secret-store.test.ts",
  "packages/agent-integration/src/harness-update-process.windows.test.ts",
  "packages/core/src/gateway-lock.test.ts",
  "packages/core/src/atomic-write.test.ts",
  "packages/core/src/encrypted-artifact-publication.test.ts",
  "packages/core/src/encrypted-artifact.test.ts",
  "packages/core/src/atomic-write.windows.test.ts",
  "packages/core/src/worker-entry.test.ts",
  "packages/core/src/node-command.test.ts",
  "packages/core/src/npm-command.test.ts",
  "packages/core/src/windows-job.test.ts",
  "packages/platform/src/windows-job-stream.test.ts",
  "packages/platform/src/windows-worker-cache.test.ts",
  "packages/platform/src/windows-powershell.test.ts",
  "packages/platform/src/windows-process.test.ts",
  "packages/platform/src/windows-process.windows.test.ts",
  "packages/platform/src/windows-regular-file.test.ts",
  "packages/platform/src/windows-regular-file.windows.test.ts",
  "packages/platform/src/windows-worker-cache.windows.test.ts",
  "packages/core/src/windows-private-file.test.ts",
  "packages/platform/src/windows-private-file-protocol.test.ts",
  "packages/platform/src/windows-private-copy.windows.test.ts",
  "packages/core/src/windows-private-stream.test.ts",
  "packages/core/src/secret-store-files.test.ts",
  "packages/core/src/secret-store.windows.test.ts",
  "packages/core/src/config-secrets.windows.test.ts",
  "packages/core/src/secret-file.windows.test.ts",
  "packages/core/src/doctor/windows-permissions.test.ts",
  "packages/core/src/doctor/windows-permissions.windows.test.ts",
  "packages/core/src/private-scratch.test.ts",
  "packages/core/src/sqlite-snapshot-windows-retry.test.ts",
  "packages/core/src/private-scratch.windows.test.ts",
  "packages/core/src/parent-shutdown.test.ts",
  "packages/core/src/windows-process-tree.test.ts",
  "packages/core/src/child-termination.test.ts",
  "packages/agent-integration/src/credentials.test.ts",
  "packages/agent-integration/src/hermes-windows-bridge.test.ts",
  "packages/agent/src/codex-private-state.windows.test.ts",
  "packages/cli/src/harness-restart.windows.test.ts",
  "packages/agent-integration/src/credentials.windows.test.ts",
  "packages/agent-integration/src/windows-files.test.ts",
  "packages/config/src/load-dotenv.test.ts",
  "packages/config/src/dotenv-bootstrap.test.ts",
  "packages/source-sdk/src/path-probe-node.test.ts",
  "packages/source-sdk/src/testing/file-permissions.test.ts",
  "packages/source-sdk/src/node-path-boundary.test.ts",
  "packages/source-sdk/src/node-path-boundary-aliases.test.ts",
  "packages/source-sdk/src/local-agent-sessions.test.ts",
  "packages/collector/src/e2e/gateway-env.test.ts",
  "packages/collector/src/e2e/subprocess-reaper.test.ts",
  "packages/collector/src/e2e/enrollment-browser-fixture.test.ts",
  "packages/collector/src/e2e/enrollment-terminal-fixture.test.ts",
  "packages/collector/src/file-watcher-manager.test.ts",
  "packages/collector/src/self-update.windows.test.ts",
  "packages/collector/src/source-descriptors.test.ts",
  "packages/gateway-client/src",
  "packages/gateway/src/process-launcher/process-launcher.test.ts",
  "packages/gateway/src/widget-renderers.test.ts",
  "packages/gateway/src/ocr/tesseract-ocr.test.ts",
  "packages/gateway/src/ocr/gguf-ocr.test.ts",
  "packages/gateway/src/indexer/usearch-index.test.ts",
  "packages/gateway/src/indexer/usearch-boot-guard.test.ts",
  "packages/gateway/src/indexer/embedder-scheduling.test.ts",
  "packages/gateway/src/search/generation-gate.test.ts",
  "packages/gateway/src/indexer/usearch-read-registry.test.ts",
  "packages/gateway/src/indexer/usearch-sidecar-integration.test.ts",
  "scripts/ci/build-windows-usearch.test.mjs",
  "scripts/ci/probe-windows-usearch.test.mjs",
  "packages/agent/src/claude-code-backend.test.ts",
  "packages/cli/src/unknown-flags.test.ts",
  "packages/cli/src/commands/status-no-token.test.ts",
  "packages/cli/src/commands/openclaw-capability-consent.test.ts",
  "packages/cli/src/commands/openclaw-install-record.test.ts",
  "scripts/nx/entrypoints.test.mjs",
  "scripts/ci/source-line-endings.test.mjs",
  "packages/providers/apple/src/imessage-transcript-storage.test.ts",
  "packages/providers/apple/src/imessage-transcript-durability.test.ts",
  "packages/providers/telegram/src/protected-store.test.ts",
  "packages/providers/telegram/src/message-store.test.ts",
  "packages/providers/whatsapp/src/message-store.test.ts",
  "packages/cli/src/credentials-wizard.test.ts",
  "packages/cli/src/load-env.test.ts",
  "packages/cli/src/commands/devices.test.ts",
  "packages/cli/src/commands/push.test.ts",
  "packages/cli/src/commands/push-setup.test.ts",
  "packages/cli/src/commands/config-target.test.ts",
  "packages/cli/src/service/exec-resolver.test.ts",
  "packages/cli/src/service/hardened.test.ts",
  "packages/cli/src/service/supervisor.test.ts",
  "packages/cli/src/service/unit-audit.test.ts",
  "packages/cli/src/update/service-definitions.test.ts",
  "packages/cli/src/uninstall/keyring-purge.test.ts",
  "packages/cli/src/update/build-tools.test.ts",
  "packages/cli/src/update/continuation.test.ts",
  "packages/cli/src/update/node-gyp-headers.test.ts",
  "packages/providers/obsidian",
  "packages/providers/maildir",
  "packages/providers-synth/maildir",
  "packages/providers/local-files",
  "packages/providers/browser-history/src/paths.test.ts",
  "packages/providers/browser-history/src/arc-windows.test.ts",
  "packages/cloud-relay/src/account-authority-key.test.ts",
  "packages/cloud-relay/src/gateway-binding.test.ts",
  "extension/scripts/panel-template.test.mjs",
  "packages/cloud-relay/src/recovery-artifact-paths.test.ts",
  "packages/cloud-relay/src/proxy-protocol.test.ts",
  "packages/cloud-relay/src/proxy-protocol-relay.test.ts",
  "packages/cloud-relay/src/cdn-front-relay.test.ts",
];

export const FOCUSED_E2E_FILES = [
  "packages/collector/src/e2e/gateway-lifecycle.e2e.test.ts",
  "packages/collector/src/e2e/synth-pipeline.e2e.test.ts",
  "packages/collector/src/e2e/source-descriptors.e2e.test.ts",
];

/** Optional manual diagnosis uses literal, existing repository E2E files only. */
export function windowsE2EFiles(text, exists = existsSync) {
  if (text === "") return [];
  let files;
  try {
    files = JSON.parse(text);
  } catch {
    throw new Error("Windows E2E files must be a JSON array of repository paths");
  }
  if (!Array.isArray(files) || files.length < 1 || files.length > 16)
    throw new Error("Select between one and sixteen Windows E2E files");
  const selected = new Set();
  for (const file of files) {
    if (
      typeof file !== "string" ||
      !/^packages\/[a-zA-Z0-9._/-]+\.e2e\.test\.ts$/u.test(file) ||
      file.split("/").some((part) => part === "" || part === "." || part === "..") ||
      !exists(file) ||
      selected.has(file)
    )
      throw new Error("Select distinct existing repository E2E test files");
    selected.add(file);
  }
  return [...selected];
}

/** Every entry is argv for Node, never a command interpreted by a shell. */
export function windowsCheckTasks(lane, shard, files = []) {
  if (files.length && (lane !== "e2e" || shard !== undefined))
    throw new Error("Selected Windows E2E files require the unsharded E2E lane");
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
      return [["scripts/run-check.mjs", "e2e", ...files, ...(shard ? [`--shard=${shard}`] : [])]];
    case "portal":
      return [["scripts/run-check.mjs", "portal"]];
    default:
      throw new Error("Expected Windows lane: focused, unit, e2e, portal");
  }
}

/** Independent suites still run after a failure, and the first failure remains the verdict. */
export async function runWindowsCheckTasks(tasks) {
  let exitCode = 0;
  for (const task of tasks) {
    const code = await waitForChild(
      spawn(process.execPath, task, {
        stdio: "inherit",
        env: process.env,
        detached: process.platform !== "win32",
      }),
    );
    if (code !== 0 && exitCode === 0) exitCode = code;
  }
  return exitCode;
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
  const files = windowsE2EFiles(process.env.OMNESIS_WINDOWS_E2E_FILES ?? "");
  const tasks = windowsCheckTasks(lane, shard, files);
  if (options.includes("--list")) {
    process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
    return 0;
  }
  return runWindowsCheckTasks(tasks);
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
