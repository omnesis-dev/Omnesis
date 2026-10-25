// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Morning brief conversation: one standing, pinned, undeletable thread
 * that each morning's brief is appended to as an assistant message. A reply
 * runs as an ordinary chat turn whose model context starts at the latest
 * brief, with that brief's items in the system prompt.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentError,
  AgentService,
  MORNING_BRIEF_REDACTED_TEXT,
  MORNING_BRIEF_TITLE,
} from "./service.js";
import { FsConversationStore, DAILY_BRIEF_REF_LIMIT } from "./conversation-store.js";
import type { ChatBackend, ChatMessage, DocumentPort, SearchPort, TurnInput } from "@omnesis/agent";
import type { AgentEvent } from "@omnesis/core";

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

function capturingBackend(seen: TurnInput[]): ChatBackend {
  return {
    name: "scripted",
    model: "scripted-model",
    // eslint-disable-next-line @typescript-eslint/require-await
    async *runTurn(input: TurnInput): AsyncIterable<AgentEvent> {
      seen.push(input);
      const ids = { sessionId: input.sessionId, messageId: input.messageId };
      yield { type: "agent.message.start", payload: { ...ids, role: "assistant" } };
      yield { type: "agent.text.delta", payload: { ...ids, delta: "Done — moved it to Friday." } };
      yield { type: "agent.message.end", payload: { ...ids, stopReason: "end_turn" } };
    },
  };
}

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-daily-brief-test-"));
  tempDirs.push(dir);
  const store = new FsConversationStore(dir);
  const seen: TurnInput[] = [];
  let n = 0;
  const service = new AgentService({
    backendFactory: () => capturingBackend(seen),
    ports: { search: stubSearch, document: stubDocument },
    systemPrompt: "default chat prompt",
    sessionIdGen: () => `s_${++n}`,
    idleTimeoutMs: 60_000,
    store,
  });
  return { service, store, seen };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const brief = (day: string) => ({
  day,
  runId: `run_${day}`,
  text: `Good morning. Two things for ${day}: the lease form, and Maya's train.`,
  notify: false,
});

describe("Morning brief conversation", () => {
  it("creates one pinned conversation and appends each day to it", async () => {
    const { service, store } = makeService();
    const first = await service.appendMorningBrief(brief("2026-03-10"));
    const second = await service.appendMorningBrief(brief("2026-03-11"));
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.messageId).not.toBe(first.messageId);

    const record = await store.load(first.conversationId);
    expect(record).toMatchObject({ title: MORNING_BRIEF_TITLE, pinned: true });
    expect(record!.messages.map((m) => m.role)).toEqual(["assistant", "assistant"]);
    expect(record!.origin).toEqual({
      kind: "daily_brief",
      runId: "run_2026-03-11",
      briefs: [
        {
          day: "2026-03-10",
          messageIndex: 0,
          messageId: first.messageId,
          sentAt: expect.stringMatching(ISO_UTC),
        },
        {
          day: "2026-03-11",
          messageIndex: 1,
          messageId: second.messageId,
          sentAt: expect.stringMatching(ISO_UTC),
        },
      ],
    });
    const listed = await store.list();
    expect(listed.filter((c) => c.origin?.kind === "daily_brief")).toHaveLength(1);
  });

  it("keeps a user's unpin across later briefs", async () => {
    const { service, store } = makeService();
    const { conversationId } = await service.appendMorningBrief(brief("2026-03-10"));
    await service.setConversationPinned(conversationId, false);
    await service.appendMorningBrief(brief("2026-03-11"));
    expect((await store.load(conversationId))!.pinned).toBe(false);
  });

  it("bounds the brief references it keeps", async () => {
    const { service, store } = makeService();
    let id = "";
    for (let i = 0; i < DAILY_BRIEF_REF_LIMIT + 3; i += 1) {
      id = (await service.appendMorningBrief({ ...brief(`day-${i}`), text: `brief ${i}` }))
        .conversationId;
    }
    const origin = (await store.load(id))!.origin;
    expect(origin?.kind === "daily_brief" && origin.briefs.length).toBe(DAILY_BRIEF_REF_LIMIT);
    expect(origin?.kind === "daily_brief" && origin.briefs.at(-1)?.day).toBe(
      `day-${DAILY_BRIEF_REF_LIMIT + 2}`,
    );
  });

  it("appends a day once, even when asked again", async () => {
    const { service, store } = makeService();
    const first = await service.appendMorningBrief(brief("2026-03-10"));
    const again = await service.appendMorningBrief(brief("2026-03-10"));
    expect(again).toEqual(first);
    expect((await store.load(first.conversationId))!.messages).toHaveLength(1);
  });

  it("redacts one brief and keeps the others", async () => {
    const { service, store } = makeService();
    const monday = await service.appendMorningBrief(brief("2026-03-10"));
    await service.appendMorningBrief(brief("2026-03-11"));
    expect(await service.redactMorningBrief(monday.conversationId, monday.messageId)).toBe(true);
    const record = await store.load(monday.conversationId);
    expect(JSON.stringify(record!.messages[0])).toContain(MORNING_BRIEF_REDACTED_TEXT);
    expect(JSON.stringify(record!.messages[0])).not.toContain("Two things for 2026-03-10");
    expect(JSON.stringify(record!.messages[1])).toContain("Two things for 2026-03-11");
    expect(await service.redactMorningBrief(monday.conversationId, "mb_unknown")).toBe(false);
  });

  it("cannot be deleted", async () => {
    const { service, store } = makeService();
    const { conversationId } = await service.appendMorningBrief(brief("2026-03-10"));
    await expect(service.deleteConversation(conversationId)).rejects.toMatchObject({
      code: "conversation_permanent",
    });
    await expect(service.deleteConversation(conversationId)).rejects.toBeInstanceOf(AgentError);
    expect(await store.load(conversationId)).not.toBeNull();
  });

  it("a reply sees only the latest brief, with its context in the system prompt", async () => {
    const { service, store, seen } = makeService();
    const contexts: Array<{ day: string; messageId: string }> = [];
    service.setDailyBriefContextProvider((latest) => {
      contexts.push(latest);
      return `## Items for ${latest.day}`;
    });
    await service.appendMorningBrief(brief("2026-03-10"));
    const today = await service.appendMorningBrief(brief("2026-03-11"));

    const session = await service.createSession("token:t1", { resumeFromId: today.conversationId });
    expect(session.messages).toHaveLength(2);
    service.sendMessage("token:t1", today.conversationId, "Move the lease form to Friday");
    await waitFor(
      () => store.load(today.conversationId),
      (record) => (record?.messages.length ?? 0) >= 4,
    );

    expect(contexts).toEqual([
      expect.objectContaining({ day: "2026-03-11", messageId: today.messageId }),
    ]);
    const turn = seen.at(-1)!;
    expect(turn.systemPrompt).toContain("## Items for 2026-03-11");
    const history: ChatMessage[] = [...turn.history];
    // A short user line introduces today's brief; yesterday's is out of context.
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(history[0])).toContain("2026-03-11");
    expect(JSON.stringify(history[1])).toContain("Two things for 2026-03-11");
    expect(JSON.stringify(history)).not.toContain("Two things for 2026-03-10");

    // The stored transcript keeps every day and the reply.
    const record = await store.load(today.conversationId);
    expect(record!.messages.map((m) => m.role)).toEqual([
      "assistant",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(record!.title).toBe(MORNING_BRIEF_TITLE);
  });

  it("a new brief evicts an idle live session so the next reply sees it", async () => {
    const { service, store, seen } = makeService();
    const first = await service.appendMorningBrief(brief("2026-03-10"));
    await service.createSession("token:t1", { resumeFromId: first.conversationId });
    service.sendMessage("token:t1", first.conversationId, "Thanks");
    await waitFor(
      () => store.load(first.conversationId),
      (record) => (record?.messages.length ?? 0) >= 3,
    );
    await service.appendMorningBrief(brief("2026-03-11"));
    const record = await store.load(first.conversationId);
    expect(record!.messages.map((m) => m.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "assistant",
    ]);

    await service.createSession("token:t1", { resumeFromId: first.conversationId });
    service.sendMessage("token:t1", first.conversationId, "What's first today?");
    await waitFor(
      () => store.load(first.conversationId),
      (r) => (r?.messages.length ?? 0) >= 6,
    );
    const history = JSON.stringify(seen.at(-1)!.history);
    expect(history).toContain("Two things for 2026-03-11");
    expect(history).not.toContain("Thanks");
  });
});
