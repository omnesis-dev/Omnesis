// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Codex app-server backend.
 *
 * This is intentionally a thin runtime adapter: Omnesis keeps owning the
 * conversation store, system prompt, and tool registry; Codex supplies only the
 * agent loop underneath. Every turn starts a fresh ephemeral Codex thread and
 * replays Omnesis' canonical transcript as text context, so Omnesis remains the
 * durable source of truth.
 */

import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type ExecFileException,
} from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import {
  createLogger,
  nodeCommandInvocation,
  spawnWindowsJob,
  execWindowsJob,
  readPackageVersion,
  atomicWriteFile,
  codexKeyringAccount,
  type AgentContextAssessment,
  type AgentEvent,
  type Logger,
  type ToolResult,
  type NodeCommandInvocation,
  managedDesktopCatalogDiscoveryInvocation,
} from "@omnesis/core";

import { assertManagedDesktopProcessAuthority } from "@omnesis/core/node-command";
import { readJsonRpcLines, encodeJsonRpcLine } from "./json-rpc-lines.js";
import { markActivity } from "./activity.js";
import { codexPoolAuthOwner, prepareCodexPrivateState } from "./codex-private-state.js";
import { toolInputJsonSchema } from "./zod-to-json-schema.js";
import { stripLocalTimeAnnotationsDeep } from "./local-times.js";
import { serializeToolResultForModel } from "./tool-result-text.js";
import { renderTranscriptUserInput } from "./transcript-user-input.js";
import {
  childEventHooks,
  DEFAULT_MAX_TOOL_ITERATIONS,
  probeTurnEvents,
  safeJsonParse,
  summarizeToolArgs,
  toolResultHasErrors,
  wrapEvent,
} from "./backend.js";
import { CODEX_RUNTIME_COMPAT, isSupportedCodexCliVersion } from "./codex-compat.js";
import {
  assertNoManagedCodexAuthFile,
  assertManagedCodexPolicy,
  managedCodexArgs,
  managedCodexAuth,
} from "./codex-managed-auth.js";
import {
  prepareManagedCodexModelCatalog,
  assertManagedCodexStaticCatalog,
  type PreparedManagedCodexCatalog,
  type ManagedCatalogPlatform,
} from "./codex-managed-model-discovery.js";
import { resolveManagedCodexNativeCommand } from "./codex-managed-native-command.js";
import { CONTEXT_WINDOW_EXCEEDED_MESSAGE } from "./turn-outcome.js";
import {
  assertManagedCodexEffectiveFeatures,
  assertManagedCodexWorkspace,
  managedCodexThreadConfig,
} from "./codex-managed-process.js";
import type { ChatBackend, ToolCaller, ToolHandle, TurnInput } from "./backend.js";

export { isSupportedCodexCliVersion } from "./codex-compat.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const log = createLogger("agent:codex");
const AGENT_VERSION = readPackageVersion(import.meta.url);

export const MANAGED_CODEX_PACKAGE = CODEX_RUNTIME_COMPAT.packageName;
export const MANAGED_CODEX_PACKAGE_VERSION = CODEX_RUNTIME_COMPAT.testedVersion;
const DEFAULT_CODEX_ARGS = ["app-server", "--listen", "stdio://"] as const;
const DEFAULT_CODEX_VERSION_ARGS = ["--version"] as const;
const DEFAULT_CODEX_WORKSPACE_DIRNAME = "workspace";

const SAFE_CODEX_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
]);
const SAFE_CODEX_ENV_PREFIXES = ["OMNESIS_FAKE_CODEX_"];

const NATIVE_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "collabAgentToolCall",
  "subAgentActivity",
  "webSearch",
  "imageView",
  "imageGeneration",
  "sleep",
]);

const STRICT_CODEX_CONFIG_TOML = `approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[features]
shell_tool = false
unified_exec = false
multi_agent = false
apps = false
memories = false
personality = false

[sandbox_workspace_write]
network_access = false
`;

const STRICT_CODEX_CONFIG_OBJECT = {
  approval_policy: "never",
  sandbox_mode: "read-only",
  web_search: "disabled",
  features: {
    shell_tool: false,
    unified_exec: false,
    multi_agent: false,
    apps: false,
    memories: false,
    personality: false,
  },
  sandbox_workspace_write: {
    network_access: false,
  },
} as const;

export type CodexRuntimeSource = "managed" | "override";

export interface CodexRuntimeCommandInfo {
  source: CodexRuntimeSource;
  command: string;
  packageName?: string;
  packageVersion?: string;
}

export interface CodexRuntimeProbe {
  command: string;
  version: string;
}

export interface CodexAppServerRuntimeOptions {
  /** Dedicated Omnesis-owned CODEX_HOME. Never point this at the user's ~/.codex. */
  codexHome: string;
  /** An isolated installer probe can never list selectable models or start a conversation. */
  purpose?: "compatibility-probe";
  /** Separate worker SQLite/log directory when the managed credential home is shared. */
  stateHome?: string;
  /** Empty Omnesis-owned working directory handed to Codex as cwd. */
  workspaceDir?: string;
  /** Advanced override. When unset, Omnesis uses its pinned managed @openai/codex runtime. */
  command?: string;
  /** Pre-resolved gateway-owned managed runtime. Takes precedence over package resolution. */
  commandInfo?: CodexRuntimeCommandInfo;
  /** Explicit OS adapter for fixtures; production resolves the pinned native asset directly. */
  resolveManagedCommand?: (info: CodexRuntimeCommandInfo) => Promise<CodexRuntimeCommandInfo>;
  /** Explicit native lock adapter for source fixtures; never read from environment. */
  managedCatalogPlatform?: ManagedCatalogPlatform;
  args?: readonly string[];
  versionArgs?: readonly string[];
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Maximum silence between meaningful model events, excluding pending tool work. */
  turnIdleTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
}

/** The turn options a Codex backend hands its runtime. */
export interface CodexRuntimeTurnOptions {
  model: string;
  reasoningEffort?: string;
  input: TurnInput;
  toolTimeoutMs: number;
  maxToolIterations: number;
  signal?: AbortSignal;
}

/** The turn interface {@link CodexAppServerBackend} depends on. Satisfied by a
 *  single {@link CodexAppServerRuntime} and by the multi-process
 *  {@link CodexRuntimePool}, so the backend is agnostic to which it holds. */
export interface CodexTurnRunner {
  runTurn(opts: CodexRuntimeTurnOptions): AsyncIterable<AgentEvent>;
}

export interface CodexAppServerBackendOptions extends CodexAppServerRuntimeOptions {
  /** Exclude commentary from single-shot inference outputs. */
  finalAnswerOnly?: boolean;
  model: string;
  reasoningEffort?: string;
  toolTimeoutMs?: number;
  maxToolIterations?: number;
  runtime?: CodexTurnRunner;
}

export interface CodexDynamicToolSpec {
  type: "function";
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function unconfirmedCodexCleanup(
  cleanupFailure: unknown,
  primaryFailure?: unknown,
): Error & { cleanupFailure: unknown } {
  return Object.assign(
    new Error("Codex process cleanup was not confirmed; runtime reuse is blocked", {
      cause:
        primaryFailure === undefined
          ? cleanupFailure
          : new AggregateError(
              [primaryFailure, cleanupFailure],
              "Codex process failed and cleanup was not confirmed",
            ),
    }),
    { cleanupFailure },
  );
}

function hasCodexCleanupFailure(error: unknown): error is { cleanupFailure: unknown } {
  return error !== null && typeof error === "object" && "cleanupFailure" in error;
}

export class CodexAppServerRuntime {
  readonly codexHome: string;
  readonly workspaceDir: string;
  private readonly stateHome: string;
  private readonly protocolOnly: boolean;

  private readonly commandOverride: string | undefined;
  private readonly configuredCommandInfo: CodexRuntimeCommandInfo | undefined;
  private readonly resolveManagedCommand: typeof resolveManagedCodexNativeCommand;
  private readonly managedCatalogPlatform: ManagedCatalogPlatform | undefined;
  private managedCatalog: PreparedManagedCodexCatalog | undefined;
  private managedPolicyProbe: Promise<void> | null = null;
  private protocolProbe: Promise<void> | null = null;
  private readonly args: readonly string[];
  private readonly versionArgs: readonly string[];
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly turnIdleTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: Logger;

  private client: CodexJsonRpcClient | null = null;
  private startingClient: Promise<CodexJsonRpcClient> | null = null;
  private commandInfo: CodexRuntimeCommandInfo | null = null;
  private activeTurn: ActiveCodexTurn | null = null;
  private turnQueue: Promise<void> = Promise.resolve();
  private cleanupFailure: unknown;
  private retiringClient: Promise<void> | undefined;
  private disposal: Promise<void> | undefined;
  private disposed = false;
  private managedProcessVersion: string | undefined;

  constructor(opts: CodexAppServerRuntimeOptions) {
    this.codexHome = opts.codexHome;
    this.protocolOnly = opts.purpose === "compatibility-probe";
    if (
      this.protocolOnly &&
      (!opts.workspaceDir ||
        basename(dirname(opts.codexHome)) !== ".omnesis-compat-probe" ||
        basename(opts.codexHome) !== "home" ||
        opts.workspaceDir !== join(dirname(opts.codexHome), "workspace"))
    )
      throw new Error("Compatibility probes require their isolated owned home and workspace");
    this.workspaceDir = opts.workspaceDir ?? join(opts.codexHome, DEFAULT_CODEX_WORKSPACE_DIRNAME);
    this.commandOverride = opts.command?.trim() || undefined;
    this.configuredCommandInfo = opts.commandInfo;
    this.resolveManagedCommand = opts.resolveManagedCommand ?? resolveManagedCodexNativeCommand;
    this.managedCatalogPlatform = opts.managedCatalogPlatform;
    this.stateHome = opts.stateHome ?? opts.codexHome;
    this.args = managedCodexArgs(
      opts.env ?? process.env,
      opts.args ?? DEFAULT_CODEX_ARGS,
      this.stateHome,
    );
    this.versionArgs = opts.versionArgs ?? DEFAULT_CODEX_VERSION_ARGS;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.turnIdleTimeoutMs = opts.turnIdleTimeoutMs ?? 300_000;
    if (!Number.isSafeInteger(this.turnIdleTimeoutMs) || this.turnIdleTimeoutMs <= 0)
      throw new Error("Codex turn idle timeout must be a positive integer");
    this.env = opts.env ?? process.env;
    this.log = opts.logger ?? log;
  }

  private assertCleanupConfirmed(): void {
    if (this.cleanupFailure !== undefined) throw unconfirmedCodexCleanup(this.cleanupFailure);
  }

  private assertManagedProfile(): void {
    if (
      !managedCodexAuth(this.env) ||
      this.resolveManagedCommand !== resolveManagedCodexNativeCommand
    )
      return;
    const configDir = this.env.OMNESIS_CONFIG_DIR,
      instance = this.env.OMNESIS_SERVICE_INSTANCE,
      secretService = this.env.OMNESIS_SECRET_SERVICE;
    if (!configDir || !instance || !secretService)
      throw new Error("Managed SDK startup requires its exact installation profile");
    assertManagedDesktopProcessAuthority({ configDir, instance, secretService });
    if (this.protocolOnly) {
      const slot = relative(join(configDir, "codex-runtimes", "staging"), this.codexHome);
      const parts = slot.split(sep);
      if (
        isAbsolute(slot) ||
        parts.length !== 3 ||
        !/^[a-zA-Z0-9_-]{1,128}$/u.test(parts[0] ?? "") ||
        parts[1] !== ".omnesis-compat-probe" ||
        parts[2] !== "home"
      )
        throw new Error(
          "Managed SDK compatibility probes require this installation's staging slot",
        );
    } else if (this.codexHome !== join(configDir, "codex-home", instance))
      throw new Error("Managed SDK credentials must remain in this installation's scoped home");
    for (const path of [this.workspaceDir, this.stateHome]) {
      const owned = relative(configDir, path);
      if (!owned || isAbsolute(owned) || owned === ".." || owned.startsWith(`..${sep}`))
        throw new Error(
          "Managed SDK workspaces and diagnostics must remain inside this installation",
        );
    }
  }

  async resolveCommandInfo(): Promise<CodexRuntimeCommandInfo> {
    this.assertCleanupConfirmed();
    if (this.retiringClient) await this.retiringClient.catch(() => {});
    this.assertCleanupConfirmed();
    if (!this.commandInfo) {
      this.assertManagedProfile();
      const resolved =
        this.configuredCommandInfo ??
        (await resolveCodexRuntimeCommand({ commandOverride: this.commandOverride }));
      this.commandInfo = managedCodexAuth(this.env)
        ? await this.resolveManagedCommand(resolved)
        : resolved;
    }
    return this.commandInfo;
  }

  async probeRuntime(timeoutMs = this.startupTimeoutMs): Promise<CodexRuntimeProbe> {
    const started = Date.now();
    const commandInfo = await this.resolveCommandInfo();
    if (this.retiringClient) await this.retiringClient.catch(() => {});
    this.assertCleanupConfirmed();
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0)
      throw Object.assign(new Error("Codex runtime probe timed out"), { code: "ETIMEDOUT" });
    return this.probeCommandRuntime(commandInfo, remaining);
  }

  private async probeCommandRuntime(
    commandInfo: CodexRuntimeCommandInfo,
    timeoutMs: number,
  ): Promise<CodexRuntimeProbe> {
    this.assertCleanupConfirmed();
    try {
      return await assertSupportedCodexRuntime({
        command: commandInfo.command,
        args: this.versionArgs,
        env: buildCodexEnv(this.env, this.codexHome, process.platform, this.workspaceDir),
        timeoutMs,
      });
    } catch (error) {
      if (hasCodexCleanupFailure(error)) this.cleanupFailure = error;
      throw error;
    }
  }

  async listModels(timeoutMs = this.requestTimeoutMs): Promise<unknown[]> {
    if (this.protocolOnly) throw new Error("Compatibility probes cannot supply selectable models");
    const client = await this.ensureClient();
    const models: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      let result: unknown;
      try {
        result = await client.request(
          "model/list",
          { cursor, includeHidden: false, limit: 100 },
          timeoutMs,
        );
      } catch (error) {
        try {
          await client.joinIfExited();
        } catch (cleanupError) {
          this.cleanupFailure = cleanupError;
          throw unconfirmedCodexCleanup(cleanupError, error);
        }
        throw error;
      }
      const record = asRecord(result);
      const data = Array.isArray(record?.data) ? record.data : [];
      models.push(...data);
      cursor = stringField(record, "nextCursor") ?? undefined;
      if (!cursor) break;
    }
    return models;
  }

  /** Metadata-only compatibility probe. Its private client is never eligible for a conversation. */
  probeProtocolModels(timeoutMs = this.startupTimeoutMs): Promise<void> {
    if (this.protocolProbe) return this.protocolProbe;
    const pending = this.runProtocolProbe(timeoutMs);
    this.protocolProbe = pending;
    return pending.finally(() => {
      if (this.protocolProbe === pending) this.protocolProbe = null;
    });
  }

  private async runProtocolProbe(timeoutMs: number): Promise<void> {
    const client = await this.startClient(true);
    let failure: unknown;
    try {
      const reply = await client.request(
        "model/list",
        { limit: 1, includeHidden: false },
        timeoutMs,
      );
      if (!asRecord(reply) || !Array.isArray(asRecord(reply)?.data))
        throw new Error("Codex model metadata compatibility could not be verified");
    } catch (error) {
      failure = error;
    }
    try {
      await client.dispose();
    } catch (error) {
      this.cleanupFailure = error;
      throw unconfirmedCodexCleanup(error, failure);
    }
    if (failure !== undefined) throw failure;
  }

  async verifyManagedCredentialPolicy(): Promise<void> {
    if (!managedCodexAuth(this.env)) return;
    if (this.managedPolicyProbe) return this.managedPolicyProbe;
    const verify = async () => {
      if (this.startingClient) await this.startingClient;
      if (this.client && this.managedCatalog) {
        assertManagedCodexPolicy(
          await this.client.request("config/read", { includeLayers: true }, this.startupTimeoutMs),
        );
        return;
      }
      const client = await this.startClient(true);
      try {
        await client.dispose();
      } catch (error) {
        this.cleanupFailure = error;
        throw unconfirmedCodexCleanup(error);
      } finally {
        if (this.client === client) this.client = null;
      }
    };
    const pending = verify();
    this.managedPolicyProbe = pending;
    try {
      await pending;
    } finally {
      if (this.managedPolicyProbe === pending) this.managedPolicyProbe = null;
    }
  }

  async *runTurn(opts: {
    model: string;
    reasoningEffort?: string;
    input: TurnInput;
    toolTimeoutMs: number;
    maxToolIterations: number;
    signal?: AbortSignal;
  }): AsyncIterable<AgentEvent> {
    const release = await this.acquireTurnSlot(opts.signal);
    try {
      yield* this.runTurnUnlocked(opts);
    } finally {
      release();
    }
  }

  private async *runTurnUnlocked(opts: {
    model: string;
    reasoningEffort?: string;
    input: TurnInput;
    toolTimeoutMs: number;
    maxToolIterations: number;
    signal?: AbortSignal;
  }): AsyncIterable<AgentEvent> {
    const { input, model, reasoningEffort, toolTimeoutMs, maxToolIterations, signal } = opts;
    const { sessionId, messageId, timeZone, caller } = input;
    yield wrapEvent("agent.message.start", { sessionId, messageId, role: "assistant" });

    let client: CodexJsonRpcClient;
    try {
      client = await this.ensureClient();
      if (managedCodexAuth(this.env)) {
        if (!this.managedCatalog) throw new Error("Managed model metadata is unavailable");
        await assertManagedCodexStaticCatalog(
          this.managedCatalog,
          await client.request("config/read", { includeLayers: true }, this.requestTimeoutMs),
          model,
        );
      }
    } catch (err) {
      const code = codexErrorCode(err);
      const message = friendlyCodexErrorMessage(err, this.codexHome);
      yield wrapEvent("agent.error", {
        sessionId,
        messageId,
        code,
        message,
      });
      yield wrapEvent("agent.message.end", {
        sessionId,
        messageId,
        stopReason: "error",
        context: unknownCodexContext(),
        failure: {
          code,
          message,
          retryable: code !== "context_window_exceeded" && code !== "codex_input_too_large",
          backend: "codex",
          model,
        },
      });
      return;
    }

    const tools = convertToolsToCodexDynamicTools(input.tools);
    const handles = new Map(input.tools.map((h) => [h.name, h]));

    let threadId = "";
    let turnId = "";
    const queue = new AsyncQueue<AgentEvent>();
    const state: ActiveCodexTurn = {
      sessionId,
      messageId,
      timeZone,
      caller,
      model,
      threadId,
      turnId,
      handles,
      queue,
      usage: {},
      progressUsage: {},
      contextReadings: 0,
      completed: false,
      answer: input.finalAnswerOnly ? { deltas: "", phased: false } : undefined,
      toolCalls: 0,
      toolTimeoutMs,
      maxToolIterations,
      signal,
      heldForTurnId: [],
      client,
      pendingTools: new Set(),
      progressItems: new Set(),
    };

    const interrupt = (): void => {
      if (!state.threadId || !state.turnId) return;
      void client
        .request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }, 2_000)
        .catch(() => {});
    };
    const abort = (): void => {
      if (state.completed) return;
      interrupt();
      this.completeActiveTurn("canceled");
    };

    try {
      if (signal?.aborted) {
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: "canceled",
          context: unknownCodexContext(),
        });
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });

      const threadResult = await client.request(
        "thread/start",
        {
          model,
          cwd: this.workspaceDir,
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: "read-only",
          developerInstructions: input.systemPrompt,
          personality: null,
          ephemeral: true,
          serviceName: "omnesis",
          config: managedCodexAuth(this.env)
            ? managedCodexThreadConfig(STRICT_CODEX_CONFIG_OBJECT, this.managedCatalog, model)
            : STRICT_CODEX_CONFIG_OBJECT,
          // Explicit dynamic tools keep execution in Omnesis's own handlers.
          dynamicTools: tools,
        },
        this.requestTimeoutMs,
      );
      const parsedThreadId = extractThreadId(threadResult);
      if (!parsedThreadId) throw new Error("Codex app-server did not return a thread id");
      threadId = parsedThreadId;
      state.threadId = threadId;
      this.activeTurn = state;
      if (managedCodexAuth(this.env)) {
        await assertManagedCodexEffectiveFeatures(
          (params) => client.request("experimentalFeature/list", params, this.requestTimeoutMs),
          threadId,
          this.managedProcessVersion,
        );
      }
      // Cancelled while thread/start was in flight, with no active turn for the
      // abort to complete. Starting one now would only spend the model's time.
      if (signal?.aborted) abort();

      if (!state.completed) {
        const turnResult = await client.request(
          "turn/start",
          {
            threadId,
            input: [
              {
                type: "text",
                text: renderTranscriptUserInput(input.history, input.userMessage, {
                  timeZone: input.timeZone,
                }),
              },
              ...(input.images ?? []).map(({ url }) => ({ type: "image", url })),
            ],
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            model,
            ...(reasoningEffort ? { effort: reasoningEffort } : {}),
          },
          this.requestTimeoutMs,
        );
        const parsedTurnId = extractTurnId(turnResult);
        if (!parsedTurnId) throw new Error("Codex app-server did not return a turn id");
        turnId = parsedTurnId;
        state.turnId = turnId;
        // Cancelled while turn/start was in flight: nothing could name this turn
        // then, so it would run on unheard and hold the model until it finished.
        if (state.completed) interrupt();
        this.releaseHeldMessages(state);
        this.armIdleWatchdog(state);
      }

      while (true) {
        const next = await queue.shift();
        if (next.done) break;
        yield next.value;
      }
    } catch (err) {
      if (state.completed) {
        // Disposal can complete the active turn while turn/start is still
        // awaiting its JSON-RPC response. Drain the queued authoritative end
        // event before leaving the generator.
        while (true) {
          const next = await queue.shift();
          if (next.done) break;
          yield next.value;
        }
      } else {
        const code = codexErrorCode(err);
        const message = friendlyCodexErrorMessage(err, this.codexHome);
        yield wrapEvent("agent.error", {
          sessionId,
          messageId,
          code,
          message,
        });
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: "error",
          context: unknownCodexContext(),
          failure: {
            code,
            message,
            retryable: code !== "context_window_exceeded" && code !== "codex_input_too_large",
            backend: "codex",
            model,
          },
        });
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      state.completed = true;
      clearTimeout(state.idleTimer);
      // A turn that never learned its id judges anything still held as foreign.
      this.releaseHeldMessages(state);
      // Never hand the runtime/pool lease onward while an admitted mutation or
      // this turn's timed-out child is still alive. Cancellation is not rollback.
      await Promise.allSettled([...state.pendingTools]);
      await this.releaseTurn(state);
    }
  }

  private async releaseTurn(state: ActiveCodexTurn): Promise<void> {
    try {
      await state.idleCleanup;
      await state.client.joinIfExited();
    } catch (cleanupError) {
      this.cleanupFailure = cleanupError;
      throw unconfirmedCodexCleanup(cleanupError);
    } finally {
      if (this.activeTurn === state) this.activeTurn = null;
      state.queue.close();
    }
  }

  dispose(): Promise<void> {
    return (this.disposal ??= this.disposeRuntime());
  }

  private async disposeRuntime(): Promise<void> {
    this.disposed = true;
    const active = this.activeTurn;
    this.completeActiveTurn("canceled");
    const starting = this.startingClient;
    try {
      await Promise.allSettled([this.managedPolicyProbe, this.protocolProbe]).then(() => {
        this.assertCleanupConfirmed();
      });
    } catch (error) {
      // The probe reports its joined startup failure to its caller. Only uncertain
      // physical cleanup is a reason to refuse generation retirement.
      if (this.cleanupFailure !== undefined)
        throw unconfirmedCodexCleanup(this.cleanupFailure, error);
    }
    const client = this.client;
    this.client = null;
    await Promise.allSettled([...(active?.pendingTools ?? [])]);
    await active?.idleCleanup;
    if (starting) {
      let startedClient: CodexJsonRpcClient | undefined;
      try {
        startedClient = await starting;
        if (startedClient !== client) await startedClient.dispose();
      } catch (error) {
        if (startedClient || this.cleanupFailure !== undefined) {
          this.cleanupFailure ??= error;
          throw unconfirmedCodexCleanup(this.cleanupFailure, error);
        }
        // A startup failure whose child was positively joined is already
        // reported to the starter. It does not make disposal fail a second time.
      }
    }
    try {
      await client?.dispose();
    } catch (error) {
      this.cleanupFailure = error;
      throw unconfirmedCodexCleanup(error);
    }
    this.assertCleanupConfirmed();
  }

  private async acquireTurnSlot(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    let release!: () => void;
    const next = new Promise<void>((resolveNext) => {
      release = resolveNext;
    });
    const previous = this.turnQueue;
    this.turnQueue = previous.then(
      () => next,
      () => next,
    );
    try {
      if (!signal) {
        await previous;
      } else {
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          void previous
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
          if (signal.aborted) abort();
        });
        signal.throwIfAborted();
      }
      return release;
    } catch (err) {
      // Keep the FIFO link behind its predecessor, but release this canceled
      // slot immediately so successors can proceed once that predecessor ends.
      release();
      throw err;
    }
  }

  private async ensureClient(): Promise<CodexJsonRpcClient> {
    if (this.managedPolicyProbe) await this.managedPolicyProbe;
    this.assertCleanupConfirmed();
    if (this.retiringClient) await this.retiringClient.catch(() => {});
    this.assertCleanupConfirmed();
    if (this.disposed) throw new Error("Codex backend has been disposed");
    if (this.client) return this.client;
    if (this.startingClient) return this.startingClient;

    const start = this.startClient();
    this.startingClient = start;
    try {
      const client = await start;
      if (this.disposed) {
        if (this.client === client) this.client = null;
        await client.dispose();
        throw new Error("Codex backend has been disposed");
      }
      return client;
    } finally {
      if (this.startingClient === start) this.startingClient = null;
    }
  }

  private async startClient(policyOnly = false): Promise<CodexJsonRpcClient> {
    if (this.disposed) throw new Error("Codex backend has been disposed");
    if (this.protocolOnly && !policyOnly)
      throw new Error("Compatibility probes cannot start conversations");
    this.assertManagedProfile();
    const owner = codexPoolAuthOwner(this);
    if (process.platform === "win32" && owner) await prepareCodexPrivateState([owner.home]);
    await ensureRuntimeDirs(this.codexHome, this.workspaceDir, owner?.path, this.env);
    if (managedCodexAuth(this.env)) {
      await assertManagedCodexWorkspace(this.workspaceDir);
      codexKeyringAccount(this.stateHome);
      await ensurePrivateDirectory(this.stateHome);
      await assertNoManagedCodexAuthFile(this.env, [this.codexHome, this.stateHome]);
    }
    const commandInfo = await this.resolveCommandInfo();
    const probe = await this.probeCommandRuntime(commandInfo, this.startupTimeoutMs);
    if (this.disposed) throw new Error("Codex backend has been disposed");
    if (!managedCodexAuth(this.env))
      return this.openClient(
        { command: commandInfo.command, args: [...this.args] },
        probe.version,
        !policyOnly,
      );
    if (policyOnly) {
      if (this.protocolOnly)
        return this.openClient(
          { command: commandInfo.command, args: [...this.args] },
          probe.version,
          false,
        );
      const invocation = (
        this.managedCatalogPlatform?.invocation ?? managedDesktopCatalogDiscoveryInvocation
      )(commandInfo.command, this.args, randomUUID());
      return this.openClient(invocation, probe.version, false);
    }
    const configDir = this.env.OMNESIS_CONFIG_DIR,
      instance = this.env.OMNESIS_SERVICE_INSTANCE,
      secretService = this.env.OMNESIS_SECRET_SERVICE;
    if (!configDir || !instance || !secretService || !probe.version)
      throw new Error("Managed model discovery requires its exact profile and pinned runtime");
    let catalog: PreparedManagedCodexCatalog;
    try {
      catalog = await prepareManagedCodexModelCatalog({
        scope: { configDir, instance, secretService },
        codexHome: this.codexHome,
        stateHome: this.stateHome,
        command: commandInfo.command,
        args: this.args,
        version: probe.version,
        timeoutMs: this.startupTimeoutMs,
        platform: this.managedCatalogPlatform,
        open: (invocation) => this.openClient(invocation, probe.version, false),
      });
    } catch (error) {
      if (hasCodexCleanupFailure(error)) {
        this.cleanupFailure = error;
        throw unconfirmedCodexCleanup(error);
      }
      throw error;
    }
    if (this.disposed) throw new Error("Codex backend has been disposed");
    const client = await this.openClient(
      {
        command: commandInfo.command,
        args: [...this.args, "-c", `model_catalog_json=${JSON.stringify(catalog.path)}`],
      },
      probe.version,
    );
    try {
      await assertManagedCodexStaticCatalog(
        catalog,
        await client.request("config/read", { includeLayers: true }, this.startupTimeoutMs),
      );
      this.managedCatalog = catalog;
      return client;
    } catch (error) {
      try {
        await client.dispose();
      } catch (cleanupError) {
        this.cleanupFailure = cleanupError;
        throw unconfirmedCodexCleanup(cleanupError, error);
      }
      if (this.client === client) this.client = null;
      throw error;
    }
  }

  private async openClient(
    invocation: NodeCommandInvocation,
    version: string | undefined,
    activate = true,
  ): Promise<CodexJsonRpcClient> {
    const client = new CodexJsonRpcClient({
      command: invocation.command,
      args: invocation.args,
      cwd: this.workspaceDir,
      env: buildCodexEnv(this.env, this.codexHome, process.platform, this.workspaceDir),
      requestTimeoutMs: this.requestTimeoutMs,
      log: this.log,
      onNotification: (method, params) => {
        if (this.client === client) this.handleNotification(method, params);
      },
      onServerRequest: (method, params) => {
        if (this.client !== client)
          return Promise.reject(new Error("Codex client is no longer active"));
        return this.handleServerRequest(method, params);
      },
      onExit: (code, sig, cleanupError) => this.handleClientExit(client, code, sig, cleanupError),
    });
    client.start();
    if (activate) this.client = client;
    try {
      await client.request(
        "initialize",
        {
          clientInfo: {
            name: "omnesis",
            title: "Omnesis",
            version: AGENT_VERSION,
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
            optOutNotificationMethods: [
              "thread/realtime/started",
              "thread/realtime/itemAdded",
              "thread/realtime/transcript/delta",
              "thread/realtime/transcript/done",
              "thread/realtime/outputAudio/delta",
              "thread/realtime/sdp",
              "thread/realtime/error",
              "thread/realtime/closed",
            ],
          },
        },
        this.startupTimeoutMs,
      );
      client.notify("initialized", {});
      if (managedCodexAuth(this.env)) {
        assertManagedCodexPolicy(
          await client.request("config/read", { includeLayers: true }, this.startupTimeoutMs),
        );
        await assertManagedCodexEffectiveFeatures(
          (params) => client.request("experimentalFeature/list", params, this.startupTimeoutMs),
          undefined,
          version,
        );
        this.managedProcessVersion = version;
      }
    } catch (err) {
      try {
        await client.dispose();
        if (this.client === client) this.client = null;
      } catch (cleanupError) {
        this.cleanupFailure = cleanupError;
        throw unconfirmedCodexCleanup(cleanupError, err);
      }
      throw err;
    }
    return client;
  }

  private async handleServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method === "item/tool/call") return this.handleToolCall(params);

    if (method === "item/commandExecution/requestApproval") {
      this.log.warn("Codex requested native command approval; declining by V1 policy");
      return { decision: "decline" };
    }
    if (method === "item/fileChange/requestApproval") {
      this.log.warn("Codex requested native file-change approval; declining by V1 policy");
      return { decision: "decline" };
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      this.log.warn(`Codex requested legacy native approval ${method}; denying by V1 policy`);
      return { decision: "denied" };
    }
    if (method === "item/permissions/requestApproval") {
      this.log.warn("Codex requested expanded native permissions; returning no grants");
      return { permissions: {}, scope: "turn", strictAutoReview: true };
    }
    if (method === "item/tool/requestUserInput") {
      this.log.warn("Codex requested native user input; returning no answers by V1 policy");
      return { answers: {} };
    }
    if (method === "mcpServer/elicitation/request") {
      this.log.warn("Codex requested MCP elicitation; declining by V1 policy");
      return { action: "decline", content: null, _meta: null };
    }

    throw new Error(`Unsupported Codex server request "${method}"`);
  }

  private async handleToolCall(params: unknown): Promise<unknown> {
    const state = this.activeTurn;
    const p = asRecord(params);

    if (state && this.holdUntilTurnId(state, params)) {
      return new Promise((resolve) => {
        state.heldForTurnId?.push(() => resolve(this.handleToolCall(params)));
      });
    }

    if (!state || state.completed || !this.acceptTurnScopedParams(state, params)) {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              kind: "error",
              code: "stale_tool_call",
              message: "tool call did not match the active Omnesis turn",
            }),
          },
        ],
      };
    }

    clearTimeout(state.idleTimer);
    const pending = this.invokeToolCall(state, p);
    state.pendingTools.add(pending);
    try {
      return await pending;
    } finally {
      state.pendingTools.delete(pending);
      this.armIdleWatchdog(state);
    }
  }

  private async invokeToolCall(
    state: ActiveCodexTurn,
    p: Record<string, unknown> | null,
  ): Promise<unknown> {
    const callId = stringField(p, "callId") ?? "codex_tool_call";
    const tool = stringField(p, "tool") ?? "";
    // Validated as the tool will receive them: without the local-time
    // annotations the model may have copied from tool output.
    const rawArgs = stripLocalTimeAnnotationsDeep(p?.arguments ?? {});
    state.toolCalls += 1;
    const handle = state.handles.get(tool);
    const parsedArgs = handle ? handle.schema.safeParse(rawArgs) : null;
    const invalidArgs = parsedArgs !== null && !parsedArgs.success;
    const args = parsedArgs?.success ? parsedArgs.data : rawArgs;
    const eventArgs = invalidArgs ? {} : args;
    state.queue.push(
      wrapEvent("agent.tool.input_start", {
        sessionId: state.sessionId,
        messageId: state.messageId,
        toolCallId: callId,
        tool,
      }),
    );
    state.queue.push(
      wrapEvent("agent.tool.start", {
        sessionId: state.sessionId,
        messageId: state.messageId,
        toolCallId: callId,
        tool,
        args: eventArgs,
        argsSummary: invalidArgs ? "invalid arguments" : summarizeToolArgs(handle, args),
      }),
    );

    const start = Date.now();
    let result: ToolResult;
    if (state.toolCalls > state.maxToolIterations) {
      result = {
        kind: "error",
        code: "tool_iteration_cap",
        message: `model exceeded ${state.maxToolIterations} tool calls`,
      };
    } else if (!handle) {
      result = { kind: "error", code: "unknown_tool", message: `no tool named ${tool}` };
    } else if (invalidArgs) {
      result = {
        kind: "error",
        code: "tool_invalid_args",
        message: formatZodError(parsedArgs.error),
      };
    } else {
      try {
        const abortSignal = state.signal
          ? AbortSignal.any([state.signal, AbortSignal.timeout(state.toolTimeoutMs)])
          : AbortSignal.timeout(state.toolTimeoutMs);
        result = await handle.invoke(args, {
          sessionId: state.sessionId,
          messageId: state.messageId,
          abortSignal,
          timeZone: state.timeZone,
          caller: state.caller,
          // Batch tools stream one child card per operation live: push each
          // agent.tool.child.* straight onto the backend's event queue as the
          // child settles, interleaved between this call's start and result.
          ...childEventHooks(
            { sessionId: state.sessionId, messageId: state.messageId, toolCallId: callId },
            (ev) => state.queue.push(ev),
          ),
        });
      } catch (err) {
        result = {
          kind: "error",
          code: "tool_threw",
          message: err instanceof Error ? err.message : "tool threw",
        };
      }
    }

    state.queue.push(
      wrapEvent("agent.tool.result", {
        sessionId: state.sessionId,
        messageId: state.messageId,
        toolCallId: callId,
        result,
        durationMs: Date.now() - start,
      }),
    );

    return {
      success: !toolResultHasErrors(result),
      contentItems: [
        {
          type: "inputText",
          text: serializeToolResultForModel(result, { timeZone: state.timeZone }),
        },
      ],
    };
  }

  private handleNotification(method: string, params: unknown): void {
    const state = this.activeTurn;
    if (!state || state.completed) return;
    if (this.holdUntilTurnId(state, params)) {
      state.heldForTurnId?.push(() => this.handleNotification(method, params));
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (!this.acceptTurnScopedParams(state, params)) return;
      const p = asRecord(params);
      const delta = stringField(p, "delta");
      if (delta) this.armIdleWatchdog(state);
      if (state.answer) {
        state.answer.deltas += delta ?? "";
        return;
      }
      if (delta) {
        state.queue.push(
          wrapEvent("agent.text.delta", {
            sessionId: state.sessionId,
            messageId: state.messageId,
            delta,
          }),
        );
      }
      return;
    }

    if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
      if (!this.acceptTurnScopedParams(state, params)) return;
      const p = asRecord(params);
      const delta = stringField(p, "delta");
      if (delta) this.armIdleWatchdog(state);
      if (delta) {
        state.queue.push(
          wrapEvent("agent.thinking.delta", {
            sessionId: state.sessionId,
            messageId: state.messageId,
            delta,
          }),
        );
      }
      return;
    }

    if (method === "thread/tokenUsage/updated") {
      if (!this.acceptTurnScopedParams(state, params)) return;
      const p = asRecord(params);
      const usage = parseCodexUsage(p?.tokenUsage);
      if (
        (["inputTokens", "outputTokens", "cacheReadTokens"] as const).some(
          (key) => (usage[key] ?? 0) > (state.progressUsage[key] ?? 0),
        )
      )
        this.armIdleWatchdog(state);
      for (const key of ["inputTokens", "outputTokens", "cacheReadTokens"] as const)
        state.progressUsage[key] = Math.max(state.progressUsage[key] ?? 0, usage[key] ?? 0);
      state.usage = usage;
      const contextInputTokens = parseCodexContextInputTokens(p?.tokenUsage);
      if (contextInputTokens !== undefined) {
        state.contextInputTokens = contextInputTokens;
        state.peakContextInputTokens = Math.max(
          state.peakContextInputTokens ?? 0,
          contextInputTokens,
        );
        state.contextReadings += 1;
      }
      const contextWindowTokens = parseCodexContextWindowTokens(p?.tokenUsage);
      if (contextWindowTokens !== undefined) state.contextWindowTokens = contextWindowTokens;
      if (Object.keys(state.usage).length > 0) {
        state.queue.push(
          wrapEvent("agent.usage.update", {
            sessionId: state.sessionId,
            messageId: state.messageId,
            usage: state.usage,
            ...(contextInputTokens === undefined ? {} : { context: codexContextAssessment(state) }),
          }),
        );
      }
      return;
    }

    if (method === "turn/completed") {
      if (!this.acceptTurnScopedParams(state, params)) return;
      const p = asRecord(params);
      const turn = asRecord(p?.turn);
      const status = stringField(turn, "status");
      if (status === "failed") {
        const error = asRecord(turn?.error);
        this.failActiveTurn(
          codexErrorCode(error),
          friendlyCodexErrorMessage(error, this.codexHome),
        );
      } else if (
        status !== "interrupted" &&
        state.answer?.phased &&
        state.answer.final === undefined
      ) {
        this.failActiveTurn("codex_incomplete_answer", "Codex completed without a final answer.");
      } else {
        this.completeActiveTurn(status === "interrupted" ? "canceled" : "end_turn");
      }
      return;
    }

    if (method === "error") {
      if (!this.acceptTurnScopedParams(state, params)) return;
      const p = asRecord(params);
      const error = asRecord(p?.error);
      if (p?.willRetry === true) return;
      this.failActiveTurn(codexErrorCode(error), friendlyCodexErrorMessage(error, this.codexHome));
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      if (!this.acceptTurnScopedParams(state, params)) return;
      const item = asRecord(asRecord(params)?.item);
      const itemType = stringField(item, "type");
      const itemId = stringField(item, "id");
      if (
        itemId &&
        itemType &&
        ["agentMessage", "reasoning", "dynamicToolCall"].includes(itemType)
      ) {
        const progress = `${method}:${itemId}`;
        if (!state.progressItems.has(progress)) {
          state.progressItems.add(progress);
          this.armIdleWatchdog(state);
        }
      }
      if (state.answer && itemType === "agentMessage") {
        const phase = stringField(item, "phase");
        if (phase) state.answer.phased = true;
        if (method === "item/completed") {
          const text = stringField(item, "text");
          if (phase === "final_answer" && text !== null) state.answer.final = text;
          else if (!phase && text !== null) state.answer.unphased = text;
        }
      }
      if (itemType && NATIVE_ITEM_TYPES.has(itemType)) {
        this.failActiveTurn(
          "codex_native_tool_unavailable",
          `Codex attempted to use native item "${itemType}", which Omnesis disables in this experimental backend.`,
        );
      }
      return;
    }

    if (isNativeCodexNotification(method)) {
      if (!this.acceptTurnScopedParams(state, params)) return;
      this.failActiveTurn(
        "codex_native_tool_unavailable",
        `Codex emitted native event "${method}", which Omnesis disables in this experimental backend.`,
      );
    }
  }

  private armIdleWatchdog(state: ActiveCodexTurn): void {
    clearTimeout(state.idleTimer);
    if (this.activeTurn !== state || state.completed || !state.turnId || state.pendingTools.size)
      return;
    state.idleTimer = setTimeout(() => {
      if (this.activeTurn !== state || state.completed || state.pendingTools.size) return;
      this.failActiveTurn(
        "codex_turn_idle_timeout",
        "Codex stopped making progress while waiting for model output. The idle runtime was stopped; this turn was not replayed.",
      );
      if (this.client === state.client) this.client = null;
      state.idleCleanup = state.client.dispose().catch((error: unknown) => {
        this.cleanupFailure = error;
        throw error;
      });
      const retiring = state.idleCleanup;
      this.retiringClient = retiring;
      void retiring.then(
        () => {
          if (this.retiringClient === retiring) this.retiringClient = undefined;
        },
        () => {
          /* Keep the sticky rejection and block every probe/reuse path. */
        },
      );
    }, this.turnIdleTimeoutMs);
  }

  private handleClientExit(
    client: CodexJsonRpcClient,
    code: number | null,
    sig: NodeJS.Signals | null,
    cleanupError?: unknown,
  ): void {
    if (cleanupError !== undefined) this.cleanupFailure = cleanupError;
    // An idle exit must also invalidate reuse. A late exit from a disposed
    // predecessor must never clear its replacement or fail the replacement's turn.
    if (this.client !== client) return;
    if (cleanupError === undefined) this.client = null;
    if (!this.activeTurn || this.activeTurn.completed) return;
    this.failActiveTurn(
      cleanupError === undefined ? "codex_process_exited" : "codex_cleanup_unconfirmed",
      `Codex app-server exited before the turn completed (${sig ?? code ?? "unknown"})`,
    );
  }

  private acceptTurnScopedParams(state: ActiveCodexTurn, params: unknown): boolean {
    const p = asRecord(params);
    if (!p) return false;
    const threadId = stringField(p, "threadId");
    if (threadId && state.threadId && threadId !== state.threadId) return false;
    const turnId = turnIdFromParams(p);
    if (!turnId) return state.turnId === "";
    return turnId === state.turnId;
  }

  /**
   * Codex may deliver a turn's first events before the `turn/start` response,
   * or in the same read, ahead of the continuation that records the turn id.
   * Until that id is known those events cannot be told apart from another
   * turn's output, so a message naming a turn is held and replayed, in arrival
   * order, once `turn/start` settles.
   */
  private holdUntilTurnId(state: ActiveCodexTurn, params: unknown): boolean {
    if (state.turnId || !state.heldForTurnId) return false;
    const p = asRecord(params);
    return p !== null && turnIdFromParams(p) !== null;
  }

  private releaseHeldMessages(state: ActiveCodexTurn): void {
    const held = state.heldForTurnId;
    state.heldForTurnId = null;
    for (const replay of held ?? []) markActivity("agent.codex.message", replay);
  }

  private failActiveTurn(code: string, message: string): void {
    const state = this.activeTurn;
    if (!state || state.completed) return;
    state.queue.push(
      wrapEvent("agent.error", {
        sessionId: state.sessionId,
        messageId: state.messageId,
        code,
        message,
      }),
    );
    this.completeActiveTurn("error", { code, message });
  }

  private completeActiveTurn(
    stopReason: "end_turn" | "canceled" | "error",
    failure?: { code: string; message: string },
  ): void {
    const state = this.activeTurn;
    if (!state || state.completed) return;
    state.completed = true;
    clearTimeout(state.idleTimer);
    if (stopReason === "end_turn" && state.answer) {
      const text = state.answer.final ?? state.answer.unphased ?? state.answer.deltas;
      if (text)
        state.queue.push(
          wrapEvent("agent.text.delta", {
            sessionId: state.sessionId,
            messageId: state.messageId,
            delta: text,
          }),
        );
    }
    state.queue.push(
      wrapEvent("agent.message.end", {
        sessionId: state.sessionId,
        messageId: state.messageId,
        stopReason,
        usage: Object.keys(state.usage).length > 0 ? state.usage : undefined,
        context: codexContextAssessment(state),
        ...(failure
          ? {
              failure: {
                ...failure,
                retryable:
                  failure.code !== "context_window_exceeded" &&
                  failure.code !== "codex_input_too_large",
                backend: "codex",
                model: state.model,
              },
            }
          : {}),
      }),
    );
    state.queue.close();
  }
}

export class CodexAppServerBackend implements ChatBackend {
  readonly name = "codex";
  readonly model: string;
  private readonly reasoningEffort: string | undefined;

  private readonly runtime: CodexTurnRunner;
  private readonly ownsRuntime: boolean;
  private readonly toolTimeoutMs: number;
  private readonly maxToolIterations: number;
  private readonly finalAnswerOnly: boolean;

  constructor(opts: CodexAppServerBackendOptions) {
    this.model = opts.model;
    this.reasoningEffort = opts.reasoningEffort;
    this.finalAnswerOnly = opts.finalAnswerOnly ?? false;
    this.runtime =
      opts.runtime ??
      new CodexAppServerRuntime({
        codexHome: opts.codexHome,
        workspaceDir: opts.workspaceDir,
        command: opts.command,
        commandInfo: opts.commandInfo,
        args: opts.args,
        versionArgs: opts.versionArgs,
        startupTimeoutMs: opts.startupTimeoutMs,
        requestTimeoutMs: opts.requestTimeoutMs,
        turnIdleTimeoutMs: opts.turnIdleTimeoutMs,
        env: opts.env,
        logger: opts.logger,
      });
    this.ownsRuntime = !opts.runtime;
    this.toolTimeoutMs = opts.toolTimeoutMs ?? 60_000;
    this.maxToolIterations = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  }

  async *runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    // The runtime owns its internal model-call loop, which is opaque here:
    // report one span per turn (documented on probeTurnEvents) rather than
    // per request.
    yield* probeTurnEvents(
      input.llmProbe,
      this.runtime.runTurn({
        model: this.model,
        reasoningEffort: this.reasoningEffort,
        input: this.finalAnswerOnly ? { ...input, finalAnswerOnly: true } : input,
        toolTimeoutMs: this.toolTimeoutMs,
        maxToolIterations: this.maxToolIterations,
        signal,
      }),
    );
  }

  async dispose(): Promise<void> {
    if (this.ownsRuntime && this.runtime instanceof CodexAppServerRuntime) {
      await this.runtime.dispose();
    }
  }
}

export function convertToolsToCodexDynamicTools(
  tools: ReadonlyArray<ToolHandle>,
): CodexDynamicToolSpec[] {
  return tools.map((h) => ({
    type: "function",
    name: h.name,
    description: h.description,
    inputSchema: toolInputJsonSchema(h.schema) as Record<string, unknown>,
  }));
}

export async function ensureCodexHome(
  codexHome: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await ensureRuntimeDirs(
    codexHome,
    join(codexHome, DEFAULT_CODEX_WORKSPACE_DIRNAME),
    undefined,
    env,
  );
}

export async function ensureCodexRuntimeDirs(
  codexHome: string,
  workspaceDir: string,
): Promise<void> {
  await ensureRuntimeDirs(codexHome, workspaceDir);
}

async function ensureRuntimeDirs(
  codexHome: string,
  workspaceDir: string,
  sharedAuthPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (managedCodexAuth(env)) {
    codexKeyringAccount(codexHome);
    codexKeyringAccount(workspaceDir);
  }
  const config = managedCodexAuth(env)
    ? 'cli_auth_credentials_store = "keyring"\nhistory.persistence = "none"\nanalytics.enabled = false\notel.log_user_prompt = false\n' +
      STRICT_CODEX_CONFIG_TOML
    : STRICT_CODEX_CONFIG_TOML;
  if (process.platform === "win32") {
    await prepareCodexPrivateState(
      [codexHome, workspaceDir],
      sharedAuthPath ? { home: codexHome, target: sharedAuthPath } : undefined,
    );
    await atomicWriteFile(join(codexHome, "config.toml"), config, {
      mode: 0o600,
    });
    return;
  }
  await ensurePrivateDirectory(codexHome);
  await ensurePrivateDirectory(workspaceDir);
  const configPath = join(codexHome, "config.toml");
  await rejectSymlinkIfPresent(configPath);
  if (managedCodexAuth(env)) {
    await atomicWriteFile(configPath, config, { mode: 0o600 });
    return;
  }
  await writeFile(configPath, STRICT_CODEX_CONFIG_TOML, { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600);
}

export function buildCodexEnv(
  env: NodeJS.ProcessEnv,
  codexHome: string,
  platform: NodeJS.Platform = process.platform,
  workspace: string = join(codexHome, DEFAULT_CODEX_WORKSPACE_DIRNAME),
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const key of SAFE_CODEX_ENV_KEYS) {
    const actual =
      platform === "win32"
        ? Object.keys(env).find((name) => name.toUpperCase() === key.toUpperCase())
        : key;
    const value = actual === undefined ? undefined : env[actual];
    if (value !== undefined) childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SAFE_CODEX_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      childEnv[key] = value;
    }
  }
  // Direct CLI login otherwise installs its own plaintext diagnostic file logger.
  // This controls that supported logger; the separate SQLite sink is audited independently.
  if (managedCodexAuth(env)) {
    for (const key of ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"])
      delete childEnv[key];
    Object.assign(childEnv, {
      RUST_LOG: "off",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_COUNT: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CEILING_DIRECTORIES: workspace,
    });
  }
  return childEnv;
}

export async function resolveCodexRuntimeCommand(
  opts: {
    commandOverride?: string;
  } = {},
): Promise<CodexRuntimeCommandInfo> {
  const override = opts.commandOverride?.trim();
  if (override) {
    return {
      source: "override",
      command: override,
    };
  }

  let packageJsonPath: string;
  try {
    packageJsonPath = require.resolve("@openai/codex/package.json");
  } catch (err) {
    throw new Error(
      `Managed Codex runtime package ${MANAGED_CODEX_PACKAGE}@${MANAGED_CODEX_PACKAGE_VERSION} is not installed.`,
      { cause: err },
    );
  }

  const parsed = safeJsonParse(await readFile(packageJsonPath, "utf8"));
  const pkg = asRecord(parsed);
  const bin = pkg?.bin;
  const binRecord = asRecord(bin);
  const binRel = typeof bin === "string" ? bin : (stringField(binRecord, "codex") ?? undefined);
  if (!binRel) {
    throw new Error(`Managed Codex runtime package ${MANAGED_CODEX_PACKAGE} has no codex bin.`);
  }

  return {
    source: "managed",
    command: resolve(dirname(packageJsonPath), binRel),
    packageName: stringField(pkg, "name") ?? MANAGED_CODEX_PACKAGE,
    packageVersion: stringField(pkg, "version") ?? MANAGED_CODEX_PACKAGE_VERSION,
  };
}

export function parseCodexCliVersion(output: string): string | null {
  const match = output.match(/codex(?:-cli)?\s+(\d+\.\d+\.\d+)/i);
  return match?.[1] ?? null;
}

export async function assertSupportedCodexRuntime(opts: {
  command: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<CodexRuntimeProbe> {
  let stdout: string;
  try {
    const invocation = nodeCommandInvocation(opts.command, opts.args ?? DEFAULT_CODEX_VERSION_ARGS);
    const result = await (process.platform === "win32" ? execWindowsJob : execFileAsync)(
      invocation.command,
      invocation.args,
      {
        env: opts.env,
        timeout: opts.timeoutMs ?? 10_000,
        windowsHide: true,
      },
    );
    stdout = `${result.stdout}${result.stderr}`;
  } catch (err) {
    if (hasCodexCleanupFailure(err)) throw err;
    const permissionFailure = codexSpawnPermissionFailure(err);
    if (permissionFailure) throw permissionFailure;
    const e = err as ExecFileException;
    if (e.code === "ENOENT") {
      throw new Error(
        `Codex CLI not found at "${opts.command}". Omnesis normally uses its managed ${MANAGED_CODEX_PACKAGE}@${MANAGED_CODEX_PACKAGE_VERSION} runtime; check OMNESIS_CODEX_COMMAND if you set an override.`,
        { cause: err },
      );
    }
    throw new Error(`Codex CLI probe failed: ${e.message}`, { cause: err });
  }

  const version = parseCodexCliVersion(stdout);
  if (!version) {
    throw new Error(`Codex CLI probe returned an unrecognized version string: ${stdout.trim()}`);
  }
  if (!isSupportedCodexCliVersion(version)) {
    throw new Error(
      `Unsupported Codex CLI version ${version}. Omnesis Codex supports ${CODEX_RUNTIME_COMPAT.supportedVersionPrefixes.map((prefix) => `${prefix}x`).join(" and ")}.`,
    );
  }
  return { command: opts.command, version };
}

interface ActiveCodexTurn {
  sessionId: string;
  messageId: string;
  /** Caller's IANA zone for this turn; rides every ToolContext the turn builds. */
  timeZone?: string;
  /** Who this turn speaks for; rides every ToolContext the turn builds. */
  caller?: ToolCaller;
  model: string;
  threadId: string;
  turnId: string;
  handles: Map<string, ToolHandle>;
  queue: AsyncQueue<AgentEvent>;
  usage: AgentEndUsage;
  progressUsage: AgentEndUsage;
  /** The input size of the turn's latest model request, cached input included. */
  contextInputTokens?: number;
  /** The largest such input seen during the turn. */
  peakContextInputTokens?: number;
  /** The model's context window, when Codex reports it. */
  contextWindowTokens?: number;
  /** How many model requests have reported their input size. */
  contextReadings: number;
  completed: boolean;
  answer?: { deltas: string; phased: boolean; final?: string; unphased?: string };
  toolCalls: number;
  toolTimeoutMs: number;
  maxToolIterations: number;
  signal?: AbortSignal;
  /** Turn-scoped messages received before `turn/start` returned the turn id; null once released. */
  heldForTurnId: Array<() => void> | null;
  client: CodexJsonRpcClient;
  pendingTools: Set<Promise<unknown>>;
  progressItems: Set<string>;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleCleanup?: Promise<void>;
}

type AgentEndUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
};

type RequestId = string | number;

interface JsonRpcMessage {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

class CodexJsonRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private exited = false;
  private pending = new Map<RequestId, PendingRequest>();
  private disposed = false;
  private joined: Promise<void> | undefined;
  private disposal: Promise<void> | undefined;

  constructor(
    private readonly opts: {
      command: string;
      args: readonly string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      requestTimeoutMs: number;
      log: Logger;
      onNotification(method: string, params: unknown): void;
      onServerRequest(method: string, params: unknown): Promise<unknown>;
      onExit(code: number | null, sig: NodeJS.Signals | null, cleanupError?: unknown): void;
    },
  ) {}

  start(): void {
    if (this.proc) return;
    const invocation = nodeCommandInvocation(this.opts.command, this.opts.args);
    const job =
      process.platform === "win32"
        ? spawnWindowsJob(invocation.command, invocation.args, {
            cwd: this.opts.cwd,
            env: this.opts.env,
          })
        : null;
    this.proc =
      job ??
      spawn(invocation.command, invocation.args, {
        cwd: this.opts.cwd,
        env: this.opts.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

    this.joined = job?.jobClosed.catch((error: unknown) => {
      // Undefined is a valid rejection reason, never a successful join receipt.
      throw error === undefined ? unconfirmedCodexCleanup(error) : error;
    });
    void this.joined?.catch(() => {});
    const notifyExit = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (!job) {
        this.opts.onExit(code, sig);
        return;
      }
      void this.joined!.then(
        () => this.opts.onExit(code, sig),
        (error: unknown) => this.opts.onExit(code, sig, error),
      );
    };

    readJsonRpcLines(this.proc.stdout, (line) =>
      markActivity("agent.codex.message", () => this.handleLine(line)),
    );
    const stderr = createInterface({ input: this.proc.stderr });
    stderr.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) this.opts.log.warn(`Codex app-server wrote stderr (${trimmed.length} chars)`);
    });

    const startFailed = (err: Error): void => {
      if (this.exited || this.disposed) return;
      this.exited = true;
      this.rejectAll(
        codexSpawnPermissionFailure(err) ??
          new Error(`Codex app-server failed to start: ${err.message}`),
      );
      notifyExit(null, null);
    };
    this.proc.once("error", startFailed);
    void job?.jobReady.catch((err: unknown) =>
      startFailed(err instanceof Error ? err : new Error(String(err))),
    );
    this.proc.once("exit", (code, sig) => {
      const alreadyExited = this.exited;
      this.exited = true;
      if (!this.disposed && !alreadyExited) {
        this.rejectAll(new Error(`Codex app-server exited (${sig ?? code ?? "unknown"})`));
        notifyExit(code, sig);
      }
    });
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = this.opts.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Codex app-server disposed"));
    if (this.exited) return Promise.reject(new Error("Codex app-server exited"));
    const id = this.nextId++;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(message);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  async joinIfExited(): Promise<void> {
    if (this.disposal) await this.disposal;
    else if (this.exited && this.joined) await this.joined;
  }

  dispose(): Promise<void> {
    // Every caller shares the same completion or uncertainty, including calls
    // arriving after raw exit or while another dispose is already draining.
    return (this.disposal ??= this.disposeProcess());
  }

  private async disposeProcess(): Promise<void> {
    this.disposed = true;
    const proc = this.proc;
    this.proc = null;
    this.rejectAll(new Error("Codex app-server disposed"));
    if (!proc) return;
    if (this.joined) {
      proc.kill("SIGKILL");
      await this.joined;
      return;
    }
    // A spawn failure emits error/close without exit and never owns a live PID.
    if (proc.pid === undefined) return;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => proc.kill("SIGKILL"), 2_000);
      proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      proc.kill("SIGTERM");
    });
  }

  private send(message: unknown): void {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable");
    }
    this.proc.stdin.write(encodeJsonRpcLine(message));
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.opts.log.warn(`Codex app-server emitted non-JSON stdout (${line.length} chars)`);
      return;
    }

    if (parsed.id !== undefined && (Object.hasOwn(parsed, "result") || parsed.error)) {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      clearTimeout(pending.timer);
      if (parsed.error) {
        pending.reject(
          new Error(parsed.error.message ?? `Codex app-server error ${parsed.error.code}`),
        );
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    if (parsed.method && parsed.id !== undefined) {
      void this.opts.onServerRequest(parsed.method, parsed.params).then(
        (result) => this.respond({ id: parsed.id, result }),
        (err) =>
          this.respond({
            id: parsed.id,
            error: {
              code: -32_000,
              message: err instanceof Error ? err.message : "Codex server request failed",
            },
          }),
      );
      return;
    }

    if (parsed.method) this.opts.onNotification(parsed.method, parsed.params);
  }

  private rejectAll(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private respond(message: unknown): void {
    try {
      this.send(message);
    } catch (err) {
      if (!this.disposed) {
        this.opts.log.warn(
          `failed to respond to Codex server request: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: QueueShift<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true });
  }

  shift(): Promise<QueueShift<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

type QueueShift<T> = { done: true } | { done: false; value: T };

function extractThreadId(result: unknown): string | null {
  const r = asRecord(result);
  const thread = asRecord(r?.thread);
  return stringField(thread, "id") ?? stringField(r, "threadId");
}

function extractTurnId(result: unknown): string | null {
  const r = asRecord(result);
  const turn = asRecord(r?.turn);
  return stringField(turn, "id") ?? stringField(r, "turnId");
}

function turnIdFromParams(params: Record<string, unknown>): string | null {
  const turn = asRecord(params.turn);
  return stringField(params, "turnId") ?? stringField(turn, "id");
}

/**
 * Read Codex's `tokenUsage` into the agent usage shape.
 *
 * `total` is the whole turn: every turn runs on a fresh ephemeral thread, so
 * the thread total is exactly this turn's spend across all its model requests,
 * whereas `last` covers only the final request. `last` is read only when a
 * server omits `total`.
 *
 * Codex's `inputTokens` includes the cached input. The agent usage convention
 * (the chat-completions and Responses backends follow it too) reports fresh
 * input and cache reads as disjoint counts, so the cached portion is
 * subtracted here, once, at the boundary.
 */
export function parseCodexUsage(value: unknown): AgentEndUsage {
  const usage = asRecord(value);
  const counts = asRecord(usage?.total) ?? asRecord(usage?.last);
  if (!counts) return {};
  const input = numberField(counts, "inputTokens");
  const cached = numberField(counts, "cachedInputTokens");
  const output = numberField(counts, "outputTokens");
  return {
    ...(input !== undefined ? { inputTokens: Math.max(0, input - (cached ?? 0)) } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
  };
}

/**
 * The context-window reading of Codex's `tokenUsage`: the full input of the
 * latest model request (`last`, cached input included), which is how much of
 * the window the conversation occupies — unlike the spend counts, a sum over
 * requests would overstate it.
 */
export function parseCodexContextInputTokens(value: unknown): number | undefined {
  const usage = asRecord(value);
  const counts = asRecord(usage?.last) ?? asRecord(usage?.total);
  return counts ? numberField(counts, "inputTokens") : undefined;
}

/** The model context window Codex reports beside its token counts, when it does. */
export function parseCodexContextWindowTokens(value: unknown): number | undefined {
  const usage = asRecord(value);
  const window = usage ? numberField(usage, "modelContextWindow") : undefined;
  return window !== undefined && Number.isSafeInteger(window) && window > 0 ? window : undefined;
}

/** The turn's context-window reading in the shared assessment shape. */
function codexContextAssessment(state: ActiveCodexTurn): AgentContextAssessment {
  const inputTokens = state.contextInputTokens;
  return {
    ...(inputTokens === undefined
      ? {}
      : { inputTokens, peakInputTokens: state.peakContextInputTokens ?? inputTokens }),
    ...(state.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: state.contextWindowTokens }),
    measurement: inputTokens === undefined ? "unknown" : "provider_reported",
    limitSource: state.contextWindowTokens === undefined ? "unknown" : "provider",
    requestIteration: Math.max(1, state.contextReadings),
  };
}

function isNativeCodexNotification(method: string): boolean {
  return (
    method.startsWith("item/commandExecution/") ||
    method.startsWith("command/exec/") ||
    method.startsWith("process/") ||
    method.startsWith("item/fileChange/") ||
    method.startsWith("item/mcpToolCall/") ||
    method.startsWith("mcpServer/") ||
    method.startsWith("item/autoApprovalReview/")
  );
}

class CodexSpawnPermissionError extends Error {
  constructor() {
    super(
      "The operating system denied starting the Codex runtime. Check execute permissions and directory access for the configured executable.",
    );
  }
}

/** Called only at OS process-launch boundaries, never on provider error payloads. */
function codexSpawnPermissionFailure(err: unknown): CodexSpawnPermissionError | null {
  const code = asRecord(err)?.code;
  return code === "EACCES" || code === "EPERM" ? new CodexSpawnPermissionError() : null;
}

/** Preserve only known protocol categories; raw provider details may contain private data. */
function structuredCodexFailure(err: unknown): { code: string; message: string } | null {
  if (err instanceof CodexSpawnPermissionError)
    return { code: "codex_permission_denied", message: err.message };
  const info = asRecord(err)?.codexErrorInfo;
  const categories: Record<string, { code: string; message: string }> = {
    contextWindowExceeded: {
      code: "context_window_exceeded",
      message: CONTEXT_WINDOW_EXCEEDED_MESSAGE,
    },
    usageLimitExceeded: {
      code: "codex_usage_limited",
      message: "Codex reported a usage or rate limit.",
    },
    rateLimitExceeded: {
      code: "codex_usage_limited",
      message: "Codex reported a usage or rate limit.",
    },
    sessionBudgetExceeded: {
      code: "codex_usage_limited",
      message: "Codex reported a session budget limit.",
    },
    unauthorized: {
      code: "codex_not_authenticated",
      message: "Codex authentication failed. Check the Codex backend login.",
    },
    serverOverloaded: {
      code: "codex_server_error",
      message: "Codex reported an overloaded server.",
    },
    internalServerError: {
      code: "codex_server_error",
      message: "Codex reported an internal server error.",
    },
  };
  if (typeof info === "string") return Object.hasOwn(categories, info) ? categories[info]! : null;
  const variants = asRecord(info);
  for (const [variant, code, message] of [
    [
      "httpConnectionFailed",
      "codex_connection_failed",
      "Codex could not connect to its upstream service.",
    ],
    [
      "responseStreamConnectionFailed",
      "codex_connection_failed",
      "Codex could not open its response stream.",
    ],
    ["responseStreamDisconnected", "codex_stream_disconnected", "Codex lost its response stream."],
    [
      "responseTooManyFailedAttempts",
      "codex_retry_exhausted",
      "Codex exhausted its upstream retry attempts.",
    ],
  ] as const) {
    if (!variants || !Object.hasOwn(variants, variant)) continue;
    const status = asRecord(variants[variant])?.httpStatusCode;
    if (status === 401 || status === 403) return categories.unauthorized!;
    if (status === 429) return categories.rateLimitExceeded!;
    return { code, message };
  }
  return null;
}

function codexErrorText(err: unknown): string {
  return err instanceof Error
    ? err.message
    : (stringField(asRecord(err), "message") ?? String(err));
}

function codexErrorCode(err: unknown): string {
  const structured = structuredCodexFailure(err);
  if (structured) return structured.code;
  const msg = codexErrorText(err);
  if (/^Input exceeds the maximum length of \d+ characters\.$/i.test(msg))
    return "codex_input_too_large";
  if (isCodexContextWindowError(msg)) return "context_window_exceeded";
  if (/not found|ENOENT/i.test(msg)) return "codex_binary_missing";
  if (/unsupported codex cli version/i.test(msg)) return "codex_unsupported_version";
  if (/unauthorized|401|auth|login/i.test(msg)) return "codex_not_authenticated";
  if (/rate limit|quota|usage limit|429|credit/i.test(msg)) return "codex_usage_limited";
  if (/model/i.test(msg)) return "codex_invalid_model";
  return "codex_runtime_error";
}

function friendlyCodexErrorMessage(err: unknown, codexHome: string): string {
  const structured = structuredCodexFailure(err);
  if (structured) return structured.message;
  const msg = codexErrorText(err);
  if (/^Input exceeds the maximum length of \d+ characters\.$/i.test(msg))
    return "The search or conversation history exceeds Codex's turn input limit. Try a narrower search or a new conversation.";
  if (isCodexContextWindowError(msg)) return CONTEXT_WINDOW_EXCEEDED_MESSAGE;
  if (/not found|ENOENT/i.test(msg)) {
    return "Codex CLI was not found. Install or configure a supported Codex CLI runtime.";
  }
  if (/unsupported codex cli version/i.test(msg)) {
    return "The installed Codex CLI version is unsupported. Update Codex and retry.";
  }
  if (/unauthorized|401|auth|login/i.test(msg)) {
    return `Codex is not authenticated for Omnesis. Log in from Models > Backends > Codex, or run omnesis codex login for ${codexHome}.`;
  }
  if (/rate limit|quota|usage limit|429|credit/i.test(msg)) {
    return "Codex reported a usage or rate limit.";
  }
  if (/model/i.test(msg) && /invalid|not found|unsupported|does not exist/i.test(msg)) {
    return "Codex rejected the configured model. Set inference.assignments.agent to a valid codex/<model> value.";
  }
  return "Codex runtime failed.";
}

function isCodexContextWindowError(message: string): boolean {
  return (
    /\bcontext(?: length| window)?(?: is)? (?:exceeded|full)\b/i.test(message) ||
    /\bmaximum context length\b.{0,120}\b(?:exceed|requested)\w*/i.test(message) ||
    /\bprompt is too long\b/i.test(message) ||
    /\binput\b.{0,80}\btoo long\b.{0,80}\bcontext\b/i.test(message)
  );
}

function unknownCodexContext() {
  return {
    measurement: "unknown" as const,
    limitSource: "unknown" as const,
    requestIteration: 1,
  };
}

function formatZodError(err: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  const issues = err.issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "arguments";
    return `${path}: ${issue.message}`;
  });
  return `tool arguments did not match the Omnesis schema${issues.length > 0 ? ` (${issues.join("; ")})` : ""}`;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to use symlinked Codex runtime directory: ${path}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Codex runtime path is not a directory: ${path}`);
    }
  } catch (err) {
    if (!isNodeErrno(err, "ENOENT")) throw err;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  await chmod(path, 0o700);
}

async function rejectSymlinkIfPresent(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write symlinked Codex config file: ${path}`);
    }
  } catch (err) {
    if (!isNodeErrno(err, "ENOENT")) throw err;
  }
}

function isNodeErrno(err: unknown, code: string): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
