// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { createSpawnSubagentTool } from "./spawn-subagent.js";
import {
  SubagentPortError,
  type SubagentJoinResult,
  type SubagentPort,
  type SubagentPortInput,
  type SubagentSpawnHandle,
} from "./types.js";
import type { ToolContext } from "../backend.js";

const ctx: ToolContext = { sessionId: "S_parent", messageId: "m1" };

function portReturning(handle: Partial<SubagentSpawnHandle> = {}): {
  port: SubagentPort;
  calls: SubagentPortInput[];
} {
  const calls: SubagentPortInput[] = [];
  const port: SubagentPort = {
    spawn: async (input) => {
      calls.push(input);
      return {
        subagentId: `${input.parentSessionId}.sub.1`,
        specialist: input.specialist ?? "generic",
        status: "running",
        ...handle,
      };
    },
    join: async (): Promise<SubagentJoinResult> => ({ results: [] }),
  };
  return { port, calls };
}

describe("spawn_subagent tool", () => {
  it("passes the parent session id + task through and returns a running launch handle", async () => {
    const { port, calls } = portReturning();
    const tool = createSpawnSubagentTool({ port });

    const result = await tool.invoke({ title: "Sweep history", task: "sweep it" }, ctx);

    expect(calls[0]).toMatchObject({
      parentSessionId: "S_parent",
      task: "sweep it",
    });
    expect(result.kind).toBe("subagent.spawned");
    if (result.kind === "subagent.spawned") {
      expect(result.specialist).toBe("generic");
      expect(result.status).toBe("running");
      expect(result.subagentId).toBe("S_parent.sub.1");
      // A launch handle carries no finding yet — that arrives via join_subagents.
      expect(result.summary).toBeUndefined();
      expect(result.citations).toBeUndefined();
    }
  });

  it("rejects an empty task with an invalid_args error (no backend/model/scope args exist)", async () => {
    const { port } = portReturning();
    const tool = createSpawnSubagentTool({ port });
    const result = await tool.invoke({ title: "x", task: "" }, ctx);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.code).toBe("invalid_args");
  });

  it("maps a SubagentPortError to a stable error ToolResult", async () => {
    const port: SubagentPort = {
      spawn: async () => {
        throw new SubagentPortError("subagent_depth_exceeded", "too deep");
      },
      join: async () => ({ results: [] }),
    };
    const tool = createSpawnSubagentTool({ port });
    const result = await tool.invoke({ title: "x", task: "t" }, ctx);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("subagent_depth_exceeded");
      expect(result.message).toBe("too deep");
    }
  });

  it("maps a tree-budget SubagentPortError to its stable code", async () => {
    const port: SubagentPort = {
      spawn: async () => {
        throw new SubagentPortError("subagent_tree_token_budget_exhausted", "budget spent");
      },
      join: async () => ({ results: [] }),
    };
    const tool = createSpawnSubagentTool({ port });
    const result = await tool.invoke({ title: "x", task: "t" }, ctx);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.code).toBe("subagent_tree_token_budget_exhausted");
    }
  });

  it("exposes only the task brief and optional title", () => {
    const tool = createSpawnSubagentTool({ port: portReturning().port });
    const shape = (tool.schema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape).sort()).toEqual(["task", "title"]);
  });
});
