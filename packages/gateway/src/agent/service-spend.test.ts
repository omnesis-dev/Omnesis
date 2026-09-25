// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Interactive-turn cognition-spend recording (the `recordSpend` seam):
 * one sample per settled turn, usage summed across the turn's
 * `agent.message.end` events, canceled/errored turns folded without
 * counting a completed run. All fixture data is invented.
 */

import { describe, expect, it } from "vitest";

import { ReplayBackend, type DocumentPort, type SearchPort } from "@omnesis/agent";
import { AgentService } from "./service.js";
import type { AgentEvent } from "@omnesis/core";

import type { AgentSpendSample } from "./spend-recorder.js";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

function messageEnd(stopReason: string, usage?: Record<string, number>): AgentEvent {
  return {
    type: "agent.message.end",
    payload: {
      sessionId: "$SESSION",
      messageId: "$MSG",
      stopReason,
      ...(usage ? { usage } : {}),
    },
  } as AgentEvent;
}

function textDelta(delta: string): AgentEvent {
  return {
    type: "agent.text.delta",
    payload: { sessionId: "$SESSION", messageId: "$MSG", delta },
  };
}

function makeService(events: AgentEvent[]) {
  const samples: AgentSpendSample[] = [];
  const service = new AgentService({
    backendFactory: () =>
      new ReplayBackend({
        fixtures: [{ entries: events.map((e) => ({ afterMs: 0, event: e })) }],
      }),
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "test",
    sessionIdGen: () => "S_spend",
    idleTimeoutMs: 60_000,
    recordSpend: (sample) => samples.push(sample),
  });
  return { service, samples };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe("interactive-turn spend recording", () => {
  it("records one completed sample per turn with usage summed across message ends", async () => {
    const { service, samples } = makeService([
      textDelta("part one"),
      messageEnd("tool_use", {
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 40,
        cacheCreationTokens: 8,
      }),
      textDelta("part two"),
      messageEnd("end_turn", { inputTokens: 50, outputTokens: 5, cacheReadTokens: 20 }),
    ]);
    const { sessionId } = await service.createSession("device:test");
    service.sendMessage("device:test", sessionId, "hello");
    await settle();

    expect(samples).toEqual([
      {
        mechanism: "interactive",
        modelId: "replay",
        usage: {
          inputTokens: 150,
          outputTokens: 15,
          cacheReadTokens: 60,
          cacheCreationTokens: 8,
        },
        completed: true,
      },
    ]);
  });

  it("records a canceled turn's reported tokens as not-completed", async () => {
    const { service, samples } = makeService([
      messageEnd("canceled", { inputTokens: 30, outputTokens: 2 }),
    ]);
    const { sessionId } = await service.createSession("device:test");
    service.sendMessage("device:test", sessionId, "hello");
    await settle();

    expect(samples).toHaveLength(1);
    expect(samples[0]!.completed).toBe(false);
    expect(samples[0]!.usage.inputTokens).toBe(30);
  });

  it("records nothing for a turn whose backend reported no usage", async () => {
    const { service, samples } = makeService([messageEnd("end_turn")]);
    const { sessionId } = await service.createSession("device:test");
    service.sendMessage("device:test", sessionId, "hello");
    await settle();

    expect(samples).toEqual([]);
  });

  it("records exactly once per turn across consecutive turns (no double count)", async () => {
    const events = [messageEnd("end_turn", { inputTokens: 7, outputTokens: 3 })];
    const samples: AgentSpendSample[] = [];
    const service = new AgentService({
      backendFactory: () =>
        new ReplayBackend({
          // Two fixtures — one per turn.
          fixtures: [
            { entries: events.map((e) => ({ afterMs: 0, event: e })) },
            { entries: events.map((e) => ({ afterMs: 0, event: e })) },
          ],
        }),
      ports: { search: stubSearch, document: stubDocument },
      systemPrompt: "test",
      sessionIdGen: () => "S_spend2",
      idleTimeoutMs: 60_000,
      recordSpend: (sample) => samples.push(sample),
    });
    const { sessionId } = await service.createSession("device:test");
    service.sendMessage("device:test", sessionId, "first");
    await settle();
    service.sendMessage("device:test", sessionId, "second");
    await settle();

    expect(samples).toHaveLength(2);
    expect(samples.every((s) => s.usage.inputTokens === 7 && s.completed)).toBe(true);
  });
});
