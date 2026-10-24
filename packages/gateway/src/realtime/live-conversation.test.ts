// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { LiveConversation, liveHistory, speechChunks } from "./live-conversation.js";
import type { VoiceAgentSession, VoiceTurnResult } from "../agent/voice-session.js";

function harness() {
  const agent: VoiceAgentSession = {
    sessionId: "conversation-fixture",
    model: "configured-model",
    backend: "configured-backend",
    history: [],
    visibleHistory: [],
    subscribe: () => () => {},
    submit: vi.fn(() =>
      Promise.resolve<VoiceTurnResult>({
        messageId: "answer",
        text: "There are two appointments.",
        stopReason: "end_turn",
      }),
    ),
    cancel: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const host = {
    agent,
    callId: "00000000-0000-4000-8000-000000000001",
    send: vi.fn(),
    fail: vi.fn(),
    replyFailure: vi.fn(),
  };
  return { agent, host, conversation: new LiveConversation(host) };
}
const request = (id: string) => ({
  type: "session.delegation.created",
  delegation: { id, target: "client" },
  offset_ms: 2000,
});
const input = (id: string, delta: string) => ({
  type: "session.input_transcript.delta",
  event_id: id,
  delta,
  start_ms: 0,
  end_ms: 1000,
});
async function drain() {
  for (let index = 0; index < 5; index++) await Promise.resolve();
}

describe("configured-agent Live delegation", () => {
  it("retains metadata-only requests until caller text and authenticated media readiness exist", async () => {
    const { conversation, agent, host } = harness();
    conversation.receive(request("delegation-one"));
    await drain();
    expect(agent.submit).not.toHaveBeenCalled();
    conversation.receive(input("fragment-one", "Find "));
    conversation.receive(input("fragment-two", "today's appointments."));
    await drain();
    expect(agent.submit).not.toHaveBeenCalled();
    conversation.ready();
    await drain();
    // The delegation's offset is not a transcript watermark; this must not deadlock.
    expect(agent.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ stream: true, text: "Find today's appointments." }),
    );
    expect(host.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.commentary.append",
        delegation_id: "delegation-one",
        content: "There are two appointments.",
      }),
    );
    expect(agent.cancel).not.toHaveBeenCalled();
  });

  it("deduplicates notification IDs without deduplicating repeated words", async () => {
    const { conversation, agent } = harness();
    conversation.ready();
    conversation.receive(input("one", "Very "));
    conversation.receive(input("two", "very important."));
    conversation.receive(input("two", "very important."));
    conversation.receive(request("same"));
    conversation.receive(request("same"));
    await drain();
    expect(agent.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "Very very important." }),
    );
  });

  it("keeps distinct delegation and transcript identities unambiguous", async () => {
    const { conversation, agent } = harness();
    conversation.ready();
    conversation.receive(input("c", "Check the schedule."));
    conversation.receive(request("a:b"));
    await drain();
    conversation.receive(input("b:c", "Check tomorrow too."));
    conversation.receive(request("a"));
    await drain();
    const calls = vi.mocked(agent.submit).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].clientMessageId).not.toBe(calls[1]![0].clientMessageId);
  });

  it("preserves work during overlapping speech and suppresses a superseded spoken result", async () => {
    const { conversation, agent, host } = harness();
    const completions: Array<(value: VoiceTurnResult) => void> = [];
    agent.submit = vi.fn(
      () => new Promise<VoiceTurnResult>((resolve) => completions.push(resolve)),
    );
    conversation.ready();
    conversation.receive(input("one", "Check the Friday schedule."));
    conversation.receive(request("first"));
    await drain();
    conversation.receive(input("two", "Thursday instead."));
    await drain();
    expect(agent.cancel).not.toHaveBeenCalled();
    conversation.receive(request("second"));
    await drain();
    completions[0]!({ messageId: "old", stopReason: "end_turn", text: "Friday result." });
    await drain();
    expect(agent.submit).toHaveBeenCalledTimes(2);
    completions[1]!({ messageId: "new", stopReason: "end_turn", text: "Thursday result." });
    await drain();
    expect(
      host.send.mock.calls
        .filter(([event]) => event.type === "session.commentary.append")
        .map(([event]) => event.content),
    ).toEqual(["Thursday result."]);
    expect(host.send).toHaveBeenCalledWith(expect.objectContaining({ delegation_id: "second" }));
    expect(agent.cancel).not.toHaveBeenCalled();
  });

  it("keeps frontend captions as quoted context and never records a second agent answer", async () => {
    const { conversation, agent } = harness();
    conversation.ready();
    conversation.receive({
      ...input("spoken", "There are two appointments."),
      type: "session.output_transcript.delta",
    });
    conversation.receive(input("caller", "Which one is first?"));
    conversation.receive(request("follow-up"));
    await drain();
    expect(agent.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        text: "Which one is first?",
        spokenContext: expect.stringContaining('"frontendSpeech":"There are two appointments."'),
      }),
    );
  });

  it("does not deliver late answers after media detaches or cancel canonical work", async () => {
    const { conversation, agent, host } = harness();
    let complete!: (result: VoiceTurnResult) => void;
    agent.submit = vi.fn(
      () =>
        new Promise<VoiceTurnResult>((resolve) => {
          complete = resolve;
        }),
    );
    conversation.ready();
    conversation.receive(input("one", "Check the schedule."));
    conversation.receive(request("first"));
    await drain();
    conversation.stop();
    complete({ messageId: "late", text: "A completed result.", stopReason: "end_turn" });
    await drain();
    expect(agent.submit).toHaveBeenCalledTimes(1);
    expect(host.send).not.toHaveBeenCalled();
    expect(agent.cancel).not.toHaveBeenCalled();
  });

  it("rejects malformed intervals and ignores unrelated future events", () => {
    const { conversation, host } = harness();
    conversation.receive({ type: "session.future.capability", private: "not a transcript" });
    expect(host.fail).not.toHaveBeenCalled();
    conversation.receive({ ...input("bad", "hello"), start_ms: 1001 });
    expect(host.fail).toHaveBeenCalledWith(expect.objectContaining({ code: "protocol_error" }));
  });

  it("preserves caller text despite approximate offsets and consumes each fragment once", async () => {
    const { conversation, agent } = harness();
    conversation.ready();
    conversation.receive({
      ...input("later", "Check the Thursday schedule."),
      start_ms: 5000,
      end_ms: 6000,
    });
    conversation.receive({ ...request("old"), offset_ms: 1000 });
    await drain();
    expect(agent.submit).toHaveBeenCalledTimes(1);
    conversation.receive({ ...request("current"), offset_ms: 6500 });
    await drain();
    expect(agent.submit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ text: "Check the Thursday schedule." }),
    );
  });

  it("keeps late continuations as canonical follow-ups instead of repeating the original action", async () => {
    const { conversation, agent } = harness();
    conversation.ready();
    conversation.receive(input("first", "Check my schedule "));
    conversation.receive(request("one-request"));
    await drain();
    conversation.receive({ ...input("late", "for Thursday."), start_ms: 1500, end_ms: 2100 });
    await drain();
    const calls = vi.mocked(agent.submit).mock.calls;
    expect(calls.map(([value]) => value.text)).toEqual(["Check my schedule ", "for Thursday."]);
    expect(calls[0]![0].clientMessageId).not.toBe(calls[1]![0].clientMessageId);
  });

  it("durably submits post-offset continuations without requiring another delegation", async () => {
    const { conversation, agent, host } = harness();
    const completions: Array<(value: VoiceTurnResult) => void> = [];
    agent.submit = vi.fn(
      () => new Promise<VoiceTurnResult>((resolve) => completions.push(resolve)),
    );
    conversation.ready();
    conversation.receive({ ...input("first", "Check my schedule "), end_ms: 500 });
    conversation.receive({ ...request("early"), offset_ms: 600 });
    await drain();
    conversation.receive({ ...input("tail-one", "for "), start_ms: 700, end_ms: 800 });
    await drain();
    conversation.receive({ ...input("tail-two", "Thursday."), start_ms: 800, end_ms: 1000 });
    await drain();
    expect(agent.submit).toHaveBeenCalledTimes(3);
    completions[0]!({
      messageId: "first",
      text: "An earlier partial result.",
      stopReason: "end_turn",
    });
    await drain();
    expect(vi.mocked(agent.submit).mock.calls.map(([value]) => value.text)).toEqual([
      "Check my schedule ",
      "for ",
      "Thursday.",
    ]);
    completions[1]!({ messageId: "middle", text: "A partial answer.", stopReason: "end_turn" });
    completions[2]!({
      messageId: "second",
      text: "Thursday has two appointments.",
      stopReason: "end_turn",
    });
    await drain();
    expect(
      host.send.mock.calls
        .filter(([event]) => event.type === "session.commentary.append")
        .map(([event]) => event.content),
    ).toEqual(["Thursday has two appointments."]);
  });

  it("invalidates spoken routing when newer delegation metadata arrives before its transcript", async () => {
    const { conversation, agent, host } = harness();
    let complete!: (result: VoiceTurnResult) => void;
    agent.submit = vi.fn(
      () =>
        new Promise<VoiceTurnResult>((resolve) => {
          complete = resolve;
        }),
    );
    conversation.ready();
    conversation.receive(request("one"));
    conversation.receive(input("one", "Check the Friday schedule."));
    await drain();
    conversation.receive(request("two"));
    complete({ messageId: "old", text: "Friday's result.", stopReason: "end_turn" });
    await drain();
    expect(host.send.mock.calls.some(([event]) => event.type === "session.commentary.append")).toBe(
      false,
    );
  });

  it("does not speak an old rejection over newer caller speech", async () => {
    const { conversation, agent, host } = harness();
    let reject!: (reason: Error) => void;
    agent.submit = vi.fn(
      () =>
        new Promise<VoiceTurnResult>((_resolve, fail) => {
          reject = fail;
        }),
    );
    conversation.ready();
    conversation.receive(input("one", "Check the Friday schedule."));
    conversation.receive(request("one"));
    await drain();
    conversation.receive(input("two", "Thursday instead."));
    reject(new Error("old failure"));
    await drain();
    expect(host.send).not.toHaveBeenCalled();
    expect(host.replyFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: "provider_error" }),
    );
  });

  it("does not force stale speech after a correction arrives ahead of its delegation", async () => {
    const { conversation, agent, host } = harness();
    let complete!: (result: VoiceTurnResult) => void;
    agent.submit = vi.fn(
      () =>
        new Promise<VoiceTurnResult>((resolve) => {
          complete = resolve;
        }),
    );
    conversation.ready();
    conversation.receive(input("first", "Check the Friday schedule."));
    conversation.receive(request("first-request"));
    await drain();
    conversation.receive({
      ...input("correction", "Thursday instead."),
      start_ms: 3000,
      end_ms: 4000,
    });
    complete({ messageId: "old", text: "Friday result.", stopReason: "end_turn" });
    await drain();
    expect(host.send.mock.calls.some(([event]) => event.type === "session.commentary.append")).toBe(
      false,
    );
    expect(agent.submit).toHaveBeenCalledTimes(2);
    expect(host.send).not.toHaveBeenCalled();
    expect(agent.cancel).not.toHaveBeenCalled();
  });
});

describe("bounded speech context", () => {
  it("keeps Unicode intact and every append below the documented token limit", () => {
    const text = "界🌤️".repeat(600);
    const chunks = speechChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 480)).toBe(true);
  });

  it("seeds only recent visible canonical text, never tool dumps or reasoning", () => {
    expect(
      liveHistory([{ role: "assistant", parts: [{ kind: "text", text: "A verified answer." }] }]),
    ).toEqual([
      { role: "assistant", content: [{ type: "input_text", text: "A verified answer." }] },
    ]);
    expect(
      liveHistory([{ role: "user", parts: [{ kind: "text", text: "x".repeat(8193) }] }]),
    ).toEqual([]);
  });
});
