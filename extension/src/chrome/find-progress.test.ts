// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { FindProgress } from "./find-progress.js";

describe("shared Find transcript", () => {
  it("keeps structured results and gates subsequent prose until the same portal dismiss action", () => {
    const progress = new FindProgress();
    progress.update("agent.tool.input_start", { toolCallId: "a", tool: "search_documents" });
    progress.update("agent.tool.start", {
      toolCallId: "a",
      tool: "search_documents",
      args: { query: "Invented" },
      argsSummary: "Invented",
    });
    const result = {
      kind: "search.results",
      results: [{ title: "Invented guide", documentId: "doc", sourceId: "example:account" }],
    };
    progress.update("agent.tool.result", { toolCallId: "a", result });
    progress.update("agent.text.delta", { delta: "The explanation." });
    expect(progress.snapshot()).toHaveLength(1);
    expect(progress.snapshot()[0]).toMatchObject({
      toolCallId: "a",
      result,
      pendingTail: [{ kind: "agent.text.delta" }],
    });
    progress.flush("a");
    expect(progress.snapshot()[0]).toMatchObject({ tailDismissed: true });
    expect(progress.snapshot()[1]).toMatchObject({ kind: "text", text: "The explanation." });
    progress.flush("a");
    expect(progress.snapshot()).toHaveLength(2);
  });
  it("retains batch child document content rather than reducing it to a count", () => {
    const progress = new FindProgress();
    progress.update("agent.tool.start", {
      toolCallId: "batch",
      tool: "fetch_many",
      args: { documents: [{ documentId: "doc" }] },
    });
    progress.update("agent.tool.child.start", {
      toolCallId: "batch",
      childIndex: 0,
      tool: "fetch_document",
      argsSummary: "Invented guide",
    });
    const result = {
      kind: "document",
      ref: { documentId: "doc", title: "Invented guide" },
      content: "Invented document content.",
    };
    progress.update("agent.tool.child.result", { toolCallId: "batch", childIndex: 0, result });
    expect(progress.snapshot()[0]?.children).toEqual([
      expect.objectContaining({ index: 0, result }),
    ]);
  });
  it("bounds tool identities and rejects hidden reasoning", () => {
    const progress = new FindProgress();
    for (let i = 0; i < 45; i++)
      progress.update("agent.tool.start", {
        toolCallId: String(i),
        tool: "fetch_document",
        args: {},
      });
    expect(progress.snapshot()).toHaveLength(40);
    expect(progress.update("agent.thinking.delta", { delta: "Private reasoning" })).toBe(false);
    progress.finish();
    expect(progress.snapshot()).toEqual([]);
  });
});
