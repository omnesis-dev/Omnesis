// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import {
  ConversationControls,
  restoreConversationControls,
  type ConversationControlState,
} from "./conversation-controls.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function harness() {
  let busy = true;
  let available = true;
  let state: ConversationControlState = { submissions: [] };
  let durable: ConversationControlState = { submissions: [] };
  const turns: ReturnType<typeof deferred>[] = [];
  const starts: string[] = [];
  const persist = vi.fn(async () => {
    durable = structuredClone(state);
  });
  const cancel = vi.fn();
  const controls = new ConversationControls({
    state: () => state,
    persist,
    busy: () => busy,
    available: () => available,
    start: async (_, s) => {
      starts.push(s.text);
      const turn = deferred();
      turns.push(turn);
      await turn.promise;
    },
    cancel,
  });
  return {
    controls,
    persist,
    cancel,
    starts,
    turns,
    idle: () => {
      busy = false;
      controls.kick("s");
    },
    stop: () => {
      available = false;
    },
    state: () => state,
    durable: () => durable,
    restore: () => {
      state = restoreConversationControls(durable);
    },
  };
}
const input = (id: string, text = id) => ({ clientMessageId: id, text, mode: "queue" as const });

it("accepts a durable follow-up while busy, deduplicates concurrent retries, then starts one combined turn", async () => {
  const h = harness();
  await Promise.all([
    h.controls.submit("s", input("one")),
    h.controls.submit("s", input("one")),
    h.controls.submit("s", input("two")),
  ]);
  expect(h.durable().submissions.map((s) => s.text)).toEqual(["one", "two"]);
  expect(h.starts).toEqual([]);
  h.idle();
  await vi.waitFor(() => expect(h.starts).toEqual(["one\n\ntwo"]));
  expect(h.durable().submissions[0]?.status).toBe("running");
  h.turns[0]!.resolve();
  await vi.waitFor(() => expect(h.controls.snapshot("s").queuedMessages).toEqual([]));
  await h.controls.settle();
  await h.controls.submit("s", input("one"));
  expect(h.starts).toEqual(["one\n\ntwo"]);
});

it("interrupts only after durability, puts correction first, retains older queued work", async () => {
  const h = harness();
  await h.controls.submit("s", input("later"));
  const barrier = deferred();
  h.persist.mockImplementationOnce(() => barrier.promise);
  const accepted = h.controls.submit("s", { ...input("correction"), mode: "interrupt" });
  await Promise.resolve();
  expect(h.cancel).not.toHaveBeenCalled();
  barrier.resolve();
  await accepted;
  expect(h.cancel).toHaveBeenCalledOnce();
  expect(h.controls.snapshot("s").queuedMessages.map((s) => s.text)).toEqual([
    "correction",
    "later",
  ]);
});

it("never cancels or drops a clarification when accepting the correction fails", async () => {
  const h = harness();
  h.state().pendingClarification = {
    id: "q",
    question: "Which period?",
    choices: [{ label: "This month" }, { label: "Last month" }],
  };
  h.persist.mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(
    h.controls.submit("s", { ...input("correction"), mode: "interrupt", clarificationId: "q" }),
  ).rejects.toThrow();
  expect(h.cancel).not.toHaveBeenCalled();
  expect(h.state().submissions).toEqual([]);
  expect(h.state().pendingClarification?.id).toBe("q");
});

it("rejects ID reuse with changed intent and stale cross-device clarification answers", async () => {
  const h = harness();
  await h.controls.submit("s", input("one"));
  await expect(h.controls.submit("s", input("one", "changed"))).rejects.toThrow("already used");
  await expect(
    h.controls.submit("s", { ...input("two"), clarificationId: "stale" }),
  ).rejects.toThrow("already been answered");
});

it("restores queued messages and choices but never automatically replays an uncertain running turn", async () => {
  const h = harness();
  const tool = h.controls.clarificationTool("s");
  const question = {
    question: "Which period should I compare?",
    choices: [{ label: "This month" }, { label: "Last month" }],
  };
  expect(await tool.invoke(question, { sessionId: "s", messageId: "m" })).toMatchObject({
    kind: "structured",
    resultType: "conversation.clarification",
  });
  expect(h.durable().pendingClarification).toMatchObject(question);
  await h.controls.submit("s", input("queued"));
  h.restore();
  expect(h.controls.snapshot("s").pendingClarification).toMatchObject(question);
  expect(h.controls.snapshot("s").queuedMessages).toHaveLength(1);
  const resumed = restoreConversationControls({
    submissions: [{ ...input("uncertain"), id: "uncertain", status: "running" }],
  });
  expect(resumed.submissions[0]).toMatchObject({ status: "failed" });
});

it("accepts only the first answer to a question even from concurrent devices", async () => {
  const h = harness();
  await h.controls
    .clarificationTool("s")
    .invoke(
      { question: "Which format?", choices: [{ label: "Table" }, { label: "Prose" }] },
      { sessionId: "s", messageId: "m" },
    );
  const id = h.state().pendingClarification!.id;
  const answers = await Promise.allSettled([
    h.controls.submit("s", { ...input("one", "Table"), clarificationId: id }),
    h.controls.submit("s", { ...input("two", "Something else"), clarificationId: id }),
  ]);
  expect(answers.map((a) => a.status)).toEqual(["fulfilled", "rejected"]);
  expect(h.durable().pendingClarification).toBeUndefined();
});

it("does not create questions from a canceled tool invocation", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  const result = await h.controls
    .clarificationTool("s")
    .invoke(
      { question: "Which?", choices: [{ label: "A" }, { label: "B" }] },
      { sessionId: "s", messageId: "m", abortSignal: controller.signal },
    );
  expect(result).toMatchObject({ kind: "error", code: "canceled" });
  expect(h.state().pendingClarification).toBeUndefined();
});

describe("compatibility", () => {
  it("treats transcripts without controls as ordinary conversations", () => {
    expect(restoreConversationControls(undefined)).toEqual({ submissions: [] });
  });
  it("retains receipts with future fields and refuses to replay unknown states", () => {
    const state = restoreConversationControls({
      submissions: [
        { ...input("known"), id: "known", status: "completed", future: true },
        { ...input("future"), id: "future", status: "awaiting_extension", future: true },
      ],
    });
    expect(state.submissions.map((s) => [s.id, s.status])).toEqual([
      ["known", "completed"],
      ["future", "failed"],
    ]);
    expect(() => restoreConversationControls({ submissions: [{ id: "broken" }] })).toThrow(
      "safely",
    );
  });
  it("accepts additive future fields in durable control state", () => {
    expect(restoreConversationControls({ submissions: [], future: true })).toEqual({
      submissions: [],
    });
    const restored = restoreConversationControls({
      submissions: [],
      pendingClarification: {
        id: "q",
        question: "Which?",
        future: true,
        choices: [{ label: "A", future: true }, { label: "B" }],
      },
    });
    expect(restored.pendingClarification?.choices).toEqual([{ label: "A" }, { label: "B" }]);
  });
});

it("serializes completion receipts behind acceptance rollback", async () => {
  const h = harness();
  await h.controls.submit("s", input("first"));
  h.idle();
  await vi.waitFor(() => expect(h.starts).toEqual(["first"]));
  const entered = deferred();
  const release = deferred();
  h.persist.mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("Acceptance storage failed");
  });
  const failed = h.controls.submit("s", input("rejected")).catch((error: unknown) => error);
  await entered.promise;
  h.turns[0]!.resolve();
  // Drain promise continuations without releasing the deliberately held transaction.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(h.state().submissions[0]?.status).toBe("running");
  release.resolve();
  expect(await failed).toBeInstanceOf(Error);
  await h.controls.settle();
  expect(h.durable().submissions.map((item) => [item.id, item.status])).toEqual([
    ["first", "completed"],
  ]);
});

it("send now cancels after persistence and never cancels again once the batch starts", async () => {
  const h = harness();
  await h.controls.submit("s", input("one"));
  await h.controls.submit("s", input("two"));
  const barrier = deferred();
  h.persist.mockImplementationOnce(() => barrier.promise);
  const sending = h.controls.sendNow("s", ["one", "two"]);
  await Promise.resolve();
  expect(h.cancel).not.toHaveBeenCalled();
  barrier.resolve();
  await sending;
  expect(h.cancel).toHaveBeenCalledOnce();
  h.idle();
  await vi.waitFor(() => expect(h.starts).toEqual(["one\n\ntwo"]));
  await h.controls.sendNow("s", ["one", "two"]);
  expect(h.cancel).toHaveBeenCalledOnce();
  h.turns[0]!.resolve();
  await h.controls.settle();
  await h.controls.submit("s", input("three"));
  await h.controls.sendNow("s", ["one", "two"]);
  expect(h.cancel).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(h.starts).toHaveLength(2));
  h.turns[1]!.resolve();
  await h.controls.settle();
});

it("send now preserves the queue and question on failed persistence", async () => {
  const h = harness();
  await h.controls.submit("s", input("one"));
  h.state().pendingClarification = {
    id: "q",
    question: "Which format?",
    choices: [{ label: "Table" }, { label: "Prose" }],
  };
  h.persist.mockRejectedValueOnce(new Error("disk unavailable"));
  await expect(h.controls.sendNow("s", ["one"])).rejects.toThrow("disk unavailable");
  expect(h.cancel).not.toHaveBeenCalled();
  expect(h.state().pendingClarification?.id).toBe("q");
  expect(h.state().submissions[0]?.status).toBe("queued");
  await expect(h.controls.sendNow("s", ["unknown"])).rejects.toThrow("changed");
});

it("keeps messages accepted during the combined turn for the next turn", async () => {
  const h = harness();
  await h.controls.submit("s", input("one"));
  await h.controls.submit("s", input("two"));
  h.idle();
  await vi.waitFor(() => expect(h.starts).toEqual(["one\n\ntwo"]));
  await h.controls.submit("s", input("three"));
  await h.controls.submit("s", input("four"));
  h.turns[0]!.resolve();
  await vi.waitFor(() => expect(h.starts).toEqual(["one\n\ntwo", "three\n\nfour"]));
  h.turns[1]!.resolve();
  await h.controls.settle();
  expect(h.durable().submissions.every((s) => s.status === "completed")).toBe(true);
});

it("bounds combined prompt length without discarding accepted work", async () => {
  const h = harness();
  await h.controls.submit("s", input("one", "a".repeat(9998)));
  await expect(h.controls.submit("s", input("two", "b"))).rejects.toThrow("too long");
  expect(h.durable().submissions).toHaveLength(1);
  await h.controls.submit("s", input("one", "a".repeat(9998)));
});

it("drains oversized queues saved by an older gateway in bounded turns", async () => {
  const h = harness();
  h.state().submissions = ["one", "two"].map((id) => ({
    ...input(id, id.repeat(2000)),
    id,
    status: "queued",
  }));
  h.idle();
  await vi.waitFor(() => expect(h.starts).toEqual(["one".repeat(2000)]));
  h.turns[0]!.resolve();
  await vi.waitFor(() => expect(h.starts).toHaveLength(2));
  expect(h.starts[1]).toBe("two".repeat(2000));
  h.turns[1]!.resolve();
  await h.controls.settle();
});
