// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/** Hermetic recording seam for the spawned gateway fleet-update E2E. */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { atomicWriteFileSync } from "@omnesis/core";
import { readPortalFleetUpdateOperation } from "@omnesis/core/portal-fleet-update";
import { isStableReleaseVersion, type ReleaseCheckSnapshot } from "@omnesis/core/release-check";
import type { PortalFleetUpdateLauncher } from "./portal-fleet-update-launcher.js";

export const PORTAL_FLEET_UPDATE_E2E_LAUNCH_FILE = "portal-updates/e2e-launch.json";

export interface PortalFleetUpdateE2EFixture {
  release: ReleaseCheckSnapshot;
  launcher: PortalFleetUpdateLauncher;
}

function priorStableVersion(version: string): string | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.0`;
  if (major > 0) return `${major - 1}.0.0`;
  return null;
}

/** Enabled only inside an explicitly synthetic, release-check-disabled E2E gateway. */
export function portalFleetUpdateE2EFixture(input: {
  env: NodeJS.ProcessEnv;
  configDir: string;
  gatewayVersion: string;
}): PortalFleetUpdateE2EFixture | null {
  if (
    input.env.OMNESIS_SYNTHETIC !== "1" ||
    input.env.OMNESIS_E2E_DISABLE_RELEASE_CHECK !== "1" ||
    input.env.OMNESIS_E2E_PORTAL_FLEET_UPDATE !== "1"
  ) {
    return null;
  }
  if (!isStableReleaseVersion(input.gatewayVersion)) return null;
  const cliEntry = input.env.OMNESIS_E2E_PORTAL_FLEET_UPDATE_CLI_ENTRY;
  const gatewayPort = input.env.OMNESIS_GATEWAY_PORT;
  if (!cliEntry || !isAbsolute(cliEntry) || !gatewayPort) return null;
  const currentVersion = priorStableVersion(input.gatewayVersion);
  if (!currentVersion) return null;

  const release: ReleaseCheckSnapshot = {
    currentVersion,
    latestVersion: input.gatewayVersion,
    installMethod: "source",
    checkedAt: "2026-09-16T12:00:00.000Z",
    updateAvailable: true,
  };
  const launcher: PortalFleetUpdateLauncher = {
    capability: () => ({ supported: true }),
    async launch(spec) {
      const operation = readPortalFleetUpdateOperation(spec.configDir);
      if (!operation || operation.id !== spec.operationId) {
        throw new Error("recording launcher did not find its durable operation");
      }
      atomicWriteFileSync(
        join(spec.configDir, PORTAL_FLEET_UPDATE_E2E_LAUNCH_FILE),
        `${JSON.stringify({ operation }, null, 2)}\n`,
        { ensureDir: true, mode: 0o600 },
      );
      const token = readFileSync(join(spec.configDir, "token"), "utf8").trim();
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            ...process.execArgv,
            cliEntry,
            "_portal-fleet-update-run",
            `--operation-id=${spec.operationId}`,
            `--config-dir=${spec.configDir}`,
          ],
          {
            detached: true,
            stdio: "ignore",
            env: {
              ...process.env,
              OMNESIS_CONFIG_DIR: spec.configDir,
              OMNESIS_GATEWAY_URL: `https://localhost:${gatewayPort}`,
              OMNESIS_TOKEN: token,
              NODE_TLS_REJECT_UNAUTHORIZED: "0",
            },
          },
        );
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
  };
  return { release, launcher };
}
