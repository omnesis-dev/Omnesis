// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

// Reload-path fan-out for the batch citation tool (annotate_many): a stored
// `annotate.batch` result must rebuild the SAME per-child citations the live
// `agent.citation` events produced, so the Timeline is identical after reopen.

import { describe, expect, it } from "vitest";

import {
  citationsFromMessages,
  trailAnnotationsFromMessages,
  reducer,
  initialState,
} from "./agent-reducer.js";
import { renderPart } from "../components/agent/parts.js";

const r = reducer;
const ref = (id) => ({ documentId: id, sourceType: "gmail", sourceId: "gmail:me", title: id });

function assistantTurn(sessionId, messageId) {
  const s0 = { ...initialState(), sessionId };
  return r(s0, { kind: "agent.message.start", payload: { sessionId, messageId } });
}

const messages = [
  { role: "user", parts: [{ kind: "text", text: "where did I live?" }] },
  {
    role: "assistant",
    parts: [
      {
        kind: "tool_use",
        toolCallId: "tc",
        tool: "annotate_many",
        args: { annotations: [{ documentId: "d1", quote: "q1" }, { documentId: "d2", note: "n2" }] },
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
            { kind: "annotate.recorded", documentId: "d1", ref: ref("d1"), quote: "q1" },
            { kind: "annotate.recorded", documentId: "d2", ref: ref("d2"), note: "n2" },
          ],
        },
      },
    ],
  },
  { role: "assistant", parts: [{ kind: "text", text: "here." }] },
];

describe("portal reducer — annotate_many reload", () => {
  it("citationsFromMessages fans an annotate.batch into one citation per child", () => {
    const cits = citationsFromMessages(messages);
    expect(cits.map((c) => c.documentId).sort()).toEqual(["d1", "d2"]);
    const d1 = cits.find((c) => c.documentId === "d1");
    expect(d1.entries[0].quote).toBe("q1");
    // Per-child stable id (matches the live agent.citation events).
    expect(d1.entries[0].toolCallId).toBe("tc#0");
    const d2 = cits.find((c) => c.documentId === "d2");
    // Note-only routes to a doc-level note, not a quote entry.
    expect(d2.docNote).toBe("n2");
  });

  it("trailAnnotationsFromMessages buckets each batch child by document", () => {
    const { byDoc } = trailAnnotationsFromMessages(messages);
    expect(Object.keys(byDoc).sort()).toEqual(["d1", "d2"]);
  });
});

describe("portal live reducer — batch tool child events", () => {
  const sid = "sess-b";

  it("populates part.children live from agent.tool.child.* and streams the answer (no gate hang)", () => {
    let s = assistantTurn(sid, "m1");
    s = r(s, { kind: "agent.tool.start", payload: { sessionId: sid, toolCallId: "tc", tool: "search_many" } });
    // Children arrive out of order; result before start for one of them.
    s = r(s, {
      kind: "agent.tool.child.start",
      payload: { sessionId: sid, toolCallId: "tc", childIndex: 0, tool: "search_documents", argsSummary: "rent London" },
    });
    s = r(s, {
      kind: "agent.tool.child.start",
      payload: { sessionId: sid, toolCallId: "tc", childIndex: 1, tool: "search_documents", argsSummary: "lease" },
    });
    s = r(s, {
      kind: "agent.tool.child.result",
      payload: { sessionId: sid, toolCallId: "tc", childIndex: 1, result: { kind: "search.results", results: [] } },
    });
    s = r(s, {
      kind: "agent.tool.child.result",
      payload: { sessionId: sid, toolCallId: "tc", childIndex: 0, result: { kind: "search.results", results: [] } },
    });
    // The terminal batch result then the answer text.
    s = r(s, {
      kind: "agent.tool.result",
      payload: { sessionId: sid, toolCallId: "tc", result: { kind: "search.batch", items: [] } },
    });
    s = r(s, { kind: "agent.text.delta", payload: { sessionId: sid, delta: "You lived in two places." } });

    const parts = s.turns[0].parts;
    const toolPart = parts.find((p) => p.kind === "tool" && p.toolCallId === "tc");
    // Children populated live, ordered by index, each carrying the singular name.
    expect(toolPart.children.map((c) => c.index)).toEqual([0, 1]);
    expect(toolPart.children[0].argsSummary).toBe("rent London");
    expect(toolPart.children[0].result).toEqual({ kind: "search.results", results: [] });
    // A batch tool does not gate: the answer text is a live text part, NOT parked
    // on the tool part's pendingTail (the bug that hung every live turn).
    const textPart = parts.find((p) => p.kind === "text");
    expect(textPart.text).toBe("You lived in two places.");
    expect(toolPart.pendingTail).toBeUndefined();
  });

  it("renders one child card per batch-result item when NO child events arrive (http backends)", () => {
    // Yield-based http backends (like anthropic / deepseek) stream a batch
    // tool's terminal result but emit NO agent.tool.child.* events. The child
    // cards must be reconstructed from part.result.items (index-aligned to
    // part.args.queries) or the turn shows nothing at all while the tool runs —
    // the regression this fixes. Only the codex backend populates children live.
    let s = assistantTurn(sid, "m3");
    s = r(s, {
      kind: "agent.tool.start",
      payload: {
        sessionId: sid,
        toolCallId: "tc",
        tool: "search_many",
        args: { queries: [{ query: "rent" }, { query: "lease" }, { query: "deposit" }] },
      },
    });
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: sid,
        toolCallId: "tc",
        result: {
          kind: "search.batch",
          items: [
            { kind: "search.results", results: [] },
            { kind: "search.results", results: [] },
            { kind: "search.results", results: [] },
          ],
        },
      },
    });

    const toolPart = s.turns[0].parts.find((p) => p.kind === "tool" && p.toolCallId === "tc");
    // No child events → the reducer never populated `children`, but it DID store
    // the terminal batch result on the part (the fallback source).
    expect(toolPart.children).toBeUndefined();
    expect(toolPart.result.items).toHaveLength(3);

    // The render path derives one singular ephemeral card per item.
    const rendered = renderPart(toolPart, 0, [], () => {}, null, false, true, false);
    expect(Array.isArray(rendered)).toBe(true);
    expect(rendered).toHaveLength(3);
    for (const vnode of rendered) {
      // Each is an EphemeralSearchCard VNode (a component function), not null.
      expect(vnode).not.toBeNull();
      expect(typeof vnode.type).toBe("function");
    }
  });

  it("shows live pending cards from part.args before the batch result lands", () => {
    // Between agent.tool.start and the terminal result, an http backend has no
    // per-child signal at all. Deriving pending cards from part.args.queries lets
    // each ephemeral card mount and spin, so the turn is not visibly frozen.
    let s = assistantTurn(sid, "m4");
    s = r(s, {
      kind: "agent.tool.start",
      payload: {
        sessionId: sid,
        toolCallId: "tc",
        tool: "search_many",
        args: { queries: [{ query: "a" }, { query: "b" }] },
      },
    });
    const toolPart = s.turns[0].parts.find((p) => p.kind === "tool" && p.toolCallId === "tc");
    expect(toolPart.result).toBeNull();
    const rendered = renderPart(toolPart, 0, [], () => {}, null, false, true, false);
    expect(rendered).toHaveLength(2);
  });

  it("feeds the live Timeline (trailAnnotations.byDoc) from an annotate.batch result", () => {
    let s = assistantTurn(sid, "m2");
    s = r(s, { kind: "agent.tool.start", payload: { sessionId: sid, toolCallId: "a", tool: "annotate_many" } });
    s = r(s, {
      kind: "agent.tool.result",
      payload: {
        sessionId: sid,
        toolCallId: "a",
        result: {
          kind: "annotate.batch",
          items: [
            { kind: "annotate.recorded", documentId: "d1", ref: ref("d1"), quote: "q1" },
            { kind: "annotate.recorded", documentId: "d2", ref: ref("d2"), note: "n2" },
          ],
        },
      },
    });
    // The live Timeline must fan the batch out — one byDoc slot per recorded
    // child — matching the reload rebuild so live equals the reloaded Timeline.
    expect(Object.keys(s.trailAnnotations.byDoc).sort()).toEqual(["d1", "d2"]);
  });
});
