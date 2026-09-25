// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type AgentEvent, type WsEvent } from "@omnesis/core";
import {
  ReplayBackend,
  type ChatBackend,
  type ChatMessage,
  type DocumentPort,
  type SearchPort,
  type TemporalReadPort,
} from "@omnesis/agent";

import {
  AgentError,
  AgentService,
  paginateConversations,
  paginateVisibleConversationMessages,
} from "./service.js";
import {
  FsConversationStore,
  type ConversationRecord,
  type ConversationStore,
} from "./conversation-store.js";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

function makeServiceWithFixture(events: AgentEvent[]) {
  const captured: WsEvent[] = [];
  const service = new AgentService({
    backendFactory: () =>
      new ReplayBackend({
        fixtures: [{ entries: events.map((e) => ({ afterMs: 0, event: e })) }],
      }),
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "test",
    broadcastEvent: (event) => captured.push(event),
    sessionIdGen: () => "S_test",
    idleTimeoutMs: 60_000,
  });
  return { service, captured };
}

function emptyAgentStream(): AsyncIterable<AgentEvent> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<AgentEvent>> {
          return Promise.resolve({ done: true, value: undefined as never });
        },
      };
    },
  };
}

const callerA = "device:A";
const callerB = "device:B";

const tempDirs: string[] = [];

describe("paginateConversations", () => {
  it("skips deleted ids in an existing cursor snapshot without skipping survivors", () => {
    const summaries = ["a", "b", "c"].map((id, index) => ({
      id,
      title: `Invented conversation ${id}`,
      model: "replay",
      backend: "replay",
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      updatedAt: `2026-01-01T00:00:0${index}.000Z`,
      messageCount: 2,
      pinned: false,
    }));
    const snapshots = new Map();
    const first = paginateConversations(summaries, { limit: 1 }, snapshots);
    expect(first.conversations.map((summary) => summary.id)).toEqual(["a"]);

    const second = paginateConversations(
      summaries,
      { limit: 1, cursor: first.nextCursor! },
      snapshots,
      new Set(["b"]),
    );
    expect(second.conversations.map((summary) => summary.id)).toEqual(["c"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("paginateVisibleConversationMessages", () => {
  it("removes an anchored seed and pages backward on complete turn boundaries", () => {
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "internal seed prompt" }] },
      { role: "assistant", parts: [{ kind: "text", text: "internal seed answer" }] },
      { role: "user", parts: [{ kind: "text", text: "first visible question" }] },
      {
        role: "assistant",
        parts: [{ kind: "tool_use", toolCallId: "call_1", tool: "search", args: {} }],
      },
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "call_1",
            result: { kind: "text", text: "synthetic result" },
          },
        ],
      },
      { role: "assistant", parts: [{ kind: "text", text: "first visible answer" }] },
      { role: "user", parts: [{ kind: "text", text: "second visible question" }] },
      { role: "assistant", parts: [{ kind: "text", text: "second visible answer" }] },
    ];

    const latest = paginateVisibleConversationMessages(
      messages,
      { kind: "brief", briefId: "brief_1", runId: "run_1", seedMessageCount: 2 },
      2,
    );
    expect(latest.messages).toEqual(messages.slice(6));
    expect(latest).toMatchObject({ messageCount: 6, hasMore: true, nextBefore: 4 });

    const older = paginateVisibleConversationMessages(
      messages,
      { kind: "brief", briefId: "brief_1", runId: "run_1", seedMessageCount: 2 },
      2,
      latest.nextBefore!,
    );
    // The tool-use + tool-result exchange stays attached to its opening user
    // message even though that makes the page larger than the requested hint.
    expect(older.messages).toEqual(messages.slice(2, 6));
    expect(older).toMatchObject({ messageCount: 6, hasMore: false, nextBefore: null });
  });

  it("returns the transcript's shape and none of it at limit zero", () => {
    // Keeping turns intact means the smallest non-empty page is a whole
    // turn — tool results and all. A caller that wants the shape and not
    // the content (the voice ask resuming its thread) asks for zero and
    // gets a cursor it could still page back through.
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "question" }] },
      {
        role: "assistant",
        parts: [{ kind: "tool_use", toolCallId: "call_1", tool: "search", args: {} }],
      },
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "call_1",
            result: { kind: "text", text: "a very large synthetic result" },
          },
        ],
      },
      { role: "assistant", parts: [{ kind: "text", text: "answer" }] },
    ];

    const empty = paginateVisibleConversationMessages(messages, undefined, 0);
    expect(empty.messages).toEqual([]);
    expect(empty).toMatchObject({ messageCount: 4, hasMore: true, nextBefore: 4 });

    // For contrast: one message is not a smaller ask — the turn boundary
    // pulls the whole turn back in, which is the payload zero avoids.
    const one = paginateVisibleConversationMessages(messages, undefined, 1);
    expect(one.messages).toEqual(messages);

    // The cursor it hands back is a real position, not a dead end: paging
    // from it recovers the transcript whole, with no gap and nothing twice.
    const resumed = paginateVisibleConversationMessages(messages, undefined, 10, empty.nextBefore!);
    expect(resumed.messages).toEqual(messages);
    expect(resumed).toMatchObject({ hasMore: false, nextBefore: null });
  });

  it("reports an empty transcript as finished, not as more to come", () => {
    const page = paginateVisibleConversationMessages([], undefined, 0);
    expect(page).toMatchObject({ messages: [], messageCount: 0, hasMore: false, nextBefore: null });
  });

  it("counts visible messages, not seeded ones, at limit zero", () => {
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ kind: "text", text: "internal seed prompt" }] },
      { role: "assistant", parts: [{ kind: "text", text: "internal seed answer" }] },
      { role: "user", parts: [{ kind: "text", text: "question" }] },
      { role: "assistant", parts: [{ kind: "text", text: "answer" }] },
    ];
    const page = paginateVisibleConversationMessages(
      messages,
      { kind: "brief", briefId: "brief_1", runId: "run_1", seedMessageCount: 2 },
      0,
    );
    expect(page).toMatchObject({ messages: [], messageCount: 2, hasMore: true, nextBefore: 2 });
  });
});

describe("AgentService", () => {
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

  it("creates a session bound to a device and reports backend/model", async () => {
    const { service } = makeServiceWithFixture([]);
    const r = await service.createSession(callerA);
    expect(r.sessionId).toBe("S_test");
    expect(r.backend).toBe("replay");
    expect(r.model).toBe("replay");
    expect(r.messageCount).toBe(0);
    // A freshly created session has no turn in flight.
    expect(r.busy).toBe(false);
    expect(service.sessionCount()).toBe(1);
  });

  it("broadcasts agent events with sessionId for client-side filtering", async () => {
    const events: AgentEvent[] = [
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "ok" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ];
    const { service, captured } = makeServiceWithFixture(events);
    const { sessionId } = await service.createSession(callerA);
    const { messageId } = service.sendMessage(callerA, sessionId, "hi");

    // Wait for the in-flight turn to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(messageId).toBeDefined();
    expect(captured.map((c) => c.type)).toContain("agent.message.start");
    expect(captured.map((c) => c.type)).toContain("agent.message.end");
  });

  it("persists a synchronous cancel-terminal follow-up after the canceled snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-svc-cancel-save-order-"));
    tempDirs.push(dir);
    const base = new FsConversationStore(dir);
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let markFirstSave!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      markFirstSave = resolve;
    });
    let saveCalls = 0;
    const store: ConversationStore = {
      save: async (record) => {
        saveCalls += 1;
        if (saveCalls === 1) {
          markFirstSave();
          await firstSaveGate;
        }
        await base.save(record);
      },
      load: (id) => base.load(id),
      list: () => base.list(),
      delete: (id) => base.delete(id),
      setPinned: (id, pinned) => base.setPinned(id, pinned),
    };
    let releaseAnswer!: () => void;
    const answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    let calls = 0;
    const backend: ChatBackend = {
      name: "cancel-follow-up",
      model: "cancel-follow-up",
      async *runTurn(input, signal) {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
          return;
        }
        await answerGate;
        yield {
          type: "agent.text.delta",
          payload: { sessionId: input.sessionId, messageId: input.messageId, delta: "new answer" },
        };
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "end_turn",
          },
        };
      },
    };
    let followUp: ReturnType<AgentService["sendMessage"]> | undefined;
    let followUpEnded = false;
    const service = new AgentService({
      backendFactory: () => backend,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      sessionIdGen: () => "S_cancel_save_order",
      idleTimeoutMs: 60_000,
      broadcastEvent: (event) => {
        if (event.type === "agent.message.end" && event.payload.stopReason === "canceled") {
          followUp = service.sendMessage(callerA, "S_cancel_save_order", "follow up");
        }
        if (
          event.type === "agent.message.end" &&
          followUp !== undefined &&
          event.payload.messageId === followUp.messageId
        ) {
          followUpEnded = true;
        }
      },
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "cancel me");
    service.cancelSession(callerA, sessionId);
    await firstSaveStarted;
    expect(followUp).toBeDefined();

    releaseAnswer();
    await waitUntil(
      () => followUpEnded,
      "the newer follow-up snapshot to queue behind the delayed canceled snapshot",
    );
    expect(saveCalls).toBe(1);
    releaseFirstSave();
    await waitUntil(
      conversationIdle(service, sessionId),
      "both ordered transcript saves to settle",
    );

    expect(saveCalls).toBe(2);
    const persisted = await base.load(sessionId);
    expect(persisted?.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(persisted?.messages.at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ kind: "text", text: "new answer" }],
    });
  });

  it("durably freezes a context-exhausted conversation before another send can start", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    let backendRuns = 0;
    const backendFactory = (): ChatBackend => ({
      name: "openai-compatible",
      model: "fictional-model",
      async *runTurn(input) {
        backendRuns += 1;
        yield {
          type: "agent.message.start",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            role: "assistant",
          },
        };
        yield {
          type: "agent.text.delta",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            delta: "Partial answer",
          },
        };
        yield {
          type: "agent.error",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            code: "context_window_exceeded",
            message: "unsafe provider detail",
          },
        };
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "error",
            context: {
              inputTokens: 130_000,
              contextWindowTokens: 128_000,
              measurement: "provider_reported",
              limitSource: "provider",
              requestIteration: 1,
            },
          },
        };
      },
    });
    let resolveTurn!: () => void;
    const turnComplete = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const first = new AgentService({
      backendFactory,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      sessionIdGen: () => "S_context",
      idleTimeoutMs: 60_000,
      onTurnComplete: () => resolveTurn(),
    });
    const created = await first.createSession(callerA);
    first.sendMessage(callerA, created.sessionId, "continue the analysis");
    await turnComplete;

    const stored = await store.load(created.sessionId);
    expect(stored?.terminalFailure).toMatchObject({
      code: "context_window_exceeded",
      retryable: false,
      backend: "openai-compatible",
      model: "fictional-model",
      context: {
        inputTokens: 130_000,
        contextWindowTokens: 128_000,
        measurement: "provider_reported",
      },
    });
    expect(stored?.messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "continue the analysis" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Partial answer" }] },
    ]);

    const liveResume = await first.createSession(callerB, {
      resumeFromId: created.sessionId,
    });
    expect(liveResume.terminalFailure?.code).toBe("context_window_exceeded");
    expect(() =>
      first.sendMessage(callerB, created.sessionId, "try deep research", {
        deepResearch: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "AgentError",
        code: "context_window_exceeded",
      }),
    );
    expect(backendRuns).toBe(1);
    await first.dispose();

    const cold = new AgentService({
      backendFactory,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      sessionIdGen: () => "unused",
      idleTimeoutMs: 60_000,
    });
    const coldResume = await cold.createSession(callerA, {
      resumeFromId: created.sessionId,
    });
    expect(coldResume.terminalFailure).toEqual(stored?.terminalFailure);
    expect(coldResume.messages).toEqual(stored?.messages);
    expect(() => cold.sendMessage(callerA, created.sessionId, "one more question")).toThrowError(
      expect.objectContaining({
        name: "AgentError",
        code: "context_window_exceeded",
      }),
    );
    expect(backendRuns).toBe(1);
    await cold.dispose();
  });

  it("persists output truncation for cross-device resume and clears it after the next answer", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    let backendRuns = 0;
    const backendFactory = (): ChatBackend => ({
      name: "openai-compatible",
      model: "fictional-model",
      async *runTurn(input) {
        backendRuns += 1;
        yield {
          type: "agent.message.start",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            role: "assistant",
          },
        };
        yield {
          type: "agent.text.delta",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            delta: backendRuns === 1 ? "Partial answer" : "Complete answer",
          },
        };
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: backendRuns === 1 ? "max_tokens" : "end_turn",
            ...(backendRuns === 1
              ? {
                  failure: {
                    code: "output_truncated",
                    message: "The model reached its output limit before completing this response.",
                    retryable: false,
                    backend: "openai-compatible",
                    model: "fictional-model",
                  },
                }
              : {}),
          },
        };
      },
    });
    let resolveFirstTurn!: () => void;
    const firstTurn = new Promise<void>((resolve) => {
      resolveFirstTurn = resolve;
    });
    const first = new AgentService({
      backendFactory,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      sessionIdGen: () => "S_truncated",
      idleTimeoutMs: 60_000,
      onTurnComplete: resolveFirstTurn,
    });
    const created = await first.createSession(callerA);
    first.sendMessage(callerA, created.sessionId, "explain the constraints");
    await firstTurn;

    const stored = await store.load(created.sessionId);
    expect(stored?.lastTurnFailure?.code).toBe("output_truncated");
    expect(stored?.messages.at(-1)).toEqual({
      role: "assistant",
      parts: [{ kind: "text", text: "Partial answer" }],
    });
    const crossDevice = await first.createSession(callerB, { resumeFromId: created.sessionId });
    expect(crossDevice.lastTurnFailure).toEqual(stored?.lastTurnFailure);
    expect(crossDevice.terminalFailure).toBeUndefined();
    await first.dispose();

    let resolveSecondTurn!: () => void;
    const secondTurn = new Promise<void>((resolve) => {
      resolveSecondTurn = resolve;
    });
    const cold = new AgentService({
      backendFactory,
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      sessionIdGen: () => "unused",
      idleTimeoutMs: 60_000,
      onTurnComplete: resolveSecondTurn,
    });
    const coldResume = await cold.createSession(callerA, { resumeFromId: created.sessionId });
    expect(coldResume.lastTurnFailure).toEqual(stored?.lastTurnFailure);
    cold.sendMessage(callerA, created.sessionId, "finish the answer");
    await secondTurn;
    expect((await store.load(created.sessionId))?.lastTurnFailure).toBeUndefined();
    expect(
      (await cold.createSession(callerB, { resumeFromId: created.sessionId })).lastTurnFailure,
    ).toBeUndefined();
    await cold.dispose();
  });

  it("any admin caller can send on any session — conversations are shared", async () => {
    // Conversations are shared across admin callers. Sending from caller
    // B into a session created by caller A no longer requires resuming
    // first; the entry's owner is updated on send so per-caller cap
    // accounting tracks the latest driver. This is the multi-device
    // contract — iOS and portal can both drive the same conversation.
    const { service } = makeServiceWithFixture([]);
    const { sessionId } = await service.createSession(callerA);
    expect(() => service.sendMessage(callerB, sessionId, "hi")).not.toThrow();
    expect(readCallerId(service, sessionId)).toBe(callerB);
  });

  it("caller B can resume a live session originally created by caller A", async () => {
    const { service } = makeServiceWithFixture([]);
    const created = await service.createSession(callerA);
    const resumed = await service.createSession(callerB, { resumeFromId: created.sessionId });
    expect(resumed.sessionId).toBe(created.sessionId);
    // After resume, ownership has transferred to caller B for cap
    // accounting.
    expect(readCallerId(service, created.sessionId)).toBe(callerB);
    expect(() => service.sendMessage(callerB, created.sessionId, "hi")).not.toThrow();
  });

  it("agent events fan out to every admin SSE listener for cross-device sync", async () => {
    // The multi-device contract: when portal and iOS both have the same
    // conversation open, every event reaches both. Each listener filters
    // by sessionId on the client side. Single-owner routing previously
    // left whichever device didn't most-recently resume the session
    // silent — that's the bug this assertion locks down.
    const events: AgentEvent[] = [
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "hi" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ];
    const { service } = makeServiceWithFixture(events);
    const created = await service.createSession(callerA);
    // Caller B resumes (taking over ownership for cap purposes).
    await service.createSession(callerB, { resumeFromId: created.sessionId });

    const heardByA: AgentEvent[] = [];
    const heardByB: AgentEvent[] = [];
    service.subscribe(callerA, (_seq, e) => heardByA.push(e as AgentEvent));
    service.subscribe(callerB, (_seq, e) => heardByB.push(e as AgentEvent));

    service.sendMessage(callerB, created.sessionId, "hi");
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    // Both listeners must see the streaming events — that's how iOS and
    // portal stay live on the same conversation simultaneously.
    expect(heardByA.map((e) => e.type)).toContain("agent.text.delta");
    expect(heardByB.map((e) => e.type)).toContain("agent.text.delta");
  });

  describe("SSE resume (seq + replay buffer)", () => {
    const turn: AgentEvent[] = [
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "a" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "b" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ];

    const settle = async () => {
      for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    };

    it("stamps monotonically increasing seq ids starting at 1", async () => {
      const { service } = makeServiceWithFixture(turn);
      const created = await service.createSession(callerA);
      const live: number[] = [];
      service.subscribe(callerA, (seq) => live.push(seq));
      service.sendMessage(callerA, created.sessionId, "hi");
      await settle();
      expect(live.length).toBeGreaterThanOrEqual(2);
      expect(live[0]).toBe(1);
      // strictly increasing
      for (let i = 1; i < live.length; i++) expect(live[i]).toBe(live[i - 1] + 1);
    });

    it("replays exactly the events past Last-Event-ID to a reconnecting subscriber", async () => {
      const { service } = makeServiceWithFixture(turn);
      const created = await service.createSession(callerA);
      const live: Array<{ seq: number; type: string }> = [];
      service.subscribe(callerA, (seq, e) => live.push({ seq, type: e.type }));
      service.sendMessage(callerA, created.sessionId, "hi");
      await settle();
      // Pretend the client got through the 2nd event, then dropped.
      const cut = live[1].seq;
      const replayed: Array<{ seq: number; type: string }> = [];
      service.subscribe(callerA, (seq, e) => replayed.push({ seq, type: e.type }), cut);
      expect(replayed).toEqual(live.filter((x) => x.seq > cut));
    });

    it("delivers nothing when Last-Event-ID is exactly current", async () => {
      const { service } = makeServiceWithFixture(turn);
      const created = await service.createSession(callerA);
      const live: number[] = [];
      service.subscribe(callerA, (seq) => live.push(seq));
      service.sendMessage(callerA, created.sessionId, "hi");
      await settle();
      const newest = live[live.length - 1];
      const atCurrent: unknown[] = [];
      service.subscribe(callerA, (seq, e) => atCurrent.push([seq, e.type]), newest);
      expect(atCurrent).toEqual([]);
    });

    it("emits agent.resync when Last-Event-ID is ahead of our sequence (post-restart reset)", async () => {
      // The after-restart case: nextSeq reset to 1 while the client kept a
      // large stale `Last-Event-ID`. The cursor is ahead of anything we've
      // assigned, so nothing is replayable — the client is told to reload the
      // persisted transcript instead of being left silently stuck on a turn
      // it thinks is still running.
      const { service } = makeServiceWithFixture(turn);
      const created = await service.createSession(callerA);
      const live: number[] = [];
      service.subscribe(callerA, (seq) => live.push(seq));
      service.sendMessage(callerA, created.sessionId, "hi");
      await settle();
      const staleHigh: Array<{ seq: number; type: string }> = [];
      service.subscribe(callerA, (seq, e) => staleHigh.push({ seq, type: e.type }), 999_999);
      expect(staleHigh).toEqual([{ seq: 0, type: "agent.resync" }]);
    });

    it("replays (not resync) at the exact oldest-buffered boundary", async () => {
      // Boundary the gap check hinges on: with a 2-event buffer only the last
      // two events (oldest = newest-1) survive. A client that saw through
      // newest-2 needs exactly the oldest buffered event, so it must replay —
      // resync fires only when oldest > sinceSeq + 1.
      const service = new AgentService({
        backendFactory: () =>
          new ReplayBackend({
            fixtures: [{ entries: turn.map((e) => ({ afterMs: 0, event: e })) }],
          }),
        ports: { search: stubSearch, document: stubDocument },
        systemPrompt: "test",
        sessionIdGen: () => "S_boundary",
        idleTimeoutMs: 60_000,
        maxBufferedEvents: 2,
      });
      const created = await service.createSession(callerA);
      const live: number[] = [];
      service.subscribe(callerA, (seq) => live.push(seq));
      service.sendMessage(callerA, created.sessionId, "hi");
      await settle();
      const newest = live[live.length - 1];
      // sinceSeq = newest-2 ⇒ the client needs newest-1, which is exactly the
      // oldest still-buffered event: the inclusive edge of the replay window.
      const got: Array<{ seq: number; type: string }> = [];
      service.subscribe(callerA, (seq, e) => got.push({ seq, type: e.type }), newest - 2);
      expect(got.map((x) => x.seq)).toEqual([newest - 1, newest]);
      expect(got.some((x) => x.type === "agent.resync")).toBe(false);
    });

    it("emits agent.resync (seq 0) when the gap predates the bounded buffer", async () => {
      // Buffer holds only the last 2 events; a client that missed earlier
      // ones can't be caught up incrementally and is told to reconcile.
      const service = new AgentService({
        backendFactory: () =>
          new ReplayBackend({
            fixtures: [{ entries: turn.map((e) => ({ afterMs: 0, event: e })) }],
          }),
        ports: { search: stubSearch, document: stubDocument },
        systemPrompt: "test",
        sessionIdGen: () => "S_gap",
        idleTimeoutMs: 60_000,
        maxBufferedEvents: 2,
      });
      const created = await service.createSession(callerA);
      service.sendMessage(callerA, created.sessionId, "hi");
      await settle();
      const got: Array<{ seq: number; type: string }> = [];
      service.subscribe(callerA, (seq, e) => got.push({ seq, type: e.type }), 1);
      expect(got).toEqual([{ seq: 0, type: "agent.resync" }]);
    });
  });

  it("lists a live, not-yet-persisted session so a new conversation is resumable immediately", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    // A gated backend whose turn doesn't complete until we release it →
    // the session stays live and unpersisted, reproducing the
    // mid-first-turn window before the turn-end flush.
    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((res) => {
      releaseTurn = res;
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "gated",
        model: "gated",
        runTurn() {
          return (async function* () {
            // Hold the turn open until released; then end it. The throw (vs a
            // clean message.end) is just a terminal signal — the user message
            // is already in history and persistConversation runs from the
            // sendMessage `.finally` regardless, so the conversation flushes.
            await turnGate;
            throw new Error("gated turn released");

            yield undefined as never; // unreachable; satisfies require-yield
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      sessionIdGen: () => "S_live",
      idleTimeoutMs: 60_000,
    });
    const { sessionId } = await service.createSession(callerA);
    // A freshly-created session with no messages isn't listed yet.
    expect(await service.listConversations()).toHaveLength(0);

    service.sendMessage(callerA, sessionId, "draft a short poem about the sea");
    await new Promise((r) => setImmediate(r)); // let send() record the user turn

    // Mid-first-turn (nothing flushed to disk), the conversation is listed.
    const live = await service.listConversations();
    const entry = live.find((c) => c.id === sessionId);
    expect(entry).toBeDefined();
    expect(entry!.messageCount).toBeGreaterThanOrEqual(1);
    expect(entry!.title.length).toBeGreaterThan(0);

    // Once the turn completes and flushes, it's listed exactly once (from
    // disk, not duplicated by the live overlay).
    releaseTurn();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    const after = await service.listConversations();
    expect(after.filter((c) => c.id === sessionId)).toHaveLength(1);
    service.dispose();
  });

  it("paginates merged stored and live conversation summaries newest-first", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    await store.save({
      id: "S_old",
      callerId: callerA,
      model: "stored",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "older stored",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "older stored" }] }],
    });
    await store.save({
      id: "S_new",
      callerId: callerA,
      model: "stored",
      backend: "replay",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      title: "newer stored",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "newer stored" }] }],
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "live",
        model: "live",
        runTurn() {
          return (async function* () {
            await new Promise(() => undefined);
            yield undefined as never;
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      sessionIdGen: () => "S_live",
      idleTimeoutMs: 60_000,
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "live draft");
    await new Promise((r) => setImmediate(r));

    const first = await service.listConversationPage({ limit: 2 });
    expect(first.conversations.map((c) => c.id)).toEqual(["S_live", "S_new"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.listConversationPage({ limit: 2, cursor: first.nextCursor! });
    expect(second.conversations.map((c) => c.id)).toEqual(["S_old"]);
    expect(second.nextCursor).toBeNull();
    service.dispose();
  });

  it("does not reorder a stored conversation when it is only resumed", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    await store.save({
      id: "S_old",
      callerId: callerA,
      model: "stored",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "older stored",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "older stored" }] }],
    });
    await store.save({
      id: "S_new",
      callerId: callerA,
      model: "stored",
      backend: "replay",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      title: "newer stored",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "newer stored" }] }],
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "live",
        model: "live",
        runTurn() {
          return (async function* () {
            yield undefined as never;
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      idleTimeoutMs: 60_000,
    });

    await service.createSession(callerA, { resumeFromId: "S_old" });

    const summaries = await service.listConversations();
    expect(summaries.map((c) => c.id)).toEqual(["S_new", "S_old"]);
    service.dispose();
  });

  it("does not skip a conversation that moves above the cursor between pages", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    await store.save({
      id: "S_old",
      callerId: callerA,
      model: "stored",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "older stored",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "older stored" }] }],
    });
    await store.save({
      id: "S_new",
      callerId: callerA,
      model: "stored",
      backend: "replay",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      title: "newer stored",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "newer stored" }] }],
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "live",
        model: "live",
        runTurn() {
          return (async function* () {
            yield undefined as never;
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      idleTimeoutMs: 60_000,
    });

    const first = await service.listConversationPage({ limit: 1 });
    expect(first.conversations.map((c) => c.id)).toEqual(["S_new"]);
    await store.save({
      id: "S_old",
      callerId: callerA,
      model: "stored",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      title: "older stored, updated",
      pinned: false,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "older stored" }] },
        { role: "assistant", parts: [{ kind: "text", text: "updated" }] },
      ],
    });

    const second = await service.listConversationPage({ limit: 1, cursor: first.nextCursor! });
    expect(second.conversations.map((c) => c.id)).toEqual(["S_old"]);
    service.dispose();
  });

  it("keeps conversation pagination cursors bounded across many pages", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    for (let i = 0; i < 125; i++) {
      const stamp = String(i + 1).padStart(3, "0");
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      await store.save({
        id: `S_${stamp}`,
        callerId: callerA,
        model: "stored",
        backend: "replay",
        createdAt: timestamp,
        updatedAt: timestamp,
        title: `stored conversation ${stamp}`,
        pinned: false,
        messages: [
          { role: "user", parts: [{ kind: "text", text: `stored conversation ${stamp}` }] },
        ],
      });
    }
    const service = new AgentService({
      backendFactory: () => ({
        name: "live",
        model: "live",
        runTurn() {
          return (async function* () {
            yield undefined as never;
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      idleTimeoutMs: 60_000,
    });

    const seen = new Set<string>();
    let page = await service.listConversationPage({ limit: 10 });
    let longestCursor = page.nextCursor?.length ?? 0;
    for (const summary of page.conversations) seen.add(summary.id);
    while (page.nextCursor) {
      page = await service.listConversationPage({ limit: 10, cursor: page.nextCursor });
      longestCursor = Math.max(longestCursor, page.nextCursor?.length ?? 0);
      for (const summary of page.conversations) seen.add(summary.id);
    }

    expect(seen.size).toBe(125);
    expect(longestCursor).toBeLessThan(160);
    service.dispose();
  });

  it("prefers a live resumed conversation summary while a new turn is in flight", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    await store.save({
      id: "S_resume",
      callerId: callerA,
      model: "stored",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "old stored",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "old stored" }] }],
    });
    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((res) => {
      releaseTurn = res;
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "live",
        model: "live",
        runTurn() {
          return (async function* () {
            await turnGate;
            throw new Error("gated turn released");

            yield undefined as never; // unreachable; satisfies require-yield
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      idleTimeoutMs: 60_000,
    });
    const { sessionId } = await service.createSession(callerA, { resumeFromId: "S_resume" });
    service.sendMessage(callerA, sessionId, "new in-flight turn");
    await new Promise((r) => setImmediate(r));

    const [summary] = await service.listConversations();
    expect(summary).toMatchObject({
      id: "S_resume",
      model: "live",
      backend: "live",
      messageCount: 2,
    });
    expect(summary!.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");

    releaseTurn();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    service.dispose();
  });

  it("resume reports busy=true mid-turn and busy=false once the turn ends", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    // A gated backend keeps the turn in flight until released, so the live
    // session's `busy` getter is true while we resume it.
    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((res) => {
      releaseTurn = res;
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "gated",
        model: "gated",
        runTurn() {
          return (async function* () {
            await turnGate;
            throw new Error("gated turn released");

            yield undefined as never; // unreachable; satisfies require-yield
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      sessionIdGen: () => "S_busy",
      idleTimeoutMs: 60_000,
    });
    const { sessionId, busy: createdBusy } = await service.createSession(callerA);
    expect(createdBusy).toBe(false); // nothing in flight yet.

    service.sendMessage(callerA, sessionId, "hold the line");
    await new Promise((r) => setImmediate(r)); // let the turn start.

    // Resuming the live session mid-turn must report it busy so a
    // reconnecting client doesn't clobber the in-flight run.
    const midTurn = await service.createSession(callerA, { resumeFromId: sessionId });
    expect(midTurn.busy).toBe(true);

    releaseTurn();
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    // The live session is gone after the turn ends; a disk-resume is idle.
    const afterTurn = await service.createSession(callerA, { resumeFromId: sessionId });
    expect(afterTurn.busy).toBe(false);
    service.dispose();
  });

  it("session_not_found when the id doesn't exist", () => {
    const { service } = makeServiceWithFixture([]);
    try {
      service.sendMessage(callerA, "nope", "x");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe("session_not_found");
    }
  });

  it("evictForCaller removes every session that device owns", async () => {
    const { service } = makeServiceWithFixture([]);
    await service.createSession(callerA);
    // Recreate with a different generator for the second.
    expect(service.sessionCount()).toBe(1);
    service.evictForCaller(callerA);
    expect(service.sessionCount()).toBe(0);
  });

  it("resuming a live session refreshes lastActive", async () => {
    const { service } = makeServiceWithFixture([]);
    const created = await service.createSession(callerA);
    // Drop into the live-resume branch (no store; same caller).
    const lastActiveBefore = readLastActive(service, created.sessionId);
    await waitMs(5);
    const resumed = await service.createSession(callerA, { resumeFromId: created.sessionId });
    expect(resumed.sessionId).toBe(created.sessionId);
    const lastActiveAfter = readLastActive(service, created.sessionId);
    expect(lastActiveAfter).toBeGreaterThan(lastActiveBefore);
  });

  it("passes backend error messages through to the wire unchanged", async () => {
    // `agent.error` messages are user-facing by contract: the backend
    // builds a vetted message and the gateway surfaces it (logging raw
    // server-side) instead of replacing it with a placeholder.
    const backendMessage = "Model API error (404): not a chat model";
    const captured: WsEvent[] = [];
    const service = new AgentService({
      backendFactory: () => ({
        name: "boom",
        model: "boom",
        runTurn() {
          return (async function* () {
            throw new Error(backendMessage);

            yield undefined as never;
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      broadcastEvent: (e) => captured.push(e),
      sessionIdGen: () => "S_boom",
      idleTimeoutMs: 60_000,
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "hi");
    // Yield until the rejection lands and the error event fires.
    for (let i = 0; i < 10 && captured.every((c) => c.type !== "agent.error"); i++) {
      await new Promise((r) => setImmediate(r));
    }
    const errorEvt = captured.find((c) => c.type === "agent.error");
    expect(errorEvt).toBeDefined();
    const message = (errorEvt!.payload as { message: string }).message;
    expect(message).toBe(backendMessage);
  });

  it("starts the regular Deep Research flow for the Codex backend", async () => {
    const captured: WsEvent[] = [];
    const storeDir = mkdtempSync(join(tmpdir(), "omnesis-svc-deep-research-delete-"));
    tempDirs.push(storeDir);
    const service = new AgentService({
      backendFactory: () => ({
        name: "codex",
        model: "gpt-5.4",
        runTurn() {
          throw new Error("ordinary Codex turn should not run for Deep Research");
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      broadcastEvent: (e) => captured.push(e),
      sessionIdGen: () => "S_codex_dr",
      idleTimeoutMs: 60_000,
      store: new FsConversationStore(storeDir),
      subagents: {
        resolveSpecialist: () => ({
          name: "research-reader",
          systemPrompt: "Synthetic reader",
          modelRole: "agent",
        }),
        genericSystemPrompt: () => "generic sub-agent prompt",
        depthCap: 1,
        concurrencyCap: 1,
      },
    });

    const { sessionId } = await service.createSession(callerA);
    const sent = service.sendMessage(callerA, sessionId, "research synthetic context", {
      deepResearch: true,
    });

    expect(sent.messageId).toMatch(/^dr_/);
    expect(captured.slice(0, 2).map((event) => event.type)).toEqual([
      "agent.user.message",
      "agent.message.start",
    ]);
    expect(
      captured.find(
        (event) =>
          event.type === "agent.error" &&
          (event.payload as { code: string }).code === "codex_deep_research_unavailable",
      ),
    ).toBeUndefined();
    await expect(service.deleteConversation(sessionId)).rejects.toMatchObject<AgentError>({
      code: "session_busy",
    });
    let deleted = false;
    for (let attempt = 0; attempt < 200 && !deleted; attempt += 1) {
      try {
        deleted = await service.deleteConversation(sessionId);
      } catch (err) {
        if (!(err instanceof AgentError) || err.code !== "session_busy") throw err;
        await waitMs(5);
      }
    }
    expect(deleted).toBe(true);
    await service.dispose();
  });

  it("does not bypass the session busy guard when starting Codex Deep Research", async () => {
    const captured: WsEvent[] = [];
    let releaseTurn: () => void = () => {};
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "codex",
        model: "gpt-5.4",
        runTurn(input) {
          return (async function* () {
            yield {
              type: "agent.message.start",
              payload: {
                sessionId: input.sessionId,
                messageId: input.messageId,
                role: "assistant",
              },
            } satisfies AgentEvent;
            await turnGate;
            yield {
              type: "agent.message.end",
              payload: {
                sessionId: input.sessionId,
                messageId: input.messageId,
                stopReason: "end_turn",
              },
            } satisfies AgentEvent;
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      broadcastEvent: (e) => captured.push(e),
      sessionIdGen: () => "S_codex_busy",
      idleTimeoutMs: 60_000,
      subagents: {
        resolveSpecialist: () => ({
          name: "research-reader",
          systemPrompt: "Synthetic reader",
          modelRole: "agent",
        }),
        genericSystemPrompt: () => "generic sub-agent prompt",
        depthCap: 1,
        concurrencyCap: 1,
      },
    });

    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "ordinary synthetic turn");
    await new Promise((resolve) => setImmediate(resolve));

    expect(() =>
      service.sendMessage(callerA, sessionId, "research synthetic context", { deepResearch: true }),
    ).toThrow("session is busy");
    releaseTurn();
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(captured.filter((event) => event.type === "agent.user.message")).toHaveLength(1);
    await service.dispose();
  });

  it("surfaces the raw failure reason on the terminal send_failed event", async () => {
    const backendMessage = "Model API error (500): upstream exploded";
    const captured: WsEvent[] = [];
    const service = new AgentService({
      backendFactory: () => ({
        name: "boom",
        model: "boom",
        runTurn() {
          return (async function* () {
            throw new Error(backendMessage);

            yield undefined as never;
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      broadcastEvent: (e) => captured.push(e),
      sessionIdGen: () => "S_sendfail",
      idleTimeoutMs: 60_000,
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "hi");
    const findSendFailed = () =>
      captured.find(
        (c) => c.type === "agent.error" && (c.payload as { code: string }).code === "send_failed",
      );
    for (let i = 0; i < 20 && !findSendFailed(); i++) {
      await new Promise((r) => setImmediate(r));
    }
    const evt = findSendFailed();
    expect(evt).toBeDefined();
    expect((evt!.payload as { message: string }).message).toBe(backendMessage);
  });

  it("persists failed no-output turns with a terminal assistant message", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    const { promise: persisted, resolve: persistDone } = Promise.withResolvers<void>();
    const service = new AgentService({
      backendFactory: () => ({
        name: "timeout-backend",
        model: "timeout-model",
        runTurn() {
          return (async function* () {
            await Promise.resolve();
            throw new Error("The operation was aborted due to timeout");

            yield undefined as never;
          })();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      onTurnComplete: () => persistDone(),
      sessionIdGen: () => "S_timeout",
      idleTimeoutMs: 60_000,
    });

    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "hi");
    await persisted;

    const record = await store.load(sessionId);
    expect(record?.messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          {
            kind: "text",
            text: "Model request failed: internal_error: The operation was aborted due to timeout",
          },
        ],
      },
    ]);
  });

  it("normalizes stored dangling user-only transcripts to an empty-response assistant error", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    await store.save({
      id: "S_dangling",
      callerId: callerA,
      model: "deepseek-ai/deepseek-v4-pro",
      backend: "http",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      title: "dangling",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "Why no answer?" }] }],
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "http",
        model: "deepseek-ai/deepseek-v4-pro",
        runTurn() {
          return emptyAgentStream();
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      idleTimeoutMs: 60_000,
    });

    const loaded = await service.loadConversation("S_dangling");
    expect(loaded?.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(loaded?.messages[1]).toEqual({
      role: "assistant",
      parts: [
        {
          kind: "text",
          text: "Model request failed: http_empty_response: Model returned an empty response.",
        },
      ],
    });

    const resumed = await service.createSession(callerB, { resumeFromId: "S_dangling" });
    expect(resumed.messageCount).toBe(2);
    expect(resumed.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    service.dispose();
  });

  it("lists every conversation regardless of which caller created it", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    let n = 0;
    const { promise: persisted, resolve: persistDone } = Promise.withResolvers<void>();
    const service = new AgentService({
      backendFactory: () =>
        new ReplayBackend({
          fixtures: [
            {
              entries: [
                {
                  afterMs: 0,
                  event: {
                    type: "agent.message.end",
                    payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
                  } satisfies AgentEvent,
                },
              ],
            },
          ],
        }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => `S_${++n}`,
      idleTimeoutMs: 60_000,
      store,
      onTurnComplete: () => persistDone(),
    });
    // Caller A creates and drives a session to first persist.
    const a = await service.createSession(callerA);
    service.sendMessage(callerA, a.sessionId, "hi");
    // Wait for the persist chain (completion → .finally → persistConversation
    // → onTurnComplete) to settle. The setImmediate loop alone was racy because
    // the file I/O inside persistConversation could take more event-loop ticks
    // than the fixed iteration count provided.
    await persisted;
    // The list endpoint surfaces it for caller B too.
    const listed = await service.listConversations();
    expect(listed.map((c) => c.id)).toContain(a.sessionId);
  });

  it("disk-resume works across callers after the live session is gone", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    let n = 0;
    const { promise: persisted, resolve: persistDone } = Promise.withResolvers<void>();
    const service = new AgentService({
      backendFactory: () =>
        new ReplayBackend({
          fixtures: [
            {
              entries: [
                {
                  afterMs: 0,
                  event: {
                    type: "agent.message.end",
                    payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
                  } satisfies AgentEvent,
                },
              ],
            },
          ],
        }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => `S_${++n}`,
      idleTimeoutMs: 60_000,
      store,
      onTurnComplete: () => persistDone(),
    });
    const a = await service.createSession(callerA);
    service.sendMessage(callerA, a.sessionId, "hi");
    // Wait for the persist chain to settle before evicting. Without this
    // the eviction can race ahead of the file I/O and store.load returns
    // null on the resume attempt.
    await persisted;
    // Drop the live entry — emulate a restart that wipes in-memory
    // sessions but leaves disk transcripts intact.
    service.evictForCaller(callerA);
    expect(service.sessionCount()).toBe(0);
    const resumed = await service.createSession(callerB, { resumeFromId: a.sessionId });
    expect(resumed.sessionId).toBe(a.sessionId);
    expect(resumed.messages.length).toBeGreaterThan(0);
    expect(readCallerId(service, a.sessionId)).toBe(callerB);
  });

  it("dispose clears every timer and removes every session", async () => {
    let n = 0;
    const service = new AgentService({
      backendFactory: () =>
        new ReplayBackend({
          fixtures: [{ entries: [] }],
        }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => `S_${++n}`,
      idleTimeoutMs: 60_000,
    });
    await service.createSession(callerA);
    await service.createSession(callerB);
    expect(service.sessionCount()).toBe(2);
    service.dispose();
    expect(service.sessionCount()).toBe(0);
  });

  it("dispose persists an ordinary in-flight cancellation before removing the session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-svc-dispose-turn-"));
    tempDirs.push(dir);
    const store = new FsConversationStore(dir);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "dispose-aware",
        model: "dispose-aware",
        async *runTurn(input, signal) {
          markStarted();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
          yield {
            type: "agent.message.end",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              stopReason: "end_turn",
            },
          };
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_dispose_turn",
      idleTimeoutMs: 60_000,
      store,
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "preserve this canceled request");
    await started;

    await service.dispose();

    expect(service.sessionCount()).toBe(0);
    expect(await store.load(sessionId)).toMatchObject({
      messages: [
        { role: "user", parts: [{ kind: "text", text: "preserve this canceled request" }] },
        {
          role: "assistant",
          parts: [
            { kind: "text", text: "Model request failed: canceled: This reply was stopped." },
          ],
        },
      ],
    });
  });

  it("cancelSession persists the stop as the user's own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-svc-user-stop-"));
    tempDirs.push(dir);
    const store = new FsConversationStore(dir);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "stop-aware",
        model: "stop-aware",
        async *runTurn(input, signal) {
          yield {
            type: "agent.message.start",
            payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
          };
          markStarted();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_user_stop",
      idleTimeoutMs: 60_000,
      store,
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "stop this one");
    await started;

    service.cancelSession(callerA, sessionId);
    await waitUntil(conversationIdle(service, sessionId), "the stopped turn to persist");

    expect(await store.load(sessionId)).toMatchObject({
      messages: [
        { role: "user", parts: [{ kind: "text", text: "stop this one" }] },
        {
          role: "assistant",
          parts: [
            { kind: "text", text: "Model request failed: canceled: You stopped this reply." },
          ],
        },
      ],
    });
    await service.dispose();
  });

  it("orders a pin mutation after an older delayed turn save", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-svc-pin-order-"));
    tempDirs.push(dir);
    const base = new FsConversationStore(dir);
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve;
    });
    let pinWrites = 0;
    const store: ConversationStore = {
      save: async (record) => {
        markSaveStarted();
        await saveGate;
        await base.save(record);
      },
      load: (id) => base.load(id),
      list: () => base.list(),
      delete: (id) => base.delete(id),
      setPinned: async (id, pinned) => {
        pinWrites += 1;
        return base.setPinned(id, pinned);
      },
    };
    const service = new AgentService({
      backendFactory: () =>
        new ReplayBackend({
          fixtures: [
            {
              entries: [
                {
                  afterMs: 0,
                  event: {
                    type: "agent.text.delta",
                    payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "Invented answer" },
                  },
                },
                {
                  afterMs: 0,
                  event: {
                    type: "agent.message.end",
                    payload: {
                      sessionId: "$SESSION",
                      messageId: "$MSG",
                      stopReason: "end_turn",
                    },
                  },
                },
              ],
            },
          ],
        }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_pin_order",
      idleTimeoutMs: 60_000,
      store,
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "Invented pin ordering question");
    await saveStarted;

    const pinning = service.setConversationPinned(sessionId, true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pinWrites).toBe(0);

    releaseSave();
    await expect(pinning).resolves.toBe(true);
    await waitUntil(conversationIdle(service, sessionId), "the ordered pin mutation to settle");
    expect(pinWrites).toBe(1);
    expect(await base.load(sessionId)).toMatchObject({ pinned: true });
  });

  it("setConversationPinned pins a stored conversation and floats it to the top", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    await store.save({
      id: "S_old",
      callerId: callerA,
      model: "stored",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "older",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "older" }] }],
    });
    await store.save({
      id: "S_new",
      callerId: callerA,
      model: "stored",
      backend: "replay",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      title: "newer",
      pinned: false,
      messages: [{ role: "user", parts: [{ kind: "text", text: "newer" }] }],
    });
    const service = new AgentService({
      backendFactory: () => new ReplayBackend({ fixtures: [{ entries: [] }] }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      idleTimeoutMs: 60_000,
    });

    expect(await service.setConversationPinned("S_old", true)).toBe(true);
    const list = await service.listConversations();
    expect(list.map((c) => c.id)).toEqual(["S_old", "S_new"]);
    expect(list.find((c) => c.id === "S_old")!.pinned).toBe(true);

    expect(await service.setConversationPinned("S_missing", true)).toBe(false);
    service.dispose();
  });

  it("a pin toggled on a live session survives the next turn-end save", async () => {
    const d = mkdtempSync(join(tmpdir(), `omnesis-svc-${process.pid}-`));
    tempDirs.push(d);
    const store = new FsConversationStore(join(d, "conversations"));
    const endTurn = {
      afterMs: 0,
      event: {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      } satisfies AgentEvent,
    };
    let persistDone: () => void = () => {};
    const service = new AgentService({
      // One fixture per turn; this test drives two turns on one session.
      backendFactory: () =>
        new ReplayBackend({ fixtures: [{ entries: [endTurn] }, { entries: [endTurn] }] }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      store,
      sessionIdGen: () => "S_live",
      idleTimeoutMs: 60_000,
      onTurnComplete: () => persistDone(),
    });
    const session = await service.createSession(callerA);
    // Resolve once the persist chain (.finally → persistConversation →
    // onTurnComplete) has actually flushed to disk for this turn.
    const completeTurn = async (text: string): Promise<void> => {
      const flushed = new Promise<void>((res) => {
        persistDone = res;
      });
      service.sendMessage(callerA, session.sessionId, text);
      await flushed;
    };

    await completeTurn("first turn");
    // First flush lands on disk unpinned.
    expect((await store.load(session.sessionId))!.pinned).toBe(false);

    // Pin while the session is still live in memory.
    expect(await service.setConversationPinned(session.sessionId, true)).toBe(true);
    expect((await store.load(session.sessionId))!.pinned).toBe(true);

    // A subsequent turn-end save must NOT clobber the pin back to false.
    await completeTurn("second turn");
    expect((await store.load(session.sessionId))!.pinned).toBe(true);
    service.dispose();
  });
});

function readLastActive(service: AgentService, sessionId: string): number {
  // Internal access for assertion only — Map lives on the private field.
  // The test is the only consumer; production callers see the Promise
  // shape of createSession / sendMessage.
  const sessions = (service as unknown as { sessions: Map<string, { lastActive: number }> })
    .sessions;
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`no entry for ${sessionId}`);
  return entry.lastActive;
}

function readCallerId(service: AgentService, sessionId: string): string {
  const sessions = (service as unknown as { sessions: Map<string, { callerId: string }> }).sessions;
  const entry = sessions.get(sessionId);
  if (!entry) throw new Error(`no entry for ${sessionId}`);
  return entry.callerId;
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the thing the assertion is about, rather than for a wall-clock
 * window a turn is expected to fit inside.
 *
 * A turn settles asynchronously — the backend stream drains, the transcript is
 * persisted, the observer fires — and how long that takes depends on what else
 * the machine is doing. Sleeping a fixed 25ms and draining a fixed number of
 * microtasks passes alone and fails in a full lane, which is a red on `main`
 * caused by load rather than by anything that landed.
 */
async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The turn is over — and the conversation deletable — once every gate
 * `deleteConversation` refuses on has cleared. `sendMessage` sets one of them
 * synchronously, so this is false the moment the turn starts and true only
 * after it has finished persisting.
 *
 * Read from the service's own state rather than inferred from the transcript:
 * a store that rejects every write never produces one to wait for, and the
 * write completing is not the same instant as the attempt being released.
 * Waiting on a fixed wall-clock window instead is the flake this replaces.
 */
function conversationIdle(service: AgentService, sessionId: string): () => boolean {
  const internals = service as unknown as Record<string, { has(id: string): boolean }>;
  const gates = [
    "answerDeleteLocks",
    "activeTurnReplays",
    "deepResearchActive",
    "resumeCreationTails",
    "conversationPersistenceCounts",
  ];
  return () => gates.every((gate) => !internals[gate]?.has(sessionId));
}

describe("AgentService — observer hooks", () => {
  function turnFixture(): AgentEvent[] {
    return [
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "ok" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ];
  }

  function makeServiceWithHooks(
    hooks: {
      onTurnComplete?: (id: string) => void;
      onSessionClose?: (id: string) => void | Promise<void>;
      onConversationDeleted?: (id: string) => Promise<unknown>;
    },
    events: AgentEvent[] = turnFixture(),
  ): { service: AgentService; storeDir: string } {
    const storeDir = mkdtempSync(join(tmpdir(), "omnesis-svc-hooks-"));
    tempDirs.push(storeDir);
    const service = new AgentService({
      backendFactory: () =>
        new ReplayBackend({
          fixtures: [{ entries: events.map((e) => ({ afterMs: 0, event: e })) }],
        }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_hooks",
      idleTimeoutMs: 60_000,
      store: new FsConversationStore(storeDir),
      ...hooks,
    });
    return { service, storeDir };
  }

  it("onTurnComplete fires exactly once per successful turn", async () => {
    const calls: string[] = [];
    const { service } = makeServiceWithHooks({
      onTurnComplete: (id) => calls.push(id),
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "hi");
    await waitUntil(() => calls.length > 0, "onTurnComplete to fire");
    // Give a second call the chance to arrive before asserting there wasn't one.
    await waitMs(25);
    expect(calls).toEqual([sessionId]);
  });

  it("onTurnComplete observer errors are caught and logged, not propagated", async () => {
    const { service } = makeServiceWithHooks({
      onTurnComplete: () => {
        throw new Error("boom");
      },
    });
    const { sessionId } = await service.createSession(callerA);
    expect(() => service.sendMessage(callerA, sessionId, "hi")).not.toThrow();
    await waitUntil(conversationIdle(service, sessionId), "the turn to settle");
    // The session must remain healthy after the observer failure.
    expect(service.sessionCount()).toBe(1);
  });

  it("onSessionClose is awaited inside evictSession (returned promise resolves before delete)", async () => {
    let observerResolve!: () => void;
    const observerStarted = { value: false };
    const observerSettled = { value: false };
    const observerGate = new Promise<void>((r) => {
      observerResolve = r;
    });
    const { service } = makeServiceWithHooks({
      onSessionClose: async () => {
        observerStarted.value = true;
        await observerGate;
        observerSettled.value = true;
      },
    });
    const { sessionId } = await service.createSession(callerA);
    // Drive a turn to populate the on-disk transcript.
    service.sendMessage(callerA, sessionId, "hi");
    await waitUntil(conversationIdle(service, sessionId), "the turn to settle");

    let deleteResolved = false;
    const delPromise = service.deleteConversation(sessionId).then((v) => {
      deleteResolved = true;
      return v;
    });
    // After a few microtask drains the observer is mid-flight; the
    // deleteConversation promise must NOT have resolved yet.
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    expect(observerStarted.value).toBe(true);
    expect(observerSettled.value).toBe(false);
    expect(deleteResolved).toBe(false);

    observerResolve();
    await delPromise;
    expect(observerSettled.value).toBe(true);
    expect(deleteResolved).toBe(true);
  });

  it("awaits the durable delete observer before unlinking the transcript", async () => {
    const seen: string[] = [];
    const { service } = makeServiceWithHooks({
      onConversationDeleted: async (id) => {
        seen.push(id);
      },
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "hi");
    await waitUntil(conversationIdle(service, sessionId), "the turn to settle");
    await service.deleteConversation(sessionId);
    expect(seen).toEqual([sessionId]);
  });

  it("preserves the transcript when the durable delete observer fails", async () => {
    let attempts = 0;
    let markDeleting!: () => void;
    let releaseFailure!: () => void;
    const deleting = new Promise<void>((resolve) => {
      markDeleting = resolve;
    });
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const { service, storeDir } = makeServiceWithHooks({
      onConversationDeleted: async () => {
        attempts += 1;
        if (attempts === 1) {
          markDeleting();
          await failureGate;
          throw new Error("index unavailable");
        }
      },
    });
    const store = new FsConversationStore(storeDir);
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "hi");
    await waitUntil(conversationIdle(service, sessionId), "the turn to settle");

    const firstDeletion = service.deleteConversation(sessionId);
    await deleting;
    expect((await service.listConversations()).map((summary) => summary.id)).not.toContain(
      sessionId,
    );
    releaseFailure();
    await expect(firstDeletion).rejects.toThrow("index unavailable");
    expect(await store.load(sessionId)).not.toBeNull();
    expect((await service.listConversations()).map((summary) => summary.id)).toContain(sessionId);
    await expect(service.deleteConversation(sessionId)).resolves.toBe(true);
    expect(await store.load(sessionId)).toBeNull();
  });

  it("refuses deletion while an interactive turn can still persist the conversation", async () => {
    let markStarted!: () => void;
    let releaseTurn!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const storeDir = mkdtempSync(join(tmpdir(), "omnesis-svc-delete-turn-"));
    tempDirs.push(storeDir);
    const store = new FsConversationStore(storeDir);
    const onConversationDeleted = vi.fn(async () => {});
    let markTurnComplete!: () => void;
    const turnComplete = new Promise<void>((resolve) => {
      markTurnComplete = resolve;
    });
    const service = new AgentService({
      backendFactory: () => ({
        name: "controlled",
        model: "controlled",
        async *runTurn(input) {
          markStarted();
          yield {
            type: "agent.message.start",
            payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
          } satisfies AgentEvent;
          await turnGate;
          yield {
            type: "agent.text.delta",
            payload: { sessionId: input.sessionId, messageId: input.messageId, delta: "done" },
          } satisfies AgentEvent;
          yield {
            type: "agent.message.end",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              stopReason: "end_turn",
            },
          } satisfies AgentEvent;
        },
      }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_delete_turn",
      idleTimeoutMs: 60_000,
      store,
      onTurnComplete: markTurnComplete,
      onConversationDeleted,
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "Invented question");
    await started;

    await expect(service.deleteConversation(sessionId)).rejects.toMatchObject<AgentError>({
      code: "session_busy",
    });
    expect(onConversationDeleted).not.toHaveBeenCalled();

    releaseTurn();
    await turnComplete;
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.deleteConversation(sessionId)).resolves.toBe(true);
    expect(await store.load(sessionId)).toBeNull();
  });

  it("deletes an idle live conversation even when its transcript was never saved", async () => {
    const store: ConversationStore = {
      save: async () => {
        throw new Error("disk unavailable");
      },
      load: async () => null,
      list: async () => [],
      delete: async () => false,
      setPinned: async () => false,
    };
    const service = new AgentService({
      backendFactory: () =>
        new ReplayBackend({
          fixtures: [
            {
              entries: turnFixture().map((event) => ({ afterMs: 0, event })),
            },
          ],
        }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_unsaved_live",
      idleTimeoutMs: 60_000,
      store,
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "Invented question");
    await waitUntil(
      conversationIdle(service, sessionId),
      "the turn's failed persistence attempt to settle",
    );

    await expect(service.deleteConversation(sessionId)).resolves.toBe(true);
    expect((await service.listConversations()).map((summary) => summary.id)).not.toContain(
      sessionId,
    );
  });

  it("refuses deletion while a stored conversation is being resumed", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "omnesis-svc-delete-resume-"));
    tempDirs.push(storeDir);
    const base = new FsConversationStore(storeDir);
    await base.save({
      id: "S_delete_resume",
      callerId: callerA,
      model: "replay",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      title: "Invented question",
      pinned: false,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Invented question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Invented answer" }] },
      ],
    });
    let markLoading!: () => void;
    let releaseLoad!: () => void;
    const loading = new Promise<void>((resolve) => {
      markLoading = resolve;
    });
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    const store: ConversationStore = {
      save: (record) => base.save(record),
      load: async (id) => {
        markLoading();
        await loadGate;
        return base.load(id);
      },
      list: () => base.list(),
      delete: (id) => base.delete(id),
      setPinned: (id, pinned) => base.setPinned(id, pinned),
    };
    const service = new AgentService({
      backendFactory: () => new ReplayBackend({ fixtures: [{ entries: [] }] }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "unused",
      idleTimeoutMs: 60_000,
      store,
    });

    const resume = service.createSession(callerA, { resumeFromId: "S_delete_resume" });
    await loading;
    await expect(service.deleteConversation("S_delete_resume")).rejects.toMatchObject<AgentError>({
      code: "session_busy",
    });

    releaseLoad();
    await resume;
    await expect(service.deleteConversation("S_delete_resume")).resolves.toBe(true);
    expect(await base.load("S_delete_resume")).toBeNull();
  });

  it("filters a stale list read that finishes after deletion", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "omnesis-svc-delete-list-"));
    tempDirs.push(storeDir);
    const base = new FsConversationStore(storeDir);
    await base.save({
      id: "S_delete_list",
      callerId: callerA,
      model: "replay",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      title: "Invented question",
      pinned: false,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Invented question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Invented answer" }] },
      ],
    });
    let markListed!: () => void;
    let releaseList!: () => void;
    const listed = new Promise<void>((resolve) => {
      markListed = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const store: ConversationStore = {
      save: (record) => base.save(record),
      load: (id) => base.load(id),
      list: async () => {
        const stale = await base.list();
        markListed();
        await listGate;
        return stale;
      },
      delete: (id) => base.delete(id),
      setPinned: (id, pinned) => base.setPinned(id, pinned),
    };
    const service = new AgentService({
      backendFactory: () => new ReplayBackend({ fixtures: [] }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "unused",
      idleTimeoutMs: 60_000,
      store,
    });

    const staleList = service.listConversations();
    await listed;
    await expect(service.deleteConversation("S_delete_list")).resolves.toBe(true);
    releaseList();
    expect(await staleList).toEqual([]);
  });

  it("hides a conversation while its durable deletion cascade is running", async () => {
    let markDeleting!: () => void;
    let releaseDelete!: () => void;
    const deleting = new Promise<void>((resolve) => {
      markDeleting = resolve;
    });
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let markTurnComplete!: () => void;
    const turnComplete = new Promise<void>((resolve) => {
      markTurnComplete = resolve;
    });
    const { service } = makeServiceWithHooks({
      onTurnComplete: markTurnComplete,
      onConversationDeleted: async () => {
        markDeleting();
        await deleteGate;
      },
    });
    const { sessionId } = await service.createSession(callerA);
    service.sendMessage(callerA, sessionId, "Invented question");
    await turnComplete;
    await new Promise((resolve) => setImmediate(resolve));

    const deletion = service.deleteConversation(sessionId);
    await deleting;
    expect((await service.listConversations()).map((summary) => summary.id)).not.toContain(
      sessionId,
    );
    expect(
      (await service.listConversationPage()).conversations.map((summary) => summary.id),
    ).not.toContain(sessionId);

    releaseDelete();
    await expect(deletion).resolves.toBe(true);
  });

  it("activity retention deletes only old unpinned ordinary conversations", async () => {
    const seen: string[] = [];
    const { service, storeDir } = makeServiceWithHooks({
      onConversationDeleted: async (id) => {
        seen.push(id);
      },
    });
    const store = new FsConversationStore(storeDir);
    const base = {
      callerId: callerA,
      model: "replay",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      title: "Invented conversation",
      messages: [],
    };
    await store.save({
      ...base,
      id: "old",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pinned: false,
    });
    await store.save({
      ...base,
      id: "fresh",
      updatedAt: "2026-03-01T00:00:00.000Z",
      pinned: false,
    });
    await store.save({
      ...base,
      id: "pinned",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pinned: true,
    });
    await store.save({
      ...base,
      id: "anchored",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pinned: false,
      origin: {
        kind: "brief" as const,
        briefId: "brief_example",
        runId: "run_example",
      },
    });
    await store.save({
      ...base,
      id: "watch-firing",
      updatedAt: "2026-01-01T00:00:00.000Z",
      pinned: false,
      origin: {
        kind: "watch_firing" as const,
        firingId: "firing_example",
        runId: "run_watch",
      },
    });

    expect(await service.pruneConversations(Date.parse("2026-02-01T00:00:00.000Z"), 10)).toEqual({
      deleted: 2,
      hasMore: false,
    });
    expect(seen.sort()).toEqual(["old", "watch-firing"]);
    expect(await store.load("old")).toBeNull();
    expect(await store.load("watch-firing")).toBeNull();
    expect(await store.load("fresh")).not.toBeNull();
    expect(await store.load("pinned")).not.toBeNull();
    expect(await store.load("anchored")).not.toBeNull();
  });

  it("deletes every eligible conversation without skipping scanned candidates", async () => {
    const { service, storeDir } = makeServiceWithHooks({});
    const store = new FsConversationStore(storeDir);
    const base = {
      callerId: callerA,
      model: "replay",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "Invented conversation",
      pinned: false,
      messages: [],
    };
    for (const id of ["old-a", "old-b", "old-c"]) {
      await store.save({ ...base, id });
    }

    let hasMore = true;
    let deleted = 0;
    for (let ticks = 0; hasMore && ticks < 10; ticks += 1) {
      const result = await service.pruneConversations(Date.parse("2026-02-01T00:00:00.000Z"), 1);
      deleted += result.deleted;
      hasMore = result.hasMore;
    }

    expect(deleted).toBe(3);
    expect(await store.list()).toEqual([]);
  });

  it("serializes resume creation against retention candidate and delete locks", async () => {
    const storeDir = mkdtempSync(join(tmpdir(), "omnesis-svc-retention-race-"));
    tempDirs.push(storeDir);
    const base = new FsConversationStore(storeDir);
    const old: ConversationRecord = {
      id: "old_race",
      callerId: callerA,
      model: "replay",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "Invented conversation",
      pinned: false,
      messages: [],
    };
    await base.save(old);

    let resumeLoadStarted!: () => void;
    const resumeLoadSeen = new Promise<void>((resolve) => {
      resumeLoadStarted = resolve;
    });
    let releaseResumeLoad!: () => void;
    const resumeLoadGate = new Promise<void>((resolve) => {
      releaseResumeLoad = resolve;
    });
    let blockResumeLoad = true;
    const store: ConversationStore = {
      save: (record) => base.save(record),
      list: () => base.list(),
      delete: (id) => base.delete(id),
      deleteForRetention: (id) => base.deleteForRetention(id),
      listRetentionCandidates: (cutoff, limit) => base.listRetentionCandidates(cutoff, limit),
      retentionCandidateIsCurrent: (candidate, cutoff) =>
        base.retentionCandidateIsCurrent(candidate, cutoff),
      setPinned: (id, pinned) => base.setPinned(id, pinned),
      load: async (id) => {
        if (id === old.id && blockResumeLoad) {
          blockResumeLoad = false;
          resumeLoadStarted();
          await resumeLoadGate;
        }
        return base.load(id);
      },
    };
    const service = new AgentService({
      backendFactory: () => new ReplayBackend({ fixtures: [{ entries: [] }] }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      idleTimeoutMs: 60_000,
      store,
    });

    const resume = service.createSession(callerA, { resumeFromId: old.id });
    await resumeLoadSeen;
    expect(await service.pruneConversations(Date.parse("2026-02-01T00:00:00.000Z"), 1)).toEqual({
      deleted: 0,
      hasMore: true,
    });
    releaseResumeLoad();
    await expect(resume).resolves.toMatchObject({ sessionId: old.id });
    expect(await base.load(old.id)).not.toBeNull();

    await service.dispose();

    // Opposite ordering: once retention owns the delete lock, a resume fails
    // busy instead of racing the unlink and returning a dead session.
    await base.save(old);
    let pruneRevalidationStarted!: () => void;
    const pruneRevalidationSeen = new Promise<void>((resolve) => {
      pruneRevalidationStarted = resolve;
    });
    let releasePruneRevalidation!: () => void;
    const pruneRevalidationGate = new Promise<void>((resolve) => {
      releasePruneRevalidation = resolve;
    });
    let blockPruneRevalidation = true;
    const pruneStore: ConversationStore = {
      ...store,
      retentionCandidateIsCurrent: async (candidate, cutoff) => {
        if (candidate.id === old.id && blockPruneRevalidation) {
          blockPruneRevalidation = false;
          pruneRevalidationStarted();
          await pruneRevalidationGate;
        }
        return base.retentionCandidateIsCurrent(candidate, cutoff);
      },
    };
    const pruningService = new AgentService({
      backendFactory: () => new ReplayBackend({ fixtures: [{ entries: [] }] }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      idleTimeoutMs: 60_000,
      store: pruneStore,
    });
    const prune = pruningService.pruneConversations(Date.parse("2026-02-01T00:00:00.000Z"), 1);
    await pruneRevalidationSeen;
    await expect(
      pruningService.createSession(callerA, { resumeFromId: old.id }),
    ).rejects.toMatchObject({ code: "session_busy" });
    releasePruneRevalidation();
    await expect(prune).resolves.toMatchObject({ deleted: 1 });
    expect(await base.load(old.id)).toBeNull();
    await pruningService.dispose();
  });

  it("retention preserves a transcript when downstream corpus cleanup fails", async () => {
    const { service, storeDir } = makeServiceWithHooks({
      onConversationDeleted: async () => {
        throw new Error("index unavailable");
      },
    });
    const store = new FsConversationStore(storeDir);
    await store.save({
      id: "retry_later",
      callerId: callerA,
      model: "replay",
      backend: "replay",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      title: "Invented conversation",
      pinned: false,
      messages: [],
    });

    expect(await service.pruneConversations(Date.parse("2026-02-01T00:00:00.000Z"), 10)).toEqual({
      deleted: 0,
      hasMore: true,
    });
    expect(await store.load("retry_later")).not.toBeNull();
  });
});

describe("AgentService — the caller's zone reaches the real tool", () => {
  /**
   * The bug this feature exists for was an integration failure: every seam
   * worked in isolation and the zone still never reached the tool that framed
   * the window. Each layer is unit-tested against a mock elsewhere; this drives
   * the real `temporal_query` through the real registry and asserts the value
   * that arrives at the read port, which no per-seam test can do.
   */
  it("frames a temporal_query in the zone the session was created with", async () => {
    const framedIn: Array<string | undefined> = [];
    const temporal: TemporalReadPort = {
      async query(input) {
        framedIn.push(input.timeZone);
        return {
          type: "temporal.results",
          window: {
            start: "2026-08-02T00:00:00.000Z",
            endExclusive: "2026-08-03T00:00:00.000Z",
            timeZone: input.timeZone,
          },
          items: [],
          coverage: {
            projectionSources: [],
            specialistSources: [],
            annotations: { selective: true },
          },
          truncated: false,
        };
      },
    };
    // Stands in for the model: calls the tool the registry actually built,
    // with no explicit `timeZone`, so the default is what is under test.
    const callingBackend: ChatBackend = {
      name: "calling",
      model: "calling",
      async *runTurn(input): AsyncIterable<AgentEvent> {
        const handle = input.tools.find((t) => t.name === "temporal_query");
        if (handle) {
          await handle.invoke(
            { from: "2026-08-02" },
            {
              sessionId: input.sessionId,
              messageId: input.messageId,
              timeZone: input.timeZone,
            },
          );
        }
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "end_turn",
          },
        };
      },
    };

    const previous = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
    try {
      const service = new AgentService({
        backendFactory: () => callingBackend,
        ports: { search: stubSearch, document: stubDocument, temporal },
        systemPrompt: "test",
        idleTimeoutMs: 60_000,
      });
      const { sessionId } = await service.createSession(callerA, { timeZone: "Asia/Tokyo" });
      service.sendMessage(callerA, sessionId, "what's on today");
      await vi.waitFor(() => expect(framedIn.length).toBe(1));
    } finally {
      if (previous === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previous;
    }

    expect(framedIn).toEqual(["Asia/Tokyo"]);
  });
});

describe("AgentService — the caller's time zone", () => {
  /**
   * A service whose prompt builder records the context it was handed, so the
   * assertions are about what actually reaches `buildSystemPrompt` rather than
   * about the prompt text (which the prompt's own suite covers).
   */
  function makeZoneRecordingService() {
    const seen: Array<{ profile: string; timeZone: string | undefined }> = [];
    const service = new AgentService({
      backendFactory: () => new ReplayBackend({ fixtures: [{ entries: [] }] }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: (profile, context) => {
        seen.push({ profile, timeZone: context.timeZone });
        return `prompt for ${context.timeZone ?? "host"}`;
      },
      idleTimeoutMs: 60_000,
    });
    return { service, seen };
  }

  it("hands the caller's zone to the prompt builder", async () => {
    const { service, seen } = makeZoneRecordingService();

    await service.createSession(callerA, { timeZone: "Asia/Tokyo" });

    expect(seen).toEqual([{ profile: "interactive", timeZone: "Asia/Tokyo" }]);
  });

  it("leaves the zone unset when the client sent none, so the builder falls back", async () => {
    const { service, seen } = makeZoneRecordingService();

    await service.createSession(callerA);

    expect(seen).toEqual([{ profile: "interactive", timeZone: undefined }]);
  });

  // Two people on two devices in two countries share one gateway and one
  // corpus. Neither session may be answered in the other's clock.
  it("keeps each live session on the zone it was created with", async () => {
    const { service, seen } = makeZoneRecordingService();

    await service.createSession(callerA, { timeZone: "Asia/Tokyo" });
    await service.createSession(callerB, { timeZone: "America/Los_Angeles" });

    expect(seen.map((entry) => entry.timeZone)).toEqual(["Asia/Tokyo", "America/Los_Angeles"]);
  });

  // The failure to avoid is not a stale zone but a SPLIT one: a prompt written
  // in Tokyo while `temporal_query` still frames windows in London. The session
  // owns a single value that both consumers read, so the two cannot diverge.
  it("keeps a live session's prompt and its tools on one zone across a profile swap", async () => {
    const seen: Array<string | undefined> = [];
    const service = new AgentService({
      backendFactory: () => new ReplayBackend({ fixtures: [{ entries: [] }] }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: (_profile, context) => {
        seen.push(context.timeZone);
        return "prompt";
      },
      idleTimeoutMs: 60_000,
    });

    const created = await service.createSession(callerA, { timeZone: "Europe/London" });
    // Same still-live session, resumed by a client reporting a different zone
    // and asking for a different prompt profile — the path that rebuilds the
    // session object underneath an existing transcript.
    await service.createSession(callerA, {
      resumeFromId: created.sessionId,
      profile: "voice",
      timeZone: "Asia/Tokyo",
    });

    // A session's zone is fixed for its lifetime: the transcript above was
    // written in it. Both the rebuilt prompt and the rebuilt session's tools
    // must agree on that one value.
    expect(seen).toEqual(["Europe/London", "Europe/London"]);
    expect(service.sessionTimeZoneForTest(created.sessionId)).toBe("Europe/London");
  });

  it("re-grounds a disk-resumed conversation in the zone the resuming client reports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnesis-tz-"));
    tempDirs.push(dir);
    const store = new FsConversationStore(dir);
    const seen: Array<string | undefined> = [];
    const build = () =>
      new AgentService({
        backendFactory: () => new ReplayBackend({ fixtures: [{ entries: [] }] }),
        ports: { search: stubSearch, document: stubDocument },
        systemPrompt: (_profile, context) => {
          seen.push(context.timeZone);
          return "prompt";
        },
        store,
        idleTimeoutMs: 60_000,
      });

    const first = build();
    const created = await first.createSession(callerA, { timeZone: "Europe/London" });
    await store.save({
      id: created.sessionId,
      callerId: callerA,
      model: "m",
      backend: "b",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      title: "t",
      messages: [],
    } as ConversationRecord);

    // A fresh service stands in for the same conversation reopened later —
    // from a phone that has since flown east.
    const second = build();
    await second.createSession(callerA, {
      resumeFromId: created.sessionId,
      timeZone: "Asia/Tokyo",
    });

    expect(seen).toEqual(["Europe/London", "Asia/Tokyo"]);
  });
});
