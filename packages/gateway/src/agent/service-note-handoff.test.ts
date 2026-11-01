// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { AgentService } from "./service.js";
import { FsConversationStore } from "./conversation-store.js";
import type { ChatBackend, TurnInput } from "@omnesis/agent";
import type { NoteHandoff } from "../brain/note-agent/handoffs.js";

test("a durable plain question resumes with normal chat tools; retries preserve replies and notify once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-note-handoff-"));
  const store = new FsConversationStore(dir);
  const seen: TurnInput[] = [];
  const notify = vi.fn();
  const arrivals = vi.fn(async () => ({ notify: true }));
  const backend: ChatBackend = {
    name: "scripted",
    model: "scripted",
    async *runTurn(input) {
      seen.push(input);
      yield {
        type: "agent.text.delta",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          delta: "The remaining work is done.",
        },
      };
      yield {
        type: "agent.message.end",
        payload: { sessionId: input.sessionId, messageId: input.messageId, stopReason: "end_turn" },
      };
    },
  };
  const service = new AgentService({
    backendFactory: () => backend,
    ports: {
      search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      document: { fetch: async () => null },
      record: {
        resolve: async () => {
          throw new Error("Not invoked");
        },
      },
    },
    systemPrompt: "Normal chat prompt.",
    store,
    noteContext: (origin) => `Live note context: ${origin.processingContext}`,
    notifyConversation: notify,
    readState: {
      agentContentArrived: arrivals,
      markSeen: async () => undefined,
      expectContentViewed: () => undefined,
      finishExpectedContent: () => undefined,
      unreadAmong: () => new Set(),
      forget: async () => undefined,
      viewingTtlMs: () => 1000,
    },
  });
  const input: NoteHandoff = {
    conversationId: "s_note_fixture",
    noteId: "note_fixture",
    revision: 0,
    attempt: 1,
    text: "Prepare a star chart, then clarify which dome to repair.",
    capturedAt: "2026-03-10T08:00:00Z",
    day: "2026-03-10",
    instructionAt: "2026-03-10T08:00:00Z",
    question: "Which dome needs repair?",
    context: "The chart task loop_chart was already created; do not repeat it.",
    changes: [{ text: "Added star chart", taskId: "loop_chart", undoSeq: 1 }],
  };
  try {
    await service.openNoteClarification(input);
    await service.openNoteClarification(input);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(arrivals).toHaveBeenCalledTimes(1);
    const saved = (await store.load(input.conversationId))!;
    expect(saved.messages).toEqual([
      { role: "user", parts: [{ kind: "text", text: input.text }] },
      { role: "assistant", parts: [{ kind: "text", text: input.question }] },
    ]);
    expect(saved.controls?.pendingClarification).toBeUndefined();
    expect(saved.origin).toMatchObject({
      kind: "note",
      noteId: input.noteId,
      revision: 0,
      seedMessageCount: 0,
      processingContext: input.context,
    });
    const resumed = await service.createSession("owner", {
      resumeFromId: input.conversationId,
      caller: { kind: "operator" },
      timeZone: "UTC",
    });
    service.sendMessage("owner", resumed.sessionId, "The western dome.");
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.systemPrompt).toContain("Normal chat prompt.");
    expect(seen[0]?.systemPrompt).toContain("loop_chart");
    expect(seen[0]?.tools.map((t) => t.name)).toContain("ask_clarification");
    expect(seen[0]?.tools.map((t) => t.name)).toContain("cite_record");
    expect(seen[0]?.tools.map((t) => t.name)).not.toContain("continue_in_chat");
    await vi.waitFor(async () =>
      expect((await store.load(input.conversationId))?.messages.at(-1)).toMatchObject({
        role: "assistant",
        parts: [{ kind: "text", text: "The remaining work is done." }],
      }),
    );
    const after = await store.load(input.conversationId);
    await service.openNoteClarification(input);
    expect((await store.load(input.conversationId))?.messages).toEqual(after?.messages);
    // Deletion creates a live tombstone; production also cancels the durable outbox.
    await vi.waitFor(async () =>
      expect(await service.deleteConversation(input.conversationId)).toBe(true),
    );
    await expect(service.openNoteClarification(input)).rejects.toThrow("deleted");
    expect(await store.load(input.conversationId)).toBeNull();
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an interrupted notification enqueue retries the same saved question and stops after it is seen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-note-handoff-retry-"));
  const store = new FsConversationStore(dir);
  let unread = false;
  let attempts = 0;
  const notifications: unknown[] = [];
  const backend: ChatBackend = {
    name: "scripted",
    model: "scripted",
    async *runTurn(input) {
      expect.unreachable("Handoff must not invoke a model");
      yield {
        type: "agent.message.end",
        payload: { sessionId: input.sessionId, messageId: input.messageId, stopReason: "end_turn" },
      };
    },
  };
  const input: NoteHandoff = {
    conversationId: "s_note_retry",
    noteId: "note_retry",
    revision: 0,
    attempt: 1,
    text: "Which dome should I repair?",
    capturedAt: "2026-03-10T08:00:00Z",
    day: "2026-03-10",
    instructionAt: "2026-03-10T08:00:00Z",
    question: "Which dome needs repair?",
    context: "Two candidates were found.",
    changes: [],
  };
  const service = new AgentService({
    backendFactory: () => backend,
    ports: {
      search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      document: { fetch: async () => null },
    },
    systemPrompt: "Normal chat.",
    store,
    notifyConversation: async (notification) => {
      notifications.push(notification);
      attempts++;
      if (attempts === 1) throw new Error("Queue acknowledgement interrupted");
    },
    readState: {
      agentContentArrived: async () => {
        unread = true;
        return { notify: true };
      },
      markSeen: async () => {
        unread = false;
      },
      expectContentViewed: () => undefined,
      finishExpectedContent: () => undefined,
      unreadAmong: (ids) => new Set(unread ? ids : []),
      forget: async () => undefined,
      viewingTtlMs: () => 1000,
    },
  });
  try {
    await expect(service.openNoteClarification(input)).rejects.toThrow("interrupted");
    expect((await store.load(input.conversationId))?.messages).toHaveLength(2);
    await service.openNoteClarification(input);
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toEqual(notifications[1]);
    expect(notifications[1]).toMatchObject({
      idempotencyKey: `note-handoff:${input.conversationId}`,
      body: input.question,
    });
    expect((await store.load(input.conversationId))?.messages).toHaveLength(2);
    unread = false;
    await service.openNoteClarification(input);
    expect(notifications).toHaveLength(2);
  } finally {
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
