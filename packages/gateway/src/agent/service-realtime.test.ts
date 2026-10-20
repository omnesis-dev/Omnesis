// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayBackend, type ChatBackend, type TurnInput } from "@omnesis/agent";
import { AgentService } from "./service.js";
import type { AgentEvent } from "@omnesis/core";
const services: AgentService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
});
function fixture() {
  const inputs: TurnInput[] = [];
  const ordinary = {
    name: "ordinary",
    model: "ordinary",
    runTurn: vi.fn<ChatBackend["runTurn"]>().mockImplementation(async function* (input) {
      inputs.push(input);
      yield {
        type: "agent.text.delta",
        payload: { sessionId: input.sessionId, messageId: input.messageId, delta: "Text answer" },
      };
      yield {
        type: "agent.message.end",
        payload: { sessionId: input.sessionId, messageId: input.messageId, stopReason: "end_turn" },
      };
    }),
  } satisfies ChatBackend;
  const service = new AgentService({
    backendFactory: () => ordinary,
    ports: {
      search: { search: async (input) => ({ query: input.query, durationMs: 1, results: [] }) },
      document: { fetch: async () => null },
    },
    systemPrompt: "Shared core prompt",
  });
  services.push(service);
  return { service, ordinary, inputs };
}
function voice(text: string) {
  return new ReplayBackend({
    fixtures: [
      {
        entries: [
          {
            afterMs: 0,
            event: {
              type: "agent.text.delta",
              payload: { sessionId: "$SESSION", messageId: "$MSG", delta: text },
            },
          },
          {
            afterMs: 0,
            event: {
              type: "agent.message.end",
              payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "end_turn" },
            },
          },
        ],
      },
    ],
  });
}
describe("shared realtime session facade", () => {
  it("switches text to voice to text on one canonical conversation without running the ordinary model for voice", async () => {
    const { service, ordinary, inputs } = fixture();
    const created = await service.createSession("token:fixture", { caller: { kind: "operator" } });
    service.sendMessage("token:fixture", created.sessionId, "First text question");
    await vi.waitFor(() => expect(ordinary.runTurn).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () =>
      expect(
        (await service.createSession("token:fixture", { resumeFromId: created.sessionId })).busy,
      ).toBe(false),
    );
    const realtime = await service.openRealtimeSession("token:fixture", {
      conversationId: created.sessionId,
    });
    expect(realtime.sessionId).toBe(created.sessionId);
    expect(
      realtime.context.history.some((message) =>
        message.parts.some((part) => part.kind === "text" && part.text === "Text answer"),
      ),
    ).toBe(true);
    await realtime.run("Spoken question", voice("Spoken answer"), new AbortController().signal);
    expect(ordinary.runTurn).toHaveBeenCalledTimes(1);
    const observing = await service.createSession("token:other-owner", {
      resumeFromId: created.sessionId,
      profile: "interactive",
    });
    expect(observing.eventCursor).toBeTypeOf("number");
    expect(
      observing.messages.some((message) =>
        message.parts.some((part) => part.kind === "text" && part.text === "Spoken answer"),
      ),
    ).toBe(true);
    expect(() =>
      service.sendMessage("token:fixture", created.sessionId, "Blocked while in voice"),
    ).toThrow("voice call");
    await realtime.close();
    await vi.waitFor(() =>
      expect(() =>
        service.sendMessage("token:fixture", created.sessionId, "Back to text"),
      ).not.toThrow(),
    );
    await vi.waitFor(() => expect(ordinary.runTurn).toHaveBeenCalledTimes(2));
    expect(
      inputs[1]?.history.some((message) =>
        message.parts.some((part) => part.kind === "text" && part.text === "Spoken answer"),
      ),
    ).toBe(true);
  });
  it("keeps a realtime-only context limit from making the ordinary text conversation read-only", async () => {
    const { service, ordinary } = fixture();
    const realtime = await service.openRealtimeSession("token:fixture", {});
    const exhausted: ChatBackend = {
      name: "smaller-voice-context",
      model: "voice-fixture",
      async *runTurn(input) {
        yield {
          type: "agent.message.end",
          payload: {
            sessionId: input.sessionId,
            messageId: input.messageId,
            stopReason: "error",
            failure: {
              code: "context_window_exceeded",
              message: "Voice context full",
              retryable: false,
              backend: "smaller-voice-context",
              model: "voice-fixture",
            },
          },
        };
      },
    };
    await realtime.run("Long spoken context", exhausted, new AbortController().signal);
    const snapshot = await service.createSession("token:fixture", {
      resumeFromId: realtime.sessionId,
    });
    expect(snapshot.terminalFailure).toBeUndefined();
    expect(snapshot.lastTurnFailure?.code).toBe("provider_error");
    expect(snapshot.lastTurnFailure?.provider?.code).toBe("context_window_exceeded");
    await expect(
      realtime.run("Retry voice", exhausted, new AbortController().signal),
    ).rejects.toThrow("context");
    await realtime.close();
    expect(() =>
      service.sendMessage(
        "token:fixture",
        realtime.sessionId,
        "Continue with the larger text model",
      ),
    ).not.toThrow();
    await vi.waitFor(() => expect(ordinary.runTurn).toHaveBeenCalledTimes(1));
  });
  it("retains permanent read-only protection for the default text model context limit", async () => {
    const { service, ordinary } = fixture();
    ordinary.runTurn.mockImplementation(async function* (input) {
      yield {
        type: "agent.message.end",
        payload: {
          sessionId: input.sessionId,
          messageId: input.messageId,
          stopReason: "error",
          failure: {
            code: "context_window_exceeded",
            message: "Text context full",
            retryable: false,
            backend: ordinary.name,
            model: ordinary.model,
          },
        },
      };
    });
    const created = await service.createSession("token:fixture", {});
    let terminal!: () => void;
    const seen = new Promise<void>((resolve) => {
      terminal = resolve;
    });
    const unsubscribe = service.subscribe("token:fixture", (_seq, event) => {
      if (event.type === "agent.message.end") terminal();
    });
    service.sendMessage("token:fixture", created.sessionId, "Long text context");
    await seen;
    expect(() => service.sendMessage("token:fixture", created.sessionId, "Retry text")).toThrow(
      "context",
    );
    const snapshot = await service.createSession("token:fixture", {
      resumeFromId: created.sessionId,
    });
    expect(snapshot.terminalFailure?.code).toBe("context_window_exceeded");
    unsubscribe();
  });
  it.each([false, true])(
    "accepts text after canonical voice terminal while persistence is pending (close during turn: %s)",
    async (closeDuringTurn) => {
      const { service, ordinary } = fixture();
      const realtime = await service.openRealtimeSession("token:fixture", {});
      let finishPersistence!: () => void;
      const pendingPersistence = new Promise<void>((resolve) => {
        finishPersistence = resolve;
      });
      const persistence = vi
        .spyOn(
          service as unknown as {
            persistAndNotify: (sessionId: string, messageId?: string) => Promise<void>;
          },
          "persistAndNotify",
        )
        .mockReturnValue(pendingPersistence);
      let terminal!: () => void;
      const terminalSeen = new Promise<void>((resolve) => {
        terminal = resolve;
      });
      const unsubscribe = realtime.subscribe((event) => {
        if (closeDuringTurn && event.type === "agent.text.delta") void realtime.close();
        if (event.type === "agent.message.end") terminal();
      });
      const turn = realtime.run(
        "Spoken question",
        voice("Spoken answer"),
        new AbortController().signal,
      );
      await terminalSeen;
      await realtime.close();
      expect(() =>
        service.sendMessage("token:fixture", realtime.sessionId, "Immediate text question"),
      ).not.toThrow();
      finishPersistence();
      await turn;
      await vi.waitFor(() => expect(ordinary.runTurn).toHaveBeenCalledTimes(1));
      unsubscribe();
      persistence.mockRestore();
    },
  );
  it("fails closed for an explicitly requested missing conversation unless legacy fallback is opted in", async () => {
    const { service } = fixture();
    await expect(
      service.openRealtimeSession("token:fixture", { conversationId: "missing-explicit-thread" }),
    ).rejects.toMatchObject({ code: "session_not_found" });
  });
  it("recovers only genuinely missing empty conversations and serializes competing voice leases", async () => {
    const { service } = fixture();
    const realtime = await service.openRealtimeSession("token:fixture", {
      conversationId: "missing-empty-thread",
      missingConversationPolicy: "create",
    });
    expect(realtime.sessionId).not.toBe("missing-empty-thread");
    await expect(
      service.openRealtimeSession("token:fixture", { conversationId: realtime.sessionId }),
    ).rejects.toThrow("busy");
    await expect(
      service.createSession("token:fixture", {
        resumeFromId: realtime.sessionId,
        profile: "voice",
      }),
    ).rejects.toThrow("voice call");
    await realtime.close();
  });
  it("cancels a transport turn through the canonical session and releases its lease after settlement", async () => {
    const { service, ordinary } = fixture();
    const realtime = await service.openRealtimeSession("token:fixture", {});
    let signal: AbortSignal | undefined;
    const backend: ChatBackend = {
      name: "socket",
      model: "gpt-realtime",
      async *runTurn(_input, abort) {
        signal = abort;
        await new Promise<void>((resolve) =>
          abort?.addEventListener("abort", () => resolve(), { once: true }),
        );
        yield {
          type: "agent.message.end",
          payload: { sessionId: "$SESSION", messageId: "$MSG", stopReason: "canceled" },
        } satisfies AgentEvent;
      },
    };
    const active = realtime.run("Spoken question", backend, new AbortController().signal);
    await vi.waitFor(() => expect(signal).toBeDefined());
    realtime.cancel();
    await active;
    await realtime.close();
    await vi.waitFor(async () =>
      expect(
        (await service.createSession("token:fixture", { resumeFromId: realtime.sessionId })).busy,
      ).toBe(false),
    );
    expect(signal?.aborted).toBe(true);
    expect(ordinary.runTurn).not.toHaveBeenCalled();
  });
});
