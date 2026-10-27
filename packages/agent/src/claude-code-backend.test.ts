// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ClaudeCodeBackend,
  ClaudeCodeRuntime,
  buildClaudeCodeEnv,
  claudeCodeSessionArgs,
  claudeCodeUserContent,
  convertToolsToMcp,
  findManagedPolicyConflict,
  isSupportedClaudeCodeVersion,
  parseClaudeCodeAuthStatus,
  parseClaudeCodeModels,
  parseClaudeCodeUsage,
  parseClaudeCodeVersion,
  resolveClaudeCodeCommand,
} from "./claude-code-backend.js";
import { agentFailureScope } from "./http-error.js";
import type { ToolHandle, TurnInput } from "./backend.js";
import type { AgentEvent, ToolResult } from "@omnesis/core";

const fakeClaude = fileURLToPath(new URL("./test-fixtures/fake-claude-code.mjs", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-claude-code-"));
  dirs.push(dir);
  return dir;
}

function tool(name: string, fn: (args: unknown) => ToolResult): ToolHandle {
  return {
    name,
    description: `synthetic ${name}`,
    schema: z.object({ query: z.string() }),
    invoke: (args) => Promise.resolve(fn(args)),
  };
}

const input = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  sessionId: "session_synthetic",
  messageId: "message_synthetic",
  history: [],
  userMessage: "Find the synthetic budget review.",
  tools: [],
  systemPrompt: "You are the Omnesis agent.",
  ...overrides,
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function setup(
  env: Record<string, string> = {},
  idleTimeoutMs?: number,
  managedSettingsDirs: string[] = [],
) {
  const dir = scratch();
  const recordPath = join(dir, "record.jsonl");
  const runtime = new ClaudeCodeRuntime({
    workspaceDir: join(dir, "workspace"),
    command: fakeClaude,
    startupTimeoutMs: 5_000,
    managedSettingsDirs,
    passEnvPrefixes: ["OMNESIS_FAKE_CLAUDE_"],
    ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      OMNESIS_FAKE_CLAUDE_RECORD: recordPath,
      ANTHROPIC_API_KEY: "must-not-leak",
      ANTHROPIC_AUTH_TOKEN: "must-not-leak",
      OMNESIS_PRIVATE_TOKEN: "must-not-leak",
      CLAUDE_CONFIG_DIR: join(dir, "claude-config"),
      ...env,
    },
  });
  const records = () =>
    readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            envKeys: string[];
            env: Record<string, string>;
            received: Array<Record<string, unknown>>;
          },
      );
  return { dir, runtime, records };
}

const types = (events: AgentEvent[]) => events.map((event) => event.type);
const text = (events: AgentEvent[]) =>
  events
    .filter((e) => e.type === "agent.text.delta")
    .map((e) => (e.payload as { delta: string }).delta)
    .join("");
const end = (events: AgentEvent[]) =>
  events.find((e) => e.type === "agent.message.end")?.payload as {
    stopReason: string;
    usage?: Record<string, number>;
    context: Record<string, unknown>;
    failure?: { code: string; message: string; backend: string; model: string; retryable: boolean };
  };

describe("Claude Code session lockdown", () => {
  it("removes every built-in tool and loads none of the operator's customizations", () => {
    const args = claudeCodeSessionArgs({ hasTools: true, model: "sonnet", effort: "low" });
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    expect(value("--tools")).toBe("");
    expect(value("--setting-sources")).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-session-persistence");
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(value("--permission-prompts")).toBe("none");
    expect(value("--allowedTools")).toBe("mcp__omnesis__*");
    expect(JSON.parse(value("--settings"))).toEqual({
      disableAllHooks: true,
      enabledPlugins: {
        "cc-plugin-agents-md@builtin": false,
        "cc-plugin-plugin-authoring@builtin": false,
      },
    });
    expect(JSON.parse(value("--mcp-config"))).toEqual({
      mcpServers: { omnesis: { type: "sdk", name: "omnesis" } },
    });
    expect(value("--model")).toBe("sonnet");
    expect(value("--effort")).toBe("low");
    expect(args).toContain("--restricted");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("configures no MCP server when the turn has no tools", () => {
    const args = claudeCodeSessionArgs({ hasTools: false });
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--allowedTools");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });

  it("forwards no API key and pins the isolation settings", () => {
    const env = buildClaudeCodeEnv({
      PATH: "/bin",
      HOME: "/home/synthetic",
      CLAUDE_CONFIG_DIR: "/home/synthetic/.claude-alt",
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_AUTH_TOKEN: "secret",
      OMNESIS_TOKEN: "secret",
      OMNESIS_FAKE_CLAUDE_SCENARIO: "text",
      NODE_OPTIONS: "--require /tmp/x.js",
      ANTHROPIC_BASE_URL: "https://proxy.example.com",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
      MCP_TIMEOUT: "1",
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "0",
    });
    for (const key of [
      "OMNESIS_FAKE_CLAUDE_SCENARIO",
      "NODE_OPTIONS",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "MCP_TIMEOUT",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(env.ENABLE_TOOL_SEARCH).toBe("false");
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe("1");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.OMNESIS_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/synthetic/.claude-alt");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("subscription-token");
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });
});

describe("Claude Code wire parsing", () => {
  it("reads versions and enforces the minimum", () => {
    expect(parseClaudeCodeVersion("2.1.296 (Claude Code)\n")).toBe("2.1.296");
    expect(parseClaudeCodeVersion("garbage")).toBeNull();
    expect(isSupportedClaudeCodeVersion("2.1.259")).toBe(true);
    expect(isSupportedClaudeCodeVersion("2.1.300")).toBe(true);
    expect(isSupportedClaudeCodeVersion("2.2.0")).toBe(true);
    expect(isSupportedClaudeCodeVersion("3.0.0")).toBe(true);
    expect(isSupportedClaudeCodeVersion("2.1.258")).toBe(false);
    expect(isSupportedClaudeCodeVersion("1.9.999")).toBe(false);
  });

  it("reads auth status without the account's identity", () => {
    expect(
      parseClaudeCodeAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          subscriptionType: "max",
          email: "maya@example.com",
        }),
      ),
    ).toEqual({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
    expect(parseClaudeCodeAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toEqual({
      loggedIn: false,
    });
  });

  it("drops the `default` pseudo-model and duplicates from the catalog", () => {
    expect(
      parseClaudeCodeModels([
        { value: "default", displayName: "Default" },
        { value: "opus", resolvedModel: "claude-opus-fake", supportedEffortLevels: ["low"] },
        { value: "opus" },
        { displayName: "no value" },
      ]),
    ).toEqual([
      { value: "opus", resolvedModel: "claude-opus-fake", supportedEffortLevels: ["low"] },
    ]);
  });

  it("reports cache writes as fresh input and cache reads apart", () => {
    expect(
      parseClaudeCodeUsage({
        input_tokens: 4,
        cache_creation_input_tokens: 96,
        cache_read_input_tokens: 1000,
        output_tokens: 20,
      }),
    ).toEqual({ inputTokens: 100, cacheReadTokens: 1000, outputTokens: 20 });
  });

  it("advertises a tool whose arguments take one of several shapes as one object", () => {
    const schema = z.union([
      z.object({ id: z.string(), ref: z.string() }).strict(),
      z.object({ id: z.string(), refs: z.array(z.string()) }).strict(),
    ]);
    const [tool] = convertToolsToMcp([
      { name: "pick", description: "Pick one", schema, execute: async () => ({ content: "" }) },
    ] as unknown as ToolHandle[]);
    expect(tool.inputSchema).toMatchObject({ type: "object", required: ["id"] });
    expect(tool.inputSchema).not.toHaveProperty("anyOf");
  });

  it("inlines data-URL images as base64 blocks after the transcript", () => {
    const content = claudeCodeUserContent(
      input({
        history: [{ role: "user", parts: [{ kind: "text", text: "Earlier question" }] }],
        userMessage: "Read this",
        images: [{ url: "data:image/png;base64,AAAA" }, { url: "file:///etc/passwd" }],
      }),
    );
    expect(content).toHaveLength(2);
    expect(String(content[0].text)).toContain("User: Earlier question");
    expect(content[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  it("finds claude on PATH and fails clearly when it is absent", async () => {
    const dir = scratch();
    await expect(resolveClaudeCodeCommand({ env: { PATH: dir, HOME: dir } })).rejects.toThrow(
      /Claude Code was not found/,
    );
    expect(await resolveClaudeCodeCommand({ commandOverride: " /opt/claude ", env: {} })).toBe(
      "/opt/claude",
    );
  });
});

describe("Claude Code runtime against a scripted CLI", () => {
  it("probes the version, the login and the model catalog", async () => {
    const { runtime } = setup();
    expect(await runtime.probeVersion()).toMatchObject({ version: "2.1.296", supported: true });
    expect(await runtime.authStatus()).toEqual({
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "max",
    });
    expect((await runtime.listModels()).map((model) => model.value)).toEqual(["sonnet", "haiku"]);
  });

  it("reports a signed-out CLI and refuses one that is too old", async () => {
    expect(
      (await setup({ OMNESIS_FAKE_CLAUDE_LOGGED_IN: "0" }).runtime.authStatus()).loggedIn,
    ).toBe(false);
    expect(
      await setup({ OMNESIS_FAKE_CLAUDE_VERSION: "2.0.1" }).runtime.probeVersion(),
    ).toMatchObject({
      version: "2.0.1",
      supported: false,
      reason: expect.stringMatching(/too old/),
    });
  });

  it("streams a text turn, sends the system prompt through initialize, and scrubs the env", async () => {
    const { runtime, records } = setup();
    const backend = new ClaudeCodeBackend({ model: "sonnet", runtime });
    const events = await collect(backend.runTurn(input()));
    expect(types(events)[0]).toBe("agent.message.start");
    expect(text(events)).toBe("Working… Echo: Find the synthetic budget review.");
    const terminal = end(events);
    expect(terminal.stopReason).toBe("end_turn");
    expect(terminal.usage).toEqual({ inputTokens: 20, outputTokens: 30, cacheReadTokens: 200 });
    expect(terminal.context).toMatchObject({ inputTokens: 115, measurement: "provider_reported" });
    // Each request's input size is reported live, before the turn's result.
    const live = events.filter((event) => event.type === "agent.usage.update");
    expect(live[0]?.payload).toMatchObject({
      usage: { inputTokens: 15, cacheReadTokens: 100 },
      context: { inputTokens: 115, peakInputTokens: 115, measurement: "provider_reported" },
    });

    const [run] = records();
    const init = run.received.find((frame) => frame.type === "control_request") as {
      request: { subtype: string; systemPrompt: string[]; sdkMcpServers?: string[] };
    };
    expect(init.request).toMatchObject({
      subtype: "initialize",
      systemPrompt: ["You are the Omnesis agent."],
    });
    expect(init.request.sdkMcpServers).toBeUndefined();
    expect(run.envKeys).not.toContain("ANTHROPIC_API_KEY");
    expect(run.envKeys).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(run.envKeys).not.toContain("OMNESIS_PRIVATE_TOKEN");
    expect(run.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    expect(run.args).toContain("--model");
  });

  it("serves Omnesis tools in process and reports them as tool events", async () => {
    const { runtime, records } = setup({
      OMNESIS_FAKE_CLAUDE_SCENARIO: "tool",
      OMNESIS_FAKE_CLAUDE_TOOL_ARGS: JSON.stringify({ query: "budget" }),
    });
    const calls: unknown[] = [];
    const search = tool("search", (args) => {
      calls.push(args);
      return { kind: "error", code: "synthetic", message: "three synthetic hits" };
    });
    const backend = new ClaudeCodeBackend({ model: "sonnet", runtime });
    const events = await collect(backend.runTurn(input({ tools: [search] })));

    expect(calls).toEqual([{ query: "budget" }]);
    expect(types(events)).toEqual(
      expect.arrayContaining(["agent.tool.input_start", "agent.tool.start", "agent.tool.result"]),
    );
    const start = events.find((e) => e.type === "agent.tool.start")?.payload as {
      toolCallId: string;
      tool: string;
    };
    expect(start).toMatchObject({ toolCallId: "toolu_fake_1", tool: "search" });
    expect(text(events)).toContain("three synthetic hits");
    expect(text(events)).toContain("(error)");
    expect(end(events).stopReason).toBe("end_turn");

    const [run] = records();
    const init = run.received.find((frame) => frame.type === "control_request") as {
      request: { sdkMcpServers?: string[] };
    };
    expect(init.request.sdkMcpServers).toEqual(["omnesis"]);
    const listed = run.received.find(
      (frame) =>
        frame.type === "control_response" &&
        JSON.stringify(frame).includes('"tools":[{"name":"search"'),
    );
    expect(listed).toBeDefined();
  });

  it("counts one request once in live usage however many messages carry it", async () => {
    const shared = async (env: Record<string, string>) => {
      const { runtime } = setup({
        OMNESIS_FAKE_CLAUDE_SCENARIO: "tool",
        OMNESIS_FAKE_CLAUDE_TOOL_ARGS: JSON.stringify({ query: "budget" }),
        ...env,
      });
      const search = tool("search", () => ({ kind: "error", code: "x", message: "none" }));
      const events = await collect(
        new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input({ tools: [search] })),
      );
      return events.filter((e) => e.type === "agent.usage.update").map((e) => e.payload);
    };
    // Two requests: the live total is their sum.
    const distinct = await shared({});
    expect(distinct[1]).toMatchObject({ usage: { inputTokens: 30, cacheReadTokens: 200 } });
    // One request reported on two messages: counted once.
    const repeated = await shared({ OMNESIS_FAKE_CLAUDE_MESSAGE_ID: "msg_fake_shared" });
    expect(repeated[1]).toMatchObject({
      usage: { inputTokens: 15, cacheReadTokens: 100 },
      context: { inputTokens: 115, requestIteration: 1 },
    });
  });

  it("returns a schema error to the model instead of invoking the tool", async () => {
    const { runtime } = setup({
      OMNESIS_FAKE_CLAUDE_SCENARIO: "tool",
      OMNESIS_FAKE_CLAUDE_TOOL_ARGS: JSON.stringify({ query: 42 }),
    });
    let invoked = false;
    const search = tool("search", () => {
      invoked = true;
      return { kind: "error", code: "x", message: "unreachable" };
    });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input({ tools: [search] })),
    );
    expect(invoked).toBe(false);
    const result = events.find((e) => e.type === "agent.tool.result")?.payload as {
      result: ToolResult;
    };
    expect(result.result).toMatchObject({ kind: "error", code: "tool_invalid_args" });
  });

  it("fails closed when the CLI offers a tool outside Omnesis", async () => {
    const { runtime } = setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: "foreign-tools" });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(
        input({ tools: [tool("search", () => ({ kind: "error", code: "x", message: "x" }))] }),
      ),
    );
    expect(end(events)).toMatchObject({
      stopReason: "error",
      failure: { code: "claude_code_native_tool_unavailable", backend: "claude-code" },
    });
    expect(text(events)).toBe("");
  });

  it("fails closed when the model reaches for a built-in tool", async () => {
    const { runtime } = setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: "native-tool" });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input()),
    );
    expect(end(events).failure?.code).toBe("claude_code_native_tool_unavailable");
  });

  const searchTool = () => tool("search", () => ({ kind: "error", code: "x", message: "x" }));

  it.each([
    ["no-init", "finishes without reporting its session"],
    ["untyped-init", "reports a session without a tool list"],
    ["foreign-server", "connects an MCP server Omnesis did not configure"],
    ["server-tool", "starts a server-side tool such as web search"],
    ["own-agents", "loads agents of its own"],
    ["loaded-skills", "loads skills"],
    ["user-plugin", "loads a plugin that is not built into it"],
    ["own-commands", "loads slash commands of its own"],
    ["no-init-lists", "answers initialize without its agent and command lists"],
    ["bypass-mode", "starts outside dontAsk permission mode"],
    ["api-key-helper", "takes credentials from an apiKeyHelper command"],
    ["hook-event", "runs a hook"],
    ["background-task", "starts a background task"],
    ["hook-request", "asks Omnesis to run a hook callback"],
    ["permission-request", "asks Omnesis for a tool permission"],
    ["foreign-result", "reports a tool result Omnesis did not produce"],
    ["unknown-block", "produces a block type Omnesis does not accept"],
    ["stream-native-tool", "streams the start of a built-in tool call"],
    ["unknown-omnesis-tool", "calls an mcp__omnesis__ tool Omnesis did not provide"],
  ])("fails closed when the CLI %s (%s)", async (scenario) => {
    const { runtime, dir } = setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: scenario });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input({ tools: [searchTool()] })),
    );
    expect(end(events)).toMatchObject({
      stopReason: "error",
      failure: { code: "claude_code_native_tool_unavailable" },
    });
    if (scenario === "own-agents") {
      // The conversation never left Omnesis.
      const frames = readFileSync(join(dir, "record.jsonl.frames"), "utf8");
      expect(frames).toContain('"subtype":"initialize"');
      expect(frames).not.toContain('"type":"user"');
    }
  });

  it.each(["own", "heartbeat"])(
    "accepts %s progress the CLI reports on a long-running Omnesis tool call",
    async (mode) => {
      const { runtime } = setup({
        OMNESIS_FAKE_CLAUDE_SCENARIO: "tool",
        OMNESIS_FAKE_CLAUDE_TOOL_PROGRESS: mode,
      });
      const events = await collect(
        new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(
          input({ tools: [searchTool()] }),
        ),
      );
      expect(end(events).stopReason).toBe("end_turn");
    },
  );

  it.each(["foreign", "foreign-heartbeat"])(
    "fails closed when the CLI reports %s progress on a call Omnesis did not make",
    async (mode) => {
      const { runtime } = setup({
        OMNESIS_FAKE_CLAUDE_SCENARIO: "tool",
        OMNESIS_FAKE_CLAUDE_TOOL_PROGRESS: mode,
      });
      const events = await collect(
        new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(
          input({ tools: [searchTool()] }),
        ),
      );
      expect(end(events).failure?.code).toBe("claude_code_native_tool_unavailable");
    },
  );

  it("passes over the frames a newer CLI adds around a text turn", async () => {
    const { runtime } = setup({ OMNESIS_FAKE_CLAUDE_NEWER_CLI: "1" });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input()),
    );
    expect(end(events).failure?.message).toBeUndefined();
    expect(end(events).stopReason).toBe("end_turn");
    expect(text(events)).toBe("Working… Echo: Find the synthetic budget review.");
  });

  it("passes over the frames a newer CLI adds around an Omnesis tool call", async () => {
    const { runtime } = setup({
      OMNESIS_FAKE_CLAUDE_SCENARIO: "tool",
      OMNESIS_FAKE_CLAUDE_NEWER_CLI: "1",
      OMNESIS_FAKE_CLAUDE_TOOL_ARGS: JSON.stringify({ query: "budget" }),
    });
    const outcome: ToolResult = {
      kind: "error",
      code: "synthetic",
      message: "three synthetic hits",
    };
    const calls: unknown[] = [];
    const search = tool("search", (args) => {
      calls.push(args);
      return outcome;
    });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input({ tools: [search] })),
    );
    expect(end(events).failure?.message).toBeUndefined();
    expect(end(events).stopReason).toBe("end_turn");
    expect(calls).toEqual([{ query: "budget" }]);
    expect(events.filter((e) => e.type === "agent.tool.result").map((e) => e.payload)).toEqual([
      expect.objectContaining({ toolCallId: "toolu_fake_1", result: outcome }),
    ]);
    expect(text(events)).toBe(`Tool said: ${JSON.stringify(outcome)} (error)`);
  });

  it("accepts a plugin built into the CLI that adds no tools", async () => {
    const { runtime } = setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: "builtin-plugin" });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input({ tools: [searchTool()] })),
    );
    expect(end(events).stopReason).toBe("end_turn");
  });

  it("refuses to start Claude Code under a managed policy that runs commands", async () => {
    const policyDir = scratch();
    writeFileSync(
      join(policyDir, "managed-settings.json"),
      JSON.stringify({ hooks: { SessionStart: [] } }),
    );
    const { runtime, dir } = setup({}, undefined, [policyDir]);
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input({ tools: [searchTool()] })),
    );
    expect(end(events).failure?.code).toBe("claude_code_managed_policy");
    expect(existsSync(join(dir, "record.jsonl.frames"))).toBe(false);
    await expect(runtime.listModels()).rejects.toThrow(/managed policy/);
  });

  it("allows a managed policy that only restricts Claude Code", async () => {
    const policyDir = scratch();
    mkdirSync(join(policyDir, "managed-settings.d"));
    writeFileSync(
      join(policyDir, "managed-settings.d", "10-limits.json"),
      JSON.stringify({ permissions: { deny: ["Bash"] } }),
    );
    expect(await findManagedPolicyConflict([policyDir])).toBeNull();
    writeFileSync(join(policyDir, "managed-settings.d", "20-helper.json"), '{"apiKeyHelper":"x"}');
    expect(await findManagedPolicyConflict([policyDir])).toMatch(/apiKeyHelper/);
    writeFileSync(join(policyDir, "managed-settings.json"), "not json");
    expect(await findManagedPolicyConflict([policyDir])).toMatch(/could not be read/);
  });

  it("never runs an Omnesis tool once the CLI has broken its session", async () => {
    let invoked = 0;
    const { runtime } = setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: "native-then-call" });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(
        input({
          tools: [
            tool("search", () => {
              invoked += 1;
              return { kind: "error", code: "x", message: "x" };
            }),
          ],
        }),
      ),
    );
    expect(end(events).failure?.code).toBe("claude_code_native_tool_unavailable");
    expect(invoked).toBe(0);
  });

  it("stops a turn whose CLI goes silent", async () => {
    const { runtime } = setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: "silent" }, 200);
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input()),
    );
    expect(end(events).failure).toMatchObject({ code: "claude_code_stalled", retryable: true });
  });

  it("does not count time spent inside an Omnesis tool as silence", async () => {
    const { runtime } = setup(
      { OMNESIS_FAKE_CLAUDE_SCENARIO: "tool", OMNESIS_FAKE_CLAUDE_TOOL_ARGS: '{"query":"q"}' },
      200,
    );
    const slow = tool("search", () => ({ kind: "error", code: "x", message: "late" }));
    const slowInvoke = slow.invoke;
    slow.invoke = async (args, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return slowInvoke(args, ctx);
    };
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input({ tools: [slow] })),
    );
    expect(end(events).stopReason).toBe("end_turn");
  });

  it("caps tool calls per turn", async () => {
    const { runtime } = setup({
      OMNESIS_FAKE_CLAUDE_SCENARIO: "tool",
      OMNESIS_FAKE_CLAUDE_TOOL_ARGS: '{"query":"q"}',
    });
    let invoked = 0;
    const counted = tool("search", () => {
      invoked += 1;
      return { kind: "error", code: "x", message: "x" };
    });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime, maxToolIterations: 0 }).runTurn(
        input({ tools: [counted] }),
      ),
    );
    expect(invoked).toBe(0);
    const result = events.find((e) => e.type === "agent.tool.result")?.payload as {
      result: ToolResult;
    };
    expect(result.result).toMatchObject({ code: "tool_iteration_cap" });
  });

  it("maps a signed-out CLI to an actionable failure", async () => {
    const { runtime } = setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: "auth-error" });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input()),
    );
    const error = events.find((e) => e.type === "agent.error")?.payload as {
      code: string;
      message: string;
    };
    expect(error.code).toBe("claude_code_not_authenticated");
    expect(error.message).toContain("claude auth login");
    expect(end(events).failure).toMatchObject({ model: "sonnet", backend: "claude-code" });
  });

  /** Run one turn and return its terminal failure. */
  async function failureOf(runtime: ClaudeCodeRuntime, tools: ToolHandle[] = []) {
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input({ tools })),
    );
    return end(events);
  }

  it.each([
    // The environment: an operator repairs it and the same turn then succeeds,
    // so a background queue waits for that instead of retiring the work.
    [
      "a lapsed login",
      () => setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: "auth-error" }).runtime,
      "claude_code_not_authenticated",
      true,
      "provider",
    ],
    [
      "a missing CLI",
      () => {
        const dir = scratch();
        return new ClaudeCodeRuntime({
          workspaceDir: join(dir, "workspace"),
          managedSettingsDirs: [],
          env: { PATH: dir, HOME: dir },
        });
      },
      "claude_code_binary_missing",
      true,
      "provider",
    ],
    [
      "an unknown model",
      () => setup({ OMNESIS_FAKE_CLAUDE_API_ERROR: "model_not_found" }).runtime,
      "claude_code_invalid_model",
      true,
      "provider",
    ],
    [
      "a managed policy that runs commands",
      () => {
        const policyDir = scratch();
        writeFileSync(join(policyDir, "managed-settings.json"), JSON.stringify({ hooks: {} }));
        return setup({}, undefined, [policyDir]).runtime;
      },
      "claude_code_managed_policy",
      true,
      "provider",
    ],
    [
      "a CLI offering tools Omnesis did not configure",
      () => setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: "foreign-tools" }).runtime,
      "claude_code_native_tool_unavailable",
      true,
      "provider",
    ],
    [
      "a usage limit",
      () => setup({ OMNESIS_FAKE_CLAUDE_API_ERROR: "rate_limit" }).runtime,
      "claude_code_usage_limited",
      true,
      "provider",
    ],
    // The payload: the same turn can never get past these.
    [
      "a prompt too long for the model",
      () =>
        setup({
          OMNESIS_FAKE_CLAUDE_API_ERROR: "invalid_request",
          OMNESIS_FAKE_CLAUDE_RESULT_TEXT: "Prompt is too long",
        }).runtime,
      "context_window_exceeded",
      false,
      "request",
    ],
    [
      "an answer past the output limit",
      () => setup({ OMNESIS_FAKE_CLAUDE_API_ERROR: "max_output_tokens" }).runtime,
      "output_truncated",
      false,
      "request",
    ],
  ] as const)("classifies %s", async (_label, runtime, code, retryable, scope) => {
    const { failure } = await failureOf(runtime(), [searchTool()]);
    expect(failure).toMatchObject({ code, retryable });
    expect(agentFailureScope(failure!)).toBe(scope);
  });

  it.each([
    [
      { OMNESIS_FAKE_CLAUDE_API_ERROR: "authentication_failed" },
      "claude_code_not_authenticated",
      true,
      "error",
    ],
    [{ OMNESIS_FAKE_CLAUDE_API_ERROR: "rate_limit" }, "claude_code_usage_limited", true, "error"],
    [{ OMNESIS_FAKE_CLAUDE_API_ERROR: "overloaded" }, "claude_code_overloaded", true, "error"],
    [
      { OMNESIS_FAKE_CLAUDE_API_ERROR: "model_not_found" },
      "claude_code_invalid_model",
      true,
      "error",
    ],
    // As the HTTP and Anthropic backends report the same failure.
    [
      { OMNESIS_FAKE_CLAUDE_API_ERROR: "max_output_tokens" },
      "output_truncated",
      false,
      "max_tokens",
    ],
    [{ OMNESIS_FAKE_CLAUDE_API_ERROR: "server_error" }, "claude_code_runtime_error", true, "error"],
    // The CLI files a prompt the model cannot take under `invalid_request`.
    [
      {
        OMNESIS_FAKE_CLAUDE_API_ERROR: "invalid_request",
        OMNESIS_FAKE_CLAUDE_RESULT_TEXT: "Prompt is too long",
      },
      "context_window_exceeded",
      false,
      "error",
    ],
    [
      { OMNESIS_FAKE_CLAUDE_RESULT_SUBTYPE: "error_max_turns" },
      "claude_code_runtime_error",
      true,
      "error",
    ],
    [
      { OMNESIS_FAKE_CLAUDE_RESULT_SUBTYPE: "error_during_execution" },
      "claude_code_runtime_error",
      true,
      "error",
    ],
    [
      {
        OMNESIS_FAKE_CLAUDE_RESULT_SUBTYPE: "error_during_execution",
        OMNESIS_FAKE_CLAUDE_RESULT_TEXT: "Prompt is too long: 210000 tokens > 200000 maximum",
      },
      "context_window_exceeded",
      false,
      "error",
    ],
    // An error the CLI recovered from does not label a later, unrelated failure.
    [
      {
        OMNESIS_FAKE_CLAUDE_EARLIER_API_ERROR: "rate_limit",
        OMNESIS_FAKE_CLAUDE_RESULT_SUBTYPE: "error_during_execution",
      },
      "claude_code_runtime_error",
      true,
      "error",
    ],
  ] as const)("maps %j to %s", async (env, code, retryable, stopReason) => {
    const terminal = await failureOf(setup(env).runtime);
    expect(terminal.stopReason).toBe(stopReason);
    expect(terminal.failure).toMatchObject({ code, retryable });
  });

  it("completes a turn that recovered from an earlier API error", async () => {
    const terminal = await failureOf(
      setup({ OMNESIS_FAKE_CLAUDE_EARLIER_API_ERROR: "max_output_tokens" }).runtime,
    );
    expect(terminal.stopReason).toBe("end_turn");
    expect(terminal.failure).toBeUndefined();
  });

  it("reports a CLI that dies mid-turn", async () => {
    const { runtime } = setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: "exit" });
    const events = await collect(
      new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input()),
    );
    expect(end(events).failure?.code).toBe("claude_code_process_exited");
  });

  it("interrupts the CLI on abort and ends the turn canceled", async () => {
    const { runtime } = setup({ OMNESIS_FAKE_CLAUDE_SCENARIO: "hang" });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(
      input(),
      controller.signal,
    )) {
      events.push(event);
      if (event.type === "agent.text.delta") controller.abort();
    }
    expect(end(events).stopReason).toBe("canceled");
  });

  it("keeps only the final answer for single-shot inference", async () => {
    const { runtime } = setup();
    const backend = new ClaudeCodeBackend({ model: "haiku", runtime, finalAnswerOnly: true });
    const events = await collect(
      backend.runTurn(
        input({ userMessage: "Classify", images: [{ url: "data:image/png;base64,AA" }] }),
      ),
    );
    expect(text(events)).toBe("Echo: Classify [1 image]");
  });

  it("leaves nothing behind in its working directory", async () => {
    const { runtime, dir } = setup();
    await collect(new ClaudeCodeBackend({ model: "sonnet", runtime }).runTurn(input()));
    expect(readdirSync(join(dir, "workspace"))).toEqual([]);
  });
});
