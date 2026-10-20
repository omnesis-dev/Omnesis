// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayBackend } from "@omnesis/agent";
import { AgentService } from "./service.js";
import type { AgentEvent } from "@omnesis/core";

const services: AgentService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
});
function fixture(events: AgentEvent[]) {
  const recordSpend = vi.fn();
  const service = new AgentService({
    backendFactory: () =>
      new ReplayBackend({
        fixtures: [{ entries: events.map((event) => ({ afterMs: 0, event })) }],
      }),
    ports: {
      search: { search: async (input) => ({ query: input.query, durationMs: 1, results: [] }) },
      document: { fetch: async () => null },
    },
    systemPrompt: "You are a fictional test assistant.",
    sessionIdGen: () => "realtime-test-thread",
    recordSpend,
  });
  services.push(service);
  return { service, recordSpend };
}
const delta = (text: string): AgentEvent => ({
  type: "agent.text.delta",
  payload: { sessionId: "$SESSION", messageId: "$MSG", delta: text },
});
const end = (stopReason: "end_turn" | "canceled"): AgentEvent => ({
  type: "agent.message.end",
  payload: {
    sessionId: "$SESSION",
    messageId: "$MSG",
    stopReason,
    usage: { inputTokens: 10, outputTokens: 5 },
  },
});

describe("supervised realtime agent turns", () => {
  it("returns the settled answer, streams live events, and records ordinary agent spend", async () => {
    const { service, recordSpend } = fixture([delta("Water the ferns."), end("end_turn")]);
    const created = await service.createSession("token:fictional", { profile: "voice" });
    const events: AgentEvent[] = [];
    expect(
      await service.realtimeTurn(
        "token:fictional",
        created.sessionId,
        "What needs watering?",
        new AbortController().signal,
        (event) => events.push(event),
      ),
    ).toBe("Water the ferns.");
    expect(events.some((event) => event.type === "agent.text.delta")).toBe(true);
    expect(recordSpend).toHaveBeenCalledWith(
      expect.objectContaining({ mechanism: "interactive", completed: true }),
    );
  });
  it("refuses a pre-cancelled call and rejects a cancelled answer", async () => {
    const { service } = fixture([delta("Partial"), end("canceled")]);
    const created = await service.createSession("token:fictional", { profile: "voice" });
    const abort = new AbortController();
    abort.abort();
    await expect(
      service.realtimeTurn(
        "token:fictional",
        created.sessionId,
        "Question",
        abort.signal,
        () => {},
      ),
    ).rejects.toThrow("Voice call ended");
    await expect(
      service.realtimeTurn(
        "token:fictional",
        created.sessionId,
        "Question",
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("could not complete");
  });
});
