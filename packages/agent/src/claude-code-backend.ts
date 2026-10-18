// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Claude Code backend.
 *
 * Runs the operator's own installed, signed-in `claude` CLI as the agent loop
 * underneath an Omnesis turn, so a Claude subscription can power the agent.
 * Like the Codex backend it is a thin runtime adapter: Omnesis owns the
 * conversation store, system prompt and tool registry. Every turn is a fresh
 * `claude -p` process speaking the stream-json protocol; Omnesis' canonical
 * transcript is replayed as text, so nothing persists inside Claude Code.
 *
 * The model may use Omnesis tools and nothing else. Every built-in Claude Code
 * tool is removed (`--tools ""`), user/project settings, CLAUDE.md files,
 * hooks, skills, slash commands and configured MCP servers are not loaded, and
 * Omnesis' tools are served by an in-process MCP server tunnelled over the
 * CLI's own control channel — no socket, no port, no extra process. The turn
 * then verifies what the CLI reports: a session advertising any tool outside
 * that server, or a model reaching for one, fails closed.
 *
 * Omnesis never reads, stores or relays Claude credentials. The CLI uses
 * whatever login its owner made with `claude auth login` (or a
 * `CLAUDE_CODE_OAUTH_TOKEN` they exported for it); API-key variables are never
 * forwarded, so a turn always runs on that login rather than on API billing.
 */

import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  createLogger,
  readPackageVersion,
  type AgentContextAssessment,
  type AgentEvent,
  type Logger,
  type ToolResult,
} from "@omnesis/core";

import {
  childEventHooks,
  DEFAULT_MAX_TOOL_ITERATIONS,
  probeTurnEvents,
  summarizeToolArgs,
  toolResultHasErrors,
  wrapEvent,
  type ChatBackend,
  type ToolHandle,
  type TurnInput,
} from "./backend.js";
import { stripLocalTimeAnnotationsDeep } from "./local-times.js";
import { serializeToolResultForModel } from "./tool-result-text.js";
import { renderTranscriptUserInput } from "./transcript-user-input.js";
import { CONTEXT_WINDOW_EXCEEDED_MESSAGE } from "./turn-outcome.js";
import { toolInputJsonSchema } from "./zod-to-json-schema.js";

const execFileAsync = promisify(execFile);
const log = createLogger("agent:claude-code");
const AGENT_VERSION = readPackageVersion(import.meta.url);

/**
 * The oldest Claude Code release this backend accepts: the first whose print
 * mode takes `--permission-prompts none`, which denies anything that would
 * otherwise prompt instead of asking a host that never answers.
 */
export const CLAUDE_CODE_MIN_VERSION = "2.1.259";

/** The in-process MCP server name; Claude Code prefixes its tools `mcp__omnesis__`. */
export const CLAUDE_CODE_TOOL_SERVER = "omnesis";
const TOOL_PREFIX = `mcp__${CLAUDE_CODE_TOOL_SERVER}__`;

/** Environment the CLI inherits. Anything else — API keys above all — stays out. */
const SAFE_CLAUDE_CODE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  // Where the operator keeps their Claude Code login, when not ~/.claude.
  "CLAUDE_CONFIG_DIR",
  // A long-lived subscription token from `claude setup-token`, the documented
  // sign-in for a host without a browser.
  "CLAUDE_CODE_OAUTH_TOKEN",
  "SystemRoot",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
]);

/**
 * Inline settings for every turn: no hooks, and Claude Code's own built-in
 * plugins switched off. Those plugins contribute skills and context, never
 * tools, and `verifySession` refuses any that would surface anyway.
 */
const CLAUDE_CODE_SETTINGS = Object.freeze({
  disableAllHooks: true,
  enabledPlugins: {
    "cc-plugin-agents-md@builtin": false,
    "cc-plugin-plugin-authoring@builtin": false,
  },
});

/** Fixed settings that keep the operator's own Claude Code customizations out of a turn. */
const ISOLATION_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  // claude.ai connectors, deferred tool loading and background tasks stay off
  // even if a CLI release stops honouring the flags that already exclude them.
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  ENABLE_TOOL_SEARCH: "false",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
});

/**
 * Claude Code's managed policy files. Their settings apply whatever flags a
 * session passes, so Omnesis reads them before every turn.
 */
function defaultManagedSettingsDirs(): string[] {
  switch (process.platform) {
    case "darwin":
      return ["/Library/Application Support/ClaudeCode"];
    case "win32":
      return [join(process.env.ProgramData ?? "C:\\ProgramData", "ClaudeCode")];
    default:
      return ["/etc/claude-code"];
  }
}

/** Managed settings that make the CLI run commands of its own, outside any tool call. */
const MANAGED_COMMAND_SETTINGS = [
  "hooks",
  "apiKeyHelper",
  "awsAuthRefresh",
  "awsCredentialExport",
  "otelHeadersHelper",
  "statusLine",
  "enabledPlugins",
  "env",
] as const;

/**
 * Name the managed policy settings that would let Claude Code run commands
 * Omnesis cannot see, or null when there are none. An unreadable policy file
 * counts as one that sets them.
 */
export async function findManagedPolicyConflict(dirs: readonly string[]): Promise<string | null> {
  for (const dir of dirs) {
    const files = [join(dir, "managed-settings.json")];
    try {
      const dropIns = await readdir(join(dir, "managed-settings.d"));
      files.push(
        ...dropIns
          .filter((f) => f.endsWith(".json"))
          .map((f) => join(dir, "managed-settings.d", f)),
      );
    } catch {
      /* no drop-in directory */
    }
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        return `Claude Code's managed policy file ${file} could not be read`;
      }
      let settings: Record<string, unknown> | null;
      try {
        settings = asRecord(JSON.parse(text));
      } catch {
        settings = null;
      }
      if (!settings) return `Claude Code's managed policy file ${file} could not be read`;
      const found = MANAGED_COMMAND_SETTINGS.filter((key) => settings[key] !== undefined);
      if (found.length > 0) {
        return `Claude Code's managed policy (${file}) sets ${found.join(", ")}`;
      }
    }
  }
  return null;
}

/** Places the official installers put `claude`, for a gateway whose PATH lacks them. */
function wellKnownClaudeCodePaths(home: string | undefined): string[] {
  return [
    ...(home
      ? [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")]
      : []),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ];
}

export interface ClaudeCodeRuntimeOptions {
  /** Empty Omnesis-owned working directory handed to the CLI as cwd. */
  workspaceDir: string;
  /** Explicit `claude` executable. When unset, PATH and the installers' locations are searched. */
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** How long a turn may wait for the CLI to report its session. */
  startupTimeoutMs?: number;
  /**
   * How long a running turn may go without any output from the CLI, outside
   * Omnesis tool calls, before it is treated as hung and stopped.
   */
  idleTimeoutMs?: number;
  logger?: Logger;
  /** Directories holding Claude Code's managed policy settings; the platform's by default. */
  managedSettingsDirs?: readonly string[];
  /** Further environment-variable prefixes passed to the CLI, for test doubles. */
  passEnvPrefixes?: readonly string[];
}

export interface ClaudeCodeTurnOptions {
  model: string;
  effort?: string;
  input: TurnInput;
  toolTimeoutMs: number;
  maxToolIterations: number;
  signal?: AbortSignal;
}

/** What {@link ClaudeCodeBackend} needs from a runtime; the gateway wraps it with admission. */
export interface ClaudeCodeTurnRunner {
  runTurn(opts: ClaudeCodeTurnOptions): AsyncIterable<AgentEvent>;
}

export interface ClaudeCodeAuthStatus {
  loggedIn: boolean;
  /** As reported by `claude auth status`, e.g. `claude.ai` or `oauth_token`. */
  authMethod?: string;
  /** Subscription tier, e.g. `pro` or `max`, when signed in to a Claude plan. */
  subscriptionType?: string;
}

/** One entry of the CLI's model catalog (`list_models`). */
export interface ClaudeCodeModelInfo {
  /** Value accepted by `--model`: an alias such as `opus` or a full model id. */
  value: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportedEffortLevels?: string[];
}

export class ClaudeCodeRuntime implements ClaudeCodeTurnRunner {
  readonly workspaceDir: string;
  private readonly commandOverride: string | undefined;
  private readonly env: NodeJS.ProcessEnv;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly managedSettingsDirs: readonly string[];
  private readonly startupTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly log: Logger;
  private resolvedCommand: string | null = null;

  constructor(opts: ClaudeCodeRuntimeOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.commandOverride = opts.command?.trim() || undefined;
    this.env = opts.env ?? process.env;
    this.childEnv = buildClaudeCodeEnv(this.env, opts.passEnvPrefixes);
    this.managedSettingsDirs = opts.managedSettingsDirs ?? defaultManagedSettingsDirs();
    this.startupTimeoutMs = opts.startupTimeoutMs ?? 30_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 5 * 60_000;
    this.log = opts.logger ?? log;
  }

  /** The `claude` executable, resolved once and then reused until {@link forgetCommand}. */
  async resolveCommand(): Promise<string> {
    if (this.resolvedCommand) return this.resolvedCommand;
    const command = await resolveClaudeCodeCommand({
      commandOverride: this.commandOverride,
      env: this.env,
    });
    this.resolvedCommand = command;
    return command;
  }

  /** Drop the cached executable so the next call searches again (after an install). */
  forgetCommand(): void {
    this.resolvedCommand = null;
  }

  /**
   * The CLI's version and whether Omnesis supports it. A CLI that runs but is
   * too old still reports its version, so callers can ask for an update rather
   * than an install; a CLI that cannot report one throws.
   */
  async probeVersion(
    timeoutMs = 15_000,
  ): Promise<{ command: string; version: string; supported: boolean; reason?: string }> {
    const command = await this.resolveCommand();
    let output: string;
    try {
      const result = await execFileAsync(command, ["--version"], {
        env: this.childEnv,
        timeout: timeoutMs,
        windowsHide: true,
      });
      output = `${result.stdout}${result.stderr}`;
    } catch (err) {
      this.forgetCommand();
      throw new Error(`Claude Code probe failed: ${conciseError(err)}`, { cause: err });
    }
    const version = parseClaudeCodeVersion(output);
    if (!version) {
      throw new Error(`Claude Code returned an unrecognized version string: ${output.trim()}`);
    }
    if (!isSupportedClaudeCodeVersion(version)) {
      return {
        command,
        version,
        supported: false,
        reason: `Claude Code ${version} is too old. Omnesis needs ${CLAUDE_CODE_MIN_VERSION} or later; run "claude update".`,
      };
    }
    return { command, version, supported: true };
  }

  async authStatus(timeoutMs = 15_000): Promise<ClaudeCodeAuthStatus> {
    const command = await this.resolveCommand();
    let stdout: string;
    try {
      const result = await execFileAsync(command, ["auth", "status", "--json"], {
        env: this.childEnv,
        timeout: timeoutMs,
        windowsHide: true,
      });
      stdout = String(result.stdout);
    } catch (err) {
      // Signed out is exit 1 with the same JSON on stdout.
      const out = (err as { stdout?: unknown }).stdout;
      if (typeof out !== "string" || !out.trim()) throw err;
      stdout = out;
    }
    return parseClaudeCodeAuthStatus(stdout);
  }

  /**
   * Refuse to start Claude Code where its managed policy would make it run
   * commands of its own: those happen outside any tool call Omnesis can see.
   */
  async assertNoManagedPolicyConflict(): Promise<void> {
    const conflict = await findManagedPolicyConflict(this.managedSettingsDirs);
    if (conflict) {
      throw new Error(
        `${conflict}. Omnesis runs the agent on Claude Code only where its managed policy cannot run commands of its own; remove those settings or assign another backend.`,
      );
    }
  }

  /** The CLI's model catalog, from a session that never sends a prompt. */
  async listModels(timeoutMs = 30_000): Promise<ClaudeCodeModelInfo[]> {
    await ensureWorkspace(this.workspaceDir);
    const command = await this.resolveCommand();
    await this.assertNoManagedPolicyConflict();
    let unexpected: string | null = null;
    const session = new ClaudeCodeProcess({
      command,
      args: claudeCodeSessionArgs({ hasTools: false }),
      cwd: this.workspaceDir,
      env: this.childEnv,
      log: this.log,
      onMessage: () => {},
      onMcpMessage: () => Promise.resolve(undefined),
      onUnexpectedRequest: (subtype) => {
        unexpected = subtype;
        session.kill();
      },
    });
    session.start();
    try {
      const initialized = await withTimeout(
        session.request({ subtype: "initialize" }),
        timeoutMs,
        "initialize",
      );
      const loaded = sessionLoadedItsOwn(asRecord(initialized));
      if (loaded) throw new Error(`Claude Code loaded ${loaded} of its own.`);
      if (unexpected) throw new Error(`Claude Code sent an unexpected ${unexpected} request.`);
      const response = await withTimeout(
        session.request({ subtype: "list_models" }),
        timeoutMs,
        "list_models",
      );
      return parseClaudeCodeModels(asRecord(response)?.models);
    } finally {
      await session.dispose();
    }
  }

  async *runTurn(opts: ClaudeCodeTurnOptions): AsyncIterable<AgentEvent> {
    const { input, model, signal } = opts;
    const { sessionId, messageId } = input;
    yield wrapEvent("agent.message.start", { sessionId, messageId, role: "assistant" });

    let command: string;
    try {
      await ensureWorkspace(this.workspaceDir);
      command = await this.resolveCommand();
      await this.assertNoManagedPolicyConflict();
    } catch (err) {
      yield* failedTurn(input, model, err);
      return;
    }
    if (signal?.aborted) {
      yield wrapEvent("agent.message.end", {
        sessionId,
        messageId,
        stopReason: "canceled",
        context: unknownContext(),
      });
      return;
    }

    const turn = new ClaudeCodeTurn({
      input,
      model,
      toolTimeoutMs: opts.toolTimeoutMs,
      maxToolIterations: opts.maxToolIterations,
      startupTimeoutMs: this.startupTimeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
      signal,
    });
    const session = new ClaudeCodeProcess({
      command,
      args: claudeCodeSessionArgs({
        hasTools: input.tools.length > 0,
        model,
        effort: opts.effort,
      }),
      cwd: this.workspaceDir,
      env: this.childEnv,
      log: this.log,
      onMessage: (message) => turn.onMessage(message),
      onMcpMessage: (message) => turn.onMcpMessage(message),
      onUnexpectedRequest: (subtype) =>
        turn.violation(`Claude Code sent a ${subtype} request Omnesis never registered for.`),
      onExit: (code, sig) => turn.onExit(code, sig),
    });
    turn.attach(session);

    const abort = (): void => turn.cancel();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      session.start();
      try {
        const initialized = await session.request({
          subtype: "initialize",
          ...(input.tools.length > 0 ? { sdkMcpServers: [CLAUDE_CODE_TOOL_SERVER] } : {}),
          systemPrompt: [input.systemPrompt],
        });
        // Nothing of the conversation leaves Omnesis until the CLI has shown
        // it built a session without agents or commands of its own.
        if (turn.acceptInitialize(asRecord(initialized))) {
          session.send({
            type: "user",
            message: { role: "user", content: claudeCodeUserContent(input) },
            parent_tool_use_id: null,
          });
        }
      } catch (err) {
        turn.fail(claudeCodeErrorCode(conciseError(err)), friendlyClaudeCodeError(err));
      }
      yield* turn.events();
    } finally {
      signal?.removeEventListener("abort", abort);
      await session.dispose();
    }
  }
}

export interface ClaudeCodeBackendOptions {
  model: string;
  effort?: string;
  runtime: ClaudeCodeTurnRunner;
  toolTimeoutMs?: number;
  maxToolIterations?: number;
  /** Exclude commentary from single-shot inference outputs. */
  finalAnswerOnly?: boolean;
}

export class ClaudeCodeBackend implements ChatBackend {
  readonly name = "claude-code";
  readonly model: string;
  private readonly effort: string | undefined;
  private readonly runtime: ClaudeCodeTurnRunner;
  private readonly toolTimeoutMs: number;
  private readonly maxToolIterations: number;
  private readonly finalAnswerOnly: boolean;

  constructor(opts: ClaudeCodeBackendOptions) {
    this.model = opts.model;
    this.effort = opts.effort;
    this.runtime = opts.runtime;
    this.toolTimeoutMs = opts.toolTimeoutMs ?? 60_000;
    this.maxToolIterations = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    this.finalAnswerOnly = opts.finalAnswerOnly ?? false;
  }

  async *runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    // The CLI runs its own model-call loop, opaque here: one span per turn.
    yield* probeTurnEvents(
      input.llmProbe,
      this.runtime.runTurn({
        model: this.model,
        effort: this.effort,
        input: this.finalAnswerOnly ? { ...input, finalAnswerOnly: true } : input,
        toolTimeoutMs: this.toolTimeoutMs,
        maxToolIterations: this.maxToolIterations,
        signal,
      }),
    );
  }
}

// ─── One turn ──────────────────────────────────────────────────────────────

type Usage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number };

/** Translates one CLI session's stream into Omnesis agent events. */
class ClaudeCodeTurn {
  private readonly queue = new EventQueue<AgentEvent>();
  private readonly handles: Map<string, ToolHandle>;
  private session: ClaudeCodeProcess | null = null;
  private completed = false;
  private canceled = false;
  private toolCalls = 0;
  private usage: Usage = {};
  /** Per-request usage keyed by API message id, summed for live progress. */
  private readonly requestUsage = new Map<string, Usage>();
  private contextInputTokens: number | undefined;
  private peakContextInputTokens: number | undefined;
  /** Error the CLI attached to an assistant message (`authentication_failed`, …). */
  private apiError: string | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set once the CLI's `system/init` matched the locked-down session asked for. */
  private verified = false;
  private toolsInFlight = 0;

  constructor(
    private readonly opts: {
      input: TurnInput;
      model: string;
      toolTimeoutMs: number;
      maxToolIterations: number;
      /** How long the CLI may take to report the session it built. */
      startupTimeoutMs: number;
      idleTimeoutMs: number;
      signal?: AbortSignal;
    },
  ) {
    this.handles = new Map(opts.input.tools.map((h) => [h.name, h]));
  }

  /** `tool_use` ids of the Omnesis tool calls the model made this turn. */
  private readonly omnesisToolUseIds = new Set<string>();

  attach(session: ClaudeCodeProcess): void {
    this.session = session;
    this.startupTimer = setTimeout(() => {
      this.fail(
        "claude_code_startup_timeout",
        `Claude Code did not start a session within ${Math.round(this.opts.startupTimeoutMs / 1000)}s.`,
      );
    }, this.opts.startupTimeoutMs);
  }

  events(): AsyncIterable<AgentEvent> {
    return this.queue;
  }

  private get ids(): { sessionId: string; messageId: string } {
    return { sessionId: this.opts.input.sessionId, messageId: this.opts.input.messageId };
  }

  /**
   * Check the CLI's answer to `initialize` before any conversation is sent:
   * it must carry no agents or slash commands of its own. Returns whether the
   * turn may proceed.
   */
  acceptInitialize(response: Record<string, unknown> | null): boolean {
    if (this.completed) return false;
    const loaded = sessionLoadedItsOwn(response);
    if (loaded) {
      this.violation(`Claude Code loaded ${loaded} of its own; Omnesis refuses to run the turn.`);
      return false;
    }
    return true;
  }

  onMessage(message: Record<string, unknown>): void {
    if (this.completed) return;
    this.armIdleTimer();
    switch (message.type) {
      case "system": {
        const subtype = stringField(message, "subtype") ?? "";
        if (subtype === "init") {
          clearTimeout(this.startupTimer);
          this.verifySession(message);
        } else if (subtype.startsWith("hook_") || subtype.startsWith("task_")) {
          // Hooks and background tasks run commands outside any tool call.
          this.violation(`Claude Code ran work Omnesis did not ask for (${subtype}).`);
        }
        return;
      }
      case "tool_progress":
        // The CLI reports progress on any long-running call, Omnesis' own
        // included; only progress on a call Omnesis did not run is foreign.
        if (!this.omnesisToolUseIds.has(progressCallId(message)))
          this.violation("Claude Code reported progress on a tool Omnesis does not run.");
        return;
      case "user":
        this.checkToolResults(message);
        return;
      case "stream_event":
        this.onStreamEvent(asRecord(message.event));
        return;
      case "assistant":
        this.onAssistant(message);
        return;
      case "result":
        this.onResult(message);
        return;
      default:
        return;
    }
  }

  /**
   * Fail closed unless the session the CLI built is exactly the one asked for:
   * Omnesis' tools through Omnesis' in-process server, and nothing else. This
   * is the check that survives a CLI release whose defaults drift from the
   * flags above, so anything it cannot read counts as a violation.
   */
  private verifySession(init: Record<string, unknown>): void {
    if (!Array.isArray(init.tools) || !Array.isArray(init.mcp_servers)) {
      this.violation("Claude Code did not report the tools of its session.");
      return;
    }
    const expected = new Set(this.opts.input.tools.map((h) => `${TOOL_PREFIX}${h.name}`));
    const offered = init.tools.map((tool) => (typeof tool === "string" ? tool : ""));
    const foreign = offered.filter((tool) => !expected.has(tool));
    if (foreign.length > 0) {
      this.violation(
        `Claude Code offered tools outside Omnesis (${foreign.slice(0, 5).join(", ")}); Omnesis refuses to run the turn.`,
      );
      return;
    }
    const permissionMode = init.permissionMode;
    if (permissionMode !== undefined && permissionMode !== "dontAsk") {
      this.violation(`Claude Code started in permission mode ${String(permissionMode)}.`);
      return;
    }
    if (init.apiKeySource === "apiKeyHelper") {
      this.violation("Claude Code took its credentials from a command of its own (apiKeyHelper).");
      return;
    }
    // Skills, sub-agents and slash commands reach the model through tools it
    // does not have, but a session that loaded any is not the one Omnesis
    // configured. A plugin can only be one built into the CLI binary itself.
    for (const field of ["skills", "agents", "slash_commands"] as const) {
      const loaded = init[field];
      if (loaded !== undefined && (!Array.isArray(loaded) || loaded.length > 0)) {
        this.violation(`Claude Code loaded ${field.replace("_", " ")} Omnesis did not configure.`);
        return;
      }
    }
    if (init.plugins !== undefined) {
      const plugins = Array.isArray(init.plugins) ? init.plugins.map(asRecord) : [null];
      const external = plugins.find(
        (plugin) => !stringField(plugin, "source")?.endsWith("@builtin"),
      );
      if (external !== undefined) {
        this.violation(
          `Claude Code loaded a plugin Omnesis did not configure (${stringField(external, "name") ?? "unnamed"}).`,
        );
        return;
      }
    }
    const servers = init.mcp_servers.map(asRecord);
    const foreignServer = servers.find(
      (server) =>
        expected.size === 0 ||
        stringField(server, "name") !== CLAUDE_CODE_TOOL_SERVER ||
        stringField(server, "source") !== "sdk",
    );
    if (foreignServer !== undefined) {
      this.violation(
        `Claude Code connected an MCP server Omnesis did not configure (${stringField(foreignServer, "name") ?? "unnamed"}).`,
      );
      return;
    }
    this.verified = true;
  }

  private onStreamEvent(event: Record<string, unknown> | null): void {
    if (event?.type === "content_block_start") {
      this.checkToolUse(asRecord(event.content_block));
      return;
    }
    if (event?.type === "message_start") {
      const content = asRecord(event.message)?.content;
      for (const block of Array.isArray(content) ? content.map(asRecord) : []) {
        if (!this.checkToolUse(block)) return;
      }
      return;
    }
    if (!event || event.type !== "content_block_delta") return;
    const delta = asRecord(event.delta);
    if (delta?.type === "text_delta") {
      const text = stringField(delta, "text");
      if (text && !this.opts.input.finalAnswerOnly) {
        this.queue.push(wrapEvent("agent.text.delta", { ...this.ids, delta: text }));
      }
    } else if (delta?.type === "thinking_delta") {
      const text = stringField(delta, "thinking");
      if (text) this.queue.push(wrapEvent("agent.thinking.delta", { ...this.ids, delta: text }));
    }
  }

  private onAssistant(message: Record<string, unknown>): void {
    const error = stringField(message, "error");
    if (error) this.apiError = error;
    const body = asRecord(message.message);
    const content = Array.isArray(body?.content) ? body.content : [];
    for (const block of content.map(asRecord)) {
      if (!this.checkToolUse(block)) return;
    }
    const usage = asRecord(body?.usage);
    if (usage && stringField(body, "model") !== "<synthetic>") {
      const context =
        (numberField(usage, "input_tokens") ?? 0) +
        (numberField(usage, "cache_read_input_tokens") ?? 0) +
        (numberField(usage, "cache_creation_input_tokens") ?? 0);
      if (context > 0) {
        this.contextInputTokens = context;
        this.peakContextInputTokens = Math.max(this.peakContextInputTokens ?? 0, context);
      }
      // One API request can surface as several assistant messages sharing an
      // id and its usage, so live progress sums distinct requests.
      const requestId = stringField(body, "id");
      if (requestId && context > 0) {
        this.requestUsage.set(requestId, parseClaudeCodeUsage(usage));
        const live: Usage = {};
        for (const request of this.requestUsage.values())
          for (const key of ["inputTokens", "outputTokens", "cacheReadTokens"] as const)
            if (request[key] !== undefined) live[key] = (live[key] ?? 0) + request[key];
        this.queue.push(
          wrapEvent("agent.usage.update", { ...this.ids, usage: live, context: this.context() }),
        );
      }
    }
  }

  /** The latest request's input size, as far as the CLI reported it. */
  private context(): AgentContextAssessment {
    const inputTokens = this.contextInputTokens;
    return {
      ...(inputTokens === undefined
        ? {}
        : { inputTokens, peakInputTokens: this.peakContextInputTokens ?? inputTokens }),
      measurement: inputTokens === undefined ? "unknown" : "provider_reported",
      limitSource: "unknown",
      requestIteration: Math.max(1, this.requestUsage.size),
    };
  }

  /**
   * A model block must be text, thinking, or a `tool_use` of an Omnesis tool.
   * Anything else — a built-in, server-side (web search) or MCP tool, a tool
   * result Omnesis did not produce, or a block type this code does not know —
   * fails the turn. Returns false after failing it.
   */
  private checkToolUse(block: Record<string, unknown> | null): boolean {
    const type = stringField(block, "type") ?? "";
    if (type === "text" || type === "thinking" || type === "redacted_thinking") return true;
    const name = stringField(block, "name") ?? "";
    if (
      type === "tool_use" &&
      name.startsWith(TOOL_PREFIX) &&
      this.handles.has(name.slice(TOOL_PREFIX.length))
    ) {
      const id = stringField(block, "id");
      if (id) this.omnesisToolUseIds.add(id);
      return true;
    }
    this.violation(
      type === "tool_use" || type.endsWith("_use")
        ? `Claude Code attempted to use "${name || type}", which Omnesis does not provide.`
        : `Claude Code produced a "${type || "untyped"}" block Omnesis does not accept.`,
    );
    return false;
  }

  /** Every tool result the CLI reports must answer an Omnesis tool call. */
  private checkToolResults(message: Record<string, unknown>): void {
    const content = asRecord(message.message)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content.map(asRecord)) {
      if (stringField(block, "type") !== "tool_result") continue;
      const id = stringField(block, "tool_use_id");
      if (!id || !this.omnesisToolUseIds.has(id)) {
        this.violation("Claude Code reported the result of a tool Omnesis did not run.");
        return;
      }
    }
  }

  private onResult(result: Record<string, unknown>): void {
    this.usage = parseClaudeCodeUsage(result.usage);
    if (Object.keys(this.usage).length > 0) {
      this.queue.push(wrapEvent("agent.usage.update", { ...this.ids, usage: this.usage }));
    }
    if (this.canceled) {
      this.complete("canceled");
      return;
    }
    if (result.is_error === true || result.subtype !== "success") {
      // The result text is the model's or the CLI's prose, so it classifies
      // nothing beyond an overflowing prompt; the API error is authoritative.
      const errors = Array.isArray(result.errors) ? result.errors.filter(isString) : [];
      const detail = stringField(result, "result") || errors.join("; ");
      const code = this.apiError
        ? claudeCodeApiErrorCode(this.apiError)
        : isContextWindowError(detail)
          ? "context_window_exceeded"
          : "claude_code_runtime_error";
      this.fail(code, friendlyClaudeCodeError(detail || code, code));
      return;
    }
    if (!this.verified) {
      this.violation("Claude Code finished a turn without reporting its session.");
      return;
    }
    if (this.opts.input.finalAnswerOnly) {
      const text = stringField(result, "result");
      if (text) this.queue.push(wrapEvent("agent.text.delta", { ...this.ids, delta: text }));
    }
    this.complete("end_turn");
  }

  async onMcpMessage(
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const method = stringField(message, "method");
    const id = message.id;
    if (id === undefined || id === null) return undefined; // notification
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": {
        const params = asRecord(message.params);
        return reply({
          protocolVersion: stringField(params, "protocolVersion") ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: CLAUDE_CODE_TOOL_SERVER, version: AGENT_VERSION },
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: convertToolsToMcp(this.opts.input.tools) });
      case "tools/call":
        return reply(await this.callTool(asRecord(message.params)));
      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Unsupported method ${method}` },
        };
    }
  }

  private async callTool(params: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const tool = stringField(params, "name") ?? "";
    const meta = asRecord(params?._meta);
    const callId = stringField(meta, "claudecode/toolUseId") ?? `claude_code_${randomUUID()}`;
    // Validated as the tool will receive them: without the local-time
    // annotations the model may have copied from tool output.
    const rawArgs = stripLocalTimeAnnotationsDeep(params?.arguments ?? {});
    if (this.completed) {
      return mcpToolResult({ kind: "error", code: "stale_tool_call", message: "turn has ended" });
    }
    if (!this.verified) {
      this.violation("Claude Code called a tool before reporting its session.");
      return mcpToolResult({ kind: "error", code: "unverified_session", message: "turn refused" });
    }

    this.toolCalls += 1;
    const handle = this.handles.get(tool);
    const parsed = handle ? handle.schema.safeParse(rawArgs) : null;
    const invalidArgs = parsed !== null && !parsed.success;
    const args = parsed?.success ? parsed.data : rawArgs;
    const base = { ...this.ids, toolCallId: callId };
    this.queue.push(wrapEvent("agent.tool.input_start", { ...base, tool }));
    this.queue.push(
      wrapEvent("agent.tool.start", {
        ...base,
        tool,
        args: invalidArgs ? {} : args,
        argsSummary: invalidArgs ? "invalid arguments" : summarizeToolArgs(handle, args),
      }),
    );

    const start = Date.now();
    let result: ToolResult;
    if (this.toolCalls > this.opts.maxToolIterations) {
      result = {
        kind: "error",
        code: "tool_iteration_cap",
        message: `model exceeded ${this.opts.maxToolIterations} tool calls`,
      };
    } else if (!handle) {
      result = { kind: "error", code: "unknown_tool", message: `no tool named ${tool}` };
    } else if (invalidArgs) {
      result = {
        kind: "error",
        code: "tool_invalid_args",
        message: formatZodIssues(parsed.error.issues),
      };
    } else {
      const timeout = AbortSignal.timeout(this.opts.toolTimeoutMs);
      // A tool may legitimately run longer than the CLI stays quiet (a
      // sub-agent), so the idle watchdog only counts time outside tools.
      this.toolsInFlight += 1;
      clearTimeout(this.idleTimer);
      try {
        result = await handle.invoke(args, {
          ...this.ids,
          abortSignal: this.opts.signal ? AbortSignal.any([this.opts.signal, timeout]) : timeout,
          timeZone: this.opts.input.timeZone,
          caller: this.opts.input.caller,
          ...childEventHooks(base, (event) => this.queue.push(event)),
        });
      } catch (err) {
        result = {
          kind: "error",
          code: "tool_threw",
          message: err instanceof Error ? err.message : "tool threw",
        };
      } finally {
        this.toolsInFlight -= 1;
        this.armIdleTimer();
      }
    }
    this.queue.push(
      wrapEvent("agent.tool.result", { ...base, result, durationMs: Date.now() - start }),
    );
    return mcpToolResult(result, this.opts.input.timeZone);
  }

  onExit(code: number | null, sig: NodeJS.Signals | null): void {
    if (this.completed) return;
    if (this.canceled) {
      this.complete("canceled");
      return;
    }
    this.fail(
      "claude_code_process_exited",
      `Claude Code exited before the turn completed (${sig ?? code ?? "unknown"}).`,
    );
  }

  cancel(): void {
    if (this.completed || this.canceled) return;
    this.canceled = true;
    this.session?.interrupt();
  }

  fail(code: string, message: string): void {
    if (this.completed) return;
    this.queue.push(wrapEvent("agent.error", { ...this.ids, code, message }));
    this.complete("error", { code, message });
    // Nothing more from this process may reach the conversation.
    void this.session?.dispose();
  }

  /** A breach of the locked-down session: stop the CLI at once, without a grace period. */
  violation(message: string): void {
    if (this.completed) return;
    this.session?.kill();
    this.fail("claude_code_native_tool_unavailable", message);
  }

  private armIdleTimer(): void {
    clearTimeout(this.idleTimer);
    if (this.completed || this.toolsInFlight > 0) return;
    this.idleTimer = setTimeout(() => {
      this.session?.kill();
      this.fail(
        "claude_code_stalled",
        `Claude Code produced no output for ${Math.round(this.opts.idleTimeoutMs / 1000)}s.`,
      );
    }, this.opts.idleTimeoutMs);
  }

  private complete(
    stopReason: "end_turn" | "canceled" | "error",
    failure?: { code: string; message: string },
  ): void {
    if (this.completed) return;
    this.completed = true;
    clearTimeout(this.startupTimer);
    clearTimeout(this.idleTimer);
    this.queue.push(
      wrapEvent("agent.message.end", {
        ...this.ids,
        stopReason,
        usage: Object.keys(this.usage).length > 0 ? this.usage : undefined,
        context: this.context(),
        ...(failure
          ? {
              failure: {
                ...failure,
                retryable: isRetryableFailure(failure.code),
                backend: "claude-code",
                model: this.opts.model,
              },
            }
          : {}),
      }),
    );
    this.queue.close();
  }
}

function* failedTurn(input: TurnInput, model: string, err: unknown): Iterable<AgentEvent> {
  const code = claudeCodeErrorCode(conciseError(err));
  const message = friendlyClaudeCodeError(err, code);
  const ids = { sessionId: input.sessionId, messageId: input.messageId };
  yield wrapEvent("agent.error", { ...ids, code, message });
  yield wrapEvent("agent.message.end", {
    ...ids,
    stopReason: "error",
    context: unknownContext(),
    failure: { code, message, retryable: isRetryableFailure(code), backend: "claude-code", model },
  });
}

// ─── The CLI process and its control channel ───────────────────────────────

interface ClaudeCodeProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  log: Logger;
  onMessage(message: Record<string, unknown>): void;
  /** Answer one MCP JSON-RPC message for the in-process tool server. */
  onMcpMessage(message: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  /** A control request Omnesis never registered for: a hook, an elicitation, a permission prompt. */
  onUnexpectedRequest?(subtype: string): void;
  onExit?(code: number | null, sig: NodeJS.Signals | null): void;
}

/** One `claude -p` process: newline-delimited JSON both ways, with request/response control frames. */
class ClaudeCodeProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<
    string,
    { resolve(value: unknown): void; reject(err: Error): void }
  >();
  private disposed = false;
  private exited: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ClaudeCodeProcessOptions) {}

  start(): void {
    if (this.proc) return;
    const proc = spawn(this.opts.command, [...this.opts.args], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;
    this.exited = new Promise((resolve) => proc.once("exit", () => resolve()));
    createInterface({ input: proc.stdout }).on("line", (line) => this.handleLine(line));
    createInterface({ input: proc.stderr }).on("line", (line) => {
      // The CLI's stderr can quote prompt or corpus text; log its size only.
      const trimmed = line.trim();
      if (trimmed) this.opts.log.debug(`Claude Code wrote stderr (${trimmed.length} chars)`);
    });
    proc.stdin.on("error", () => {
      /* the exit handler reports a dead process */
    });
    proc.once("error", (err) => {
      this.rejectAll(new Error(`Claude Code failed to start: ${err.message}`));
      if (!this.disposed) this.opts.onExit?.(null, null);
    });
    proc.once("exit", (code, sig) => {
      this.rejectAll(new Error(`Claude Code exited (${sig ?? code ?? "unknown"})`));
      if (!this.disposed) this.opts.onExit?.(code, sig);
    });
  }

  send(message: unknown): void {
    const stdin = this.proc?.stdin;
    if (!stdin || !stdin.writable) throw new Error("Claude Code stdin is not writable");
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(request: Record<string, unknown>): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.send({ type: "control_request", request_id: requestId, request });
      } catch (err) {
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Stop the CLI immediately. */
  kill(): void {
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  }

  /** Ask the CLI to stop the running turn; it then reports a result and exits. */
  interrupt(): void {
    void this.request({ subtype: "interrupt" }).catch(() => {});
    const proc = this.proc;
    setTimeout(() => {
      if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
    }, 5_000).unref();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return this.exited;
    this.disposed = true;
    const proc = this.proc;
    this.rejectAll(new Error("Claude Code session closed"));
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return this.exited;
    proc.stdin.end();
    const killTimer = setTimeout(() => proc.kill("SIGTERM"), 2_000);
    const hardKill = setTimeout(() => proc.kill("SIGKILL"), 5_000);
    try {
      await this.exited;
    } finally {
      clearTimeout(killTimer);
      clearTimeout(hardKill);
    }
  }

  private handleLine(line: string): void {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = asRecord(JSON.parse(line));
    } catch {
      this.opts.log.warn(`Claude Code emitted non-JSON stdout (${line.length} chars)`);
      return;
    }
    if (!parsed) return;
    if (parsed.type === "control_response") {
      const response = asRecord(parsed.response);
      const requestId = stringField(response, "request_id");
      const pending = requestId ? this.pending.get(requestId) : undefined;
      if (!requestId || !pending) return;
      this.pending.delete(requestId);
      if (response?.subtype === "success") pending.resolve(response.response ?? {});
      else
        pending.reject(new Error(stringField(response, "error") ?? "Claude Code request failed"));
      return;
    }
    if (parsed.type === "control_request") {
      void this.answerControlRequest(parsed);
      return;
    }
    if (parsed.type === "control_cancel_request") return;
    this.opts.onMessage(parsed);
  }

  private async answerControlRequest(frame: Record<string, unknown>): Promise<void> {
    const requestId = stringField(frame, "request_id");
    const request = asRecord(frame.request);
    if (!requestId || !request) return;
    const respond = (response: Record<string, unknown>) => {
      try {
        if (!this.disposed) this.send({ type: "control_response", response });
      } catch (err) {
        this.opts.log.warn(`failed to answer Claude Code control request: ${conciseError(err)}`);
      }
    };
    try {
      switch (request.subtype) {
        case "mcp_message": {
          const message = asRecord(request.message);
          if (stringField(request, "server_name") !== CLAUDE_CODE_TOOL_SERVER || !message) {
            throw new Error("unknown MCP server");
          }
          const reply = await this.opts.onMcpMessage(message);
          respond({
            subtype: "success",
            request_id: requestId,
            response: reply ? { mcp_response: reply } : {},
          });
          return;
        }
        case "can_use_tool":
          // Omnesis tools are pre-approved; anything that reaches a prompt is not one.
          respond({
            subtype: "success",
            request_id: requestId,
            response: { behavior: "deny", message: "Only Omnesis tools are available." },
          });
          this.opts.onUnexpectedRequest?.("can_use_tool");
          return;
        default:
          this.opts.onUnexpectedRequest?.(String(request.subtype));
          throw new Error(`unsupported control request ${String(request.subtype)}`);
      }
    } catch (err) {
      respond({ subtype: "error", request_id: requestId, error: conciseError(err) });
    }
  }

  private rejectAll(err: Error): void {
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}

// ─── Wire helpers ──────────────────────────────────────────────────────────

/**
 * Arguments for a locked-down print-mode session: no built-in tools, no
 * settings, CLAUDE.md, hooks, skills or slash commands, only the MCP server
 * Omnesis serves in process, permission prompts denied, nothing persisted.
 */
export function claudeCodeSessionArgs(opts: {
  hasTools: boolean;
  model?: string;
  effort?: string;
}): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(opts.model ? ["--model", opts.model] : []),
    ...(opts.effort ? ["--effort", opts.effort] : []),
    "--tools",
    "",
    "--strict-mcp-config",
    ...(opts.hasTools
      ? [
          "--mcp-config",
          JSON.stringify({
            mcpServers: {
              [CLAUDE_CODE_TOOL_SERVER]: { type: "sdk", name: CLAUDE_CODE_TOOL_SERVER },
            },
          }),
          "--allowedTools",
          `${TOOL_PREFIX}*`,
        ]
      : []),
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify(CLAUDE_CODE_SETTINGS),
    "--disable-slash-commands",
    // Belt and braces: refuses bypassPermissions and drops code-running tools
    // even if `--tools ""` ever stopped covering one.
    "--restricted",
    "--no-session-persistence",
  ];
}

export function buildClaudeCodeEnv(
  env: NodeJS.ProcessEnv,
  passPrefixes: readonly string[] = [],
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (
      SAFE_CLAUDE_CODE_ENV_KEYS.has(key) ||
      passPrefixes.some((prefix) => key.startsWith(prefix))
    ) {
      childEnv[key] = value;
    }
  }
  return { ...childEnv, ...ISOLATION_ENV };
}

export async function resolveClaudeCodeCommand(opts: {
  commandOverride?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const override = opts.commandOverride?.trim();
  if (override) return override;
  const env = opts.env ?? process.env;
  const fromPath = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, process.platform === "win32" ? "claude.exe" : "claude"));
  for (const candidate of [...fromPath, ...wellKnownClaudeCodePaths(env.HOME)]) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  throw new Error(
    "Claude Code was not found. Install it (https://claude.com/claude-code) and sign in with `claude auth login`.",
  );
}

export function parseClaudeCodeVersion(output: string): string | null {
  return output.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

export function isSupportedClaudeCodeVersion(version: string): boolean {
  const have = version.split(".").map(Number);
  const need = CLAUDE_CODE_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < need.length; i += 1) {
    if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) > need[i];
  }
  return true;
}

export function parseClaudeCodeAuthStatus(stdout: string): ClaudeCodeAuthStatus {
  const record = asRecord(JSON.parse(stdout));
  const authMethod = stringField(record, "authMethod") ?? undefined;
  const subscriptionType = stringField(record, "subscriptionType") ?? undefined;
  return {
    loggedIn: record?.loggedIn === true,
    ...(authMethod && authMethod !== "none" ? { authMethod } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
  };
}

/** The selectable catalog: aliases and ids the CLI accepts for `--model`. */
export function parseClaudeCodeModels(value: unknown): ClaudeCodeModelInfo[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = stringField(record, "value")?.trim();
    // `default` names whatever the CLI would pick; an assignment names a model.
    if (!id || id === "default" || seen.has(id)) return [];
    seen.add(id);
    const efforts = Array.isArray(record?.supportedEffortLevels)
      ? record.supportedEffortLevels.filter(isString)
      : undefined;
    const resolvedModel = stringField(record, "resolvedModel") ?? undefined;
    const displayName = stringField(record, "displayName") ?? undefined;
    const description = stringField(record, "description") ?? undefined;
    return [
      {
        value: id,
        ...(resolvedModel ? { resolvedModel } : {}),
        ...(displayName ? { displayName } : {}),
        ...(description ? { description } : {}),
        ...(efforts && efforts.length > 0 ? { supportedEffortLevels: efforts } : {}),
      },
    ];
  });
}

/**
 * A result's usage in the agent convention: fresh input and cache reads as
 * disjoint counts. Cache writes are fresh input the provider also stored.
 */
export function parseClaudeCodeUsage(value: unknown): Usage {
  const usage = asRecord(value);
  if (!usage) return {};
  const input = numberField(usage, "input_tokens");
  const cacheWrite = numberField(usage, "cache_creation_input_tokens");
  const cacheRead = numberField(usage, "cache_read_input_tokens");
  const output = numberField(usage, "output_tokens");
  return {
    ...(input !== undefined || cacheWrite !== undefined
      ? { inputTokens: (input ?? 0) + (cacheWrite ?? 0) }
      : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
  };
}

export function convertToolsToMcp(
  tools: ReadonlyArray<ToolHandle>,
): Array<Record<string, unknown>> {
  return tools.map((h) => ({
    name: h.name,
    description: h.description,
    inputSchema: toolInputJsonSchema(h.schema),
  }));
}

/** The turn's user message: the replayed transcript, plus inline images. */
export function claudeCodeUserContent(input: TurnInput): Array<Record<string, unknown>> {
  return [
    {
      type: "text",
      text: renderTranscriptUserInput(input.history, input.userMessage, {
        timeZone: input.timeZone,
      }),
    },
    ...(input.images ?? []).flatMap(({ url }): Array<Record<string, unknown>> => {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
      if (match) {
        return [
          { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } },
        ];
      }
      return /^https?:\/\//.test(url) ? [{ type: "image", source: { type: "url", url } }] : [];
    }),
  ];
}

function mcpToolResult(result: ToolResult, timeZone?: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: serializeToolResultForModel(result, { timeZone }) }],
    isError: toolResultHasErrors(result),
  };
}

/** Failure codes for the `error` the CLI attaches to an assistant message. */
function claudeCodeApiErrorCode(error: string): string {
  switch (error) {
    case "authentication_failed":
      return "claude_code_not_authenticated";
    case "rate_limit":
      return "claude_code_usage_limited";
    case "model_not_found":
      return "claude_code_invalid_model";
    case "max_output_tokens":
      return "output_truncated";
    case "overloaded":
      return "claude_code_overloaded";
    default:
      return "claude_code_runtime_error";
  }
}

function claudeCodeErrorCode(message: string): string {
  if (isContextWindowError(message)) return "context_window_exceeded";
  if (/managed policy/i.test(message)) return "claude_code_managed_policy";
  if (/not found|ENOENT/i.test(message)) return "claude_code_binary_missing";
  if (/too old|claude update/i.test(message)) return "claude_code_unsupported_version";
  if (/not logged in|login|unauthori[sz]ed|401|authentication/i.test(message)) {
    return "claude_code_not_authenticated";
  }
  if (/rate limit|usage limit|429|quota/i.test(message)) return "claude_code_usage_limited";
  return "claude_code_runtime_error";
}

function friendlyClaudeCodeError(
  err: unknown,
  code = claudeCodeErrorCode(conciseError(err)),
): string {
  switch (code) {
    case "context_window_exceeded":
      return CONTEXT_WINDOW_EXCEEDED_MESSAGE;
    case "claude_code_binary_missing":
      return "Claude Code was not found on the gateway host. Install it and sign in with `claude auth login`.";
    case "claude_code_unsupported_version":
    case "claude_code_managed_policy":
      return conciseError(err);
    case "claude_code_not_authenticated":
      return "Claude Code is not signed in on the gateway host. Run `claude auth login` there, then refresh Models > Backends > Claude Code.";
    case "claude_code_usage_limited":
      return "Claude Code reported a usage or rate limit on this Claude plan.";
    case "claude_code_invalid_model":
      return "Claude Code rejected the configured model. Assign a model listed under Models > Backends > Claude Code.";
    case "claude_code_overloaded":
      return "Claude is temporarily overloaded. Try again shortly.";
    case "output_truncated":
      return "The model reached its output limit before completing this response.";
    default:
      return "Claude Code failed to complete the turn.";
  }
}

/** Failures that retrying the same turn cannot fix without the operator acting first. */
const PERMANENT_FAILURES = new Set([
  "context_window_exceeded",
  "claude_code_native_tool_unavailable",
  "claude_code_not_authenticated",
  "claude_code_binary_missing",
  "claude_code_unsupported_version",
  "claude_code_invalid_model",
  "claude_code_managed_policy",
]);

function isRetryableFailure(code: string): boolean {
  return !PERMANENT_FAILURES.has(code);
}

function isContextWindowError(message: string): boolean {
  return (
    /\bprompt is too long\b/i.test(message) ||
    /\bcontext (?:window|length)\b.{0,40}\bexceed/i.test(message)
  );
}

function unknownContext() {
  return { measurement: "unknown" as const, limitSource: "unknown" as const, requestIteration: 1 };
}

function formatZodIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
  const parts = issues.slice(0, 3).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "arguments";
    return `${path}: ${issue.message}`;
  });
  return `tool arguments did not match the Omnesis schema${parts.length > 0 ? ` (${parts.join("; ")})` : ""}`;
}

async function ensureWorkspace(path: string): Promise<void> {
  try {
    const st = await lstat(path);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`Claude Code workspace is not a plain directory: ${path}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Claude Code ${label} timed out`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Push/close queue consumed with `for await`; queued values drain before the end. */
class EventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
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
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0)
          return Promise.resolve({ done: false, value: this.values.shift()! });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function conciseError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/\s+/g, " ").trim() || "unknown error";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * What a session's `initialize` answer says it loaded beyond what Omnesis
 * asked for — `agents` or `commands` — or null. A missing or malformed list
 * counts as loaded.
 */
function sessionLoadedItsOwn(response: Record<string, unknown> | null): string | null {
  for (const key of ["agents", "commands"] as const) {
    const value = response?.[key];
    if (!Array.isArray(value) || value.length > 0) return key;
  }
  return null;
}

/**
 * The tool call a `tool_progress` message reports on. The CLI's heartbeat for
 * a call running past 30 seconds carries the call's id suffixed
 * `-heartbeat-<n>`, so it is read back to the call it belongs to.
 */
function progressCallId(message: Record<string, unknown>): string {
  const id = stringField(message, "tool_use_id") ?? "";
  return message.heartbeat === true ? id.replace(/-heartbeat-\d+$/, "") : id;
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

function isString(value: unknown): value is string {
  return typeof value === "string";
}
