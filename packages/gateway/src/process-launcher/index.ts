// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLogger, resolveWorkerEntry } from "@omnesis/core";
import {
  directProcessLauncher,
  killProcessGroup,
  type ProcessLauncher,
  type ProcessResult,
  type RunProcessOptions,
} from "./run-child.js";
import type { LauncherReply, LauncherRequest } from "../workers/process-launcher-host.js";

export {
  directProcessLauncher,
  STDERR_CAPTURE_CHARS,
  type ProcessLauncher,
  type ProcessResult,
  type RunProcessOptions,
} from "./run-child.js";

const log = createLogger("gateway:process-launcher");
const READY_TIMEOUT_MS = 15_000;
/**
 * After a failed start, or a second host in a row that exits soon after
 * starting, the host is not started again for this long: each start forks the
 * gateway, the cost the host exists to avoid. Programs start from the gateway
 * in the meantime.
 */
const RESTART_BACKOFF_MS = 60_000;
/** How long a run waits past its own timeout for a host that stopped answering. */
const HOST_REPLY_GRACE_MS = 10_000;
/** How long a disconnected host gets to kill its programs and exit before it is killed. */
const DISPOSE_GRACE_MS = 2_000;

interface Pending {
  resolve: (result: ProcessResult) => void;
  cleanup: () => void;
  /** The program's pid, also its process group id, once the host started it. */
  pid?: number;
}

/** One forked host and the runs it was handed. */
interface Host {
  child: ChildProcess;
  pending: Map<number, Pending>;
}

/**
 * Starts external programs from the launcher host (`workers/process-launcher-host.ts`)
 * so the gateway's own event loop never pays for forking a large process.
 * When the host has exited it is started again on the next run, unless it
 * failed to start or hosts keep exiting soon after starting; then programs
 * start from the gateway itself until `RESTART_BACKOFF_MS` has passed.
 */
export class HostedProcessLauncher implements ProcessLauncher {
  private host: Host | null = null;
  private starting: Promise<Host | null> | null = null;
  private nextId = 1;
  private disposed = false;
  private retryAt = 0;
  /** Hosts in a row that exited within `RESTART_BACKOFF_MS` of becoming ready. */
  private earlyExits = 0;

  constructor(
    private readonly entry: { modulePath: string; execArgv: string[] } = defaultHostEntry(),
    private readonly clock: () => number = Date.now,
  ) {}

  /** Start the host now; later runs reuse it. */
  async start(): Promise<boolean> {
    return (await this.current()) !== null;
  }

  async run(
    command: string,
    args: readonly string[],
    opts: RunProcessOptions,
  ): Promise<ProcessResult> {
    const host = await this.current();
    if (!host) return directProcessLauncher.run(command, args, opts);
    const { signal, ...rest } = opts;
    const id = this.nextId++;
    return new Promise<ProcessResult>((resolve) => {
      const onAbort = (): void => {
        if (host.child.connected) host.child.send({ type: "kill", id } satisfies LauncherRequest);
      };
      // A host that stopped answering must not hold the caller past its own timeout.
      const backstop = setTimeout(() => {
        const pending = host.pending.get(id);
        if (!pending) return;
        host.pending.delete(id);
        pending.cleanup();
        if (process.platform === "win32") {
          // Each native job helper watches this host through a pinned handle.
          // Stopping an unresponsive host closes all its owned jobs without
          // guessing whether a helper's numeric PID has been reused.
          host.child.kill("SIGKILL");
        } else if (pending.pid !== undefined) killProcessGroup(pending.pid);
        resolve(launcherFailure("timeout", "process launcher did not answer"));
      }, opts.timeoutMs + HOST_REPLY_GRACE_MS);
      backstop.unref();
      const cleanup = (): void => {
        clearTimeout(backstop);
        signal?.removeEventListener("abort", onAbort);
        if (host.pending.size === 0) host.child.channel?.unref();
      };
      host.pending.set(id, { resolve, cleanup });
      host.child.channel?.ref();
      host.child.send({
        type: "run",
        id,
        command,
        args: [...args],
        opts: rest,
      } satisfies LauncherRequest);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Stop the host: it kills the programs it is running and exits once
   * disconnected, and is killed outright if it has not exited within
   * `DISPOSE_GRACE_MS`. Later runs start programs from the gateway.
   */
  dispose(): void {
    this.disposed = true;
    const host = this.host;
    this.host = null;
    if (host) retire(host.child);
  }

  private current(): Promise<Host | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.host?.child.connected) return Promise.resolve(this.host);
    if (this.clock() < this.retryAt) return Promise.resolve(null);
    this.starting ??= this.fork()
      .then((host) => {
        if (!host) this.retryAt = this.clock() + RESTART_BACKOFF_MS;
        return host;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  private fork(): Promise<Host | null> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = fork(this.entry.modulePath, [], {
          execArgv: this.entry.execArgv,
          serialization: "advanced",
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
      } catch (err) {
        log.warn(
          `Process launcher could not start; programs start from the gateway: ${err instanceof Error ? err.message : String(err)}`,
        );
        resolve(null);
        return;
      }
      const host: Host = { child, pending: new Map() };
      let ready = false;
      let readyAt = 0;
      const notReady = (reason: string): void => {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        log.warn(`Process launcher ${reason}; programs start from the gateway`);
        child.kill("SIGKILL");
        resolve(null);
      };
      const timer = setTimeout(
        () => notReady(`was not ready within ${READY_TIMEOUT_MS}ms`),
        READY_TIMEOUT_MS,
      );
      child.on("message", (reply: LauncherReply) => {
        if (reply.type === "ready") {
          if (ready) return;
          ready = true;
          clearTimeout(timer);
          if (this.disposed) {
            retire(child);
            resolve(null);
            return;
          }
          readyAt = this.clock();
          this.host = host;
          child.channel?.unref();
          child.unref();
          resolve(host);
          return;
        }
        const pending = host.pending.get(reply.id);
        if (!pending) return;
        if (reply.type === "started") {
          pending.pid = reply.pid;
          return;
        }
        host.pending.delete(reply.id);
        pending.cleanup();
        pending.resolve({ ...reply.result, stdout: toBuffer(reply.result.stdout) });
      });
      child.on("error", (err) => {
        log.warn(`Process launcher error: ${err.message}`);
        notReady(`could not start (${err.message})`);
      });
      child.on("exit", (code, signal) => {
        notReady(`exited before it was ready (${signal ?? `code ${code}`})`);
        if (this.host === host) this.host = null;
        if (!this.disposed && readyAt > 0) {
          const early = this.clock() - readyAt < RESTART_BACKOFF_MS;
          this.earlyExits = early ? this.earlyExits + 1 : 0;
          const backOff = this.earlyExits > 1;
          if (backOff) this.retryAt = this.clock() + RESTART_BACKOFF_MS;
          log.warn(
            `Process launcher exited (${signal ?? `code ${code}`}); ${backOff ? `programs start from the gateway for ${RESTART_BACKOFF_MS / 1000}s` : "it starts again on the next program"}`,
          );
        }
        for (const [id, pending] of host.pending) {
          host.pending.delete(id);
          pending.cleanup();
          // The programs of a host that was killed outlive it; nobody reads them now.
          if (pending.pid !== undefined) killProcessGroup(pending.pid);
          pending.resolve(launcherFailure("spawn", "process launcher exited"));
        }
      });
    });
  }
}

/** Disconnect a host so it kills its programs and exits; kill it if it lingers. */
function retire(child: ChildProcess): void {
  if (child.connected) child.disconnect();
  const kill = setTimeout(() => child.kill("SIGKILL"), DISPOSE_GRACE_MS);
  kill.unref();
  child.once("exit", () => clearTimeout(kill));
}

function launcherFailure(failure: "spawn" | "timeout", failureMessage: string): ProcessResult {
  return {
    exitCode: null,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: "",
    failure,
    failureMessage,
  };
}

function defaultHostEntry(): { modulePath: string; execArgv: string[] } {
  const entry = resolveWorkerEntry(
    "../workers/process-launcher-host.ts",
    import.meta.url,
    "../workers/register-tsx.mjs",
  );
  return { modulePath: fileURLToPath(entry.url), execArgv: entry.execArgv };
}

/** Advanced serialization delivers a Buffer as a plain Uint8Array. */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

let current: ProcessLauncher = directProcessLauncher;

/** The launcher programs are started through: the gateway's host once installed. */
export function processLauncher(): ProcessLauncher {
  return current;
}

/** Install the process-wide launcher. The gateway installs its host at boot. */
export function setProcessLauncher(launcher: ProcessLauncher): void {
  current = launcher;
}
