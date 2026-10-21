// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentSession, type ChatBackend, type ToolHandle, type ToolContext } from "@omnesis/agent";
import { RealtimeBackend, realtimeHistoryItems } from "./backend.js";
import type { AgentEvent } from "@omnesis/core";

function fixture(tool?: ToolHandle, onCancellationTimeout?: () => void) {
  const sent: Array<Record<string, unknown>> = [];
  const backend = new RealtimeBackend(
    (event) => sent.push(event as Record<string, unknown>),
    () => true,
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
  });
  const events: AgentEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { sent, backend, normal, session, events };
}
function response(f: ReturnType<typeof fixture>, id: string) {
  f.backend.receive({ type: "response.created", response: { id } });
}
function done(f: ReturnType<typeof fixture>, id: string, status = "completed") {
  f.backend.receive({ type: "response.done", response: { id, status, output: [] } });
}
describe("socket-backed canonical turns", () => {
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
