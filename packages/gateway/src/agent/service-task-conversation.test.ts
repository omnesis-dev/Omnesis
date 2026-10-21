// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Conversations about a task ("Chat about this"): opened empty with the
 * task's snapshot in their origin, resumed like any conversation, and given
 * the task's context in the system prompt of every turn, built when the turn
 * starts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./service.js";
import { FsConversationStore, type TaskConversationOrigin } from "./conversation-store.js";
import type { ChatBackend, DocumentPort, SearchPort, TurnInput } from "@omnesis/agent";
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
      yield {
        type: "agent.text.delta",
        payload: { ...ids, delta: "The renewal is due on the 20th." },
      };
      yield { type: "agent.message.end", payload: { ...ids, stopReason: "end_turn" } };
    },
  };
}

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "omnesis-task-conversation-test-"));
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

const SNAPSHOT = {
  title: "Renew the studio lease",
  state: "open",
  due: "2026-03-20",
  sourceCount: 2,
};

async function sendAndSettle(
  service: AgentService,
  store: FsConversationStore,
  id: string,
  text: string,
  messages: number,
) {
  service.sendMessage("token:t1", id, text);
  await waitFor(
    () => store.load(id),
    (record) => (record?.messages.length ?? 0) >= messages,
  );
}

describe("task conversations", () => {
  it("opens an empty conversation titled after the task, with the snapshot in its origin", async () => {
    const { service, store } = makeService();
    const summary = await service.openTaskConversation("token:t1", {
      taskId: "loop_lease",
      snapshot: SNAPSHOT,
    });
    const origin: TaskConversationOrigin = {
      kind: "task",
      taskId: "loop_lease",
      runId: "loop_lease",
      task: SNAPSHOT,
      seedMessageCount: 0,
    };
    expect(summary).toMatchObject({
      title: "Renew the studio lease",
      messageCount: 0,
      pinned: false,
      model: "scripted-model",
      origin,
    });
    const record = await store.load(summary.id);
    expect(record).toMatchObject({ callerId: "token:t1", messages: [], origin });
    // List rows carry the anchor only.
    expect((await service.listConversations()).find((c) => c.id === summary.id)?.origin).toEqual({
      kind: "task",
      taskId: "loop_lease",
      runId: "loop_lease",
    });
    const second = await service.openTaskConversation("token:t1", {
      taskId: "loop_lease",
      snapshot: SNAPSHOT,
    });
    expect(second.id).not.toBe(summary.id);
  });

  it("puts the task's current context in the system prompt of every turn", async () => {
    const { service, store, seen } = makeService();
    let version = 1;
    const asked: string[] = [];
    service.setTaskContextProvider((origin) => {
      asked.push(origin.taskId);
      return `## Task context v${version}`;
    });
    const { id } = await service.openTaskConversation("token:t1", {
      taskId: "loop_lease",
      snapshot: SNAPSHOT,
    });
    const resumed = await service.createSession("token:t1", { resumeFromId: id });
    expect(resumed.origin).toMatchObject({ kind: "task", task: SNAPSHOT });
    expect(resumed.title).toBe("Renew the studio lease");

    await sendAndSettle(service, store, id, "When is this due?", 2);
    expect(seen.at(-1)!.systemPrompt).toBe("default chat prompt\n\n## Task context v1");

    version = 2;
    await sendAndSettle(service, store, id, "And what did the landlord say?", 4);
    expect(seen.at(-1)!.systemPrompt).toBe("default chat prompt\n\n## Task context v2");
    expect(asked).toEqual(["loop_lease", "loop_lease"]);

    // The user's own messages are the conversation; the title stays the task's.
    const record = await store.load(id);
    expect(record!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(record!.title).toBe("Renew the studio lease");
  });

  it("keeps the plain prompt when the context cannot be built", async () => {
    const { service, store, seen } = makeService();
    service.setTaskContextProvider(() => {
      throw new Error("the task store is unavailable");
    });
    const { id } = await service.openTaskConversation("token:t1", {
      taskId: "loop_lease",
      snapshot: SNAPSHOT,
    });
    await service.createSession("token:t1", { resumeFromId: id });
    await sendAndSettle(service, store, id, "When is this due?", 2);
    expect(seen.at(-1)!.systemPrompt).toBe("default chat prompt");
  });

  it("adds nothing to a conversation that is not about a task", async () => {
    const { service, store, seen } = makeService();
    let calls = 0;
    service.setTaskContextProvider(() => {
      calls += 1;
      return "## Task context";
    });
    const { sessionId } = await service.createSession("token:t1", {});
    await sendAndSettle(service, store, sessionId, "Hello", 2);
    expect(seen.at(-1)!.systemPrompt).toBe("default chat prompt");
    expect(calls).toBe(0);
  });
});
