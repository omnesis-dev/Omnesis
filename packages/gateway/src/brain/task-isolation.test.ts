// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { isolateTaskTools, isTaskRun } from "./task-isolation.js";
import { buildCognitionSystemPrompt } from "./runtime/prompts.js";
import type { ToolHandle } from "@omnesis/agent";

const tool = (name: string): ToolHandle => ({
  name,
  description: name,
  schema: z.object({ sentence: z.string().optional(), loopIds: z.array(z.string()).optional() }),
  invoke: vi.fn(async () => ({ kind: "error" as const, code: "test", message: "called" })),
});

describe("Brain without the Tasks product", () => {
  test("keeps memory tools, removes product tools and reference parameters", () => {
    const tools = isolateTaskTools(
      [
        tool("open_loop_search"),
        tool("open_loop_create"),
        tool("task_update"),
        tool("loop_synthesis_save"),
        tool("schedule_agent_run"),
        tool("temporal_annotation_add"),
        tool("annotation_search"),
      ],
      () => false,
    );
    expect(tools.map((t) => t.name)).toEqual(["temporal_annotation_add", "annotation_search"]);
    expect(
      tools[0]!.schema.safeParse({ sentence: "A dated event", loopIds: ["hidden"] }).success,
    ).toBe(false);
    expect(tools[0]!.schema.safeParse({ sentence: "A dated event" }).success).toBe(true);
    expect(tools[0]!.description).not.toMatch(/loop|task/i);
  });

  test("previously issued handles honor a hot opt-out before invoking", async () => {
    let enabled = true;
    const original = tool("open_loop_create");
    const [handle] = isolateTaskTools([original], () => enabled);
    enabled = false;
    expect(await handle!.invoke({}, { sessionId: "session", messageId: "message" })).toMatchObject({
      kind: "error",
      code: "feature_disabled",
    });
    expect(original.invoke).not.toHaveBeenCalled();
  });

  test("classifies persisted task checks without blocking ordinary Brain work", () => {
    for (const payload of [
      { loopId: "example" },
      { decayCheckLoopId: "example" },
      { recheckDependentKind: "loop", recheckDependentId: "example" },
      { focus: "collision", loopIds: ["example", "other"] },
    ])
      expect(isTaskRun({ payload })).toBe(true);
    expect(isTaskRun({ payload: { focus: "knowledge-maintenance", batchId: "batch" } })).toBe(
      false,
    );
    expect(
      isTaskRun({ payload: { focus: "collision", temporalAnnotationIds: ["one", "two"] } }),
    ).toBe(false);
  });

  test("task-free identity retains memory and evidence discipline without product instructions", () => {
    const prompt = buildCognitionSystemPrompt({
      notesMaxBytes: 4096,
      annotationsEnabled: true,
      tasksEnabled: false,
    });
    expect(prompt).toContain("temporal_query");
    expect(prompt).toContain("annotation_search");
    expect(prompt).toContain("knowledge_candidates");
    expect(prompt).not.toMatch(/open_loop|task_|tracked loops|task journal/i);
  });
});

test("retained memory tools omit task backlinks while preserving grounded text", async () => {
  const handles = isolateTaskTools(
    [
      {
        ...tool("annotation_fetch"),
        invoke: async () => ({
          kind: "structured",
          resultType: "annotation",
          data: {
            annotation: {
              body: "A fictional source discusses tasks in a project.",
              loopIds: ["task-hidden"],
              nested: { relatedLoopIds: ["task-hidden"], evidence: "original quote" },
            },
          },
        }),
      },
      tool("entity_context"),
    ],
    () => false,
  );
  expect(handles.map((t) => t.name)).toEqual(["annotation_fetch"]);
  const result = await handles[0]!.invoke({}, { sessionId: "test", messageId: "test" } as never);
  expect(result).toMatchObject({
    kind: "structured",
    data: {
      annotation: {
        body: "A fictional source discusses tasks in a project.",
        nested: { evidence: "original quote" },
      },
    },
  });
  expect(JSON.stringify(result)).not.toContain("task-hidden");
});
