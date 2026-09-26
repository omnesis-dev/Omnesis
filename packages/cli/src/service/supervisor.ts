// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Platform supervision backends for `omnesis service`. Each backend wraps
 * the native service manager behind one `Supervisor` interface:
 *
 *   - macOS  → launchd LaunchAgents (`launchctl bootstrap`/`bootout`/`print`)
 *   - Linux  → systemd user units (`systemctl --user`, `journalctl --user`)
 *
 * All process invocations go through the injected `ExecRunner` / `StreamRunner`
 * seams (plain `execFile`/`spawn`, no shell interpolation) so tests can assert
 * the exact argv without touching the host's service manager.
 */

import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { CliError, EXIT_FAILURE, EXIT_USER_ERROR } from "@omnesis/cli-shared";
import {
  atomicWriteFileSync,
  GATEWAY_EXIT_TIMEOUT_SECONDS,
  liveGatewayHolder,
  type GatewayLockHolder,
} from "@omnesis/core";
import {
  systemdWritablePaths,
  darwinLogsDir,
  generateLaunchdPlist,
  generateSystemdUnit,
  launchdLabel,
  launchdLogPaths,
  launchdPlistPath,
  systemdUnitName,
  systemdUnitPath,
} from "./units.js";
import type { ServiceComponent, ServiceSpec, ServiceState, ServiceStatus } from "./types.js";

// ── Exec seams ─────────────────────────────────────────────────────────

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command to completion, capturing output. Never throws on non-zero exit. */
export type ExecRunner = (cmd: string, args: string[]) => Promise<ExecResult>;

export const defaultExecRunner: ExecRunner = (cmd, args) =>
  new Promise((resolveResult) => {
    execFile(cmd, args, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) {
        resolveResult({ code: 0, stdout, stderr });
        return;
      }
      const rawCode = (err as NodeJS.ErrnoException & { code?: number | string }).code;
      // A string code (e.g. ENOENT) means the spawn itself failed.
      const code = typeof rawCode === "number" ? rawCode : 127;
      resolveResult({ code, stdout: stdout ?? "", stderr: stderr || err.message });
    });
  });

/** Run a command with inherited stdio (log tailing); resolves with the exit code. */
export type StreamRunner = (cmd: string, args: string[]) => Promise<number>;

export const defaultStreamRunner: StreamRunner = (cmd, args) =>
  new Promise((resolveResult, rejectResult) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", rejectResult);
    child.on("exit", (code) => resolveResult(code ?? 0));
  });

// ── Supervisor contract ────────────────────────────────────────────────

export interface InstallOptions {
  /** systemd only: unit this one should order after (collector → gateway). */
  afterUnit?: string;
}

export interface LogsOptions {
  follow: boolean;
  lines: number;
}

export interface ServiceDefinitionInspection {
  /** Service-manager fragment that supplies the canonical unit definition. */
  fragmentPath: string;
  /** Effective override files layered over that fragment. */
  overridePaths: string[];
  /** Relevant variables inherited from the service manager itself. */
  inheritedEnvironment: string[];
  /** Complete manager environment rendering, used to protect checkout cleanup. */
  inheritedEnvironmentText: string;
}

const MIGRATION_ENVIRONMENT_KEYS = [
  "OMNESIS_CONFIG_DIR",
  "OMNESIS_GATEWAY_PORT",
  "OMNESIS_BIND",
] as const;

export interface Supervisor {
  readonly platform: "darwin" | "linux";
  unitName(component: ServiceComponent, instance?: string): string;
  unitPath(component: ServiceComponent, instance?: string): string;
  isInstalled(component: ServiceComponent, instance?: string): boolean;
  /** Write the unit file, register it with the service manager, and start it. */
  install(spec: ServiceSpec, opts?: InstallOptions): Promise<void>;
  /** Stop, unregister, and remove the unit file. Idempotent. */
  uninstall(component: ServiceComponent, instance?: string): Promise<void>;
  start(component: ServiceComponent, instance?: string): Promise<void>;
  stop(component: ServiceComponent, instance?: string): Promise<void>;
  restart(component: ServiceComponent, instance?: string): Promise<void>;
  /** Re-read the existing unit file and restart it without regenerating it. */
  reload(component: ServiceComponent, instance?: string): Promise<void>;
  /**
   * Have the service manager read the unit file again without touching the
   * running daemon, so its next restart runs under it. False where the
   * manager cannot: launchd reads a plist only when the job is loaded.
   */
  loadDefinition(component: ServiceComponent, instance?: string): Promise<boolean>;
  /** Inspect service-manager layers that are not visible in the unit file. */
  inspectDefinition(
    component: ServiceComponent,
    instance?: string,
  ): Promise<ServiceDefinitionInspection>;
  status(component: ServiceComponent, instance?: string): Promise<ServiceStatus>;
  /** Stream logs for the given components; resolves with the pager's exit code. */
  logs(
    components: ServiceComponent[],
    instance: string | undefined,
    opts: LogsOptions,
  ): Promise<number>;
  /** One-time hint to print after install (e.g. systemd linger), or null. */
  postInstallHint(): Promise<string | null>;
}

/** Pick the backend for the current platform. */
export function createSupervisor(platform: NodeJS.Platform = process.platform): Supervisor {
  if (platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    return new LaunchdSupervisor({
      exec: defaultExecRunner,
      stream: defaultStreamRunner,
      home: homedir(),
      uid,
    });
  }
  if (platform === "linux") {
    return new SystemdSupervisor({
      exec: defaultExecRunner,
      stream: defaultStreamRunner,
      home: homedir(),
      username: userInfo().username,
    });
  }
  throw new CliError(
    `omnesis service is not supported on ${platform} — macOS (launchd) and Linux (systemd) only.`,
    EXIT_USER_ERROR,
  );
}

// ── launchd backend (macOS) ────────────────────────────────────────────

export interface LaunchdDeps {
  exec: ExecRunner;
  stream: StreamRunner;
  home: string;
  uid: number;
  /** Pause between polls of a job that is unloading. Tests substitute a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** How long a stop waits for launchd to report the job gone. */
  stopTimeoutMs?: number;
  /** The live gateway holding a config dir's lock. Tests substitute a fixture. */
  gatewayHolder?: (configDir: string) => GatewayLockHolder | null;
  /** Send a signal to a process. Tests substitute a recorder. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** How long an orphaned gateway gets to shut down before SIGKILL. */
  orphanExitTimeoutMs?: number;
}

/**
 * Longer than the plist's ExitTimeOut: launchd escalates to SIGKILL at that
 * point, so a job that is still registered afterwards is launchd's problem to
 * report, not a daemon that is merely slow.
 */
const LAUNCHD_STOP_TIMEOUT_MS = GATEWAY_EXIT_TIMEOUT_SECONDS * 1000 + 30_000;
const LAUNCHD_POLL_MS = 250;

/** One `<key>` of a plist's EnvironmentVariables, as `generateLaunchdPlist` writes it. */
export function launchdPlistEnvValue(plist: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  if (!match) return null;
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Parse `launchctl print` output into a state + pid. */
export function parseLaunchctlPrint(output: string): { state: ServiceState; pid: number | null } {
  const stateMatch = /^\s*state = (.+)$/m.exec(output);
  const pidMatch = /^\s*pid = (\d+)$/m.exec(output);
  const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;
  if (!stateMatch) return { state: "unknown", pid };
  return { state: stateMatch[1].trim() === "running" ? "running" : "stopped", pid };
}

export class LaunchdSupervisor implements Supervisor {
  readonly platform = "darwin" as const;

  constructor(private readonly deps: LaunchdDeps) {}

  unitName(component: ServiceComponent, instance?: string): string {
    return launchdLabel(component, instance);
  }

  unitPath(component: ServiceComponent, instance?: string): string {
    return launchdPlistPath(this.deps.home, component, instance);
  }

  isInstalled(component: ServiceComponent, instance?: string): boolean {
    return existsSync(this.unitPath(component, instance));
  }

  /** launchctl service target in the user's GUI domain. */
  private target(component: ServiceComponent, instance?: string): string {
    return `gui/${this.deps.uid}/${this.unitName(component, instance)}`;
  }

  async install(spec: ServiceSpec): Promise<void> {
    const path = this.unitPath(spec.component, spec.instance);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    mkdirSync(spec.logsDir, { recursive: true, mode: 0o700 });
    chmodSync(spec.logsDir, 0o700);
    // Durable, not just written: a power cut seconds after an install left this
    // file empty on ext4, and launchd then has a job definition with no content.
    atomicWriteFileSync(path, generateLaunchdPlist(spec), { mode: 0o600 });
    // Reinstall path: unload the previous registration first and let its
    // process finish. The plist cannot be bootstrapped while the old job is
    // still registered, and the old daemon must have released the stores
    // before the new one opens them.
    await this.bootoutAndWait(spec.component, spec.instance);
    await this.bootstrap(spec.component, spec.instance);
    // RunAtLoad is not reliable when bootstrap happens outside a real GUI
    // login context (e.g. over SSH): launchd records the job with a pended
    // "speculative" spawn and never execs it. Kick it explicitly so install
    // always means started.
    await this.kickstart(spec.component, spec.instance);
  }

  async uninstall(component: ServiceComponent, instance?: string): Promise<void> {
    // Idempotent: bootout fails harmlessly when the agent isn't loaded.
    await this.bootoutAndWait(component, instance);
    rmSync(this.unitPath(component, instance), { force: true });
  }

  async start(component: ServiceComponent, instance?: string): Promise<void> {
    this.requireInstalled(component, instance);
    // `kickstart -k` restarts the job's own process. A gateway this job left
    // behind would keep the config dir from whatever it starts.
    await this.stopOrphanedGateway(component, instance);
    // A stopped job is unloaded, so starting it means registering it again.
    if (!(await this.isLoaded(component, instance))) await this.bootstrap(component, instance);
    await this.kickstart(component, instance);
  }

  async restart(component: ServiceComponent, instance?: string): Promise<void> {
    await this.start(component, instance);
  }

  async reload(component: ServiceComponent, instance?: string): Promise<void> {
    this.requireInstalled(component, instance);
    await this.bootoutAndWait(component, instance);
    await this.bootstrap(component, instance);
    await this.kickstart(component, instance);
  }

  loadDefinition(component: ServiceComponent, instance?: string): Promise<boolean> {
    this.requireInstalled(component, instance);
    return Promise.resolve(false);
  }

  /** Whether launchd currently has the job registered (running or not). */
  private async isLoaded(component: ServiceComponent, instance?: string): Promise<boolean> {
    const res = await this.deps.exec("launchctl", ["print", this.target(component, instance)]);
    return res.code === 0;
  }

  private async bootstrap(component: ServiceComponent, instance?: string): Promise<void> {
    const path = this.unitPath(component, instance);
    const res = await this.deps.exec("launchctl", ["bootstrap", `gui/${this.deps.uid}`, path]);
    if (res.code !== 0) {
      throw new CliError(
        `launchctl bootstrap failed (${res.code}): ${res.stderr.trim()}`,
        EXIT_FAILURE,
      );
    }
  }

  /**
   * Unload the job and wait until launchd no longer lists it. `bootout`
   * returns as soon as the request is queued; the job stays registered until
   * its process has exited — the daemon draining, then closing its stores.
   * Returning earlier lets a `bootstrap` collide with the old registration
   * and lets a replacement daemon open stores the old one still holds.
   */
  private async bootoutAndWait(component: ServiceComponent, instance?: string): Promise<void> {
    const target = this.target(component, instance);
    // Fails harmlessly when the job isn't loaded.
    await this.deps.exec("launchctl", ["bootout", target]);
    const timeoutMs = this.deps.stopTimeoutMs ?? LAUNCHD_STOP_TIMEOUT_MS;
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + timeoutMs;
    while (await this.isLoaded(component, instance)) {
      if (Date.now() >= deadline) {
        throw new CliError(
          `${this.unitName(component, instance)} is still running ${Math.round(timeoutMs / 1000)}s after launchctl bootout; inspect it with \`launchctl print ${target}\`.`,
          EXIT_FAILURE,
        );
      }
      await sleep(LAUNCHD_POLL_MS);
    }
    // Unloading the job ends only the processes launchd still tracks for it.
    await this.stopOrphanedGateway(component, instance);
  }

  /**
   * Stop a gateway this job started that launchd no longer tracks.
   *
   * A source install's job runs `tsx`, whose child is the gateway. If tsx dies
   * and the gateway does not, launchd reparents the gateway, counts the job as
   * exited and starts a replacement. The replacement waits on the gateway's
   * config-dir lock, gives up, and is restarted, while the orphan keeps the
   * lock and keeps serving: `kickstart` and `bootout` reach only the job's
   * current process, so a restart — including the one `omnesis update` makes —
   * never reaches the process that is actually serving.
   *
   * The lock holder is stopped only when it is certainly that orphan: it holds
   * this job's config dir, it is not the job's process, launchd is its parent
   * (the launcher that started it is gone), and it carries this job's label in
   * the environment launchd gave it. A gateway someone runs by hand has none of
   * these and is left alone.
   */
  private async stopOrphanedGateway(component: ServiceComponent, instance?: string): Promise<void> {
    if (component !== "gateway") return;
    const configDir = this.configDirOf(component, instance);
    if (configDir === null) return;
    const holderOf = this.deps.gatewayHolder ?? liveGatewayHolder;
    const holder = holderOf(configDir);
    if (holder === null) return;
    const job = await this.deps.exec("launchctl", ["print", this.target(component, instance)]);
    if (job.code === 0 && parseLaunchctlPrint(job.stdout).pid === holder.pid) return;
    const ps = await this.deps.exec("ps", [
      "-E",
      "-ww",
      "-o",
      "ppid=,command=",
      "-p",
      String(holder.pid),
    ]);
    const row = /^\s*(\d+)\s+(.*)$/s.exec(ps.stdout);
    if (ps.code !== 0 || !row || Number(row[1]) !== 1) return;
    const label = `XPC_SERVICE_NAME=${this.unitName(component, instance)}`;
    if (!row[2].split(/\s+/).includes(label)) return;

    const signal = this.deps.signal ?? ((pid, sig) => void process.kill(pid, sig));
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // Gone once the lock no longer names that same process — released on the
    // way out, or left by a process that has exited. The lock's start time
    // keeps a recycled PID from passing for the orphan.
    const gone = (): boolean => holderOf(configDir)?.pid !== holder.pid;
    // The same patience launchd gives the job's own process before SIGKILL.
    const timeoutMs = this.deps.orphanExitTimeoutMs ?? GATEWAY_EXIT_TIMEOUT_SECONDS * 1000;
    const deadline = Date.now() + timeoutMs;
    try {
      signal(holder.pid, "SIGTERM");
    } catch {
      return;
    }
    while (!gone()) {
      if (Date.now() >= deadline) {
        try {
          signal(holder.pid, "SIGKILL");
        } catch {
          return;
        }
        const killDeadline = Date.now() + Math.min(5_000, timeoutMs);
        while (!gone() && Date.now() < killDeadline) await sleep(LAUNCHD_POLL_MS);
        if (gone()) return;
        throw new CliError(
          `A gateway (PID ${holder.pid}) left behind by ${this.unitName(component, instance)} still holds ${configDir} after SIGKILL.`,
          EXIT_FAILURE,
        );
      }
      await sleep(LAUNCHD_POLL_MS);
    }
  }

  /** The config dir the job's plist points the daemon at, or null when unreadable. */
  private configDirOf(component: ServiceComponent, instance?: string): string | null {
    try {
      const plist = readFileSync(this.unitPath(component, instance), "utf8");
      return launchdPlistEnvValue(plist, "OMNESIS_CONFIG_DIR");
    } catch {
      return null;
    }
  }

  async inspectDefinition(
    component: ServiceComponent,
    instance?: string,
  ): Promise<ServiceDefinitionInspection> {
    const environment = await this.deps.exec("launchctl", ["export"]);
    if (environment.code !== 0) {
      throw new CliError(
        `launchctl export failed (${environment.code}): ${environment.stderr.trim()}`,
        EXIT_FAILURE,
      );
    }
    const inheritedEnvironment = MIGRATION_ENVIRONMENT_KEYS.filter((key) =>
      environment.stdout.includes(`${key}=`),
    );
    return {
      fragmentPath: this.unitPath(component, instance),
      overridePaths: [],
      inheritedEnvironment,
      inheritedEnvironmentText: environment.stdout,
    };
  }

  private async kickstart(component: ServiceComponent, instance?: string): Promise<void> {
    this.requireInstalled(component, instance);
    const res = await this.deps.exec("launchctl", [
      "kickstart",
      "-k",
      this.target(component, instance),
    ]);
    if (res.code !== 0) {
      throw new CliError(
        `launchctl kickstart failed (${res.code}): ${res.stderr.trim()}`,
        EXIT_FAILURE,
      );
    }
  }

  async stop(component: ServiceComponent, instance?: string): Promise<void> {
    this.requireInstalled(component, instance);
    // Unload the job rather than signal its process: a signalled job stays
    // registered, and launchd's KeepAlive respawns it after any exit it
    // deems a failure — a SIGTERM that lands before the daemon's handler is
    // installed, or a hand-edited plist whose KeepAlive is unconditional.
    // Stopped has to mean stopped, because offline maintenance (restore,
    // secure) runs against the stores next. The plist stays on disk, so the
    // job returns with `start`, and at the next login.
    await this.bootoutAndWait(component, instance);
  }

  async status(component: ServiceComponent, instance?: string): Promise<ServiceStatus> {
    const unit = this.unitName(component, instance);
    if (!this.isInstalled(component, instance)) {
      return { component, unit, installed: false, state: "not-installed", pid: null };
    }
    const res = await this.deps.exec("launchctl", ["print", this.target(component, instance)]);
    if (res.code !== 0) {
      // Plist on disk but not registered with launchd.
      return { component, unit, installed: true, state: "stopped", pid: null };
    }
    return { component, unit, installed: true, ...parseLaunchctlPrint(res.stdout) };
  }

  async logs(
    components: ServiceComponent[],
    instance: string | undefined,
    opts: LogsOptions,
  ): Promise<number> {
    const logsDir = darwinLogsDir(this.deps.home);
    const files: string[] = [];
    for (const component of components) {
      const { out, err } = launchdLogPaths(logsDir, component, instance);
      for (const file of [out, err]) {
        if (existsSync(file)) files.push(file);
      }
    }
    if (files.length === 0) {
      throw new CliError(`No log files found under ${logsDir}.`, EXIT_USER_ERROR);
    }
    const args = ["-n", String(opts.lines)];
    if (opts.follow) args.push("-f");
    return this.deps.stream("tail", [...args, ...files]);
  }

  postInstallHint(): Promise<string | null> {
    return Promise.resolve(null);
  }

  private requireInstalled(component: ServiceComponent, instance?: string): void {
    if (!this.isInstalled(component, instance)) {
      throw new CliError(
        `${this.unitName(component, instance)} is not installed — run 'omnesis service install ${component}' first.`,
        EXIT_USER_ERROR,
      );
    }
  }
}

// ── systemd backend (Linux) ────────────────────────────────────────────

export interface SystemdDeps {
  exec: ExecRunner;
  stream: StreamRunner;
  home: string;
  username: string;
}

/** Map `systemctl is-active` output to a ServiceState. */
export function mapSystemdActiveState(value: string): ServiceState {
  switch (value) {
    case "active":
    case "reloading":
      return "running";
    case "activating":
      return "starting";
    case "failed":
      return "failed";
    case "inactive":
    case "deactivating":
      return "stopped";
    default:
      return "unknown";
  }
}

export class SystemdSupervisor implements Supervisor {
  readonly platform = "linux" as const;

  constructor(private readonly deps: SystemdDeps) {}

  unitName(component: ServiceComponent, instance?: string): string {
    return systemdUnitName(component, instance);
  }

  unitPath(component: ServiceComponent, instance?: string): string {
    return systemdUnitPath(this.deps.home, component, instance);
  }

  isInstalled(component: ServiceComponent, instance?: string): boolean {
    return existsSync(this.unitPath(component, instance));
  }

  async install(spec: ServiceSpec, opts: InstallOptions = {}): Promise<void> {
    const path = this.unitPath(spec.component, spec.instance);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Every ReadWritePaths entry has to exist before the unit starts: systemd
    // fails the whole namespace when one is missing (226/NAMESPACE), and with
    // Restart=on-failure that becomes a crash loop the operator sees as a
    // gateway that never came up. The launchd path above creates its log
    // directory for the same reason.
    for (const writable of systemdWritablePaths(spec)) {
      mkdirSync(writable, { recursive: true, mode: 0o700 });
    }
    const unitOpts = opts.afterUnit ? { afterUnit: opts.afterUnit } : {};
    // Same as launchd above: an empty unit after a power cut is reported by
    // systemd as masked, and nothing starts at boot.
    atomicWriteFileSync(path, generateSystemdUnit(spec, unitOpts), { mode: 0o600 });
    await this.systemctl(["daemon-reload"]);
    await this.systemctl(["enable", "--now", this.unitName(spec.component, spec.instance)]);
    // A --user unit stops when the last login session ends; on a server that's
    // never. Try to enable lingering so it survives logout/reboot. This may need
    // polkit/root, so it's best-effort — postInstallHint() prints the sudo
    // command when it's still off.
    await this.deps.exec("loginctl", ["enable-linger", this.deps.username]).catch(() => undefined);
  }

  async uninstall(component: ServiceComponent, instance?: string): Promise<void> {
    // Idempotent: disable fails harmlessly when the unit isn't loaded/enabled.
    await this.deps.exec("systemctl", [
      "--user",
      "disable",
      "--now",
      this.unitName(component, instance),
    ]);
    rmSync(this.unitPath(component, instance), { force: true });
    await this.deps.exec("systemctl", ["--user", "daemon-reload"]);
  }

  async start(component: ServiceComponent, instance?: string): Promise<void> {
    this.requireInstalled(component, instance);
    await this.systemctl(["start", this.unitName(component, instance)]);
  }

  async stop(component: ServiceComponent, instance?: string): Promise<void> {
    this.requireInstalled(component, instance);
    await this.systemctl(["stop", this.unitName(component, instance)]);
  }

  async restart(component: ServiceComponent, instance?: string): Promise<void> {
    this.requireInstalled(component, instance);
    await this.systemctl(["restart", this.unitName(component, instance)]);
  }

  async reload(component: ServiceComponent, instance?: string): Promise<void> {
    this.requireInstalled(component, instance);
    await this.systemctl(["daemon-reload"]);
    await this.systemctl(["restart", this.unitName(component, instance)]);
  }

  async loadDefinition(component: ServiceComponent, instance?: string): Promise<boolean> {
    this.requireInstalled(component, instance);
    await this.systemctl(["daemon-reload"]);
    return true;
  }

  async inspectDefinition(
    component: ServiceComponent,
    instance?: string,
  ): Promise<ServiceDefinitionInspection> {
    const unit = this.unitName(component, instance);
    const fragment = await this.systemctl(["show", "-p", "FragmentPath", "--value", unit]);
    const dropIns = await this.systemctl(["show", "-p", "DropInPaths", "--value", unit]);
    const environment = await this.systemctl(["show-environment"]);
    const inheritedEnvironment = MIGRATION_ENVIRONMENT_KEYS.filter((key) =>
      environment.stdout.split(/\r?\n/u).some((line) => line.startsWith(`${key}=`)),
    );
    return {
      fragmentPath: fragment.stdout.trim(),
      overridePaths: dropIns.stdout.trim() === "" ? [] : dropIns.stdout.trim().split(/\s+/u),
      inheritedEnvironment: [...inheritedEnvironment],
      inheritedEnvironmentText: environment.stdout,
    };
  }

  async status(component: ServiceComponent, instance?: string): Promise<ServiceStatus> {
    const unit = this.unitName(component, instance);
    if (!this.isInstalled(component, instance)) {
      return { component, unit, installed: false, state: "not-installed", pid: null };
    }
    // `is-active` exits non-zero for any non-active state but still prints
    // the state word — read stdout, not the exit code.
    const active = await this.deps.exec("systemctl", ["--user", "is-active", unit]);
    const state = mapSystemdActiveState(active.stdout.trim());
    let pid: number | null = null;
    if (state === "running" || state === "starting") {
      const show = await this.deps.exec("systemctl", [
        "--user",
        "show",
        "-p",
        "MainPID",
        "--value",
        unit,
      ]);
      const parsed = Number.parseInt(show.stdout.trim(), 10);
      pid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    }
    return { component, unit, installed: true, state, pid };
  }

  async logs(
    components: ServiceComponent[],
    instance: string | undefined,
    opts: LogsOptions,
  ): Promise<number> {
    const args = ["--user"];
    for (const component of components) {
      args.push("-u", this.unitName(component, instance));
    }
    args.push("-n", String(opts.lines));
    if (opts.follow) args.push("-f");
    return this.deps.stream("journalctl", args);
  }

  async postInstallHint(): Promise<string | null> {
    const res = await this.deps.exec("loginctl", ["show-user", this.deps.username, "-p", "Linger"]);
    if (res.code === 0 && res.stdout.trim() === "Linger=no") {
      return `Services stop when you log out. Run 'loginctl enable-linger ${this.deps.username}' to keep them running.`;
    }
    return null;
  }

  private requireInstalled(component: ServiceComponent, instance?: string): void {
    if (!this.isInstalled(component, instance)) {
      throw new CliError(
        `${this.unitName(component, instance)} is not installed — run 'omnesis service install ${component}' first.`,
        EXIT_USER_ERROR,
      );
    }
  }

  /** Run `systemctl --user …`, surfacing a non-zero exit as a CLI error. */
  private async systemctl(args: string[]): Promise<ExecResult> {
    const res = await this.deps.exec("systemctl", ["--user", ...args]);
    if (res.code !== 0) {
      throw new CliError(
        `systemctl --user ${args.join(" ")} failed (${res.code}): ${res.stderr.trim()}`,
        EXIT_FAILURE,
      );
    }
    return res;
  }
}
