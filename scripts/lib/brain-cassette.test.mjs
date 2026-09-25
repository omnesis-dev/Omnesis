// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import {
  buildBrainEntries,
  serializeBrainCassette,
  triggersForKind,
  MUTATING_TOOLS,
} from "./brain-cassette.mjs";
import { COGNITION_MUTATING_TOOL_NAMES } from "../../packages/gateway/src/brain/steward/tools.ts";

const S = "loop-agent-run-run_1-a1";
const M = "msg_1";

const toolStart = (toolCallId, tool, args) => ({
  type: "agent.tool.start",
  payload: { sessionId: S, messageId: M, toolCallId, tool, args },
});
const toolResult = (toolCallId, result) => ({
  type: "agent.tool.result",
  payload: { sessionId: S, messageId: M, toolCallId, durationMs: 2, result },
});
const structured = (data) => ({ kind: "structured", resultType: "x", data });

describe("brain cassette transform", () => {
  it("keeps the recorded result of a read-only call, so replay does not depend on the corpus", () => {
    const { entries, liveCalls } = buildBrainEntries([
      toolStart("t1", "open_loop_search", { query: "deposit" }),
      toolResult("t1", structured({ loops: [] })),
    ]);
    expect(liveCalls).toEqual([]);
    expect(entries.map((e) => e.event.type)).toEqual(["agent.tool.start", "agent.tool.result"]);
  });

  it("drops a mutating call's result so the real tool runs at replay time", () => {
    const { entries, liveCalls } = buildBrainEntries([
      toolStart("t1", "open_loop_create", { title: "Track it" }),
      toolResult("t1", structured({ loop: { id: "loop_abc123" } })),
    ]);
    expect(liveCalls).toEqual(["open_loop_create"]);
    expect(entries.map((e) => e.event.type)).toEqual(["agent.tool.start"]);
  });

  it("lifts an id a later call reuses into a capture, and rewrites the reference", () => {
    const { entries, captures } = buildBrainEntries([
      toolStart("t1", "open_loop_create", { title: "Track it" }),
      toolResult("t1", structured({ loop: { id: "loop_abc123" } })),
      toolStart("t2", "open_loop_ledger_append", { id: "loop_abc123", note: "n" }),
      toolResult("t2", structured({ ok: true })),
    ]);
    expect(entries[0].capture).toEqual({ loop1: "data.loop.id" });
    expect(entries[1].event.payload.args).toEqual({ id: "$CAP_loop1", note: "n" });
    expect(captures).toEqual({ $CAP_loop1: "loop_abc123" });
  });

  it("does not capture an id nothing later uses", () => {
    const { entries } = buildBrainEntries([
      toolStart("t1", "open_loop_create", { title: "Track it" }),
      toolResult("t1", structured({ loop: { id: "loop_abc123" } })),
    ]);
    expect(entries[0].capture).toBeUndefined();
  });

  it("names two captures of the same kind distinctly", () => {
    const { entries } = buildBrainEntries([
      toolStart("t1", "open_loop_create", { title: "A" }),
      toolResult("t1", structured({ loop: { id: "loop_aaa111" } })),
      toolStart("t2", "open_loop_create", { title: "B" }),
      toolResult("t2", structured({ loop: { id: "loop_bbb222" } })),
      toolStart("t3", "brief_create", {
        kind: "loop",
        relatedLoopIds: ["loop_aaa111", "loop_bbb222"],
      }),
    ]);
    expect(entries[0].capture).toEqual({ loop1: "data.loop.id" });
    expect(entries[1].capture).toEqual({ loop2: "data.loop.id" });
    expect(entries[2].event.payload.args.relatedLoopIds).toEqual(["$CAP_loop1", "$CAP_loop2"]);
  });

  it("substitutes the session and message ids it minted", () => {
    const { entries } = buildBrainEntries([toolStart("t1", "open_loop_search", { query: "x" })]);
    const { jsonl } = serializeBrainCassette(entries, { sessionId: S, messageId: M });
    expect(jsonl).toContain("$SESSION");
    expect(jsonl).toContain("$MSG");
    expect(jsonl).not.toContain(S);
  });

  it("substitutes document ids for their external ids", () => {
    const { entries } = buildBrainEntries([
      toolStart("t1", "brief_create", { kind: "info", citations: ["doc_zzz999"] }),
    ]);
    const { jsonl } = serializeBrainCassette(
      entries,
      { sessionId: S, messageId: M },
      { docExternalIds: { doc_zzz999: "bench-deposit" } },
    );
    expect(jsonl).toContain("$DOC_bench-deposit");
    expect(jsonl).not.toContain("doc_zzz999");
  });

  it("refuses to write a cassette carrying something real-looking", () => {
    const { entries } = buildBrainEntries([
      toolStart("t1", "brief_create", {
        kind: "info",
        description: "reach them at someone@a-real-looking-domain.co.uk",
      }),
    ]);
    expect(() => serializeBrainCassette(entries, { sessionId: S, messageId: M })).toThrow(
      /Refusing to write cassette/,
    );
  });

  it("triggers on the run kind, which is the only stable thing in the envelope", () => {
    expect(triggersForKind("data")).toEqual(["kind: data"]);
  });

  /**
   * A tool missing from the recorder's list would replay its recorded result
   * and silently write nothing — the cassette would look fine and assert
   * nothing. Keeping the two lists in lockstep is what prevents that.
   */
  it("treats exactly the gateway's mutating tools as live", () => {
    expect([...MUTATING_TOOLS].sort()).toEqual([...COGNITION_MUTATING_TOOL_NAMES].sort());
  });
});
