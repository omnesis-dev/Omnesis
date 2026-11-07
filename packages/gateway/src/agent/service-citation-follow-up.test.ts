// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import {
  CITATION_FOLLOW_UP_MESSAGE,
  type ChatBackend,
  type DocumentPort,
  type SearchPort,
  type TurnInput,
} from "@omnesis/agent";
import { AgentService } from "./service.js";
import type { AgentEvent, WsEvent } from "@omnesis/core";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

/**
 * Answers every question from one `search_many` call without citing, and
 * answers the citation follow-up with nothing, so a test counts the runs.
 */
class UncitedBackend implements ChatBackend {
  readonly name = "uncited";
  readonly model = "uncited";
  readonly turns: TurnInput[] = [];

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.turns.push(input);
    const { sessionId, messageId } = input;
    if (input.userMessage !== CITATION_FOLLOW_UP_MESSAGE) {
      yield {
        type: "agent.tool.start",
        payload: { sessionId, messageId, toolCallId: "tc_search", tool: "search_many", args: {} },
      };
      yield {
        type: "agent.tool.result",
        payload: {
          sessionId,
          messageId,
          toolCallId: "tc_search",
          durationMs: 1,
          result: { kind: "search.batch", items: [] },
        },
      };
      yield {
        type: "agent.message.end",
        payload: { sessionId, messageId, stopReason: "tool_use" },
      };
      yield {
        type: "agent.text.delta",
        payload: { sessionId, messageId, delta: "The Q4 budget review is on Friday." },
      };
    }
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

function makeService(backend: ChatBackend) {
  const ended: WsEvent[] = [];
  let n = 0;
  const service = new AgentService({
    backendFactory: () => backend,
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "test",
    broadcastEvent: (event) => {
      if (event.type === "agent.message.end") ended.push(event);
    },
    sessionIdGen: () => `S_cite_${++n}`,
    idleTimeoutMs: 60_000,
  });
  const turnEnded = async (count: number) => {
    for (let i = 0; i < 500 && ended.length < count; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(ended).toHaveLength(count);
  };
  return { service, turnEnded };
}

describe("AgentService citation follow-up", () => {
  it("asks an interactive turn that answered uncited to cite, once", async () => {
    const backend = new UncitedBackend();
    const { service, turnEnded } = makeService(backend);
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "When is the budget review?");
    await turnEnded(1);
    expect(backend.turns.map((t) => t.userMessage)).toEqual([
      "When is the budget review?",
      CITATION_FOLLOW_UP_MESSAGE,
    ]);
    await service.dispose();
  });

  it("leaves a voice turn alone: it has no Timeline", async () => {
    const backend = new UncitedBackend();
    const { service, turnEnded } = makeService(backend);
    const { sessionId } = await service.createSession("device:A", { profile: "voice" });
    service.sendMessage("device:A", sessionId, "When is the budget review?");
    await turnEnded(1);
    expect(backend.turns).toHaveLength(1);
    await service.dispose();
  });

  it("leaves an unattended turn alone", async () => {
    const backend = new UncitedBackend();
    const { service, turnEnded } = makeService(backend);
    const { sessionId } = await service.createSession("device:A", { unattended: true });
    service.sendMessage("device:A", sessionId, "When is the budget review?");
    await turnEnded(1);
    expect(backend.turns).toHaveLength(1);
    await service.dispose();
  });

  it("leaves an Answer alone: it has its own citation contract", async () => {
    const backend = new UncitedBackend();
    const { service } = makeService(backend);
    await service.generateReadOnlyAnswerCandidate("When is the budget review?");
    expect(backend.turns).toHaveLength(1);
    await service.dispose();
  });
});
