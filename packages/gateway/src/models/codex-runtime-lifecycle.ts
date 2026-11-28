// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  buildCodexEnv,
  ensureCodexHome,
  managedCodexArgs,
  managedCodexAuth,
  assertNoManagedCodexAuthFile,
} from "@omnesis/agent";
import {
  createLogger,
  nodeCommandInvocation,
  terminateChildProcess,
  spawnWindowsJob,
  type CodexBackendStatus,
  type CodexLoginFlow,
  type CodexRuntimeStatus,
} from "@omnesis/core";
import {
  reassertCodexGenerationAuth,
  type CodexGenerationSupervisor,
  type CodexRuntimeGeneration,
} from "./codex-generation-supervisor.js";

import { CodexGenerationCleanupError, codexCleanupFailure } from "./codex-runtime-cleanup.js";
import { clearCodexAuthentication } from "./codex-auth-removal.js";
import type { CodexRuntimeCommandInfo } from "@omnesis/agent";

const log = createLogger("gateway:models:codex:lifecycle");
const DEFAULT_LOGIN_TTL_MS = 15 * 60_000;

export class CodexRuntimeLifecycleConflictError extends Error {}

interface ActiveLogin {
  flow: CodexLoginFlow;
  proc: ReturnType<typeof spawn>;
  running: boolean;
  closed: Promise<void>;
  timer: NodeJS.Timeout;
  termination: Promise<void> | null;
}

interface CodexRuntimeLifecycleOptions {
  codexHome: string;
  poolHome?: string;
  legacyHome?: string;
  createGeneration?(commandInfo: CodexRuntimeCommandInfo): CodexRuntimeGeneration;
  cliArgsPrefix: readonly string[];
  env: NodeJS.ProcessEnv;
  refreshTimeoutMs: number;
  loginStartTimeoutMs: number;
  loginTtlMs: number;
  supervisor: CodexGenerationSupervisor;
  ensureSelectedRuntime(): Promise<void>;
  updateInProgress(): boolean;
  refresh(): Promise<CodexBackendStatus>;
  invalidateRefresh(): void;
  describeRuntime(): Promise<CodexRuntimeStatus | undefined>;
  setStatus(status: CodexBackendStatus): void;
}

/** Owns device login and logout process lifecycle for the Codex runtime. */
export class CodexRuntimeLifecycle {
  private readonly opts: CodexRuntimeLifecycleOptions;
  private activeLogin: ActiveLogin | null = null;
  private claim: "login-starting" | "agent-setup" | "logout" | null = null;
  private loginStartInFlight: Promise<void> | null = null;
  private readonly acceptedWork = new Set<Promise<void>>();
  private disposed = false;
  private cleanupFailure: unknown;
  private disposal: Promise<void> | undefined;
  private readonly pendingCleanup = Object.assign(
    new CodexGenerationCleanupError(new Error("Codex lifecycle cleanup remains pending.")),
    { cleanupPending: true as const },
  );

  constructor(opts: CodexRuntimeLifecycleOptions) {
    this.opts = opts;
  }

  private holdCleanup(error: unknown): void {
    const failure = codexCleanupFailure(error) ?? new CodexGenerationCleanupError(error);
    this.cleanupFailure = this.opts.supervisor.holdCleanup(failure);
  }

  private assertCleanupConfirmed(): void {
    const failure = this.cleanupFailure ?? this.opts.supervisor.cleanupError;
    if (failure !== undefined && failure !== null)
      throw new CodexRuntimeLifecycleConflictError(
        "Codex process cleanup was not confirmed. Review the process state before retrying.",
        { cause: failure },
      );
  }

  /** Read-only shutdown receipt, including operations whose close has not settled. */
  cleanupReceipt(): unknown | undefined {
    return (
      this.cleanupFailure ??
      this.opts.supervisor.cleanupError ??
      (this.disposed &&
      (this.claim !== null || this.activeLogin?.running || this.activeLogin?.termination)
        ? this.pendingCleanup
        : undefined)
    );
  }

  get busy(): boolean {
    return (
      this.cleanupFailure !== undefined ||
      Boolean(this.opts.supervisor.cleanupError) ||
      this.activeLogin?.running === true ||
      this.activeLogin?.termination != null ||
      this.claim !== null
    );
  }

  private retainAcceptedWork(): () => void {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.acceptedWork.add(work);
    return () => {
      this.acceptedWork.delete(work);
      finish();
    };
  }

  async runAgentSetup<T>(operation: () => Promise<T>): Promise<T> {
    this.assertCleanupConfirmed();
    if (this.disposed) throw new Error("Codex runtime service disposed.");
    if (this.opts.updateInProgress()) {
      throw new CodexRuntimeLifecycleConflictError(
        "Wait for the Codex runtime update to finish before setting up Agent.",
      );
    }
    if (this.busy) {
      throw new CodexRuntimeLifecycleConflictError(
        "Another Codex lifecycle operation is in progress.",
      );
    }
    this.claim = "agent-setup";
    const finish = this.retainAcceptedWork();
    try {
      return await operation();
    } finally {
      if (this.claim === "agent-setup") this.claim = null;
      finish();
    }
  }

  dispose(): Promise<void> {
    return (this.disposal ??= this.disposeLifecycle());
  }

  private async disposeLifecycle(): Promise<void> {
    this.disposed = true;
    // Disposal is not admitted work: close admission, then join the accepted operations.
    await Promise.all([this.loginStartInFlight, ...this.acceptedWork]);
    const active = this.activeLogin;
    if (!active) {
      if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
      if (this.opts.supervisor.cleanupError) throw this.opts.supervisor.cleanupError;
      return;
    }
    clearTimeout(active.timer);
    if (active.flow.status === "pending") {
      active.flow = { ...active.flow, status: "canceled", reason: "Gateway stopped." };
    }
    if (active.running || active.termination) await this.stopLogin(active, "SIGTERM");
    await Promise.race([active.closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (active.running) {
      await this.stopLogin(active, "SIGKILL");
      await active.closed;
    }
    this.activeLogin = null;
    if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
    if (this.opts.supervisor.cleanupError) throw this.opts.supervisor.cleanupError;
  }

  async startDeviceLogin(): Promise<CodexLoginFlow> {
    this.assertCleanupConfirmed();
    if (this.disposed) throw new Error("Codex runtime service disposed.");
    if (this.opts.updateInProgress()) {
      throw new CodexRuntimeLifecycleConflictError(
        "Wait for the Codex runtime update to finish before starting login.",
      );
    }
    if (this.claim && this.claim !== "login-starting") {
      throw new CodexRuntimeLifecycleConflictError(
        "Another Codex lifecycle operation is in progress.",
      );
    }
    if (this.activeLogin?.flow.status === "pending") return this.activeLogin.flow;
    if (this.activeLogin?.running || this.activeLogin?.termination) {
      throw new CodexRuntimeLifecycleConflictError(
        "Wait for the previous Codex login process to finish.",
      );
    }
    if (this.claim) {
      throw new CodexRuntimeLifecycleConflictError(
        "Another Codex lifecycle operation is in progress.",
      );
    }
    this.claim = "login-starting";
    let settleLoginStart!: () => void;
    const loginStartInFlight = new Promise<void>((resolve) => {
      settleLoginStart = resolve;
    });
    this.loginStartInFlight = loginStartInFlight;

    try {
      await this.opts.ensureSelectedRuntime();
      this.assertCleanupConfirmed();
      if (this.cleanupFailure !== undefined)
        throw new CodexRuntimeLifecycleConflictError(
          "Codex process cleanup was not confirmed. Review the process state before retrying.",
        );
      if (this.disposed) throw new Error("Codex runtime service disposed.");
      await ensureCodexHome(this.opts.codexHome, this.opts.env);
      this.assertCleanupConfirmed();
      if (this.cleanupFailure !== undefined)
        throw new CodexRuntimeLifecycleConflictError(
          "Codex process cleanup was not confirmed. Review the process state before retrying.",
        );
      if (this.disposed) throw new Error("Codex runtime service disposed.");
      const childEnv = buildCodexEnv(this.opts.env, this.opts.codexHome);
      await this.opts.supervisor.current.runtime.probeRuntime(this.opts.refreshTimeoutMs);
      if (managedCodexAuth(this.opts.env))
        await this.opts.supervisor.current.runtime.verifyManagedCredentialPolicy();
      this.assertCleanupConfirmed();
      if (this.cleanupFailure !== undefined)
        throw new CodexRuntimeLifecycleConflictError(
          "Codex process cleanup was not confirmed. Review the process state before retrying.",
        );
      if (this.disposed) throw new Error("Codex runtime service disposed.");
      const commandInfo = await this.opts.supervisor.current.runtime.resolveCommandInfo();
      this.assertCleanupConfirmed();
      if (this.cleanupFailure !== undefined)
        throw new CodexRuntimeLifecycleConflictError(
          "Codex process cleanup was not confirmed. Review the process state before retrying.",
        );
      if (this.disposed) throw new Error("Codex runtime service disposed.");

      const id = randomUUID();
      const flow: CodexLoginFlow = {
        id,
        status: "pending",
        expiresAt: new Date(Date.now() + this.opts.loginTtlMs).toISOString(),
      };
      await assertNoManagedCodexAuthFile(this.opts.env, [
        this.opts.codexHome,
        ...(this.opts.legacyHome ? [this.opts.legacyHome] : []),
      ]);
      const invocation = nodeCommandInvocation(
        commandInfo.command,
        managedCodexArgs(
          this.opts.env,
          [...this.opts.cliArgsPrefix, "login", "--device-auth"],
          this.opts.codexHome,
        ),
      );
      const job =
        process.platform === "win32"
          ? spawnWindowsJob(invocation.command, invocation.args, { env: childEnv })
          : null;
      const proc =
        job ??
        spawn(invocation.command, invocation.args, {
          env: childEnv,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      job?.stdin.end();
      const closed =
        job?.jobClosed ??
        new Promise<void>((resolve) => {
          proc.once("close", () => resolve());
          proc.once("error", () => resolve());
        });
      void closed.catch((error: unknown) => {
        if (job) this.holdCleanup(error);
      });
      let output = "";
      let startTimer: NodeJS.Timeout | null = null;
      let startSettled = false;
      let deviceCodeParsed = false;

      const settleStart = (resolve: (value: CodexLoginFlow) => void): void => {
        if (startSettled) return;
        startSettled = true;
        if (startTimer) clearTimeout(startTimer);
        const current = this.activeLogin?.flow.id === id ? this.activeLogin.flow : flow;
        resolve({ ...current });
      };
      const failStart = (reject: (reason: Error) => void, message: string): void => {
        if (startSettled) return;
        startSettled = true;
        if (startTimer) clearTimeout(startTimer);
        reject(new Error(message));
      };
      const expireLogin = (): void => {
        if (this.activeLogin?.flow.id !== id) return;
        this.activeLogin.flow = {
          ...this.activeLogin.flow,
          status: "failed",
          reason: "The Codex device login expired.",
        };
        void this.stopLogin(this.activeLogin, "SIGTERM");
      };
      const expiryTimer = setTimeout(expireLogin, this.opts.loginTtlMs + 5_000);
      this.activeLogin = {
        flow,
        proc,
        running: true,
        closed,
        timer: expiryTimer,
        termination: null,
      };

      return await new Promise<CodexLoginFlow>((resolve, reject) => {
        startTimer = setTimeout(() => {
          if (this.activeLogin?.flow.id === id) {
            this.activeLogin.flow = {
              ...this.activeLogin.flow,
              status: "failed",
              reason: "Codex did not return a device login code.",
            };
          }
          if (this.activeLogin?.flow.id === id) void this.stopLogin(this.activeLogin, "SIGTERM");
          failStart(reject, "Codex did not return a device login code.");
        }, this.opts.loginStartTimeoutMs);

        const onChunk = (chunk: Buffer): void => {
          output += stripAnsi(chunk.toString("utf8"));
          const parsed = parseCodexDeviceLoginOutput(output);
          if (!parsed || deviceCodeParsed || this.activeLogin?.flow.id !== id) return;
          deviceCodeParsed = true;
          this.activeLogin.flow = {
            ...this.activeLogin.flow,
            verificationUri: parsed.verificationUri,
            userCode: parsed.userCode,
            expiresAt: new Date(Date.now() + parsed.expiresMs).toISOString(),
          };
          clearTimeout(this.activeLogin.timer);
          this.activeLogin.timer = setTimeout(expireLogin, parsed.expiresMs + 5_000);
          settleStart(resolve);
        };
        proc.stdout?.on("data", onChunk);
        proc.stderr?.on("data", onChunk);
        proc.on("error", (err) => {
          if (this.activeLogin?.flow.id === id) {
            if (!job) this.activeLogin.running = false;
            clearTimeout(this.activeLogin.timer);
            this.activeLogin.flow = {
              ...this.activeLogin.flow,
              status: "failed",
              reason: conciseError(err),
            };
          }
          failStart(reject, conciseError(err));
        });
        void job?.jobReady.catch((err: unknown) => {
          if (this.activeLogin?.flow.id === id) {
            this.activeLogin.flow = {
              ...this.activeLogin.flow,
              status: "failed",
              reason: conciseError(err),
            };
          }
          failStart(reject, conciseError(err));
        });
        const completeLogin = (): void => {
          if (this.activeLogin?.flow.id !== id || this.activeLogin.flow.status !== "pending")
            return;
          this.activeLogin.flow = {
            ...this.activeLogin.flow,
            status: "complete",
            reason: undefined,
          };
          this.opts.invalidateRefresh();
          reassertCodexGenerationAuth(this.opts.supervisor.current);
          if (!this.disposed)
            void this.opts.refresh().catch((err) => {
              log.warn(`Codex status refresh after login failed: ${conciseError(err)}`);
            });
          if (!startSettled) settleStart(resolve);
        };
        const exited = (code: number | null, signal: NodeJS.Signals | null): void => {
          if (this.activeLogin?.flow.id !== id) return;
          this.activeLogin.running = false;
          clearTimeout(this.activeLogin.timer);
          if (
            this.activeLogin.flow.status === "canceled" ||
            this.activeLogin.flow.status === "failed"
          ) {
            if (!startSettled) settleStart(resolve);
            return;
          }
          if (code === 0) {
            if (managedCodexAuth(this.opts.env)) {
              void assertNoManagedCodexAuthFile(this.opts.env, [this.opts.codexHome]).then(
                completeLogin,
                () => {
                  if (this.activeLogin?.flow.id !== id) return;
                  const reason =
                    "ChatGPT sign-in could not be confirmed safe in Keychain. Sign out in Omnesis and retry.";
                  this.activeLogin.flow = { ...this.activeLogin.flow, status: "failed", reason };
                  if (!startSettled) failStart(reject, reason);
                },
              );
            } else completeLogin();
            return;
          }
          const reason = signal
            ? `Codex login exited from ${signal}.`
            : `Codex login exited with code ${code ?? "unknown"}.`;
          this.activeLogin.flow = { ...this.activeLogin.flow, status: "failed", reason };
          if (!startSettled) failStart(reject, reason);
        };
        proc.on("exit", (code, signal) => {
          if (!job) {
            exited(code, signal);
            return;
          }
          void closed.then(
            () => exited(code, signal),
            (cleanupError: unknown) => {
              this.holdCleanup(cleanupError);
              if (this.activeLogin?.flow.id !== id) return;
              // Keep the operation fenced: raw helper exit is insufficient
              // authority to start another login or mutate its auth state.
              clearTimeout(this.activeLogin.timer);
              const reason =
                "Codex login cleanup was not confirmed. Review the process state before retrying.";
              this.activeLogin.flow = { ...this.activeLogin.flow, status: "failed", reason };
              failStart(reject, reason);
            },
          );
        });
      });
    } finally {
      if (this.claim === "login-starting") this.claim = null;
      settleLoginStart();
      if (this.loginStartInFlight === loginStartInFlight) this.loginStartInFlight = null;
    }
  }

  getLoginFlow(): CodexLoginFlow | null {
    return this.activeLogin ? { ...this.activeLogin.flow } : null;
  }

  cancelLogin(): { ok: true; canceled: boolean; flow: CodexLoginFlow | null } {
    const active = this.activeLogin;
    if (!active || active.flow.status !== "pending") {
      return { ok: true, canceled: false, flow: this.getLoginFlow() };
    }
    active.flow = { ...active.flow, status: "canceled", reason: "Login canceled." };
    clearTimeout(active.timer);
    void this.stopLogin(active, "SIGTERM");
    return { ok: true, canceled: true, flow: { ...active.flow } };
  }

  async logout(): Promise<{ ok: true; status: CodexBackendStatus }> {
    this.assertCleanupConfirmed();
    if (this.disposed) throw new Error("Codex runtime service disposed.");
    if (this.opts.updateInProgress()) {
      throw new CodexRuntimeLifecycleConflictError(
        "Wait for the Codex runtime update to finish before logging out.",
      );
    }
    if (this.claim) {
      throw new CodexRuntimeLifecycleConflictError(
        "Another Codex lifecycle operation is in progress.",
      );
    }
    this.claim = "logout";
    const finish = this.retainAcceptedWork();
    try {
      await this.opts.ensureSelectedRuntime();
      const perform = async (): Promise<{ ok: true; status: CodexBackendStatus }> => {
        await this.opts.ensureSelectedRuntime();
        this.assertCleanupConfirmed();
        if (this.disposed) throw new Error("Codex runtime service disposed.");
        if (this.activeLogin) {
          clearTimeout(this.activeLogin.timer);
          if (this.activeLogin.running || this.activeLogin.termination) {
            await this.stopLogin(this.activeLogin, "SIGTERM");
            await Promise.race([
              this.activeLogin.closed,
              new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
            ]);
            if (this.activeLogin.running) {
              await this.stopLogin(this.activeLogin, "SIGKILL");
              await this.activeLogin.closed;
            }
          }
          this.activeLogin = null;
        }
        await clearCodexAuthentication({
          env: this.opts.env,
          home: this.opts.codexHome,
          legacyHome: this.opts.legacyHome,
          poolHome: this.opts.poolHome,
          cliArgsPrefix: this.opts.cliArgsPrefix,
          timeoutMs: this.opts.refreshTimeoutMs,
          command: () => this.opts.supervisor.current.runtime.resolveCommandInfo(),
          assertActive: () => {
            this.assertCleanupConfirmed();
            if (this.disposed) throw new Error("Codex runtime service disposed.");
          },
          assertCleanup: () => this.assertCleanupConfirmed(),
          holdCleanup: (error) => this.holdCleanup(error),
        });
        this.opts.invalidateRefresh();
        reassertCodexGenerationAuth(this.opts.supervisor.current);
        const status: CodexBackendStatus = {
          type: "codex",
          configured: false,
          status: "unreachable",
          loggedIn: false,
          runtime: await this.opts.describeRuntime(),
          models: [],
          reason: "Codex login removed.",
          refreshedAt: new Date().toISOString(),
        };
        this.opts.setStatus(status);
        return { ok: true, status };
      };
      if (!managedCodexAuth(this.opts.env)) return await perform();
      return await this.opts.supervisor.exclusive(async (generation, replace) => {
        if (!this.opts.createGeneration)
          throw new Error("The managed ChatGPT sign-out cannot drain its workers safely.");
        const command = await generation.runtime.resolveCommandInfo();
        await this.opts.supervisor.retire(generation);
        replace(this.opts.createGeneration(command));
        return perform();
      });
    } finally {
      if (this.claim === "logout") this.claim = null;
      finish();
    }
  }

  private stopLogin(active: ActiveLogin, signal: NodeJS.Signals): Promise<void> {
    if (process.platform === "win32" && active.termination) return active.termination;
    const stopping =
      process.platform === "win32"
        ? (async () => {
            if (active.proc.exitCode === null && active.proc.signalCode === null)
              active.proc.kill("SIGKILL");
            await active.closed;
          })()
        : terminateChildProcess(active.proc, signal);
    active.termination = stopping;
    void stopping.then(
      () => {
        if (active.termination === stopping) active.termination = null;
      },
      (err: unknown) => {
        if (active.termination === stopping) active.termination = null;
        log.warn(`Could not stop Codex login process: ${conciseError(err)}`);
      },
    );
    return stopping;
  }
}

export function parseCodexDeviceLoginOutput(
  output: string,
): { verificationUri: string; userCode: string; expiresMs: number } | null {
  const text = stripAnsi(output);
  const uri = text.match(/https:\/\/auth\.openai\.com\/codex\/device/)?.[0];
  const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/)?.[0];
  if (!uri || !code) return null;
  const minutes = Number.parseInt(text.match(/expires?\s+in\s+(\d+)\s+minutes?/i)?.[1] ?? "", 10);
  return {
    verificationUri: uri,
    userCode: code,
    expiresMs: Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_LOGIN_TTL_MS,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function conciseError(err: unknown): string {
  const value = err instanceof Error ? err.message : String(err);
  return value.replace(/\s+/g, " ").trim() || "unknown error";
}
