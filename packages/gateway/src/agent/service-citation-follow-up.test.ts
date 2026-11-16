// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CITATION_FOLLOW_UP_MESSAGE,
  type ChatBackend,
  type DocumentPort,
  type SearchPort,
  type TurnInput,
} from "@omnesis/agent";
import { AgentService } from "./service.js";
import { FsConversationStore } from "./conversation-store.js";
import type { ConversationReadStatePort } from "./conversation-read-state-service.js";
import type { AgentEvent, WsEvent } from "@omnesis/core";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

const ANSWER = "The Q4 budget review is on Friday.";
const REF = {
  documentId: "doc1",
  sourceType: "gmail",
  sourceId: "gmail:me",
  title: "Q4 budget review",
};

/**
 * Answers every question from one `search_many` call without citing, and
 * answers the citation follow-up with nothing — or, given `cites`, with one
 * `annotate_many` call — so a test counts the runs.
 */
class UncitedBackend implements ChatBackend {
  readonly model = "uncited";
  readonly turns: TurnInput[] = [];

  constructor(
    readonly name = "uncited",
    private readonly cites = false,
  ) {}

  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    this.turns.push(input);
    const { sessionId, messageId } = input;
    if (input.userMessage === CITATION_FOLLOW_UP_MESSAGE && this.cites) {
      yield {
        type: "agent.tool.start",
        payload: { sessionId, messageId, toolCallId: "tc_cite", tool: "annotate_many", args: {} },
      };
      yield {
        type: "agent.tool.result",
        payload: {
          sessionId,
          messageId,
          toolCallId: "tc_cite",
          durationMs: 1,
          result: { kind: "annotate.recorded", documentId: "doc1", ref: REF, quote: "Friday" },
        },
      } as AgentEvent;
      yield {
        type: "agent.message.end",
        payload: { sessionId, messageId, stopReason: "tool_use" },
      };
    }
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
        payload: { sessionId, messageId, delta: ANSWER },
      };
    }
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

function makeService(
  backend: ChatBackend,
  extra: { store?: FsConversationStore; readState?: ConversationReadStatePort } = {},
) {
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
    ...extra,
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

  // A cited follow-up records its calls before the answer, so the finished
  // turn still ends on the answer's text — what the unread gate and the
  // dangling-turn repair on load both read.
  describe.each(["http", "anthropic"])("a cited follow-up on %s", (name) => {
    async function citedTurn() {
      const store = new FsConversationStore(await mkdtemp(join(tmpdir(), "citation-follow-up-")));
      const arrivals = vi.fn(async () => ({ notify: true }));
      const readState = {
        agentContentArrived: arrivals,
        unreadAmong: () => new Set<string>(),
        finishExpectedContent: () => {},
      } as unknown as ConversationReadStatePort;
      const backend = new UncitedBackend(name, true);
      const { service, turnEnded } = makeService(backend, { store, readState });
      const { sessionId } = await service.createSession("device:A");
      service.sendMessage("device:A", sessionId, "When is the budget review?");
      await turnEnded(1);
      await vi.waitFor(() => expect(arrivals).toHaveBeenCalled());
      const loaded = await service.loadConversation(sessionId);
      await service.dispose();
      return { backend, loaded };
    }

    it("tells the unread gate the answer arrived", async () => {
      const { backend } = await citedTurn();
      expect(backend.turns).toHaveLength(2);
    });

    it("reloads ending on the answer, with no failure line", async () => {
      const { loaded } = await citedTurn();
      const messages = loaded!.messages;
      expect(JSON.stringify(messages)).toContain("annotate_many");
      expect(JSON.stringify(messages)).not.toContain("Model request failed");
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        parts: [{ kind: "text", text: ANSWER }],
      });
    });
  });
});
