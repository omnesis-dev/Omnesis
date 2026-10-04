// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { FindProgress } from "./find-progress.js";

describe("ephemeral Find tool cards", () => {
  it("preserves parallel call identities across preparing, arguments, result and error", () => {
    const progress = new FindProgress();
    progress.update("agent.tool.input_start", { toolCallId: "a", tool: "search_documents" });
    progress.update("agent.tool.input_start", { toolCallId: "b", tool: "run_sql" });
    progress.update("agent.tool.start", {
      toolCallId: "a",
      tool: "search_documents",
      argsSummary: "Invented query",
    });
    progress.update("agent.tool.result", {
      toolCallId: "a",
      result: { kind: "search.results", results: [{ title: "Invented" }] },
    });
    progress.update("agent.tool.result", {
      toolCallId: "b",
      result: { kind: "error", message: "Invented error" },
    });
    expect(progress.snapshot()).toEqual([
      {
        id: "a",
        tool: "Searching documents",
        summary: "Invented query",
        status: "done",
        result: "1 result found",
      },
      { id: "b", tool: "Querying records", summary: "", status: "error", result: "Invented error" },
    ]);
  });
  it("bounds cards and summaries without collecting hidden reasoning or transcripts", () => {
    const progress = new FindProgress();
    for (let i = 0; i < 40; i++)
      progress.update("agent.tool.start", {
        toolCallId: String(i),
        tool: "search",
        argsSummary: "x".repeat(2000),
      });
    expect(progress.snapshot()).toHaveLength(20);
    expect(progress.snapshot()[0]?.id).toBe("20");
    expect(progress.snapshot()[0]?.summary).toHaveLength(500);
    expect(
      progress.update("agent.thinking.delta", { toolCallId: "private", delta: "Hidden" }),
    ).toBe(false);
    expect(progress.snapshot()).toHaveLength(20);
  });
});
