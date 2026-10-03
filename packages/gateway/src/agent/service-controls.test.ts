// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AgentService } from "./service.js";
import { FsConversationStore } from "./conversation-store.js";
import type { ChatBackend } from "@omnesis/agent";

const services: AgentService[] = [];
const dirs: string[] = [];
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "omnesis-controls-"));
  dirs.push(dir);
  const store = new FsConversationStore(dir);
  const turns: { text: string; finish: () => void }[] = [];
  const backend: ChatBackend = {
    name: "scripted",
    model: "scripted",
    async *runTurn(input, signal) {
      const wait = gate();
      turns.push({ text: input.userMessage, finish: wait.resolve });
      const abort = () => wait.resolve();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (input.userMessage === "Ask a question") {
          const tool = input.tools.find((t) => t.name === "ask_clarification")!;
          await tool.invoke(
            { question: "Which format?", choices: [{ label: "Table" }, { label: "Prose" }] },
            { sessionId: input.sessionId, messageId: input.messageId, abortSignal: signal },
          );
        }
        await wait.promise;
        if (!signal?.aborted)
          yield {
            type: "agent.text.delta",
            payload: {
              sessionId: input.sessionId,
              messageId: input.messageId,
              delta: "Scripted answer",
            },
          };
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: signal?.aborted ? "canceled" : "end_turn",
          },
        };
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
  const create = () => {
    const service = new AgentService({
      backendFactory: () => backend,
      ports: {
        search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
        document: { fetch: async () => null },
      },
      systemPrompt: "test",
      store,
      sessionIdGen: () => "controls-session",
      idleTimeoutMs: 60_000,
    });
    services.push(service);
    return service;
  };
  return { service: create(), create, store, turns };
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.dispose()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const request = (id: string, text: string) => ({
  clientMessageId: id,
  text,
  mode: "queue" as const,
});

it("drains durable followups after a legacy turn; retries do not duplicate turns", async () => {
  const h = await setup();
  const { sessionId } = await h.service.createSession("device:A");
  h.service.sendMessage("device:A", sessionId, "First");
  await h.service.submitMessage("device:B", sessionId, request("followup", "Second"));
  await h.service.submitMessage("device:B", sessionId, request("additional", "Third"));
  expect(h.turns.map((t) => t.text)).toEqual(["First"]);
  h.turns[0]!.finish();
  await vi.waitFor(() => expect(h.turns.map((t) => t.text)).toEqual(["First", "Second\n\nThird"]));
  h.turns[1]!.finish();
  await vi.waitFor(async () =>
    expect((await h.store.load(sessionId))?.controls?.submissions[0]?.status).toBe("completed"),
  );
  await h.service.submitMessage("device:B", sessionId, request("followup", "Second"));
  expect(h.turns).toHaveLength(2);
  const record = await h.store.load(sessionId);
  expect(record?.messages.filter((m) => m.role === "user")).toHaveLength(2);
});

it("interrupts the current run and combines the correction with an older queued followup", async () => {
  const h = await setup();
  const { sessionId } = await h.service.createSession("device:A");
  h.service.sendMessage("device:A", sessionId, "First");
  await h.service.submitMessage("device:B", sessionId, request("followup", "Later"));
  await h.service.submitMessage("device:B", sessionId, {
    ...request("correction", "Correction"),
    mode: "interrupt",
  });
  await vi.waitFor(() =>
    expect(h.turns.map((t) => t.text)).toEqual(["First", "Correction\n\nLater"]),
  );
  h.turns[1]!.finish();
});

it("retains a question across restart and accepts text from an old client", async () => {
  const h = await setup();
  const { sessionId } = await h.service.createSession("device:A");
  h.service.sendMessage("device:A", sessionId, "Ask a question");
  await vi.waitFor(() =>
    expect(h.service.conversationControls(sessionId).pendingClarification?.question).toBe(
      "Which format?",
    ),
  );
  h.turns[0]!.finish();
  await vi.waitFor(() => expect(h.service.conversationControls(sessionId).busy).toBe(false));
  await h.service.dispose();
  const resumed = h.create();
  await resumed.createSession("device:B", { resumeFromId: sessionId });
  expect(resumed.conversationControls(sessionId).pendingClarification?.choices).toHaveLength(2);
  resumed.sendMessage("device:B", sessionId, "Prose");
  expect(resumed.conversationControls(sessionId).pendingClarification).toBeUndefined();
  h.turns[1]!.finish();
});

it("pauses queued work for a question and prioritizes its answer", async () => {
  const h = await setup();
  const { sessionId } = await h.service.createSession("device:A");
  h.service.sendMessage("device:A", sessionId, "Ask a question");
  await h.service.submitMessage("device:B", sessionId, request("later", "Later"));
  h.turns[0]!.finish();
  await vi.waitFor(() => expect(h.service.conversationControls(sessionId).busy).toBe(false));
  expect(h.turns).toHaveLength(1);
  const question = h.service.conversationControls(sessionId).pendingClarification!;
  await h.service.submitMessage("device:B", sessionId, {
    ...request("answer", "Table"),
    clarificationId: question.id,
  });
  await vi.waitFor(() =>
    expect(h.turns.map((t) => t.text)).toEqual(["Ask a question", "Table\n\nLater"]),
  );
  h.turns[1]!.finish();
});

it("reserves the start barrier against concurrent legacy sends", async () => {
  const h = await setup();
  const { sessionId } = await h.service.createSession("device:A");
  const saved = h.store.save.bind(h.store);
  const waiting = gate();
  const release = gate();
  let calls = 0;
  vi.spyOn(h.store, "save").mockImplementation(async (record) => {
    if (++calls === 2) {
      waiting.resolve();
      await release.promise;
    }
    await saved(record);
  });
  await h.service.submitMessage("device:A", sessionId, request("first", "Reserved"));
  await waiting.promise;
  expect(() => h.service.sendMessage("device:B", sessionId, "Race")).toThrow("queued message");
  release.resolve();
  await vi.waitFor(() => expect(h.turns.map((t) => t.text)).toEqual(["Reserved"]));
  h.turns[0]!.finish();
});

it("never persists a rejected submission through a concurrent legacy turn completion", async () => {
  const h = await setup();
  const { sessionId } = await h.service.createSession("device:A");
  h.service.sendMessage("device:A", sessionId, "First");
  const entered = gate();
  const release = gate();
  const save = h.store.save.bind(h.store);
  let rejectAcceptance = true;
  vi.spyOn(h.store, "save").mockImplementation(async (record) => {
    if (rejectAcceptance) {
      rejectAcceptance = false;
      entered.resolve();
      await release.promise;
      throw new Error("Acceptance storage failed");
    }
    await save(record);
  });
  // Observe entry into the real persistence path so the terminal snapshot is
  // definitely queued behind the held acceptance write before releasing it.
  const persistence = vi.spyOn(
    h.service as unknown as { persistConversation: (...args: unknown[]) => Promise<void> },
    "persistConversation",
  );
  const submission = h.service
    .submitMessage("device:B", sessionId, request("rejected", "Never accepted"))
    .catch((error: unknown) => error);
  await entered.promise;
  h.turns[0]!.finish();
  await vi.waitFor(() => expect(persistence).toHaveBeenCalledTimes(2));
  release.resolve();
  expect(await submission).toBeInstanceOf(Error);
  await vi.waitFor(() => expect(h.service.conversationControls(sessionId).busy).toBe(false));
  expect((await h.store.load(sessionId))?.controls?.submissions).toEqual([]);
  await h.service.dispose();
  const resumed = h.create();
  await resumed.createSession("device:A", { resumeFromId: sessionId });
  expect(resumed.conversationControls(sessionId).queuedMessages).toEqual([]);
  expect(h.turns.map((turn) => turn.text)).toEqual(["First"]);
});

it("keeps successful acceptance when an older terminal snapshot saves after it", async () => {
  const h = await setup();
  const { sessionId } = await h.service.createSession("device:A");
  h.service.sendMessage("device:A", sessionId, "First");
  const entered = gate();
  const release = gate();
  const save = h.store.save.bind(h.store);
  let holdAcceptance = true;
  vi.spyOn(h.store, "save").mockImplementation(async (record) => {
    if (holdAcceptance) {
      holdAcceptance = false;
      entered.resolve();
      await release.promise;
    }
    await save(record);
  });
  const persistence = vi.spyOn(
    h.service as unknown as { persistConversation: (...args: unknown[]) => Promise<void> },
    "persistConversation",
  );
  const submission = h.service.submitMessage("device:B", sessionId, request("next", "Second"));
  await entered.promise;
  h.turns[0]!.finish();
  await vi.waitFor(() => expect(persistence).toHaveBeenCalledTimes(2));
  release.resolve();
  await submission;
  await vi.waitFor(() => expect(h.turns.map((turn) => turn.text)).toEqual(["First", "Second"]));
  expect((await h.store.load(sessionId))?.controls?.submissions.map((item) => item.id)).toEqual([
    "next",
  ]);
  h.turns[1]!.finish();
});

it("interrupts once to send accumulated followups together and keeps receipts across restart", async () => {
  const h = await setup();
  const { sessionId } = await h.service.createSession("device:A");
  h.service.sendMessage("device:A", sessionId, "First");
  await h.service.submitMessage("device:A", sessionId, request("one", "Use a table."));
  await h.service.submitMessage("device:A", sessionId, request("two", "Include sources."));
  await h.service.sendQueuedNow("device:A", sessionId, ["one", "two"]);
  await vi.waitFor(() =>
    expect(h.turns.map((t) => t.text)).toEqual(["First", "Use a table.\n\nInclude sources."]),
  );
  h.turns[1]!.finish();
  await vi.waitFor(async () =>
    expect((await h.store.load(sessionId))?.controls?.submissions.map((s) => s.status)).toEqual([
      "completed",
      "completed",
    ]),
  );
  await h.service.dispose();
  const resumed = h.create();
  await resumed.createSession("device:A", { resumeFromId: sessionId });
  await resumed.sendQueuedNow("device:A", sessionId, ["one", "two"]);
  await resumed.submitMessage("device:A", sessionId, request("two", "Include sources."));
  expect(h.turns).toHaveLength(2);
  const record = await h.store.load(sessionId);
  expect(record?.messages.filter((m) => m.role === "user")).toHaveLength(2);
});
