// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import "./synth-env.js";

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { gatewayJson, runAgentTurn, waitForAgentSearchReady } from "./agent-turn-helpers.js";
import { SyntheticE2EHarness } from "./synth-harness.js";

const fakeClaudePath = join(
  import.meta.dirname,
  "../../../agent/src/test-fixtures/fake-claude-code.mjs",
);

const ENV_KEYS = [
  "OMNESIS_CLAUDE_CODE_COMMAND",
  "OMNESIS_FAKE_CLAUDE_RECORD",
  "OMNESIS_FAKE_CLAUDE_SCENARIO",
  "OMNESIS_FAKE_CLAUDE_TOOL",
  "OMNESIS_FAKE_CLAUDE_TOOL_ARGS",
  "ANTHROPIC_API_KEY",
  "OMNESIS_PRIVATE_TOKEN",
] as const;

interface Recorded {
  args: string[];
  envKeys: string[];
  received: Array<Record<string, unknown>>;
}

describe("Claude Code agent backend — spawned gateway E2E", () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  });

  test("runs the main Omnesis agent through the Claude Code CLI with only Omnesis tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-claude-code-e2e-tool-"));
    tempDirs.push(dir);
    const recordPath = join(dir, "fake-claude.jsonl");
    const restoreEnv = applyClaudeCodeEnv(recordPath, "tool");
    const harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      embedderBackend: "fake",
      extraInference: {
        assignments: { agent: "claude-code/sonnet" },
        allowRemoteInference: true,
      },
    });

    try {
      await harness.start();
      await harness.syncAllSources();
      await harness.refreshSearchSnapshot();
      await waitForAgentSearchReady(harness, "marathon training", 90_000);

      const models = await gatewayJson<{
        inference: { claudeCode?: { status: string; loggedIn: boolean; models: string[] } };
      }>(harness, "/admin/models");
      expect(models.inference.claudeCode).toMatchObject({
        status: "ok",
        loggedIn: true,
        models: ["sonnet", "haiku"],
      });

      const config = await gatewayJson<{ backend: string; enabled: boolean }>(
        harness,
        "/admin/agent/config",
      );
      expect(config).toMatchObject({ backend: "claude-code", enabled: true });

      const { session, events } = await runAgentTurn(harness, "Find the marathon training plan.");
      expect(session.backend).toBe("claude-code");
      expect(session.model).toBe("sonnet");

      const toolStart = events.find((event) => event.type === "agent.tool.start");
      expect(toolStart?.payload.tool).toBe("search_many");
      const toolResult = events.find((event) => event.type === "agent.tool.result");
      expect(toolResult?.payload.result).toMatchObject({
        kind: "search.batch",
        items: [{ kind: "search.results", query: "marathon training" }],
      });
      expect(events.some((event) => event.type === "agent.error")).toBe(false);
      expect(events.find((event) => event.type === "agent.message.end")?.payload.stopReason).toBe(
        "end_turn",
      );

      const turn = readRecords(recordPath).find((run) =>
        run.received.some((frame) => frame.type === "user"),
      );
      if (!turn) throw new Error("the fake CLI recorded no turn");
      const flag = (name: string) => turn.args[turn.args.indexOf(name) + 1];
      expect(flag("--tools")).toBe("");
      expect(flag("--setting-sources")).toBe("");
      expect(flag("--model")).toBe("sonnet");
      expect(turn.args).toContain("--strict-mcp-config");
      expect(turn.envKeys).not.toContain("ANTHROPIC_API_KEY");
      expect(turn.envKeys).not.toContain("OMNESIS_PRIVATE_TOKEN");

      const toolList = JSON.stringify(
        turn.received.find(
          (frame) =>
            frame.type === "control_response" && JSON.stringify(frame).includes('"tools":['),
        ),
      );
      expect(toolList).toContain('"name":"search_many"');
      expect(toolList).toContain('"name":"spawn_subagent"');
    } finally {
      restoreEnv();
      await harness.destroy();
    }
  }, 240_000);

  test("fails the turn when the CLI offers a tool Omnesis did not provide", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-claude-code-e2e-foreign-"));
    tempDirs.push(dir);
    const restoreEnv = applyClaudeCodeEnv(join(dir, "fake-claude.jsonl"), "foreign-tools");
    const harness = new SyntheticE2EHarness({
      gatewayMode: "stable",
      universe: "e2e-minimal",
      extraInference: {
        assignments: { agent: "claude-code/sonnet" },
        allowRemoteInference: true,
      },
    });

    try {
      await harness.start();
      const { events } = await runAgentTurn(harness, "List the files on this machine.");
      const error = events.find((event) => event.type === "agent.error");
      expect(error?.payload.code).toBe("claude_code_native_tool_unavailable");
      expect(error?.payload.message).toContain("Bash");
      expect(events.find((event) => event.type === "agent.message.end")?.payload.stopReason).toBe(
        "error",
      );
    } finally {
      restoreEnv();
      await harness.destroy();
    }
  }, 60_000);
});

function applyClaudeCodeEnv(recordPath: string, scenario: string): () => void {
  const previous = new Map<(typeof ENV_KEYS)[number], string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);

  process.env.OMNESIS_CLAUDE_CODE_COMMAND = fakeClaudePath;
  process.env.OMNESIS_FAKE_CLAUDE_RECORD = recordPath;
  process.env.OMNESIS_FAKE_CLAUDE_SCENARIO = scenario;
  process.env.OMNESIS_FAKE_CLAUDE_TOOL = "search_many";
  process.env.OMNESIS_FAKE_CLAUDE_TOOL_ARGS = JSON.stringify({
    queries: [{ query: "marathon training", limit: 3 }],
  });
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

function readRecords(path: string): Recorded[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as Recorded);
}
