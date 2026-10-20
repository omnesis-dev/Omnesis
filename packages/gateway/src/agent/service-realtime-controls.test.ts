// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type ChatBackend, type TurnInput } from "@omnesis/agent";
import { AgentService } from "./service.js";
import { FsConversationStore } from "./conversation-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const submission = (id: string, text = "Queued fictional question") => ({
  clientMessageId: id,
  text,
  mode: "queue" as const,
});
function reply(ask = false): ChatBackend {
  return {
    name: "scripted-voice",
    model: "scripted-voice",
    async *runTurn(input, abortSignal) {
      const base = { sessionId: input.sessionId, messageId: input.messageId };
      if (ask) {
        const tool = input.tools.find((candidate) => candidate.name === "ask_clarification")!;
        const args = {
          question: "Which fictional format?",
          choices: [{ label: "Table" }, { label: "Prose" }],
        };
        yield {
          type: "agent.tool.start",
          payload: { ...base, toolCallId: "clarification-call", tool: tool.name, args },
        };
        const result = await tool.invoke(args, {
          ...base,
          abortSignal,
          caller: input.caller,
          timeZone: input.timeZone,
        });
        yield {
          type: "agent.tool.result",
          payload: { ...base, toolCallId: "clarification-call", result, durationMs: 1 },
        };
      }
      yield {
        type: "agent.text.delta",
        payload: {
          ...base,
          delta: ask ? "Which fictional format: Table or Prose?" : "Spoken answer",
        },
      };
      yield { type: "agent.message.end", payload: { ...base, stopReason: "end_turn" } };
    },
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "omnesis-realtime-controls-"));
  const store = new FsConversationStore(directory);
  const inputs: TurnInput[] = [];
  const normal: ChatBackend = {
    name: "scripted-text",
    model: "scripted-text",
    async *runTurn(input, signal) {
      inputs.push(input);
      yield* reply(input.userMessage === "Ask a fictional question").runTurn(input, signal);
    },
  };
  const service = new AgentService({
    backendFactory: () => normal,
    ports: {
      search: { search: async () => ({ query: "", durationMs: 0, results: [] }) },
      document: { fetch: async () => null },
    },
    systemPrompt: "Shared instructions",
    store,
  });
  cleanups.push(async () => {
    await service.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, inputs, store };
}

it("defers durable queued text during voice and drains it exactly once after lease release", async () => {
  const f = await fixture();
  const voice = await f.service.openRealtimeSession("token:owner", {});
  const queued = submission("queue-one");
  await f.service.submitMessage("token:owner", voice.sessionId, queued);
  expect(f.inputs).toHaveLength(0);
  const before = f.service.conversationControls(voice.sessionId);
  expect(before.queuedMessages.map((item) => item.id)).toEqual([queued.clientMessageId]);
  await expect(
    f.service.submitMessage("token:owner", voice.sessionId, {
      ...submission("interrupt"),
      mode: "interrupt",
    }),
  ).rejects.toMatchObject({ code: "session_busy" });
  await expect(
    f.service.sendQueuedNow("token:owner", voice.sessionId, [queued.clientMessageId]),
  ).rejects.toMatchObject({ code: "session_busy" });
  expect(f.service.conversationControls(voice.sessionId)).toEqual(before);
  await voice.run("Spoken question", reply(), new AbortController().signal);
  expect(f.inputs).toHaveLength(0);
  await voice.close();
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  await vi.waitFor(() =>
    expect(f.service.conversationControls(voice.sessionId).queuedMessages).toEqual([]),
  );
  expect(f.inputs[0]!.userMessage).toBe(queued.text);
  expect(f.inputs[0]!.tools.map((tool) => tool.name)).toEqual(
    voice.context.tools.map((tool) => tool.name),
  );
  expect(voice.context.tools.some((tool) => tool.name === "ask_clarification")).toBe(true);
  await f.service.submitMessage("token:owner", voice.sessionId, queued);
  expect(f.inputs).toHaveLength(1);
});

it("keeps queued submissions ordered across canonical voice cancellation and close", async () => {
  const f = await fixture();
  const voice = await f.service.openRealtimeSession("token:owner", {});
  let abortSignal: AbortSignal | undefined;
  const pending: ChatBackend = {
    name: "scripted-pending-voice",
    model: "scripted-pending-voice",
    async *runTurn(input, signal) {
      abortSignal = signal;
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield {
        type: "agent.message.end",
        payload: { sessionId: input.sessionId, messageId: input.messageId, stopReason: "canceled" },
      };
    },
  };
  const active = voice.run("Canceled spoken question", pending, new AbortController().signal);
  await vi.waitFor(() => expect(abortSignal).toBeDefined());
  await f.service.submitMessage(
    "token:owner",
    voice.sessionId,
    submission("first", "First queued text"),
  );
  await f.service.submitMessage(
    "token:owner",
    voice.sessionId,
    submission("second", "Second queued text"),
  );
  voice.cancel();
  await active;
  expect(abortSignal?.aborted).toBe(true);
  expect(f.inputs).toHaveLength(0);
  expect(
    f.service.conversationControls(voice.sessionId).queuedMessages.map((item) => item.id),
  ).toEqual(["first", "second"]);
  await voice.close();
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  expect(f.inputs[0]!.userMessage).toBe("First queued text\n\nSecond queued text");
  await vi.waitFor(() =>
    expect(f.service.conversationControls(voice.sessionId).queuedMessages).toEqual([]),
  );
  const stored = await f.store.load(voice.sessionId);
  expect(
    stored?.controls?.submissions.map((item) => ({ id: item.id, status: item.status })),
  ).toEqual([
    { id: "first", status: "completed" },
    { id: "second", status: "completed" },
  ]);
});

it("serializes spoken clarification answers after a pending durable queue acceptance", async () => {
  const f = await fixture();
  const voice = await f.service.openRealtimeSession("token:owner", {});
  await voice.run("Ask a fictional question", reply(true), new AbortController().signal);
  let persistStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    persistStarted = resolve;
  });
  let finishPersist!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finishPersist = resolve;
  });
  const originalSave = f.store.save.bind(f.store);
  vi.spyOn(f.store, "save").mockImplementationOnce(async (record) => {
    persistStarted();
    await blocked;
    await originalSave(record);
  });
  const acceptance = f.service.submitMessage(
    "token:owner",
    voice.sessionId,
    submission("concurrent-answer"),
  );
  await started;
  const spoken = reply();
  const run = vi.spyOn(spoken, "runTurn");
  const answer = voice.run("Table please", spoken, new AbortController().signal);
  expect(run).not.toHaveBeenCalled();
  finishPersist();
  await acceptance;
  await answer;
  expect(run).toHaveBeenCalledTimes(1);
  const stored = await f.store.load(voice.sessionId);
  expect(stored?.controls?.pendingClarification).toBeUndefined();
  await voice.close();
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
});

it.each(["close", "cancel"] as const)(
  "invalidates a voice turn waiting for control admission on %s",
  async (action) => {
    const f = await fixture();
    const voice = await f.service.openRealtimeSession("token:owner", {});
    let persistStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      persistStarted = resolve;
    });
    let finishPersist!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finishPersist = resolve;
    });
    const originalSave = f.store.save.bind(f.store);
    vi.spyOn(f.store, "save").mockImplementationOnce(async (record) => {
      persistStarted();
      await blocked;
      await originalSave(record);
    });
    const acceptance = f.service.submitMessage(
      "token:owner",
      voice.sessionId,
      submission("held-acceptance"),
    );
    await started;
    const spoken = reply();
    const run = vi.spyOn(spoken, "runTurn");
    const answer = voice
      .run("Must never become a canonical voice message", spoken, new AbortController().signal)
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    if (action === "close") await voice.close();
    else voice.cancel();
    finishPersist();
    await acceptance;
    expect(await answer).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    if (action === "cancel") {
      expect(f.inputs).toHaveLength(0);
      await voice.close();
    }
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    expect(
      f.inputs[0]!.history.some((message) =>
        message.parts.some(
          (part) =>
            part.kind === "text" && part.text === "Must never become a canonical voice message",
        ),
      ),
    ).toBe(false);
  },
);

it("answers the same durable clarification by speech and unblocks the preserved queue", async () => {
  const f = await fixture();
  const voice = await f.service.openRealtimeSession("token:owner", {});
  await voice.run("Ask a fictional question", reply(true), new AbortController().signal);
  expect(f.service.conversationControls(voice.sessionId).pendingClarification).toBeDefined();
  await f.service.submitMessage("token:owner", voice.sessionId, submission("after-answer"));
  await voice.run("Table please", reply(), new AbortController().signal);
  expect(f.service.conversationControls(voice.sessionId).pendingClarification).toBeUndefined();
  expect(f.inputs).toHaveLength(0);
  await voice.close();
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  expect(
    f.inputs[0]!.history.some((message) =>
      message.parts.some(
        (part) =>
          part.kind === "tool_result" &&
          part.result.kind === "structured" &&
          part.result.resultType === "conversation.clarification",
      ),
    ),
  ).toBe(true);
  await vi.waitFor(() =>
    expect(f.service.conversationControls(voice.sessionId).queuedMessages).toEqual([]),
  );
  const stored = await f.store.load(voice.sessionId);
  expect(stored?.controls?.pendingClarification).toBeUndefined();
});

it("refuses to leapfrog a preexisting queued submission when entering voice", async () => {
  const f = await fixture();
  const created = await f.service.createSession("token:owner");
  f.service.sendMessage("token:owner", created.sessionId, "Ask a fictional question");
  await vi.waitFor(() =>
    expect(f.service.conversationControls(created.sessionId).pendingClarification).toBeDefined(),
  );
  await f.service.submitMessage("token:owner", created.sessionId, submission("already-queued"));
  await expect(
    f.service.openRealtimeSession("token:owner", { conversationId: created.sessionId }),
  ).rejects.toMatchObject({ code: "session_busy" });
  expect(
    f.service.conversationControls(created.sessionId).queuedMessages.map((item) => item.id),
  ).toEqual(["already-queued"]);
  await f.service.sendQueuedNow("token:owner", created.sessionId, ["already-queued"]);
  await vi.waitFor(() => expect(f.inputs).toHaveLength(2));
});
