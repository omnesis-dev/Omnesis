// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

import {
  ClaudeCodeBackend,
  ClaudeCodeRuntime,
  type ClaudeCodeModelInfo,
  type ClaudeCodeTurnOptions,
  type ClaudeCodeTurnRunner,
} from "@omnesis/agent";
import {
  CLAUDE_CODE_SUPPORTED_ROLES,
  createLogger,
  type AgentEvent,
  type CapabilityRole,
  type ClaudeCodeBackendStatus,
  type ClaudeCodeModelStatus,
} from "@omnesis/core";
import { setupAgentAssignment, type AgentSetupResult } from "./agent-assignment-setup.js";
import type { ConfigStore } from "../config-store.js";

const log = createLogger("gateway:models:claude-code");

/** Empty directory each Claude Code turn runs in, inside the config dir. */
const CLAUDE_CODE_WORKSPACE_DIR = "claude-code-workspace";

const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

/**
 * A Claude Code turn's lane. Every turn is its own `claude` process, so a lane
 * is just a bound on how many run at once: conversations get latency
 * isolation from background work, and single-shot inference (judges, OCR) has
 * its own capacity so it is never stuck behind a long agent turn.
 */
export type ClaudeCodeLane = "interactive" | "background" | "inference";

const DEFAULT_LANE_CAPACITY: Readonly<Record<ClaudeCodeLane, number>> = Object.freeze({
  interactive: 3,
  background: 1,
  inference: 2,
});

export interface ClaudeCodeServiceOptions {
  configDir: string;
  /** Explicit `claude` executable; otherwise PATH and the installers' locations. */
  command?: string;
  env?: NodeJS.ProcessEnv;
  refreshTimeoutMs?: number;
  laneCapacity?: Partial<Record<ClaudeCodeLane, number>>;
  /** Current application sub-agent nesting cap; two further levels serve leaf inference. */
  getSubagentDepthCap?: () => number;
  /** Further environment-variable prefixes passed to the CLI, for test doubles. */
  passEnvPrefixes?: readonly string[];
}

/**
 * The turn whose tool is running. `open` closes when that tool call settles,
 * so work a tool merely schedules (a timer, a queued job) and that starts a
 * turn later is not mistaken for a nested turn.
 */
interface ToolScope {
  depth: number;
  open: boolean;
}

/**
 * The gateway's handle on the operator's own Claude Code CLI: its readiness,
 * its model catalog, and backends that run turns on it under lane admission.
 */
export class ClaudeCodeService {
  private readonly runtime: ClaudeCodeRuntime;
  private readonly refreshTimeoutMs: number;
  private readonly lanes: Record<ClaudeCodeLane, Semaphore>;
  /** Capacity for turns started from a running turn's tool, one lane per depth. */
  private readonly nestedLanes = new Map<number, Semaphore>();
  private readonly nestedCapacity: number;
  private readonly getSubagentDepthCap: () => number;
  private readonly turnContext = new AsyncLocalStorage<ToolScope>();
  private refreshInFlight: Promise<ClaudeCodeBackendStatus> | null = null;
  private status: ClaudeCodeBackendStatus = {
    type: "claude-code",
    installed: false,
    status: "unreachable",
    loggedIn: false,
    models: [],
    reason: "Claude Code has not been checked yet.",
  };

  constructor(opts: ClaudeCodeServiceOptions) {
    this.runtime = new ClaudeCodeRuntime({
      workspaceDir: join(opts.configDir, CLAUDE_CODE_WORKSPACE_DIR),
      command: opts.command,
      env: opts.env,
      passEnvPrefixes: opts.passEnvPrefixes,
      logger: log.child("runtime"),
    });
    this.refreshTimeoutMs = opts.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    const capacity = { ...DEFAULT_LANE_CAPACITY, ...opts.laneCapacity };
    this.nestedCapacity = capacity.inference;
    this.getSubagentDepthCap = opts.getSubagentDepthCap ?? (() => 2);
    this.lanes = {
      interactive: new Semaphore(capacity.interactive),
      background: new Semaphore(capacity.background),
      inference: new Semaphore(capacity.inference),
    };
  }

  snapshot(): ClaudeCodeBackendStatus {
    return this.status;
  }

  refresh(): Promise<ClaudeCodeBackendStatus> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.status = { ...this.status, status: "probing", reason: undefined };
    const promise = this.computeStatus()
      .catch(
        (err): ClaudeCodeBackendStatus => ({
          type: "claude-code",
          installed: false,
          status: "unreachable",
          loggedIn: false,
          models: [],
          reason: conciseError(err),
          refreshedAt: new Date().toISOString(),
        }),
      )
      .then((status) => {
        this.status = status;
        return status;
      })
      .finally(() => {
        this.refreshInFlight = null;
      });
    this.refreshInFlight = promise;
    return promise;
  }

  createBackend(opts: {
    model: string;
    reasoningEffort?: string;
    maxToolIterations?: number;
    lane?: ClaudeCodeLane;
  }): ClaudeCodeBackend {
    const lane = opts.lane ?? "interactive";
    return new ClaudeCodeBackend({
      model: opts.model,
      effort: opts.reasoningEffort,
      runtime: this.laneRunner(lane),
      maxToolIterations: opts.maxToolIterations,
      finalAnswerOnly: lane === "inference",
    });
  }

  setupAgent(configStore: ConfigStore, model: string): Promise<AgentSetupResult> {
    return setupAgentAssignment({
      configStore,
      backend: "claude-code",
      label: "Claude Code",
      refreshStatus: () => this.refresh(),
      model,
    });
  }

  private laneRunner(lane: ClaudeCodeLane): ClaudeCodeTurnRunner {
    return { runTurn: (opts) => this.runAdmitted(lane, opts) };
  }

  /**
   * Run a turn once its lane has room. A turn started while another turn's
   * tool is running (a sub-agent, a judge) waits on a lane for its nesting
   * depth instead: its parent holds a slot and is waiting on it, so sharing the
   * parent's lane could deadlock, while one lane per depth keeps fan-out
   * bounded.
   */
  private async *runAdmitted(
    lane: ClaudeCodeLane,
    opts: ClaudeCodeTurnOptions,
  ): AsyncIterable<AgentEvent> {
    const parent = this.turnContext.getStore();
    const depth = parent?.open ? parent.depth + 1 : 0;
    const release = await (depth === 0 ? this.lanes[lane] : this.nestedLane(depth)).acquire(
      opts.signal,
    );
    try {
      const input = {
        ...opts.input,
        tools: opts.input.tools.map((tool) => ({
          ...tool,
          invoke: async (...args: Parameters<typeof tool.invoke>) => {
            const scope: ToolScope = { depth, open: true };
            try {
              return await this.turnContext.run(scope, () => tool.invoke(...args));
            } finally {
              scope.open = false;
            }
          },
        })),
      };
      yield* this.runtime.runTurn({ ...opts, input });
    } finally {
      release();
    }
  }

  private nestedLane(depth: number): Semaphore {
    const limit = this.getSubagentDepthCap() + 2;
    if (depth > limit) {
      throw new Error(`Claude Code nested turn depth ${depth} exceeds the limit ${limit}`);
    }
    let lane = this.nestedLanes.get(depth);
    if (!lane) {
      lane = new Semaphore(this.nestedCapacity);
      this.nestedLanes.set(depth, lane);
    }
    return lane;
  }

  private async computeStatus(): Promise<ClaudeCodeBackendStatus> {
    const refreshedAt = (): string => new Date().toISOString();
    let command: string;
    try {
      this.runtime.forgetCommand();
      command = await this.runtime.resolveCommand();
    } catch (err) {
      return {
        type: "claude-code",
        installed: false,
        status: "unreachable",
        loggedIn: false,
        models: [],
        reason: conciseError(err),
        refreshedAt: refreshedAt(),
      };
    }

    let probe: Awaited<ReturnType<ClaudeCodeRuntime["probeVersion"]>>;
    try {
      probe = await this.runtime.probeVersion(this.refreshTimeoutMs);
    } catch (err) {
      return {
        type: "claude-code",
        installed: false,
        status: "unreachable",
        loggedIn: false,
        runtime: { command, supported: false, reason: conciseError(err) },
        models: [],
        reason: conciseError(err),
        refreshedAt: refreshedAt(),
      };
    }
    if (!probe.supported) {
      return {
        type: "claude-code",
        installed: true,
        status: "unreachable",
        loggedIn: false,
        runtime: { command, version: probe.version, supported: false, reason: probe.reason },
        models: [],
        reason: probe.reason,
        refreshedAt: refreshedAt(),
      };
    }
    const runtime = { command, version: probe.version, supported: true };

    let auth: Awaited<ReturnType<ClaudeCodeRuntime["authStatus"]>>;
    try {
      auth = await this.runtime.authStatus(this.refreshTimeoutMs);
    } catch (err) {
      return {
        type: "claude-code",
        installed: true,
        status: "unreachable",
        loggedIn: false,
        runtime,
        models: [],
        reason: `Could not read the Claude Code login: ${conciseError(err)}`,
        refreshedAt: refreshedAt(),
      };
    }
    const account =
      auth.authMethod || auth.subscriptionType
        ? {
            ...(auth.authMethod ? { authMethod: auth.authMethod } : {}),
            ...(auth.subscriptionType ? { subscriptionType: auth.subscriptionType } : {}),
          }
        : undefined;
    if (!auth.loggedIn) {
      return {
        type: "claude-code",
        installed: true,
        status: "unreachable",
        loggedIn: false,
        runtime,
        models: [],
        reason: "Claude Code is not signed in. Run `claude auth login` on the gateway host.",
        refreshedAt: refreshedAt(),
      };
    }

    let modelDetails: ClaudeCodeModelStatus[];
    try {
      modelDetails = toModelStatuses(await this.runtime.listModels(this.refreshTimeoutMs));
    } catch (err) {
      return {
        type: "claude-code",
        installed: true,
        status: "unreachable",
        loggedIn: true,
        ...(account ? { account } : {}),
        runtime,
        models: [],
        reason: `Could not read the Claude Code model catalog: ${conciseError(err)}`,
        refreshedAt: refreshedAt(),
      };
    }
    if (modelDetails.length === 0) {
      return {
        type: "claude-code",
        installed: true,
        status: "unreachable",
        loggedIn: true,
        ...(account ? { account } : {}),
        runtime,
        models: [],
        reason: "Claude Code returned an empty model catalog.",
        refreshedAt: refreshedAt(),
      };
    }
    return {
      type: "claude-code",
      installed: true,
      status: "ok",
      loggedIn: true,
      ...(account ? { account } : {}),
      runtime,
      models: modelDetails.map((m) => m.id),
      modelDetails,
      modelRoles: Object.fromEntries(
        modelDetails.map((m) => [m.id, [...CLAUDE_CODE_SUPPORTED_ROLES] as CapabilityRole[]]),
      ),
      refreshedAt: refreshedAt(),
    };
  }
}

function toModelStatuses(models: ClaudeCodeModelInfo[]): ClaudeCodeModelStatus[] {
  return models.map((m) => ({
    id: m.value,
    name: m.displayName ?? m.value,
    ...(m.description ? { description: m.description } : {}),
    ...(m.resolvedModel && m.resolvedModel !== m.value ? { resolvedModel: m.resolvedModel } : {}),
    inputModalities: ["text", "image"],
    ...(m.supportedEffortLevels ? { supportedReasoningEfforts: m.supportedEffortLevels } : {}),
  }));
}

/** FIFO counting semaphore whose waits can be abandoned through an AbortSignal. */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error(`Claude Code lane capacity must be a positive integer (got ${capacity})`);
    }
    this.available = capacity;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.available > 0) {
      this.available -= 1;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener("abort", abandon);
        resolve();
      };
      const abandon = (): void => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", abandon, { once: true });
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

function conciseError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim() || "unknown error";
}
