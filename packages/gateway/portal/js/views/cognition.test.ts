// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// The read-only cognition debug surface is EXPERIMENTAL-gated, exactly like the
// Triggers nav item: the tab is added to the Debug tab bar only when the gateway
// advertises experimental mode (read from `GET /status`). This asserts the
// gate on the pure `debugTabs(experimental)` helper (no DOM renderer needed)
// and smoke-imports the view module so a template/import typo reddens the build.

import { describe, it, expect } from "vitest";

describe("Cognition debug tab — experimental gating", () => {
  it("is hidden when experimental is off, shown when on (mirrors the Triggers gate)", async () => {
    // @ts-expect-error — portal is plain JS, no .d.ts ships alongside.
    const { debugTabs } = await import("../lib/debug-tabs.js");
    const off = debugTabs(false).map((t) => t.key);
    const on = debugTabs(true).map((t) => t.key);
    expect(off).toEqual(["data", "sql", "graph", "metrics", "background-jobs", "doctor"]);
    expect(off).not.toContain("cognition");
    // Flipping experimental ONLY inserts the experimental tabs — the stock ones
    // keep both their membership and their relative order, with Doctor still last.
    expect(on).toEqual([
      "data",
      "sql",
      "graph",
      "metrics",
      "background-jobs",
      "cognition",
      "watch",
      "doctor",
    ]);
    expect(on.filter((k) => off.includes(k))).toEqual(off);
  });

  it("the Cognition view module imports cleanly and exports the view", async () => {
    // @ts-expect-error — portal JS module, no .d.ts.
    const mod = await import("./cognition.js");
    expect(typeof mod.CognitionView).toBe("function");
  });
});

// The inactive-brain gate every cognition tab reads: raw `/admin/brain/*`
// 404s must render as the "not running" notice, never as red errors.
describe("brainGateFromStatus — the Brain-inactive gate", () => {
  async function gateOf(data: unknown) {
    // @ts-expect-error — portal JS module, no .d.ts ships alongside.
    const { brainGateFromStatus } = await import("./cognition.js");
    return brainGateFromStatus(data) as { briefsGate: unknown; brainBlocked: boolean };
  }

  it("an active brain never blocks", async () => {
    const { brainBlocked } = await gateOf({
      brain: { visible: true, enabled: true, modelAssigned: true, active: true },
    });
    expect(brainBlocked).toBe(false);
  });

  it("experimental on but no model blocks (the reported case)", async () => {
    const { briefsGate, brainBlocked } = await gateOf({
      brain: {
        visible: true,
        enabled: true,
        modelAssigned: false,
        active: false,
        reason: "no background-agent model assigned",
      },
    });
    expect(brainBlocked).toBe(true);
    expect(briefsGate).toMatchObject({ active: false });
  });

  it("reads the legacy `briefs` field when `brain` is absent", async () => {
    const { brainBlocked } = await gateOf({
      briefs: { visible: true, enabled: true, modelAssigned: false, active: false },
    });
    expect(brainBlocked).toBe(true);
  });

  it("unknown status (still loading, or predates the field) never blocks", async () => {
    for (const data of [null, undefined, {}, { brain: null }]) {
      expect((await gateOf(data)).brainBlocked).toBe(false);
    }
  });

  it("blocked without a reason still counts as blocked (the banner carries a fallback)", async () => {
    // A model assigned while the feature switch is off yields active:false
    // with no reason — history still shows, so the banner must too.
    const { briefsGate, brainBlocked } = await gateOf({
      brain: { visible: true, enabled: false, modelAssigned: true, active: false },
    });
    expect(brainBlocked).toBe(true);
    expect(briefsGate).toMatchObject({ active: false });
  });
});

// These tests cover the Formatted transcript view (the Raw / Formatted toggle),
// which folds the stored AgentEvent stream into readable turns via
// `transcriptEventsToTurns`. They
// assert the fold at the data level (the render itself is verified by the
// mandatory portal screenshot self-critique): tool calls carry the tool name,
// text stays text (never JSON), thinking is captured, and — the key contract —
// an unrecognised event type degrades to a labelled `unknown` part rather than
// vanishing. All fixture data is invented; none comes from any real corpus.
describe("transcriptEventsToTurns — the Formatted transcript fold", () => {
  interface TurnPart {
    kind: string;
    text?: string;
    tool?: string;
    argsSummary?: string;
    result?: { kind?: string } | null;
    type?: string;
  }
  interface Turn {
    role: string;
    parts: TurnPart[];
  }

  async function fold(events: Array<{ type: string; payload: unknown }>): Promise<Turn[]> {
    // @ts-expect-error — portal JS module, no .d.ts ships alongside.
    const { transcriptEventsToTurns } = await import("./agent-reducer.js");
    return transcriptEventsToTurns(events) as Turn[];
  }

  // A run that thinks, searches, creates an open loop, answers — plus one
  // event type the fold has never heard of (the graceful-degrade case).
  const MIXED_EVENTS: Array<{ type: string; payload: unknown }> = [
    { type: "agent.message.start", payload: { sessionId: "s", messageId: "m1", role: "assistant" } },
    { type: "agent.thinking.delta", payload: { sessionId: "s", messageId: "m1", delta: "Was the studio booking confirmed? " } },
    { type: "agent.thinking.delta", payload: { sessionId: "s", messageId: "m1", delta: "Let me check." } },
    { type: "agent.tool.input_start", payload: { sessionId: "s", messageId: "m1", toolCallId: "tc1", tool: "search_documents" } },
    { type: "agent.tool.start", payload: { sessionId: "s", messageId: "m1", toolCallId: "tc1", tool: "search_documents", args: { query: "studio booking confirmation" }, intent: "look for a confirmation" } },
    { type: "agent.tool.result", payload: { sessionId: "s", messageId: "m1", toolCallId: "tc1", result: { kind: "search.results", results: [] }, durationMs: 12 } },
    { type: "agent.tool.start", payload: { sessionId: "s", messageId: "m1", toolCallId: "tc2", tool: "open_loop_create", args: { title: "Reply to the studio booking quote", confidence: 0.8, importance: 0.6 } } },
    { type: "agent.tool.result", payload: { sessionId: "s", messageId: "m1", toolCallId: "tc2", result: { kind: "structured", data: { id: "loop-1" } }, durationMs: 4 } },
    { type: "agent.horizon.pulse", payload: { phase: "waxing" } },
    { type: "agent.text.delta", payload: { sessionId: "s", messageId: "m1", delta: "Created an open loop to reply to the studio booking quote." } },
    { type: "agent.message.end", payload: { sessionId: "s", messageId: "m1", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } } },
  ];

  it("folds a mixed stream into one settled assistant turn with the right part kinds", async () => {
    const turns = await fold(MIXED_EVENTS);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.role).toBe("assistant");
    const kinds = turns[0]!.parts.map((p) => p.kind);
    expect(kinds).toEqual(["thinking", "tool", "tool", "unknown", "text"]);
  });

  it("tool calls carry the tool NAME and an args summary (not raw JSON in the header)", async () => {
    const turns = await fold(MIXED_EVENTS);
    const tools = turns[0]!.parts.filter((p) => p.kind === "tool");
    expect(tools.map((t) => t.tool)).toEqual(["search_documents", "open_loop_create"]);
    // The search summary is the query; the loop-create summary carries its title.
    expect(tools[0]!.argsSummary).toContain("studio booking confirmation");
    expect(tools[1]!.argsSummary).toContain("Reply to the studio booking quote");
    // The tool result lands back on the matching call.
    expect(tools[0]!.result?.kind).toBe("search.results");
    expect(tools[1]!.result?.kind).toBe("structured");
  });

  it("text shows as text — the answer is the literal string, not a JSON blob", async () => {
    const turns = await fold(MIXED_EVENTS);
    const text = turns[0]!.parts.find((p) => p.kind === "text");
    expect(text?.text).toBe("Created an open loop to reply to the studio booking quote.");
    // Coalesced thinking deltas read as prose too.
    const thinking = turns[0]!.parts.find((p) => p.kind === "thinking");
    expect(thinking?.text).toBe("Was the studio booking confirmed? Let me check.");
  });

  it("an unrecognised event type degrades to a labelled `unknown` part — never blank, never dropped", async () => {
    const turns = await fold(MIXED_EVENTS);
    const unknown = turns[0]!.parts.find((p) => p.kind === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown!.type).toBe("agent.horizon.pulse");
    // The known events are all modelled — nothing else fell through to unknown.
    expect(turns[0]!.parts.filter((p) => p.kind === "unknown")).toHaveLength(1);
  });

  it("an empty event stream folds to no turns (the Formatted view renders its empty state)", async () => {
    expect(await fold([])).toEqual([]);
  });

  it("opens a fresh turn per round and marks a settled round done", async () => {
    const turns = await fold([
      { type: "agent.message.start", payload: { messageId: "m1" } },
      { type: "agent.text.delta", payload: { messageId: "m1", delta: "first" } },
      { type: "agent.message.end", payload: { sessionId: "s", messageId: "m1", stopReason: "end_turn" } },
      { type: "agent.message.start", payload: { messageId: "m2" } },
      { type: "agent.text.delta", payload: { messageId: "m2", delta: "second" } },
      { type: "agent.message.end", payload: { sessionId: "s", messageId: "m2", stopReason: "end_turn" } },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => (t.parts[0] as TurnPart).text)).toEqual(["first", "second"]);
  });
});
