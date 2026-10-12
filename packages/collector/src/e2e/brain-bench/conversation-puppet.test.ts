// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { decideConversationTurn, readConversationContext } from "./conversation-puppet.js";
import { call, ref, type WireMessage } from "./puppet-plan.js";

const behaviors = [
  {
    messageContains: "the first one is done",
    plan: {
      calls: [
        call("task_list", { query: "boiler" }),
        call("task_update", { id: ref("task_list", "tasks.0.id"), action: "complete" }),
      ],
      finalText: "Done.",
    },
  },
];

function toolRound(id: string, name: string, args: unknown, result: unknown): WireMessage[] {
  return [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    { role: "tool", tool_call_id: id, content: JSON.stringify(result) },
  ];
}

describe("the conversation puppet", () => {
  test("reads the latest user message and the system prompt", () => {
    const ctx = readConversationContext([
      { role: "system", content: "You are Omnesis." },
      { role: "system", content: "## Morning brief context" },
      { role: "user", content: "(This morning's brief, 2026-08-21.)" },
      { role: "assistant", content: "Today: nothing due." },
      { role: "user", content: "Thanks, the first one is done." },
    ]);
    expect(ctx.message).toBe("Thanks, the first one is done.");
    expect(ctx.systemPrompt).toBe("You are Omnesis.\n## Morning brief context");
  });

  test("counts only the tool calls made since the latest user message", () => {
    const earlier = [
      { role: "user", content: "Earlier: the first one is done." },
      ...toolRound("a", "task_list", {}, { kind: "structured", data: { tasks: [] } }),
      { role: "assistant", content: "Done." },
    ] satisfies WireMessage[];
    const now: WireMessage[] = [
      ...earlier,
      { role: "user", content: "Again, the first one is done." },
    ];
    expect(decideConversationTurn(now, behaviors)).toEqual({
      kind: "tool",
      name: "task_list",
      args: { query: "boiler" },
    });
    const after = [
      ...now,
      ...toolRound(
        "b",
        "task_list",
        { query: "boiler" },
        {
          kind: "structured",
          data: { tasks: [{ id: "loop_7" }] },
        },
      ),
    ];
    expect(decideConversationTurn(after, behaviors)).toEqual({
      kind: "tool",
      name: "task_update",
      args: { id: "loop_7", action: "complete" },
    });
  });

  test("an unmatched message ends the turn with a no-op text", () => {
    expect(decideConversationTurn([{ role: "user", content: "hello" }], behaviors)).toMatchObject({
      kind: "final",
    });
  });
});
