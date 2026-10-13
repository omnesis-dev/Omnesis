// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ConfigStore } from "../config-store.js";
import { AgentSetupConflictError, AgentSetupUnavailableError } from "./agent-assignment-setup.js";
import { ClaudeCodeService } from "./claude-code-service.js";
import type { AgentEvent } from "@omnesis/core";
import type { ChatBackend, ToolHandle, TurnInput } from "@omnesis/agent";

const fakeClaude = fileURLToPath(
  new URL("../../../agent/src/test-fixtures/fake-claude-code.mjs", import.meta.url),
);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function service(
  env: Record<string, string> = {},
  opts: { command?: string; laneCapacity?: { interactive?: number } } = {},
) {
  const configDir = mkdtempSync(join(tmpdir(), "omnesis-claude-code-service-"));
  dirs.push(configDir);
  return {
    configDir,
    service: new ClaudeCodeService({
      configDir,
      command: opts.command ?? fakeClaude,
      env: { PATH: process.env.PATH, HOME: configDir, ...env },
      passEnvPrefixes: ["OMNESIS_FAKE_CLAUDE_"],
      ...(opts.laneCapacity ? { laneCapacity: opts.laneCapacity } : {}),
    }),
  };
}

const input = (overrides: Partial<TurnInput> = {}): TurnInput => ({
  sessionId: "session_synthetic",
  messageId: "message_synthetic",
  history: [],
  userMessage: "Summarise the synthetic quarterly review.",
  tools: [],
  systemPrompt: "You are the Omnesis agent.",
  ...overrides,
});

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const stopReason = (events: AgentEvent[]) =>
  (events.find((e) => e.type === "agent.message.end")?.payload as { stopReason: string })
    .stopReason;

describe("ClaudeCodeService status", () => {
  it("reports a signed-in CLI with its plan and catalog", async () => {
    const status = await service().service.refresh();
    expect(status).toMatchObject({
      type: "claude-code",
      installed: true,
      status: "ok",
      loggedIn: true,
      account: { authMethod: "claude.ai", subscriptionType: "max" },
      runtime: { command: fakeClaude, version: "2.1.296", supported: true },
      models: ["sonnet", "haiku"],
    });
    expect(status.modelDetails?.[0]).toMatchObject({
      id: "sonnet",
      name: "Sonnet",
      resolvedModel: "claude-sonnet-fake",
      inputModalities: ["text", "image"],
      supportedReasoningEfforts: ["low", "medium", "high"],
    });
    expect(status.modelRoles?.sonnet).toContain("agent");
    expect(status.modelRoles?.sonnet).toContain("ocr");
    expect(status.modelRoles?.sonnet).not.toContain("embedder");
  });

  it("tells a signed-out operator to sign in on the gateway host", async () => {
    const status = await service({ OMNESIS_FAKE_CLAUDE_LOGGED_IN: "0" }).service.refresh();
    expect(status).toMatchObject({ installed: true, status: "unreachable", loggedIn: false });
    expect(status.reason).toContain("claude auth login");
    expect(status.models).toEqual([]);
  });

  it("reports a CLI that is too old as installed but unsupported", async () => {
    const status = await service({ OMNESIS_FAKE_CLAUDE_VERSION: "2.0.0" }).service.refresh();
    expect(status).toMatchObject({ installed: true, status: "unreachable" });
    expect(status.runtime).toMatchObject({ version: "2.0.0", supported: false });
    expect(status.reason).toMatch(/too old/);
  });

  it("reports a missing CLI", async () => {
    const { service: svc, configDir } = service({}, { command: "" });
    // No override and an empty PATH: nothing to find.
    const missing = new ClaudeCodeService({ configDir, env: { PATH: configDir, HOME: configDir } });
    const status = await missing.refresh();
    expect(status).toMatchObject({ installed: false, status: "unreachable", loggedIn: false });
    expect(status.reason).toMatch(/not found/);
    expect(svc.snapshot().status).toBe("unreachable");
  });

  it("keeps a signed-in CLI's details when its catalog cannot be read", async () => {
    const status = await service({ OMNESIS_FAKE_CLAUDE_LIST_MODELS: "fail" }).service.refresh();
    expect(status).toMatchObject({
      installed: true,
      loggedIn: true,
      status: "unreachable",
      runtime: { version: "2.1.296", supported: true },
    });
    expect(status.reason).toContain("model catalog");
  });

  it("coalesces concurrent refreshes", async () => {
    const { service: svc } = service();
    const [a, b] = [svc.refresh(), svc.refresh()];
    expect(svc.snapshot().status).toBe("probing");
    expect(await a).toBe(await b);
  });
});

describe("ClaudeCodeService agent setup", () => {
  async function store(configDir: string, agent?: string) {
    const configStore = new ConfigStore({ filePath: join(configDir, "omnesis.json") });
    await configStore.load();
    if (agent) await configStore.patch({ inference: { assignments: { agent } } });
    return configStore;
  }

  it("enables remote inference and assigns an unassigned agent", async () => {
    const { service: svc, configDir } = service();
    const configStore = await store(configDir);
    expect(await svc.setupAgent(configStore, "sonnet")).toEqual({
      assignment: "claude-code/sonnet",
      allowRemoteInference: true,
    });
    const inference = configStore.get().inference;
    expect(inference?.assignments?.agent).toBe("claude-code/sonnet");
    expect(inference?.allowRemoteInference).toBe(true);
  });

  it("refuses a model the CLI does not list and a CLI that is signed out", async () => {
    const { service: svc, configDir } = service();
    await expect(svc.setupAgent(await store(configDir), "opus-unknown")).rejects.toBeInstanceOf(
      AgentSetupUnavailableError,
    );
    const signedOut = service({ OMNESIS_FAKE_CLAUDE_LOGGED_IN: "0" });
    await expect(
      signedOut.service.setupAgent(await store(signedOut.configDir), "sonnet"),
    ).rejects.toBeInstanceOf(AgentSetupUnavailableError);
  });

  it("never replaces an agent someone already assigned", async () => {
    const { service: svc, configDir } = service();
    const configStore = await store(configDir, "anthropic/claude-sonnet-fake");
    await expect(svc.setupAgent(configStore, "sonnet")).rejects.toBeInstanceOf(
      AgentSetupConflictError,
    );
    expect(configStore.get().inference?.assignments?.agent).toBe("anthropic/claude-sonnet-fake");
  });
});

describe("ClaudeCodeService lanes", () => {
  it("queues a top-level turn while its lane is full and admits it when a slot frees", async () => {
    const { service: svc } = service(
      { OMNESIS_FAKE_CLAUDE_SCENARIO: "hang" },
      { laneCapacity: { interactive: 1 } },
    );
    const first = new AbortController();
    const firstTurn = svc.createBackend({ model: "sonnet" }).runTurn(input(), first.signal);
    const iterator = firstTurn[Symbol.asyncIterator]();
    await iterator.next(); // admitted and started

    const second = new AbortController();
    let secondStarted = false;
    const secondRun = (async () => {
      for await (const event of svc
        .createBackend({ model: "sonnet" })
        .runTurn(input(), second.signal)) {
        if (event.type === "agent.message.start") secondStarted = true;
        if (event.type === "agent.text.delta") second.abort();
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(secondStarted).toBe(false);

    first.abort();
    while (!(await iterator.next()).done) {
      /* drain the canceled turn */
    }
    await secondRun;
    expect(secondStarted).toBe(true);
  });

  it("abandons a queued turn whose caller gives up", async () => {
    const { service: svc } = service(
      { OMNESIS_FAKE_CLAUDE_SCENARIO: "hang" },
      { laneCapacity: { interactive: 1 } },
    );
    const holder = new AbortController();
    const held = svc.createBackend({ model: "sonnet" }).runTurn(input(), holder.signal);
    const iterator = held[Symbol.asyncIterator]();
    await iterator.next();

    const waiter = new AbortController();
    const queued = collect(svc.createBackend({ model: "sonnet" }).runTurn(input(), waiter.signal));
    waiter.abort(new Error("caller left"));
    await expect(queued).rejects.toThrow("caller left");

    holder.abort();
    while (!(await iterator.next()).done) {
      /* drain */
    }
  });

  it("admits a turn started from inside another turn's tool even when the lane is full", async () => {
    const { service: svc } = service(
      { OMNESIS_FAKE_CLAUDE_SCENARIO: "tool", OMNESIS_FAKE_CLAUDE_TOOL_ARGS: '{"query":"x"}' },
      { laneCapacity: { interactive: 1 } },
    );
    let nested: ChatBackend | null = null;
    let nestedStop = "";
    const delegate: ToolHandle = {
      name: "delegate",
      description: "Run a synthetic sub-agent",
      schema: z.object({ query: z.string() }),
      invoke: async () => {
        nested = svc.createBackend({ model: "haiku" });
        nestedStop = stopReason(await collect(nested.runTurn(input())));
        return { kind: "error", code: "synthetic", message: `sub-agent ${nestedStop}` };
      },
    };
    const events = await collect(
      svc.createBackend({ model: "sonnet" }).runTurn(input({ tools: [delegate] })),
    );
    expect(nestedStop).toBe("end_turn");
    expect(stopReason(events)).toBe("end_turn");
  });

  it("admits work a tool only scheduled through the lane, not as a nested turn", async () => {
    const { service: svc } = service(
      { OMNESIS_FAKE_CLAUDE_SCENARIO: "tool", OMNESIS_FAKE_CLAUDE_TOOL_ARGS: '{"query":"x"}' },
      { laneCapacity: { interactive: 1 } },
    );
    let scheduled!: Promise<void>;
    let scheduledStarted = false;
    const scheduler: ToolHandle = {
      name: "schedule",
      description: "Queue synthetic follow-up work",
      schema: z.object({ query: z.string() }),
      invoke: () => {
        // Started after this call settles, while the scheduling turn still
        // holds the only interactive slot.
        scheduled = new Promise<void>((resolve) => setTimeout(resolve, 50)).then(async () => {
          for await (const event of svc
            .createBackend({ model: "haiku" })
            .runTurn(input({ sessionId: "follow-up" }))) {
            if (event.type === "agent.message.start") scheduledStarted = true;
          }
        });
        return Promise.resolve({ kind: "error", code: "synthetic", message: "queued" });
      },
    };
    const turn = svc.createBackend({ model: "sonnet" }).runTurn(input({ tools: [scheduler] }));
    const iterator = turn[Symbol.asyncIterator]();
    let next = await iterator.next();
    while (!next.done && next.value.type !== "agent.tool.result") next = await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(scheduledStarted).toBe(false);
    while (!(await iterator.next()).done) {
      /* finish the scheduling turn, freeing its slot */
    }
    await scheduled;
    expect(scheduledStarted).toBe(true);
  });

  it("refuses nesting beyond the sub-agent depth cap", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "omnesis-claude-code-depth-"));
    dirs.push(configDir);
    const svc = new ClaudeCodeService({
      configDir,
      command: fakeClaude,
      env: {
        PATH: process.env.PATH,
        HOME: configDir,
        OMNESIS_FAKE_CLAUDE_SCENARIO: "tool",
        OMNESIS_FAKE_CLAUDE_TOOL_ARGS: '{"query":"x"}',
      },
      passEnvPrefixes: ["OMNESIS_FAKE_CLAUDE_"],
      getSubagentDepthCap: () => 0,
    });
    const depths: string[] = [];
    const recurse: ToolHandle = {
      name: "recurse",
      description: "Start a synthetic sub-agent that recurses",
      schema: z.object({ query: z.string() }),
      invoke: async () => {
        try {
          const events = await collect(
            svc.createBackend({ model: "haiku" }).runTurn(input({ tools: [recurse] })),
          );
          depths.push(stopReason(events));
          return { kind: "error", code: "synthetic", message: "nested done" };
        } catch (err) {
          depths.push(err instanceof Error ? err.message : String(err));
          return { kind: "error", code: "synthetic", message: "refused" };
        }
      },
    };
    await collect(svc.createBackend({ model: "sonnet" }).runTurn(input({ tools: [recurse] })));
    expect(depths.some((d) => /exceeds the limit 2/.test(d))).toBe(true);
  });

  it("runs inference turns as final-answer-only", async () => {
    const { service: svc } = service();
    const events = await collect(
      svc
        .createBackend({ model: "haiku", lane: "inference" })
        .runTurn(input({ userMessage: "Hi" })),
    );
    const text = events
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e.payload as { delta: string }).delta)
      .join("");
    expect(text).toBe("Echo: Hi");
  });
});
