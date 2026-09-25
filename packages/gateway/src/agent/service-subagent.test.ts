// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import {
  ReplayBackend,
  type ChatBackend,
  type DocumentPort,
  type SearchPort,
  type TurnInput,
} from "@omnesis/agent";
import {
  BACKGROUND_RATE_LIMIT_PATIENCE,
  type AgentEvent,
  type CapabilityRole,
  type WsEvent,
} from "@omnesis/core";

import { AgentService } from "./service.js";
import { FsConversationStore } from "./conversation-store.js";
import type { ResolvedSpecialist } from "./subagent-service.js";

const tempDirs: string[] = [];

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

/**
 * A parent backend that, on its single turn, LAUNCHES a sub-agent via
 * `spawn_subagent`, awaits it via `join_subagents`, then echoes the child's
 * collected finding and ends. ReplayBackend doesn't invoke tools, so we need a
 * backend that actually calls them to exercise the spawn+join path end-to-end.
 */
class SpawnInvokingBackend implements ChatBackend {
  readonly name = "spawn-test";
  readonly model = "spawn-test";
  /** Records which tool names the parent saw — for assertions. */
  sawTools: string[] = [];
  /** The summary the join collected (for assertions). */
  joinedSummary: string | undefined;
  /** The rate-limit patience the parent's turn ran with. */
  sawRateLimitPatience: TurnInput["rateLimitPatience"];

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    this.sawTools = input.tools.map((t) => t.name);
    this.sawRateLimitPatience = input.rateLimitPatience;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };

    const spawn = input.tools.find((t) => t.name === "spawn_subagent");
    const join = input.tools.find((t) => t.name === "join_subagents");
    if (spawn && join) {
      const handle = await spawn.invoke({ task: "sweep last month" }, { sessionId, messageId });
      yield {
        type: "agent.tool.result",
        payload: { sessionId, messageId, toolCallId: "tc-spawn", result: handle, durationMs: 1 },
      };
      const subagentId = handle.kind === "subagent.spawned" ? handle.subagentId : "";
      const joined = await join.invoke({ subagentIds: [subagentId] }, { sessionId, messageId });
      if (joined.kind === "subagent.joined") {
        this.joinedSummary = joined.results[0]?.summary;
      }
      yield {
        type: "agent.tool.result",
        payload: { sessionId, messageId, toolCallId: "tc-join", result: joined, durationMs: 1 },
      };
    }

    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "synthesized" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/**
 * A child backend that records the tool names it was handed, then emits a
 * minimal finding. Lets a test assert the child's tool set directly.
 */
class RecordingChildBackend implements ChatBackend {
  readonly name = "child-test";
  readonly model = "child-test";
  sawTools: string[] = [];
  sawRateLimitPatience: TurnInput["rateLimitPatience"];
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    this.sawTools = input.tools.map((t) => t.name);
    this.sawRateLimitPatience = input.rateLimitPatience;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "child-finding" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

function childBackendFactory(): ChatBackend {
  const events: AgentEvent[] = [
    {
      type: "agent.message.start",
      payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
    },
    {
      type: "agent.thinking.delta",
      payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "hidden-child-reasoning" },
    },
    {
      type: "agent.tool.start",
      payload: {
        sessionId: "$SESSION",
        messageId: "$MSG",
        toolCallId: "child-tool",
        tool: "search_documents",
        args: { query: "synthetic planning" },
        extraContent: { encryptedThinking: "hidden-provider-metadata" },
        reasoningDetails: [{ type: "reasoning.encrypted", data: "hidden-structured-reasoning" }],
      },
    },
    {
      type: "agent.tool.result",
      payload: {
        sessionId: "$SESSION",
        messageId: "$MSG",
        toolCallId: "child-tool",
        result: { query: "synthetic planning", durationMs: 1, results: [] },
        durationMs: 1,
      },
    },
    {
      type: "agent.text.delta",
      payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "child-finding" },
    },
    {
      type: "agent.message.end",
      payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
    },
  ];
  return new ReplayBackend({
    fixtures: [{ entries: events.map((e) => ({ afterMs: 0, event: e })) }],
  });
}

const resolveSpecialist = (name: string): ResolvedSpecialist => ({
  name,
  systemPrompt: "sub-agent",
  modelRole: "subagent-fanout",
});

function makeService(makeChild: () => ChatBackend = childBackendFactory) {
  const captured: WsEvent[] = [];
  const parent = new SpawnInvokingBackend();
  let parentMade = false;
  const service = new AgentService({
    backendFactory: (_role: CapabilityRole) => {
      if (!parentMade) {
        parentMade = true;
        return parent;
      }
      return makeChild();
    },
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "test",
    broadcastEvent: (e) => captured.push(e),
    sessionIdGen: () => "S_parent",
    idleTimeoutMs: 60_000,
    subagents: {
      resolveSpecialist,
      genericSystemPrompt: () => "generic sub-agent prompt",
      depthCap: 2,
      concurrencyCap: 4,
    },
  });
  return { service, captured, parent };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

describe("AgentService sub-agent wiring (#748)", () => {
  afterEach(() => {
    while (tempDirs.length) {
      const d = tempDirs.pop()!;
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("exposes spawn_subagent to the parent and runs a child end-to-end", async () => {
    const { service, captured, parent } = makeService();
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "do deep research");
    await settle();

    // The parent agent's tool set includes both fan-out tools.
    expect(parent.sawTools).toContain("spawn_subagent");
    expect(parent.sawTools).toContain("join_subagents");

    // Generic workers retain the lifecycle stream; clients distinguish the
    // stable `generic` profile from Deep Research reader specialists.
    const kinds = captured.map((e) => e.type);
    expect(kinds).toContain("agent.subagent.spawned");
    expect(kinds).toContain("agent.subagent.event");
    expect(kinds).toContain("agent.subagent.result");

    const resultEvent = captured.find((e) => e.type === "agent.subagent.result");
    expect((resultEvent?.payload as { specialist?: string }).specialist).toBe("generic");
    expect((resultEvent?.payload as { summary?: string }).summary).toBe("child-finding");
    // The parent collected the child's finding via join_subagents.
    expect(parent.joinedSummary).toBe("child-finding");
  });

  it("runs an /answer tree with background rate-limit patience, and a chat turn without", async () => {
    const answerChild = new RecordingChildBackend();
    const answer = makeService(() => answerChild);
    await answer.service.generateReadOnlyAnswerCandidate("Run the synthetic sweep", []);

    expect(answer.parent.sawRateLimitPatience).toEqual(BACKGROUND_RATE_LIMIT_PATIENCE);
    expect(answerChild.sawRateLimitPatience).toEqual(BACKGROUND_RATE_LIMIT_PATIENCE);

    const chatChild = new RecordingChildBackend();
    const chat = makeService(() => chatChild);
    const { sessionId } = await chat.service.createSession("device:A");
    chat.service.sendMessage("device:A", sessionId, "do deep research");
    await settle();

    expect(chat.parent.joinedSummary).toBe("child-finding");
    expect(chat.parent.sawRateLimitPatience).toBeUndefined();
    expect(chatChild.sawRateLimitPatience).toBeUndefined();
  });

  it("captures /answer child activity without broadcasting it as an ordinary Agent turn", async () => {
    const { service, captured, parent } = makeService();

    const result = await service.generateReadOnlyAnswerCandidate("Run the synthetic sweep", []);

    expect(result.answer).toBe("synthesized");
    expect(parent.sawTools).toContain("spawn_subagent");
    expect(captured.map((event) => event.type)).not.toContain("agent.subagent.spawned");
    expect(captured.map((event) => event.type)).not.toContain("agent.subagent.event");
    expect(captured.map((event) => event.type)).not.toContain("agent.subagent.result");
    const trace = JSON.stringify(result.trace?.subagentEvents);
    expect(trace).toContain("agent.subagent.spawned");
    expect(trace).toContain("child-finding");
    expect(trace).not.toContain("hidden-child-reasoning");
    expect(trace).not.toContain("hidden-provider-metadata");
    expect(trace).not.toContain("extraContent");
    expect(trace).not.toContain("hidden-structured-reasoning");
    expect(trace).not.toContain("reasoningDetails");
    await service.dispose();
  });

  it("does NOT grant write tools to the child sub-agent by default", async () => {
    // The watch tools are experimental-gated, like every other automation
    // surface — turn the gate on so the parent actually receives them.
    const previousExperimental = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
    onTestFinished(() => {
      if (previousExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previousExperimental;
    });
    const captured: WsEvent[] = [];
    const parent = new SpawnInvokingBackend();
    const child = new RecordingChildBackend();
    let parentMade = false;
    const service = new AgentService({
      backendFactory: (_role: CapabilityRole) => {
        if (!parentMade) {
          parentMade = true;
          return parent;
        }
        return child;
      },
      ports: {
        search: stubSearch,
        document: stubDocument,
        // A watch port adds write tools (watch_create/watch_update) to the
        // PARENT set; the child must not inherit them.
        watch: {
          create: async () => {
            throw new Error("unused");
          },
          update: async () => {
            throw new Error("unused");
          },
        },
      },
      systemPrompt: "test",
      broadcastEvent: (e) => captured.push(e),
      sessionIdGen: () => "S_parent",
      idleTimeoutMs: 60_000,
      subagents: {
        resolveSpecialist,
        genericSystemPrompt: () => "generic sub-agent prompt",
        depthCap: 2,
        concurrencyCap: 4,
      },
    });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "go");
    await settle();

    // Parent saw the write tools…
    expect(parent.sawTools).toContain("watch_create");
    expect(parent.sawTools).toContain("watch_update");
    // …but the child's tool set has the write tools stripped.
    expect(child.sawTools).not.toContain("watch_create");
    expect(child.sawTools).not.toContain("watch_update");
    expect(child.sawTools).not.toContain("cite_record");
    // Read tools are still present.
    expect(child.sawTools).toContain("search_many");
    expect(child.sawTools).toContain("fetch_many");
    expect(child.sawTools).toContain("annotate_many");
    // Generic fan-out is one level deep and presentation stays parent-owned.
    expect(child.sawTools).not.toContain("spawn_subagent");
    expect(child.sawTools).not.toContain("join_subagents");
    expect(child.sawTools).not.toContain("plan");
  });

  it("recursively evicts a live child when the parent is deleted", async () => {
    // A child whose turn hangs until cancelled, so we can observe the parent's
    // eviction cancelling it.
    let childCanceled = false;
    class HangingChildBackend implements ChatBackend {
      readonly name = "hang";
      readonly model = "hang";
      async *runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
        const { sessionId, messageId } = input;
        yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            childCanceled = true;
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => {
            childCanceled = true;
            resolve();
          });
        });
        yield {
          type: "agent.message.end",
          payload: { sessionId, messageId, stopReason: "canceled" },
        };
      }
    }

    // The parent spawns the child but does NOT await it (fire-and-forget), so
    // the child stays live while we evict the parent. A backend that kicks off
    // the spawn without blocking on completion.
    class FireAndForgetParent implements ChatBackend {
      readonly name = "faf";
      readonly model = "faf";
      async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
        const { sessionId, messageId } = input;
        yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
        const spawn = input.tools.find((t) => t.name === "spawn_subagent");
        if (spawn) {
          // Don't await — let the child hang in the background.
          void spawn.invoke({ task: "hang" }, { sessionId, messageId });
          // Give the child a tick to register before the parent ends.
          await new Promise((r) => setImmediate(r));
        }
        yield {
          type: "agent.message.end",
          payload: { sessionId, messageId, stopReason: "end_turn" },
        };
      }
    }

    const child = new HangingChildBackend();
    const parent = new FireAndForgetParent();
    let parentMade = false;
    let markTurnComplete!: () => void;
    const turnComplete = new Promise<void>((resolve) => {
      markTurnComplete = resolve;
    });
    const dir = mkdtempSync(join(tmpdir(), "omnesis-subagent-evict-"));
    tempDirs.push(dir);
    const service = new AgentService({
      backendFactory: (_role: CapabilityRole) => {
        if (!parentMade) {
          parentMade = true;
          return parent;
        }
        return child;
      },
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_parent",
      idleTimeoutMs: 60_000,
      store: new FsConversationStore(dir),
      onTurnComplete: markTurnComplete,
      subagents: {
        resolveSpecialist,
        genericSystemPrompt: () => "generic sub-agent prompt",
        depthCap: 2,
        concurrencyCap: 4,
      },
    });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "go");
    await turnComplete;
    await new Promise((resolve) => setImmediate(resolve));
    expect(childCanceled).toBe(false); // child is hanging

    await service.deleteConversation(sessionId); // evicts parent → recursive child eviction
    await settle();
    expect(childCanceled).toBe(true);
  });

  it("omits spawn_subagent when no subagents config is provided", async () => {
    const captured: WsEvent[] = [];
    const parent = new SpawnInvokingBackend();
    const service = new AgentService({
      backendFactory: () => parent,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      broadcastEvent: (e) => captured.push(e),
      sessionIdGen: () => "S_parent",
      idleTimeoutMs: 60_000,
    });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "go");
    await settle();
    expect(parent.sawTools).not.toContain("spawn_subagent");
    expect(captured.map((e) => e.type)).not.toContain("agent.subagent.spawned");
  });
});
