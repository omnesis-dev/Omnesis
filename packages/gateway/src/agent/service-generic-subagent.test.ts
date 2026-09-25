// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Integration: spawn an ordinary generic worker through the real
 * `SubagentService` + `AgentService` end-to-end, asserting that the
 * host-owned prompt and fixed read-tool policy reach the child session.
 *
 * Behaviour/wiring is tested — NOT verbatim prompt strings (the operator
 * rejects tautological prompt-content change-detectors).
 */

import { describe, expect, it } from "vitest";

import {
  type ChatBackend,
  type DocumentPort,
  type SearchPort,
  type TurnInput,
} from "@omnesis/agent";
import { type AgentEvent, type CapabilityRole, type ToolResult, type WsEvent } from "@omnesis/core";

import { AgentService } from "./service.js";
import type {
  ConversationRecord,
  ConversationStore,
  ConversationSummary,
} from "./conversation-store.js";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

/** Records the system prompt + tool names the child session was handed. */
class RecordingChildBackend implements ChatBackend {
  readonly name = "child";
  readonly model = "child";
  sawSystemPrompt = "";
  sawTools: string[] = [];
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    this.sawSystemPrompt = input.systemPrompt;
    this.sawTools = input.tools.map((t) => t.name);
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "child-finding" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/** Holds the child open after its start event so a second caller can resume mid-join. */
class GatedChildBackend implements ChatBackend {
  readonly name = "gated-child";
  readonly model = "gated-child";
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  constructor(private readonly usageEventCount = 1) {}

  release(): void {
    this.releaseGate();
  }

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "child-progress" } };
    yield {
      type: "agent.thinking.delta",
      payload: { sessionId, messageId, delta: "private-child-reasoning" },
    };
    for (let i = 1; i <= this.usageEventCount; i++) {
      yield {
        type: "agent.usage.update",
        payload: { sessionId, messageId, usage: { outputTokens: i } },
      };
    }
    await this.gate;
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "late-finding" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/** Emits a large useful-progress stream and completes immediately. */
class BurstUsageChildBackend implements ChatBackend {
  readonly name = "burst-child";
  readonly model = "burst-child";

  constructor(private readonly usageEventCount: number) {}

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    for (let i = 1; i <= this.usageEventCount; i++) {
      yield {
        type: "agent.usage.update",
        payload: { sessionId, messageId, usage: { outputTokens: i } },
      };
    }
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "source summary" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/** Emits parent live-only state, then waits so a second client can resume. */
class GatedLiveStateBackend implements ChatBackend {
  readonly name = "live-state";
  readonly model = "live-state";
  private readonly gate = Promise.withResolvers<void>();

  release(): void {
    this.gate.resolve();
  }

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    yield {
      type: "agent.text.delta",
      payload: { sessionId, messageId, delta: "parent-transcript-text" },
    };
    yield {
      type: "agent.usage.update",
      payload: { sessionId, messageId, usage: { outputTokens: 12 } },
    };
    yield {
      type: "agent.tool.child.start",
      payload: {
        sessionId,
        messageId,
        toolCallId: "batch-1",
        childIndex: 0,
        tool: "search_documents",
        argsSummary: "independent source",
      },
    };
    yield {
      type: "agent.tool.child.result",
      payload: {
        sessionId,
        messageId,
        toolCallId: "batch-1",
        childIndex: 0,
        result: { kind: "error", code: "no_match", message: "No matching synthetic source" },
      },
    };
    yield {
      type: "agent.tool.start",
      payload: {
        sessionId,
        messageId,
        toolCallId: "plan-1",
        tool: "plan",
        args: { items: [{ id: "review", label: "Review independent source" }] },
      },
    };
    yield {
      type: "agent.tool.result",
      payload: {
        sessionId,
        messageId,
        toolCallId: "plan-1",
        result: {
          kind: "plan.updated",
          items: [{ id: "review", label: "Review independent source", status: "in_progress" }],
        },
        durationMs: 1,
      },
    };
    await this.gate.promise;
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: " complete" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/** Parent backend that invokes spawn_subagent once and captures the result. */
class SpawnInvokingBackend implements ChatBackend {
  readonly name = "parent";
  readonly model = "parent";
  lastResult: ToolResult | undefined;
  constructor(private readonly spawnArgs: { task: string; title?: string; specialist?: string }) {}
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    const spawn = input.tools.find((t) => t.name === "spawn_subagent");
    if (spawn) {
      this.lastResult = await spawn.invoke(this.spawnArgs, { sessionId, messageId });
    }
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/** Parent that remains busy until its generic child finishes. */
class SpawnAndJoinBackend implements ChatBackend {
  readonly name = "parent-join";
  readonly model = "parent-join";

  constructor(private readonly afterJoin?: Promise<void>) {}

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    yield {
      type: "agent.text.delta",
      payload: { sessionId, messageId, delta: "I am checking the independent branch. " },
    };
    const spawn = input.tools.find((tool) => tool.name === "spawn_subagent");
    const join = input.tools.find((tool) => tool.name === "join_subagents");
    if (spawn && join) {
      yield {
        type: "agent.tool.start",
        payload: {
          sessionId,
          messageId,
          toolCallId: "tc-spawn",
          tool: "spawn_subagent",
          args: { task: "inspect the independent evidence branch" },
        },
      };
      const handle = await spawn.invoke(
        { task: "inspect the independent evidence branch" },
        { sessionId, messageId },
      );
      yield {
        type: "agent.tool.result",
        payload: { sessionId, messageId, toolCallId: "tc-spawn", result: handle, durationMs: 1 },
      };
      const subagentId = handle.kind === "subagent.spawned" ? handle.subagentId : "";
      yield {
        type: "agent.tool.start",
        payload: {
          sessionId,
          messageId,
          toolCallId: "tc-join",
          tool: "join_subagents",
          args: { subagentIds: [subagentId] },
        },
      };
      const joined = await join.invoke({ subagentIds: [subagentId] }, { sessionId, messageId });
      yield {
        type: "agent.tool.result",
        payload: { sessionId, messageId, toolCallId: "tc-join", result: joined, durationMs: 1 },
      };
      await this.afterJoin;
    }
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "parent-answer" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

function makeService(spawnArgs: { task: string; title?: string; specialist?: string }) {
  const captured: WsEvent[] = [];
  const parent = new SpawnInvokingBackend(spawnArgs);
  const child = new RecordingChildBackend();
  let parentMade = false;
  const service = new AgentService({
    // Parent and sub-agents now share the "agent" role (Deep Research runs on
    // the agent model), so the role no longer distinguishes them. The service
    // builds the parent session's backend first and the spawned child next —
    // hand out the recording child only after the parent has been built.
    backendFactory: (_role: CapabilityRole) => {
      if (!parentMade) {
        parentMade = true;
        return parent;
      }
      return child;
    },
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "parent-prompt",
    broadcastEvent: (e) => captured.push(e),
    sessionIdGen: () => "S_parent",
    idleTimeoutMs: 60_000,
    subagents: {
      resolveSpecialist: () => {
        throw new Error("ordinary spawns must not resolve a specialist");
      },
      genericSystemPrompt: () => "HOST-GENERIC-PROMPT",
      depthCap: 2,
      concurrencyCap: 4,
    },
  });
  return { service, captured, parent, child };
}

describe("AgentService × generic sub-agent profile", () => {
  it("replays live-only parent state without duplicating transcript text", async () => {
    const captured: WsEvent[] = [];
    const backend = new GatedLiveStateBackend();
    const service = new AgentService({
      backendFactory: () => backend,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "parent-prompt",
      broadcastEvent: (event) => captured.push(event),
      sessionIdGen: () => "S_live_state",
      idleTimeoutMs: 60_000,
    });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "show live state");
    for (
      let i = 0;
      i < 30 &&
      !captured.some(
        (event) =>
          event.type === "agent.tool.result" &&
          (event.payload as { result?: { kind?: string } }).result?.kind === "plan.updated",
      );
      i++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const reopened = await service.createSession("device:B", { resumeFromId: sessionId });
    expect(reopened.replayEvents?.map((event) => event.type)).toEqual([
      "agent.usage.update",
      "agent.tool.child.start",
      "agent.tool.child.result",
      "agent.tool.result",
    ]);
    expect(JSON.stringify(reopened.replayEvents)).toContain("plan.updated");
    expect(JSON.stringify(reopened.replayEvents)).not.toContain("parent-transcript-text");
    expect(JSON.stringify(reopened.messages)).toContain("parent-transcript-text");

    backend.release();
    await settle();
    await service.dispose();
  });

  it("applies the host-owned generic prompt and fixed read-tool policy", async () => {
    const { service, captured, child } = makeService({
      task: "sweep the last quarter for the budget topic",
    });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "go");
    await settle();

    // The backend factory hands the recording child to the second backend it builds.
    expect(child.sawSystemPrompt).toBe("HOST-GENERIC-PROMPT");

    // Retrieval/evidence tools remain available; parent-only tools do not.
    expect(child.sawTools).toContain("search_many");
    expect(child.sawTools).toContain("fetch_many");
    expect(child.sawTools).not.toContain("cite_record");
    expect(child.sawTools).not.toContain("spawn_subagent");
    expect(child.sawTools).not.toContain("join_subagents");
    expect(child.sawTools).not.toContain("plan");

    // Ordinary workers retain an observable lifecycle. Clients use the stable
    // `generic` profile to keep these cards out of the Deep Research workspace.
    const spawned = captured.find((event) => event.type === "agent.subagent.spawned");
    expect((spawned?.payload as { specialist?: string }).specialist).toBe("generic");
  });

  it("does not expose specialist selection through the ordinary tool contract", async () => {
    const { service, captured, parent } = makeService({
      specialist: "no-such-specialist",
      task: "do something",
    });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "go");
    await settle();

    const kinds = captured.map((e) => e.type);
    expect(kinds).toContain("agent.subagent.spawned");
    expect((parent.lastResult as { specialist?: string }).specialist).toBe("generic");
  });

  it("replays an active generic worker to a second client opening during join", async () => {
    const captured: WsEvent[] = [];
    const parent = new SpawnAndJoinBackend();
    const child = new GatedChildBackend();
    let parentMade = false;
    const service = new AgentService({
      backendFactory: () => {
        if (!parentMade) {
          parentMade = true;
          return parent;
        }
        return child;
      },
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "parent-prompt",
      broadcastEvent: (event) => captured.push(event),
      sessionIdGen: () => "S_shared",
      idleTimeoutMs: 60_000,
      subagents: {
        resolveSpecialist: () => {
          throw new Error("ordinary spawns must not resolve a specialist");
        },
        genericSystemPrompt: () => "HOST-GENERIC-PROMPT",
        depthCap: 2,
        concurrencyCap: 4,
      },
    });
    const { sessionId } = await service.createSession("device:iOS");
    const turn = service.sendMessage("device:iOS", sessionId, "compare the branches");
    for (
      let i = 0;
      i < 30 &&
      !captured.some(
        (event) =>
          event.type === "agent.subagent.event" &&
          (event.payload as { event?: { type?: string } }).event?.type === "agent.usage.update",
      );
      i++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const reopened = await service.createSession("device:portal", { resumeFromId: sessionId });
    expect(reopened.busy).toBe(true);
    expect(JSON.stringify(reopened.messages)).toContain("I am checking the independent branch.");
    expect(JSON.stringify(reopened.messages)).toContain("spawn_subagent");
    expect(JSON.stringify(reopened.messages)).toContain("join_subagents");
    expect(reopened.replayEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.subagent.spawned",
          payload: expect.objectContaining({ specialist: "generic" }),
        }),
      ]),
    );
    const nestedReplayTypes = (reopened.replayEvents ?? [])
      .filter((event) => event.type === "agent.subagent.event")
      .map((event) => (event.payload as { event?: { type?: string } }).event?.type);
    expect(nestedReplayTypes).toContain("agent.usage.update");
    expect(nestedReplayTypes).not.toContain("agent.text.delta");
    expect(nestedReplayTypes).not.toContain("agent.thinking.delta");

    // Events emitted after the snapshot must still reach both clients live.
    const heardByIOS: WsEvent[] = [];
    const heardByPortal: WsEvent[] = [];
    service.subscribe("device:iOS", (_seq, event) => heardByIOS.push(event));
    service.subscribe("device:portal", (_seq, event) => heardByPortal.push(event));
    child.release();
    await turn.completion;
    await settle();
    expect(heardByIOS.some((event) => event.type === "agent.subagent.result")).toBe(true);
    expect(heardByPortal.some((event) => event.type === "agent.subagent.result")).toBe(true);

    const settled = await service.createSession("device:portal", { resumeFromId: sessionId });
    expect(settled.busy).toBe(false);
    expect(settled.replayEvents).toBeUndefined();
    await service.dispose();
  });

  it("bounds active replay while preserving worker anchors and recent progress", async () => {
    const captured: WsEvent[] = [];
    const releaseParent = Promise.withResolvers<void>();
    const parent = new SpawnAndJoinBackend(releaseParent.promise);
    const child = new BurstUsageChildBackend(300);
    let parentMade = false;
    const service = new AgentService({
      backendFactory: () => {
        if (!parentMade) {
          parentMade = true;
          return parent;
        }
        return child;
      },
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "parent-prompt",
      broadcastEvent: (event) => captured.push(event),
      sessionIdGen: () => "S_bounded",
      idleTimeoutMs: 60_000,
      subagents: {
        resolveSpecialist: () => {
          throw new Error("ordinary spawns must not resolve a specialist");
        },
        genericSystemPrompt: () => "HOST-GENERIC-PROMPT",
        depthCap: 2,
        concurrencyCap: 4,
      },
    });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "inspect progress");
    for (
      let i = 0;
      i < 100 &&
      !captured.some(
        (event) =>
          event.type === "agent.subagent.result" &&
          (event.payload as { subagentId?: string }).subagentId === "S_bounded.sub.1",
      );
      i++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const reopened = await service.createSession("device:B", { resumeFromId: sessionId });
    expect(reopened.replayEvents).toHaveLength(256);
    expect(reopened.replayEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.subagent.spawned",
          payload: expect.objectContaining({ specialist: "generic" }),
        }),
        expect.objectContaining({
          type: "agent.subagent.result",
          payload: expect.objectContaining({ subagentId: "S_bounded.sub.1" }),
        }),
      ]),
    );
    const replayUsage = (reopened.replayEvents ?? [])
      .filter((event) => event.type === "agent.subagent.event")
      .map(
        (event) =>
          (event.payload as { event?: { payload?: { usage?: { outputTokens?: number } } } }).event
            ?.payload?.usage?.outputTokens,
      );
    expect(replayUsage).toContain(300);
    expect(replayUsage).not.toContain(1);

    releaseParent.resolve();
    await settle();
    await service.dispose();
  });

  it("does not let an older persistence tail erase a newer turn's replay", async () => {
    const firstSaveStarted = Promise.withResolvers<void>();
    const releaseFirstSave = Promise.withResolvers<void>();
    const records = new Map<string, ConversationRecord>();
    let saveCount = 0;
    const store: ConversationStore = {
      async save(record) {
        saveCount++;
        if (saveCount === 1) {
          firstSaveStarted.resolve();
          await releaseFirstSave.promise;
        }
        records.set(record.id, record);
      },
      async load(id) {
        return records.get(id) ?? null;
      },
      async list(): Promise<ConversationSummary[]> {
        return [];
      },
      async delete(id) {
        return records.delete(id);
      },
      async setPinned() {
        return false;
      },
    };
    const captured: WsEvent[] = [];
    const parent = new SpawnAndJoinBackend();
    const firstChild = new RecordingChildBackend();
    const secondChild = new GatedChildBackend();
    let backendCount = 0;
    const service = new AgentService({
      backendFactory: () => {
        backendCount++;
        if (backendCount === 1) return parent;
        if (backendCount === 2) return firstChild;
        return secondChild;
      },
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "parent-prompt",
      broadcastEvent: (event) => captured.push(event),
      sessionIdGen: () => "S_overlap",
      idleTimeoutMs: 60_000,
      store,
      subagents: {
        resolveSpecialist: () => {
          throw new Error("ordinary spawns must not resolve a specialist");
        },
        genericSystemPrompt: () => "HOST-GENERIC-PROMPT",
        depthCap: 2,
        concurrencyCap: 4,
      },
    });
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "first turn");
    await firstSaveStarted.promise;

    service.sendMessage("device:B", sessionId, "second turn");
    for (
      let i = 0;
      i < 30 &&
      !captured.some(
        (event) =>
          event.type === "agent.subagent.spawned" &&
          (event.payload as { subagentId?: string }).subagentId === "S_overlap.sub.2",
      );
      i++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Let turn one's persistence and stale finally complete while turn two is
    // still blocked in join_subagents.
    releaseFirstSave.resolve();
    await settle();
    const reopened = await service.createSession("device:C", { resumeFromId: sessionId });
    expect(reopened.busy).toBe(true);
    expect(reopened.replayEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.subagent.spawned",
          payload: expect.objectContaining({ subagentId: "S_overlap.sub.2" }),
        }),
      ]),
    );

    secondChild.release();
    await settle();
    await service.dispose();
  });
});
