// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Anchored-thread sessions (brief talk-back + temporal-annotation ask):
 * createAnchoredThread persists an origin-tagged, seeded conversation
 * without starting a live session; resuming one dispatches onto the
 * anchored-thread profile (steward toolset + background-agent backend)
 * instead of the default chat profile — with the origin handed to both
 * profile callbacks — and refuses cleanly when no profile is installed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ReplayBackend,
  type ChatMessage,
  type DocumentPort,
  type SearchPort,
  type ToolHandle,
} from "@omnesis/agent";
import { z } from "zod";
import { AgentError, AgentService, type AnchoredThreadProfile } from "./service.js";
import { FsConversationStore } from "./conversation-store.js";
import type { ConversationOrigin } from "./conversation-store.js";
import type { AgentEvent, ToolResult } from "@omnesis/core";

const stubSearch: SearchPort = {
  async search(input) {
    return { query: input.query, durationMs: 1, results: [] };
  },
};
const stubDocument: DocumentPort = { fetch: async () => null };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function endTurn(): AgentEvent[] {
  return [
    {
      type: "agent.text.delta",
      payload: { sessionId: "S", messageId: "M", delta: "Noted." },
    } as AgentEvent,
    {
      type: "agent.message.end",
      payload: { sessionId: "S", messageId: "M", stopReason: "end_turn" },
    } as AgentEvent,
  ];
}

function threadTool(): ToolHandle {
  return {
    name: "open_loop_search",
    description: "stub",
    schema: z.object({}),
    async invoke(): Promise<ToolResult> {
      return { kind: "text", text: "ok" };
    },
  };
}

const SEED: ChatMessage[] = [
  {
    role: "user",
    parts: [{ kind: "text", text: "Loop agent run run_1 (kind: data, attempt 1)." }],
  },
  { role: "assistant", parts: [{ kind: "text", text: "Tracked the projector loan." }] },
];

const BRIEF_ORIGIN: ConversationOrigin = {
  kind: "brief",
  briefId: "brief_1",
  runId: "run_1",
  brief: {
    title: "Return the borrowed projector",
    description: "The projector goes back to the AV desk this week.",
    body: "Borrowed for the demo on 2026-07-02; the AV desk closes at 17:00.",
  },
};

function makeService(withProfile: boolean, opts: { backendResolvable?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-anchored-thread-test-"));
  tempDirs.push(dir);
  const store = new FsConversationStore(dir);
  let profileToolCalls = 0;
  const promptOrigins: ConversationOrigin[] = [];
  const service = new AgentService({
    backendFactory: () =>
      new ReplayBackend({
        fixtures: [{ entries: endTurn().map((e) => ({ afterMs: 0, event: e })) }],
      }),
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "default chat prompt",
    sessionIdGen: () => `s_${Math.random().toString(36).slice(2, 10)}`,
    idleTimeoutMs: 60_000,
    store,
  });
  const profile: AnchoredThreadProfile = {
    buildTools: () => {
      profileToolCalls += 1;
      return [threadTool()];
    },
    systemPrompt: (origin) => {
      promptOrigins.push(origin);
      return "talkback prompt";
    },
    resolveBackend: () =>
      opts.backendResolvable === false
        ? null
        : new ReplayBackend({
            fixtures: [{ entries: endTurn().map((e) => ({ afterMs: 0, event: e })) }],
          }),
  };
  if (withProfile) service.setAnchoredThreadProfile(profile);
  return { service, store, profileToolCallCount: () => profileToolCalls, promptOrigins };
}

describe("AgentService anchored threads", () => {
  it("createAnchoredThread persists an origin-tagged conversation with the fixed title and seed", async () => {
    const { service, store } = makeService(true);
    const id = await service.createAnchoredThread("token:t1", {
      title: "Return the borrowed projector",
      origin: BRIEF_ORIGIN,
      initialHistory: SEED,
    });
    const rec = await store.load(id);
    expect(rec).not.toBeNull();
    expect(rec!.origin).toEqual({ ...BRIEF_ORIGIN, seedMessageCount: SEED.length });
    expect(rec!.title).toBe("Return the borrowed projector");
    expect(rec!.messages).toEqual(SEED);
    // No live session was started — resume is what builds one.
    const summaries = await store.list();
    expect(summaries[0]!.origin).toEqual({
      kind: "brief",
      briefId: "brief_1",
      runId: "run_1",
    });
  });

  it("resuming an anchored thread without a profile refuses with a typed error", async () => {
    const { service } = makeService(true);
    const id = await service.createAnchoredThread("token:t1", {
      title: "Return the borrowed projector",
      origin: BRIEF_ORIGIN,
      initialHistory: SEED,
    });
    service.setAnchoredThreadProfile(null);
    await expect(service.createSession("token:t1", { resumeFromId: id })).rejects.toMatchObject({
      code: "anchored_thread_unavailable",
    });
  });

  it("resuming a brief thread runs on the profile and keeps origin + title across turn saves", async () => {
    const { service, store, profileToolCallCount, promptOrigins } = makeService(true);
    const id = await service.createAnchoredThread("token:t1", {
      title: "Return the borrowed projector",
      origin: BRIEF_ORIGIN,
      initialHistory: SEED,
    });
    const resumed = await service.createSession("token:t1", { resumeFromId: id });
    expect(resumed.messages).toEqual(SEED);
    expect(resumed.origin).toEqual({ ...BRIEF_ORIGIN, seedMessageCount: SEED.length });
    expect(resumed.title).toBe("Return the borrowed projector");
    expect(resumed.backend).toBe("replay");
    expect(profileToolCallCount()).toBe(1);
    // The profile's system prompt saw the origin it is framing.
    expect(promptOrigins).toHaveLength(1);
    expect(promptOrigins[0]!.kind).toBe("brief");

    service.sendMessage("token:t1", id, "I returned it yesterday.");
    // Wait for the turn (and its .finally persistence) to land on disk.
    await new Promise((r) => setTimeout(r, 150));
    const rec = await store.load(id);
    expect(rec!.origin).toEqual({ ...BRIEF_ORIGIN, seedMessageCount: SEED.length });
    expect(rec!.title).toBe("Return the borrowed projector");
    expect(rec!.messages.length).toBeGreaterThan(SEED.length);
  });

  it("createAnchoredThread refuses when the profile is missing or backend unresolvable", async () => {
    const { service } = makeService(false);
    await expect(
      service.createAnchoredThread("token:t1", {
        title: "T",
        origin: BRIEF_ORIGIN,
        initialHistory: SEED,
      }),
    ).rejects.toBeInstanceOf(AgentError);
    const { service: noBackend } = makeService(true, { backendResolvable: false });
    await expect(
      noBackend.createAnchoredThread("token:t1", {
        title: "T",
        origin: BRIEF_ORIGIN,
        initialHistory: SEED,
      }),
    ).rejects.toMatchObject({ code: "anchored_thread_unavailable" });
  });

  it("an anchor-shaped origin of an unknown kind refuses to resume instead of degrading to chat", async () => {
    const { service, store } = makeService(true);
    const id = await service.createAnchoredThread("token:t1", {
      title: "T",
      origin: BRIEF_ORIGIN,
      initialHistory: SEED,
    });
    // A persisted origin kind is no longer supported:
    // rewrite the persisted record's origin out-of-band.
    const rec = (await store.load(id))!;
    const raw = JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
    raw.origin = { kind: "shopping_list", listId: "sl_1", runId: "run_1" };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tempDirs.at(-1)!, `${id}.json`), JSON.stringify(raw));
    await expect(service.createSession("token:t1", { resumeFromId: id })).rejects.toMatchObject({
      code: "anchored_thread_unavailable",
      message: "this conversation has an unsupported origin and cannot be resumed safely",
    });
  });
});
