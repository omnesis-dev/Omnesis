// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// @ts-expect-error — the portal is plain JS, no .d.ts ships alongside.
import {
  reducer,
  initialState,
  chatMessagesToTurns,
  citationsFromMessages,
  trailAnnotationsFromMessages,
  recordCitationsFromMessages,
  buildUnifiedTimeline,
  summarizeArgs,
  reduceChildEvent,
  researchPanels,
  isResearchWorkspaceActive,
  EPHEMERAL_TOOLS,
} from "./agent-reducer.js";
import { describe, expect, it } from "vitest";

type State = ReturnType<typeof initialState>;
// The reducer is hand-typed JS — coerce to `any` at the boundary so the
// test stays focused on behaviour rather than fighting `unknown`.
const r: (s: State, a: any) => State = reducer as any;
const reduceChild: (card: any, event: any) => any = reduceChildEvent as any;

const MEMORY_TOOLS = [
  "conversation_memory_evidence",
  "annotation_search",
  "annotate_durable",
  "annotation_revise",
  "annotation_retract",
  "annotation_supersede",
  "annotate_person",
  "person_annotation_revise",
  "person_annotation_retract",
  "person_annotation_supersede",
];

describe("interactive memory tool visibility", () => {
  it("classifies every memory tool as ephemeral", () => {
    for (const tool of MEMORY_TOOLS) expect(EPHEMERAL_TOOLS.has(tool), tool).toBe(true);
  });
});

// Find the lone `subagent` transcript part across all turns (test helper).
function findSubagentCard(state: State, subagentId: string): any {
  for (const turn of state.turns as any[]) {
    for (const part of turn.parts) {
      if (part.kind === "subagent" && part.subagentId === subagentId) return part;
    }
  }
  return null;
}

function withAssistantTurn(sessionId: string, messageId: string): State {
  const s0 = { ...initialState(), sessionId } as State;
  return r(s0, { kind: "agent.message.start", payload: { sessionId, messageId } });
}

describe("agent reducer — message.start + text delta", () => {
  it("accumulates text deltas into a single text part", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, { kind: "agent.text.delta", payload: { sessionId: "sess-1", delta: "Hello " } });
    s = r(s, { kind: "agent.text.delta", payload: { sessionId: "sess-1", delta: "world" } });
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0].role).toBe("assistant");
    expect(s.turns[0].parts).toEqual([{ kind: "text", text: "Hello world" }]);
  });

  it("starts a new text part if a non-text part intervenes", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, { kind: "agent.text.delta", payload: { sessionId: "sess-1", delta: "before " } });
    s = r(s, {
      kind: "agent.tool.input_start",
      payload: { sessionId: "sess-1", toolCallId: "tc-1", tool: "search_documents" },
    });
    s = r(s, { kind: "agent.text.delta", payload: { sessionId: "sess-1", delta: "after" } });
    const parts = s.turns[0].parts;
    expect(parts.filter((p: any) => p.kind === "text").map((p: any) => p.text)).toEqual([
      "before ",
      "after",
    ]);
  });
});

describe("agent reducer — terminal context exhaustion", () => {
  const failure = {
    code: "context_window_exceeded",
    message:
      "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.",
    retryable: false,
    backend: "openai-compatible",
    model: "fictional-model",
  };

  it("freezes the conversation from the authoritative message.end payload", () => {
    let state = withAssistantTurn("sess-context", "message-context");
    state = r({ ...state, busy: true }, {
      kind: "agent.message.end",
      payload: {
        sessionId: "sess-context",
        messageId: "message-context",
        stopReason: "error",
        failure,
        context: {
          measurement: "provider_reported",
          limitSource: "provider",
          requestIteration: 1,
        },
      },
    });

    expect(state.busy).toBe(false);
    expect(state.terminalFailure).toEqual({
      ...failure,
      context: {
        measurement: "provider_reported",
        limitSource: "provider",
        requestIteration: 1,
      },
    });
    expect(state.turns[0].error).toBeUndefined();
  });

  it("does not freeze from the preceding live agent.error signal", () => {
    const state = r(withAssistantTurn("sess-context", "message-context"), {
      kind: "agent.error",
      payload: {
        sessionId: "sess-context",
        messageId: "message-context",
        code: "context_window_exceeded",
        message: failure.message,
      },
    });

    expect(state.terminalFailure).toBeNull();
  });

  it("restores and clears durable terminal state on resume and reset", () => {
    let state = r(initialState(), {
      kind: "load-conversation",
      sessionId: "sess-context",
      model: "fictional-model",
      backend: "openai-compatible",
      messages: [],
      terminalFailure: { ...failure, failedAt: "2026-07-29T12:00:00.000Z" },
    });
    expect(state.terminalFailure?.code).toBe("context_window_exceeded");

    state = r(state, {
      kind: "reset-conversation",
      sessionId: "sess-new",
      model: "fictional-model",
      backend: "openai-compatible",
    });
    expect(state.terminalFailure).toBeNull();
  });

  it("does not carry an old terminal failure into a different session", () => {
    const exhausted = {
      ...initialState(),
      sessionId: "sess-old",
      terminalFailure: { ...failure, failedAt: "2026-07-29T12:00:00.000Z" },
    } as State;

    const state = r(exhausted, {
      kind: "session-ready",
      sessionId: "sess-new",
      model: "fictional-model",
      backend: "openai-compatible",
      client: {},
    });

    expect(state.terminalFailure).toBeNull();
  });
});

describe("agent reducer — authoritative output truncation", () => {
  const message = "The model reached its output limit before completing this response.";

  it("marks the partial assistant turn from message.end without freezing the conversation", () => {
    let state = withAssistantTurn("sess-truncated", "message-truncated");
    state = r({ ...state, busy: true }, {
      kind: "agent.message.end",
      payload: {
        sessionId: "sess-truncated",
        messageId: "message-truncated",
        stopReason: "max_tokens",
        failure: {
          code: "output_truncated",
          message,
          retryable: false,
          backend: "openai-compatible",
          model: "fictional-model",
        },
      },
    });

    expect(state.busy).toBe(false);
    expect(state.terminalFailure).toBeNull();
    expect(state.turns[0]).toMatchObject({
      done: true,
      stopReason: "max_tokens",
      error: message,
    });
  });

  it("does not mark or settle the turn from a live agent.error breadcrumb", () => {
    const state = r({ ...withAssistantTurn("sess-truncated", "message-truncated"), busy: true }, {
      kind: "agent.error",
      payload: {
        sessionId: "sess-truncated",
        messageId: "message-truncated",
        code: "output_truncated",
        message,
      },
    });

    expect(state.busy).toBe(true);
    expect(state.turns[0].error).toBeUndefined();
  });

  it("restores the partial-answer marker from durable resume metadata", () => {
    const state = r(initialState(), {
      kind: "load-conversation",
      sessionId: "sess-truncated",
      model: "fictional-model",
      backend: "openai-compatible",
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Explain the constraints." }] },
        { role: "assistant", parts: [{ kind: "text", text: "The first constraint is" }] },
      ],
      lastTurnFailure: {
        code: "output_truncated",
        message,
        retryable: false,
        backend: "openai-compatible",
        model: "fictional-model",
      },
    });

    expect(state.turns.at(-1)).toMatchObject({
      role: "assistant",
      error: message,
      stopReason: "max_tokens",
    });
    expect(state.terminalFailure).toBeNull();
  });
});

describe("agent reducer — tool lifecycle", () => {
  it("input_start stub → start upgrades same part in place", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.input_start",
      payload: { sessionId: "sess-1", toolCallId: "tc-1", tool: "search_documents" },
    });
    const beforeTools = s.turns[0].parts.filter((p: any) => p.kind === "tool");
    expect(beforeTools).toHaveLength(1);
    expect(beforeTools[0].args).toBeNull();

    s = r(s, {
      kind: "agent.tool.start",
      payload: {
        sessionId: "sess-1",
        toolCallId: "tc-1",
        tool: "search_documents",
        args: { query: "paris apartment" },
      },
    });
    const afterTools = s.turns[0].parts.filter((p: any) => p.kind === "tool");
    expect(afterTools).toHaveLength(1);
    expect(afterTools[0].tool).toBe("search_documents");
    expect(afterTools[0].args).toEqual({ query: "paris apartment" });
    expect(afterTools[0].argsSummary).toBe("paris apartment");
  });

  it("tool.start without prior input_start appends a new tool part", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.start",
      payload: {
        sessionId: "sess-1",
        toolCallId: "tc-1",
        tool: "fetch_document",
        args: { documentId: "doc-1234" },
      },
    });
    const tools = s.turns[0].parts.filter((p: any) => p.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].tool).toBe("fetch_document");
  });

  it("tool.result fills duration + result on the matching stub", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.start",
      payload: { sessionId: "sess-1", toolCallId: "tc-1", tool: "search_documents", args: { query: "x" } },
    });
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        toolCallId: "tc-1",
        result: { kind: "search.results", results: [] },
        durationMs: 42,
      },
    });
    const tool = s.turns[0].parts.find((p: any) => p.kind === "tool");
    expect(tool.durationMs).toBe(42);
    expect(tool.result).toEqual({ kind: "search.results", results: [] });
  });

  it("out-of-order tool.result with no matching start is dropped (no stub injected)", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    const before = s.turns[0].parts.length;
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        toolCallId: "tc-unknown",
        result: { kind: "search.results", results: [] },
        durationMs: 10,
      },
    });
    expect(s.turns[0].parts).toHaveLength(before);
  });
});

describe("agent reducer — dedupe + session gating (Task 18)", () => {
  it("duplicate message.start with same id is a no-op", () => {
    const s0 = { ...initialState(), sessionId: "sess-1" } as State;
    const s1 = r(s0, { kind: "agent.message.start", payload: { sessionId: "sess-1", messageId: "msg-1" } });
    expect(s1.turns).toHaveLength(1);
    const s2 = r(s1, { kind: "agent.message.start", payload: { sessionId: "sess-1", messageId: "msg-1" } });
    // Reducer should keep the same turns array reference (no-op).
    expect(s2.turns).toHaveLength(1);
    expect(s2.turns[0]).toBe(s1.turns[0]);
  });

  it("duplicate tool.input_start with same id does not push a second stub", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.input_start",
      payload: { sessionId: "sess-1", toolCallId: "tc-dup", tool: "search_documents" },
    });
    s = r(s, {
      kind: "agent.tool.input_start",
      payload: { sessionId: "sess-1", toolCallId: "tc-dup", tool: "search_documents" },
    });
    const tools = s.turns[0].parts.filter((p: any) => p.kind === "tool" && p.toolCallId === "tc-dup");
    expect(tools).toHaveLength(1);
  });

  it("message.end from a different sessionId is ignored", () => {
    let s = withAssistantTurn("sess-active", "msg-1");
    s = { ...s, busy: true };
    const stale = r(s, {
      kind: "agent.message.end",
      payload: { sessionId: "sess-stale", messageId: "msg-1", stopReason: "end_turn" },
    });
    expect(stale.busy).toBe(true);
    expect(stale.turns[0].done).toBe(false);

    const matching = r(s, {
      kind: "agent.message.end",
      payload: { sessionId: "sess-active", messageId: "msg-1", stopReason: "end_turn" },
    });
    expect(matching.busy).toBe(false);
    expect(matching.turns[0].done).toBe(true);
  });

  it("agent.error creates an assistant error turn when no assistant started", () => {
    let s = { ...initialState(), sessionId: "sess-1", busy: true } as State;
    s = r(s, {
      kind: "agent.error",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-err",
        code: "http_request_error",
        message: "The operation was aborted due to timeout",
        provider: { status: 503, code: "upstream_unavailable" },
      },
    });
    expect(s.busy).toBe(false);
    expect(s.turns).toHaveLength(1);
    // The sentence stands alone; the code and the provider's disposition ride
    // beside it so the bubble can set them apart instead of running them
    // together into one line of prose.
    expect(s.turns[0]).toMatchObject({
      id: "msg-err",
      role: "assistant",
      parts: [],
      done: true,
      error: "The operation was aborted due to timeout",
      failure: {
        code: "http_request_error",
        message: "The operation was aborted due to timeout",
        detail: "HTTP 503 · upstream_unavailable",
      },
    });
  });

  it("agent.error updates the matching assistant turn instead of duplicating it", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = { ...s, busy: true };
    s = r(s, {
      kind: "agent.error",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        code: "send_failed",
        message: "upstream failed",
      },
    });
    expect(s.busy).toBe(false);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]).toMatchObject({
      id: "msg-1",
      error: "upstream failed",
      failure: { code: "send_failed", detail: null },
      done: true,
    });
  });

  it("send failure after a user attempt does not corrupt the prior assistant answer", () => {
    let s = withAssistantTurn("sess-1", "answer-1");
    s = r(s, {
      kind: "user-send",
      text: "Continue",
      optimisticId: "user-2",
    });
    s = r(s, {
      kind: "agent.error",
      payload: { code: "send_failed", message: "Backend probe failed." },
    });

    expect(s.turns.at(-3)).not.toHaveProperty("error");
    expect(s.turns.at(-2)).toMatchObject({ id: "user-2", role: "user" });
    expect(s.turns.at(-1)).toMatchObject({
      role: "assistant",
      error: "Backend probe failed.",
      failure: { code: "send_failed" },
      done: true,
    });
  });
});

describe("agent reducer — plan panel", () => {
  it("clears the completed turn's plan only when a local follow-up starts", () => {
    const state = {
      ...withAssistantTurn("sess-1", "msg-1"),
      planItems: [{ id: "p1", label: "Summarize", status: "done" }],
    };

    const next = r(state, {
      kind: "user-send",
      text: "Continue",
      optimisticId: "user-2",
    });

    expect(next.planItems).toEqual([]);
  });

  it("agent.tool.result with plan.updated replaces planItems", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    expect(s.planItems).toEqual([]);
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-plan-1",
        durationMs: 3,
        result: {
          kind: "plan.updated",
          items: [
            { id: "p1", label: "Search", status: "in_progress" },
            { id: "p2", label: "Summarize", status: "pending" },
          ],
        },
      },
    });
    expect(s.planItems).toEqual([
      { id: "p1", label: "Search", status: "in_progress" },
      { id: "p2", label: "Summarize", status: "pending" },
    ]);
  });

  it("plan tool calls do NOT pollute the transcript turn parts", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.input_start",
      payload: { sessionId: "sess-1", messageId: "msg-1", toolCallId: "tc-plan-1", tool: "plan" },
    });
    s = r(s, {
      kind: "agent.tool.start",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-plan-1",
        tool: "plan",
        args: { add: ["a", "b"] },
      },
    });
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-plan-1",
        durationMs: 2,
        result: {
          kind: "plan.updated",
          items: [{ id: "p1", label: "a", status: "in_progress" }],
        },
      },
    });
    // No tool part was added; planItems were set instead.
    expect(s.turns[0].parts.filter((p: any) => p.kind === "tool")).toHaveLength(0);
    expect(s.planItems).toHaveLength(1);
  });

  it("subsequent plan.updated replaces (not appends to) planItems", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-1",
        durationMs: 2,
        result: {
          kind: "plan.updated",
          items: [
            { id: "p1", label: "a", status: "in_progress" },
            { id: "p2", label: "b", status: "pending" },
          ],
        },
      },
    });
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-2",
        durationMs: 2,
        result: {
          kind: "plan.updated",
          items: [
            { id: "p1", label: "a", status: "done" },
            { id: "p2", label: "b", status: "in_progress" },
          ],
        },
      },
    });
    expect(s.planItems).toEqual([
      { id: "p1", label: "a", status: "done" },
      { id: "p2", label: "b", status: "in_progress" },
    ]);
  });

  it("reset-conversation clears planItems", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-1",
        durationMs: 2,
        result: { kind: "plan.updated", items: [{ id: "p1", label: "a", status: "in_progress" }] },
      },
    });
    expect(s.planItems).toHaveLength(1);
    s = r(s, {
      kind: "reset-conversation",
      sessionId: "sess-2",
      model: "demo",
      backend: "replay",
    });
    expect(s.planItems).toEqual([]);
  });

  it("load-conversation does not repopulate planItems from history", () => {
    let s = { ...initialState() } as State;
    s = r(s, {
      kind: "load-conversation",
      sessionId: "sess-r",
      model: "demo",
      backend: "replay",
      // History containing a plan tool_use block — must NOT seed planItems
      // (the panel is for live in-flight progress only).
      messages: [
        { role: "user", parts: [{ kind: "text", text: "hi" }] },
        {
          role: "assistant",
          parts: [
            {
              kind: "tool_use",
              toolCallId: "tc-plan",
              tool: "plan",
              args: { add: ["x"] },
            },
            { kind: "text", text: "done" },
          ],
        },
      ],
    });
    expect(s.planItems).toEqual([]);
  });

  it("load-conversation with a brief origin hides the seed prefix and pins the snapshot", () => {
    const origin = {
      kind: "brief",
      briefId: "brief_1",
      runId: "run_1",
      brief: {
        title: "Return the borrowed projector",
        description: "Back to the AV desk this week.",
        body: null,
      },
      seedMessageCount: 2,
    };
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-brief",
      model: "demo",
      backend: "replay",
      origin,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Loop agent run run_1 (kind: daily, attempt 1)." }] },
        { role: "assistant", parts: [{ kind: "text", text: "Composed the brief." }] },
        { role: "user", parts: [{ kind: "text", text: "Push it to Friday?" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Done." }] },
      ],
    });
    expect(s.briefOrigin).toEqual(origin);
    expect(s.turns).toHaveLength(2);
    expect((s.turns[0] as any).parts[0].text).toBe("Push it to Friday?");
  });

  it("does not reapply the origin seed count to a server-visible page", () => {
    const origin = {
      kind: "brief",
      briefId: "brief_1",
      runId: "run_1",
      brief: { title: "Review the launch checklist" },
      seedMessageCount: 2,
    };
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-visible",
      model: "demo",
      backend: "replay",
      origin,
      messagesAreVisible: true,
      messagePageInfo: { nextCursor: "older-1" },
      messageCount: 8,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "First visible question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "First visible answer" }] },
      ],
    });
    expect(s.turns).toHaveLength(2);
    expect((s.turns[0] as any).parts[0].text).toBe("First visible question");
    expect((s as any).messageNextCursor).toBe("older-1");
    expect((s as any).messageCount).toBe(8);
  });

  it("prepends a chronological older page and advances its cursor", () => {
    let s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-pages",
      model: "demo",
      backend: "replay",
      messagesAreVisible: true,
      messagePageInfo: { nextCursor: "older-1" },
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Newest question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Newest answer" }] },
      ],
    });
    s = r(s, {
      kind: "prepend-conversation-history",
      sessionId: "sess-pages",
      pageKey: "older-1",
      pageInfo: { nextCursor: null },
      messagesAreVisible: true,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Oldest question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Oldest answer" }] },
      ],
    });
    expect(
      s.turns.map((turn: any) => turn.parts.find((part: any) => part.kind === "text")?.text),
    ).toEqual([
      "Oldest question",
      "Oldest answer",
      "Newest question",
      "Newest answer",
    ]);
    expect(new Set(s.turns.map((turn: any) => turn.id)).size).toBe(4);
    expect((s as any).messageNextCursor).toBeNull();
  });

  it("keeps newer record metadata when an older page cites the same record", () => {
    const cite = (title: string) => ({
      role: "user",
      parts: [
        {
          kind: "tool_result",
          toolCallId: `cite-${title}`,
          result: {
            kind: "cite_record.recorded",
            recordKey: "row:example:1",
            semanticTime: "2026-01-02T00:00:00.000Z",
            title,
          },
        },
      ],
    });
    let s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-record-pages",
      model: "demo",
      backend: "replay",
      messagesAreVisible: true,
      messagePageInfo: { nextCursor: "older-records" },
      messages: [cite("New metadata")],
    });
    s = r(s, {
      kind: "prepend-conversation-history",
      sessionId: "sess-record-pages",
      pageKey: "older-records",
      pageInfo: { nextCursor: null },
      messagesAreVisible: true,
      messages: [cite("Old metadata")],
    });

    expect((s as any).recordCitations).toHaveLength(1);
    expect((s as any).recordCitations[0].record.title).toBe("New metadata");
  });

  it("ignores duplicate or stale older-history pages", () => {
    let s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-pages",
      model: "demo",
      backend: "replay",
      messagesAreVisible: true,
      messagePageInfo: { nextCursor: "older-1" },
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Newest question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Newest answer" }] },
      ],
    });
    const page = {
      kind: "prepend-conversation-history",
      sessionId: "sess-pages",
      pageKey: "older-1",
      pageInfo: { nextCursor: null },
      messagesAreVisible: true,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Oldest question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Oldest answer" }] },
      ],
    };
    s = r(s, page);
    const once = s;
    expect(r(s, page)).toBe(once);
    expect(
      r(s, { ...page, sessionId: "a-different-session", pageKey: "older-2" }),
    ).toBe(once);
  });

  it("exhausts history when an endpoint repeats the requested cursor", () => {
    let s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-pages",
      model: "demo",
      backend: "replay",
      messagesAreVisible: true,
      messagePageInfo: { nextCursor: "older-1" },
      messages: [],
    });
    s = r(s, {
      kind: "prepend-conversation-history",
      sessionId: "sess-pages",
      pageKey: "older-1",
      pageInfo: { nextCursor: "older-1" },
      messages: [],
    });
    expect((s as any).messageNextCursor).toBeNull();
    expect((s as any).messagePagingTruncated).toBe(true);
  });

  it("stops an advancing empty history page without claiming the transcript is complete", () => {
    let s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-empty-page",
      model: "demo",
      backend: "replay",
      messagesAreVisible: true,
      messagePageInfo: { nextCursor: "older-1" },
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Newest question" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Newest answer" }] },
      ],
    });
    const before = s.turns;

    s = r(s, {
      kind: "prepend-conversation-history",
      sessionId: "sess-empty-page",
      pageKey: "older-1",
      pageInfo: { nextCursor: "older-2" },
      messages: [],
    });

    expect(s.turns).toBe(before);
    expect((s as any).messageNextCursor).toBeNull();
    expect((s as any).messagePagingTruncated).toBe(true);
  });

  it("rejects a duplicate visible history page even when its cursor advances", () => {
    const messages = [
      { role: "user", parts: [{ kind: "text", text: "Repeated question" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Repeated answer" }] },
    ];
    let s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-duplicate-page",
      model: "demo",
      backend: "replay",
      messagesAreVisible: true,
      messagePageInfo: { nextCursor: "older-1" },
      messages,
    });
    const before = s.turns;

    s = r(s, {
      kind: "prepend-conversation-history",
      sessionId: "sess-duplicate-page",
      pageKey: "older-1",
      pageInfo: { nextCursor: "older-2" },
      messages,
    });

    expect(s.turns).toBe(before);
    expect((s as any).messageNextCursor).toBeNull();
    expect((s as any).messagePagingTruncated).toBe(true);
  });

  it("a brief origin without a snapshot leaves the transcript fully visible", () => {
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-brief-old",
      model: "demo",
      backend: "replay",
      origin: { kind: "brief", briefId: "brief_1", runId: "run_1" },
      messages: [
        { role: "user", parts: [{ kind: "text", text: "seed" }] },
        { role: "assistant", parts: [{ kind: "text", text: "seeded" }] },
      ],
    });
    expect(s.turns).toHaveLength(2);
  });

  it("load-conversation with a watch-firing origin hides the hidden briefing", () => {
    // The seed here is the prompt that told the agent what to write. Without
    // the origin decoded and a card to stand in its place, the operator
    // opens the thread on an internal instruction.
    const origin = {
      kind: "watch_firing",
      firingId: "sfiring_1",
      runId: "sfiring_1",
      watchId: "sub_1",
      watch: {
        name: "Marathon entry deadlines",
        condition: "a race I entered moves its registration deadline",
        firedAt: 1_789_344_600_000,
      },
      seedMessageCount: 1,
    };
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-watch",
      model: "demo",
      backend: "replay",
      origin,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "You are opening a new conversation…" }] },
        {
          role: "assistant",
          parts: [{ kind: "text", text: "The half marathon moved to 4 October." }],
        },
      ],
    });
    expect(s.briefOrigin).toEqual(origin);
    expect(s.turns).toHaveLength(1);
    expect((s.turns[0] as any).parts[0].text).toBe("The half marathon moved to 4 October.");
  });

  it("a watch-firing origin without a snapshot leaves the transcript fully visible", () => {
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-watch-bare",
      model: "demo",
      backend: "replay",
      origin: { kind: "watch_firing", firingId: "sfiring_1", runId: "sfiring_1", watchId: "sub_1" },
      messages: [
        { role: "user", parts: [{ kind: "text", text: "seed" }] },
        { role: "assistant", parts: [{ kind: "text", text: "seeded" }] },
      ],
    });
    expect(s.turns).toHaveLength(2);
  });

  it("reset-conversation clears briefOrigin", () => {
    let s = { ...initialState() } as State;
    (s as any).briefOrigin = { kind: "brief", briefId: "b", runId: "r" };
    s = r(s, { kind: "reset-conversation", sessionId: "sess-n", model: "m", backend: "b" });
    expect((s as any).briefOrigin).toBeNull();
  });

  it("steward tool calls are dropped from resumed interactive history", () => {
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-loop",
      model: "demo",
      backend: "replay",
      messages: [
        { role: "user", parts: [{ kind: "text", text: "mark the loop done" }] },
        {
          role: "assistant",
          parts: [
            {
              kind: "tool_use",
              toolCallId: "tc-loop",
              tool: "open_loop_update",
              args: { id: "loop_1" },
            },
            { kind: "text", text: "Done — resolved." },
          ],
        },
      ],
    });
    const assistant = s.turns[1] as any;
    expect(assistant.parts.every((p: any) => p.kind !== "tool")).toBe(true);
  });

  it("drops rollout-era temporal tool aliases from resumed history", () => {
    const s = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-temporal-alias",
      model: "demo",
      backend: "replay",
      messages: [
        { role: "user", parts: [{ kind: "text", text: "check the date" }] },
        {
          role: "assistant",
          parts: [
            {
              kind: "tool_use",
              toolCallId: "tc-temporal-alias",
              tool: "time_index_query",
              args: { from: "2026-07-23" },
            },
            { kind: "text", text: "That date is clear." },
          ],
        },
      ],
    });
    const assistant = s.turns[1] as any;
    expect(assistant.parts.every((part: any) => part.kind !== "tool")).toBe(true);
  });

  it("replaces stale live state with an authoritative busy same-session snapshot", () => {
    let s = { ...initialState(), sessionId: "sess-live" } as State;
    s = r(s, {
      kind: "user-send",
      text: "summarize launch notes",
      optimisticId: "u-local",
    });
    s = r(s, {
      kind: "agent.message.start",
      payload: { sessionId: "sess-live", messageId: "a-live" },
    });
    s = r(s, {
      kind: "agent.text.delta",
      payload: { sessionId: "sess-live", messageId: "a-live", delta: "Working " },
    });
    s = r(s, {
      kind: "agent.tool.input_start",
      payload: {
        sessionId: "sess-live",
        messageId: "a-live",
        toolCallId: "tc-search",
        tool: "search_documents",
      },
    });
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-live",
        messageId: "a-live",
        toolCallId: "tc-plan",
        durationMs: 2,
        result: {
          kind: "plan.updated",
          items: [{ id: "p1", label: "Read matching documents", status: "in_progress" }],
        },
      },
    });
    const beforeTurns = s.turns;
    expect(s.busy).toBe(true);
    expect(s.planItems).toHaveLength(1);

    const next = r(s, {
      kind: "load-conversation",
      sessionId: "sess-live",
      model: "demo-model-v2",
      backend: "http",
      busy: true,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "summarize launch notes" }] },
        { role: "assistant", parts: [{ kind: "text", text: "Authoritative snapshot" }] },
      ],
    });

    expect(next.busy).toBe(true);
    expect(next.model).toBe("demo-model-v2");
    expect(next.backend).toBe("http");
    expect(next.turns).not.toBe(beforeTurns);
    expect(next.turns.at(-1)?.parts).toEqual([
      { kind: "text", text: "Authoritative snapshot" },
    ]);
    expect(next.turns.at(-1)?.done).toBe(false);
    expect(next.planItems).toEqual([]);
  });

  it("busy load-conversation seeds an empty view without marking the turn done", () => {
    const next = r({ ...initialState() } as State, {
      kind: "load-conversation",
      sessionId: "sess-live",
      model: "demo-model",
      backend: "http",
      busy: true,
      messages: [{ role: "user", parts: [{ kind: "text", text: "summarize launch notes" }] }],
    });

    expect(next.sessionId).toBe("sess-live");
    expect(next.busy).toBe(true);
    expect(next.turns).toEqual([
      {
        id: "u-0",
        role: "user",
        parts: [{ kind: "text", text: "summarize launch notes" }],
        done: true,
      },
    ]);
  });

  it("stale busy load-conversation does not resurrect busy after turn end", () => {
    let s = { ...initialState(), sessionId: "sess-live" } as State;
    s = r(s, {
      kind: "user-send",
      text: "summarize launch notes",
      optimisticId: "u-local",
    });
    s = r(s, {
      kind: "agent.message.start",
      payload: { sessionId: "sess-live", messageId: "a-live" },
    });
    s = r(s, {
      kind: "agent.text.delta",
      payload: { sessionId: "sess-live", messageId: "a-live", delta: "Done." },
    });
    s = r(s, {
      kind: "agent.message.end",
      payload: { sessionId: "sess-live", messageId: "a-live", stopReason: "end_turn" },
    });
    expect(s.busy).toBe(false);
    const beforeTurns = s.turns;

    const next = r(s, {
      kind: "load-conversation",
      sessionId: "sess-live",
      model: "demo-model-v2",
      backend: "http",
      busy: true,
      // Response was captured while the turn was still busy, but it arrived
      // after message.end. It must not put the UI back into an in-flight state.
      messages: [{ role: "user", parts: [{ kind: "text", text: "summarize launch notes" }] }],
    });

    expect(next.busy).toBe(false);
    expect(next.model).toBe("demo-model-v2");
    expect(next.backend).toBe("http");
    expect(next.turns).toBe(beforeTurns);
    expect(next.turns.at(-1)).toMatchObject({ role: "assistant", done: true });
  });

  it("plan-clear wipes planItems", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-1",
        durationMs: 2,
        result: { kind: "plan.updated", items: [{ id: "p1", label: "a", status: "done" }] },
      },
    });
    expect(s.planItems).toHaveLength(1);
    s = r(s, { kind: "plan-clear" });
    expect(s.planItems).toEqual([]);
  });
});

describe("agent reducer — citations", () => {
  it("agent.citation appends entries to the matching doc and creates new ones", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    const ref = { documentId: "d-1", sourceId: "gmail:x", sourceType: "gmail", title: "Re: x" };
    s = r(s, {
      kind: "agent.citation",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-a",
        documentId: "d-1",
        ref,
        quote: "first quote",
      },
    });
    expect(s.citations).toHaveLength(1);
    expect(s.citations[0].entries[0].quote).toBe("first quote");
    // The originating assistant turn's citationCount bumps.
    expect(s.turns[0].citationCount).toBe(1);

    // Second cite on the same doc (also with a quote) → append entry,
    // count climbs. Quote cites route to entries[], not docNote.
    s = r(s, {
      kind: "agent.citation",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-b",
        documentId: "d-1",
        ref,
        quote: "second quote",
      },
    });
    expect(s.citations).toHaveLength(1);
    expect(s.citations[0].entries).toHaveLength(2);
    expect(s.turns[0].citationCount).toBe(2);

    // Different doc → second citation card.
    s = r(s, {
      kind: "agent.citation",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-c",
        documentId: "d-2",
        ref: { documentId: "d-2", sourceId: "gmail:x", sourceType: "gmail" },
        quote: "another quote",
      },
    });
    expect(s.citations).toHaveLength(2);
    expect(s.turns[0].citationCount).toBe(3);
  });

  it("agent.citation routes note-only to docNote (last-write wins)", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    const ref = { documentId: "d-1", sourceId: "gmail:x", sourceType: "gmail" };
    // Quote first — populates entries[].
    s = r(s, {
      kind: "agent.citation",
      payload: { sessionId: "sess-1", messageId: "msg-1", toolCallId: "q1", documentId: "d-1", ref, quote: "shipped" },
    });
    expect(s.citations[0].entries).toHaveLength(1);
    expect(s.citations[0].docNote).toBeUndefined();

    // Note-only — sets docNote, doesn't touch entries.
    s = r(s, {
      kind: "agent.citation",
      payload: { sessionId: "sess-1", messageId: "msg-1", toolCallId: "n1", documentId: "d-1", ref, note: "the canonical record" },
    });
    expect(s.citations[0].entries).toHaveLength(1);
    expect(s.citations[0].docNote).toBe("the canonical record");

    // Second note-only — overwrites docNote (last-write wins).
    s = r(s, {
      kind: "agent.citation",
      payload: { sessionId: "sess-1", messageId: "msg-1", toolCallId: "n2", documentId: "d-1", ref, note: "updated framing" },
    });
    expect(s.citations[0].entries).toHaveLength(1);
    expect(s.citations[0].docNote).toBe("updated framing");
    // Every cite call bumps the chip count, including note-only.
    expect(s.turns[0].citationCount).toBe(3);
  });

  it("quoteAuthor flows through agent.citation live event", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    const ref = { documentId: "d-1", sourceId: "gmail:x", sourceType: "gmail", title: "Re: plan" };
    s = r(s, {
      kind: "agent.citation",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-qa",
        documentId: "d-1",
        ref,
        quote: "confirmed by Dan",
        quoteAuthor: "Dan",
      },
    });
    expect(s.citations).toHaveLength(1);
    expect(s.citations[0].entries).toHaveLength(1);
    expect(s.citations[0].entries[0].quoteAuthor).toBe("Dan");
    expect(s.citations[0].entries[0].quote).toBe("confirmed by Dan");
  });

  it("quoteIsSelf flows through agent.citation into the grouped entry", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    const ref = { documentId: "d-1", sourceId: "gmail:x", sourceType: "gmail", title: "Re: plan" };
    // Self-authored quote → quoteIsSelf projects onto the entry.
    s = r(s, {
      kind: "agent.citation",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-self",
        documentId: "d-1",
        ref,
        quote: "I confirmed the date",
        quoteAuthor: "You",
        quoteIsSelf: true,
      },
    });
    expect(s.citations[0].entries[0].quoteIsSelf).toBe(true);

    // Third-party quote on a different doc → quoteIsSelf stays absent/falsy.
    s = r(s, {
      kind: "agent.citation",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "tc-other",
        documentId: "d-2",
        ref: { documentId: "d-2", sourceId: "gmail:x", sourceType: "gmail" },
        quote: "confirmed by Dan",
        quoteAuthor: "Dan",
      },
    });
    expect(s.citations[1].entries[0].quoteIsSelf).toBeFalsy();
  });

  it("agent.citations.update adds + removes docs", () => {
    let s = initialState() as State;
    s = r(s, {
      kind: "agent.citations.update",
      payload: {
        sessionId: null,
        added: [
          { documentId: "d-1", title: "First", sourceId: "gmail:x", sourceType: "gmail" },
          { documentId: "d-2", title: "Second", sourceId: "gmail:x", sourceType: "gmail" },
        ],
        removed: [],
      },
    });
    expect(s.citations).toHaveLength(2);

    // Duplicate add → no-op.
    s = r(s, {
      kind: "agent.citations.update",
      payload: {
        sessionId: null,
        added: [{ documentId: "d-1", title: "First again", sourceId: "gmail:x", sourceType: "gmail" }],
        removed: [],
      },
    });
    expect(s.citations).toHaveLength(2);

    // Remove keeps index map consistent.
    s = r(s, {
      kind: "agent.citations.update",
      payload: { sessionId: null, added: [], removed: ["d-1"] },
    });
    expect(s.citations).toHaveLength(1);
    expect(s.citations[0].documentId).toBe("d-2");
    expect(s.citationsByDocId.get("d-2")).toBe(0);
  });
});

describe("chatMessagesToTurns", () => {
  it("prefers the record's own failure over the one lifted from the marker", () => {
    // Both sources describe the same turn, but only the record carries the
    // provider's disposition, so a conversation stored since the record kept
    // one must not fall back to the marker's thinner account.
    let s = r(initialState() as State, {
      kind: "load-conversation",
      sessionId: "sess-1",
      model: "m",
      backend: "http",
      messagesAreVisible: true,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "What is on the schedule?" }] },
        {
          role: "assistant",
          parts: [
            {
              kind: "text",
              text: "Model request failed: http_api_error: The provider has no such model.",
            },
          ],
        },
      ],
      lastTurnFailure: {
        code: "http_api_error",
        message: "The model provider does not have the assigned model (HTTP 404).",
        retryable: true,
        backend: "http",
        model: "m",
        provider: { status: 404, code: "NOT_FOUND", param: "model" },
      },
    } as never);
    const last = s.turns.at(-1)!;
    expect(last.parts).toEqual([]);
    expect(last.stopReason).toBeUndefined();
    expect(last.failure).toMatchObject({
      code: "http_api_error",
      detail: "HTTP 404 · NOT_FOUND · param=model",
    });
  });

  it("renders a resumed failed turn as a failure, not as assistant prose", () => {
    // Reopening the conversation must not turn the failure into something the
    // assistant appears to have said, with the code buried mid-sentence.
    const turns = chatMessagesToTurns([
      { role: "user", parts: [{ kind: "text", text: "What is on the schedule?" }] },
      {
        role: "assistant",
        parts: [
          {
            kind: "text",
            text: "Model request failed: http_api_error: The model provider does not have the assigned model (HTTP 404).",
          },
        ],
      },
    ]);
    expect(turns[1].parts).toEqual([]);
    expect(turns[1]).toMatchObject({
      error: "The model provider does not have the assigned model (HTTP 404).",
      failure: {
        code: "http_api_error",
        message: "The model provider does not have the assigned model (HTTP 404).",
      },
    });
  });

  it("keeps the answer a failed turn produced before it died", () => {
    const turns = chatMessagesToTurns([
      { role: "user", parts: [{ kind: "text", text: "Summarize the audit." }] },
      {
        role: "assistant",
        parts: [
          {
            kind: "text",
            text: "Studio Northstar handled it.\n\nModel request failed: http_stream_error: The model closed the connection.",
          },
        ],
      },
    ]);
    expect(turns[1].parts).toEqual([{ kind: "text", text: "Studio Northstar handled it." }]);
    expect(turns[1].failure?.code).toBe("http_stream_error");
  });

  it("renders a reopened stopped turn as a stop, not as a failure", () => {
    // Live, a stopped turn ends with no error affordance at all; reopened, it
    // must not come back as a red failure block with the code beneath it.
    const turns = chatMessagesToTurns([
      { role: "user", parts: [{ kind: "text", text: "Summarize the audit." }] },
      {
        role: "assistant",
        parts: [
          {
            kind: "text",
            text: "Studio Northstar handled it.\n\nModel request failed: canceled: You stopped this reply.",
          },
        ],
      },
    ]);
    expect(turns[1].parts).toEqual([{ kind: "text", text: "Studio Northstar handled it." }]);
    expect(turns[1].stopReason).toBe("canceled");
    expect(turns[1].stopped).toBe("You stopped this reply.");
    expect(turns[1].error).toBeUndefined();
    expect(turns[1].failure).toBeUndefined();
  });

  it("leaves an answer that quotes the marker mid-sentence intact", () => {
    // The user pastes a gateway log line and asks what it means. The reply is
    // an answer, not a failure, and reopening the conversation must not strip
    // its tail into a red error bubble.
    const answer =
      "That line — Model request failed: http_api_error: no such model — means the id is wrong.";
    const turns = chatMessagesToTurns([
      { role: "user", parts: [{ kind: "text", text: "What does this log line mean?" }] },
      { role: "assistant", parts: [{ kind: "text", text: answer }] },
    ]);
    expect(turns[1].parts).toEqual([{ kind: "text", text: answer }]);
    expect(turns[1].failure).toBeUndefined();
  });

  it("leaves ordinary assistant prose that merely mentions a failure alone", () => {
    const turns = chatMessagesToTurns([
      { role: "user", parts: [{ kind: "text", text: "What went wrong?" }] },
      {
        role: "assistant",
        parts: [{ kind: "text", text: "The invoice says the model request failed on Tuesday." }],
      },
    ]);
    expect(turns[1].parts).toHaveLength(1);
    expect(turns[1].failure).toBeUndefined();
  });

  it("drops thinking parts when loading conversation history", () => {
    // Thinking blocks are a transient live-stream indicator (like the
    // ephemeral tool cards) — they must never reappear when a past
    // conversation is reopened. The reducer drops them on rebuild; the
    // canonical ConversationStore record is untouched server-side.
    const messages = [
      { role: "user", parts: [{ kind: "text", text: "who handled the Q4 audit?" }] },
      {
        role: "assistant",
        parts: [
          { kind: "thinking", text: "Let me search the engagement letter, then check the invoice dates." },
          { kind: "text", text: "Studio Northstar handled it." },
        ],
      },
    ];
    const turns = chatMessagesToTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[1].role).toBe("assistant");
    // No thinking part survives the rebuild.
    expect(turns[1].parts.some((p: any) => p.kind === "thinking")).toBe(false);
    // The answer text is kept.
    const texts = turns[1].parts.filter((p: any) => p.kind === "text").map((p: any) => p.text);
    expect(texts).toContain("Studio Northstar handled it.");
  });

  it("reconstructs user + assistant turns with inlined tool results", () => {
    // Uses `annotate` because it's NOT in the ephemeral set, so its
    // tool_use + tool_result pair survives the rebuild. The ephemeral
    // tools (search / fetch / sql / trace_connections) are filtered on
    // resume — see the next test.
    const ref = { documentId: "d-Q", sourceType: "gmail", sourceId: "gmail:self" };
    const messages = [
      { role: "user", parts: [{ kind: "text", text: "find emails from Q" }] },
      {
        role: "assistant",
        parts: [
          { kind: "text", text: "Searching." },
          { kind: "tool_use", toolCallId: "t1", tool: "annotate", args: { documentId: "d-Q", note: "matches" } },
        ],
      },
      {
        role: "user",
        parts: [{ kind: "tool_result", toolCallId: "t1", result: { kind: "annotate.recorded", documentId: "d-Q", ref, note: "matches" } }],
      },
      { role: "assistant", parts: [{ kind: "text", text: "Found nothing." }] },
    ];
    const turns = chatMessagesToTurns(messages);
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[0].parts[0].text).toBe("find emails from Q");

    expect(turns[1].role).toBe("assistant");
    const tool = turns[1].parts.find((p: any) => p.kind === "tool");
    expect(tool.toolCallId).toBe("t1");
    expect(tool.result).toEqual({ kind: "annotate.recorded", documentId: "d-Q", ref, note: "matches" });
    const texts = turns[1].parts.filter((p: any) => p.kind === "text").map((p: any) => p.text);
    expect(texts).toContain("Searching.");
    expect(texts).toContain("Found nothing.");
  });

  it("drops ephemeral tool_use parts when loading conversation history", () => {
    // The ephemeral tools (search / fetch / sql / trace_connections)
    // render as rolling-slot cards during live streaming and then
    // dismiss themselves. On resume the rolling animation must NOT
    // replay — the cleanest implementation is to drop those tool_use
    // blocks (and their matching tool_results) from the reconstructed
    // transcript entirely. The canonical ConversationStore record is
    // untouched server-side; this is purely a client-side display
    // filter.
    const messages = [
      { role: "user", parts: [{ kind: "text", text: "find gift ideas" }] },
      {
        role: "assistant",
        parts: [
          { kind: "text", text: "Searching." },
          { kind: "tool_use", toolCallId: "t1", tool: "search_documents", args: { query: "gifts" } },
          { kind: "tool_use", toolCallId: "t2", tool: "fetch_document", args: { documentId: "d-1" } },
          { kind: "tool_use", toolCallId: "t3", tool: "run_sql", args: { sql: "SELECT 1" } },
          { kind: "tool_use", toolCallId: "t4", tool: "trace_connections", args: { seedIds: ["d-1"] } },
        ],
      },
      {
        role: "user",
        parts: [
          { kind: "tool_result", toolCallId: "t1", result: { kind: "search.results", results: [] } },
          { kind: "tool_result", toolCallId: "t2", result: { kind: "document", ref: { documentId: "d-1" } } },
          { kind: "tool_result", toolCallId: "t3", result: { kind: "sql.rows", columns: [], rows: [], rowCount: 0 } },
          { kind: "tool_result", toolCallId: "t4", result: { kind: "event_trail.built", seeds: [], events: [], truncated: false, stats: { visited: 0, elapsedMs: 0, maxDepthReached: 0 } } },
        ],
      },
      { role: "assistant", parts: [{ kind: "text", text: "Done." }] },
    ];
    const turns = chatMessagesToTurns(messages);
    const tools = turns[1].parts.filter((p: any) => p.kind === "tool");
    // Every ephemeral tool_use is filtered out of the resumed transcript.
    expect(tools).toHaveLength(0);
    // The non-tool text parts (which actually answer the user) are kept.
    const texts = turns[1].parts.filter((p: any) => p.kind === "text").map((p: any) => p.text);
    expect(texts).toContain("Searching.");
    expect(texts).toContain("Done.");
  });

  it("can rebuild observable ephemeral tool activity for a local audit transcript", () => {
    const messages = [
      { role: "user", parts: [{ kind: "text", text: "Find the invented plan." }] },
      { role: "assistant", parts: [{
        kind: "tool_use",
        toolCallId: "search-1",
        tool: "search_documents",
        args: { query: "invented plan" },
      }] },
      { role: "user", parts: [{
        kind: "tool_result",
        toolCallId: "search-1",
        result: { kind: "search.results", results: [] },
      }] },
      { role: "assistant", parts: [{ kind: "text", text: "No matching plan was found." }] },
    ];

    const turns = chatMessagesToTurns(messages, { includeEphemeralTools: true });
    const tool = turns[1].parts.find((part: any) => part.kind === "tool");
    expect(tool).toMatchObject({
      toolCallId: "search-1",
      tool: "search_documents",
      result: { kind: "search.results", results: [] },
    });
    expect(turns[1].parts).toContainEqual({ kind: "text", text: "No matching plan was found." });
  });

  it("persisted tool_use renders as 'args resolved' — argsSummary set, args present, not a streaming stub", () => {
    // The renderer reads `args == null` as "input_start fired but
    // tool.start hasn't" and shows a "building query…" stub. Resumed
    // tool entries must mirror the post-`tool.start` shape so the
    // renderer paints the finalized header. Uses `annotate` because
    // it's not in the ephemeral-on-resume filter.
    const ref = { documentId: "abc-doc-id", sourceType: "gmail", sourceId: "gmail:self" };
    const messages = [
      { role: "user", parts: [{ kind: "text", text: "walk the doc graph" }] },
      {
        role: "assistant",
        parts: [
          {
            kind: "tool_use",
            toolCallId: "t1",
            tool: "annotate",
            args: { documentId: "abc-doc-id", note: "anchor" },
          },
        ],
      },
      {
        role: "user",
        parts: [{ kind: "tool_result", toolCallId: "t1", result: { kind: "annotate.recorded", documentId: "abc-doc-id", ref, note: "anchor" } }],
      },
    ];
    const turns = chatMessagesToTurns(messages);
    const tool = turns[1].parts.find((p: any) => p.kind === "tool");
    expect(tool).toBeDefined();
    // Args preserved on the part — renderer's `call.args != null` check
    // is what flips it out of the streaming-stub state.
    expect(tool.args).toEqual({ documentId: "abc-doc-id", note: "anchor" });
    // The `annotate` summarizer prefixes the document id (24 chars).
    expect(tool.argsSummary).toContain("abc-doc-id");
    expect(tool.args).not.toBeNull();
  });
});

describe("agent reducer — conversation-not-found", () => {
  it("clears the live turn state and stashes the bogus id for the banner", () => {
    let s = { ...initialState(), sessionId: "sess-1" } as State;
    s = r(s, { kind: "agent.message.start", payload: { sessionId: "sess-1", messageId: "msg-1" } });
    s = r(s, { kind: "agent.text.delta", payload: { sessionId: "sess-1", delta: "hi" } });
    expect(s.turns).toHaveLength(1);

    const next = r(s, { kind: "conversation-not-found", convoId: "bogus-id" });
    expect(next.notFoundConvoId).toBe("bogus-id");
    expect(next.sessionId).toBeNull();
    expect(next.turns).toHaveLength(0);
    expect(next.busy).toBe(false);
  });

  it("load-conversation clears the not-found banner", () => {
    let s = { ...initialState() } as State;
    s = r(s, { kind: "conversation-not-found", convoId: "bogus-id" });
    expect(s.notFoundConvoId).toBe("bogus-id");
    s = r(s, {
      kind: "load-conversation",
      sessionId: "sess-2",
      model: "m",
      backend: "b",
      messages: [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
    });
    expect(s.notFoundConvoId).toBeNull();
  });
});

describe("agent reducer — agent-unconfigured", () => {
  it("stashes the config snapshot so the view can render setup guidance", () => {
    const s0 = { ...initialState() } as State;
    expect(s0.agentConfig).toBeNull();
    const cfg = { backend: "off", enabled: false, disabledReason: "Agent disabled." };
    const next = r(s0, { kind: "agent-unconfigured", config: cfg });
    expect(next.agentConfig).toEqual(cfg);
  });

  it("preserves a null disabledReason", () => {
    const cfg = { backend: "off", enabled: false, disabledReason: null };
    const next = r({ ...initialState() } as State, { kind: "agent-unconfigured", config: cfg });
    expect(next.agentConfig?.enabled).toBe(false);
    expect(next.agentConfig?.disabledReason).toBeNull();
  });
});

describe("citationsFromMessages", () => {
  it("does NOT include search hits or fetched docs", () => {
    // A tool_result of kind=search.results or kind=document must not
    // contribute to citations — only annotate.recorded does.
    const messages = [
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "a",
            result: {
              kind: "search.results",
              results: [{ documentId: "d-1", sourceId: "gmail:x", sourceType: "gmail" }],
            },
          },
          {
            kind: "tool_result",
            toolCallId: "b",
            result: {
              kind: "document",
              ref: { documentId: "d-2", sourceId: "gmail:x", sourceType: "gmail" },
            },
          },
        ],
      },
    ];
    expect(citationsFromMessages(messages)).toEqual([]);
  });

  it("routes note-only annotate to docNote, quote annotate to entries", () => {
    const ref = { documentId: "d-1", sourceId: "gmail:x", sourceType: "gmail" };
    const messages = [
      { role: "user", parts: [{ kind: "text", text: "anything?" }] },
      {
        role: "assistant",
        parts: [
          { kind: "tool_use", toolCallId: "tc-q", tool: "annotate", args: { documentId: "d-1", quote: "shipped" } },
          { kind: "tool_use", toolCallId: "tc-n", tool: "annotate", args: { documentId: "d-1", note: "the canonical record" } },
        ],
      },
      {
        role: "user",
        parts: [
          { kind: "tool_result", toolCallId: "tc-q", result: { kind: "annotate.recorded", documentId: "d-1", ref, quote: "shipped" } },
          { kind: "tool_result", toolCallId: "tc-n", result: { kind: "annotate.recorded", documentId: "d-1", ref, note: "the canonical record" } },
        ],
      },
    ];
    const cits = citationsFromMessages(messages);
    expect(cits).toHaveLength(1);
    expect(cits[0].docNote).toBe("the canonical record");
    expect(cits[0].entries).toHaveLength(1);
    expect(cits[0].entries[0].quote).toBe("shipped");
  });

  it("last note-only annotate wins for docNote", () => {
    const ref = { documentId: "d-1", sourceId: "gmail:x", sourceType: "gmail" };
    const messages = [
      {
        role: "assistant",
        parts: [
          { kind: "tool_use", toolCallId: "n1", tool: "annotate", args: { documentId: "d-1", note: "first" } },
          { kind: "tool_use", toolCallId: "n2", tool: "annotate", args: { documentId: "d-1", note: "second" } },
        ],
      },
      {
        role: "user",
        parts: [
          { kind: "tool_result", toolCallId: "n1", result: { kind: "annotate.recorded", documentId: "d-1", ref, note: "first" } },
          { kind: "tool_result", toolCallId: "n2", result: { kind: "annotate.recorded", documentId: "d-1", ref, note: "second" } },
        ],
      },
    ];
    const cits = citationsFromMessages(messages);
    expect(cits).toHaveLength(1);
    expect(cits[0].docNote).toBe("second");
    expect(cits[0].entries).toEqual([]);
  });

  it("aggregates annotate + annotate.recorded", () => {
    const ref = { documentId: "d-1", sourceId: "gmail:x", sourceType: "gmail" };
    const messages = [
      { role: "user", parts: [{ kind: "text", text: "anything?" }] },
      {
        role: "assistant",
        parts: [
          {
            kind: "tool_use",
            toolCallId: "tc-1",
            tool: "annotate",
            args: { documentId: "d-1", quote: "shipped" },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "tc-1",
            result: { kind: "annotate.recorded", documentId: "d-1", ref, quote: "shipped" },
          },
        ],
      },
      { role: "assistant", parts: [{ kind: "text", text: "yes" }] },
    ];
    const cits = citationsFromMessages(messages);
    expect(cits).toHaveLength(1);
    expect(cits[0].documentId).toBe("d-1");
    expect(cits[0].entries[0].quote).toBe("shipped");
  });

});

describe("agent reducer — ephemeral causality gate", () => {
  // Helpers — keep each test focused on the gate semantics, not the
  // SSE envelope shape.
  function inputStart(toolCallId: string, tool: string) {
    return {
      kind: "agent.tool.input_start",
      payload: { sessionId: "sess-1", toolCallId, tool },
    };
  }
  function toolStart(toolCallId: string, tool: string, args: any) {
    return {
      kind: "agent.tool.start",
      payload: { sessionId: "sess-1", toolCallId, tool, args },
    };
  }
  function toolResult(toolCallId: string, result: any) {
    return {
      kind: "agent.tool.result",
      payload: { sessionId: "sess-1", toolCallId, result, durationMs: 1 },
    };
  }
  function textDelta(delta: string) {
    return { kind: "agent.text.delta", payload: { sessionId: "sess-1", delta } };
  }
  function flush(toolCallId: string) {
    return { kind: "ephemeral-tail-flush", toolCallId };
  }
  function setupSearchWithResult(): State {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, inputStart("tc-1", "search_documents"));
    s = r(s, toolStart("tc-1", "search_documents", { query: "x" }));
    s = r(s, toolResult("tc-1", {
      kind: "search.results",
      results: [{ documentId: "d1", sourceType: "gmail", sourceId: "g", title: "x" }],
    }));
    return s;
  }

  it("text deltas after an ephemeral result are buffered, not appended", () => {
    let s = setupSearchWithResult();
    // Snapshot the parts before the buffered events.
    const partsBefore = s.turns[0].parts;
    s = r(s, textDelta("Found one result. "));
    s = r(s, textDelta("Opening it now."));
    // No text part appended to the turn — both deltas live in pendingTail.
    expect(s.turns[0].parts).toHaveLength(partsBefore.length);
    const gate: any = s.turns[0].parts.find((p: any) => p.toolCallId === "tc-1");
    expect(gate.pendingTail).toHaveLength(2);
    expect(gate.tailDismissed).toBe(false);
    expect(gate.pendingTail[0]).toMatchObject({ kind: "agent.text.delta" });
  });

  it("ephemeral-tail-flush drains the queue in order onto the turn", () => {
    let s = setupSearchWithResult();
    s = r(s, textDelta("Hello "));
    s = r(s, textDelta("world."));
    s = r(s, flush("tc-1"));
    const gate: any = s.turns[0].parts.find((p: any) => p.toolCallId === "tc-1");
    expect(gate.tailDismissed).toBe(true);
    expect(gate.pendingTail).toEqual([]);
    // The two deltas have been consolidated into one trailing text part.
    const texts = s.turns[0].parts.filter((p: any) => p.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe("Hello world.");
    // Text part lands AFTER the tool, preserving causality.
    const lastTwo = s.turns[0].parts.slice(-2);
    expect(lastTwo[0].kind).toBe("tool");
    expect(lastTwo[1].kind).toBe("text");
  });

  it("a SECOND ephemeral tool that arrives while a gate is active is also buffered", () => {
    let s = setupSearchWithResult();
    // Mid-rotation: text starts arriving, then a second tool call kicks off.
    s = r(s, textDelta("Found it. "));
    s = r(s, inputStart("tc-2", "fetch_document"));
    s = r(s, toolStart("tc-2", "fetch_document", { documentId: "doc-1" }));
    s = r(s, toolResult("tc-2", {
      kind: "document",
      ref: { documentId: "doc-1", sourceType: "gmail", sourceId: "g" },
      document: { content: "body" },
    }));
    // Both the text AND the entire tc-2 lifecycle should be on tc-1's
    // queue. tc-2 must NOT yet appear in turn.parts.
    const gate: any = s.turns[0].parts.find((p: any) => p.toolCallId === "tc-1");
    expect(gate.pendingTail).toHaveLength(4); // text + 3 tc-2 events
    expect(s.turns[0].parts.find((p: any) => p.toolCallId === "tc-2")).toBeUndefined();
  });

  it("flushing tc-1 promotes tc-2 to the turn AND makes tc-2 the new gate", () => {
    let s = setupSearchWithResult();
    s = r(s, textDelta("Found it. "));
    s = r(s, inputStart("tc-2", "fetch_document"));
    s = r(s, toolStart("tc-2", "fetch_document", { documentId: "doc-1" }));
    s = r(s, toolResult("tc-2", {
      kind: "document",
      ref: { documentId: "doc-1", sourceType: "gmail", sourceId: "g" },
      document: { content: "body" },
    }));
    s = r(s, flush("tc-1"));
    // tc-2 is now in parts AND has its result; tc-1 stays present but dismissed.
    const tc1: any = s.turns[0].parts.find((p: any) => p.toolCallId === "tc-1");
    const tc2: any = s.turns[0].parts.find((p: any) => p.toolCallId === "tc-2");
    expect(tc1.tailDismissed).toBe(true);
    expect(tc2).toBeDefined();
    expect(tc2.tool).toBe("fetch_document");
    expect(tc2.result?.kind).toBe("document");
    // tc-2's pendingTail is initialised (it's an ephemeral tool) but empty.
    expect(tc2.pendingTail).toEqual([]);
    expect(tc2.tailDismissed).toBe(false);
    // Order: tc-1 → text → tc-2 (the text was queued before the second tool).
    const ordered = s.turns[0].parts.map((p: any) => p.kind === "tool" ? `tool:${p.toolCallId}` : p.kind);
    expect(ordered).toEqual(["tool:tc-1", "text", "tool:tc-2"]);
  });

  it("text arriving AFTER tc-2's result (still in tc-1's window) lands on tc-2's tail after flush", () => {
    // Reproduces the user's worst case: card 1 → text → card 2 → more
    // text, all racing in before card 1 finishes. After card 1 flushes,
    // card 2 should absorb the trailing text as its own gate.
    let s = setupSearchWithResult();
    s = r(s, textDelta("a"));
    s = r(s, inputStart("tc-2", "fetch_document"));
    s = r(s, toolStart("tc-2", "fetch_document", { documentId: "doc-1" }));
    s = r(s, toolResult("tc-2", {
      kind: "document",
      ref: { documentId: "doc-1", sourceType: "gmail", sourceId: "g" },
      document: { content: "body" },
    }));
    s = r(s, textDelta("b")); // arrives AFTER tc-2's result, still tc-1's window
    s = r(s, flush("tc-1"));
    // Post-flush: tc-2 must now be the gate, with "b" on ITS tail.
    const tc2: any = s.turns[0].parts.find((p: any) => p.toolCallId === "tc-2");
    expect(tc2.tailDismissed).toBe(false);
    expect(tc2.pendingTail).toHaveLength(1);
    expect(tc2.pendingTail[0]).toMatchObject({ kind: "agent.text.delta", payload: { delta: "b" } });
    // The first text ("a") landed before tc-2 in the turn.
    const ordered = s.turns[0].parts.map((p: any) => p.kind === "tool" ? `tool:${p.toolCallId}` : p.kind);
    expect(ordered).toEqual(["tool:tc-1", "text", "tool:tc-2"]);
    const text: any = s.turns[0].parts.find((p: any) => p.kind === "text");
    expect(text.text).toBe("a");
  });

  it("flushing tc-2 then drains its tail, completing the causality chain", () => {
    let s = setupSearchWithResult();
    s = r(s, textDelta("a"));
    s = r(s, inputStart("tc-2", "fetch_document"));
    s = r(s, toolStart("tc-2", "fetch_document", { documentId: "doc-1" }));
    s = r(s, toolResult("tc-2", {
      kind: "document",
      ref: { documentId: "doc-1", sourceType: "gmail", sourceId: "g" },
      document: { content: "body" },
    }));
    s = r(s, textDelta("b"));
    s = r(s, flush("tc-1"));
    s = r(s, flush("tc-2"));
    const tc2: any = s.turns[0].parts.find((p: any) => p.toolCallId === "tc-2");
    expect(tc2.tailDismissed).toBe(true);
    expect(tc2.pendingTail).toEqual([]);
    // Final shape: tc-1 → text("a") → tc-2 → text("b").
    const ordered = s.turns[0].parts.map((p: any) =>
      p.kind === "tool" ? `tool:${p.toolCallId}` : `${p.kind}:${p.text ?? ""}`,
    );
    expect(ordered).toEqual(["tool:tc-1", "text:a", "tool:tc-2", "text:b"]);
  });

  it("non-ephemeral tool calls never become a gate", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    // `annotate` isn't in EPHEMERAL_TOOLS, so its result doesn't
    // activate a causality gate and subsequent text appends straight
    // onto the turn.
    s = r(s, inputStart("tc-1", "annotate"));
    s = r(s, toolStart("tc-1", "annotate", { documentId: "d1", note: "x" }));
    s = r(s, toolResult("tc-1", { kind: "annotate.recorded", documentId: "d1", ref: { documentId: "d1", sourceType: "gmail", sourceId: "gmail:self" }, note: "x" }));
    // Following text should append normally (no buffering).
    s = r(s, textDelta("answer"));
    const texts = s.turns[0].parts.filter((p: any) => p.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe("answer");
    const tool: any = s.turns[0].parts.find((p: any) => p.kind === "tool");
    // annotate isn't ephemeral — pendingTail is undefined, not [].
    expect(tool.pendingTail).toBeUndefined();
  });

  it("interactive memory tools gate following prose until their card dismisses", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, inputStart("memory-1", "annotate_person"));
    s = r(s, toolStart("memory-1", "annotate_person", {}));
    s = r(s, toolResult("memory-1", {
      kind: "structured",
      resultType: "person_annotation.created",
      data: {},
    }));
    s = r(s, textDelta("Remembered."));

    const tool: any = s.turns[0].parts.find((p: any) => p.kind === "tool");
    expect(tool.pendingTail).toHaveLength(1);
    expect(s.turns[0].parts.some((p: any) => p.kind === "text")).toBe(false);

    s = r(s, flush("memory-1"));
    expect(s.turns[0].parts.find((p: any) => p.kind === "text")?.text).toBe("Remembered.");
  });

  it("text deltas arriving BEFORE the result land normally (no gate yet)", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, inputStart("tc-1", "search_documents"));
    s = r(s, toolStart("tc-1", "search_documents", { query: "x" }));
    // No result yet → no gate → the text appends as a normal part.
    s = r(s, textDelta("waiting…"));
    const ordered = s.turns[0].parts.map((p: any) => p.kind);
    expect(ordered).toEqual(["tool", "text"]);
  });

  it("an ephemeral tool ERROR result still gates following text, and flush drains it", () => {
    // A failed tool returns the shared `{ kind: "error" }` result. The
    // gate keys off the *presence* of a result, not its kind, so the
    // agent's following text must still be buffered until the card
    // finishes its dismiss animation. This is the reducer half of the
    // deadlock fixed in `components/agent/parts.js`: the card used to
    // begin its dismiss lifecycle only on a success-shaped result, so an
    // error left it spinning forever and these buffered deltas never
    // flushed — only a page refresh (which rebuilds without gating)
    // surfaced the answer.
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, inputStart("tc-1", "run_sql"));
    s = r(s, toolStart("tc-1", "run_sql", { sql: "SELECT bogus" }));
    s = r(s, toolResult("tc-1", { kind: "error", code: "sql_error", message: "no such column" }));
    s = r(s, textDelta("That query failed. "));
    s = r(s, textDelta("Let me try another."));
    const gate: any = s.turns[0].parts.find((p: any) => p.toolCallId === "tc-1");
    expect(gate.pendingTail).toHaveLength(2);
    expect(gate.tailDismissed).toBe(false);
    // The flush the (fixed) card now reliably dispatches drains the queue.
    s = r(s, flush("tc-1"));
    const drained: any = s.turns[0].parts.find((p: any) => p.toolCallId === "tc-1");
    expect(drained.tailDismissed).toBe(true);
    const texts = s.turns[0].parts.filter((p: any) => p.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0].text).toBe("That query failed. Let me try another.");
  });

  it("a stale flush for an unknown / already-dismissed tool is a safe no-op", () => {
    let s = setupSearchWithResult();
    s = r(s, textDelta("buffered"));
    s = r(s, flush("tc-1"));
    const before = s;
    // Second flush for the same id must not double-drain.
    s = r(s, flush("tc-1"));
    expect(s).toEqual(before);
    // Flush for a never-seen id is also a no-op.
    s = r(s, flush("tc-nonexistent"));
    expect(s).toEqual(before);
  });
});

describe("summarizeArgs", () => {
  it("formats search_documents with its limit", () => {
    expect(summarizeArgs("search_documents", { query: "paris", limit: 10 })).toBe(
      "paris (limit=10)",
    );
  });

  it("collapses fetch_document to the first 24 chars of the id", () => {
    expect(summarizeArgs("fetch_document", { documentId: "abcdefghijklmnopqrstuvwxyz" })).toHaveLength(24);
  });

  it("collapses lookup_people to just the query string", () => {
    expect(summarizeArgs("lookup_people", { query: "Quentin" })).toBe("Quentin");
  });

  it("collapses lookup_document_by_url to the URL, truncating at 80 chars with an ellipsis", () => {
    const short = "https://drive.google.com/file/d/abc/view";
    expect(summarizeArgs("lookup_document_by_url", { url: short })).toBe(short);
    const long = "https://drive.google.com/file/d/" + "a".repeat(100) + "/view";
    const out = summarizeArgs("lookup_document_by_url", { url: long });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildUnifiedTimeline", () => {
  // Only `annotate` (byDoc) and `cite_record` (records) feed the Timeline;
  // a `trace_connections` graph walk's raw output never reaches it.
  function annot(
    documentId: string,
    ts: number | undefined,
    opts: any = {},
  ): Record<string, any> {
    return {
      [documentId]: {
        ref: {
          documentId,
          sourceType: opts.sourceType ?? "gmail",
          sourceId: opts.sourceId ?? "gmail:self",
          documentType: opts.documentType ?? "email",
          title: opts.title ?? documentId,
          ...(opts.mimeType ? { mimeType: opts.mimeType } : {}),
          ...(ts !== undefined ? { ts } : {}),
        },
        quotes: opts.quotes ?? [{ quote: "grounds a claim" }],
        ...(opts.note ? { note: opts.note } : {}),
      },
    };
  }
  function recordEvent(recordKey: string, at: string | null, opts: any = {}) {
    return {
      eventId: opts.eventId ?? recordKey,
      at,
      kind: opts.kind ?? "record",
      record: {
        recordKey,
        table: opts.table ?? "fitness.workouts",
        tableDisplayName: opts.tableDisplayName ?? "Workouts",
        title: opts.title ?? "Morning run",
        keyFields: opts.keyFields ?? [{ label: "Distance", value: "5.2 km" }],
        semanticTime: at ?? "1970-01-01T00:00:00Z",
        sourceId: opts.sourceId ?? "demo-fitness:self",
        sourceType: opts.sourceType ?? "demo-fitness",
        boundDocumentId: opts.boundDocumentId ?? null,
        snapshot: opts.snapshot ?? { distance_km: 5.2 },
      },
      attachments: [],
      people: [],
      related: [],
    };
  }

  it("returns an empty list when given no annotations and no records", () => {
    expect(buildUnifiedTimeline({}, [])).toEqual([]);
    expect(buildUnifiedTimeline(undefined as any, undefined as any)).toEqual([]);
  });

  it("synthesises a Timeline row for an annotated document", () => {
    const byDoc = annot("d-orphan", 1_725_000_000_000, {
      sourceType: "whatsapp-messages",
      sourceId: "whatsapp-messages:self",
      documentType: "conversation",
      title: "Lone WhatsApp thread",
      quotes: [{ quote: "matters because" }],
    });
    const merged = buildUnifiedTimeline(byDoc, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].eventId).toBe("synth:doc:d-orphan");
    expect(merged[0].kind).toBe("document");
    expect(merged[0].doc.documentId).toBe("d-orphan");
    expect(merged[0].doc.sourceId).toBe("whatsapp-messages:self");
    expect(merged[0].doc.title).toBe("Lone WhatsApp thread");
    expect(typeof merged[0].at).toBe("string");
    expect(merged[0].at?.startsWith("20")).toBe(true);
    expect(merged[0].attachments).toEqual([]);
    expect(merged[0].people).toEqual([]);
    expect(merged[0].related).toEqual([]);
  });

  it("carries mimeType from the ref onto the synthesised row for file-type icons", () => {
    const byDoc = annot("d-pdf", 1_725_000_000_000, {
      sourceType: "gdrive",
      sourceId: "gdrive:self",
      documentType: "file",
      title: "Q4 Budget Review.pdf",
      mimeType: "application/pdf",
      quotes: [{ quote: "totals on page 2" }],
    });
    const merged = buildUnifiedTimeline(byDoc, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].doc.mimeType).toBe("application/pdf");
  });

  it("orders annotated documents chronologically by their ref timestamp", () => {
    const byDoc = {
      ...annot("d-b", Date.parse("2025-09-04T10:00:00Z")),
      ...annot("d-a", Date.parse("2025-09-01T09:00:00Z")),
      ...annot("d-c", Date.parse("2025-09-08T18:00:00Z")),
    };
    const merged = buildUnifiedTimeline(byDoc, []);
    expect(merged.map((e: any) => e.doc.documentId)).toEqual(["d-a", "d-b", "d-c"]);
  });

  it("places annotated docs with no timestamp after dated ones", () => {
    const byDoc = {
      ...annot("d-dated", Date.parse("2025-09-01T00:00:00Z")),
      ...annot("d-undated", undefined),
    };
    const merged = buildUnifiedTimeline(byDoc, []);
    expect(merged.map((e: any) => e.doc.documentId)).toEqual(["d-dated", "d-undated"]);
  });

  it("can't synthesise a row without a `ref` (silent skip)", () => {
    const byDoc = { "d-no-ref": { quotes: [{ quote: "lost in transit" }] } };
    expect(buildUnifiedTimeline(byDoc, [])).toEqual([]);
  });

  // Directly-cited records (`cite_record`) arrive via the `records`
  // param and interleave with annotated documents by semantic time.
  it("keeps a directly-cited record (records param) as a record-only row", () => {
    const merged = buildUnifiedTimeline({}, [
      recordEvent("row:fitness.workouts:42", "2025-09-04T07:30:00Z"),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].doc).toBeUndefined();
    expect(merged[0].record.recordKey).toBe("row:fitness.workouts:42");
  });

  it("interleaves annotated documents with cited records by time", () => {
    const byDoc = {
      ...annot("d-late", Date.parse("2025-09-08T18:00:00Z")),
      ...annot("d-early", Date.parse("2025-09-01T09:00:00Z")),
    };
    const records = [recordEvent("row:fitness.workouts:1", "2025-09-02T07:00:00Z")];
    const merged = buildUnifiedTimeline(byDoc, records);
    const ids = merged.map((e: any) => e.doc?.documentId ?? e.record.recordKey);
    expect(ids).toEqual(["d-early", "row:fitness.workouts:1", "d-late"]);
  });

  it("dedups a cited record by recordKey (first occurrence wins)", () => {
    const merged = buildUnifiedTimeline({}, [
      recordEvent("row:k:1", "2025-09-02T07:00:00Z", { title: "first" }),
      recordEvent("row:k:1", "2025-09-02T07:00:00Z", { title: "dup" }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].record.title).toBe("first");
  });

  it("orders undated cited records deterministically by recordKey", () => {
    const merged = buildUnifiedTimeline(annot("d-dated", Date.parse("2025-09-01T00:00:00Z")), [
      recordEvent("row:z", null),
      recordEvent("row:a", null),
    ]);
    const ids = merged.map((e: any) => e.doc?.documentId ?? e.record.recordKey);
    expect(ids).toEqual(["d-dated", "row:a", "row:z"]);
  });
});

describe("recordCitationsFromMessages", () => {
  function citeResult(recordKey: string, semanticTime: string, opts: any = {}) {
    return {
      kind: "cite_record.recorded",
      recordKey,
      table: opts.table ?? "fitness.workouts",
      tableDisplayName: opts.tableDisplayName ?? "Workouts",
      title: opts.title ?? "Morning run",
      keyFields: opts.keyFields ?? [{ label: "Distance", value: "5.2 km" }],
      semanticTime,
      sourceId: opts.sourceId ?? "demo-fitness:self",
      sourceType: opts.sourceType ?? "demo-fitness",
      boundDocumentId: opts.boundDocumentId ?? null,
      snapshot: opts.snapshot ?? { distance_km: 5.2 },
    };
  }
  const userMsg = (result: any) => ({
    role: "user",
    parts: [{ kind: "tool_result", toolCallId: "tc", result }],
  });

  it("maps cite_record.recorded results to record-only timeline events", () => {
    const events = recordCitationsFromMessages([
      userMsg(citeResult("row:k:1", "2025-09-02T07:00:00Z", { title: "Run A" })),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("record");
    expect(events[0].doc).toBeUndefined();
    expect(events[0].record.recordKey).toBe("row:k:1");
    expect(events[0].record.title).toBe("Run A");
    expect(events[0].at).toBe("2025-09-02T07:00:00Z");
  });

  it("dedups by recordKey (latest cite of a row wins)", () => {
    const events = recordCitationsFromMessages([
      userMsg(citeResult("row:k:1", "2025-09-02T07:00:00Z", { title: "stale" })),
      userMsg(citeResult("row:k:1", "2025-09-02T07:00:00Z", { title: "fresh" })),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].record.title).toBe("fresh");
  });

  it("ignores non-cite_record results and malformed records", () => {
    const events = recordCitationsFromMessages([
      userMsg({ kind: "annotate.recorded", documentId: "d-1", ref: {} }),
      userMsg({ kind: "cite_record.recorded", recordKey: "", semanticTime: "" }),
    ]);
    expect(events).toEqual([]);
  });
});

describe("trailAnnotationsFromMessages — ref capture", () => {
  it("captures the ref on the first annotate.recorded so synthesis can pick it up", () => {
    const ref = {
      documentId: "d-1",
      sourceType: "gmail",
      sourceId: "gmail:self",
      title: "subject line",
      ts: 1_725_300_000_000,
    };
    const messages = [
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "tc-1",
            result: { kind: "annotate.recorded", documentId: "d-1", ref, quote: "x" },
          },
        ],
      },
    ];
    const { byDoc } = trailAnnotationsFromMessages(messages);
    expect(byDoc["d-1"].ref).toEqual(ref);
  });

  it("captures quoteAuthor in byDoc quotes from annotate.recorded", () => {
    const ref = {
      documentId: "d-1",
      sourceType: "gmail",
      sourceId: "gmail:self",
      title: "subject line",
    };
    const messages = [
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "tc-1",
            result: {
              kind: "annotate.recorded",
              documentId: "d-1",
              ref,
              quote: "the relevant bit",
              quoteAuthor: "Elise",
            },
          },
        ],
      },
    ];
    const { byDoc } = trailAnnotationsFromMessages(messages);
    expect(byDoc["d-1"].quotes[0].quote).toBe("the relevant bit");
    expect(byDoc["d-1"].quotes[0].quoteAuthor).toBe("Elise");
  });

});

describe("reducer integration — unified Timeline", () => {
  function annotateRecorded(documentId: string, ref: any, quote?: string, note?: string) {
    return {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        toolCallId: `tc-${documentId}`,
        durationMs: 1,
        result: { kind: "annotate.recorded", documentId, ref, quote, note },
      },
    };
  }
  it("captures ref on byDoc[docId] when an annotate.recorded arrives live", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.start",
      payload: { sessionId: "sess-1", toolCallId: "tc-d1", tool: "annotate", args: { documentId: "d-1", quote: "x" } },
    });
    const ref = { documentId: "d-1", sourceType: "gmail", sourceId: "gmail:self", ts: 1_725_300_000_000 };
    s = r(s, annotateRecorded("d-1", ref, "x"));
    expect((s as any).trailAnnotations.byDoc["d-1"].ref).toEqual(ref);
  });

  it("buildUnifiedTimeline can synthesise from the live state's byDoc", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.start",
      payload: { sessionId: "sess-1", toolCallId: "tc-d1", tool: "annotate", args: { documentId: "d-1", note: "matters" } },
    });
    s = r(s, annotateRecorded(
      "d-1",
      { documentId: "d-1", sourceType: "gmail", sourceId: "gmail:self", ts: 1_725_300_000_000 },
      undefined,
      "matters",
    ));
    const events = buildUnifiedTimeline((s as any).trailAnnotations.byDoc, (s as any).recordCitations);
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe("synth:doc:d-1");
  });

  it("a trace_connections result contributes nothing to the Timeline (only annotate does)", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    // Annotate one doc → it is the sole Timeline row.
    s = r(s, {
      kind: "agent.tool.start",
      payload: { sessionId: "sess-1", toolCallId: "tc-d1", tool: "annotate", args: { documentId: "d-1", note: "matters" } },
    });
    s = r(s, annotateRecorded(
      "d-1",
      { documentId: "d-1", sourceType: "gmail", sourceId: "gmail:self", ts: 1_725_300_000_000 },
      undefined,
      "matters",
    ));
    // A trace_connections walk surfaces another doc — it must NOT reach the Timeline.
    s = r(s, {
      kind: "agent.tool.start",
      payload: { sessionId: "sess-1", toolCallId: "tc-trail", tool: "trace_connections", args: { seedIds: ["d-1"] } },
    });
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        toolCallId: "tc-trail",
        durationMs: 1,
        result: {
          kind: "event_trail.built",
          seeds: ["d-1"],
          events: [
            { eventId: "evt-x", at: "2025-09-01T00:00:00Z", kind: "document", doc: { documentId: "d-x", title: "walked", sourceId: "gmail:self", documentType: "email" }, attachments: [], people: [], related: [] },
          ],
          truncated: false,
          stats: { visited: 1, elapsedMs: 1, maxDepthReached: 1 },
        },
      },
    });
    const events = buildUnifiedTimeline((s as any).trailAnnotations.byDoc, (s as any).recordCitations);
    // Only the annotated doc — the walked doc (d-x) is absent.
    expect(events.map((e: any) => e.doc?.documentId ?? e.record?.recordKey)).toEqual(["d-1"]);
    // The reducer no longer keeps a `trails` state slot at all.
    expect((s as any).trails).toBeUndefined();
  });
});

// ─── Sub-agent card ───────────────────────────────────────────────

describe("agent reducer — sub-agent card", () => {
  it("does not rebuild spawn or join controls from a completed transcript", () => {
    const s = r(initialState() as State, {
      kind: "load-conversation",
      sessionId: "sess-1",
      model: "demo",
      backend: "replay",
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Compare two planning periods" }] },
        {
          role: "assistant",
          parts: [
            { kind: "tool_use", toolCallId: "spawn-1", tool: "spawn_subagent", args: { task: "Compare independently" } },
            { kind: "tool_use", toolCallId: "join-1", tool: "join_subagents", args: { subagentIds: ["sub-1"] } },
            { kind: "text", text: "The plans differ in scope." },
          ],
        },
      ],
    });

    const assistant = s.turns.at(-1) as any;
    expect(assistant.parts).toEqual([{ kind: "text", text: "The plans differ in scope." }]);
  });

  it("rebuilds intermediate parent text and child progress from a busy runtime snapshot", () => {
    let s = r(initialState() as State, {
      kind: "load-conversation",
      sessionId: "sess-live",
      model: "demo",
      backend: "replay",
      busy: true,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Compare two planning periods" }] },
        {
          role: "assistant",
          parts: [
            { kind: "text", text: "I’ll compare those independently. " },
            { kind: "tool_use", toolCallId: "spawn-1", tool: "spawn_subagent", args: { task: "Compare independently" } },
            { kind: "tool_use", toolCallId: "join-1", tool: "join_subagents", args: { subagentIds: ["sub-1"] } },
          ],
        },
      ],
    });
    s = r(s, {
      kind: "agent.message.start",
      payload: { sessionId: "sess-live", messageId: "msg-live" },
    });
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-live", subagentId: "sub-1", specialist: "generic", task: "Compare independently" },
    });
    s = r(s, {
      kind: "agent.subagent.event",
      payload: {
        sessionId: "sess-live",
        subagentId: "sub-1",
        event: { type: "agent.usage.update", payload: { messageId: "child-1", usage: { outputTokens: 18 } } },
      },
    });

    const assistant = s.turns.at(-1) as any;
    expect(s.turns.filter((turn: any) => turn.role === "assistant")).toHaveLength(1);
    expect(assistant.done).toBe(false);
    expect(assistant.parts.filter((part: any) => part.kind === "text")).toEqual([
      { kind: "text", text: "I’ll compare those independently. " },
    ]);
    expect(assistant.parts.some((part: any) => part.kind === "tool")).toBe(false);
    expect(findSubagentCard(s, "sub-1")?.tokens).toBe(18);
  });

  it("keeps spawn controls ephemeral, hides join plumbing, and retains the child card", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.input_start",
      payload: { sessionId: "sess-1", messageId: "msg-1", toolCallId: "spawn-1", tool: "spawn_subagent" },
    });
    s = r(s, {
      kind: "agent.tool.start",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "spawn-1",
        tool: "spawn_subagent",
        args: { task: "Compare two independent periods" },
      },
    });
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "spawn-1",
        result: { kind: "subagent.spawned", subagentId: "sub-1" },
        durationMs: 2,
      },
    });
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: {
        sessionId: "sess-1",
        subagentId: "sub-1",
        specialist: "generic",
        task: "Compare two independent periods",
        parentToolCallId: "spawn-1",
      },
    });
    s = r(s, {
      kind: "agent.tool.input_start",
      payload: { sessionId: "sess-1", messageId: "msg-1", toolCallId: "join-1", tool: "join_subagents" },
    });
    s = r(s, {
      kind: "agent.tool.start",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "join-1",
        tool: "join_subagents",
        args: { subagentIds: ["sub-1"] },
      },
    });
    s = r(s, { kind: "ephemeral-tail-flush", toolCallId: "spawn-1" });

    const assistant = s.turns.at(-1) as any;
    const tools = assistant.parts.filter((part: any) => part.kind === "tool");
    expect(tools).toEqual([]);
    expect(findSubagentCard(s, "sub-1")).not.toBeNull();
  });

  it("drains queued tail content then purges orchestration controls at message end", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.tool.start",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "spawn-1",
        tool: "spawn_subagent",
        args: { task: "Inspect evidence" },
      },
    });
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: "sess-1",
        messageId: "msg-1",
        toolCallId: "spawn-1",
        result: { kind: "subagent.spawned", subagentId: "sub-1" },
        durationMs: 1,
      },
    });
    s = r(s, {
      kind: "agent.text.delta",
      payload: { sessionId: "sess-1", messageId: "msg-1", delta: "Final comparison." },
    });
    s = r(s, {
      kind: "agent.message.end",
      payload: { sessionId: "sess-1", messageId: "msg-1", stopReason: "end_turn" },
    });

    const assistant = s.turns.at(-1) as any;
    expect(assistant.parts.filter((part: any) => part.kind === "text")).toEqual([
      { kind: "text", text: "Final comparison." },
    ]);
    expect(assistant.parts.some(
      (part: any) => part.kind === "tool" && ["spawn_subagent", "join_subagents"].includes(part.tool),
    )).toBe(false);
    expect(assistant.done).toBe(true);
  });

  it("agent.subagent.spawned pushes a card onto the current assistant turn", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: {
        sessionId: "sess-1",
        subagentId: "sess-1.sub.ab12",
        specialist: "history-sweep",
        task: "Sweep Q3 for the marathon-entry thread",
        parentToolCallId: "tc-spawn-1",
      },
    });
    const card = findSubagentCard(s, "sess-1.sub.ab12");
    expect(card).not.toBeNull();
    expect(card.kind).toBe("subagent");
    expect(card.specialist).toBe("history-sweep");
    expect(card.task).toBe("Sweep Q3 for the marathon-entry thread");
    expect(card.parentToolCallId).toBe("tc-spawn-1");
    // Counters start at zero; status is null while in flight.
    expect(card.stepCount).toBe(0);
    expect(card.tokens).toBe(0);
    expect(card.status).toBeNull();
    expect(card.childTurns).toEqual([]);
  });

  it("keeps a generic worker in the ordinary transcript without arming Deep Research", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: {
        sessionId: "sess-1",
        subagentId: "sess-1.sub.generic",
        specialist: "generic",
        title: "Compare quarterly plans",
        task: "Compare the two independent planning periods",
      },
    });

    expect(findSubagentCard(s, "sess-1.sub.generic")).not.toBeNull();
    expect(s.deepResearch).toBe(false);
    expect(isResearchWorkspaceActive(s)).toBe(false);
  });

  it("duplicate agent.subagent.spawned for the same id is a no-op", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    const spawned = {
      kind: "agent.subagent.spawned",
      payload: {
        sessionId: "sess-1",
        subagentId: "sess-1.sub.ab12",
        specialist: "history-sweep",
        task: "Sweep the quarter",
      },
    };
    s = r(s, spawned);
    s = r(s, spawned);
    const cards = (s.turns[0].parts as any[]).filter((p) => p.kind === "subagent");
    expect(cards).toHaveLength(1);
  });

  it("tracks pending tools without retaining unrendered child prose", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", task: "T" },
    });
    const wrap = (event: any) => ({
      kind: "agent.subagent.event",
      payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", event },
    });
    s = r(s, wrap({ type: "agent.message.start", payload: { sessionId: "k1", messageId: "cm-1" } }));
    s = r(s, wrap({ type: "agent.text.delta", payload: { sessionId: "k1", delta: "Looking… " } }));
    s = r(s, wrap({ type: "agent.text.delta", payload: { sessionId: "k1", delta: "found it." } }));
    s = r(
      s,
      wrap({
        type: "agent.tool.start",
        payload: { sessionId: "k1", toolCallId: "ct-1", tool: "search_documents", args: { query: "x" } },
      }),
    );
    const card = findSubagentCard(s, "k1");
    expect(card.childTurns).toHaveLength(1);
    const parts = card.childTurns[0].parts;
    expect(parts.filter((p: any) => p.kind === "text")).toEqual([]);
    expect(parts.find((p: any) => p.kind === "tool")?.tool).toBe("search_documents");
    // The child tool call is one step.
    expect(card.stepCount).toBe(1);
  });

  it("agent.subagent.result finalises the card with status, summary, and token total", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", task: "T" },
    });
    s = r(s, {
      kind: "agent.subagent.result",
      payload: {
        sessionId: "sess-1",
        subagentId: "k1",
        specialist: "history-sweep",
        status: "complete",
        summary: "Found three relevant threads.",
        citations: [{ documentId: "cited-1", title: "Budget thread", sourceId: "alpha-mail:acct" }],
        usage: { inputTokens: 1200, outputTokens: 300 },
      },
    });
    const card = findSubagentCard(s, "k1");
    expect(card.status).toBe("complete");
    expect(card.summary).toBe("Found three relevant threads.");
    expect(card.tokens).toBe(1500);
    expect(card.retainedCitationCount).toBe(1);
  });

  it("retains deliberate citations on a failed result for the partial-result state", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-1", subagentId: "k1", specialist: "generic", task: "T" },
    });
    s = r(s, {
      kind: "agent.subagent.result",
      payload: {
        sessionId: "sess-1",
        subagentId: "k1",
        specialist: "generic",
        status: "failed",
        summary: "Partial evidence collected before the output limit.",
        citations: [{ documentId: "cited-1", title: "Project note", sourceId: "notes:local" }],
        failure: {
          code: "output_truncated",
          message: "The model reached its output limit.",
          retryable: false,
          backend: "http",
          model: "fictional-model",
        },
      },
    });

    const card = findSubagentCard(s, "k1");
    expect(card.status).toBe("failed");
    expect(card.retainedCitationCount).toBe(1);
    expect(card.failureCode).toBe("output_truncated");
    expect(card.docs.map((doc: any) => doc.documentId)).toEqual(["cited-1"]);
  });

  it("retains a cited non-truncation failure code without promoting it to partial", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-1", subagentId: "k1", specialist: "generic", task: "T" },
    });
    s = r(s, {
      kind: "agent.subagent.result",
      payload: {
        sessionId: "sess-1",
        subagentId: "k1",
        specialist: "generic",
        status: "failed",
        summary: "HTTP model request failed.",
        citations: [{ documentId: "cited-1", title: "Project note", sourceId: "notes:local" }],
        failure: {
          code: "http_api_error",
          message: "HTTP model request failed.",
          retryable: true,
          backend: "http",
          model: "fictional-model",
        },
      },
    });

    const card = findSubagentCard(s, "k1");
    expect(card.retainedCitationCount).toBe(1);
    expect(card.failureCode).toBe("http_api_error");
  });

  it("a child message.end usage accumulates onto tokens while running", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", task: "T" },
    });
    s = r(s, {
      kind: "agent.subagent.event",
      payload: {
        sessionId: "sess-1",
        subagentId: "k1",
        specialist: "history-sweep",
        event: {
          type: "agent.message.end",
          payload: { sessionId: "k1", messageId: "cm-1", stopReason: "end_turn", usage: { inputTokens: 800, outputTokens: 200 } },
        },
      },
    });
    expect(findSubagentCard(s, "k1").tokens).toBe(1000);
  });

  it("shows a child's cumulative live usage before its request ends", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, { kind: "agent.subagent.spawned", payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", task: "T" } });
    s = r(s, { kind: "agent.subagent.event", payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", event: { type: "agent.usage.update", payload: { sessionId: "k1", messageId: "cm-1", usage: { inputTokens: 800, outputTokens: 200 } } } } });
    expect(findSubagentCard(s, "k1").tokens).toBe(1000);
  });

  it("does not double-count live usage when the child request ends", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, { kind: "agent.subagent.spawned", payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", task: "T" } });
    const wrapped = (event) => ({ kind: "agent.subagent.event", payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", event } });
    s = r(s, wrapped({ type: "agent.usage.update", payload: { sessionId: "k1", messageId: "cm-1", usage: { inputTokens: 800, outputTokens: 200 } } }));
    s = r(s, wrapped({ type: "agent.message.end", payload: { sessionId: "k1", messageId: "cm-1", stopReason: "tool_use", usage: { inputTokens: 800, outputTokens: 200 } } }));
    s = r(s, wrapped({ type: "agent.usage.update", payload: { sessionId: "k1", messageId: "cm-2", usage: { inputTokens: 500, outputTokens: 100 } } }));
    expect(findSubagentCard(s, "k1").tokens).toBe(1600);
  });

  it("merges partial cumulative usage and ignores a duplicate terminal event", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, { kind: "agent.subagent.spawned", payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", task: "T" } });
    const wrapped = (event) => ({ kind: "agent.subagent.event", payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", event } });
    s = r(s, wrapped({ type: "agent.usage.update", payload: { sessionId: "k1", messageId: "cm-1", usage: { inputTokens: 100 } } }));
    s = r(s, wrapped({ type: "agent.usage.update", payload: { sessionId: "k1", messageId: "cm-1", usage: { outputTokens: 10 } } }));
    const end = { type: "agent.message.end", payload: { sessionId: "k1", messageId: "cm-1", stopReason: "tool_use", usage: { outputTokens: 20 } } };
    s = r(s, wrapped(end));
    s = r(s, wrapped(end));
    expect(findSubagentCard(s, "k1").tokens).toBe(120);
  });

  it("adds source documents as batch children settle", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", task: "T" },
    });
    s = r(s, {
      kind: "agent.subagent.event",
      payload: {
        sessionId: "sess-1",
        subagentId: "k1",
        specialist: "history-sweep",
        event: {
          type: "agent.tool.child.result",
          payload: {
            sessionId: "k1",
            messageId: "cm-1",
            toolCallId: "batch-1",
            childIndex: 0,
            result: { kind: "search.results", results: [{ documentId: "d1", title: "Ledger", sourceId: "drive:acct" }] },
          },
        },
      },
    });
    expect(findSubagentCard(s, "k1").docs).toEqual([
      { documentId: "d1", title: "Ledger", sourceId: "drive:acct" },
    ]);
  });

  it("retains source documents from a terminal batch when live child events are unavailable", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, { kind: "agent.subagent.spawned", payload: { sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep", task: "T" } });
    s = r(s, {
      kind: "agent.subagent.event",
      payload: {
        sessionId: "sess-1", subagentId: "k1", specialist: "history-sweep",
        event: {
          type: "agent.tool.result",
          payload: {
            sessionId: "k1", messageId: "cm-1", toolCallId: "batch-1", durationMs: 1,
            result: { kind: "search.batch", items: [{ kind: "search.results", results: [{ documentId: "d1", title: "Ledger", sourceId: "drive:acct" }] }] },
          },
        },
      },
    });
    expect(findSubagentCard(s, "k1").docs.map((doc) => doc.documentId)).toEqual(["d1"]);
  });

  it("agent.subagent.event for an unknown subagentId is a no-op (no card created)", () => {
    let s = withAssistantTurn("sess-1", "msg-1");
    s = r(s, {
      kind: "agent.subagent.event",
      payload: {
        sessionId: "sess-1",
        subagentId: "ghost",
        specialist: "history-sweep",
        event: { type: "agent.text.delta", payload: { sessionId: "ghost", delta: "hi" } },
      },
    });
    expect(findSubagentCard(s, "ghost")).toBeNull();
  });

  it("reconstructs a live researcher card after loading the parent prompt", () => {
    let s = r(initialState(), {
      kind: "load-conversation",
      sessionId: "sess-live",
      model: "test-model",
      backend: "test",
      busy: true,
      messages: [
        { role: "user", parts: [{ kind: "text", text: "Research the archive" }] },
        { role: "assistant", parts: [{ kind: "text", text: "" }] },
      ],
    });
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: {
        sessionId: "sess-live",
        subagentId: "sess-live.sub.reader",
        specialist: "archive-reader",
        title: "Archive reader",
        task: "Find relevant evidence",
      },
    });
    s = r(s, {
      kind: "agent.subagent.event",
      payload: {
        sessionId: "sess-live",
        subagentId: "sess-live.sub.reader",
        specialist: "archive-reader",
        event: {
          type: "agent.message.start",
          payload: { sessionId: "sess-live.sub.reader", messageId: "reader-turn" },
        },
      },
    });
    s = r(s, {
      kind: "agent.subagent.event",
      payload: {
        sessionId: "sess-live",
        subagentId: "sess-live.sub.reader",
        specialist: "archive-reader",
        event: {
          type: "agent.tool.start",
          payload: {
            sessionId: "sess-live.sub.reader",
            toolCallId: "search-1",
            tool: "search_documents",
            args: { query: "archive" },
          },
        },
      },
    });

    const card = findSubagentCard(s, "sess-live.sub.reader");
    expect(card).toMatchObject({ specialist: "archive-reader", stepCount: 1, status: null });
    expect(s.deepResearch).toBe(true);
    expect(s.turns.find((turn) => turn.role === "assistant")?.done).toBe(false);
  });
});

describe("reduceChildEvent — graceful degradation", () => {
  const base = () => ({
    kind: "subagent",
    subagentId: "k1",
    specialist: "history-sweep",
    task: "T",
    childTurns: [],
    stepCount: 0,
    tokens: 0,
    status: null,
    summary: null,
  });

  it("ignores an unknown child event kind, leaving the transcript unchanged", () => {
    const card = base();
    const next = reduceChild(card, { type: "agent.some.future.kind", payload: { whatever: 1 } });
    expect(next.childTurns).toEqual([]);
    expect(next.stepCount).toBe(0);
  });

  it("ignores a malformed child event (no type) without throwing", () => {
    const card = base();
    expect(() => reduceChild(card, null)).not.toThrow();
    expect(() => reduceChild(card, {})).not.toThrow();
    expect(reduceChild(card, {}).childTurns).toEqual([]);
  });

  it("does not mutate the input card (returns a fresh card)", () => {
    const card = base();
    const next = reduceChild(card, {
      type: "agent.message.start",
      payload: { sessionId: "k1", messageId: "cm-1" },
    });
    expect(card.childTurns).toEqual([]);
    expect(next).not.toBe(card);
    expect(next.childTurns).toHaveLength(1);
  });

  it("a tool.input_start then tool.start for the same call counts one step", () => {
    let card = base();
    card = reduceChild(card, {
      type: "agent.message.start",
      payload: { sessionId: "k1", messageId: "cm-1" },
    });
    card = reduceChild(card, {
      type: "agent.tool.input_start",
      payload: { sessionId: "k1", toolCallId: "ct-1", tool: "run_sql" },
    });
    card = reduceChild(card, {
      type: "agent.tool.start",
      payload: { sessionId: "k1", toolCallId: "ct-1", tool: "run_sql", args: { sql: "select 1" } },
    });
    expect(card.stepCount).toBe(1);
    // tool.result discards the now-complete scratch entry after extracting docs.
    card = reduceChild(card, {
      type: "agent.tool.result",
      payload: { sessionId: "k1", toolCallId: "ct-1", result: { kind: "sql.rows", rows: [] }, durationMs: 12 },
    });
    expect(card.childTurns[0].parts).toEqual([]);
  });

  it("clears pending tool scratch when the child request ends", () => {
    let card = base();
    card = reduceChild(card, {
      type: "agent.message.start",
      payload: { sessionId: "k1", messageId: "cm-1" },
    });
    card = reduceChild(card, {
      type: "agent.tool.start",
      payload: { sessionId: "k1", toolCallId: "ct-1", tool: "run_sql", args: {} },
    });
    card = reduceChild(card, {
      type: "agent.message.end",
      payload: { sessionId: "k1", messageId: "cm-1", usage: { inputTokens: 20 } },
    });
    expect(card.childTurns).toEqual([]);
    expect(card.tokens).toBe(20);
  });
});

// ─── Research working-set surface ─────────────────────────────────
//
// The bespoke multi-panel surface is driven entirely off reducer state: a
// Deep Research send flips `state.deepResearch`, the `agent.subagent.*`
// stream populates one card per researcher with its source-tinted docs, and
// the surface collapses when the run ends. These tests assert that data
// shape (panels, per-researcher live docs, finalise, gating, degrade); the
// pixel-level polish needs operator browser QA (see the PR checklist).

describe("research working-set surface — reducer + selectors", () => {
  // Drive a scripted Deep Research run: a deepResearch send, two spawned
  // researchers each finding source-tinted docs, then both finalising.
  function deepRunWithTwoResearchers(): State {
    let s = { ...initialState(), sessionId: "sess-r" } as State;
    s = r(s, { kind: "user-send", text: "Research X", optimisticId: "u1", deepResearch: true });
    s = r(s, { kind: "agent.message.start", payload: { sessionId: "sess-r", messageId: "m1" } });
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-r", subagentId: "r1", specialist: "history-sweep", task: "Sweep mail" },
    });
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-r", subagentId: "r2", specialist: "source-digest", task: "Digest files" },
    });
    return s;
  }

  const wrapChild = (subagentId: string, event: any) => ({
    kind: "agent.subagent.event",
    payload: { sessionId: "sess-r", subagentId, specialist: "x", event },
  });

  it("a deepResearch send opens the surface once researchers exist", () => {
    let s = { ...initialState(), sessionId: "sess-r" } as State;
    s = r(s, { kind: "user-send", text: "Research X", optimisticId: "u1", deepResearch: true });
    expect(s.deepResearch).toBe(true);
    // No researchers yet → surface not active.
    expect(isResearchWorkspaceActive(s)).toBe(false);
    s = r(s, { kind: "agent.message.start", payload: { sessionId: "sess-r", messageId: "m1" } });
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-r", subagentId: "r1", specialist: "history-sweep", task: "Sweep" },
    });
    expect(isResearchWorkspaceActive(s)).toBe(true);
  });

  it("a subagent spawn activates the surface even without the deepResearch pill", () => {
    // A replay demo cassette (or an agent that fans out mid-turn) emits
    // subagent.spawned without the send having armed the `/` pill. The spawn
    // itself IS the research signal, so the working-set surfaces anyway and
    // still collapses on message.end.
    let s = { ...initialState(), sessionId: "sess-r" } as State;
    s = r(s, { kind: "user-send", text: "hi", optimisticId: "u1" });
    expect(s.deepResearch).toBe(false);
    s = r(s, { kind: "agent.message.start", payload: { sessionId: "sess-r", messageId: "m1" } });
    s = r(s, {
      kind: "agent.subagent.spawned",
      payload: { sessionId: "sess-r", subagentId: "r1", specialist: "history-sweep", task: "T" },
    });
    expect(s.deepResearch).toBe(true);
    expect(isResearchWorkspaceActive(s)).toBe(true);
    expect(researchPanels(s)).toHaveLength(1);
  });

  it("the events reduce into N distinct researcher panels in spawn order", () => {
    const s = deepRunWithTwoResearchers();
    const panels = researchPanels(s);
    expect(panels.map((p: any) => p.subagentId)).toEqual(["r1", "r2"]);
    expect(panels.map((p: any) => p.specialist)).toEqual(["history-sweep", "source-digest"]);
    expect(panels.map((p: any) => p.task)).toEqual(["Sweep mail", "Digest files"]);
  });

  it("each panel accumulates its OWN source-tinted docs from its tool results", () => {
    let s = deepRunWithTwoResearchers();
    // r1 runs a search returning two docs from two different sources.
    s = r(
      s,
      wrapChild("r1", {
        type: "agent.tool.result",
        payload: {
          sessionId: "r1",
          toolCallId: "t1",
          result: {
            kind: "search.results",
            results: [
              { documentId: "d-a", title: "Quarterly budget", sourceId: "alpha-mail:acct" },
              { documentId: "d-b", title: "Trip plan", sourceId: "beta-files:vol" },
            ],
          },
        },
      }),
    );
    // r2 opens a single document from a third source.
    s = r(
      s,
      wrapChild("r2", {
        type: "agent.tool.result",
        payload: {
          sessionId: "r2",
          toolCallId: "t2",
          result: {
            kind: "document",
            ref: { documentId: "d-c", title: "Spec sheet", sourceId: "gamma-notes:db" },
          },
        },
      }),
    );
    const panels = researchPanels(s);
    const r1 = panels.find((p: any) => p.subagentId === "r1");
    const r2 = panels.find((p: any) => p.subagentId === "r2");
    expect(r1.docs.map((d: any) => d.documentId)).toEqual(["d-a", "d-b"]);
    // Each doc carries the sourceId the registry tints on (no source-name branch).
    expect(r1.docs.map((d: any) => d.sourceId)).toEqual(["alpha-mail:acct", "beta-files:vol"]);
    expect(r2.docs.map((d: any) => d.documentId)).toEqual(["d-c"]);
    // r2's doc never leaks into r1's working set.
    expect(r1.docs.some((d: any) => d.documentId === "d-c")).toBe(false);
  });

  it("doc accumulation dedupes by documentId across multiple tool results", () => {
    let s = deepRunWithTwoResearchers();
    const result = {
      kind: "search.results",
      results: [{ documentId: "dup", title: "Same doc", sourceId: "alpha-mail:acct" }],
    };
    s = r(s, wrapChild("r1", { type: "agent.tool.result", payload: { sessionId: "r1", toolCallId: "a", result } }));
    s = r(s, wrapChild("r1", { type: "agent.tool.result", payload: { sessionId: "r1", toolCallId: "b", result } }));
    const r1 = researchPanels(s).find((p: any) => p.subagentId === "r1");
    expect(r1.docs).toHaveLength(1);
  });

  it("docs accumulate from a trace_connections result (events + attachments, flattened)", () => {
    let s = deepRunWithTwoResearchers();
    s = r(
      s,
      wrapChild("r1", {
        type: "agent.tool.result",
        payload: {
          sessionId: "r1",
          toolCallId: "t1",
          result: {
            kind: "event_trail.built",
            events: [
              {
                doc: { documentId: "ev-1", title: "Thread", sourceId: "alpha-mail:acct" },
                attachments: [{ doc: { documentId: "att-1", title: "PDF", sourceId: "beta-files:vol" } }],
              },
            ],
          },
        },
      }),
    );
    const r1 = researchPanels(s).find((p: any) => p.subagentId === "r1");
    expect(r1.docs.map((d: any) => d.documentId)).toEqual(["ev-1", "att-1"]);
  });

  it("a panel finalises on agent.subagent.result (status + summary)", () => {
    let s = deepRunWithTwoResearchers();
    s = r(s, {
      kind: "agent.subagent.result",
      payload: {
        sessionId: "sess-r",
        subagentId: "r1",
        specialist: "history-sweep",
        status: "complete",
        summary: "Found the budget thread.",
        citations: [{ documentId: "cited-1", title: "Budget thread", sourceId: "alpha-mail:acct" }],
        usage: { inputTokens: 900, outputTokens: 100 },
      },
    });
    const r1 = researchPanels(s).find((p: any) => p.subagentId === "r1");
    expect(r1.status).toBe("complete");
    expect(r1.summary).toBe("Found the budget thread.");
    expect(r1.tokens).toBe(1000);
    expect(r1.docs).toEqual([{ documentId: "cited-1", title: "Budget thread", sourceId: "alpha-mail:acct" }]);
    // The other researcher is still in flight (null status).
    const r2 = researchPanels(s).find((p: any) => p.subagentId === "r2");
    expect(r2.status).toBeNull();
  });

  it("the surface collapses (deactivates) when the run ends", () => {
    let s = deepRunWithTwoResearchers();
    expect(isResearchWorkspaceActive(s)).toBe(true);
    s = r(s, {
      kind: "agent.message.end",
      payload: { sessionId: "sess-r", messageId: "m1", stopReason: "end_turn" },
    });
    // Run over → surface collapses, but the finished panels still exist
    // on the transcript (they fold into the report context).
    expect(s.deepResearch).toBe(false);
    expect(isResearchWorkspaceActive(s)).toBe(false);
    expect(researchPanels(s)).toHaveLength(2);
  });

  it("the surface collapses on a run error", () => {
    let s = deepRunWithTwoResearchers();
    s = r(s, { kind: "agent.error", payload: { code: "boom", message: "failed" } });
    expect(s.deepResearch).toBe(false);
    expect(isResearchWorkspaceActive(s)).toBe(false);
  });

  it("an unknown wrapped child event degrades: panel stays, no docs added", () => {
    let s = deepRunWithTwoResearchers();
    s = r(s, wrapChild("r1", { type: "agent.some.future.kind", payload: { x: 1 } }));
    s = r(s, wrapChild("r1", null));
    const r1 = researchPanels(s).find((p: any) => p.subagentId === "r1");
    expect(r1).toBeDefined();
    expect(r1.docs).toEqual([]);
  });

  it("a tool result with no doc refs adds no docs (graceful)", () => {
    let s = deepRunWithTwoResearchers();
    s = r(
      s,
      wrapChild("r1", {
        type: "agent.tool.result",
        payload: { sessionId: "r1", toolCallId: "t1", result: { kind: "sql.rows", rows: [[1]] } },
      }),
    );
    const r1 = researchPanels(s).find((p: any) => p.subagentId === "r1");
    expect(r1.docs).toEqual([]);
  });

  it("researchPanels is empty when there is no assistant turn", () => {
    const s = { ...initialState() } as State;
    expect(researchPanels(s)).toEqual([]);
    expect(isResearchWorkspaceActive(s)).toBe(false);
  });
});

describe("agent reducer — retired report artifact compatibility", () => {
  const REPORT_ARTIFACT = {
    kind: "report_artifact",
    stoppedReason: "answer_complete",
    plan: [{ specialist: "history-sweep", task: "Sweep mail" }],
    treeUsage: { inputTokens: 1000, outputTokens: 500 },
    verification: { quotesChecked: 2, quotesVerified: 2 },
    citations: [
      { documentId: "d-a", sourceType: "alpha-mail", sourceId: "alpha-mail:acct", title: "Q4 budget review" },
      { documentId: "d-b", sourceType: "beta-files", sourceId: "beta-files:vol", title: "Trip plan" },
    ],
  };

  const persistedConversation = () => [
    { role: "user", parts: [{ kind: "text", text: "Research the Q4 budget" }] },
    {
      role: "assistant",
      parts: [
        { kind: "text", text: "# Report\nThe budget review concluded…" },
        REPORT_ARTIFACT,
      ],
    },
  ];

  it("retains legacy citations without restoring a completion card", () => {
    const turns = (chatMessagesToTurns as any)(persistedConversation());
    const assistant = turns.find((t: any) => t.role === "assistant");
    expect(assistant.reportCitations.map((c: any) => c.documentId)).toEqual(["d-a", "d-b"]);
    expect(assistant.reportArtifact).toBeUndefined();
    expect(assistant.parts.some((p: any) => p.kind === "text" && p.text.includes("# Report"))).toBe(true);
  });

  it("load-conversation seeds state.citations from the persisted artifact", () => {
    let s = { ...initialState(), sessionId: null } as State;
    s = r(s, {
      kind: "load-conversation",
      sessionId: "sess-dr",
      model: "m",
      backend: "b",
      messages: persistedConversation(),
    });
    expect((s.citations as any[]).map((c) => c.documentId).sort()).toEqual(["d-a", "d-b"]);
    expect((s.citationsByDocId as Map<string, number>).get("d-a")).toBeDefined();
    expect((s.citationsByDocId as Map<string, number>).get("d-b")).toBeDefined();
    const assistant = (s.turns as any[]).find((t) => t.role === "assistant");
    expect(assistant.reportArtifact).toBeUndefined();
  });
});
