// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { withLabTools } from "./lab-tools.js";
import type { ToolHandle } from "@omnesis/agent";

function handle(name: string): ToolHandle {
  return {
    name,
    description: name,
    schema: {} as never,
    invoke: vi.fn(async () => ({ kind: "structured" as const, resultType: "fixture", data: {} })),
  };
}

describe("Lab tool admission", () => {
  it("keeps user-directed tasks available without the Brain, with independent Watches", () => {
    const tools = [
      "task_list",
      "task_create",
      "list_loops",
      "entity_context",
      "watch_get",
      "watches_list",
      "memory_create",
      "temporal_query",
    ].map(handle);
    expect(withLabTools(tools, (id) => id === "tasks").map((tool) => tool.name)).toEqual([
      "task_list",
      "task_create",
      "memory_create",
      "temporal_query",
    ]);
    expect(withLabTools(tools, (id) => id === "watches").map((tool) => tool.name)).toEqual([
      "watch_get",
      "watches_list",
      "memory_create",
      "temporal_query",
    ]);
  });

  it("withholds loop reads and entity context while Tasks is off even with the Brain enabled", () => {
    const tools = [
      "list_loops",
      "search_loops",
      "fetch_loop",
      "entity_context",
      "memory_create",
      "temporal_query",
    ].map(handle);
    expect(withLabTools(tools, (id) => id === "brain").map((tool) => tool.name)).toEqual([
      "memory_create",
      "temporal_query",
    ]);
  });

  it("rejects a previously captured tool after its feature is disabled", async () => {
    let enabled = true;
    const task = handle("task_create");
    const [captured] = withLabTools([task], () => enabled);
    enabled = false;
    expect(await captured!.invoke({}, {} as never)).toMatchObject({
      kind: "error",
      code: "feature_disabled",
    });
    expect(task.invoke).not.toHaveBeenCalled();
  });
});
