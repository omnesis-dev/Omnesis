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
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import {
  createLogger,
  readPackageVersion,
  type AgentEvent,
  type Logger,
  type ToolResult,
} from "@omnesis/core";

import { zodToJsonSchema } from "./zod-to-json-schema.js";
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
import { CONTEXT_WINDOW_EXCEEDED_MESSAGE } from "./turn-outcome.js";
import type { ChatBackend, ChatMessage, ToolCaller, ToolHandle, TurnInput } from "./backend.js";

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
  /** Empty Omnesis-owned working directory handed to Codex as cwd. */
  workspaceDir?: string;
  /** Advanced override. When unset, Omnesis uses its pinned managed @openai/codex runtime. */
  command?: string;
  /** Pre-resolved gateway-owned managed runtime. Takes precedence over package resolution. */
  commandInfo?: CodexRuntimeCommandInfo;
  args?: readonly string[];
  versionArgs?: readonly string[];
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
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

export class CodexAppServerRuntime {
  readonly codexHome: string;
  readonly workspaceDir: string;

  private readonly commandOverride: string | undefined;
  private readonly configuredCommandInfo: CodexRuntimeCommandInfo | undefined;
  private readonly args: readonly string[];
  private readonly versionArgs: readonly string[];
  private readonly startupTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: Logger;

  private client: CodexJsonRpcClient | null = null;
  private startingClient: Promise<CodexJsonRpcClient> | null = null;
  private commandInfo: CodexRuntimeCommandInfo | null = null;
  private activeTurn: ActiveCodexTurn | null = null;
  private turnQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(opts: CodexAppServerRuntimeOptions) {
    this.codexHome = opts.codexHome;
    this.workspaceDir = opts.workspaceDir ?? join(opts.codexHome, DEFAULT_CODEX_WORKSPACE_DIRNAME);
    this.commandOverride = opts.command?.trim() || undefined;
    this.configuredCommandInfo = opts.commandInfo;
    this.args = opts.args ?? DEFAULT_CODEX_ARGS;
    this.versionArgs = opts.versionArgs ?? DEFAULT_CODEX_VERSION_ARGS;
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    this.env = opts.env ?? process.env;
    this.log = opts.logger ?? log;
  }

  async resolveCommandInfo(): Promise<CodexRuntimeCommandInfo> {
    if (!this.commandInfo) {
      this.commandInfo =
        this.configuredCommandInfo ??
        (await resolveCodexRuntimeCommand({
          commandOverride: this.commandOverride,
        }));
    }
    return this.commandInfo;
  }

  async probeRuntime(timeoutMs = this.startupTimeoutMs): Promise<CodexRuntimeProbe> {
    const commandInfo = await this.resolveCommandInfo();
    return assertSupportedCodexRuntime({
      command: commandInfo.command,
      args: this.versionArgs,
      env: buildCodexEnv(this.env, this.codexHome),
      timeoutMs,
    });
  }

  async listModels(timeoutMs = this.requestTimeoutMs): Promise<unknown[]> {
    const client = await this.ensureClient();
    const models: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await client.request(
        "model/list",
        { cursor, includeHidden: false, limit: 100 },
        timeoutMs,
      );
      const record = asRecord(result);
      const data = Array.isArray(record?.data) ? record.data : [];
      models.push(...data);
      cursor = stringField(record, "nextCursor") ?? undefined;
      if (!cursor) break;
    }
    return models;
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
          retryable: code !== "context_window_exceeded",
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
      completed: false,
      answer: input.finalAnswerOnly ? { deltas: "", phased: false } : undefined,
      toolCalls: 0,
      toolTimeoutMs,
      maxToolIterations,
      signal,
    };

    const abort = (): void => {
      if (state.completed) return;
      if (state.threadId && state.turnId) {
        void client
          .request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }, 2_000)
          .catch(() => {});
      }
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
          config: STRICT_CODEX_CONFIG_OBJECT,
          // Present in the 0.142.x app-server runtime even though the generated
          // TS schema omits it. Keep this as a narrow boundary object.
          dynamicTools: tools,
        },
        this.requestTimeoutMs,
      );
      const parsedThreadId = extractThreadId(threadResult);
      if (!parsedThreadId) throw new Error("Codex app-server did not return a thread id");
      threadId = parsedThreadId;
      state.threadId = threadId;
      this.activeTurn = state;

      const turnResult = await client.request(
        "turn/start",
        {
          threadId,
          input: [
            { type: "text", text: renderCodexUserInput(input.history, input.userMessage) },
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
      if (state.turnId && state.turnId !== turnId) {
        throw new Error("Codex app-server returned a turn id that did not match its early events");
      }
      state.turnId = turnId;

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
            retryable: code !== "context_window_exceeded",
            backend: "codex",
            model,
          },
        });
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.activeTurn === state) this.activeTurn = null;
      queue.close();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.completeActiveTurn("canceled");
    const starting = this.startingClient;
    const client = this.client;
    this.client = null;
    if (starting) {
      try {
        const started = await starting;
        if (started !== client) await started.dispose();
      } catch {
        /* startup was already failing; dispose remains best-effort */
      }
    }
    await client?.dispose();
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

  private async startClient(): Promise<CodexJsonRpcClient> {
    await ensureCodexRuntimeDirs(this.codexHome, this.workspaceDir);
    const commandInfo = await this.resolveCommandInfo();
    await assertSupportedCodexRuntime({
      command: commandInfo.command,
      args: this.versionArgs,
      env: buildCodexEnv(this.env, this.codexHome),
      timeoutMs: this.startupTimeoutMs,
    });

    const client = new CodexJsonRpcClient({
      command: commandInfo.command,
      args: this.args,
      cwd: this.workspaceDir,
      env: buildCodexEnv(this.env, this.codexHome),
      requestTimeoutMs: this.requestTimeoutMs,
      log: this.log,
      onNotification: (method, params) => this.handleNotification(method, params),
      onServerRequest: (method, params) => this.handleServerRequest(method, params),
      onExit: (code, sig) => this.handleClientExit(code, sig),
    });
    client.start();
    this.client = client;
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
    } catch (err) {
      if (this.client === client) this.client = null;
      await client.dispose().catch(() => {});
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
    const callId = stringField(p, "callId") ?? "codex_tool_call";
    const tool = stringField(p, "tool") ?? "";
    const rawArgs = p?.arguments ?? {};

    if (!state || !this.acceptTurnScopedParams(state, params)) {
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
      contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
    };
  }

  private handleNotification(method: string, params: unknown): void {
    const state = this.activeTurn;
    if (!state) return;

    if (method === "item/agentMessage/delta") {
      if (!this.acceptTurnScopedParams(state, params)) return;
      const p = asRecord(params);
      const delta = stringField(p, "delta");
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
      state.usage = parseCodexUsage(p?.tokenUsage);
      if (Object.keys(state.usage).length > 0) {
        state.queue.push(
          wrapEvent("agent.usage.update", {
            sessionId: state.sessionId,
            messageId: state.messageId,
            usage: state.usage,
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
          "codex_turn_failed",
          friendlyCodexErrorMessage(
            stringField(error, "message") ?? "Codex turn failed",
            this.codexHome,
          ),
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
      const message = stringField(error, "message") ?? "Codex runtime error";
      this.failActiveTurn(
        codexErrorCode(message),
        friendlyCodexErrorMessage(message, this.codexHome),
      );
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      if (!this.acceptTurnScopedParams(state, params)) return;
      const item = asRecord(asRecord(params)?.item);
      const itemType = stringField(item, "type");
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

  private handleClientExit(code: number | null, sig: NodeJS.Signals | null): void {
    if (!this.activeTurn || this.activeTurn.completed) return;
    this.failActiveTurn(
      "codex_process_exited",
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
    if (!state.turnId) {
      state.turnId = turnId;
      return true;
    }
    return turnId === state.turnId;
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
    const inputTokens = state.usage.inputTokens;
    state.queue.push(
      wrapEvent("agent.message.end", {
        sessionId: state.sessionId,
        messageId: state.messageId,
        stopReason,
        usage: Object.keys(state.usage).length > 0 ? state.usage : undefined,
        context: {
          ...(inputTokens === undefined
            ? {}
            : {
                inputTokens,
                peakInputTokens: inputTokens,
              }),
          measurement: inputTokens === undefined ? "unknown" : "provider_reported",
          limitSource: "unknown",
          requestIteration: 1,
        },
        ...(failure
          ? {
              failure: {
                ...failure,
                retryable: failure.code !== "context_window_exceeded",
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
    inputSchema: zodToJsonSchema(h.schema) as Record<string, unknown>,
  }));
}

export function renderCodexUserInput(
  history: ReadonlyArray<ChatMessage>,
  userMessage: string,
): string {
  if (history.length === 0) return userMessage;

  const lines = ["Conversation so far:"];
  for (const msg of history) {
    if (msg.role === "user") {
      for (const part of msg.parts) {
        if (part.kind === "text") lines.push(`User: ${part.text}`);
        if (part.kind === "tool_result") {
          lines.push(`Tool result ${part.toolCallId}: ${safeJsonStringify(part.result)}`);
        }
      }
    } else {
      for (const part of msg.parts) {
        if (part.kind === "text") lines.push(`Assistant: ${part.text}`);
        if (part.kind === "thinking") lines.push(`Assistant reasoning summary: ${part.text}`);
        if (part.kind === "tool_use") {
          lines.push(`Assistant called ${part.tool}: ${safeJsonStringify(part.args)}`);
        }
      }
    }
  }
  lines.push("");
  lines.push("New user message:");
  lines.push(userMessage);
  return lines.join("\n");
}

export async function ensureCodexHome(codexHome: string): Promise<void> {
  await ensureCodexRuntimeDirs(codexHome, join(codexHome, DEFAULT_CODEX_WORKSPACE_DIRNAME));
}

export async function ensureCodexRuntimeDirs(
  codexHome: string,
  workspaceDir: string,
): Promise<void> {
  await ensurePrivateDirectory(codexHome);
  await ensurePrivateDirectory(workspaceDir);
  const configPath = join(codexHome, "config.toml");
  await rejectSymlinkIfPresent(configPath);
  await writeFile(configPath, STRICT_CODEX_CONFIG_TOML, { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600);
}

export function buildCodexEnv(env: NodeJS.ProcessEnv, codexHome: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const key of SAFE_CODEX_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) childEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SAFE_CODEX_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      childEnv[key] = value;
    }
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
    const result = await execFileAsync(
      opts.command,
      [...(opts.args ?? DEFAULT_CODEX_VERSION_ARGS)],
      {
        env: opts.env,
        timeout: opts.timeoutMs ?? 10_000,
        windowsHide: true,
      },
    );
    stdout = `${result.stdout}${result.stderr}`;
  } catch (err) {
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
  completed: boolean;
  answer?: { deltas: string; phased: boolean; final?: string; unphased?: string };
  toolCalls: number;
  toolTimeoutMs: number;
  maxToolIterations: number;
  signal?: AbortSignal;
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
  private pending = new Map<RequestId, PendingRequest>();
  private disposed = false;

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
      onExit(code: number | null, sig: NodeJS.Signals | null): void;
    },
  ) {}

  start(): void {
    if (this.proc) return;
    this.proc = spawn(this.opts.command, [...this.opts.args], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const stdout = createInterface({ input: this.proc.stdout });
    stdout.on("line", (line) => this.handleLine(line));
    const stderr = createInterface({ input: this.proc.stderr });
    stderr.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) this.opts.log.warn(`Codex app-server wrote stderr (${trimmed.length} chars)`);
    });

    this.proc.once("error", (err) => {
      this.rejectAll(new Error(`Codex app-server failed to start: ${err.message}`));
      this.opts.onExit(null, null);
    });
    this.proc.once("exit", (code, sig) => {
      if (!this.disposed) {
        this.rejectAll(new Error(`Codex app-server exited (${sig ?? code ?? "unknown"})`));
        this.opts.onExit(code, sig);
      }
    });
  }

  request(
    method: string,
    params: unknown,
    timeoutMs = this.opts.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Codex app-server disposed"));
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

  async dispose(): Promise<void> {
    this.disposed = true;
    const proc = this.proc;
    this.proc = null;
    this.rejectAll(new Error("Codex app-server disposed"));
    if (!proc) return;
    if (proc.exitCode !== null || proc.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2_000);
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
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
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

function parseCodexUsage(value: unknown): AgentEndUsage {
  const usage = asRecord(value);
  const last = asRecord(usage?.last) ?? asRecord(usage?.total);
  if (!last) return {};
  return {
    inputTokens: numberField(last, "inputTokens"),
    outputTokens: numberField(last, "outputTokens"),
    cacheReadTokens: numberField(last, "cachedInputTokens"),
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

function codexErrorCode(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (isCodexContextWindowError(msg)) return "context_window_exceeded";
  if (/not found|ENOENT/i.test(msg)) return "codex_binary_missing";
  if (/unsupported codex cli version/i.test(msg)) return "codex_unsupported_version";
  if (/unauthorized|401|auth|login/i.test(msg)) return "codex_not_authenticated";
  if (/rate limit|quota|usage limit|429|credit/i.test(msg)) return "codex_usage_limited";
  if (/model/i.test(msg)) return "codex_invalid_model";
  return "codex_runtime_error";
}

function friendlyCodexErrorMessage(err: unknown, codexHome: string): string {
  const msg = err instanceof Error ? err.message : String(err);
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

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(safeJsonParse(String(value)));
  }
}
