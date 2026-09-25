// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Escape the gateway service's filesystem sandbox before updating its host.
 *
 * The launched process contains no update policy. It receives only the id of
 * an owner-only operation record and its config directory; the hidden CLI
 * runner reads the exact target from that record before invoking the normal
 * updater. Linux uses a transient user-systemd unit and macOS uses a submitted
 * launchd job, so stopping the gateway cannot stop its updater with it.
 */

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { atomicWriteFileSync, KEYRING_ENV_KEYS, PASSPHRASE_ENV } from "@omnesis/core";
import type { ReleaseCheckSnapshot } from "@omnesis/core/release-check";

export interface PortalFleetUpdateCapability {
  supported: boolean;
  unsupportedReason?: string;
}

export interface PortalFleetUpdateLaunchSpec {
  operationId: string;
  configDir: string;
}

export interface PortalFleetUpdateLauncher {
  capability(
    release: ReleaseCheckSnapshot | null,
    options?: { allowCurrentTarget?: boolean },
  ): PortalFleetUpdateCapability;
  launch(spec: PortalFleetUpdateLaunchSpec): Promise<void>;
  cleanup?(spec: PortalFleetUpdateLaunchSpec): Promise<void>;
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ServiceManagerPortalFleetUpdateLauncherOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  execArgv?: readonly string[];
  cliEntry?: string;
  spawnAndWait?: (command: string, args: string[]) => Promise<SpawnResult>;
  linuxCgroup?: string;
  launchdService?: { label: string; pid: number } | null;
  uid?: number;
  pid?: number;
}

const SECRET_ENV = /(TOKEN|SECRET|PASSWORD|_KEY)$|PASSPHRASE(?!_FILE)/u;
const MAX_LAUNCH_DETAIL = 2_000;

function unsupported(reason: string): PortalFleetUpdateCapability {
  return { supported: false, unsupportedReason: reason };
}

/** Pure support verdict shown before the portal enables the action. */
export function portalFleetUpdateCapability(
  release: ReleaseCheckSnapshot | null,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  evidence: {
    linuxCgroup?: string;
    launchdService?: { label: string; pid: number } | null;
    pid?: number;
  } = {},
  options: { allowCurrentTarget?: boolean } = {},
): PortalFleetUpdateCapability {
  if (!release || (!release.updateAvailable && !options.allowCurrentTarget)) {
    return unsupported("No newer stable release is available from a successful release check.");
  }
  if (release.installMethod === "docker") {
    return unsupported(
      "Container gateways must be updated from the host with `omnesis update --fleet`.",
    );
  }
  if (env.OMNESIS_SERVICE_INSTANCE?.trim()) {
    return unsupported(
      "Named gateway instances must be updated on their host with `omnesis update --fleet`.",
    );
  }
  if (
    env.OMNESIS_SECRET_STORE === "passphrase" &&
    !env.OMNESIS_KEYRING_PASSPHRASE_FILE?.trim() &&
    !env.CREDENTIALS_DIRECTORY?.trim()
  ) {
    return unsupported(
      "This gateway's keyring is available only to its current process. Run `omnesis update --fleet` on its host.",
    );
  }
  if (platform === "linux") {
    const defaultUnit = evidence.linuxCgroup
      ?.split("\n")
      .some((line) => line.trim().endsWith("/omnesis-gateway.service"));
    if (env.OMNESIS_SERVICE_MANAGER !== "systemd-user" || !env.INVOCATION_ID || !defaultUnit) {
      return unsupported(
        "This gateway is not running as an Omnesis user service. Run `omnesis update --fleet` on its host.",
      );
    }
    return { supported: true };
  }
  if (platform === "darwin") {
    const service = evidence.launchdService;
    if (
      env.OMNESIS_SERVICE_MANAGER !== "launchd-user" ||
      service?.label !== "dev.omnesis.gateway" ||
      service.pid !== (evidence.pid ?? process.pid)
    ) {
      return unsupported(
        "This gateway is not running as an Omnesis LaunchAgent. Run `omnesis update --fleet` on its host.",
      );
    }
    return { supported: true };
  }
  return unsupported(
    `Portal-driven host updates are not supported on ${platform}; run \`omnesis update --fleet\` on the gateway host.`,
  );
}

function safeEnvironment(env: NodeJS.ProcessEnv, configDir: string): string[] {
  // The updater must open this installation's sealed admin token so it can
  // take its mandatory pre-update backup. Carry only keyring backend/path
  // locators; the direct passphrase remains forbidden at this boundary.
  const carried = new Set([
    "HOME",
    "PATH",
    "LANG",
    ...KEYRING_ENV_KEYS.filter((name) => name !== PASSPHRASE_ENV),
  ]);
  const pairs = ["NO_COLOR=1"];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || /[\r\n]/u.test(value) || SECRET_ENV.test(name)) continue;
    if (!carried.has(name)) continue;
    pairs.push(`${name}=${value}`);
  }
  const extraCa = env.NODE_EXTRA_CA_CERTS;
  if (extraCa && isAbsolute(extraCa) && !/[\r\n]/u.test(extraCa)) {
    try {
      const canonicalConfig = realpathSync(configDir);
      const canonicalCert = realpathSync(extraCa);
      const certRelative = relative(canonicalConfig, canonicalCert);
      if (
        certRelative !== "" &&
        !certRelative.startsWith("..") &&
        !isAbsolute(certRelative) &&
        statSync(canonicalCert).isFile()
      ) {
        pairs.push(`NODE_EXTRA_CA_CERTS=${canonicalCert}`);
      }
    } catch {
      // A missing or out-of-tree CA path is not safe to propagate across the
      // service-manager boundary. The updater will use the configured default.
    }
  }
  return pairs;
}

function launchdIdentity(uid: number): { label: string; pid: number } | null {
  const result = spawnSync("/bin/launchctl", ["print", `gui/${uid}/dev.omnesis.gateway`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const pid = /^\s*pid\s*=\s*(\d+)\s*$/mu.exec(result.stdout)?.[1];
  return pid ? { label: "dev.omnesis.gateway", pid: Number(pid) } : null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function launchdPlist(label: string, args: readonly string[], env: Record<string, string>): string {
  const argumentsXml = args.map((arg) => `      <string>${escapeXml(arg)}</string>`).join("\n");
  const environmentXml = Object.entries(env)
    .map(
      ([key, value]) =>
        `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>Umask</key>
    <integer>63</integer>
    <key>EnvironmentVariables</key>
    <dict>
${environmentXml}
    </dict>
  </dict>
</plist>
`;
}

function defaultSpawnAndWait(command: string, args: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = `${stdout}${chunk}`.slice(-MAX_LAUNCH_DETAIL);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_LAUNCH_DETAIL);
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export class ServiceManagerPortalFleetUpdateLauncher implements PortalFleetUpdateLauncher {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cliCommand: string[] | null;
  private readonly spawnAndWait: (command: string, args: string[]) => Promise<SpawnResult>;
  private readonly linuxCgroup?: string;
  private readonly launchdService: { label: string; pid: number } | null;
  private readonly uid: number;
  private readonly pid: number;

  constructor(options: ServiceManagerPortalFleetUpdateLauncherOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    const cliEntry = options.cliEntry ?? process.argv[1] ?? "";
    this.cliCommand = cliEntry
      ? [options.execPath ?? process.execPath, ...(options.execArgv ?? process.execArgv), cliEntry]
      : null;
    this.spawnAndWait = options.spawnAndWait ?? defaultSpawnAndWait;
    this.uid = options.uid ?? process.getuid?.() ?? 0;
    this.pid = options.pid ?? process.pid;
    this.linuxCgroup =
      options.linuxCgroup ??
      (this.platform === "linux"
        ? (() => {
            try {
              return readFileSync("/proc/self/cgroup", "utf8");
            } catch {
              return undefined;
            }
          })()
        : undefined);
    this.launchdService =
      options.launchdService === undefined && this.platform === "darwin"
        ? launchdIdentity(this.uid)
        : (options.launchdService ?? null);
  }

  capability(
    release: ReleaseCheckSnapshot | null,
    options: { allowCurrentTarget?: boolean } = {},
  ): PortalFleetUpdateCapability {
    if (!this.cliCommand) {
      return unsupported(
        "The gateway CLI could not be launched independently. Run `omnesis update --fleet` on its host.",
      );
    }
    return portalFleetUpdateCapability(
      release,
      this.platform,
      this.env,
      {
        linuxCgroup: this.linuxCgroup,
        launchdService: this.launchdService,
        pid: this.pid,
      },
      options,
    );
  }

  async launch(spec: PortalFleetUpdateLaunchSpec): Promise<void> {
    if (!this.cliCommand) {
      throw new Error("the gateway CLI cannot be launched independently");
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        spec.operationId,
      )
    ) {
      throw new Error("invalid portal fleet update operation id");
    }
    const runnerArgs = [
      ...this.cliCommand,
      "_portal-fleet-update-run",
      `--operation-id=${spec.operationId}`,
      `--config-dir=${spec.configDir}`,
    ];
    let command: string;
    let args: string[];
    if (this.platform === "linux") {
      command = "/usr/bin/systemd-run";
      args = [
        "--user",
        "--quiet",
        "--collect",
        "--no-block",
        `--unit=omnesis-portal-update-${spec.operationId}.service`,
        "--property=KillMode=control-group",
        ...safeEnvironment(this.env, spec.configDir).map((pair) => `--setenv=${pair}`),
        `--setenv=OMNESIS_CONFIG_DIR=${spec.configDir}`,
        "--",
        ...runnerArgs,
      ];
    } else if (this.platform === "darwin") {
      const label = `dev.omnesis.portal-update.${spec.operationId}`;
      const launchDir = join(spec.configDir, "portal-updates", "launchd");
      const plistPath = join(launchDir, `${label}.plist`);
      mkdirSync(launchDir, { recursive: true, mode: 0o700 });
      chmodSync(launchDir, 0o700);
      const childEnv = Object.fromEntries(
        safeEnvironment(this.env, spec.configDir)
          .filter((pair) => pair !== "NO_COLOR=1")
          .map((pair) => {
            const separator = pair.indexOf("=");
            return [pair.slice(0, separator), pair.slice(separator + 1)];
          }),
      );
      childEnv.NO_COLOR = "1";
      childEnv.OMNESIS_CONFIG_DIR = spec.configDir;
      atomicWriteFileSync(plistPath, launchdPlist(label, runnerArgs, childEnv), { mode: 0o600 });
      command = "/bin/launchctl";
      const domain = `gui/${this.uid}`;
      const bootstrapped = await this.spawnAndWait(command, ["bootstrap", domain, plistPath]);
      if (bootstrapped.code !== 0) {
        rmSync(plistPath, { force: true });
        const detail = (bootstrapped.stderr || bootstrapped.stdout)
          .trim()
          .slice(-MAX_LAUNCH_DETAIL);
        throw new Error(`launchctl refused the update launcher${detail ? `: ${detail}` : ""}`);
      }
      // RunAtLoad may remain pending when launchd is reached over SSH rather
      // than from an active GUI session. Explicit kickstart makes acceptance
      // mean the independent updater was actually asked to run.
      const kicked = await this.spawnAndWait(command, ["kickstart", `${domain}/${label}`]);
      if (kicked.code !== 0) {
        await this.spawnAndWait(command, ["bootout", `${domain}/${label}`]).catch(() => undefined);
        rmSync(plistPath, { force: true });
        const detail = (kicked.stderr || kicked.stdout).trim().slice(-MAX_LAUNCH_DETAIL);
        throw new Error(
          `launchctl refused to start the update launcher${detail ? `: ${detail}` : ""}`,
        );
      }
      return;
    } else {
      throw new Error(`unsupported service manager on ${this.platform}`);
    }
    const result = await this.spawnAndWait(command, args);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-MAX_LAUNCH_DETAIL);
      throw new Error(`${command} refused the update launcher${detail ? `: ${detail}` : ""}`);
    }
  }

  async cleanup(spec: PortalFleetUpdateLaunchSpec): Promise<void> {
    if (this.platform !== "darwin") return;
    const label = `dev.omnesis.portal-update.${spec.operationId}`;
    const plistPath = join(spec.configDir, "portal-updates", "launchd", `${label}.plist`);
    const result = await this.spawnAndWait("/bin/launchctl", [
      "bootout",
      `gui/${this.uid}/${label}`,
    ]);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(-MAX_LAUNCH_DETAIL);
      if (!/(?:could not find service|no such process|not found)/iu.test(detail)) {
        throw new Error(`launchctl refused updater cleanup${detail ? `: ${detail}` : ""}`);
      }
    }
    rmSync(plistPath, { force: true });
  }
}
