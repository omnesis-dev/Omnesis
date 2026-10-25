// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Everything `omnesis uninstall` reaches outside its own process through:
 * the platform, the home directory, child processes, the service manager and
 * the secret store. Tests build a context over a temporary home and a scripted
 * command runner; the real one is `defaultUninstallContext()`.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import {
  liveGatewayHolder,
  type CreateSecretStoreOptions,
  type GatewayLockHolder,
} from "@omnesis/core";
import {
  defaultExecRunner,
  defaultStreamRunner,
  LaunchdSupervisor,
  SystemdSupervisor,
  type ExecResult,
  type Supervisor,
} from "../service/supervisor.js";

export interface RunOptions {
  cwd?: string;
  /** Variables layered over this process's environment. */
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Run a command to completion, capturing output; never throws. Code 127: it could not start. */
export type CommandRunner = (cmd: string, args: string[], opts?: RunOptions) => Promise<ExecResult>;

export interface UninstallContext {
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  uid: number;
  isRoot: boolean;
  /** A terminal is attached, so a prompt (sudo's included) can be answered. */
  interactive: boolean;
  run: CommandRunner;
  /** Run with the terminal attached, for a command that may prompt (sudo). */
  runInteractive(cmd: string, args: string[]): Promise<number>;
  supervisor(): Supervisor;
  gatewayHolder(configDir: string): GatewayLockHolder | null;
  /** How the secret store holding `configDir`'s keys is opened. */
  secretStoreOptions(configDir: string): CreateSecretStoreOptions;
  /** The CLI is the Docker install's own, running inside its container. */
  inContainer: boolean;
  /** Prefix for root-owned paths that are only looked at (a hardened install); "" outside tests. */
  systemRoot: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export const defaultCommandRunner: CommandRunner = (cmd, args, opts = {}) =>
  new Promise((resolveResult) => {
    execFile(
      cmd,
      args,
      {
        encoding: "utf8",
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolveResult({ code: 0, stdout, stderr });
          return;
        }
        const rawCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
        const code = typeof rawCode === "number" ? rawCode : 127;
        resolveResult({ code, stdout: stdout ?? "", stderr: stderr || err.message });
      },
    );
  });

export function defaultUninstallContext(): UninstallContext {
  const platform = process.platform;
  const home = homedir();
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  let supervisor: Supervisor | null = null;
  return {
    platform,
    home,
    env: process.env,
    uid,
    isRoot: uid === 0,
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    run: defaultCommandRunner,
    runInteractive: (cmd, args) =>
      new Promise((resolveCode) => {
        const child = spawn(cmd, args, { stdio: "inherit" });
        child.on("error", () => resolveCode(127));
        child.on("exit", (code) => resolveCode(code ?? 1));
      }),
    supervisor() {
      supervisor ??=
        platform === "darwin"
          ? new LaunchdSupervisor({
              exec: defaultExecRunner,
              stream: defaultStreamRunner,
              home,
              uid,
            })
          : new SystemdSupervisor({
              exec: defaultExecRunner,
              stream: defaultStreamRunner,
              home,
              username: userInfo().username,
            });
      return supervisor;
    },
    gatewayHolder: liveGatewayHolder,
    secretStoreOptions: (configDir) => ({ configDir }),
    inContainer: isDockerInstallImage(fileURLToPath(import.meta.url)),
    systemRoot: "",
  };
}

/**
 * Whether the CLI at `modulePath` is the one the Omnesis image carries: in a
 * Docker container, under the image's `/app` (see the Dockerfile). Any other
 * container — systemd in Docker, a dev container, a CI image — is a host like
 * any other, whose installs `omnesis uninstall` removes.
 */
export function isDockerInstallImage(
  modulePath: string,
  dockerEnv = existsSync("/.dockerenv"),
): boolean {
  return dockerEnv && modulePath.startsWith("/app/packages/cli/");
}
