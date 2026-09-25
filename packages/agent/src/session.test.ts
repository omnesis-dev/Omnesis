// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { AgentSession } from "./session.js";
import { ReplayBackend, type ReplayFixture } from "./replay-backend.js";
import type { ChatBackend, TurnInput } from "./backend.js";
import type { AgentEvent, DocRef } from "@omnesis/core";

function fx(events: AgentEvent[]): ReplayFixture {
  return { entries: events.map((event) => ({ afterMs: 0, event })) };
}

function refsFromEvents(events: AgentEvent[]): DocRef[] {
  const result: DocRef[] = [];
  for (const e of events) {
    if (e.type === "agent.citations.update") result.push(...e.payload.added);
  }
  return result;
}

function newSession(events: AgentEvent[]): {
  session: AgentSession;
  captured: AgentEvent[];
} {
  const backend = new ReplayBackend({ fixtures: [fx(events)] });
  const session = new AgentSession({
    sessionId: "S",
    backend,
    tools: [],
    systemPrompt: "test",
    idGen: () => "M",
  });
  const captured: AgentEvent[] = [];
  session.subscribe((e) => captured.push(e));
  return { session, captured };
}

describe("AgentSession", () => {
  it("includes an empty assistant in a live snapshot before the first delta", async () => {
    const gate = Promise.withResolvers<void>();
    const backend: ChatBackend = {
      name: "gated",
      model: "gated",
      async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
        yield {
          type: "agent.message.start",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            role: "assistant",
          },
        };
        await gate.promise;
        yield {
          type: "agent.text.delta",
          payload: { sessionId: input.sessionId, messageId: input.messageId, delta: "ready" },
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
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "test",
      idGen: () => "M",
    });
    const started = session.send("hi");
    await new Promise((resolve) => setImmediate(resolve));

    expect(session.historySnapshot()).toEqual([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
    ]);
    expect(session.liveHistorySnapshot()).toEqual([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      { role: "assistant", parts: [] },
    ]);

    gate.resolve();
    await started.completion;
  });

  it("appends a text-only turn to history and re-emits events", async () => {
    const { session, captured } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "hello " },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "there" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);

    const { messageId, completion } = session.send("hi");
    const terminal = await completion;
    expect(messageId).toBe("M");
    expect(terminal.context).toEqual({
      measurement: "unknown",
      limitSource: "unknown",
      requestIteration: 1,
    });
    expect(captured.map((e) => e.type)).toEqual([
      "agent.user.message",
      "agent.message.start",
      "agent.text.delta",
      "agent.text.delta",
      "agent.message.end",
    ]);

    const history = session.historySnapshot();
    // user msg, then assistant text turn.
    expect(history.length).toBe(2);
    expect(history[0]!.role).toBe("user");
    expect(history[1]!.role).toBe("assistant");
    expect(history[1]!.parts).toEqual([{ kind: "text", text: "hello there" }]);
  });

  it("recordTurn injects a user→assistant exchange without running the backend", () => {
    const { session } = newSession([]);
    session.recordTurn("What did Q4 look like?", "# Report\nThe budget held.");
    const history = session.historySnapshot();
    expect(history.length).toBe(2);
    expect(history[0]).toEqual({
      role: "user",
      parts: [{ kind: "text", text: "What did Q4 look like?" }],
    });
    expect(history[1]).toEqual({
      role: "assistant",
      parts: [{ kind: "text", text: "# Report\nThe budget held." }],
    });
  });

  it("recordTurn appends a report_artifact part when given one (#748)", () => {
    // The Deep Research write-back path hands `recordTurn` the verified-report
    // artifact so the card survives a conversation reload. The part lands
    // alongside the report text on the same assistant message.
    const { session } = newSession([]);
    const artifact = {
      kind: "report_artifact" as const,
      stoppedReason: "answer_complete",
      plan: [{ specialist: "history-sweep", task: "Sweep mail" }],
      treeUsage: { inputTokens: 1000, outputTokens: 500 },
      verification: { quotesChecked: 2, quotesVerified: 2 },
      citations: [
        { documentId: "d-a", sourceType: "gmail", sourceId: "gmail:me", title: "Q4 budget review" },
      ] as DocRef[],
    };
    session.recordTurn("Research the Q4 budget", "# Report\nbody", artifact);
    const history = session.historySnapshot();
    expect(history.length).toBe(2);
    const assistant = history[1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.parts).toEqual([{ kind: "text", text: "# Report\nbody" }, artifact]);
  });

  it("replaces a provisional recorded assistant turn without duplicating the prompt", () => {
    const { session } = newSession([]);
    session.recordTurn("Research the archive", "");
    session.replaceLastRecordedAssistantTurn("# Research report");

    expect(session.historySnapshot()).toEqual([
      { role: "user", parts: [{ kind: "text", text: "Research the archive" }] },
      { role: "assistant", parts: [{ kind: "text", text: "# Research report" }] },
    ]);
  });

  it("persists a report_artifact part on a replay/normal turn that emits a deep-research summary (#748)", async () => {
    // The demo cassette (and any backend that scripts a deep-research run)
    // plays as a NORMAL turn, not the real-engine `runDeepResearch` write-back.
    // So the session itself must fold the streamed `agent.deep_research.summary`
    // (+ the merged `agent.citations.update`) into the persisted
    // `report_artifact` part — otherwise the "answer complete · N/N verified ·
    // N sources" card is a live-only event and vanishes on reload. This is the
    // regression net for that bug, which the first fix (real-engine path only)
    // missed.
    const citation: DocRef = {
      documentId: "d-bank-1",
      sourceType: "enable-banking-accounts",
      sourceId: "enable-banking-accounts:self",
      title: "Tokyo Riverside Hotel",
    };
    const { session } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "Total spend: ~£3,700." },
      },
      {
        type: "agent.citations.update",
        payload: { sessionId: "$SESSION", added: [citation], removed: [] },
      },
      {
        type: "agent.deep_research.summary",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          stoppedReason: "answer_complete",
          plan: [{ specialist: "history-sweep", task: "Sweep bank statements" }],
          treeUsage: { inputTokens: 1200, outputTokens: 600 },
          verification: { quotesChecked: 6, quotesVerified: 6 },
        },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);

    await session.send("How much did I spend during my Japan trip?").completion;

    const history = session.historySnapshot();
    const assistant = history.find((m) => m.role === "assistant");
    expect(assistant, "no assistant turn recorded").toBeTruthy();
    // text first, then the report_artifact — both on the same assistant message.
    expect(assistant!.parts.map((p) => p.kind)).toEqual(["text", "report_artifact"]);
    const artifact = assistant!.parts.find((p) => p.kind === "report_artifact") as
      | {
          stoppedReason: string;
          plan: Array<{ specialist: string; task: string }>;
          verification: { quotesChecked: number; quotesVerified: number };
          citations: DocRef[];
        }
      | undefined;
    expect(
      artifact,
      "deep-research summary was not persisted as a report_artifact part",
    ).toBeTruthy();
    expect(artifact!.stoppedReason).toBe("answer_complete");
    expect(artifact!.verification).toEqual({ quotesChecked: 6, quotesVerified: 6 });
    expect(artifact!.plan).toEqual([
      { specialist: "history-sweep", task: "Sweep bank statements" },
    ]);
    expect(artifact!.citations).toEqual([citation]);
  });

  it("search.results do not auto-populate citations", async () => {
    // The agent must explicitly cite via the `annotate` tool; search
    // hits never surface in the citations panel.
    const refA: DocRef = {
      documentId: "docA",
      sourceType: "gmail",
      sourceId: "gmail:me",
      title: "From Quentin",
    };
    const refB: DocRef = {
      documentId: "docB",
      sourceType: "whatsapp",
      sourceId: "whatsapp:phone",
    };

    const { session, captured } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.tool.start",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_1",
          tool: "search_documents",
          args: { query: "Quentin" },
        },
      },
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_1",
          durationMs: 12,
          result: {
            kind: "search.results",
            query: "Quentin",
            durationMs: 12,
            results: [refA, refB],
          },
        },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "Found two." },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);

    await session.send("anything from Quentin?").completion;

    expect(session.citationsSnapshot()).toEqual([]);
    expect(refsFromEvents(captured)).toEqual([]);

    // History shape still alternates correctly.
    const history = session.historySnapshot();
    expect(history.map((h) => h.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(history[1]!.parts.map((p) => p.kind)).toEqual(["tool_use"]);
    expect(history[2]!.parts[0]!.kind).toBe("tool_result");
    expect(history[3]!.parts.map((p) => p.kind)).toEqual(["text"]);
  });

  it("records a tool.start's extraContent on the tool_use history part (#510)", async () => {
    const sig = { google: { thought_signature: "c2lnbmF0dXJl" } };
    const { session } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.tool.start",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_1",
          tool: "search_documents",
          args: { query: "x" },
          extraContent: sig,
        },
      },
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_1",
          durationMs: 1,
          result: { kind: "search.results", query: "x", durationMs: 1, results: [] },
        },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);

    await session.send("find x").completion;

    const history = session.historySnapshot();
    const toolUse = history[1]!.parts[0]!;
    expect(toolUse.kind).toBe("tool_use");
    expect(toolUse.kind === "tool_use" && toolUse.extraContent).toEqual(sig);
  });

  it("retains opaque reasoning blocks with the tool call for resumed conversations", async () => {
    const details = [
      { type: "reasoning.text", text: "example trace", signature: "example-signature" },
      { type: "reasoning.encrypted", data: "example-opaque-data" },
    ];
    const { session } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.tool.start",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_1",
          tool: "search_documents",
          args: { query: "example" },
          reasoningDetails: details,
        },
      },
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_1",
          durationMs: 1,
          result: { kind: "search.results", query: "example", durationMs: 1, results: [] },
        },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);

    await session.send("find example").completion;
    const toolUse = session.historySnapshot()[1]!.parts[0]!;
    expect(toolUse.kind === "tool_use" && toolUse.reasoningDetails).toEqual(details);
  });

  it("a successful annotate tool result populates citations + emits live agent.citation", async () => {
    const ref: DocRef = {
      documentId: "doc1",
      sourceType: "notion-pages",
      sourceId: "notion-pages:self",
      title: "Plan",
    };
    const { session, captured } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.tool.start",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_ann",
          tool: "annotate",
          args: { documentId: "doc1", quote: "the plan is ready" },
        },
      },
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_ann",
          durationMs: 5,
          result: {
            kind: "annotate.recorded",
            documentId: "doc1",
            ref,
            quote: "the plan is ready",
          },
        },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    // message.end commits citations before its own deferred broadcast. A
    // synchronous cancel from that last pre-terminal notification is already
    // too late and must not rewrite the accepted provider outcome.
    session.subscribe((event) => {
      if (event.type === "agent.citations.update") session.cancel();
    });
    await session.send("status?").completion;

    const snap = session.citationsSnapshot();
    expect(snap.map((c) => c.documentId)).toEqual(["doc1"]);
    expect(snap[0]!.entries).toEqual([
      { toolCallId: "tc_ann", messageId: "M", quote: "the plan is ready", note: undefined },
    ]);

    // Live `agent.citation` was synthesised from the annotate.recorded result.
    const live = captured.filter((e) => e.type === "agent.citation");
    expect(live).toHaveLength(1);
    if (live[0]!.type === "agent.citation") {
      expect(live[0]!.payload.documentId).toBe("doc1");
      expect(live[0]!.payload.quote).toBe("the plan is ready");
      expect(live[0]!.payload.toolCallId).toBe("tc_ann");
    }
    // Terminal `agent.citations.update` carries the added ref.
    expect(refsFromEvents(captured).map((r) => r.documentId)).toEqual(["doc1"]);
    expect(captured.at(-1)).toMatchObject({
      type: "agent.message.end",
      payload: { stopReason: "end_turn" },
    });
  });

  it("a successful annotate with quoteAuthor populates citations + emits agent.citation with quoteAuthor", async () => {
    const ref: DocRef = {
      documentId: "doc1",
      sourceType: "gmail",
      sourceId: "gmail:me",
      title: "Thread",
    };
    const { session, captured } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.tool.start",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_ann",
          tool: "annotate",
          args: { documentId: "doc1", quote: "shipped at noon", quoteAuthor: "Alice" },
        },
      },
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_ann",
          durationMs: 3,
          result: {
            kind: "annotate.recorded",
            documentId: "doc1",
            ref,
            quote: "shipped at noon",
            quoteAuthor: "Alice",
          },
        },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    await session.send("update?").completion;

    const snap = session.citationsSnapshot();
    expect(snap.map((c) => c.documentId)).toEqual(["doc1"]);
    expect(snap[0]!.entries[0]!.quote).toBe("shipped at noon");
    expect(snap[0]!.entries[0]!.quoteAuthor).toBe("Alice");
    // A third-party author is not the user, so quoteIsSelf stays absent.
    expect(snap[0]!.entries[0]!.quoteIsSelf).toBeFalsy();

    // Live `agent.citation` includes quoteAuthor.
    const live = captured.filter((e) => e.type === "agent.citation");
    expect(live).toHaveLength(1);
    if (live[0]!.type === "agent.citation") {
      expect(live[0]!.payload.documentId).toBe("doc1");
      expect(live[0]!.payload.quote).toBe("shipped at noon");
      expect(live[0]!.payload.quoteAuthor).toBe("Alice");
      expect(live[0]!.payload.quoteIsSelf).toBeFalsy();
      expect(live[0]!.payload.toolCallId).toBe("tc_ann");
    }
    // Terminal `agent.citations.update` carries the added ref.
    expect(refsFromEvents(captured).map((r) => r.documentId)).toEqual(["doc1"]);
  });

  it("a self-authored quote ('You') carries quoteIsSelf through to the snapshot + live citation", async () => {
    const ref: DocRef = {
      documentId: "doc1",
      sourceType: "gmail",
      sourceId: "gmail:me",
      title: "Thread",
    };
    const { session, captured } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.tool.start",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_ann",
          tool: "annotate",
          args: { documentId: "doc1", quote: "I confirmed the date", quoteAuthor: "You" },
        },
      },
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_ann",
          durationMs: 3,
          result: {
            kind: "annotate.recorded",
            documentId: "doc1",
            ref,
            quote: "I confirmed the date",
            quoteAuthor: "You",
            quoteIsSelf: true,
          },
        },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    await session.send("update?").completion;

    const snap = session.citationsSnapshot();
    expect(snap.map((c) => c.documentId)).toEqual(["doc1"]);
    expect(snap[0]!.entries[0]!.quote).toBe("I confirmed the date");
    expect(snap[0]!.entries[0]!.quoteAuthor).toBe("You");
    // The user authored the quote, so quoteIsSelf survives into the stored entry.
    expect(snap[0]!.entries[0]!.quoteIsSelf).toBe(true);

    // The synthesised live `agent.citation` carries quoteIsSelf too.
    const live = captured.filter((e) => e.type === "agent.citation");
    expect(live).toHaveLength(1);
    if (live[0]!.type === "agent.citation") {
      expect(live[0]!.payload.documentId).toBe("doc1");
      expect(live[0]!.payload.quote).toBe("I confirmed the date");
      expect(live[0]!.payload.quoteAuthor).toBe("You");
      expect(live[0]!.payload.quoteIsSelf).toBe(true);
      expect(live[0]!.payload.toolCallId).toBe("tc_ann");
    }
    // Terminal `agent.citations.update` carries the added ref.
    expect(refsFromEvents(captured).map((r) => r.documentId)).toEqual(["doc1"]);
  });

  it("preserves Anthropic-valid alternation across a multi-tool turn", async () => {
    // Two tool calls in a single turn: search → result → fetch → result →
    // text. Anthropic rejects history that puts tool_result blocks before
    // the assistant message carrying the tool_use; this exercise pins down
    // the exact alternation the next call should send.
    const refA: DocRef = {
      documentId: "docA",
      sourceType: "gmail",
      sourceId: "gmail:me",
    };
    const { session } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.tool.start",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_1",
          tool: "search_documents",
          args: { query: "x" },
        },
      },
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_1",
          durationMs: 5,
          result: { kind: "search.results", query: "x", durationMs: 5, results: [refA] },
        },
      },
      {
        type: "agent.tool.start",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_2",
          tool: "fetch_document",
          args: { documentId: "docA" },
        },
      },
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_2",
          durationMs: 3,
          result: { kind: "document", ref: refA, document: { content: "body" } },
        },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "Done." },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);

    await session.send("look for x").completion;
    const history = session.historySnapshot();
    // user → assistant(tool_use) → user(tool_result) → assistant(tool_use)
    // → user(tool_result) → assistant(text).
    expect(history.map((h) => h.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history[1]!.parts.map((p) => p.kind)).toEqual(["tool_use"]);
    expect(history[2]!.parts.map((p) => p.kind)).toEqual(["tool_result"]);
    expect(history[3]!.parts.map((p) => p.kind)).toEqual(["tool_use"]);
    expect(history[4]!.parts.map((p) => p.kind)).toEqual(["tool_result"]);
    expect(history[5]!.parts.map((p) => p.kind)).toEqual(["text"]);
    // Every tool_result must be preceded by a matching tool_use id.
    const toolUseIds = new Set<string>();
    for (const msg of history) {
      for (const part of msg.parts) {
        if (part.kind === "tool_use") toolUseIds.add(part.toolCallId);
        if (part.kind === "tool_result") expect(toolUseIds.has(part.toolCallId)).toBe(true);
      }
    }
  });

  it("a freestanding agent.citation event (replay path) does NOT mutate citations on its own", async () => {
    // The live `agent.citation` event is a synthesised side-effect of
    // an `annotate.recorded` tool result, not a state-mutation
    // entrypoint. A replay backend that emits a bare citation event
    // must also emit the citations.update for the session-level
    // snapshot to populate.
    const ref: DocRef = {
      documentId: "cited",
      sourceType: "notion",
      sourceId: "notion:ws",
    };
    const { session } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.citation",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_freestanding",
          documentId: "cited",
          ref,
          quote: "ok",
        },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "ok" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);

    await session.send("explain").completion;
    expect(session.citationsSnapshot()).toEqual([]);
  });

  it("rejects concurrent send", async () => {
    const { session } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);

    const first = session.send("first");
    expect(() => session.send("second")).toThrow(/busy/);
    await first.completion;
  });

  it("fetched documents do NOT contribute to citations", async () => {
    // fetch_document never lands in the citations panel — only the
    // explicit `annotate` tool does. Neither the target nor its
    // neighbors should appear.
    const target: DocRef = { documentId: "tgt", sourceType: "gmail", sourceId: "gmail:me" };
    const neighbor: DocRef = { documentId: "neigh", sourceType: "gmail", sourceId: "gmail:me" };
    const { session } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.tool.start",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_1",
          tool: "fetch_document",
          args: { documentId: "tgt" },
        },
      },
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_1",
          durationMs: 1,
          result: { kind: "document", ref: target, document: { id: "tgt" }, neighbors: [neighbor] },
        },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    await session.send("read it").completion;
    expect(session.citationsSnapshot()).toEqual([]);
  });

  it("seeds citations from initial history on resume", async () => {
    // Saved transcript has a prior assistant turn that called
    // `annotate` with a quote; the session reconstructor must rebuild
    // `citationsSnapshot()` from the saved tool_use + tool_result pair.
    const ref: DocRef = {
      documentId: "saved",
      sourceType: "gmail",
      sourceId: "gmail:me",
      title: "Old thread",
    };
    const backend = new ReplayBackend({
      fixtures: [
        fx([
          {
            type: "agent.message.start",
            payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
          },
          {
            type: "agent.message.end",
            payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
          },
        ]),
      ],
    });
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "test",
      idGen: () => "M",
      initialHistory: [
        { role: "user", parts: [{ kind: "text", text: "did the thing happen?" }] },
        {
          role: "assistant",
          parts: [
            {
              kind: "tool_use",
              toolCallId: "tc_prior",
              tool: "annotate_many",
              args: { annotations: [{ documentId: "saved", quote: "shipped" }] },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              kind: "tool_result",
              toolCallId: "tc_prior",
              result: {
                kind: "annotate.batch",
                items: [
                  {
                    kind: "annotate.recorded",
                    documentId: "saved",
                    ref,
                    quote: "shipped",
                  },
                ],
              },
            },
          ],
        },
        { role: "assistant", parts: [{ kind: "text", text: "yes." }] },
      ],
    });
    const snap = session.citationsSnapshot();
    expect(snap.map((c) => c.documentId)).toEqual(["saved"]);
    expect(snap[0]!.entries[0]!.quote).toBe("shipped");
    // A batch of ONE keeps the bare parent id (no `#idx` suffix).
    expect(snap[0]!.entries[0]!.toolCallId).toBe("tc_prior");
  });

  it("seeds one citation per child from a multi-item annotate.batch, with stable #idx ids", async () => {
    // A resumed transcript whose prior turn cited two documents in a single
    // `annotate_many` must rebuild BOTH citations, each keyed by `${call}#${idx}`
    // over the filtered successful list — matching the live per-child ids so the
    // Timeline is identical live and on reload.
    const ref: DocRef = {
      documentId: "seed",
      sourceType: "gmail",
      sourceId: "gmail:me",
      title: "Lease",
    };
    const backend = new ReplayBackend({
      fixtures: [
        fx([
          {
            type: "agent.message.start",
            payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
          },
          {
            type: "agent.message.end",
            payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
          },
        ]),
      ],
    });
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "test",
      idGen: () => "M",
      initialHistory: [
        { role: "user", parts: [{ kind: "text", text: "where did I live?" }] },
        {
          role: "assistant",
          parts: [
            {
              kind: "tool_use",
              toolCallId: "tc",
              tool: "annotate_many",
              args: {
                annotations: [
                  { documentId: "d1", quote: "north lease" },
                  { documentId: "d2", quote: "south lease" },
                ],
              },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              kind: "tool_result",
              toolCallId: "tc",
              result: {
                kind: "annotate.batch",
                items: [
                  {
                    kind: "annotate.recorded",
                    documentId: "d1",
                    ref: { ...ref, documentId: "d1" },
                    quote: "north lease",
                  },
                  {
                    kind: "annotate.recorded",
                    documentId: "d2",
                    ref: { ...ref, documentId: "d2" },
                    quote: "south lease",
                  },
                ],
              },
            },
          ],
        },
        { role: "assistant", parts: [{ kind: "text", text: "two places." }] },
      ],
    });
    const snap = session.citationsSnapshot();
    expect(snap.map((c) => c.documentId).sort()).toEqual(["d1", "d2"]);
    const byId = Object.fromEntries(snap.map((c) => [c.documentId, c]));
    expect(byId.d1!.entries[0]!.toolCallId).toBe("tc#0");
    expect(byId.d2!.entries[0]!.toolCallId).toBe("tc#1");
  });

  it("drops an orphan agent.tool.result that has no preceding tool.start", async () => {
    const { session, captured } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_ghost",
          durationMs: 0,
          result: { kind: "error", code: "boom", message: "no preceding start" },
        },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "done" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    await session.send("hi").completion;
    // The session must NOT have written a user/tool_result block; otherwise
    // the next turn would carry an orphan tool_result in the request body.
    for (const msg of session.historySnapshot()) {
      for (const part of msg.parts) {
        expect(part.kind).not.toBe("tool_result");
      }
    }
    // The orphan event is still re-broadcast — the rendering layer
    // can decide whether to show it; we only refuse to commit it.
    expect(captured.some((e) => e.type === "agent.tool.result")).toBe(true);
  });

  it("synthesises a tool_result stub for an open tool_use when the stream ends early", async () => {
    const { session } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.tool.start",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc_open",
          tool: "search_documents",
          args: { query: "x" },
        },
      },
      {
        type: "agent.error",
        payload: { sessionId: "$SESSION", messageId: "$MSG", code: "boom", message: "kaboom" },
      },
      // No message.end — the session must synthesise both the missing
      // tool_result stub and the terminal end event.
    ]);
    await session.send("go").completion;
    const history = session.historySnapshot();
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of history) {
      for (const part of msg.parts) {
        if (part.kind === "tool_use") toolUseIds.add(part.toolCallId);
        if (part.kind === "tool_result") toolResultIds.add(part.toolCallId);
      }
    }
    expect(toolUseIds.has("tc_open")).toBe(true);
    expect(toolResultIds.has("tc_open")).toBe(true);
  });

  it("persists a no-output backend error as assistant text", async () => {
    const { session } = newSession([
      {
        type: "agent.error",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          code: "http_request_error",
          message: "The operation was aborted due to timeout",
        },
      },
    ]);

    await session.send("hi").completion;

    const history = session.historySnapshot();
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual({ role: "user", parts: [{ kind: "text", text: "hi" }] });
    // `Model request failed: <code>: <message>` is a contract, not an
    // incidental string: the portal reads it back out of replayed history to
    // render a resumed failed turn the same way the live stream renders it
    // (`splitTerminalFailureMarker` in the portal's agent reducer). Changing
    // this shape without changing that parser makes a reopened conversation
    // show the failure as ordinary assistant prose.
    expect(history[1]).toEqual({
      role: "assistant",
      parts: [
        {
          kind: "text",
          text: "Model request failed: http_request_error: The operation was aborted due to timeout",
        },
      ],
    });
  });

  it("keeps context exhaustion outside model-visible history", async () => {
    const { session, captured } = newSession([
      {
        type: "agent.error",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          code: "context_window_exceeded",
          message: "raw provider detail must not survive",
        },
      },
      {
        type: "agent.message.end",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          stopReason: "error",
        },
      },
    ]);

    const terminal = await session.send("hi").completion;

    expect(terminal).toMatchObject({
      stopReason: "error",
      context: {
        measurement: "unknown",
        limitSource: "unknown",
        requestIteration: 1,
      },
      failure: {
        code: "context_window_exceeded",
        retryable: false,
        backend: "replay",
      },
    });
    expect(session.historySnapshot()).toEqual([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
    ]);
    const error = captured.find((event) => event.type === "agent.error");
    expect(error?.payload).toMatchObject({
      code: "context_window_exceeded",
      message:
        "This conversation no longer fits in the selected model's context window. Start a new conversation to continue.",
    });
  });

  it("preserves partial assistant text without adding a context-error breadcrumb", async () => {
    const { session } = newSession([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "Partial answer" },
      },
      {
        type: "agent.error",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          code: "context_window_exceeded",
          message: "request too large",
        },
      },
      {
        type: "agent.message.end",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          stopReason: "error",
          failure: {
            code: "context_window_exceeded",
            message: "unsafe detail",
            retryable: true,
            backend: "fixture",
            model: "fixture-model",
          },
        },
      },
    ]);

    const terminal = await session.send("hi").completion;

    expect(terminal.failure).toMatchObject({
      code: "context_window_exceeded",
      retryable: false,
      backend: "replay",
    });
    expect(session.historySnapshot()).toEqual([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      { role: "assistant", parts: [{ kind: "text", text: "Partial answer" }] },
    ]);
  });

  it("normalizes max-token stops into an output-truncated failure", async () => {
    const { session } = newSession([
      {
        type: "agent.message.end",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          stopReason: "max_tokens",
        },
      },
    ]);

    await expect(session.send("hi").completion).resolves.toMatchObject({
      stopReason: "max_tokens",
      failure: {
        code: "output_truncated",
        retryable: false,
        backend: "replay",
      },
    });
  });

  it("surfaces a synchronous backend throw as agent.error + terminal end, then rejects completion", async () => {
    const throwingBackend: ChatBackend = {
      name: "throwing",
      model: "test",
      runTurn(): AsyncIterable<AgentEvent> {
        throw new Error("synchronous boom");
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend: throwingBackend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });
    const captured: AgentEvent[] = [];
    session.subscribe((e) => captured.push(e));

    const { completion } = session.send("hi");
    await expect(completion).rejects.toThrow(/synchronous boom/);

    const types = captured.map((e) => e.type);
    expect(types).toContain("agent.error");
    expect(types[types.length - 1]).toBe("agent.message.end");
    const err = captured.find((e) => e.type === "agent.error");
    if (err && err.type === "agent.error") expect(err.payload.code).toBe("internal_error");
    const end = captured.find((e) => e.type === "agent.message.end");
    if (end && end.type === "agent.message.end") expect(end.payload.stopReason).toBe("error");
    expect(session.historySnapshot()).toEqual([
      { role: "user", parts: [{ kind: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          {
            kind: "text",
            text: "Model request failed: internal_error: synchronous boom",
          },
        ],
      },
    ]);
  });

  it("surfaces a mid-stream iterator throw as agent.error + terminal end, then rejects completion", async () => {
    const iteratorThrowingBackend: ChatBackend = {
      name: "iter-throw",
      model: "test",
      async *runTurn(_input: TurnInput): AsyncIterable<AgentEvent> {
        yield {
          type: "agent.message.start",
          payload: { sessionId: _input.sessionId, messageId: _input.messageId, role: "assistant" },
        };
        yield {
          type: "agent.text.delta",
          payload: { sessionId: _input.sessionId, messageId: _input.messageId, delta: "hi" },
        };
        throw new Error("connection reset");
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend: iteratorThrowingBackend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });
    const captured: AgentEvent[] = [];
    session.subscribe((e) => captured.push(e));

    const { completion } = session.send("hi");
    await expect(completion).rejects.toThrow(/connection reset/);

    const types = captured.map((e) => e.type);
    expect(types).toContain("agent.error");
    expect(types[types.length - 1]).toBe("agent.message.end");
    const end = captured.find((e) => e.type === "agent.message.end");
    if (end && end.type === "agent.message.end") expect(end.payload.stopReason).toBe("error");
  });

  it("closes an open tool_use when the backend errors before emitting the result", async () => {
    // A backend that opens a tool_use, then errors out without an
    // agent.tool.result. The session must synthesise the missing
    // tool_result so the history pair is valid for the next turn.
    const partialBackend: ChatBackend = {
      name: "partial",
      model: "test",
      async *runTurn(_input: TurnInput): AsyncIterable<AgentEvent> {
        yield {
          type: "agent.message.start",
          payload: { sessionId: _input.sessionId, messageId: _input.messageId, role: "assistant" },
        };
        yield {
          type: "agent.tool.start",
          payload: {
            sessionId: _input.sessionId,
            messageId: _input.messageId,
            toolCallId: "tc_open",
            tool: "search_documents",
            args: { query: "x" },
          },
        };
        yield {
          type: "agent.error",
          payload: {
            sessionId: _input.sessionId,
            messageId: _input.messageId,
            code: "anthropic_stream_error",
            message: "reset",
          },
        };
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend: partialBackend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });
    await session.send("go").completion;
    const history = session.historySnapshot();
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of history) {
      for (const part of msg.parts) {
        if (part.kind === "tool_use") toolUseIds.add(part.toolCallId);
        if (part.kind === "tool_result") toolResultIds.add(part.toolCallId);
      }
    }
    for (const id of toolUseIds) {
      expect(toolResultIds.has(id)).toBe(true);
    }
  });

  it("cancel() ends the turn with stopReason=canceled", async () => {
    const backend = new ReplayBackend({
      fixtures: [
        fx([
          {
            type: "agent.message.start",
            payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
          },
          {
            type: "agent.text.delta",
            payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "x" },
          },
          {
            type: "agent.message.end",
            payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
          },
        ]),
      ],
      clampMs: 100, // 100ms between events; we cancel before they all arrive
    });

    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });
    const captured: AgentEvent[] = [];
    session.subscribe((e) => captured.push(e));

    const sent = session.send("x");
    setTimeout(() => session.cancel(), 30);
    await sent.completion;

    const endEvents = captured.filter((e) => e.type === "agent.message.end");
    expect(endEvents.length).toBeGreaterThan(0);
    expect((endEvents[0]!.payload as { stopReason: string }).stopReason).toBe("canceled");
  });

  it("cancel() records the stop after the partial answer, and the terminal carries no failure", async () => {
    let markListening!: () => void;
    const listening = new Promise<void>((resolve) => {
      markListening = resolve;
    });
    const backend: ChatBackend = {
      name: "partial-then-hang",
      model: "partial-then-hang",
      async *runTurn(input, signal) {
        yield {
          type: "agent.message.start",
          payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
        };
        yield {
          type: "agent.text.delta",
          payload: { sessionId: input.sessionId, messageId: input.messageId, delta: "Half an " },
        };
        yield {
          type: "agent.text.delta",
          payload: { sessionId: input.sessionId, messageId: input.messageId, delta: "answer" },
        };
        await new Promise<void>((_resolve, reject) => {
          markListening();
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });
    const captured: AgentEvent[] = [];
    session.subscribe((event) => captured.push(event));

    const turn = session.send("tell me everything");
    await listening;
    session.cancel("user");
    await turn.completion;

    expect(session.historySnapshot()).toEqual([
      { role: "user", parts: [{ kind: "text", text: "tell me everything" }] },
      {
        role: "assistant",
        parts: [
          {
            kind: "text",
            text: "Half an answer\n\nModel request failed: canceled: You stopped this reply.",
          },
        ],
      },
    ]);
    const terminal = captured.find((event) => event.type === "agent.message.end");
    expect(terminal?.payload).toMatchObject({ stopReason: "canceled" });
    expect(terminal?.payload).not.toHaveProperty("failure");
  });

  it("cancel() before any output still ends the transcript on the stop message", async () => {
    let markListening!: () => void;
    const listening = new Promise<void>((resolve) => {
      markListening = resolve;
    });
    const backend: ChatBackend = {
      name: "hang",
      model: "hang",
      async *runTurn(input, signal) {
        yield {
          type: "agent.message.start",
          payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
        };
        await new Promise<void>((_resolve, reject) => {
          markListening();
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });

    const turn = session.send("stop this");
    await listening;
    session.cancel();
    await turn.completion;

    expect(session.historySnapshot()).toEqual([
      { role: "user", parts: [{ kind: "text", text: "stop this" }] },
      {
        role: "assistant",
        parts: [{ kind: "text", text: "Model request failed: canceled: This reply was stopped." }],
      },
    ]);
  });

  it("cancel() with an open tool call lands the stop message after the stub tool results", async () => {
    let markListening!: () => void;
    const listening = new Promise<void>((resolve) => {
      markListening = resolve;
    });
    const backend: ChatBackend = {
      name: "tool-then-hang",
      model: "tool-then-hang",
      async *runTurn(input, signal) {
        yield {
          type: "agent.message.start",
          payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
        };
        yield {
          type: "agent.tool.start",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            toolCallId: "tc_open",
            tool: "search_documents",
            args: { query: "budget review" },
          },
        };
        await new Promise<void>((_resolve, reject) => {
          markListening();
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });

    const turn = session.send("find the budget review");
    await listening;
    session.cancel();
    await turn.completion;

    const history = session.historySnapshot();
    expect(history.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(history[2]).toMatchObject({
      role: "user",
      parts: [{ kind: "tool_result", toolCallId: "tc_open", result: { code: "turn_aborted" } }],
    });
    expect(history[3]).toEqual({
      role: "assistant",
      parts: [{ kind: "text", text: "Model request failed: canceled: This reply was stopped." }],
    });
  });

  it("only a Stop the user pressed says the user stopped the reply", async () => {
    // `cancel()` defaults to the impersonal line, so a disposal or a caller's
    // aborted signal never claims the user did it; the Stop path passes the
    // user cause, and a disposal that follows it keeps that first cause.
    const hanging = (): ChatBackend => ({
      name: "hang",
      model: "hang",
      async *runTurn(input, signal) {
        yield {
          type: "agent.message.start",
          payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
        };
        if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
        });
      },
    });
    const open = (): AgentSession =>
      new AgentSession({
        sessionId: "S",
        backend: hanging(),
        tools: [],
        systemPrompt: "",
        idGen: () => "M",
      });
    const lastLine = (session: AgentSession): string | undefined => {
      const last = session.historySnapshot().at(-1);
      const part = last?.role === "assistant" ? last.parts.at(-1) : undefined;
      return part?.kind === "text" ? part.text : undefined;
    };

    const disposed = open();
    const disposedTurn = disposed.send("stop this");
    await disposed.dispose();
    await disposedTurn.completion;
    expect(lastLine(disposed)).toBe("Model request failed: canceled: This reply was stopped.");

    const external = open();
    const controller = new AbortController();
    const externalTurn = external.send("stop this", { signal: controller.signal });
    controller.abort();
    await externalTurn.completion;
    expect(lastLine(external)).toBe("Model request failed: canceled: This reply was stopped.");

    const stopped = open();
    const stoppedTurn = stopped.send("stop this");
    stopped.cancel("user");
    await stopped.dispose();
    await stoppedTurn.completion;
    expect(lastLine(stopped)).toBe("Model request failed: canceled: You stopped this reply.");
  });

  it("cancel() remains effective after an intermediate tool-use boundary", async () => {
    let boundarySeen!: () => void;
    const atBoundary = new Promise<void>((resolve) => {
      boundarySeen = resolve;
    });
    const backend: ChatBackend = {
      name: "tool-boundary",
      model: "tool-boundary",
      async *runTurn(input, signal) {
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "tool_use",
            usage: { inputTokens: 3, outputTokens: 1 },
          },
        };
        boundarySeen();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
        });
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });
    const captured: AgentEvent[] = [];
    session.subscribe((event) => captured.push(event));

    const turn = session.send("stop after the tool call");
    await atBoundary;
    expect(session.busy).toBe(true);
    session.cancel();
    await turn.completion;

    const terminalEvents = captured.filter((event) => event.type === "agent.message.end");
    expect(terminalEvents.map((event) => event.payload.stopReason)).toEqual(["canceled"]);
    expect(terminalEvents[0]?.payload.usage).toEqual({
      inputTokens: 3,
      outputTokens: 1,
    });
    expect(session.busy).toBe(false);
  });

  it("retires an abort-rejected turn before broadcasting canceled so a follow-up can start", async () => {
    let calls = 0;
    const backend: ChatBackend = {
      name: "abort-then-answer",
      model: "abort-then-answer",
      async *runTurn(input, signal) {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted", "AbortError")),
              { once: true },
            );
          });
          return;
        }
        yield {
          type: "agent.message.start",
          payload: { sessionId: input.sessionId, messageId: input.messageId, role: "assistant" },
        };
        yield {
          type: "agent.text.delta",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            delta: "second answer",
          },
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
    let nextId = 0;
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "",
      idGen: () => `M${++nextId}`,
    });
    let followUp: ReturnType<AgentSession["send"]> | undefined;
    const captured: AgentEvent[] = [];
    session.subscribe((event) => {
      captured.push(event);
      if (event.type === "agent.message.end" && event.payload.stopReason === "canceled") {
        // This callback is synchronous with terminal fan-out, making it the
        // strongest form of the cancel → immediate-send race.
        followUp = session.send("again");
      }
    });

    const first = session.send("stop this");
    session.cancel();
    await first.completion;
    expect(followUp).toBeDefined();
    await followUp!.completion;

    expect(captured.filter((event) => event.type === "agent.error")).toHaveLength(0);
    expect(
      captured
        .filter((event) => event.type === "agent.message.end")
        .map((event) => event.payload.stopReason),
    ).toEqual(["canceled", "end_turn"]);
    expect(session.historySnapshot().at(-1)).toMatchObject({
      role: "assistant",
      parts: [{ kind: "text", text: "second answer" }],
    });
  });

  it("suppresses abort-time provider errors and output before the canceled terminal", async () => {
    let markListening!: () => void;
    const listening = new Promise<void>((resolve) => {
      markListening = resolve;
    });
    const backend: ChatBackend = {
      name: "late-abort-output",
      model: "late-abort-output",
      async *runTurn(input, signal) {
        await new Promise<void>((resolve) => {
          markListening();
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          type: "agent.error",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            code: "send_failed",
            message: "late provider failure",
          },
        };
        yield {
          type: "agent.text.delta",
          payload: { sessionId: input.sessionId, messageId: input.messageId, delta: "late text" },
        };
        yield {
          type: "agent.message.end",
          payload: { sessionId: input.sessionId, messageId: input.messageId, stopReason: "error" },
        };
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });
    const captured: AgentEvent[] = [];
    session.subscribe((event) => captured.push(event));

    const turn = session.send("stop this");
    await listening;
    session.cancel();
    await turn.completion;

    expect(captured.filter((event) => event.type === "agent.error")).toEqual([]);
    expect(captured.filter((event) => event.type === "agent.text.delta")).toEqual([]);
    expect(
      captured
        .filter((event) => event.type === "agent.message.end")
        .map((event) => event.payload.stopReason),
    ).toEqual(["canceled"]);
  });

  it("retires immediately after a terminal even if the provider would throw afterward", async () => {
    const backend: ChatBackend = {
      name: "terminal-then-throw",
      model: "terminal-then-throw",
      async *runTurn(input) {
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "end_turn",
          },
        };
        throw new Error("unreachable provider failure");
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });
    const captured: AgentEvent[] = [];
    session.subscribe((event) => captured.push(event));

    await expect(session.send("finish").completion).resolves.toMatchObject({
      stopReason: "end_turn",
    });

    expect(session.busy).toBe(false);
    expect(captured.filter((event) => event.type === "agent.error")).toEqual([]);
    expect(captured.filter((event) => event.type === "agent.message.end")).toHaveLength(1);
  });

  it("retires immediately after a terminal even if the provider would never close", async () => {
    const backend: ChatBackend = {
      name: "terminal-then-hang",
      model: "terminal-then-hang",
      async *runTurn(input) {
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "end_turn",
          },
        };
        await new Promise<never>(() => undefined);
      },
    };
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "",
      idGen: () => "M",
    });

    await expect(session.send("finish").completion).resolves.toMatchObject({
      stopReason: "end_turn",
    });
    expect(session.busy).toBe(false);
  });
});

describe("AgentSession — what each turn carries from the session", () => {
  /** A backend that records the TurnInput it was handed and ends the turn. */
  function recordingBackend(): { backend: ChatBackend; seen: () => TurnInput | undefined } {
    let seen: TurnInput | undefined;
    return {
      seen: () => seen,
      backend: {
        name: "recording",
        model: "recording",
        async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
          seen = input;
          yield {
            type: "agent.message.end",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              stopReason: "end_turn",
            },
          };
        },
      },
    };
  }

  it("forwards the session's zone onto every turn, for the tool context to carry", async () => {
    const { backend, seen } = recordingBackend();
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "test",
      timeZone: "Asia/Tokyo",
    });

    await session.send("what's on today");

    expect(seen()?.timeZone).toBe("Asia/Tokyo");
  });

  it("leaves the zone unset when the session was built without one", async () => {
    const { backend, seen } = recordingBackend();
    const session = new AgentSession({ sessionId: "S", backend, tools: [], systemPrompt: "test" });

    await session.send("what's on today");

    expect(seen()?.timeZone).toBeUndefined();
  });

  // Same recording backend, a different fact: who the turn speaks for. The
  // session holds it once, at construction, and every turn has to carry it —
  // the tools scope what they disclose by audience, and a turn that arrives
  // without one is treated as speaking for nobody. Dropping the line that
  // carries it would silently narrow the operator's own surfaces to nothing,
  // with no error anywhere and every other assertion still green.
  it("forwards the audience the session speaks for onto every turn", async () => {
    const { backend, seen } = recordingBackend();
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "test",
      caller: { kind: "integration", slug: "openclaw" },
    });

    await session.send("what am I watching for?");

    expect(seen()?.caller).toEqual({ kind: "integration", slug: "openclaw" });
  });

  it("carries the operator's own audience just as literally", async () => {
    const { backend, seen } = recordingBackend();
    const session = new AgentSession({
      sessionId: "S",
      backend,
      tools: [],
      systemPrompt: "test",
      caller: { kind: "operator" },
    });

    await session.send("what am I watching for?");

    expect(seen()?.caller).toEqual({ kind: "operator" });
  });

  it("leaves the audience unset when the boundary could not say", async () => {
    const { backend, seen } = recordingBackend();
    const session = new AgentSession({ sessionId: "S", backend, tools: [], systemPrompt: "test" });

    await session.send("what am I watching for?");

    expect(seen()?.caller).toBeUndefined();
  });
});

describe("AgentSession rate-limit patience", () => {
  function capturingBackend(inputs: TurnInput[]): ChatBackend {
    return {
      name: "capture",
      model: "capture",
      async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
        inputs.push(input);
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
  }

  it("forwards the session's patience to every turn", async () => {
    const inputs: TurnInput[] = [];
    const session = new AgentSession({
      sessionId: "S",
      backend: capturingBackend(inputs),
      tools: [],
      systemPrompt: "test",
      rateLimitPatience: { maxAttempts: 4, maxTotalDelayMs: 90_000 },
    });
    await session.send("first").completion;
    await session.send("second").completion;

    expect(inputs.map((input) => input.rateLimitPatience)).toEqual([
      { maxAttempts: 4, maxTotalDelayMs: 90_000 },
      { maxAttempts: 4, maxTotalDelayMs: 90_000 },
    ]);
  });

  it("leaves the backend default in place when the session sets none", async () => {
    const inputs: TurnInput[] = [];
    const session = new AgentSession({
      sessionId: "S",
      backend: capturingBackend(inputs),
      tools: [],
      systemPrompt: "test",
    });
    await session.send("hello").completion;

    expect(inputs[0]).not.toHaveProperty("rateLimitPatience");
  });
});
