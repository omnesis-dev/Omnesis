// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { z } from "zod";
import {
  ReplayBackend,
  RoutingReplayBackend,
  parseFixture,
  serializeFixture,
  type ReplayFixture,
  type ReplayScenario,
} from "./replay-backend.js";

import type { AgentEvent, ToolResult } from "@omnesis/core";
import type { ToolHandle, TurnInput } from "./backend.js";

async function drainEvents(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

function fixture(events: AgentEvent[], afterMs = 0): ReplayFixture {
  return { name: "test", entries: events.map((event) => ({ afterMs, event })) };
}

describe("ReplayBackend", () => {
  it("emits a fixture's events in order with placeholders substituted", async () => {
    const fx = fixture([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "Hello " },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "world" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);

    const backend = new ReplayBackend({ fixtures: [fx] });
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn({
      sessionId: "S1",
      messageId: "M1",
      history: [],
      userMessage: "hi",
      tools: [],
      systemPrompt: "",
    })) {
      events.push(e);
    }

    expect(events.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.text.delta",
      "agent.text.delta",
      "agent.message.end",
    ]);
    expect((events[0]!.payload as { sessionId: string }).sessionId).toBe("S1");
    expect((events[0]!.payload as { messageId: string }).messageId).toBe("M1");
    expect((events[1]!.payload as { delta: string }).delta).toBe("Hello ");
  });

  it("consumes one fixture per runTurn call", async () => {
    const fx1 = fixture([
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    const fx2 = fixture([
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    const backend = new ReplayBackend({ fixtures: [fx1, fx2] });

    const input = {
      sessionId: "S",
      messageId: "M",
      history: [],
      userMessage: "x",
      tools: [],
      systemPrompt: "",
    };

    let count = 0;
    for await (const _ of backend.runTurn(input)) count++;
    expect(count).toBe(1);

    let count2 = 0;
    for await (const _ of backend.runTurn(input)) count2++;
    expect(count2).toBe(1);

    // Third call → exhausted. Yields an `agent.error` event + clean end
    // (we don't throw — a fixture running out shouldn't crash the session).
    const events: AgentEvent[] = [];
    for await (const e of backend.runTurn(input)) events.push(e);
    const types = events.map((e) => e.type);
    expect(types).toContain("agent.error");
    expect(types).toContain("agent.message.end");
    const err = events.find((e) => e.type === "agent.error");
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("fixture_exhausted");
    }
  });

  it("honours AbortSignal during sleep between events", async () => {
    const fx = fixture(
      [
        {
          type: "agent.message.start",
          payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
        },
        {
          type: "agent.text.delta",
          payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "never seen" },
        },
      ],
      500, // long sleep between events
    );
    const backend = new ReplayBackend({ fixtures: [fx], clampMs: 500 });
    const controller = new AbortController();

    const stream = backend.runTurn(
      {
        sessionId: "S",
        messageId: "M",
        history: [],
        userMessage: "x",
        tools: [],
        systemPrompt: "",
      },
      controller.signal,
    );

    setTimeout(() => controller.abort(), 30);
    const events: AgentEvent[] = [];
    for await (const e of stream) events.push(e);

    // Got at most the first event (after waiting 500ms), or zero.
    expect(events.length).toBeLessThan(2);
  });

  it("parses and serializes a JSONL fixture round-trip", () => {
    const src = [
      "# comment line",
      "",
      JSON.stringify({
        afterMs: 0,
        event: {
          type: "agent.message.start",
          payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
        },
      }),
      JSON.stringify({
        afterMs: 12,
        event: {
          type: "agent.text.delta",
          payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "x" },
        },
      }),
    ].join("\n");
    const parsed = parseFixture("f", src);
    expect(parsed.entries.length).toBe(2);
    expect(parsed.entries[0]!.event.type).toBe("agent.message.start");
    const out = serializeFixture(parsed);
    const reparsed = parseFixture("f", out);
    expect(reparsed.entries.length).toBe(2);
  });

  it("round-trips the three agent.subagent.* event kinds through parse/serialize (#748)", () => {
    const src = [
      JSON.stringify({
        afterMs: 0,
        event: {
          type: "agent.subagent.spawned",
          payload: {
            sessionId: "$SESSION",
            subagentId: "$SESSION.sub.1",
            specialist: "history-sweep",
            task: "sweep the archive",
          },
        },
      }),
      JSON.stringify({
        afterMs: 5,
        event: {
          type: "agent.subagent.event",
          payload: {
            sessionId: "$SESSION",
            subagentId: "$SESSION.sub.1",
            specialist: "history-sweep",
            event: {
              type: "agent.text.delta",
              payload: { sessionId: "$SESSION.sub.1", messageId: "$MSG", delta: "hi" },
            },
          },
        },
      }),
      JSON.stringify({
        afterMs: 5,
        event: {
          type: "agent.subagent.result",
          payload: {
            sessionId: "$SESSION",
            subagentId: "$SESSION.sub.1",
            specialist: "history-sweep",
            status: "complete",
            summary: "found three things",
            citations: [{ documentId: "d1", sourceType: "demo", sourceId: "demo-1" }],
            usage: { inputTokens: 10, outputTokens: 4 },
          },
        },
      }),
    ].join("\n");
    const parsed = parseFixture("f", src);
    expect(parsed.entries.map((e) => e.event.type)).toEqual([
      "agent.subagent.spawned",
      "agent.subagent.event",
      "agent.subagent.result",
    ]);
    // Serialize → reparse is lossless for the new kinds.
    const reparsed = parseFixture("f", serializeFixture(parsed));
    expect(reparsed.entries.map((e) => e.event.type)).toEqual([
      "agent.subagent.spawned",
      "agent.subagent.event",
      "agent.subagent.result",
    ]);
  });

  it("rejects a malformed agent.subagent.result payload (#748)", () => {
    const src = JSON.stringify({
      afterMs: 0,
      event: {
        type: "agent.subagent.result",
        payload: { sessionId: "$SESSION" /* missing subagentId, status, summary, citations */ },
      },
    });
    expect(() => parseFixture("f", src)).toThrow(/payload for agent\.subagent\.result/);
  });

  it("rejects a malformed event payload at parse time", () => {
    const src = JSON.stringify({
      afterMs: 0,
      event: {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION" /* missing messageId, delta */ },
      },
    });
    expect(() => parseFixture("f", src)).toThrow(/payload for agent\.text\.delta/);
  });

  it("rejects an unknown event type", () => {
    const src = JSON.stringify({
      afterMs: 0,
      event: { type: "totally.not.a.type", payload: {} },
    });
    expect(() => parseFixture("f", src)).toThrow(/agent\.\*/);
  });

  it("serves concurrent runTurn invocations from distinct fixtures without interleaving", async () => {
    // Two callers iterate the same backend in parallel. Each must get a
    // full, ordered fixture — fixture assignment is captured at function
    // entry so the cursor advance can't race.
    const fx1 = fixture([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "A1" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "A2" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    const fx2 = fixture([
      {
        type: "agent.message.start",
        payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
      },
      {
        type: "agent.text.delta",
        payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "B1" },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    const backend = new ReplayBackend({ fixtures: [fx1, fx2] });

    const a = backend.runTurn({
      sessionId: "SA",
      messageId: "MA",
      history: [],
      userMessage: "x",
      tools: [],
      systemPrompt: "",
    });
    const b = backend.runTurn({
      sessionId: "SB",
      messageId: "MB",
      history: [],
      userMessage: "x",
      tools: [],
      systemPrompt: "",
    });

    async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
      const out: AgentEvent[] = [];
      for await (const e of iter) out.push(e);
      return out;
    }

    const [eventsA, eventsB] = await Promise.all([drain(a), drain(b)]);

    expect(eventsA.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.text.delta",
      "agent.text.delta",
      "agent.message.end",
    ]);
    expect(eventsB.map((e) => e.type)).toEqual([
      "agent.message.start",
      "agent.text.delta",
      "agent.message.end",
    ]);
    const aDeltas = eventsA
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e.payload as { delta: string }).delta);
    expect(aDeltas).toEqual(["A1", "A2"]);
    const bDeltas = eventsB
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e.payload as { delta: string }).delta);
    expect(bDeltas).toEqual(["B1"]);
  });

  it("reports one llmProbe span per turn with the terminal usage", async () => {
    const fx = fixture([
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
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          stopReason: "end_turn",
          usage: { inputTokens: 40, outputTokens: 8 },
        },
      },
    ]);
    const backend = new ReplayBackend({ fixtures: [fx] });
    const timings: Array<{
      requestIndex: number;
      ttftMs: number | null;
      wallMs: number;
      inputTokens?: number;
      outputTokens?: number;
    }> = [];
    for await (const _e of backend.runTurn({
      sessionId: "S",
      messageId: "M",
      history: [],
      userMessage: "hi",
      tools: [],
      systemPrompt: "",
      llmProbe: (timing) => timings.push(timing),
    })) {
      // Drain the stream; the probe observes passively.
    }
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({
      requestIndex: 1,
      inputTokens: 40,
      outputTokens: 8,
    });
    expect(timings[0]!.ttftMs).not.toBeNull();
    expect(timings[0]!.wallMs).toBeGreaterThanOrEqual(0);
  });
});

describe("ReplayBackend tool calls", () => {
  function toolHandle(name: string, invoke: (args: unknown) => Promise<ToolResult>): ToolHandle {
    return {
      name,
      description: name,
      schema: z.unknown(),
      invoke: (args) => invoke(args),
    };
  }

  function turn(tools: ToolHandle[]): TurnInput {
    return {
      sessionId: "S1",
      messageId: "M1",
      history: [],
      userMessage: "go",
      tools,
      systemPrompt: "",
    };
  }

  const start = (toolCallId: string, tool: string, args: Record<string, unknown>): AgentEvent => ({
    type: "agent.tool.start",
    payload: { sessionId: "$SESSION", messageId: "$MSG", toolCallId, tool, args },
  });

  it("replays a recorded result and never runs the tool", async () => {
    const calls: unknown[] = [];
    const fx = fixture([
      start("tc1", "search_many", { queries: ["x"] }),
      {
        type: "agent.tool.result",
        payload: {
          sessionId: "$SESSION",
          messageId: "$MSG",
          toolCallId: "tc1",
          durationMs: 3,
          result: { kind: "text", text: "recorded" },
        },
      },
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    const backend = new ReplayBackend({ fixtures: [fx] });
    const events = await drainEvents(
      backend.runTurn(
        turn([
          toolHandle("search_many", async (args) => {
            calls.push(args);
            return { kind: "text", text: "live" };
          }),
        ]),
      ),
    );

    expect(calls).toEqual([]);
    const results = events.filter((e) => e.type === "agent.tool.result");
    expect(results).toHaveLength(1);
    expect((results[0]!.payload as { result: ToolResult }).result).toEqual({
      kind: "text",
      text: "recorded",
    });
  });

  it("runs the real tool when the fixture records no result for the call", async () => {
    const calls: unknown[] = [];
    const fx = fixture([
      start("tc1", "submit_privacy_review", { decision: "allow" }),
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    const backend = new ReplayBackend({ fixtures: [fx] });
    const events = await drainEvents(
      backend.runTurn(
        turn([
          toolHandle("submit_privacy_review", async (args) => {
            calls.push(args);
            return { kind: "structured", resultType: "privacy_review.accepted", data: {} };
          }),
        ]),
      ),
    );

    // The tool ran with the recorded arguments, and its real answer — not a
    // recorded one — is what the session sees.
    expect(calls).toEqual([{ decision: "allow" }]);
    expect(events.map((e) => e.type)).toEqual([
      "agent.tool.start",
      "agent.tool.result",
      "agent.message.end",
    ]);
    expect((events[1]!.payload as { result: ToolResult }).result).toMatchObject({
      kind: "structured",
      resultType: "privacy_review.accepted",
    });
    expect((events[1]!.payload as { toolCallId: string }).toolCallId).toBe("tc1");
  });

  it("reports a live call to a tool the turn does not offer as an error result", async () => {
    const fx = fixture([
      start("tc1", "gone_tool", {}),
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    const backend = new ReplayBackend({ fixtures: [fx] });
    const events = await drainEvents(backend.runTurn(turn([])));

    expect((events[1]!.payload as { result: ToolResult }).result).toMatchObject({
      kind: "error",
      code: "tool_not_available",
    });
  });

  it("turns a throwing tool into an error result rather than breaking the stream", async () => {
    const fx = fixture([
      start("tc1", "boom", {}),
      {
        type: "agent.message.end",
        payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
      },
    ]);
    const backend = new ReplayBackend({ fixtures: [fx] });
    const events = await drainEvents(
      backend.runTurn(
        turn([
          toolHandle("boom", () => {
            throw new Error("tool exploded");
          }),
        ]),
      ),
    );

    expect(events.map((e) => e.type)).toEqual([
      "agent.tool.start",
      "agent.tool.result",
      "agent.message.end",
    ]);
    expect((events[1]!.payload as { result: ToolResult }).result).toMatchObject({
      kind: "error",
      code: "tool_failed",
      message: "tool exploded",
    });
  });
});

describe("RoutingReplayBackend", () => {
  function scenario(name: string, triggers: string[], deltaText: string): ReplayScenario {
    return {
      name,
      triggers,
      fixture: fixture([
        {
          type: "agent.message.start",
          payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
        },
        {
          type: "agent.text.delta",
          payload: { sessionId: "$SESSION", messageId: "$MSG", delta: deltaText },
        },
        {
          type: "agent.message.end",
          payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
        },
      ]),
    };
  }

  function input(userMessage: string): Parameters<RoutingReplayBackend["runTurn"]>[0] {
    return {
      sessionId: "S",
      messageId: "M",
      history: [],
      userMessage,
      tools: [],
      systemPrompt: "",
    };
  }

  async function drain(iter: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const e of iter) out.push(e);
    return out;
  }

  it("routes the first user message to the scenario whose trigger matches", async () => {
    const backend = new RoutingReplayBackend({
      scenarios: [
        scenario("vendor-eval", ["vendor", "globex"], "VENDOR_PICKED"),
        scenario("citations", ["cite", "citation"], "CITATIONS_PICKED"),
      ],
    });
    const events = await drain(backend.runTurn(input("Show me the vendor comparison")));
    const deltas = events
      .filter((e) => e.type === "agent.text.delta")
      .map((e) => (e.payload as { delta: string }).delta);
    expect(deltas).toEqual(["VENDOR_PICKED"]);
  });

  it("matches case-insensitively", async () => {
    const backend = new RoutingReplayBackend({
      scenarios: [scenario("vendor-eval", ["GLOBEX"], "MATCHED")],
    });
    const events = await drain(backend.runTurn(input("what's up with globex?")));
    const deltas = events.filter((e) => e.type === "agent.text.delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0]!.payload as { delta: string }).delta).toBe("MATCHED");
  });

  it("picks the first listed scenario when triggers overlap", async () => {
    const backend = new RoutingReplayBackend({
      scenarios: [
        scenario("first", ["evaluation"], "FIRST"),
        scenario("second", ["evaluation"], "SECOND"),
      ],
    });
    const events = await drain(backend.runTurn(input("kick off the evaluation")));
    const delta = events.find((e) => e.type === "agent.text.delta");
    expect((delta!.payload as { delta: string }).delta).toBe("FIRST");
  });

  it("emits a synthetic 'no scenario matched' stream when nothing matches", async () => {
    const backend = new RoutingReplayBackend({
      scenarios: [scenario("vendor-eval", ["vendor"], "X"), scenario("citations", ["cite"], "Y")],
    });
    const events = await drain(backend.runTurn(input("hello there")));
    const types = events.map((e) => e.type);
    expect(types).toEqual(["agent.message.start", "agent.text.delta", "agent.message.end"]);
    const delta = (events[1]!.payload as { delta: string }).delta;
    expect(delta).toMatch(/No demo scenario matched/);
    // Both scenarios are listed by name so the demo operator knows what to type.
    expect(delta).toContain("vendor-eval");
    expect(delta).toContain("citations");
  });

  it("locks the session: a second turn after a match emits fixture_exhausted", async () => {
    const backend = new RoutingReplayBackend({
      scenarios: [scenario("vendor-eval", ["vendor"], "X")],
    });
    await drain(backend.runTurn(input("vendor please")));
    const events = await drain(backend.runTurn(input("vendor again")));
    const types = events.map((e) => e.type);
    expect(types).toContain("agent.error");
    const err = events.find((e) => e.type === "agent.error");
    if (err && err.type === "agent.error") {
      expect(err.payload.code).toBe("fixture_exhausted");
    }
  });

  it("locks the session even after a no-match first turn", async () => {
    const backend = new RoutingReplayBackend({
      scenarios: [scenario("vendor-eval", ["vendor"], "X")],
    });
    await drain(backend.runTurn(input("hello there")));
    const events = await drain(backend.runTurn(input("now try vendor")));
    const types = events.map((e) => e.type);
    expect(types).toContain("agent.error");
  });

  it("throws if constructed with no scenarios", () => {
    expect(() => new RoutingReplayBackend({ scenarios: [] })).toThrow(/at least one scenario/);
  });

  it("applies per-scenario substitutions", async () => {
    const scenarioWithSub: ReplayScenario = {
      name: "with-sub",
      triggers: ["go"],
      fixture: fixture([
        {
          type: "agent.message.start",
          payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
        },
        {
          type: "agent.text.delta",
          payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "$DOC_x" },
        },
        {
          type: "agent.message.end",
          payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
        },
      ]),
      substitutions: { $DOC_x: "resolved-uuid-123" },
    };
    const backend = new RoutingReplayBackend({ scenarios: [scenarioWithSub] });
    const events = await drain(backend.runTurn(input("go!")));
    const delta = events.find((e) => e.type === "agent.text.delta");
    expect((delta!.payload as { delta: string }).delta).toBe("resolved-uuid-123");
  });

  it("substitutes placeholders that appear as substrings inside larger strings", async () => {
    // Real-world case: a trigger spec value like `"person:$PERSON_X"` —
    // the `"person:"` prefix is a namespace marker and the placeholder
    // is the remainder. Whole-value substitution alone would leak the
    // placeholder; substring substitution resolves it.
    const scenario: ReplayScenario = {
      name: "substring-sub",
      triggers: ["fire"],
      fixture: fixture([
        {
          type: "agent.message.start",
          payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
        },
        {
          type: "agent.text.delta",
          payload: {
            sessionId: "$SESSION",
            messageId: "$MSG",
            // Both whole-value ($DOC_a) and substring ($PERSON_n
            // embedded in `"person:..."`) should resolve.
            delta: "doc=$DOC_a person=person:$PERSON_n",
          },
        },
        {
          type: "agent.message.end",
          payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
        },
      ]),
      substitutions: {
        $DOC_a: "uuid-doc",
        $PERSON_n: "uuid-person",
      },
    };
    const backend = new RoutingReplayBackend({ scenarios: [scenario] });
    const events = await drain(backend.runTurn(input("fire away")));
    const delta = events.find((e) => e.type === "agent.text.delta");
    expect((delta!.payload as { delta: string }).delta).toBe(
      "doc=uuid-doc person=person:uuid-person",
    );
  });

  it("leaves strings without a `$` untouched (substitution fast-path)", async () => {
    // Substring scan only kicks in when the string contains `$`. A plain
    // string like `"hello world"` should never be searched.
    const scenario: ReplayScenario = {
      name: "no-dollar",
      triggers: ["yo"],
      fixture: fixture([
        {
          type: "agent.message.start",
          payload: { sessionId: "$SESSION", messageId: "$MSG", role: "assistant" },
        },
        {
          type: "agent.text.delta",
          payload: { sessionId: "$SESSION", messageId: "$MSG", delta: "hello world" },
        },
        {
          type: "agent.message.end",
          payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
        },
      ]),
      substitutions: { $DOC_a: "uuid-doc" },
    };
    const backend = new RoutingReplayBackend({ scenarios: [scenario] });
    const events = await drain(backend.runTurn(input("yo")));
    const delta = events.find((e) => e.type === "agent.text.delta");
    expect((delta!.payload as { delta: string }).delta).toBe("hello world");
  });
});

describe("ReplayBackend live-result captures", () => {
  function toolHandle(name: string, invoke: (args: unknown) => Promise<ToolResult>): ToolHandle {
    return { name, description: name, schema: z.unknown(), invoke: (args) => invoke(args) };
  }
  function turn(tools: ToolHandle[]): TurnInput {
    return {
      sessionId: "S1",
      messageId: "M1",
      history: [],
      userMessage: "go",
      tools,
      systemPrompt: "",
    };
  }
  const start = (toolCallId: string, tool: string, args: Record<string, unknown>): AgentEvent => ({
    type: "agent.tool.start",
    payload: { sessionId: "$SESSION", messageId: "$MSG", toolCallId, tool, args },
  });
  const end: AgentEvent = {
    type: "agent.message.end",
    payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
  };

  /** A cassette that creates something, then acts on the id it really got. */
  function createThenAppend(): ReplayFixture {
    return {
      name: "capture",
      entries: [
        {
          afterMs: 0,
          event: start("tc1", "open_loop_create", { title: "Track it" }),
          capture: { loop1: "data.loop.id" },
        },
        {
          afterMs: 0,
          event: start("tc2", "open_loop_ledger_append", { id: "$CAP_loop1", note: "n" }),
        },
        { afterMs: 0, event: end },
      ],
    };
  }

  it("threads a live result's id into a later call", async () => {
    const seen: unknown[] = [];
    const backend = new ReplayBackend({ fixtures: [createThenAppend()] });
    await drainEvents(
      backend.runTurn(
        turn([
          toolHandle("open_loop_create", async () => ({
            kind: "structured",
            resultType: "open_loop.created",
            data: { loop: { id: "loop_minted_now" } },
          })),
          toolHandle("open_loop_ledger_append", async (args) => {
            seen.push(args);
            return { kind: "text", text: "ok" };
          }),
        ]),
      ),
    );
    expect(seen).toEqual([{ id: "loop_minted_now", note: "n" }]);
  });

  it("shows the resolved id in the emitted tool.start, so transcripts stay honest", async () => {
    const backend = new ReplayBackend({ fixtures: [createThenAppend()] });
    const events = await drainEvents(
      backend.runTurn(
        turn([
          toolHandle("open_loop_create", async () => ({
            kind: "structured",
            resultType: "open_loop.created",
            data: { loop: { id: "loop_minted_now" } },
          })),
          toolHandle("open_loop_ledger_append", async () => ({ kind: "text", text: "ok" })),
        ]),
      ),
    );
    const appendStart = events.find(
      (e) =>
        e.type === "agent.tool.start" &&
        (e.payload as { tool: string }).tool === "open_loop_ledger_append",
    );
    expect((appendStart!.payload as { args: { id: string } }).args.id).toBe("loop_minted_now");
  });

  it("a capture that misses is loud, never a literal placeholder in a real call", async () => {
    const seen: unknown[] = [];
    const backend = new ReplayBackend({ fixtures: [createThenAppend()] });
    await drainEvents(
      backend.runTurn(
        turn([
          // No `data.loop.id` in this result — the capture cannot resolve.
          toolHandle("open_loop_create", async () => ({ kind: "text", text: "no id here" })),
          toolHandle("open_loop_ledger_append", async (args) => {
            seen.push(args);
            return { kind: "text", text: "ok" };
          }),
        ]),
      ),
    );
    expect((seen[0] as { id: string }).id).toBe("__CAPTURE_MISS_loop1__");
  });

  it("captures do not leak between turns", async () => {
    const seen: unknown[] = [];
    // Turn 1 captures a real id; turn 2's create returns none. If the capture
    // table were shared, turn 2 would inherit turn 1's id — so the miss
    // sentinel is what proves the isolation. (Two missing turns would pass
    // whether the table were per-turn or per-instance, and prove nothing.)
    let turnsServed = 0;
    const tools = [
      toolHandle("open_loop_create", async () =>
        turnsServed++ === 0
          ? {
              kind: "structured",
              resultType: "open_loop.created",
              data: { loop: { id: "loop_A" } },
            }
          : { kind: "text", text: "no id" },
      ),
      toolHandle("open_loop_ledger_append", async (args) => {
        seen.push(args);
        return { kind: "text", text: "ok" };
      }),
    ];
    const backend = new ReplayBackend({ fixtures: [createThenAppend(), createThenAppend()] });
    await drainEvents(backend.runTurn(turn(tools)));
    await drainEvents(backend.runTurn(turn(tools)));
    expect(seen.map((s) => (s as { id: string }).id)).toEqual(["loop_A", "__CAPTURE_MISS_loop1__"]);
  });

  it("a capture name that prefixes another does not eat it", async () => {
    // Names are minted `loop1 … loop9, loop10`, so the colliding pair is
    // reached by any recording that creates ten loops.
    const seen: unknown[] = [];
    const fixture: ReplayFixture = {
      name: "prefix",
      entries: [
        {
          afterMs: 0,
          event: start("t1", "open_loop_create", { title: "first" }),
          capture: { loop1: "data.loop.id" },
        },
        {
          afterMs: 0,
          event: start("t2", "open_loop_create", { title: "tenth" }),
          capture: { loop10: "data.loop.id" },
        },
        {
          afterMs: 0,
          event: start("t3", "open_loop_ledger_append", {
            id: "$CAP_loop10",
            note: "refers to $CAP_loop10 inline",
          }),
        },
        { afterMs: 0, event: end },
      ],
    };
    let created = 0;
    const backend = new ReplayBackend({ fixtures: [fixture] });
    await drainEvents(
      backend.runTurn(
        turn([
          toolHandle("open_loop_create", async () => ({
            kind: "structured",
            resultType: "open_loop.created",
            data: { loop: { id: `loop_${++created === 1 ? "FIRST" : "TENTH"}` } },
          })),
          toolHandle("open_loop_ledger_append", async (args) => {
            seen.push(args);
            return { kind: "text", text: "ok" };
          }),
        ]),
      ),
    );
    expect(seen).toEqual([{ id: "loop_TENTH", note: "refers to loop_TENTH inline" }]);
  });

  it("parses and round-trips a capture through JSONL", () => {
    const line = JSON.stringify({
      afterMs: 0,
      event: start("tc1", "open_loop_create", { title: "x" }),
      capture: { loop1: "data.loop.id" },
    });
    const parsed = parseFixture("f", line);
    expect(parsed.entries[0]!.capture).toEqual({ loop1: "data.loop.id" });
    expect(parseFixture("f", serializeFixture(parsed)).entries[0]!.capture).toEqual({
      loop1: "data.loop.id",
    });
  });

  it("rejects a malformed capture at parse time", () => {
    const bad = JSON.stringify({
      afterMs: 0,
      event: start("tc1", "open_loop_create", { title: "x" }),
      capture: { loop1: 7 },
    });
    expect(() => parseFixture("f", bad)).toThrow(/capture 'loop1' must be a non-empty path/);
  });
});
