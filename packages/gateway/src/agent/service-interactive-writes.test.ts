// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Interactive-agent substrate write access: a TOP-LEVEL chat session, under
 * experimental mode with an InteractiveWriteProfile installed, is handed the
 * Cognition Steward's own mutating tools stamped with an interactive-origin run id —
 * so facts the user provides mid-conversation are written into the substrate.
 * With the profile absent — or experimental off — the session stays read-only.
 *
 * The paired sub-agent-read-only invariant (the write handles never reach a
 * delegated child) is covered where it lives: the own-tools are appended only to
 * the per-session `tools` array (never `this.tools`, which subagents build from),
 * and `selectSubagentTools` strips every `mutates:true` handle — asserted in
 * `registry.test.ts` and `brain/steward/runtime.test.ts`.
 *
 * Fixture data is invented — no corpus content.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ChatBackend,
  type DocumentPort,
  type SearchPort,
  type ToolHandle,
  type TurnInput,
} from "@omnesis/agent";
import { type AgentEvent, type CapabilityRole, type WsEvent } from "@omnesis/core";
import { AgentService, type InteractiveWriteProfile } from "./service.js";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

/** Captures the tool names the top-level session was handed. */
class RecordingBackend implements ChatBackend {
  readonly name = "rec";
  readonly model = "rec";
  sawTools: string[] = [];
  async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
    const { sessionId, messageId } = input;
    this.sawTools = input.tools.map((t) => t.name);
    yield { type: "agent.message.start", payload: { sessionId, messageId, role: "assistant" } };
    yield { type: "agent.text.delta", payload: { sessionId, messageId, delta: "ok" } };
    yield { type: "agent.message.end", payload: { sessionId, messageId, stopReason: "end_turn" } };
  }
}

/** A stub write tool that records the run id it was built with. */
function makeProfile(): { profile: InteractiveWriteProfile; seenRunIds: string[] } {
  const seenRunIds: string[] = [];
  const profile: InteractiveWriteProfile = {
    buildOwnTools(runId: string): ToolHandle[] {
      seenRunIds.push(runId);
      const stub: ToolHandle = {
        name: "cognitive_write_stub",
        description: "stub",
        mutates: true,
        schema: undefined as never,
        invoke: async () => ({ kind: "structured", resultType: "noop", data: {} }),
      };
      return [stub];
    },
  };
  return { profile, seenRunIds };
}

function makeService() {
  const captured: WsEvent[] = [];
  const backend = new RecordingBackend();
  const service = new AgentService({
    backendFactory: (_role: CapabilityRole) => backend,
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "test",
    broadcastEvent: (e) => captured.push(e),
    sessionIdGen: () => "S_top",
    idleTimeoutMs: 60_000,
  });
  return { service, backend };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

describe("interactive-agent substrate write access", () => {
  let prevExperimental: string | undefined;
  beforeEach(() => {
    prevExperimental = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
  });
  afterEach(() => {
    if (prevExperimental === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
    else process.env.OMNESIS_EXPERIMENTAL = prevExperimental;
  });

  it("appends the profile's write tools to a top-level session, stamped interactive_<sessionId>", async () => {
    const { service, backend } = makeService();
    const { profile, seenRunIds } = makeProfile();
    service.setInteractiveWriteProfile(profile);

    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "she confirmed for Tuesday");
    await settle();

    expect(backend.sawTools).toContain("cognitive_write_stub");
    // Provenance: the run id marks the interactive origin (analogue of talkback_).
    expect(seenRunIds).toContain(`interactive_${sessionId}`);
  });

  it("stays read-only when no profile is installed", async () => {
    const { service, backend } = makeService();
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "hello");
    await settle();
    expect(backend.sawTools).not.toContain("cognitive_write_stub");
  });

  it("stays read-only when experimental is off, even with a profile", async () => {
    process.env.OMNESIS_EXPERIMENTAL = "0";
    const { service, backend } = makeService();
    service.setInteractiveWriteProfile(makeProfile().profile);
    const { sessionId } = await service.createSession("device:A");
    service.sendMessage("device:A", sessionId, "hello");
    await settle();
    expect(backend.sawTools).not.toContain("cognitive_write_stub");
  });
});

describe("stable interactive memory", () => {
  it("grants memory while keeping the broader cognition profile gated", async () => {
    const previous = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "0";
    const { service, backend } = makeService();
    try {
      service.setInteractiveMemoryProfile(makeProfile().profile);
      service.setInteractiveWriteProfile({
        buildOwnTools: () => [
          {
            name: "open_loop_create",
            description: "stub",
            mutates: true,
            schema: undefined as never,
            invoke: async () => ({ kind: "structured", resultType: "noop", data: {} }),
          },
        ],
      });
      const { sessionId } = await service.createSession("device:A");
      service.sendMessage("device:A", sessionId, "Remember that I prefer morning meetings.");
      await settle();
      expect(backend.sawTools).toContain("cognitive_write_stub");
      expect(backend.sawTools).not.toContain("open_loop_create");
    } finally {
      if (previous === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previous;
    }
  });
  it("does not duplicate annotation tools when both profiles are installed", async () => {
    const previous = process.env.OMNESIS_EXPERIMENTAL;
    process.env.OMNESIS_EXPERIMENTAL = "1";
    try {
      const { service, backend } = makeService();
      service.setInteractiveMemoryProfile(makeProfile().profile);
      service.setInteractiveWriteProfile(makeProfile().profile);
      const { sessionId } = await service.createSession("device:A");
      service.sendMessage("device:A", sessionId, "hello");
      await settle();
      expect(backend.sawTools.filter((name) => name === "cognitive_write_stub")).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.OMNESIS_EXPERIMENTAL;
      else process.env.OMNESIS_EXPERIMENTAL = previous;
    }
  });
});
