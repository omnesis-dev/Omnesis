// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { SyntheticE2EHarness } from "./synth-harness.js";

interface AgentEvent {
  type: string;
  payload: Record<string, unknown>;
}

interface SearchResponse {
  results?: unknown[];
}

const TURN_TIMEOUT_MS = 20_000;
const fakeCodexPath = join(
  import.meta.dirname,
  "../../../agent/src/test-fixtures/fake-codex-app-server.mjs",
);

const ENV_KEYS = [
  "OMNESIS_CODEX_COMMAND",
  "OMNESIS_CODEX_ARGS_JSON",
  "OMNESIS_CODEX_VERSION_ARGS_JSON",
  "OMNESIS_FAKE_CODEX_LOG",
  "OMNESIS_FAKE_CODEX_SCENARIO",
  "OMNESIS_FAKE_CODEX_TOOL",
  "OMNESIS_FAKE_CODEX_QUERY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "ANTHROPIC_API_KEY",
  "OMNESIS_PRIVATE_TOKEN",
] as const;

describe("Codex agent backend — spawned gateway E2E", () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  test("runs the main Omnesis agent through Codex app-server with dynamic Omnesis tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-codex-e2e-tool-"));
    tempDirs.push(dir);
    const logPath = join(dir, "fake-codex.jsonl");
    const restoreEnv = applyCodexEnv(logPath, "tool");
    const harness = new SyntheticE2EHarness({
      gatewayMode: "experimental",
      universe: "e2e-minimal",
      embedderBackend: "fake",
      extraInference: {
        assignments: { agent: "codex/gpt-5.4" },
        allowRemoteInference: true,
      },
    });

    try {
      await harness.start();
      await harness.syncAllSources();
      await harness.refreshSearchSnapshot();
      await waitForAgentSearchReady(harness, "marathon training", 90_000);

      const config = await gatewayJson<{ backend: string; enabled: boolean }>(
        harness,
        "/admin/agent/config",
      );
      expect(config).toMatchObject({ backend: "codex", enabled: true });

      const { session, events } = await runAgentTurn(harness, "Find the marathon training plan.");
      expect(session.backend).toBe("codex");
      expect(session.model).toBe("gpt-5.4");

      expect(events.some((event) => event.type === "agent.message.start")).toBe(true);
      const toolStart = events.find((event) => event.type === "agent.tool.start");
      expect(toolStart?.payload.tool).toBe("search_many");
      expect(toolStart?.payload.args).toMatchObject({
        queries: [
          {
            query: "marathon training",
            limit: 3,
          },
        ],
      });
      const toolResult = events.find((event) => event.type === "agent.tool.result");
      expect(
        toolResult?.payload.result,
        `unexpected Codex tool result: ${JSON.stringify(toolResult?.payload.result)}`,
      ).toMatchObject({
        kind: "search.batch",
        items: [
          {
            kind: "search.results",
            query: "marathon training",
          },
        ],
      });
      expect(
        (
          (toolResult?.payload.result as { items?: Array<{ results?: unknown[] }> } | undefined)
            ?.items?.[0]?.results ?? []
        ).length,
      ).toBeGreaterThan(0);
      expect(events.some((event) => event.type === "agent.error")).toBe(false);
      const end = events.find((event) => event.type === "agent.message.end");
      expect(end?.payload.stopReason).toBe("end_turn");

      const logs = readLog(logPath);
      const startup = firstPayload<{
        codexHome: string;
        cwd: string;
        hasOpenAiApiKey: boolean;
        hasCodexApiKey: boolean;
        hasAnthropicApiKey: boolean;
        hasOmnesisPrivateToken: boolean;
      }>(logs, "startup");
      expect(startup.cwd).not.toBe(startup.codexHome);
      expect(startup.cwd).toContain("codex-workspace");
      expect(startup.codexHome).toContain("codex-home");
      expect(startup.hasOpenAiApiKey).toBe(false);
      expect(startup.hasCodexApiKey).toBe(false);
      expect(startup.hasAnthropicApiKey).toBe(false);
      expect(startup.hasOmnesisPrivateToken).toBe(false);

      const threadStart = firstPayload<{ dynamicToolNames: string[] }>(logs, "thread_start");
      expect(threadStart.dynamicToolNames).toContain("search_many");
      expect(threadStart.dynamicToolNames).toContain("watch_create");
      expect(threadStart.dynamicToolNames).toContain("spawn_subagent");
      expect(threadStart.dynamicToolNames).toContain("join_subagents");
    } finally {
      restoreEnv();
      await harness.destroy();
    }
  }, 240_000);

  test("fails the turn if Codex emits native command output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-codex-e2e-native-"));
    tempDirs.push(dir);
    const logPath = join(dir, "fake-codex.jsonl");
    const restoreEnv = applyCodexEnv(logPath, "native-output");
    const harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      extraInference: {
        assignments: { agent: "codex/gpt-5.4" },
        allowRemoteInference: true,
      },
    });

    try {
      await harness.start();

      const { events } = await runAgentTurn(harness, "Try a native command.");
      const error = events.find((event) => event.type === "agent.error");
      expect(error?.payload.code).toBe("codex_native_tool_unavailable");
      expect(error?.payload.message).toContain("native item");
      const end = events.find((event) => event.type === "agent.message.end");
      expect(end?.payload.stopReason).toBe("error");
    } finally {
      restoreEnv();
      await harness.destroy();
    }
  }, 60_000);
});

function applyCodexEnv(logPath: string, scenario: string): () => void {
  const previous = new Map<(typeof ENV_KEYS)[number], string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);

  process.env.OMNESIS_CODEX_COMMAND = process.execPath;
  process.env.OMNESIS_CODEX_ARGS_JSON = JSON.stringify([fakeCodexPath]);
  process.env.OMNESIS_CODEX_VERSION_ARGS_JSON = JSON.stringify([fakeCodexPath, "--version"]);
  process.env.OMNESIS_FAKE_CODEX_LOG = logPath;
  process.env.OMNESIS_FAKE_CODEX_SCENARIO = scenario;
  process.env.OMNESIS_FAKE_CODEX_TOOL = "search_many";
  process.env.OMNESIS_FAKE_CODEX_QUERY = "marathon training";
  process.env.OPENAI_API_KEY = "must-not-leak";
  process.env.CODEX_API_KEY = "must-not-leak";
  process.env.ANTHROPIC_API_KEY = "must-not-leak";
  process.env.OMNESIS_PRIVATE_TOKEN = "must-not-leak";

  return () => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function waitForAgentSearchReady(
  harness: SyntheticE2EHarness,
  query: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: SearchResponse | undefined;
  while (Date.now() < deadline) {
    await harness.refreshSearchSnapshot();
    last = await gatewayJson<SearchResponse>(harness, "/search", {
      method: "POST",
      body: JSON.stringify({ text: query, limit: 3 }),
    });
    if ((last.results ?? []).length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`search did not become ready for ${query}: ${JSON.stringify(last)}`);
}

async function runAgentTurn(
  harness: SyntheticE2EHarness,
  text: string,
): Promise<{
  session: { sessionId: string; backend: string; model: string };
  events: AgentEvent[];
}> {
  const sse = await fetch(`${harness.gatewayUrl}/agent/events`, {
    headers: { Authorization: `Bearer ${harness.apiKey}`, Accept: "text/event-stream" },
  });
  if (!sse.ok || !sse.body) {
    throw new Error(`SSE subscribe failed: ${sse.status} ${await sse.text()}`);
  }
  const reader = sse.body.getReader();

  try {
    const session = await gatewayJson<{ sessionId: string; backend: string; model: string }>(
      harness,
      "/agent/sessions",
      {
        method: "POST",
        body: "{}",
      },
    );

    const sent = await gatewayJson<{ messageId: string }>(
      harness,
      `/agent/sessions/${session.sessionId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ text }),
      },
    );

    const events = await readEventsUntilMessageEnd(reader, session.sessionId, sent.messageId);
    return { session, events };
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* best effort */
    }
  }
}

async function gatewayJson<T>(
  harness: SyntheticE2EHarness,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${harness.apiKey}`);
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${harness.gatewayUrl}${path}`, { ...init, headers });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function readEventsUntilMessageEnd(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  sessionId: string,
  messageId: string,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + TURN_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value?: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true as const }), remaining),
      ),
    ]);
    if (next.done || !next.value) break;
    buffer += decoder.decode(next.value, { stream: true });

    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const json = dataLine.slice("data:".length).trim();
      if (!json) continue;
      let parsed: AgentEvent;
      try {
        parsed = JSON.parse(json) as AgentEvent;
      } catch {
        continue;
      }
      if (parsed.payload.sessionId !== sessionId) continue;
      events.push(parsed);
      if (parsed.type === "agent.message.end" && parsed.payload.messageId === messageId) {
        return events;
      }
    }
  }

  throw new Error(`Did not see agent.message.end for ${sessionId}/${messageId}`);
}

function readLog(path: string): Array<{ event: string; payload: unknown }> {
  if (!existsSync(path)) return [];
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
