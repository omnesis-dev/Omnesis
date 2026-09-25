// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  CodexAppServerBackend,
  CodexAppServerRuntime,
  CodexRuntimePool,
  buildCodexEnv,
  ensureCodexHome,
  type CodexRuntimeCommandInfo,
  type CodexRuntimeTurnOptions,
  type CodexTurnRunner,
} from "@omnesis/agent";
import {
  codexPaths,
  CODEX_SUPPORTED_ROLES,
  createLogger,
  type CapabilityRole,
  type CodexBackendStatus,
  type CodexLoginFlow,
  type CodexModelStatus,
  type CodexRuntimeStatus,
  type CodexRuntimeUpdateSnapshot,
} from "@omnesis/core";
import { CodexRuntimeInstaller } from "./codex-runtime-installer.js";
import {
  CodexAgentSetupConflictError,
  setupCodexAgent,
  type CodexAgentSetupResult,
} from "./codex-agent-setup.js";
import {
  CodexGenerationSupervisor,
  type CodexRuntimeGeneration,
} from "./codex-generation-supervisor.js";
import {
  CodexRuntimeLifecycle,
  CodexRuntimeLifecycleConflictError,
} from "./codex-runtime-lifecycle.js";
import { CodexRuntimeUpdater } from "./codex-runtime-updater.js";
import type { ConfigStore } from "../config-store.js";

export { parseCodexDeviceLoginOutput } from "./codex-runtime-lifecycle.js";

const execFileAsync = promisify(execFile);
const log = createLogger("gateway:models:codex");

const DEFAULT_CODEX_VERSION_ARGS = ["--version"] as const;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_START_TIMEOUT_MS = 15_000;
const DEFAULT_LOGIN_TTL_MS = 15 * 60_000;
const CODEX_MODEL_LIST_MAX_BUFFER = 20 * 1024 * 1024;

/**
 * Number of extra app-server subprocesses backing the interactive lane. Each
 * runs one Codex turn at a time, so N members = up to N concurrent interactive
 * turns (app conversations and `/answer`). Background agent
 * work stays on the single serialized owner runtime. 0 disables the pool (all
 * interactive and background turns share the owner runtime). Kept conservative by
 * default: each member is a live app-server subprocess competing for memory.
 */
const DEFAULT_INTERACTIVE_POOL_SIZE = 3;
const DEFAULT_INFERENCE_POOL_SIZE = 2;

/** A Codex turn's lane. Interactive turns spread across the pool for latency
 *  isolation; inference and nested calls have independent bounded capacity. */
export type CodexLane = "interactive" | "background" | "inference";

export interface CodexRuntimeServiceOptions {
  configDir: string;
  command?: string;
  args?: readonly string[];
  cliArgsPrefix?: readonly string[];
  versionArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  refreshTimeoutMs?: number;
  loginStartTimeoutMs?: number;
  loginTtlMs?: number;
  installer?: CodexRuntimeInstaller;
  /** Interactive-lane pool size. Defaults to {@link DEFAULT_INTERACTIVE_POOL_SIZE};
   *  0 makes top-level interactive and background turns share the owner runtime. */
  interactivePoolSize?: number;
  /** Capacity for independent inference and each lazily created nested depth. */
  inferencePoolSize?: number;
  /** Current application subagent nesting cap; two further levels serve leaf inference. */
  getSubagentDepthCap?: () => number;
}

export class CodexRuntimeService {
  private readonly paths: ReturnType<typeof codexPaths>;
  private readonly codexHome: string;
  private readonly workspaceDir: string;
  private readonly cliArgsPrefix: readonly string[];
  private readonly versionArgs: readonly string[];
  private readonly args: readonly string[] | undefined;
  private readonly commandOverride: string | undefined;
  private readonly interactivePoolSize: number;
  private readonly inferencePoolSize: number;
  private readonly getSubagentDepthCap: () => number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly supervisor: CodexGenerationSupervisor;
  private readonly updater: CodexRuntimeUpdater;
  private readonly lifecycle: CodexRuntimeLifecycle;
  private readonly backgroundRunner: CodexTurnRunner;
  private readonly interactiveRunner: CodexTurnRunner;
  private readonly inferenceRunner: CodexTurnRunner;
  private readonly refreshTimeoutMs: number;
  private refreshEpoch = 0;
  private refreshInFlight: {
    epoch: number;
    promise: Promise<CodexBackendStatus>;
  } | null = null;
  private status: CodexBackendStatus = {
    type: "codex",
    configured: false,
    status: "unreachable",
    loggedIn: false,
    models: [],
    reason: "Codex is not configured.",
  };

  constructor(opts: CodexRuntimeServiceOptions) {
    const paths = codexPaths(opts.configDir);
    this.paths = paths;
    this.codexHome = paths.home;
    this.workspaceDir = paths.workspace;
    this.versionArgs = opts.versionArgs ?? DEFAULT_CODEX_VERSION_ARGS;
    this.args = opts.args;
    this.commandOverride = opts.command?.trim() || undefined;
    this.cliArgsPrefix = opts.cliArgsPrefix ?? inferCliArgsPrefix(this.versionArgs);
    this.env = opts.env ?? process.env;
    this.interactivePoolSize = opts.interactivePoolSize ?? DEFAULT_INTERACTIVE_POOL_SIZE;
    this.inferencePoolSize = opts.inferencePoolSize ?? DEFAULT_INFERENCE_POOL_SIZE;
    for (const [name, value, minimum] of [
      ["interactivePoolSize", this.interactivePoolSize, 0],
      ["inferencePoolSize", this.inferencePoolSize, 1],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`Codex ${name} must be an integer of at least ${minimum}`);
      }
    }
    this.getSubagentDepthCap = opts.getSubagentDepthCap ?? (() => 2);
    this.supervisor = new CodexGenerationSupervisor(this.createGeneration());
    this.backgroundRunner = this.laneRunner("background");
    this.interactiveRunner = this.laneRunner("interactive");
    this.inferenceRunner = this.laneRunner("inference");
    this.refreshTimeoutMs = opts.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    this.updater = new CodexRuntimeUpdater({
      installer:
        opts.installer ?? new CodexRuntimeInstaller({ configDir: opts.configDir, env: this.env }),
      supervisor: this.supervisor,
      commandOverride: this.commandOverride,
      refreshTimeoutMs: this.refreshTimeoutMs,
      createGeneration: (commandInfo) => this.createGeneration(commandInfo),
      validateGeneration: async (generation) => {
        await generation.runtime.probeRuntime(this.refreshTimeoutMs);
        const models = await generation.runtime.listModels(this.refreshTimeoutMs);
        if (models.length === 0) {
          throw new Error("The replacement Codex runtime returned an empty model catalog.");
        }
      },
      describeRuntime: () => this.describeRuntime(),
      refresh: () => this.refresh(),
      status: () => this.status,
      loginBusy: () => this.lifecycle.busy,
    });
    this.lifecycle = new CodexRuntimeLifecycle({
      codexHome: this.codexHome,
      cliArgsPrefix: this.cliArgsPrefix,
      env: this.env,
      refreshTimeoutMs: this.refreshTimeoutMs,
      loginStartTimeoutMs: opts.loginStartTimeoutMs ?? DEFAULT_LOGIN_START_TIMEOUT_MS,
      loginTtlMs: opts.loginTtlMs ?? DEFAULT_LOGIN_TTL_MS,
      supervisor: this.supervisor,
      ensureSelectedRuntime: () => this.updater.ensureSelectedRuntime(),
      updateInProgress: () => this.updater.isUpdating,
      refresh: () => this.refresh(),
      invalidateRefresh: () => {
        this.refreshEpoch += 1;
      },
      describeRuntime: () => this.describeRuntime(),
      setStatus: (status) => {
        this.status = status;
      },
    });
  }

  snapshot(): CodexBackendStatus {
    return this.status;
  }

  private createGeneration(commandInfo?: CodexRuntimeCommandInfo): CodexRuntimeGeneration {
    const command = commandInfo ? undefined : this.commandOverride;
    const runtimeOptions = {
      command,
      commandInfo,
      args: this.args,
      versionArgs: this.versionArgs,
      env: this.env,
    };
    const runtime = new CodexAppServerRuntime({
      ...runtimeOptions,
      codexHome: this.codexHome,
      workspaceDir: this.workspaceDir,
      logger: log.child("runtime"),
    });
    const interactivePool =
      this.interactivePoolSize > 0
        ? new CodexRuntimePool({
            runtimeOptions,
            sharedHome: this.codexHome,
            poolHomeBase: this.paths.poolHomeBase,
            poolWorkspaceBase: this.paths.poolWorkspaceBase,
            size: this.interactivePoolSize,
            logger: log.child("pool"),
          })
        : null;
    const makeAuxiliaryPool = (name: string): CodexRuntimePool =>
      new CodexRuntimePool({
        runtimeOptions,
        sharedHome: this.codexHome,
        poolHomeBase: join(this.paths.poolHomeBase, name),
        poolWorkspaceBase: join(this.paths.poolWorkspaceBase, name),
        size: this.inferencePoolSize,
        logger: log.child(name),
      });
    const nestedPools = new Map<number, CodexRuntimePool>();
    return {
      runtime,
      interactivePool,
      inferencePool: makeAuxiliaryPool("inference"),
      nestedPools,
      nestedPool: (depth) => {
        const limit = this.getSubagentDepthCap() + 2;
        if (!Number.isSafeInteger(limit) || depth > limit) {
          throw new Error(
            `Codex nested execution depth ${depth} exceeds the configured limit ${limit}`,
          );
        }
        let pool = nestedPools.get(depth);
        if (!pool) {
          pool = makeAuxiliaryPool(`nested-${depth}`);
          nestedPools.set(depth, pool);
        }
        return pool;
      },
    };
  }

  createBackend(opts: {
    model: string;
    reasoningEffort?: string;
    maxToolIterations?: number;
    lane?: CodexLane;
  }): CodexAppServerBackend {
    // Interactive turns spread across the pool (up to N concurrent); background
    // turns serialize on the owner. Inference and nested calls have independent
    // capacity even when the interactive pool is disabled.
    const runtime =
      opts.lane === "background"
        ? this.backgroundRunner
        : opts.lane === "inference"
          ? this.inferenceRunner
          : this.interactiveRunner;
    return new CodexAppServerBackend({
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      codexHome: this.codexHome,
      workspaceDir: this.workspaceDir,
      runtime,
      maxToolIterations: opts.maxToolIterations,
      finalAnswerOnly: opts.lane === "inference",
    });
  }

  private laneRunner(lane: CodexLane): CodexTurnRunner {
    return {
      runTurn: (opts) => this.runOnSelectedGeneration(lane, opts),
    };
  }

  private async *runOnSelectedGeneration(
    lane: CodexLane,
    opts: CodexRuntimeTurnOptions,
  ): AsyncIterable<import("@omnesis/core").AgentEvent> {
    await this.updater.ensureSelectedRuntime();
    yield* this.supervisor.runner(lane).runTurn(opts);
  }

  async dispose(): Promise<void> {
    await Promise.all([this.updater.dispose(), this.lifecycle.dispose()]);
    await this.supervisor.dispose();
  }

  async getRuntimeUpdate(): Promise<CodexRuntimeUpdateSnapshot> {
    return this.updater.get();
  }

  async startRuntimeUpdate(opts: { dryRun: boolean }): Promise<CodexRuntimeUpdateSnapshot> {
    return this.updater.start(opts);
  }

  async cancelRuntimeUpdate(): Promise<CodexRuntimeUpdateSnapshot> {
    return this.updater.cancel();
  }

  refresh(): Promise<CodexBackendStatus> {
    const epoch = this.refreshEpoch;
    if (this.refreshInFlight?.epoch === epoch) return this.refreshInFlight.promise;
    this.status = {
      ...this.status,
      status: "probing",
      reason: undefined,
    };
    const promise = this.supervisor
      .use(async () => {
        const status = await this.computeStatus();
        const runtimeUpdate = await this.updater.computePlan();
        const enriched = { ...status, runtimeUpdate };
        if (epoch !== this.refreshEpoch) return this.status;
        this.status = enriched;
        return enriched;
      })
      .catch((err) => {
        if (epoch !== this.refreshEpoch) return this.status;
        const status: CodexBackendStatus = {
          type: "codex",
          configured: this.hasStoredAuth(),
          status: "unreachable",
          loggedIn: false,
          models: [],
          reason: conciseError(err),
          refreshedAt: new Date().toISOString(),
        };
        this.status = status;
        return status;
      })
      .finally(() => {
        if (this.refreshInFlight?.promise === promise) this.refreshInFlight = null;
      });
    this.refreshInFlight = { epoch, promise };
    return promise;
  }

  setupAgent(configStore: ConfigStore, model: string): Promise<CodexAgentSetupResult> {
    return this.lifecycle
      .runAgentSetup(() => setupCodexAgent(configStore, () => this.refresh(), model))
      .catch((error) => {
        if (error instanceof CodexRuntimeLifecycleConflictError) {
          throw new CodexAgentSetupConflictError(error.message);
        }
        throw error;
      });
  }

  async startDeviceLogin(): Promise<CodexLoginFlow> {
    return this.lifecycle.startDeviceLogin();
  }

  getLoginFlow(): CodexLoginFlow | null {
    return this.lifecycle.getLoginFlow();
  }

  cancelLogin(): { ok: true; canceled: boolean; flow: CodexLoginFlow | null } {
    return this.lifecycle.cancelLogin();
  }

  async logout(): Promise<{ ok: true; status: CodexBackendStatus }> {
    return this.lifecycle.logout();
  }

  private async describeRuntime(): Promise<CodexRuntimeStatus | undefined> {
    let commandInfo: CodexRuntimeCommandInfo;
    try {
      commandInfo = await this.supervisor.current.runtime.resolveCommandInfo();
    } catch (err) {
      return {
        source: "managed",
        command: "",
        supported: false,
        reason: conciseError(err),
      };
    }

    try {
      const probe = await this.supervisor.current.runtime.probeRuntime(this.refreshTimeoutMs);
      return {
        ...commandInfo,
        version: probe.version,
        supported: true,
      };
    } catch (err) {
      return {
        ...commandInfo,
        supported: false,
        reason: conciseError(err),
      };
    }
  }

  private async computeStatus(): Promise<CodexBackendStatus> {
    const runtime = await this.describeRuntime();
    if (!this.hasStoredAuth()) {
      return {
        type: "codex",
        configured: false,
        status: "unreachable",
        loggedIn: false,
        runtime,
        models: [],
        reason: "Codex is not configured.",
        refreshedAt: new Date().toISOString(),
      };
    }

    await ensureCodexHome(this.codexHome);
    const childEnv = buildCodexEnv(this.env, this.codexHome);
    if (runtime && !runtime.supported) {
      return {
        type: "codex",
        configured: true,
        status: "unreachable",
        loggedIn: false,
        runtime,
        models: [],
        reason: runtime.reason ?? "Codex runtime is unavailable.",
        refreshedAt: new Date().toISOString(),
      };
    }
    const commandInfo = await this.supervisor.current.runtime.resolveCommandInfo();

    const loggedIn = await this.checkLoggedIn(commandInfo.command, childEnv);
    if (!loggedIn.ok) {
      return {
        type: "codex",
        configured: true,
        status: "unreachable",
        loggedIn: false,
        runtime,
        models: [],
        reason: loggedIn.reason,
        refreshedAt: new Date().toISOString(),
      };
    }

    const discovered = await this.discoverModels(commandInfo.command, childEnv);
    const modelDetails = discovered.modelDetails;
    if (modelDetails.length === 0) {
      return {
        type: "codex",
        configured: true,
        status: "unreachable",
        loggedIn: true,
        runtime,
        models: [],
        reason: "Codex returned an empty model catalog.",
        refreshedAt: new Date().toISOString(),
      };
    }
    const models = modelDetails.map((m) => m.id);
    return {
      type: "codex",
      configured: true,
      status: "ok",
      loggedIn: true,
      runtime,
      models,
      modelDetails,
      discovery: discovered.discovery,
      modelRoles: codexModelRoles(modelDetails),
      refreshedAt: new Date().toISOString(),
    };
  }

  private async discoverModels(
    command: string,
    childEnv: NodeJS.ProcessEnv,
  ): Promise<{ discovery: "app-server" | "debug-models"; modelDetails: CodexModelStatus[] }> {
    try {
      const modelDetails = parseCodexAppServerModels(
        await this.supervisor.current.runtime.listModels(this.refreshTimeoutMs),
      );
      if (modelDetails.length > 0) {
        return { discovery: "app-server", modelDetails };
      }
      log.warn(
        "Codex app-server model/list returned an empty catalog; falling back to debug models",
      );
    } catch (err) {
      log.warn(
        `Codex app-server model/list failed; falling back to debug models: ${conciseError(err)}`,
      );
    }

    const result = await execFileAsync(command, [...this.cliArgsPrefix, "debug", "models"], {
      env: childEnv,
      timeout: this.refreshTimeoutMs,
      maxBuffer: CODEX_MODEL_LIST_MAX_BUFFER,
      windowsHide: true,
    });
    return {
      discovery: "debug-models",
      modelDetails: parseCodexModelsJson(String(result.stdout)),
    };
  }

  private async checkLoggedIn(
    command: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await execFileAsync(command, [...this.cliArgsPrefix, "login", "status"], {
        env,
        timeout: this.refreshTimeoutMs,
        windowsHide: true,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: `Codex is not logged in (${conciseError(err)}).` };
    }
  }

  private hasStoredAuth(): boolean {
    return existsSync(join(this.codexHome, "auth.json"));
  }
}

export function parseCodexModelsJson(stdout: string): CodexModelStatus[] {
  const parsed = JSON.parse(stdout) as { models?: unknown };
  if (!Array.isArray(parsed.models)) return [];
  return parsed.models.flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = stringValue(value.slug)?.trim();
    if (!id) return [];
    const visibility = stringValue(value.visibility);
    if (visibility && visibility !== "list") return [];
    if (value.upgrade != null) return [];
    const defaultReasoningEffort = stringValue(value.default_reasoning_effort);
    const supportedReasoningEfforts = codexReasoningEfforts(value.supported_reasoning_efforts);
    return [
      {
        id,
        name: stringValue(value.display_name) ?? id,
        description: stringValue(value.description),
        recommended: value.priority === 0,
        inputModalities: codexInputModalities(value.input_modalities),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
      },
    ];
  });
}

export function parseCodexAppServerModels(models: unknown[]): CodexModelStatus[] {
  return models.flatMap((value) => {
    if (!isRecord(value)) return [];
    const id = stringValue(value.model) ?? stringValue(value.id);
    if (!id) return [];
    if (value.hidden === true) return [];
    if (value.upgrade != null || value.upgradeInfo != null) return [];
    const defaultReasoningEffort = stringValue(value.defaultReasoningEffort);
    const supportedReasoningEfforts = codexReasoningEfforts(value.supportedReasoningEfforts);
    return [
      {
        id,
        name: stringValue(value.displayName) ?? id,
        description: stringValue(value.description),
        recommended: value.isDefault === true,
        inputModalities: codexInputModalities(value.inputModalities),
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
      },
    ];
  });
}

function codexReasoningEfforts(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const efforts = value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item] : [];
    if (!isRecord(item)) return [];
    const effort = stringValue(item.reasoningEffort)?.trim();
    return effort ? [effort] : [];
  });
  return efforts.length > 0 ? [...new Set(efforts)] : undefined;
}

function codexInputModalities(value: unknown): Array<"text" | "image"> {
  // Codex model/list defaults missing modality metadata to text and image.
  if (!Array.isArray(value)) return ["text", "image"];
  return value.filter((item): item is "text" | "image" => item === "text" || item === "image");
}

function codexModelRoles(models: CodexModelStatus[]): Record<string, CapabilityRole[]> {
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      CODEX_SUPPORTED_ROLES.filter(
        (role) => role !== "ocr" || model.inputModalities?.includes("image"),
      ),
    ]),
  );
}

function inferCliArgsPrefix(versionArgs: readonly string[]): readonly string[] {
  if (versionArgs.length <= 1) return [];
  const last = versionArgs[versionArgs.length - 1];
  return last === "--version" ? versionArgs.slice(0, -1) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function conciseError(err: unknown): string {
  if (err instanceof Error) return oneLine(err.message);
  return oneLine(String(err));
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "unknown error";
}
