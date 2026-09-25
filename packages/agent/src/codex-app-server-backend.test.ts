// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { existsSync, readFileSync, rmSync, mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CodexAppServerBackend,
  MANAGED_CODEX_PACKAGE,
  MANAGED_CODEX_PACKAGE_VERSION,
  convertToolsToCodexDynamicTools,
  isSupportedCodexCliVersion,
  parseCodexCliVersion,
  renderCodexUserInput,
  resolveCodexRuntimeCommand,
} from "./codex-app-server-backend.js";
import type { ChatMessage, ToolHandle, TurnInput } from "./backend.js";
import type { AgentEvent, ToolResult } from "@omnesis/core";

const fakeCodexPath = fileURLToPath(
  new URL("./test-fixtures/fake-codex-app-server.mjs", import.meta.url),
);

function fakeToolHandle(name: string, fn: (args: unknown) => ToolResult): ToolHandle {
  return {
    name,
    description: `synthetic ${name}`,
    schema: z.object({
      query: z.string().optional(),
      limit: z.number().optional(),
    }),
    invoke(args) {
      return Promise.resolve(fn(args));
    },
    summarize(args) {
      return JSON.stringify(args);
    },
  };
}

const baseInput = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  sessionId: "session_synthetic",
  messageId: "message_synthetic",
  history: [],
  userMessage: "Find the synthetic budget review.",
  tools: [],
  systemPrompt: "You are the Omnesis agent. Use Omnesis tools only.",
  ...overrides,
});

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of it) events.push(ev);
  return events;
}

function makeBackend(opts: {
  codexHome: string;
  workspaceDir?: string;
  logPath: string;
  scenario?: string;
  requestedTool?: string;
  version?: string;
  reasoningEffort?: string;
}): CodexAppServerBackend {
  return new CodexAppServerBackend({
    model: "gpt-5.4",
    reasoningEffort: opts.reasoningEffort,
    codexHome: opts.codexHome,
    workspaceDir: opts.workspaceDir,
    command: process.execPath,
    args: [fakeCodexPath],
    versionArgs: [fakeCodexPath, "--version"],
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
    toolTimeoutMs: 2_000,
    maxToolIterations: 4,
    env: {
      ...process.env,
      OMNESIS_FAKE_CODEX_LOG: opts.logPath,
      OMNESIS_FAKE_CODEX_SCENARIO: opts.scenario ?? "tool",
      ...(opts.version ? { OMNESIS_FAKE_CODEX_VERSION: opts.version } : {}),
      ...(opts.requestedTool ? { OMNESIS_FAKE_CODEX_TOOL: opts.requestedTool } : {}),
      OPENAI_API_KEY: "must-not-leak",
      CODEX_API_KEY: "must-not-leak",
      ANTHROPIC_API_KEY: "must-not-leak",
      OMNESIS_PRIVATE_TOKEN: "must-not-leak",
    },
  });
}

function readLog(path: string): Array<{ event: string; payload: unknown }> {
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as { event: string; payload: unknown });
}

function firstPayload<T extends Record<string, unknown>>(
  logs: Array<{ event: string; payload: unknown }>,
  event: string,
): T {
  const entry = logs.find((line) => line.event === event);
  if (!entry || !entry.payload || typeof entry.payload !== "object") {
    throw new Error(`missing ${event} log entry`);
  }
  return entry.payload as T;
}

async function waitForLog(
  path: string,
  predicate: (logs: Array<{ event: string; payload: unknown }>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && predicate(readLog(path))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for fake Codex log ${path}`);
}

describe("CodexAppServerBackend", () => {
  it("parses and gates the supported Codex CLI line", () => {
    expect(parseCodexCliVersion("codex-cli 0.142.4")).toBe("0.142.4");
    expect(parseCodexCliVersion("codex 0.142.0")).toBe("0.142.0");
    expect(parseCodexCliVersion("unexpected")).toBeNull();
    expect(isSupportedCodexCliVersion("0.142.4")).toBe(true);
    expect(isSupportedCodexCliVersion("0.151.0")).toBe(true);
    expect(isSupportedCodexCliVersion("0.143.0")).toBe(false);
  });

  it("resolves managed Codex by default and preserves explicit overrides", async () => {
    await expect(resolveCodexRuntimeCommand({ commandOverride: fakeCodexPath })).resolves.toEqual({
      source: "override",
      command: fakeCodexPath,
    });

    const managed = await resolveCodexRuntimeCommand();
    expect(managed).toMatchObject({
      source: "managed",
      packageName: MANAGED_CODEX_PACKAGE,
      packageVersion: MANAGED_CODEX_PACKAGE_VERSION,
    });
    expect(managed.command).toContain("@openai/codex");
  });

  it("preserves pre-resolved gateway-owned runtimes as managed", async () => {
    const runtime = new (await import("./codex-app-server-backend.js")).CodexAppServerRuntime({
      codexHome: "/tmp/omnesis-synthetic-codex-home",
      command: "/tmp/ignored-override",
      commandInfo: {
        source: "managed",
        command: fakeCodexPath,
        packageName: MANAGED_CODEX_PACKAGE,
        packageVersion: MANAGED_CODEX_PACKAGE_VERSION,
      },
    });

    await expect(runtime.resolveCommandInfo()).resolves.toMatchObject({
      source: "managed",
      command: fakeCodexPath,
      packageVersion: MANAGED_CODEX_PACKAGE_VERSION,
    });
    await runtime.dispose();
  });

  it("includes sub-agent tools in Codex dynamic tools", () => {
    const tools = convertToolsToCodexDynamicTools([
      fakeToolHandle("search_documents", () => ({
        kind: "error",
        code: "unused",
        message: "unused",
      })),
      fakeToolHandle("spawn_subagent", () => ({
        kind: "error",
        code: "unused",
        message: "unused",
      })),
      fakeToolHandle("join_subagents", () => ({
        kind: "error",
        code: "unused",
        message: "unused",
      })),
    ]);

    expect(tools.map((tool) => tool.name)).toEqual([
      "search_documents",
      "spawn_subagent",
      "join_subagents",
    ]);
    expect(tools[0]).toMatchObject({ type: "function", name: "search_documents" });
  });

  it("renders prior Omnesis history into a stateless Codex turn prompt", () => {
    const history: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "Earlier synthetic question" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Earlier synthetic answer" }] },
    ];

    expect(renderCodexUserInput(history, "New synthetic question")).toContain(
      "Conversation so far:\nUser: Earlier synthetic question\nAssistant: Earlier synthetic answer",
    );
    expect(renderCodexUserInput(history, "New synthetic question")).toContain(
      "New user message:\nNew synthetic question",
    );
  });

  it("sends inline vision inputs without enabling native image tools", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-vision-")));
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({ codexHome: join(dir, "home"), logPath, scenario: "no-tool" });
    const url = "data:image/png;base64,aW52ZW50ZWQ=";
    try {
      const events = await collect(backend.runTurn(baseInput({ images: [{ url }] })));
      expect(events.find((event) => event.type === "agent.message.end")?.payload.stopReason).toBe(
        "end_turn",
      );
      const logs = readLog(logPath);
      const turn = firstPayload<{ params: { input: unknown[] } }>(logs, "turn_start");
      expect(turn.params.input).toEqual([
        { type: "text", text: renderCodexUserInput([], baseInput().userMessage) },
        { type: "image", url },
      ]);
      const thread = firstPayload<{ dynamicToolNames: string[] }>(logs, "thread_start");
      expect(thread.dynamicToolNames).toEqual([]);
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends a configured reasoning effort using Codex's native turn field", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-effort-")));
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({
      codexHome: join(dir, "home"),
      logPath,
      scenario: "no-tool",
      reasoningEffort: "high",
    });
    try {
      await collect(backend.runTurn(baseInput()));
      const turn = firstPayload<{ params: Record<string, unknown> }>(
        readLog(logPath),
        "turn_start",
      );
      expect(turn.params.effort).toBe("high");
      expect(turn.params).not.toHaveProperty("reasoning_effort");
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts a hardened Codex app-server, exposes only Omnesis tools, and feeds tool results back", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-unit-")));
    const codexHome = join(dir, "codex-home");
    const workspaceDir = join(dir, "codex-workspace");
    const logPath = join(dir, "fake-codex.jsonl");
    const result: ToolResult = {
      kind: "search.results",
      query: "synthetic budget review",
      durationMs: 0,
      results: [],
    };
    const backend = makeBackend({ codexHome, workspaceDir, logPath });

    try {
      const events = await collect(
        backend.runTurn(
          baseInput({
            tools: [
              fakeToolHandle("search_documents", () => result),
              fakeToolHandle("spawn_subagent", () => ({
                kind: "error",
                code: "should_not_run",
                message: "should not run",
              })),
            ],
          }),
        ),
      );

      expect(events.map((ev) => ev.type)).toEqual([
        "agent.message.start",
        "agent.tool.input_start",
        "agent.tool.start",
        "agent.tool.result",
        "agent.text.delta",
        "agent.usage.update",
        "agent.message.end",
      ]);
      const toolResult = events.find((ev) => ev.type === "agent.tool.result");
      expect(toolResult?.payload.result).toEqual(result);
      const end = events.find((ev) => ev.type === "agent.message.end");
      expect(end?.payload.usage).toEqual({
        inputTokens: 12,
        outputTokens: 7,
        cacheReadTokens: 2,
      });

      const configToml = readFileSync(join(codexHome, "config.toml"), "utf8");
      expect(configToml).toContain('approval_policy = "never"');
      expect(configToml).toContain('sandbox_mode = "read-only"');
      expect(configToml).toContain("shell_tool = false");
      expect(configToml).toContain("multi_agent = false");
      expect(configToml).toContain("network_access = false");
      expect(statSync(codexHome).mode & 0o777).toBe(0o700);
      expect(statSync(workspaceDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(codexHome, "config.toml")).mode & 0o777).toBe(0o600);

      const logs = readLog(logPath);
      const startup = firstPayload<{
        codexHome: string;
        cwd: string;
        hasOpenAiApiKey: boolean;
        hasCodexApiKey: boolean;
        hasAnthropicApiKey: boolean;
        hasOmnesisPrivateToken: boolean;
      }>(logs, "startup");
      expect(startup.codexHome).toBe(codexHome);
      expect(startup.cwd).toBe(workspaceDir);
      expect(startup.hasOpenAiApiKey).toBe(false);
      expect(startup.hasCodexApiKey).toBe(false);
      expect(startup.hasAnthropicApiKey).toBe(false);
      expect(startup.hasOmnesisPrivateToken).toBe(false);

      const threadStart = firstPayload<{
        dynamicToolNames: string[];
        params: { cwd: string };
      }>(logs, "thread_start");
      expect(threadStart.params.cwd).toBe(workspaceDir);
      expect(threadStart.dynamicToolNames).toContain("search_documents");
      expect(threadStart.dynamicToolNames).toContain("spawn_subagent");
      expect(threadStart.dynamicToolNames).not.toContain("join_subagents");

      const toolResponse = firstPayload<{
        result: { success: boolean; contentItems: Array<{ text: string }> };
      }>(logs, "tool_call_response");
      expect(toolResponse.result.success).toBe(true);
      expect(JSON.parse(toolResponse.result.contentItems[0]!.text)).toMatchObject({
        kind: "search.results",
        query: "synthetic budget review",
      });
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts tool calls that arrive immediately after turn/start before the await resumes", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-early-events-")));
    const codexHome = join(dir, "codex-home");
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({ codexHome, logPath, scenario: "early-events" });

    try {
      const events = await collect(
        backend.runTurn(
          baseInput({
            tools: [
              fakeToolHandle("search_documents", () => ({
                kind: "search.results",
                query: "synthetic budget review",
                durationMs: 0,
                results: [],
              })),
            ],
          }),
        ),
      );

      expect(events.map((ev) => ev.type)).toContain("agent.tool.result");
      expect(events.some((ev) => ev.type === "agent.error")).toBe(false);
      expect(events.find((ev) => ev.type === "agent.message.end")?.payload.stopReason).toBe(
        "end_turn",
      );
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["native-approval", "native_approval_response", { decision: "decline" }],
    ["native-file-approval", "native_file_approval_response", { decision: "decline" }],
    [
      "permissions",
      "permissions_response",
      { permissions: {}, scope: "turn", strictAutoReview: true },
    ],
    ["user-input", "user_input_response", { answers: {} }],
    ["mcp-elicitation", "mcp_elicitation_response", { action: "decline", content: null }],
  ] as const)(
    "auto-declines native Codex server request %s but allows the turn to finish",
    async (scenario, responseEvent, expected) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), `omnesis-codex-${scenario}-`)));
      const codexHome = join(dir, "codex-home");
      const logPath = join(dir, "fake-codex.jsonl");
      const backend = makeBackend({ codexHome, logPath, scenario });

      try {
        const events = await collect(backend.runTurn(baseInput()));

        expect(events.map((ev) => ev.type)).toEqual([
          "agent.message.start",
          "agent.text.delta",
          "agent.usage.update",
          "agent.message.end",
        ]);
        const text = events.find((ev) => ev.type === "agent.text.delta");
        expect(text?.payload.delta).toContain("declined by policy");
        const response = firstPayload<{ result: Record<string, unknown> }>(
          readLog(logPath),
          responseEvent,
        );
        expect(response.result).toMatchObject(expected);
      } finally {
        await backend.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("hard-fails if Codex emits native command output", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-native-output-")));
    const codexHome = join(dir, "codex-home");
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({ codexHome, logPath, scenario: "native-output" });

    try {
      const events = await collect(backend.runTurn(baseInput()));

      expect(events.map((ev) => ev.type)).toEqual([
        "agent.message.start",
        "agent.error",
        "agent.message.end",
      ]);
      const error = events.find((ev) => ev.type === "agent.error");
      expect(error?.payload.code).toBe("codex_native_tool_unavailable");
      expect(error?.payload.message).toContain("native item");
      const end = events.find((ev) => ev.type === "agent.message.end");
      expect(end?.payload.stopReason).toBe("error");
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a batch containing a child error as unsuccessful without dropping its payload", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-batch-error-")));
    const codexHome = join(dir, "codex-home");
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({
      codexHome,
      logPath,
      scenario: "tool",
      requestedTool: "annotate_many",
    });

    try {
      await collect(
        backend.runTurn(
          baseInput({
            tools: [
              fakeToolHandle("annotate_many", () => ({
                kind: "annotate.batch",
                items: [
                  {
                    kind: "error",
                    code: "document_not_found",
                    message: "Resolve the canonical document id and retry.",
                  },
                ],
              })),
            ],
          }),
        ),
      );

      const toolResponse = firstPayload<{
        result: { success: boolean; contentItems: Array<{ text: string }> };
      }>(readLog(logPath), "tool_call_response");
      expect(toolResponse.result.success).toBe(false);
      expect(JSON.parse(toolResponse.result.contentItems[0]!.text)).toEqual({
        kind: "annotate.batch",
        items: [
          {
            kind: "error",
            code: "document_not_found",
            message: "Resolve the canonical document id and retry.",
          },
        ],
      });
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores stale native output from a previous turn", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-stale-native-output-")));
    const codexHome = join(dir, "codex-home");
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({ codexHome, logPath, scenario: "stale-native-output" });

    try {
      const events = await collect(backend.runTurn(baseInput()));

      expect(events.some((ev) => ev.type === "agent.error")).toBe(false);
      expect(events.find((ev) => ev.type === "agent.text.delta")?.payload.delta).toContain(
        "Fresh turn survived",
      );
      expect(events.find((ev) => ev.type === "agent.message.end")?.payload.stopReason).toBe(
        "end_turn",
      );
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["invalid-tool-args", undefined, "tool_invalid_args"],
    ["tool", "missing_tool", "unknown_tool"],
  ] as const)("returns structured tool errors for %s", async (scenario, requestedTool, code) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), `omnesis-codex-${scenario}-`)));
    const codexHome = join(dir, "codex-home");
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({ codexHome, logPath, scenario, requestedTool });

    try {
      const events = await collect(
        backend.runTurn(
          baseInput({
            tools: [
              fakeToolHandle("search_documents", () => ({
                kind: "search.results",
                query: "synthetic budget review",
                durationMs: 0,
                results: [],
              })),
            ],
          }),
        ),
      );

      const result = events.find((ev) => ev.type === "agent.tool.result")?.payload.result;
      expect(result).toMatchObject({ kind: "error", code });
      const toolResponse = firstPayload<{
        result: { success: boolean; contentItems: Array<{ text: string }> };
      }>(readLog(logPath), "tool_call_response");
      expect(toolResponse.result.success).toBe(false);
      expect(JSON.parse(toolResponse.result.contentItems[0]!.text)).toMatchObject({ code });
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a structured tool error when an Omnesis tool throws", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-tool-throws-")));
    const codexHome = join(dir, "codex-home");
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({ codexHome, logPath });

    try {
      const events = await collect(
        backend.runTurn(
          baseInput({
            tools: [
              {
                ...fakeToolHandle("search_documents", () => ({
                  kind: "search.results",
                  query: "unused",
                  durationMs: 0,
                  results: [],
                })),
                invoke() {
                  throw new Error("synthetic tool failure");
                },
              },
            ],
          }),
        ),
      );

      const result = events.find((ev) => ev.type === "agent.tool.result")?.payload.result;
      expect(result).toMatchObject({
        kind: "error",
        code: "tool_threw",
        message: "synthetic tool failure",
      });
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels a queued turn promptly without starting it or blocking its successor", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-queue-abort-")));
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({ codexHome: join(dir, "home"), logPath, scenario: "hang" });
    const firstAbort = new AbortController();
    const lastAbort = new AbortController();
    try {
      const first = collect(backend.runTurn(baseInput(), firstAbort.signal));
      await waitForLog(logPath, (logs) => logs.some((line) => line.event === "turn_start"));
      const middleAbort = new AbortController();
      const middle = collect(backend.runTurn(baseInput(), middleAbort.signal));
      const last = collect(backend.runTurn(baseInput(), lastAbort.signal));
      middleAbort.abort();
      await expect(middle).rejects.toMatchObject({ name: "AbortError" });
      firstAbort.abort();
      await first;
      await waitForLog(
        logPath,
        (logs) => logs.filter((line) => line.event === "turn_start").length === 2,
      );
      lastAbort.abort();
      await last;
    } finally {
      firstAbort.abort();
      lastAbort.abort();
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels an active turn on dispose and tears down the child process", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-dispose-")));
    const codexHome = join(dir, "codex-home");
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({ codexHome, logPath, scenario: "hang" });

    try {
      const eventsPromise = collect(backend.runTurn(baseInput()));
      await waitForLog(logPath, (logs) => logs.some((line) => line.event === "turn_start"));
      await backend.dispose();
      const events = await eventsPromise;

      expect(events.map((ev) => ev.type)).toEqual(["agent.message.start", "agent.message.end"]);
      expect(events.find((ev) => ev.type === "agent.message.end")?.payload.stopReason).toBe(
        "canceled",
      );
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits the cancellation terminal when disposed before turn/start resolves", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-pending-dispose-")));
    const codexHome = join(dir, "codex-home");
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({ codexHome, logPath, scenario: "pending-turn-start" });

    try {
      const eventsPromise = collect(backend.runTurn(baseInput()));
      await waitForLog(logPath, (logs) => logs.some((line) => line.event === "turn_start"));
      await backend.dispose();
      const events = await eventsPromise;

      expect(events.map((ev) => ev.type)).toEqual(["agent.message.start", "agent.message.end"]);
      expect(events.find((ev) => ev.type === "agent.message.end")?.payload.stopReason).toBe(
        "canceled",
      );
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["quota", "codex_usage_limited"],
    ["auth", "codex_not_authenticated"],
    ["context", "context_window_exceeded"],
  ] as const)(
    "surfaces %s failures with actionable Codex error codes",
    async (scenario, code) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), `omnesis-codex-${scenario}-`)));
      const codexHome = join(dir, "codex-home");
      const logPath = join(dir, "fake-codex.jsonl");
      const backend = makeBackend({ codexHome, logPath, scenario });

      try {
        const events = await collect(backend.runTurn(baseInput()));
        const error = events.find((ev) => ev.type === "agent.error");
        expect(error?.payload.code).toBe(code);
        expect(error?.payload.message).not.toContain("fake Codex runtime");
        const end = events.find((ev) => ev.type === "agent.message.end");
        expect(end?.payload.stopReason).toBe("error");
        expect(end?.payload.failure).toMatchObject({
          code,
          retryable: code !== "context_window_exceeded",
          backend: "codex",
        });
        if (code === "context_window_exceeded") {
          expect(end?.payload.context).toMatchObject({
            measurement: "unknown",
            limitSource: "unknown",
            requestIteration: 1,
          });
          expect(end?.payload.context?.inputTokens).toBeUndefined();
        }
      } finally {
        await backend.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("rejects unsupported Codex CLI versions before starting app-server", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "omnesis-codex-unsupported-version-")));
    const codexHome = join(dir, "codex-home");
    const logPath = join(dir, "fake-codex.jsonl");
    const backend = makeBackend({ codexHome, logPath, version: "0.143.0" });

    try {
      const events = await collect(backend.runTurn(baseInput()));
      const error = events.find((ev) => ev.type === "agent.error");
      expect(error?.payload.code).toBe("codex_unsupported_version");
      expect(events.find((ev) => ev.type === "agent.message.end")?.payload.stopReason).toBe(
        "error",
      );
      expect(existsSync(logPath)).toBe(false);
    } finally {
      await backend.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
