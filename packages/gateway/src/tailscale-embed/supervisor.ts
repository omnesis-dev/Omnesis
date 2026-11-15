// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Runs the Tailscale helper program as a child of the gateway: starts it,
 * reads its status, restarts it after a crash with backoff, and stops it.
 * The helper exits on its own when its standard input closes, so it never
 * outlives the gateway.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createLogger } from "@omnesis/core";
import {
  encodeHelperCommand,
  HELPER_PROTOCOL_VERSION,
  parseHelperEvent,
  type HelperCommand,
  type HelperStatus,
} from "./protocol.js";

const log = createLogger("gateway:tailscale").child("helper");

export interface HelperLaunch {
  binary: string;
  stateDir: string;
  hostname: string;
  socketPath: string;
  fallbackCert: string;
  fallbackKey: string;
  /** Coordination server; empty for Tailscale's own. Set only by tests. */
  controlUrl?: string;
}

export type HelperProcessState = "stopped" | "starting" | "running" | "crashed";

export interface SupervisorSnapshot {
  process: HelperProcessState;
  /** Why the helper last stopped, when it did not stop by request. */
  reason?: string;
  status: HelperStatus | null;
}

export type Spawner = (
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams;

const defaultSpawner: Spawner = (binary, args, env) =>
  spawn(binary, args, { env, stdio: ["pipe", "pipe", "pipe"] });

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** How long a stopping helper gets to close cleanly before SIGTERM, then SIGKILL. */
const STOP_GRACE_MS = 5_000;
const STOP_KILL_MS = 8_000;
/** A run this long counts as healthy and resets the backoff. */
const HEALTHY_RUN_MS = 60_000;

/**
 * What the helper may see of the gateway's environment: where it is, which
 * locale, which certificate store and which outbound proxy to use. Nothing
 * else (model keys, keyring passphrases, Tailscale's own TS_* variables)
 * reaches it.
 */
const HELPER_ENVIRONMENT = new Set([
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
]);

export function helperEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (HELPER_ENVIRONMENT.has(name) || name.startsWith("LC_")) out[name] = value;
  }
  return out;
}

export class HelperSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private launch: HelperLaunch | null = null;
  private state: HelperProcessState = "stopped";
  private reason: string | undefined;
  private status: HelperStatus | null = null;
  private startedAt = 0;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  /** The stop in progress; nothing is spawned until it ends. */
  private stopping: Promise<void> | null = null;
  private lastConfigure: HelperCommand | null = null;
  private readonly listeners = new Set<(snapshot: SupervisorSnapshot) => void>();

  constructor(
    private readonly spawner: Spawner = defaultSpawner,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly backoffMs: readonly number[] = BACKOFF_MS,
  ) {}

  snapshot(): SupervisorSnapshot {
    return {
      process: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      status: this.status,
    };
  }

  onChange(listener: (snapshot: SupervisorSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start the helper, or restart it with new launch settings. Resolves once
   * the previous helper, if any, has exited and the new one is spawned; one
   * helper runs at a time, however often this is called.
   */
  async start(launch: HelperLaunch): Promise<void> {
    this.cancelRestart();
    this.launch = launch;
    this.failures = 0;
    await this.stopChild();
    // Several starts may wait on one stop; only the latest launch is spawned,
    // and the starts it superseded return without spawning.
    if (this.launch === launch) this.spawnChild();
  }

  /** Stop the helper and do not restart it. */
  async stop(): Promise<void> {
    this.cancelRestart();
    this.launch = null;
    await this.stopChild();
    this.setState("stopped", undefined, null);
  }

  /** Send a command; configure commands are replayed after a restart. */
  send(command: HelperCommand): void {
    if (command.type === "configure") this.lastConfigure = command;
    if (this.child?.stdin.writable) this.child.stdin.write(encodeHelperCommand(command));
  }

  private spawnChild(): void {
    const launch = this.launch;
    if (!launch || this.child || this.stopping) return;
    const args = [
      "-state-dir",
      launch.stateDir,
      "-hostname",
      launch.hostname,
      "-socket",
      launch.socketPath,
      "-fallback-cert",
      launch.fallbackCert,
      "-fallback-key",
      launch.fallbackKey,
      ...(launch.controlUrl ? ["-control-url", launch.controlUrl] : []),
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.spawner(launch.binary, args, helperEnvironment(this.env));
    } catch (err) {
      this.onExit(`could not start: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.child = child;
    this.startedAt = Date.now();
    this.setState("starting", undefined, null);
    child.on("error", (err) => log.warn(`Tailscale helper error: ${err.message}`));
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(child, line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (line.trim()) log.info(`helper: ${line}`);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.onExit(signal ? `stopped by ${signal}` : `exited with status ${code}`);
    });
    if (this.lastConfigure) child.stdin.write(encodeHelperCommand(this.lastConfigure));
  }

  private onLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child) return;
    const event = parseHelperEvent(line);
    if (!event) {
      log.warn("Tailscale helper sent a line the gateway does not understand");
      return;
    }
    if (event.type === "fatal") {
      this.reason = event.message;
      log.warn(`Tailscale helper failed: ${event.message}`);
      return;
    }
    if (event.protocol !== HELPER_PROTOCOL_VERSION) {
      this.reason = `the helper speaks protocol ${event.protocol}, this gateway ${HELPER_PROTOCOL_VERSION}`;
      log.warn(`Stopping the Tailscale helper: ${this.reason}`);
      this.launch = null;
      const reason = this.reason;
      void this.stopChild().then(() => this.setState("crashed", reason, null));
      return;
    }
    this.setState("running", undefined, event);
  }

  private onExit(why: string): void {
    if (!this.launch) {
      this.setState("stopped", undefined, null);
      return;
    }
    const ranFor = Date.now() - this.startedAt;
    this.failures = ranFor >= HEALTHY_RUN_MS ? 1 : this.failures + 1;
    const delay = this.backoffMs[Math.min(this.failures - 1, this.backoffMs.length - 1)]!;
    const reason = this.reason ?? why;
    this.reason = undefined;
    log.warn(`Tailscale helper ${why}; restarting in ${Math.round(delay / 1000)}s`);
    this.setState("crashed", reason, null);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnChild();
    }, delay);
    this.restartTimer.unref();
  }

  /** Stop the running helper; resolves when it has exited (or was killed). */
  private stopChild(): Promise<void> {
    if (this.stopping) return this.stopping;
    const child = this.child;
    if (!child) return Promise.resolve();
    this.child = null;
    this.stopping = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(term);
        clearTimeout(kill);
        this.stopping = null;
        resolve();
      };
      child.once("exit", finish);
      // Closing standard input asks the helper to shut down cleanly, which
      // closes the public address before it goes.
      child.stdin.end();
      const term = setTimeout(() => child.kill("SIGTERM"), STOP_GRACE_MS);
      const kill = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, STOP_KILL_MS);
      term.unref();
      kill.unref();
    });
    return this.stopping;
  }

  private cancelRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private setState(
    state: HelperProcessState,
    reason: string | undefined,
    status: HelperStatus | null,
  ): void {
    this.state = state;
    this.reason = reason;
    this.status = status;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}
