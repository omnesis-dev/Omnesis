// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createSearchManyTool } from "./search-many.js";
import { createAnnotateManyTool } from "./annotate-many.js";
import type { ToolContext } from "../backend.js";
import type { DocumentPort, SearchPort } from "./types.js";

const ctxBase = { sessionId: "S", messageId: "M" };

/** A ToolContext that records the per-child events a batch tool streams. */
function recordingCtx(): {
  ctx: ToolContext;
  starts: Array<{ index: number; tool: string }>;
  results: Array<{ index: number; kind: string }>;
} {
  const starts: Array<{ index: number; tool: string }> = [];
  const results: Array<{ index: number; kind: string }> = [];
  return {
    starts,
    results,
    ctx: {
      ...ctxBase,
      onChildStart: (c) => starts.push({ index: c.index, tool: c.tool }),
      onChildResult: (c) => results.push({ index: c.index, kind: c.result.kind }),
    },
  };
}

describe("batch tools", () => {
  it("search_many returns one search.results per query, in input order", async () => {
    const port: SearchPort = {
      search: async (input) => ({
        query: input.query,
        durationMs: 0,
        results: [],
      }),
    };
    const tool = createSearchManyTool({ port });
    const { ctx, starts, results } = recordingCtx();
    const r = await tool.invoke(
      { queries: [{ query: "alpha" }, { query: "beta" }, { query: "gamma" }] },
      ctx,
    );
    expect(r.kind).toBe("search.batch");
    if (r.kind !== "search.batch") throw new Error("unreachable");
    expect(r.items.map((i) => (i.kind === "search.results" ? i.query : "ERR"))).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    // One child card per query, tagged with the SINGULAR tool name.
    expect(starts).toHaveLength(3);
    expect(starts.every((s) => s.tool === "search_documents")).toBe(true);
    expect(results.map((x) => x.index).sort()).toEqual([0, 1, 2]);
  });

  it("search_many keeps input order even when a later query resolves first", async () => {
    // First query is slow, second fast: the batch result must still be ordered.
    const port: SearchPort = {
      search: async (input) => {
        if (input.query === "slow") await new Promise((res) => setTimeout(res, 20));
        return { query: input.query, durationMs: 0, results: [] };
      },
    };
    const tool = createSearchManyTool({ port });
    const r = await tool.invoke(
      { queries: [{ query: "slow" }, { query: "quick" }] },
      {
        ...ctxBase,
      },
    );
    if (r.kind !== "search.batch") throw new Error("unreachable");
    expect(r.items.map((i) => (i.kind === "search.results" ? i.query : "ERR"))).toEqual([
      "slow",
      "quick",
    ]);
  });

  it("a failed child occupies its slot as an error; the batch is not discarded", async () => {
    const port: SearchPort = {
      search: async (input) => {
        if (input.query === "boom") throw new Error("kaboom");
        return { query: input.query, durationMs: 0, results: [] };
      },
    };
    const tool = createSearchManyTool({ port });
    const r = await tool.invoke({ queries: [{ query: "ok" }, { query: "boom" }] }, { ...ctxBase });
    if (r.kind !== "search.batch") throw new Error("unreachable");
    expect(r.items[0]!.kind).toBe("search.results");
    expect(r.items[1]!.kind).toBe("error");
  });

  it("annotate_many returns one annotate.recorded per annotation", async () => {
    const doc: DocumentPort = {
      fetch: async (documentId) => ({
        ref: { documentId, sourceType: "gmail", sourceId: "gmail:me", title: "t" },
        document: { id: documentId },
      }),
    };
    const tool = createAnnotateManyTool({ port: doc });
    const r = await tool.invoke(
      {
        annotations: [
          { documentId: "d1", quote: "q1" },
          { documentId: "d2", note: "n2" },
        ],
      },
      { ...ctxBase },
    );
    expect(r.kind).toBe("annotate.batch");
    if (r.kind !== "annotate.batch") throw new Error("unreachable");
    expect(r.items.map((i) => (i.kind === "annotate.recorded" ? i.documentId : "ERR"))).toEqual([
      "d1",
      "d2",
    ]);
  });

  it("annotate_many keeps valid citations and gives actionable feedback for an invalid id", async () => {
    const doc: DocumentPort = {
      fetch: async (documentId) =>
        documentId === "analytics-row-17"
          ? null
          : {
              ref: { documentId, sourceType: "notes", sourceId: "notes:self", title: "Q4 plan" },
              document: { id: documentId },
            },
    };
    const tool = createAnnotateManyTool({ port: doc });
    const r = await tool.invoke(
      {
        annotations: [
          { documentId: "doc-plan", note: "Canonical project plan" },
          { documentId: "analytics-row-17", note: "Raw analytics row id" },
        ],
      },
      { ...ctxBase },
    );
    expect(r.kind).toBe("annotate.batch");
    if (r.kind !== "annotate.batch") throw new Error("unreachable");
    expect(r.items.map((item) => item.kind)).toEqual(["annotate.recorded", "error"]);
    const invalid = r.items[1];
    expect(invalid?.kind).toBe("error");
    if (invalid?.kind === "error") {
      expect(invalid.code).toBe("document_not_found");
      expect(invalid.message).toContain("retry annotate_many");
      expect(invalid.message).toContain("cite_record");
    }
  });

  it("rejects an over-cap batch and an empty batch", async () => {
    const port: SearchPort = {
      search: async (input) => ({ query: input.query, durationMs: 0, results: [] }),
    };
    const tool = createSearchManyTool({ port });
    const empty = await tool.invoke({ queries: [] }, { ...ctxBase });
    expect(empty.kind).toBe("error");
    const tooMany = await tool.invoke(
      { queries: Array.from({ length: 17 }, (_, i) => ({ query: `q${i}` })) },
      { ...ctxBase },
    );
    expect(tooMany.kind).toBe("error");
  });

  it("does not require child hooks (batch tools no-op when unset)", async () => {
    const port: SearchPort = {
      search: async (input) => ({ query: input.query, durationMs: 0, results: [] }),
    };
    const tool = createSearchManyTool({ port });
    // No onChildStart/onChildResult on ctx — must not throw.
    const r = await tool.invoke({ queries: [{ query: "x" }] }, { sessionId: "S", messageId: "M" });
    expect(r.kind).toBe("search.batch");
  });
});
