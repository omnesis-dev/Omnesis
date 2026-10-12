// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { expect, it, vi } from "vitest";
import { AgentSession } from "./session.js";
import type { AgentEvent } from "@omnesis/core";
import type { ChatBackend } from "./backend.js";

function backend(): ChatBackend {
  return {
    name: "scripted",
    model: "scripted",
    async *runTurn(input) {
      const identity = { sessionId: input.sessionId, messageId: input.messageId };
      yield {
        type: "agent.text.delta",
        payload: { ...identity, delta: "Unchecked intermediate assertion." },
      };
      yield {
        type: "agent.tool.start",
        payload: { ...identity, toolCallId: "read", tool: "read", args: {} },
      };
      yield { type: "agent.message.end", payload: { ...identity, stopReason: "tool_use" } };
      yield {
        type: "agent.tool.result",
        payload: {
          ...identity,
          toolCallId: "read",
          result: { kind: "error", code: "scripted", message: "Observed progress" },
          durationMs: 0,
        },
      };
      yield {
        type: "agent.text.delta",
        payload: { ...identity, delta: "Unchecked final assertion." },
      };
      yield { type: "agent.message.end", payload: { ...identity, stopReason: "end_turn" } };
    },
  };
}

it("withholds intermediate and final prose from events and history until finalization", async () => {
  const review = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  const raw: AgentEvent[] = [];
  const events: AgentEvent[] = [];
  const finalize = vi.fn(async ({ draft }: { draft: string }) => {
    expect(draft).toBe("Unchecked final assertion.");
    entered.resolve();
    return review.promise;
  });
  const session = new AgentSession({
    sessionId: "session",
    backend: backend(),
    tools: [],
    systemPrompt: "test",
    finalizer: () => ({ observe: (event) => raw.push(event), finalize }),
  });
  session.subscribe((event) => events.push(event));
  const turn = session.send("What is established?");
  await entered.promise;
  expect(events.some((event) => event.type === "agent.tool.result")).toBe(true);
  expect(events.some((event) => event.type === "agent.text.delta")).toBe(false);
  expect(JSON.stringify(session.liveHistorySnapshot())).not.toContain("Unchecked");
  expect(JSON.stringify(session.historySnapshot())).not.toContain("Unchecked");
  expect(JSON.stringify(raw)).toContain("Unchecked intermediate assertion.");
  review.resolve("The source does not establish that relationship.");
  await turn.completion;
  expect(events.filter((event) => event.type === "agent.text.delta")).toHaveLength(1);
  expect(JSON.stringify(session.historySnapshot())).toContain("does not establish");
  expect(JSON.stringify(session.historySnapshot())).not.toContain("Unchecked");
});

it("does not release a late finalized answer after cancellation", async () => {
  const review = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  const events: AgentEvent[] = [];
  const session = new AgentSession({
    sessionId: "session",
    backend: backend(),
    tools: [],
    systemPrompt: "test",
    finalizer: () => ({
      observe() {},
      async finalize() {
        entered.resolve();
        return review.promise;
      },
    }),
  });
  session.subscribe((event) => events.push(event));
  const turn = session.send("Question");
  await entered.promise;
  session.cancel();
  review.resolve("Late answer");
  await turn.completion;
  expect(JSON.stringify(events)).not.toContain("Late answer");
  expect(JSON.stringify(session.historySnapshot())).not.toContain("Unchecked");
});

it("verifies prose followed by a citation without requiring another text segment", async () => {
  const model: ChatBackend = {
    name: "scripted",
    model: "scripted",
    async *runTurn(input) {
      const identity = { sessionId: input.sessionId, messageId: input.messageId };
      yield {
        type: "agent.text.delta",
        payload: { ...identity, delta: "Supported answer before its citation." },
      };
      yield {
        type: "agent.tool.start",
        payload: { ...identity, toolCallId: "citation", tool: "annotate_many", args: {} },
      };
      yield {
        type: "agent.tool.result",
        payload: {
          ...identity,
          toolCallId: "citation",
          durationMs: 0,
          result: { kind: "structured", resultType: "citation.test", data: {} },
        },
      };
      yield { type: "agent.message.end", payload: { ...identity, stopReason: "end_turn" } };
    },
  };
  const finalize = vi.fn(async ({ draft }: { draft: string }) => draft);
  const session = new AgentSession({
    sessionId: "session",
    backend: model,
    tools: [],
    systemPrompt: "test",
    finalizer: () => ({ observe() {}, finalize }),
  });
  await session.send("Question").completion;
  expect(finalize.mock.calls[0]?.[0].draft).toBe("Supported answer before its citation.");
});
