// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The audience a conversation speaks for, carried from `createSession` to the
 * turn the backend actually runs.
 *
 * The HTTP boundary decides who is asking; the tools decide what that audience
 * may be shown. Between them sit two hand-written assignments — the service
 * onto the session, the session onto each turn — and dropping either is silent:
 * an unattributed turn is treated as speaking for nobody, so the operator's own
 * agent would quietly stop finding watches it had just been asked to make,
 * while every other assertion in the suite stayed green. That is the failure
 * this pins.
 */

import { describe, expect, it } from "vitest";

import { AgentService } from "./service.js";
import type { AgentEvent } from "@omnesis/core";
import type { ChatBackend, DocumentPort, SearchPort, ToolCaller, TurnInput } from "@omnesis/agent";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

/** Records the turn the session hands the backend, then ends the turn. */
function recordingService(): {
  service: AgentService;
  seen: () => TurnInput | undefined;
  turnComplete: Promise<void>;
} {
  let seen: TurnInput | undefined;
  let resolveTurn!: () => void;
  const turnComplete = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  const backend: ChatBackend = {
    name: "recording",
    model: "recording",
    async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      seen = input;
      yield {
        type: "agent.message.end",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          stopReason: "end_turn",
        },
      };
    },
  };
  const service = new AgentService({
    backendFactory: () => backend,
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "test",
    // The turn is over when its end event reaches the broadcast — this service
    // has no transcript store, so there is no persistence hook to wait on.
    broadcastEvent: (event) => {
      if (event.type === "agent.message.end") resolveTurn();
    },
    sessionIdGen: () => "S_1",
  });
  return { service, seen: () => seen, turnComplete };
}

async function turnFor(caller?: ToolCaller): Promise<TurnInput | undefined> {
  const { service, seen, turnComplete } = recordingService();
  const { sessionId } = await service.createSession("token:test", { caller });
  service.sendMessage("token:test", sessionId, "what am I watching for?");
  await turnComplete;
  return seen();
}

describe("the audience a conversation speaks for", () => {
  it("reaches the turn as the integration the boundary named", async () => {
    expect((await turnFor({ kind: "integration", slug: "openclaw" }))?.caller).toEqual({
      kind: "integration",
      slug: "openclaw",
    });
  });

  it("reaches the turn as the operator when the boundary said so", async () => {
    expect((await turnFor({ kind: "operator" }))?.caller).toEqual({ kind: "operator" });
  });

  // Background work and test rigs open sessions with no boundary to ask. The
  // absence has to travel too: a tool that sees no caller falls back to the
  // treatment that discloses least, and inventing one here would defeat that.
  it("stays absent when the session was opened without one", async () => {
    expect((await turnFor())?.caller).toBeUndefined();
  });
});
