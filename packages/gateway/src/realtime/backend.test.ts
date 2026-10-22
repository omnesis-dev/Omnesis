// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentSession, type ChatBackend, type ToolHandle, type ToolContext } from "@omnesis/agent";
import { RealtimeBackend, realtimeHistoryItems } from "./backend.js";
import type { AgentEvent, RateLimitPatience } from "@omnesis/core";

function fixture(
  tool?: ToolHandle,
  onCancellationTimeout?: () => void,
  authorized: () => boolean = () => true,
  rateLimitPatience?: RateLimitPatience,
) {
  const sent: Array<Record<string, unknown>> = [];
  const backend = new RealtimeBackend(
    (event) => sent.push(event as Record<string, unknown>),
    authorized,
    onCancellationTimeout,
  );
  const normal: ChatBackend = {
    name: "text",
    model: "text",
    runTurn: vi.fn(() => {
      throw new Error("Ordinary model must never run");
    }),
  };
  const session = new AgentSession({
    sessionId: "fixture-thread",
    backend: normal,
    tools: tool ? [tool] : [],
    systemPrompt: "Core prompt",
    caller: { kind: "operator" },
    ...(rateLimitPatience ? { rateLimitPatience } : {}),
  });
  const events: AgentEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { sent, backend, normal, session, events };
}
function response(f: ReturnType<typeof fixture>, id: string) {
  f.backend.receive({ type: "response.created", response: { id } });
}
function done(f: ReturnType<typeof fixture>, id: string, status = "completed") {
  f.backend.receive({
    type: "response.done",
    response: { id, status, output: [] },
  });
}
describe("socket-backed canonical turns", () => {
  it.each([
    null,
    { type: null, reason: null, error: null },
    {
      type: "failed",
      reason: null,
      error: { code: null, type: "server_error", message: "PRIVATE_SENTINEL" },
    },
  ])("accepts nullable provider failure fields without exposing messages: %j", async (details) => {
    const f = fixture();
    const turn = f.session.send("Explain fictional inventory", { backend: f.backend });
    await vi.waitFor(() =>
      expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
    );
    response(f, "failed");
    f.backend.receive({
      type: "response.done",
      response: { id: "failed", status: "failed", status_details: details, output: [] },
    });
    await turn.completion;
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "agent.message.end",
        payload: expect.objectContaining({
          failure: expect.objectContaining({ code: "provider_error" }),
        }),
      }),
    );
    expect(JSON.stringify(f.events)).not.toContain("PRIVATE_SENTINEL");
    await f.session.dispose();
  });
  it("bounds repeated rate-limit failures and reports the canonical rate_limited code", async () => {
    const f = fixture();
    const turn = f.session.send("Explain fictional inventory", { backend: f.backend });
    const requests = () => f.sent.filter((event) => event.type === "response.create");
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    vi.useFakeTimers();
    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        response(f, `limited-${attempt}`);
        f.backend.receive({
          type: "response.done",
          response: {
            id: `limited-${attempt}`,
            status: "failed",
            status_details: { error: { code: "rate_limit_exceeded", type: "tokens" } },
            output: [],
          },
        });
        await vi.advanceTimersByTimeAsync(25000);
      }
      await turn.completion;
      expect(requests()).toHaveLength(3);
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: "agent.message.end",
          payload: expect.objectContaining({
            failure: expect.objectContaining({ code: "rate_limited", retryable: true }),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
      await f.session.dispose();
    }
  });
  it.each(["answer", "cancel", "dispose", "explicit_zero_patience"])(
    "honors production voice patience and immediate %s during a 25-second refill",
    async (action) => {
      const f = fixture(
        undefined,
        undefined,
        () => true,
        action === "explicit_zero_patience" ? { maxTotalDelayMs: 0 } : undefined,
      );
      const first = f.session.send("Fictional inventory", { backend: f.backend });
      await vi.waitFor(() =>
        expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
      );
      response(f, "first");
      f.backend.receive({
        type: "response.done",
        response: {
          id: "first",
          status: "completed",
          output: [],
          usage: { input_tokens: 100000, output_tokens: 0 },
        },
      });
      await first.completion;
      vi.useFakeTimers();
      try {
        f.backend.receive({
          type: "rate_limits.updated",
          rate_limits: [{ name: "tokens", limit: 200000, remaining: 0, reset_seconds: 50 }],
        });
        const second = f.session.send("Fictional inventory", { backend: f.backend });
        await vi.advanceTimersByTimeAsync(15000);
        expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(
          action === "explicit_zero_patience" ? 2 : 1,
        );
        if (action === "cancel" || action === "dispose") {
          if (action === "cancel") f.session.cancel();
          else await f.backend.dispose();
          await second.completion;
          expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
          return;
        }
        await vi.advanceTimersByTimeAsync(15000);
        expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(2);
        response(f, "second");
        done(f, "second");
        await second.completion;
      } finally {
        vi.useRealTimers();
        await f.session.dispose();
      }
    },
  );
  it("retries only an empty rate-limited response with identical completed tool context", async () => {
    const invoke = vi.fn(async () => ({
      kind: "structured" as const,
      resultType: "fixture.inventory",
      data: { count: 24 },
    }));
    const f = fixture({
      name: "fixture_tool",
      description: "fixture",
      schema: z.object({}),
      invoke,
    });
    const turn = f.session.send("Count fictional workshop supplies", { backend: f.backend });
    const requests = () => f.sent.filter((event) => event.type === "response.create");
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    response(f, "lookup");
    f.backend.receive({
      type: "response.function_call_arguments.done",
      response_id: "lookup",
      call_id: "inventory-call",
      name: "fixture_tool",
      arguments: "{}",
    });
    done(f, "lookup");
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    response(f, "limited");
    vi.useFakeTimers();
    try {
      f.backend.receive({
        type: "response.done",
        response: {
          id: "limited",
          status: "failed",
          status_details: { error: { code: "rate_limit_exceeded", type: "tokens" } },
          output: [],
        },
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(requests()).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1101);
      expect(requests()).toHaveLength(3);
      expect(requests()[2]).toEqual(requests()[1]);
      response(f, "limited-again");
      f.backend.receive({
        type: "response.done",
        response: {
          id: "limited-again",
          status: "failed",
          status_details: { error: { code: "rate_limit_exceeded", type: "tokens" } },
          output: [],
        },
      });
      await vi.advanceTimersByTimeAsync(19999);
      expect(requests()).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(2101);
      expect(requests()).toHaveLength(4);
      expect(requests()[3]).toEqual(requests()[1]);
      response(f, "answer");
      f.backend.receive({
        type: "response.output_audio.delta",
        response_id: "answer",
        delta: "AAAA",
      });
      f.backend.receive({
        type: "response.output_audio_transcript.delta",
        response_id: "answer",
        delta: "There are 24 supplies.",
      });
      done(f, "answer");
      await turn.completion;
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: "agent.message.end",
          payload: expect.objectContaining({ stopReason: "end_turn" }),
        }),
      );
    } finally {
      vi.useRealTimers();
      await f.session.dispose();
    }
  });
  it.each(["cancel", "revoke"])(
    "does not send a delayed rate-limit retry after %s",
    async (action) => {
      let authorized = true;
      const f = fixture(undefined, undefined, () => authorized);
      const turn = f.session.send("Explain fictional inventory", { backend: f.backend });
      await vi.waitFor(() =>
        expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
      );
      response(f, "limited");
      vi.useFakeTimers();
      try {
        f.backend.receive({
          type: "response.done",
          response: {
            id: "limited",
            status: "failed",
            status_details: { error: { code: "rate_limit_exceeded" } },
            output: [],
          },
        });
        await vi.advanceTimersByTimeAsync(1);
        if (action === "cancel") f.session.cancel();
        else authorized = false;
        await vi.advanceTimersByTimeAsync(20000);
        await turn.completion;
        expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        await f.session.dispose();
      }
    },
  );
  it.each(["server_error", "credit_balance_exhausted", "insufficient_quota", "partial_rate_limit"])(
    "does not retry %s failures",
    async (code) => {
      const f = fixture();
      const turn = f.session.send("Explain fictional inventory", { backend: f.backend });
      await vi.waitFor(() =>
        expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
      );
      response(f, "failed");
      if (code === "partial_rate_limit")
        f.backend.receive({
          type: "response.output_audio.delta",
          response_id: "failed",
          delta: "AAAA",
        });
      f.backend.receive({
        type: "response.done",
        response: {
          id: "failed",
          status: "failed",
          status_details: {
            error: { code: code === "partial_rate_limit" ? "rate_limit_exceeded" : code },
          },
          output: [],
        },
      });
      await turn.completion;
      expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
      if (code.includes("quota") || code.includes("credit"))
        expect(f.events).toContainEqual(
          expect.objectContaining({
            type: "agent.message.end",
            payload: expect.objectContaining({
              failure: expect.objectContaining({ retryable: false }),
            }),
          }),
        );
      await f.session.dispose();
    },
  );
  it.each([undefined, "PRIVATE_SENTINEL", "rate_limit_exceeded"])(
    "never retries quota type evidence with code %s",
    async (code) => {
      const f = fixture();
      const turn = f.session.send("Explain fictional inventory", { backend: f.backend });
      await vi.waitFor(() =>
        expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
      );
      response(f, "quota");
      f.backend.receive({
        type: "response.done",
        response: {
          id: "quota",
          status: "failed",
          output: [],
          status_details: { error: { code, type: "insufficient_quota" } },
        },
      });
      await turn.completion;
      expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: "agent.message.end",
          payload: expect.objectContaining({
            failure: expect.objectContaining({
              code: "provider_error",
              retryable: false,
              message:
                "The provider API credit or quota is exhausted. Check billing or limits before trying again.",
              provider: expect.objectContaining({ type: "insufficient_quota" }),
            }),
          }),
        }),
      );
      expect(JSON.stringify(f.events)).not.toContain("PRIVATE_SENTINEL");
      await f.session.dispose();
    },
  );
  it("retains allowlisted provider failure codes and types without retaining error messages", async () => {
    const f = fixture();
    const turn = f.session.send("Explain the fictional workshop guide", { backend: f.backend });
    await vi.waitFor(() =>
      expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
    );
    response(f, "failed-response");
    f.backend.receive({
      type: "response.done",
      response: {
        id: "failed-response",
        status: "failed",
        status_details: {
          type: "failed",
          error: { code: "server_error", type: "server_error", message: "PRIVATE_SENTINEL" },
        },
        output: [],
      },
    });
    await turn.completion;
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "agent.message.end",
        payload: expect.objectContaining({
          failure: expect.objectContaining({
            code: "provider_error",
            provider: { code: "server_error", type: "server_error" },
          }),
        }),
      }),
    );
    expect(JSON.stringify(f.events)).not.toContain("PRIVATE_SENTINEL");
    await f.session.dispose();
  });
  it.each(["cancelled", "failed", undefined])(
    "does not continue commentary from a %s response",
    async (status) => {
      const f = fixture();
      const turn = f.session.send("Explain the fictional workshop guide", { backend: f.backend });
      await vi.waitFor(() =>
        expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
      );
      response(f, "terminal");
      f.backend.receive({
        type: "response.done",
        response: {
          id: "terminal",
          ...(status === undefined ? {} : { status }),
          output: [{ type: "message", id: "commentary-item", phase: "commentary" }],
        },
      });
      await turn.completion;
      expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
      await f.session.dispose();
    },
  );
  it("adds focused voice guidance without replacing the canonical prompt or tool inventory", async () => {
    const f = fixture();
    const configuration = f.backend.configuration({
      systemPrompt: "Canonical core instructions",
      tools: [],
      history: [],
    });
    expect(configuration.instructions).toMatch(/^Canonical core instructions\n\n## Live voice/);
    for (const section of [
      "Language",
      "Preambles",
      "Tools and answers",
      "Verbosity and reasoning",
      "Unclear audio",
    ])
      expect(configuration.instructions).toContain(`## ${section}`);
    expect(configuration.instructions).toContain("Batch independent lookups");
    expect(configuration.instructions).toContain("Stop retrieving once there is enough evidence");
    expect(configuration.instructions).toContain("one to three short sentences");
    expect(configuration.instructions).toContain("at most one brief acknowledgement");
    expect(configuration.instructions).toContain("run the lookup silently");
    expect(configuration.tools).toEqual([]);
    await f.session.dispose();
  });

  it("preserves provider commentary references in order with canonical tool calls and outputs", async () => {
    const invoke = vi.fn(async () => ({
      kind: "structured" as const,
      resultType: "fixture.guide",
      data: { summary: "Blue labels identify workshop supplies." },
    }));
    const f = fixture({
      name: "fixture_tool",
      description: "fixture",
      schema: z.object({}),
      invoke,
    });
    const turn = f.session.send("Explain the fictional workshop guide", { backend: f.backend });
    const requests = () => f.sent.filter((event) => event.type === "response.create");
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    response(f, "lookup");
    f.backend.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "lookup",
      delta: "I am checking the guide.",
    });
    f.backend.receive({
      type: "response.function_call_arguments.done",
      response_id: "lookup",
      call_id: "guide-call",
      name: "fixture_tool",
      arguments: "{}",
    });
    f.backend.receive({
      type: "response.done",
      response: {
        id: "lookup",
        status: "completed",
        output: [
          { type: "message", id: "preamble-item", role: "assistant", phase: "commentary" },
          { type: "function_call", call_id: "guide-call", name: "fixture_tool", arguments: "{}" },
        ],
      },
    });
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    const input = (requests()[1].response as { input: Array<Record<string, unknown>> }).input;
    expect(input.slice(-3)).toEqual([
      { type: "item_reference", id: "preamble-item" },
      { type: "function_call", call_id: "guide-call", name: "fixture_tool", arguments: "{}" },
      expect.objectContaining({ type: "function_call_output", call_id: "guide-call" }),
    ]);
    expect(JSON.stringify(input)).not.toContain("I am checking the guide.");
    expect(requests()[1].response).not.toHaveProperty("tool_choice");
    response(f, "answer");
    f.backend.receive({
      type: "response.output_audio.delta",
      response_id: "answer",
      delta: "AAAA",
    });
    f.backend.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "answer",
      delta: "Blue labels identify workshop supplies.",
    });
    f.backend.receive({
      type: "response.done",
      response: {
        id: "answer",
        status: "completed",
        output: [{ type: "message", id: "answer-item", phase: "final_answer" }],
      },
    });
    await turn.completion;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "agent.message.end",
        payload: expect.objectContaining({ stopReason: "end_turn" }),
      }),
    );
    expect(JSON.stringify(f.session.historySnapshot())).toContain(
      "Blue labels identify workshop supplies.",
    );
    await f.session.dispose();
  });
  it("ends a response containing commentary and a final answer without another response", async () => {
    const f = fixture();
    const turn = f.session.send("Explain the fictional workshop guide", { backend: f.backend });
    await vi.waitFor(() =>
      expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
    );
    response(f, "mixed");
    f.backend.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "mixed",
      delta: "Blue labels identify workshop supplies.",
    });
    f.backend.receive({
      type: "response.done",
      response: {
        id: "mixed",
        status: "completed",
        output: [
          { type: "message", id: "commentary-item", phase: "commentary" },
          { type: "message", id: "final-item", phase: "final_answer" },
        ],
      },
    });
    await turn.completion;
    expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
    await f.session.dispose();
  });
  it("bounds commentary-only continuations with a canonical failure", async () => {
    const f = fixture();
    const turn = f.session.send("Explain the fictional workshop guide", { backend: f.backend });
    for (let index = 0; index < 50; index += 1) {
      await vi.waitFor(
        () =>
          expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(
            index + 1,
          ),
        { interval: 1 },
      );
      const id = `commentary-${index}`;
      response(f, id);
      f.backend.receive({
        type: "response.output_audio_transcript.delta",
        response_id: id,
        delta: "I am checking.",
      });
      f.backend.receive({
        type: "response.done",
        response: {
          id,
          status: "completed",
          output: [{ type: "message", id: `item-${index}`, phase: "commentary" }],
        },
      });
    }
    await turn.completion;
    expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(50);
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "agent.message.end",
        payload: expect.objectContaining({
          stopReason: "error",
          failure: expect.objectContaining({ code: "provider_error" }),
        }),
      }),
    );
    await f.session.dispose();
  });

  it("continues provider commentary with its original item reference until a final answer", async () => {
    const f = fixture();
    const turn = f.session.send("Explain the fictional workshop guide", { backend: f.backend });
    const requests = () => f.sent.filter((event) => event.type === "response.create");
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    response(f, "commentary-response");
    f.backend.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "commentary-response",
      delta: "I am checking the guide.",
    });
    f.backend.receive({
      type: "response.done",
      response: {
        id: "commentary-response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "commentary-item",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_audio", transcript: "I am checking the guide." }],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    expect(requests()[1].response).toEqual(
      expect.objectContaining({
        input: expect.arrayContaining([{ type: "item_reference", id: "commentary-item" }]),
      }),
    );
    response(f, "final-response");
    f.backend.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "final-response",
      delta: "The guide uses blue labels.",
    });
    f.backend.receive({
      type: "response.done",
      response: {
        id: "final-response",
        status: "completed",
        output: [
          {
            type: "message",
            id: "final-item",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_audio", transcript: "The guide uses blue labels." }],
          },
        ],
      },
    });
    await turn.completion;
    expect(requests()).toHaveLength(2);
    await f.session.dispose();
  });
  it.each(["cancelled", "failed", "unknown", undefined])(
    "does not recover a post-tool response with status %s",
    async (status) => {
      const f = fixture({
        name: "fixture_tool",
        description: "fixture",
        schema: z.object({}),
        invoke: async () => ({ kind: "structured", resultType: "fixture", data: {} }),
      });
      const turn = f.session.send("Explain the fictional workshop guide", { backend: f.backend });
      const requests = () => f.sent.filter((event) => event.type === "response.create");
      await vi.waitFor(() => expect(requests()).toHaveLength(1));
      response(f, "lookup");
      f.backend.receive({
        type: "response.function_call_arguments.done",
        response_id: "lookup",
        call_id: "lookup-call",
        name: "fixture_tool",
        arguments: "{}",
      });
      done(f, "lookup");
      await vi.waitFor(() => expect(requests()).toHaveLength(2));
      response(f, "terminal");
      f.backend.receive({
        type: "response.done",
        response: { id: "terminal", ...(status === undefined ? {} : { status }), output: [] },
      });
      await turn.completion;
      expect(requests()).toHaveLength(2);
      await f.session.dispose();
    },
  );

  it.each(["audio", "transcript", "explicit_final_transcript"])(
    "does not replay an answer that already has %s output",
    async (output) => {
      const f = fixture({
        name: "fixture_tool",
        description: "fixture",
        schema: z.object({}),
        invoke: async () => ({
          kind: "structured",
          resultType: "fixture",
          data: {},
        }),
      });
      const turn = f.session.send("Explain the fictional workshop guide", {
        backend: f.backend,
      });
      const requests = () => f.sent.filter((event) => event.type === "response.create");
      await vi.waitFor(() => expect(requests()).toHaveLength(1));
      response(f, "lookup");
      f.backend.receive({
        type: "response.function_call_arguments.done",
        response_id: "lookup",
        call_id: "lookup-call",
        name: "fixture_tool",
        arguments: "{}",
      });
      done(f, "lookup");
      await vi.waitFor(() => expect(requests()).toHaveLength(2));
      response(f, "answer");
      f.backend.receive({
        type:
          output === "audio"
            ? "response.output_audio.delta"
            : "response.output_audio_transcript.delta",
        response_id: "answer",
        delta: output === "audio" ? "AAAA" : "The guide uses blue labels.",
      });
      if (output === "explicit_final_transcript")
        f.backend.receive({
          type: "response.done",
          response: {
            id: "answer",
            status: "completed",
            output: [{ type: "message", id: "text-only-final", phase: "final_answer" }],
          },
        });
      else done(f, "answer");
      await turn.completion;
      expect(requests()).toHaveLength(2);
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: "agent.message.end",
          payload: expect.objectContaining(
            output === "explicit_final_transcript"
              ? {
                  stopReason: "error",
                  failure: expect.objectContaining({ code: "provider_error", retryable: true }),
                }
              : { stopReason: "end_turn" },
          ),
        }),
      );
      await f.session.dispose();
    },
  );
  it("does not retry an empty initial answer", async () => {
    const f = fixture();
    const turn = f.session.send("Hello", { backend: f.backend });
    await vi.waitFor(() => expect(f.sent.some((e) => e.type === "response.create")).toBe(true));
    response(f, "initial");
    done(f, "initial");
    await turn.completion;
    expect(f.sent.filter((e) => e.type === "response.create")).toHaveLength(1);
    await f.session.dispose();
  });
  it.each([
    "empty",
    "commentary",
    "cancelled",
    "failed",
    "unexpected_tool",
    "unexpected_done_tool",
  ])("settles %s recovery without another tool execution or recovery loop", async (outcome) => {
    const invoke = vi.fn(async () => ({
      kind: "structured" as const,
      resultType: "fixture",
      data: {},
    }));
    const f = fixture({
      name: "fixture_tool",
      description: "fixture",
      schema: z.object({}),
      invoke,
    });
    const turn = f.session.send("Explain the fictional workshop guide", {
      backend: f.backend,
    });
    const requests = () => f.sent.filter((event) => event.type === "response.create");
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    response(f, "lookup");
    f.backend.receive({
      type: "response.function_call_arguments.done",
      response_id: "lookup",
      call_id: "lookup-call",
      name: "fixture_tool",
      arguments: "{}",
    });
    done(f, "lookup");
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    response(f, "silent");
    done(f, "silent");
    await vi.waitFor(() => expect(requests()).toHaveLength(3));
    expect(requests()[2].response).toEqual(expect.objectContaining({ tool_choice: "none" }));
    response(f, "recovery");
    if (outcome === "unexpected_tool")
      f.backend.receive({
        type: "response.function_call_arguments.done",
        response_id: "recovery",
        call_id: "new-call",
        name: "fixture_tool",
        arguments: "{}",
      });
    if (outcome.startsWith("unexpected") || outcome === "commentary")
      f.backend.receive({
        type: "response.output_audio.delta",
        response_id: "recovery",
        delta: "AAAA",
      });
    if (outcome === "commentary")
      f.backend.receive({
        type: "response.done",
        response: {
          id: "recovery",
          status: "completed",
          output: [{ type: "message", id: "recovery-commentary", phase: "commentary" }],
        },
      });
    else if (outcome === "unexpected_done_tool")
      f.backend.receive({
        type: "response.done",
        response: {
          id: "recovery",
          status: "completed",
          output: [
            { type: "function_call", call_id: "new-call", name: "fixture_tool", arguments: "{}" },
          ],
        },
      });
    else
      done(f, "recovery", outcome === "cancelled" || outcome === "failed" ? outcome : "completed");
    await turn.completion;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(requests()).toHaveLength(3);
    if (outcome.startsWith("unexpected"))
      expect(f.events).not.toContainEqual(
        expect.objectContaining({
          type: "agent.message.end",
          payload: expect.objectContaining({ stopReason: "end_turn" }),
        }),
      );
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "agent.message.end",
        payload: expect.objectContaining({
          stopReason: outcome === "cancelled" ? "canceled" : "error",
        }),
      }),
    );
    await f.session.dispose();
  });

  it("recovers one silent completion after a tool without executing that tool again", async () => {
    const invoke = vi.fn(async () => ({
      kind: "structured" as const,
      resultType: "fixture.guide",
      data: { summary: "The fictional workshop guide uses blue labels." },
    }));
    const f = fixture({
      name: "fixture_tool",
      description: "fixture",
      schema: z.object({}),
      invoke,
    });
    const turn = f.session.send("Explain the workshop guide", {
      backend: f.backend,
    });
    const requests = () => f.sent.filter((event) => event.type === "response.create");
    await vi.waitFor(() => expect(requests()).toHaveLength(1));
    response(f, "lookup");
    f.backend.receive({
      type: "response.function_call_arguments.done",
      response_id: "lookup",
      call_id: "guide-call",
      name: "fixture_tool",
      arguments: "{}",
    });
    done(f, "lookup");
    await vi.waitFor(() => expect(requests()).toHaveLength(2));
    response(f, "silent");
    done(f, "silent");
    await vi.waitFor(() => expect(requests()).toHaveLength(3));
    response(f, "answer");
    f.backend.receive({
      type: "response.output_audio.delta",
      response_id: "answer",
      delta: "AAAA",
    });
    f.backend.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "answer",
      delta: "The guide uses blue labels.",
    });
    done(f, "answer");
    await turn.completion;
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.session.historySnapshot())).toContain("The guide uses blue labels.");
    expect(f.normal.runTurn).not.toHaveBeenCalled();
    await f.session.dispose();
  });
  it.each([
    ["failed", { error: { code: "context_length_exceeded" } }, "provider_error", "error"],
    ["incomplete", { reason: "max_output_tokens" }, "output_truncated", "max_tokens"],
  ])(
    "preserves canonical failure semantics for %s responses",
    async (status, status_details, code, stopReason) => {
      const f = fixture();
      const turn = f.session.send("Spoken question", { backend: f.backend });
      await vi.waitFor(() =>
        expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
      );
      response(f, "failed-response");
      f.backend.receive({
        type: "response.done",
        response: { id: "failed-response", status, status_details, output: [] },
      });
      await turn.completion;
      expect(f.events).toContainEqual(
        expect.objectContaining({
          type: "agent.message.end",
          payload: expect.objectContaining({
            stopReason,
            failure: expect.objectContaining({ code, model: "gpt-realtime-2.1" }),
          }),
        }),
      );
      await f.session.dispose();
    },
  );
  it("bounds cancellation settlement when the provider never acknowledges cancellation", async () => {
    const timeout = vi.fn();
    const f = fixture(undefined, timeout);
    const turn = f.session.send("Spoken question", { backend: f.backend });
    await vi.waitFor(() =>
      expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
    );
    response(f, "unacknowledged");
    vi.useFakeTimers();
    try {
      f.session.cancel();
      await turn.completion;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(timeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(timeout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      await f.backend.dispose();
      await f.session.dispose();
    }
  });
  it("seeds canonical text and tool history using the GA wire types and shared result serializer", async () => {
    const f = fixture();
    const items = realtimeHistoryItems([
      { role: "user", parts: [{ kind: "text", text: "Earlier question" }] },
      {
        role: "assistant",
        parts: [
          { kind: "text", text: "Earlier answer" },
          { kind: "tool_use", toolCallId: "call-1", tool: "fixture_tool", args: {} },
        ],
      },
      {
        role: "user",
        parts: [
          {
            kind: "tool_result",
            toolCallId: "call-1",
            result: { kind: "error", code: "fixture", message: "Fixture result" },
          },
        ],
      },
    ]);
    expect(items).toContainEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Earlier answer" }],
    });
    expect(items).toContainEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Earlier question" }],
    });
    expect(items).toContainEqual(
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call-1",
        output: expect.stringContaining("Fixture result"),
      }),
    );
    await f.session.dispose();
  });
  it("waits for canceled response settlement and rejects old response deltas/functions on the next turn", async () => {
    const invoke = vi.fn(async () => ({
      kind: "error" as const,
      code: "fixture",
      message: "fixture",
    }));
    const f = fixture({
      name: "fixture_tool",
      description: "fixture",
      schema: z.object({}),
      invoke,
    });
    const first = f.session.send("First spoken question", { backend: f.backend });
    await vi.waitFor(() =>
      expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(1),
    );
    response(f, "old-response");
    f.session.cancel();
    await first.completion;
    const second = f.session.send("Second spoken question", { backend: f.backend });
    expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
    done(f, "old-response", "cancelled");
    await vi.waitFor(() =>
      expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(2),
    );
    response(f, "new-response");
    f.backend.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "old-response",
      delta: "Stale text",
    });
    f.backend.receive({
      type: "response.function_call_arguments.done",
      response_id: "old-response",
      call_id: "old-call",
      name: "fixture_tool",
      arguments: "{}",
    });
    done(f, "old-response", "cancelled");
    f.backend.receive({
      type: "response.output_audio_transcript.delta",
      response_id: "new-response",
      delta: "Current answer",
    });
    done(f, "new-response");
    await second.completion;
    expect(invoke).not.toHaveBeenCalled();
    expect(JSON.stringify(f.session.historySnapshot())).not.toContain("Stale text");
    expect(JSON.stringify(f.session.historySnapshot())).toContain("Current answer");
    expect(f.normal.runTurn).not.toHaveBeenCalled();
    await f.session.dispose();
  });
  it("aborts tool context and suppresses late tool completions and duplicated provider calls", async () => {
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    const invoke = vi.fn(async (_args: unknown, context: ToolContext) => {
      signal = context.abortSignal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { kind: "error" as const, code: "fixture", message: "Late result" };
    });
    const f = fixture({
      name: "fixture_write",
      description: "fixture",
      schema: z.object({}),
      mutates: true,
      invoke,
    });
    const turn = f.session.send("Spoken action", { backend: f.backend });
    await vi.waitFor(() =>
      expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
    );
    response(f, "response");
    const call = {
      type: "response.function_call_arguments.done",
      response_id: "response",
      call_id: "same-call",
      name: "fixture_write",
      arguments: "{}",
    };
    f.backend.receive(call);
    f.backend.receive(call);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    f.session.cancel();
    await turn.completion;
    expect(signal?.aborted).toBe(true);
    const count = f.sent.length;
    const canonicalResults = f.events.filter((event) => event.type === "agent.tool.result").length;
    f.backend.receive({ ...call, call_id: "late-call" });
    finish();
    await vi.waitFor(() => expect(f.session.busy).toBe(false));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(f.sent).toHaveLength(count);
    expect(f.events.filter((event) => event.type === "agent.tool.result")).toHaveLength(
      canonicalResults,
    );
    expect(JSON.stringify(f.events)).not.toContain("Late result");
    await f.session.dispose();
  });
  it("uses canonical balanced history and only the current committed audio reference after interrupted tools", async () => {
    let signal: AbortSignal | undefined;
    const invoke = vi.fn(async (_args: unknown, context: ToolContext) => {
      signal = context.abortSignal;
      await new Promise<void>((resolve) =>
        context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { kind: "error" as const, code: "fixture", message: "Stopped" };
    });
    const f = fixture({
      name: "fixture_tool",
      description: "fixture",
      schema: z.object({}),
      invoke,
    });
    f.backend.useInputItem("first-audio");
    const first = f.session.send("First question", { backend: f.backend });
    await vi.waitFor(() =>
      expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
    );
    response(f, "first-response");
    f.backend.receive({
      type: "response.function_call_arguments.done",
      response_id: "first-response",
      call_id: "pending-call",
      name: "fixture_tool",
      arguments: "{}",
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    f.session.cancel();
    await first.completion;
    done(f, "first-response", "cancelled");
    f.backend.useInputItem("second-audio");
    const second = f.session.send("Second question", { backend: f.backend });
    await vi.waitFor(() =>
      expect(f.sent.filter((event) => event.type === "response.create")).toHaveLength(2),
    );
    const request = f.sent.filter((event) => event.type === "response.create").at(-1)!.response as {
      input: Array<Record<string, unknown>>;
    };
    expect(request.input).toContainEqual({ type: "item_reference", id: "second-audio" });
    expect(
      request.input.some((item) => item.type === "item_reference" && item.id === "future-audio"),
    ).toBe(false);
    expect(request.input).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "pending-call" }),
    );
    expect(request.input).toContainEqual(
      expect.objectContaining({
        type: "function_call_output",
        call_id: "pending-call",
        output: expect.stringContaining("turn_aborted"),
      }),
    );
    f.session.cancel();
    await second.completion;
    await f.session.dispose();
  });
  it("responds to malformed JSON with the ordinary parse error and never executes the handle", async () => {
    const invoke = vi.fn(async () => ({
      kind: "error" as const,
      code: "fixture",
      message: "fixture",
    }));
    const f = fixture({
      name: "fixture_tool",
      description: "fixture",
      schema: z.object({}),
      invoke,
    });
    const turn = f.session.send("Spoken question", { backend: f.backend });
    await vi.waitFor(() =>
      expect(f.sent.some((event) => event.type === "response.create")).toBe(true),
    );
    response(f, "response");
    f.backend.receive({
      type: "response.function_call_arguments.done",
      response_id: "response",
      call_id: "broken",
      name: "fixture_tool",
      arguments: "{",
    });
    done(f, "response");
    await vi.waitFor(() =>
      expect(f.events.some((event) => event.type === "agent.tool.result")).toBe(true),
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(f.events).toContainEqual(
      expect.objectContaining({
        type: "agent.tool.result",
        payload: expect.objectContaining({
          result: expect.objectContaining({ kind: "error", code: "tool_args_unparseable" }),
        }),
      }),
    );
    f.session.cancel();
    await turn.completion;
    await f.session.dispose();
  });
});
