// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createJoinSubagentsTool } from "./join-subagents.js";
import {
  SubagentPortError,
  type SubagentJoinInput,
  type SubagentJoinResult,
  type SubagentPort,
} from "./types.js";
import type { ToolContext } from "../backend.js";

const ctx: ToolContext = { sessionId: "S_parent", messageId: "m1" };

function portReturning(join: SubagentJoinResult): {
  port: SubagentPort;
  calls: SubagentJoinInput[];
} {
  const calls: SubagentJoinInput[] = [];
  const port: SubagentPort = {
    spawn: async (input) => ({
      subagentId: `${input.parentSessionId}.sub.1`,
      specialist: input.specialist ?? "generic",
      status: "running",
    }),
    join: async (input) => {
      calls.push(input);
      return join;
    },
  };
  return { port, calls };
}

describe("join_subagents tool", () => {
  it("awaits the named ids and returns the collected findings + tree usage", async () => {
    const { port, calls } = portReturning({
      results: [
        {
          subagentId: "S.sub.1",
          specialist: "history-sweep",
          status: "complete",
          summary: "found three things",
          citations: [{ documentId: "d1", sourceType: "demo", sourceId: "s1" }],
          usage: { inputTokens: 50, outputTokens: 10 },
        },
      ],
      treeUsage: { inputTokens: 50, outputTokens: 10 },
    });
    const tool = createJoinSubagentsTool({ port });

    const result = await tool.invoke({ subagentIds: ["S.sub.1"] }, ctx);

    expect(calls[0]).toMatchObject({ parentSessionId: "S_parent", subagentIds: ["S.sub.1"] });
    expect(result.kind).toBe("subagent.joined");
    if (result.kind === "subagent.joined") {
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.summary).toBe("found three things");
      expect(result.results[0]?.citations).toHaveLength(1);
      expect(result.treeUsage).toMatchObject({ inputTokens: 50, outputTokens: 10 });
      expect(result.stoppedReason).toBeUndefined();
    }
  });

  it("surfaces the honest stoppedReason when the tree budget tripped", async () => {
    const { port } = portReturning({
      results: [
        {
          subagentId: "S.sub.1",
          specialist: "history-sweep",
          status: "budget_exhausted",
          summary: "(stopped — tree token budget exhausted)",
          citations: [],
        },
      ],
      treeUsage: { inputTokens: 200 },
      stoppedReason: "tree token budget (150) exhausted",
    });
    const tool = createJoinSubagentsTool({ port });
    const result = await tool.invoke({ subagentIds: ["S.sub.1"] }, ctx);
    expect(result.kind).toBe("subagent.joined");
    if (result.kind === "subagent.joined") {
      expect(result.stoppedReason).toBe("tree token budget (150) exhausted");
      expect(result.results[0]?.status).toBe("budget_exhausted");
    }
  });

  it("preserves an authoritative failure alongside a partial finding", async () => {
    const { port } = portReturning({
      results: [
        {
          subagentId: "S.sub.1",
          specialist: "history-sweep",
          status: "failed",
          summary:
            "Partial finding before the worker reached its output limit:\nMilestone approved.",
          citations: [{ documentId: "d1", sourceType: "demo", sourceId: "s1" }],
          failure: {
            code: "output_truncated",
            message: "The model reached its output limit before completing this response.",
            retryable: false,
            backend: "http",
            model: "fictional-model",
          },
        },
      ],
    });
    const result = await createJoinSubagentsTool({ port }).invoke(
      { subagentIds: ["S.sub.1"] },
      ctx,
    );
    expect(result).toMatchObject({
      kind: "subagent.joined",
      results: [{ status: "failed", failure: { code: "output_truncated" } }],
    });
  });

  it("rejects an empty id list with invalid_args", async () => {
    const { port } = portReturning({ results: [] });
    const tool = createJoinSubagentsTool({ port });
    const result = await tool.invoke({ subagentIds: [] }, ctx);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("invalid_args");
  });

  it("maps a SubagentPortError to a stable error ToolResult", async () => {
    const port: SubagentPort = {
      spawn: async (input) => ({
        subagentId: input.parentSessionId,
        specialist: input.specialist ?? "generic",
        status: "running",
      }),
      join: async () => {
        throw new SubagentPortError("subagent_join_failed", "boom");
      },
    };
    const tool = createJoinSubagentsTool({ port });
    const result = await tool.invoke({ subagentIds: ["x"] }, ctx);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("subagent_join_failed");
  });
});
