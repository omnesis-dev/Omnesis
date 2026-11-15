// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Runs the Tailscale helper program as a child of the gateway: starts it,
 * reads its status, restarts it after a crash with backoff, and stops it.
 * Standard input asks it to stop; physical child/cohort closure is the
 * authority for retirement and replacement.
 */

import {
  createLogger,
  windowsEnvironmentValue,
  spawnOwnedChildProcess,
  ownedProcessCleanupReceipt,
  type OwnedChildProcess,
} from "@omnesis/core";
import type { Readable } from "node:stream";
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
  /** Internal pipe credentials; the public pin is an argument, the token stays in the environment. */
  transport?: { certificateSha256: string; token: string };
}

export type HelperProcessState = "stopped" | "starting" | "running" | "crashed";

export interface SupervisorSnapshot {
  process: HelperProcessState;
  /** Why the helper last stopped, when it did not stop by request. */
  reason?: string;
  status: HelperStatus | null;
  /** Present for a crashed helper: whether an automatic restart is scheduled. */
  retrying?: boolean;
}

export type Spawner = (binary: string, args: string[], env: NodeJS.ProcessEnv) => OwnedChildProcess;

const defaultSpawner: Spawner = (binary, args, env) =>
  spawnOwnedChildProcess(binary, args, { env });

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

export function helperEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (platform === "win32") {
    // Windows variable names are case-insensitive. Emit each allowed name
    // once, preserving host paths needed by native runtimes and trust stores.
    const names = new Set([
      ...[...HELPER_ENVIRONMENT].map((name) => name.toUpperCase()),
      "SystemRoot",
      "WINDIR",
      "USERPROFILE",
      "LOCALAPPDATA",
      "APPDATA",
      "TEMP",
      "TMP",
      ...Object.keys(env)
        .filter((name) => name.toUpperCase().startsWith("LC_"))
        .map((name) => name.toUpperCase()),
    ]);
    for (const name of names) {
      const value = windowsEnvironmentValue(name, env);
      if (value !== undefined) out[name] = value;
    }
    return out;
  }
  for (const [name, value] of Object.entries(env)) {
    if (HELPER_ENVIRONMENT.has(name) || name.startsWith("LC_")) out[name] = value;
  }
  return out;
}

/** Drain bounded protocol lines without retaining unbounded unterminated output. */
function helperLines(
  stream: Readable,
  line: (value: string) => void,
  failed: (error: unknown) => void,
) {
  let buffer = "";
  let discarded = false;
  const discard = () => {
    discarded = true;
    buffer = "";
  };
  const fail = (error: unknown) => {
    if (discarded) return;
    discard();
    failed(error);
  };
  const finish = () => {
    if (discarded) return;
    try {
      if (buffer.trim()) line(buffer.trim());
    } catch (error) {
      fail(error);
    }
    buffer = "";
  };
  const data = (chunk: string) => {
    if (discarded) return;
    try {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        if (end > 65_536) throw new Error("Tailscale helper output exceeds its line bound");
        line(buffer.slice(0, end).trim());
        buffer = buffer.slice(end + 1);
        if (discarded) return;
      }
      if (buffer.length > 65_536) throw new Error("Tailscale helper output exceeds its line bound");
    } catch (error) {
      fail(error);
    }
  };
  stream.setEncoding("utf8");
  stream.on("data", data);
  stream.on("error", fail);
  stream.once("end", finish);
  return {
    discard,
    close() {
      finish();
      discard();
      stream.off("data", data);
      stream.off("error", fail);
      stream.off("end", finish);
    },
  };
}

function uncertainHelper(error: unknown): unknown {
  return ownedProcessCleanupReceipt(error)
    ? error
    : Object.assign(new Error("Tailscale helper cleanup is unconfirmed", { cause: error }), {
        cleanupFailure: error,
      });
}

export class HelperSupervisor {
  private owner: OwnedChildProcess | null = null;
  private launch: HelperLaunch | null = null;
  private state: HelperProcessState = "stopped";
  private reason: string | undefined;
  private status: HelperStatus | null = null;
  private startedAt = 0;
  private failures = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  /** Retain a rejected, uncertain close as well as a close still in progress. */
  private stopping: Promise<void> | null = null;
  private stoppingOwner: OwnedChildProcess | null = null;
  private held = false;
  private heldError: unknown;
  private readonly pending = Object.assign(new Error("Tailscale helper remains owned"), {
    cleanupFailure: undefined,
    cleanupPending: true as const,
  });
  private lastConfigure: HelperCommand | null = null;
  private readonly listeners = new Set<(snapshot: SupervisorSnapshot) => void>();

  constructor(
    private readonly spawner: Spawner = defaultSpawner,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly backoffMs: readonly number[] = BACKOFF_MS,
  ) {}

  cleanupFailure(): unknown {
    return this.held ? this.heldError : this.owner || this.stopping ? this.pending : undefined;
  }

  snapshot(): SupervisorSnapshot {
    return {
      process: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      status: this.status,
      ...(this.state === "crashed" ? { retrying: this.restartTimer !== null } : {}),
    };
  }

  onChange(listener: (snapshot: SupervisorSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Latest launch wins; no replacement is admitted before the previous owner joins. */
  async start(launch: HelperLaunch): Promise<void> {
    if (this.held) throw this.heldError;
    this.cancelRestart();
    this.launch = launch;
    this.failures = 0;
    await this.stopChild();
    if (this.launch === launch) this.spawnChild();
  }

  async stop(): Promise<void> {
    this.cancelRestart();
    this.launch = null;
    await this.stopChild();
    this.setState("stopped", undefined, null);
  }

  /** Configure commands remain available for the next successfully admitted helper. */
  send(command: HelperCommand): void {
    if (this.held) throw this.heldError;
    if (command.type === "configure") this.lastConfigure = command;
    const owner = this.owner;
    if (owner && this.stoppingOwner !== owner && owner.child.stdin?.writable) {
      try {
        owner.child.stdin.write(encodeHelperCommand(command));
      } catch (error) {
        this.observe(error);
        throw error;
      }
    }
  }

  private observe(error: unknown): boolean {
    if (!ownedProcessCleanupReceipt(error)) return false;
    if (!this.held) {
      this.held = true;
      this.heldError = uncertainHelper(error);
      this.cancelRestart();
      this.setState("crashed", "Tailscale helper cleanup is unconfirmed; review is required", null);
    }
    return true;
  }

  private spawnChild(): void {
    const launch = this.launch;
    if (!launch || this.owner || this.stopping || this.held) return;
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
      ...(launch.transport
        ? ["-socket-certificate-sha256", launch.transport.certificateSha256]
        : []),
    ];
    let owner: OwnedChildProcess;
    this.startedAt = Date.now();
    try {
      owner = this.spawner(launch.binary, args, {
        ...helperEnvironment(this.env),
        ...(launch.transport ? { OMNESIS_TAILNET_IPC_TOKEN: launch.transport.token } : {}),
      });
    } catch (error) {
      if (!this.observe(error))
        this.onExit(`could not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.owner = owner;
    const child = owner.child;
    this.setState("starting", undefined, null);
    const readers: Array<ReturnType<typeof helperLines>> = [];
    const failed = (error: unknown) => {
      for (const reader of readers) reader.discard();
      if (this.observe(error)) {
        void this.stopChild().catch((failure: unknown) => {
          this.observe(failure);
        });
        return;
      }
      this.protocolFailure(owner, error instanceof Error ? error.message : "Invalid helper output");
    };
    if (child.stdout && child.stderr) {
      readers.push(helperLines(child.stdout, (line) => this.onLine(owner, line), failed));
      readers.push(
        helperLines(
          child.stderr,
          (line) => {
            if (line) log.info(`helper: ${line}`);
          },
          failed,
        ),
      );
    } else failed(new Error("Tailscale helper has no output pipes"));
    child.on("error", (error) => {
      if (this.owner !== owner) return;
      this.reason = `could not start: ${error.message}`;
      this.observe(error);
      log.warn(`Tailscale helper error: ${error.message}`);
    });
    child.stdin?.on("error", (error) => {
      if (this.observe(error) || this.owner !== owner || this.stoppingOwner === owner) return;
      const launchAtFailure = this.launch;
      void this.stopChild()
        .then(() => {
          if (!this.owner && this.launch === launchAtFailure)
            this.onExit(`input closed: ${error.message}`);
        })
        .catch((failure: unknown) => {
          this.observe(failure);
        });
    });
    void owner.ready.catch((error: unknown) => {
      this.observe(error);
    });
    void owner.joined.then(
      () => {
        for (const reader of readers) reader.close();
        if (this.owner !== owner) return;
        this.owner = null;
        if (this.stoppingOwner === owner || this.held || this.launch !== launch) return;
        this.onExit(
          child.signalCode
            ? `stopped by ${child.signalCode}`
            : `exited with status ${child.exitCode}`,
        );
      },
      (error: unknown) => {
        for (const reader of readers) reader.discard();
        this.observe(uncertainHelper(error));
      },
    );
    if (this.lastConfigure && child.stdin?.writable)
      child.stdin.write(encodeHelperCommand(this.lastConfigure));
  }

  private onLine(owner: OwnedChildProcess, line: string): void {
    if (!line || this.owner !== owner || this.stoppingOwner === owner || this.held) return;
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
      this.protocolFailure(
        owner,
        `the helper speaks protocol ${event.protocol}, this gateway ${HELPER_PROTOCOL_VERSION}`,
      );
      return;
    }
    this.setState("running", undefined, event);
  }

  private protocolFailure(owner: OwnedChildProcess, reason: string): void {
    if (this.owner !== owner || this.held) return;
    this.launch = null;
    this.cancelRestart();
    void this.stopChild()
      .then(() => this.setState("crashed", reason, null))
      .catch((error: unknown) => {
        if (!this.observe(error)) this.setState("crashed", reason, null);
      });
  }

  private onExit(why: string): void {
    if (this.held) return;
    if (!this.launch) {
      this.setState("stopped", undefined, null);
      return;
    }
    this.failures = Date.now() - this.startedAt >= HEALTHY_RUN_MS ? 1 : this.failures + 1;
    const delay = this.backoffMs[Math.min(this.failures - 1, this.backoffMs.length - 1)]!;
    const reason = this.reason ?? why;
    this.reason = undefined;
    log.warn(`Tailscale helper ${why}; restarting in ${Math.round(delay / 1000)}s`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnChild();
    }, delay);
    this.restartTimer.unref();
    this.setState("crashed", reason, null);
  }

  /** Input grace and POSIX escalation keep their existing five/eight-second boundaries. */
  private stopChild(): Promise<void> {
    if (this.stopping) return this.stopping;
    const owner = this.owner;
    if (!owner) return this.held ? Promise.reject(this.heldError) : Promise.resolve();
    this.stoppingOwner = owner;
    const errors: unknown[] = [];
    let term: NodeJS.Timeout | undefined;
    let kill: NodeJS.Timeout | undefined;
    const requestStop = () => {
      void owner.stop().catch((error: unknown) => {
        errors.push(error);
        if (!owner.joinedConfirmed) this.observe(uncertainHelper(error));
        else this.observe(error);
      });
    };
    const proof = (async () => {
      try {
        try {
          owner.child.stdin?.end();
        } catch (error) {
          errors.push(error);
          requestStop();
        }
        term = setTimeout(requestStop, STOP_GRACE_MS);
        kill = setTimeout(() => {
          try {
            owner.child.kill("SIGKILL");
          } catch (error) {
            errors.push(error);
            this.observe(error);
          }
        }, STOP_KILL_MS);
        term.unref();
        kill.unref();
        await owner.joined;
        await owner.stop();
        if (this.held) throw this.heldError;
        if (errors.length)
          throw new AggregateError(errors, "Tailscale helper stop failed after closure");
      } finally {
        clearTimeout(term);
        clearTimeout(kill);
      }
    })().then(
      () => {
        if (this.owner === owner) this.owner = null;
        this.stopping = null;
        this.stoppingOwner = null;
      },
      (error: unknown) => {
        const failure = owner.joinedConfirmed ? error : uncertainHelper(error);
        if (!this.observe(failure)) {
          if (this.owner === owner) this.owner = null;
          this.stopping = null;
          this.stoppingOwner = null;
          this.setState("stopped", undefined, null);
        }
        throw failure;
      },
    );
    this.stopping = proof;
    void proof.catch(() => {});
    return proof;
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
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        if (!this.observe(error)) log.warn("Tailscale helper status observer failed");
      }
    }
  }
}
