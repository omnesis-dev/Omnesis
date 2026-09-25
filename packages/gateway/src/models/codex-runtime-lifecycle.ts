// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { buildCodexEnv, ensureCodexHome } from "@omnesis/agent";
import {
  createLogger,
  type CodexBackendStatus,
  type CodexLoginFlow,
  type CodexRuntimeStatus,
} from "@omnesis/core";
import {
  reassertCodexGenerationAuth,
  type CodexGenerationSupervisor,
} from "./codex-generation-supervisor.js";

const execFileAsync = promisify(execFile);
const log = createLogger("gateway:models:codex:lifecycle");
const DEFAULT_LOGIN_TTL_MS = 15 * 60_000;

export class CodexRuntimeLifecycleConflictError extends Error {}

interface ActiveLogin {
  flow: CodexLoginFlow;
  proc: ReturnType<typeof spawn>;
  running: boolean;
  closed: Promise<void>;
  timer: NodeJS.Timeout;
}

interface CodexRuntimeLifecycleOptions {
  codexHome: string;
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
  private disposed = false;

  constructor(opts: CodexRuntimeLifecycleOptions) {
    this.opts = opts;
  }

  get busy(): boolean {
    return this.activeLogin?.running === true || this.claim !== null;
  }

  async runAgentSetup<T>(operation: () => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("Codex runtime service disposed.");
    if (this.opts.updateInProgress()) {
      throw new CodexRuntimeLifecycleConflictError(
        "Wait for the Codex runtime update to finish before setting up Agent.",
      );
    }
    if (this.activeLogin?.running || this.claim) {
      throw new CodexRuntimeLifecycleConflictError(
        "Another Codex lifecycle operation is in progress.",
      );
    }
    this.claim = "agent-setup";
    try {
      return await operation();
    } finally {
      if (this.claim === "agent-setup") this.claim = null;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.loginStartInFlight;
    const active = this.activeLogin;
    if (!active) return;
    clearTimeout(active.timer);
    if (active.flow.status === "pending") {
      active.flow = { ...active.flow, status: "canceled", reason: "Gateway stopped." };
    }
    if (active.running) active.proc.kill("SIGTERM");
    await Promise.race([active.closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
    if (active.running) {
      active.proc.kill("SIGKILL");
      await active.closed;
    }
    this.activeLogin = null;
  }

  async startDeviceLogin(): Promise<CodexLoginFlow> {
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
    if (this.activeLogin?.running) {
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
      if (this.disposed) throw new Error("Codex runtime service disposed.");
      await ensureCodexHome(this.opts.codexHome);
      if (this.disposed) throw new Error("Codex runtime service disposed.");
      const childEnv = buildCodexEnv(this.opts.env, this.opts.codexHome);
      await this.opts.supervisor.current.runtime.probeRuntime(this.opts.refreshTimeoutMs);
      if (this.disposed) throw new Error("Codex runtime service disposed.");
      const commandInfo = await this.opts.supervisor.current.runtime.resolveCommandInfo();
      if (this.disposed) throw new Error("Codex runtime service disposed.");

      const id = randomUUID();
      const flow: CodexLoginFlow = {
        id,
        status: "pending",
        expiresAt: new Date(Date.now() + this.opts.loginTtlMs).toISOString(),
      };
      const proc = spawn(
        commandInfo.command,
        [...this.opts.cliArgsPrefix, "login", "--device-auth"],
        { env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      const closed = new Promise<void>((resolve) => {
        proc.once("close", () => resolve());
        proc.once("error", () => resolve());
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
        proc.kill("SIGTERM");
      };
      const expiryTimer = setTimeout(expireLogin, this.opts.loginTtlMs + 5_000);
      this.activeLogin = { flow, proc, running: true, closed, timer: expiryTimer };

      return await new Promise<CodexLoginFlow>((resolve, reject) => {
        startTimer = setTimeout(() => {
          if (this.activeLogin?.flow.id === id) {
            this.activeLogin.flow = {
              ...this.activeLogin.flow,
              status: "failed",
              reason: "Codex did not return a device login code.",
            };
          }
          proc.kill("SIGTERM");
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
            this.activeLogin.running = false;
            clearTimeout(this.activeLogin.timer);
            this.activeLogin.flow = {
              ...this.activeLogin.flow,
              status: "failed",
              reason: conciseError(err),
            };
          }
          failStart(reject, conciseError(err));
        });
        proc.on("exit", (code, signal) => {
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
            this.activeLogin.flow = {
              ...this.activeLogin.flow,
              status: "complete",
              reason: undefined,
            };
            this.opts.invalidateRefresh();
            reassertCodexGenerationAuth(this.opts.supervisor.current);
            if (!this.disposed) {
              void this.opts.refresh().catch((err) => {
                log.warn(`Codex status refresh after login failed: ${conciseError(err)}`);
              });
            }
            if (!startSettled) settleStart(resolve);
            return;
          }
          const reason = signal
            ? `Codex login exited from ${signal}.`
            : `Codex login exited with code ${code ?? "unknown"}.`;
          this.activeLogin.flow = { ...this.activeLogin.flow, status: "failed", reason };
          if (!startSettled) failStart(reject, reason);
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
    active.proc.kill("SIGTERM");
    return { ok: true, canceled: true, flow: { ...active.flow } };
  }

  async logout(): Promise<{ ok: true; status: CodexBackendStatus }> {
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
    try {
      await this.opts.ensureSelectedRuntime();
      if (this.activeLogin) {
        clearTimeout(this.activeLogin.timer);
        if (this.activeLogin.running) {
          this.activeLogin.proc.kill("SIGTERM");
          await Promise.race([
            this.activeLogin.closed,
            new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
          ]);
          if (this.activeLogin.running) {
            this.activeLogin.proc.kill("SIGKILL");
            await this.activeLogin.closed;
          }
        }
        this.activeLogin = null;
      }
      const childEnv = buildCodexEnv(this.opts.env, this.opts.codexHome);
      try {
        const commandInfo = await this.opts.supervisor.current.runtime.resolveCommandInfo();
        await execFileAsync(commandInfo.command, [...this.opts.cliArgsPrefix, "logout"], {
          env: childEnv,
          timeout: this.opts.refreshTimeoutMs,
          windowsHide: true,
        });
      } catch (err) {
        log.warn(`Codex logout command failed; removing local auth file: ${conciseError(err)}`);
      }
      await rm(join(this.opts.codexHome, "auth.json"), { force: true });
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
    } finally {
      if (this.claim === "logout") this.claim = null;
    }
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
