// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  portalFleetUpdateCapability,
  ServiceManagerPortalFleetUpdateLauncher,
} from "./portal-fleet-update-launcher.js";
import type { ReleaseCheckSnapshot } from "@omnesis/core/release-check";

const RELEASE: ReleaseCheckSnapshot = {
  currentVersion: "1.4.0",
  latestVersion: "1.5.0",
  installMethod: "source",
  checkedAt: "2026-09-16T12:00:00.000Z",
  updateAvailable: true,
};

type SpawnAndWait = (
  command: string,
  args: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

describe("portalFleetUpdateCapability", () => {
  test.each(["source", "npm-global"] as const)(
    "enables %s installs under generated unnamed systemd user services",
    (installMethod) => {
      expect(
        portalFleetUpdateCapability(
          { ...RELEASE, installMethod },
          "linux",
          {
            OMNESIS_SERVICE_MANAGER: "systemd-user",
            INVOCATION_ID: "service-invocation",
          },
          { linuxCgroup: "0::/user.slice/app.slice/omnesis-gateway.service" },
        ),
      ).toEqual({ supported: true });
    },
  );

  test.each(["source", "npm-global"] as const)(
    "enables %s installs under generated unnamed LaunchAgents",
    (installMethod) => {
      expect(
        portalFleetUpdateCapability(
          { ...RELEASE, installMethod },
          "darwin",
          {
            OMNESIS_SERVICE_MANAGER: "launchd-user",
          },
          { launchdService: { label: "dev.omnesis.gateway", pid: 42 }, pid: 42 },
        ),
      ).toEqual({ supported: true });
    },
  );

  test.each([
    ["docker", "Container gateways"],
    ["named", "Named gateway instances"],
    ["manual", "not running as an Omnesis user service"],
  ])("refuses %s topologies with a terminal fallback", (kind, expected) => {
    const release = kind === "docker" ? { ...RELEASE, installMethod: "docker" as const } : RELEASE;
    const env =
      kind === "named"
        ? {
            OMNESIS_SERVICE_MANAGER: "systemd-user",
            OMNESIS_SERVICE_INSTANCE: "staging",
            INVOCATION_ID: "service-invocation",
          }
        : {};
    const result = portalFleetUpdateCapability(release, "linux", env);
    expect(result.supported).toBe(false);
    expect(result.unsupportedReason).toContain(expected);
    expect(result.unsupportedReason).toContain("omnesis update --fleet");
  });

  test("does not trust forgeable service-manager markers without process provenance", () => {
    expect(
      portalFleetUpdateCapability(RELEASE, "linux", {
        OMNESIS_SERVICE_MANAGER: "systemd-user",
        INVOCATION_ID: "forged",
      }),
    ).toMatchObject({ supported: false });
    expect(
      portalFleetUpdateCapability(
        RELEASE,
        "darwin",
        { OMNESIS_SERVICE_MANAGER: "launchd-user" },
        { launchdService: { label: "dev.omnesis.gateway", pid: 41 }, pid: 42 },
      ),
    ).toMatchObject({ supported: false });
  });

  test("refuses a passphrase backend that has only an inline secret", () => {
    const service = {
      OMNESIS_SERVICE_MANAGER: "systemd-user",
      INVOCATION_ID: "service-invocation",
      OMNESIS_SECRET_STORE: "passphrase",
      OMNESIS_KEYRING_PASSPHRASE: "must-not-cross-the-boundary",
    };
    const evidence = { linuxCgroup: "0::/user.slice/app.slice/omnesis-gateway.service" };

    expect(portalFleetUpdateCapability(RELEASE, "linux", service, evidence)).toMatchObject({
      supported: false,
      unsupportedReason: expect.stringContaining("current process"),
    });
    expect(
      portalFleetUpdateCapability(
        RELEASE,
        "linux",
        { ...service, OMNESIS_KEYRING_PASSPHRASE_FILE: "/cfg/keyring.pass" },
        evidence,
      ),
    ).toEqual({ supported: true });
    expect(
      portalFleetUpdateCapability(
        RELEASE,
        "linux",
        { ...service, CREDENTIALS_DIRECTORY: "/run/user/501/credentials/service" },
        evidence,
      ),
    ).toEqual({ supported: true });
  });
});

describe("ServiceManagerPortalFleetUpdateLauncher", () => {
  test("submits a fixed systemd runner with no target or browser-controlled argv", async () => {
    const spawnAndWait = vi.fn<SpawnAndWait>(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    const launcher = new ServiceManagerPortalFleetUpdateLauncher({
      platform: "linux",
      env: {
        HOME: "/home/maya",
        PATH: "/opt/node/bin:/usr/bin",
        NODE_OPTIONS: "--require=/tmp/attacker.js",
        NODE_EXTRA_CA_CERTS: "/tmp/outside.pem",
        OMNESIS_CONFIG_DIR: "/cfg",
        OMNESIS_ADMIN_TOKEN: "must-not-leak",
        OMNESIS_SECRET_STORE: "passphrase",
        OMNESIS_KEYRING_PASSPHRASE: "must-not-leak-passphrase",
        OMNESIS_KEYRING_PASSPHRASE_FILE: "/cfg/keyring.pass",
        CREDENTIALS_DIRECTORY: "/run/user/501/credentials/omnesis-gateway.service",
      },
      execPath: "/opt/node/bin/node",
      execArgv: [],
      cliEntry: "/opt/omnesis/dist/index.js",
      spawnAndWait,
    });

    await launcher.launch({
      operationId: "123e4567-e89b-42d3-a456-426614174000",
      configDir: "/cfg",
    });

    const [command, args] = spawnAndWait.mock.calls[0]!;
    expect(command).toBe("/usr/bin/systemd-run");
    expect(args).toContain("--no-block");
    expect(args).toContain("--setenv=HOME=/home/maya");
    expect(args).toContain("--setenv=OMNESIS_SECRET_STORE=passphrase");
    expect(args).toContain("--setenv=OMNESIS_KEYRING_PASSPHRASE_FILE=/cfg/keyring.pass");
    expect(args).toContain(
      "--setenv=CREDENTIALS_DIRECTORY=/run/user/501/credentials/omnesis-gateway.service",
    );
    expect(args.join(" ")).not.toContain("must-not-leak");
    expect(args.join(" ")).not.toContain("NODE_OPTIONS");
    expect(args.join(" ")).not.toContain("outside.pem");
    expect(args.slice(-5)).toEqual([
      "/opt/node/bin/node",
      "/opt/omnesis/dist/index.js",
      "_portal-fleet-update-run",
      "--operation-id=123e4567-e89b-42d3-a456-426614174000",
      "--config-dir=/cfg",
    ]);
    expect(args).not.toContain(expect.stringContaining("target-version"));
  });

  test("preserves the trusted tsx loader arguments for a source checkout", async () => {
    const spawnAndWait = vi.fn<SpawnAndWait>(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    const launcher = new ServiceManagerPortalFleetUpdateLauncher({
      platform: "linux",
      execPath: "/usr/bin/node",
      execArgv: ["--require", "/repo/node_modules/tsx/preflight.cjs", "--import", "tsx/loader.mjs"],
      cliEntry: "/repo/packages/cli/src/index.ts",
      spawnAndWait,
    });

    await launcher.launch({
      operationId: "123e4567-e89b-42d3-a456-426614174000",
      configDir: "/cfg",
    });

    expect(spawnAndWait.mock.calls[0]![1].slice(-9)).toEqual([
      "/usr/bin/node",
      "--require",
      "/repo/node_modules/tsx/preflight.cjs",
      "--import",
      "tsx/loader.mjs",
      "/repo/packages/cli/src/index.ts",
      "_portal-fleet-update-run",
      "--operation-id=123e4567-e89b-42d3-a456-426614174000",
      "--config-dir=/cfg",
    ]);
  });

  test("submits a launchd-owned job on macOS", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-portal-launcher-"));
    const spawnAndWait = vi.fn<SpawnAndWait>(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    const launcher = new ServiceManagerPortalFleetUpdateLauncher({
      platform: "darwin",
      env: { PATH: "/tmp/fictional-bin:/usr/bin" },
      execPath: "/opt/node/bin/node",
      execArgv: [],
      cliEntry: "/opt/omnesis/dist/index.js",
      spawnAndWait,
      launchdService: { label: "dev.omnesis.gateway", pid: 42 },
      pid: 42,
      uid: 501,
    });
    await launcher.launch({
      operationId: "123e4567-e89b-42d3-a456-426614174000",
      configDir,
    });
    const label = "dev.omnesis.portal-update.123e4567-e89b-42d3-a456-426614174000";
    expect(spawnAndWait).toHaveBeenNthCalledWith(
      1,
      "/bin/launchctl",
      expect.arrayContaining(["bootstrap"]),
    );
    expect(spawnAndWait).toHaveBeenNthCalledWith(2, "/bin/launchctl", [
      "kickstart",
      `gui/501/${label}`,
    ]);

    const plistPath = join(configDir, "portal-updates", "launchd", `${label}.plist`);
    expect(existsSync(plistPath)).toBe(true);
    await launcher.cleanup({
      operationId: "123e4567-e89b-42d3-a456-426614174000",
      configDir,
    });
    expect(spawnAndWait).toHaveBeenLastCalledWith("/bin/launchctl", [
      "bootout",
      `gui/501/${label}`,
    ]);
    expect(existsSync(plistPath)).toBe(false);
  });

  test("removes a launchd job that cannot be kickstarted", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-portal-kickstart-"));
    const spawnAndWait = vi
      .fn<SpawnAndWait>()
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 5, stdout: "", stderr: "not allowed" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const launcher = new ServiceManagerPortalFleetUpdateLauncher({
      platform: "darwin",
      execPath: "/opt/node/bin/node",
      execArgv: [],
      cliEntry: "/opt/omnesis/dist/index.js",
      spawnAndWait,
      launchdService: { label: "dev.omnesis.gateway", pid: 42 },
      pid: 42,
      uid: 501,
    });
    const spec = {
      operationId: "123e4567-e89b-42d3-a456-426614174000",
      configDir,
    };
    const label = `dev.omnesis.portal-update.${spec.operationId}`;
    const plistPath = join(configDir, "portal-updates", "launchd", `${label}.plist`);

    await expect(launcher.launch(spec)).rejects.toThrow(/not allowed/u);
    expect(spawnAndWait).toHaveBeenNthCalledWith(3, "/bin/launchctl", [
      "bootout",
      `gui/501/${label}`,
    ]);
    expect(existsSync(plistPath)).toBe(false);
  });

  test("only carries an extra CA file contained by the canonical config directory", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-portal-ca-"));
    const certPath = join(configDir, "private-ca.pem");
    writeFileSync(certPath, "fictional certificate");
    const spawnAndWait = vi.fn<SpawnAndWait>(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    const launcher = new ServiceManagerPortalFleetUpdateLauncher({
      platform: "linux",
      env: { NODE_EXTRA_CA_CERTS: certPath },
      execPath: "/opt/node/bin/node",
      execArgv: [],
      cliEntry: "/opt/omnesis/dist/index.js",
      spawnAndWait,
    });
    await launcher.launch({
      operationId: "123e4567-e89b-42d3-a456-426614174000",
      configDir,
    });
    expect(spawnAndWait.mock.calls[0]![1]).toContain(
      `--setenv=NODE_EXTRA_CA_CERTS=${realpathSync(certPath)}`,
    );
  });

  test("retains a launchd plist when cleanup fails so a later retry can remove it", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-portal-cleanup-"));
    const spawnAndWait = vi
      .fn<SpawnAndWait>()
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 5, stdout: "", stderr: "temporary refusal" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    const launcher = new ServiceManagerPortalFleetUpdateLauncher({
      platform: "darwin",
      execPath: "/opt/node/bin/node",
      execArgv: [],
      cliEntry: "/opt/omnesis/dist/index.js",
      spawnAndWait,
      launchdService: { label: "dev.omnesis.gateway", pid: 42 },
      pid: 42,
      uid: 501,
    });
    const spec = {
      operationId: "123e4567-e89b-42d3-a456-426614174000",
      configDir,
    };
    const plistPath = join(
      configDir,
      "portal-updates",
      "launchd",
      `dev.omnesis.portal-update.${spec.operationId}.plist`,
    );
    await launcher.launch(spec);

    await expect(launcher.cleanup(spec)).rejects.toThrow(/temporary refusal/u);
    expect(existsSync(plistPath)).toBe(true);
    await expect(launcher.cleanup(spec)).resolves.toBeUndefined();
    expect(existsSync(plistPath)).toBe(false);
  });
});
