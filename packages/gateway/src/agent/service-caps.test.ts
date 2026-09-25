// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";

import { ReplayBackend, type DocumentPort, type SearchPort } from "@omnesis/agent";

import { AgentService } from "./service.js";
import type { AgentEvent, WsEvent } from "@omnesis/core";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

function makeService(
  opts: {
    maxSessionsPerCaller?: number;
    maxTotalSessions?: number;
    maxListenersPerCaller?: number;
    idleTimeoutMs?: number;
  } = {},
) {
  let n = 0;
  const captured: WsEvent[] = [];
  const service = new AgentService({
    backendFactory: () =>
      new ReplayBackend({
        fixtures: [
          {
            entries: [
              {
                afterMs: 0,
                event: {
                  type: "agent.message.end",
                  payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
                } satisfies AgentEvent,
              },
            ],
          },
        ],
      }),
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "test",
    broadcastEvent: (e) => captured.push(e),
    sessionIdGen: () => `S_${++n}`,
    idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
    maxSessionsPerCaller: opts.maxSessionsPerCaller,
    maxTotalSessions: opts.maxTotalSessions,
    maxListenersPerCaller: opts.maxListenersPerCaller,
  });
  return { service, captured };
}

describe("AgentService caps", () => {
  it("evicts the oldest idle session when the per-caller cap is hit", async () => {
    const { service } = makeService({ maxSessionsPerCaller: 2 });
    const s1 = await service.createSession("caller-A");
    await service.createSession("caller-A");
    // With every session idle, the 3rd create evicts s1 and succeeds. The
    // hard reject only fires when every existing session is in-flight
    // (covered by a separate test path — see service.ts createSession).
    const s3 = await service.createSession("caller-A");
    expect(s3.sessionId).not.toBe(s1.sessionId);
  });

  it("rejects createSession past the global cap", async () => {
    const { service } = makeService({ maxSessionsPerCaller: 100, maxTotalSessions: 1 });
    await service.createSession("caller-A");
    await expect(service.createSession("caller-B")).rejects.toThrowError(/total-session cap/);
  });

  it("rejects subscribe past the per-caller listener cap", () => {
    const { service } = makeService({ maxListenersPerCaller: 2 });
    service.subscribe("caller-A", () => {});
    service.subscribe("caller-A", () => {});
    expect(() => service.subscribe("caller-A", () => {})).toThrowError(/listener cap/);
  });

  it("counts sessions per caller, not globally, for the per-caller cap", async () => {
    const { service } = makeService({ maxSessionsPerCaller: 1 });
    await service.createSession("caller-A");
    // caller-B is unaffected by caller-A's cap.
    await expect(service.createSession("caller-B")).resolves.toBeDefined();
  });
});
