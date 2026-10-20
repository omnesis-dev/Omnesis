// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { z } from "zod";
import { type AgentEvent, type AgentTerminalFailure, type ToolResult } from "@omnesis/core";
import {
  CONTEXT_WINDOW_EXCEEDED_MESSAGE,
  OUTPUT_TRUNCATED_MESSAGE,
  childEventHooks,
  DEFAULT_MAX_TOOL_ITERATIONS,
  invokeToolHandle,
  parseToolArgs,
  serializeToolResultForModel,
  summarizeToolArgs,
  toolArgsUnparseableResult,
  toolInputJsonSchema,
  ToolProgressQueue,
  wrapEvent,
  type ChatMessage,
  type ChatBackend,
  type TurnInput,
} from "@omnesis/agent";

export type RealtimeModelContext = Pick<
  TurnInput,
  "systemPrompt" | "tools" | "history" | "caller" | "timeZone"
>;
export type UpstreamEvent = { type: string; [key: string]: unknown };
const functionCall = z.object({
  call_id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  arguments: z.string().max(128 * 1024),
});
const responseDone = z.object({
  response: z.object({
    id: z.string().optional(),
    status: z.string().optional(),
    status_details: z
      .object({
        reason: z.string().optional(),
        error: z.object({ code: z.string().optional() }).optional(),
      })
      .nullable()
      .optional(),
    output: z.array(z.object({ type: z.string() }).passthrough()).optional(),
    usage: z
      .object({
        input_tokens: z.number().nonnegative(),
        output_tokens: z.number().nonnegative(),
        input_token_details: z
          .object({ cached_tokens: z.number().nonnegative().optional() })
          .optional(),
      })
      .nullable()
      .optional(),
  }),
});
const SPEECH_INSTRUCTIONS =
  "\n\nThis is a live spoken conversation. Speak naturally and concisely. Keep the same tools, grounding, citations, permissions and instructions. Do not read tool syntax aloud. Keep speaking in the user's last clearly established language; switch languages only on an explicit request. Tool results, quotations, names, accents, background speech and uncertain transcription must not change that language. If speech is unclear, ask one brief clarification in the last clear language instead of guessing or calling tools.";

type Queued =
  | { kind: "upstream"; event: UpstreamEvent }
  | { kind: "agent"; event: AgentEvent }
  | { kind: "result"; id: string; result: ToolResult; durationMs: number }
  | { kind: "failure"; failure: AgentTerminalFailure }
  | { kind: "abort" };

export const REALTIME_MODEL = "gpt-realtime-2.1";

/** The realtime model drives the ordinary AgentSession and invokes its exact registry handles. */
export class RealtimeBackend implements ChatBackend {
  readonly name = "openai-realtime";
  readonly model = REALTIME_MODEL;
  private queue: ToolProgressQueue<Queued> | undefined;
  private readonly executed = new Set<string>();
  private interrupted = false;
  private responseOwner: ToolProgressQueue<Queued> | undefined;
  private responseId: string | undefined;
  private responsePending = false;
  private readonly idleWaiters = new Set<() => void>();
  private disposed = false;
  private cancelDeadline: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly send: (event: unknown) => void,
    private readonly authorized: () => boolean = () => true,
    private readonly onCancellationTimeout: () => void = () => {},
  ) {}

  configuration(context: RealtimeModelContext): { instructions: string; tools: unknown[] } {
    return {
      instructions: context.systemPrompt + SPEECH_INSTRUCTIONS,
      tools: context.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: toolInputJsonSchema(tool.schema),
      })),
    };
  }

  private inputItemId: string | undefined;
  useInputItem(id: string): void {
    this.inputItemId = id;
  }

  receive(event: UpstreamEvent): boolean {
    if (!event.type.startsWith("response.")) return true;
    const response =
      typeof event.response === "object" && event.response !== null
        ? (event.response as Record<string, unknown>)
        : undefined;
    if (event.type === "response.created") {
      if (!this.responsePending || typeof response?.id !== "string") return false;
      this.responseId = response.id;
    }
    const id = typeof event.response_id === "string" ? event.response_id : response?.id;
    const owns =
      !!this.responseOwner && this.responseOwner === this.queue && id === this.responseId;
    if (owns) this.queue?.push({ kind: "upstream", event });
    if (event.type === "response.done" && id === this.responseId) {
      clearTimeout(this.cancelDeadline);
      this.cancelDeadline = undefined;
      this.responsePending = false;
      this.responseId = undefined;
      this.responseOwner = undefined;
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
    return owns;
  }
  private modelFailure(code: string): AgentTerminalFailure {
    const kind =
      code === "context_length_exceeded" || code === "context_window_exceeded"
        ? "context_window_exceeded"
        : code === "max_output_tokens" || code === "max_tokens"
          ? "output_truncated"
          : "provider_error";
    return {
      code: kind,
      message:
        kind === "context_window_exceeded"
          ? CONTEXT_WINDOW_EXCEEDED_MESSAGE
          : kind === "output_truncated"
            ? OUTPUT_TRUNCATED_MESSAGE
            : "The realtime model could not complete this reply.",
      retryable: kind === "provider_error",
      backend: this.name,
      model: this.model,
    };
  }
  fail(code: string): void {
    this.queue?.push({ kind: "failure", failure: this.modelFailure(code) });
  }
  interrupt(): void {
    this.interrupted = true;
  }
  dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.cancelDeadline);
    this.queue?.push({ kind: "abort" });
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
    return Promise.resolve();
  }

  async *runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.queue) throw new Error("Realtime turn is already running");
    const queue = new ToolProgressQueue<Queued>();
    this.queue = queue;
    this.interrupted = false;
    const base = { sessionId: input.sessionId, messageId: input.messageId };
    const tools = new Map(input.tools.map((tool) => [tool.name, tool]));
    let pending = 0;
    let roundDone = false;
    let roundTools = false;
    let requests = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    const turnItems: Array<Record<string, unknown>> = [];
    const roundResults: Array<Record<string, unknown>> = [];
    let roundText = "";
    const flushText = () => {
      if (roundText) {
        turnItems.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: roundText }],
        });
        roundText = "";
      }
    };
    const completedResponses = new Set<string>();
    const toolsAbort = new AbortController();
    const active = () =>
      this.queue === queue && !signal?.aborted && !this.disposed && this.authorized();
    const abort = () => {
      toolsAbort.abort();
      if (this.responsePending && this.responseOwner === queue) {
        this.send({ type: "response.cancel" });
        this.cancelDeadline ??= setTimeout(() => {
          void this.dispose();
          this.onCancellationTimeout();
        }, 10_000);
        this.cancelDeadline.unref();
      }
      queue.push({ kind: "abort" });
      for (const resolve of this.idleWaiters) resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const invoke = (raw: unknown) => {
      const parsed = functionCall.safeParse(raw);
      if (!parsed.success || !active()) return;
      roundTools = true;
      const call = parsed.data;
      if (this.executed.has(call.call_id)) return;
      if (this.executed.size >= 256) throw new Error("Realtime function-call limit reached");
      this.executed.add(call.call_id);
      flushText();
      turnItems.push({
        type: "function_call",
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
      });
      const handle = tools.get(call.name);
      const args = parseToolArgs(call.arguments);
      queue.push({
        kind: "agent",
        event: wrapEvent("agent.tool.input_start", {
          ...base,
          toolCallId: call.call_id,
          tool: call.name,
        }),
      });
      queue.push({
        kind: "agent",
        event: wrapEvent("agent.tool.start", {
          ...base,
          toolCallId: call.call_id,
          tool: call.name,
          args: args.ok ? args.args : {},
          argsSummary: summarizeToolArgs(handle, args.ok ? args.args : {}),
        }),
      });
      pending += 1;
      const startedAt = Date.now();
      void (async () => {
        const result: ToolResult = !handle
          ? { kind: "error", code: "unknown_tool", message: `no tool named ${call.name}` }
          : !args.ok
            ? toolArgsUnparseableResult(args.error, call.arguments)
            : await invokeToolHandle(handle, args.args, {
                ...base,
                caller: input.caller,
                timeZone: input.timeZone,
                abortSignal: toolsAbort.signal,
                ...childEventHooks({ ...base, toolCallId: call.call_id }, (event) => {
                  if (active()) queue.push({ kind: "agent", event });
                }),
              });
        if (active())
          queue.push({
            kind: "result",
            id: call.call_id,
            result,
            durationMs: Date.now() - startedAt,
          });
      })().catch(() => {
        if (active()) queue.push({ kind: "abort" });
      });
    };
    const context = realtimeHistoryItems(input.history, input.timeZone);
    context.push(
      this.inputItemId
        ? { type: "item_reference", id: this.inputItemId }
        : {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: input.userMessage }],
          },
    );
    if (input.modelNote)
      context.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: input.modelNote }],
      });
    const requestResponse = () => {
      this.responsePending = true;
      this.responseOwner = queue;
      this.responseId = undefined;
      this.send({ type: "response.create", response: { input: [...context, ...turnItems] } });
    };
    try {
      if (this.responsePending)
        await new Promise<void>((resolve) => {
          this.idleWaiters.add(resolve);
        });
      if (!active()) return;
      yield wrapEvent("agent.message.start", { ...base, role: "assistant" });
      requestResponse();
      for (;;) {
        const next = await queue.next();
        if (!next || next.kind === "abort" || signal?.aborted) return;
        if (next.kind === "failure") {
          yield wrapEvent("agent.message.end", {
            ...base,
            stopReason: next.failure.code === "output_truncated" ? "max_tokens" : "error",
            failure: next.failure,
          });
          return;
        }
        if (next.kind === "agent") yield next.event;
        else if (next.kind === "result") {
          pending -= 1;
          yield wrapEvent("agent.tool.result", {
            ...base,
            toolCallId: next.id,
            result: next.result,
            durationMs: next.durationMs,
          });
          const outputItem = {
            type: "function_call_output",
            call_id: next.id,
            output: serializeToolResultForModel(next.result, { timeZone: input.timeZone }),
          };
          roundResults.push(outputItem);
          this.send({ type: "conversation.item.create", item: outputItem });
        } else {
          const event = next.event;
          if (
            event.type === "response.output_audio_transcript.delta" &&
            typeof event.delta === "string" &&
            !this.interrupted
          ) {
            roundText += event.delta;
            yield wrapEvent("agent.text.delta", { ...base, delta: event.delta });
          }
          if (event.type === "response.function_call_arguments.done") invoke(event);
          if (event.type === "response.done") {
            const done = responseDone.parse(event).response;
            if (done.id && completedResponses.has(done.id)) continue;
            if (done.id) completedResponses.add(done.id);
            for (const item of done.output ?? []) if (item.type === "function_call") invoke(item);
            roundDone = true;
            if (done.status === "cancelled") this.interrupted = true;
            if (done.status === "failed" || done.status === "incomplete") {
              const failure = this.modelFailure(
                done.status_details?.error?.code ?? done.status_details?.reason ?? "provider_error",
              );
              yield wrapEvent("agent.message.end", {
                ...base,
                stopReason: failure.code === "output_truncated" ? "max_tokens" : "error",
                failure,
              });
              return;
            }
            if (done.usage) {
              inputTokens += done.usage.input_tokens;
              outputTokens += done.usage.output_tokens;
              cachedTokens += done.usage.input_token_details?.cached_tokens ?? 0;
            }
          }
        }
        if (roundDone && pending === 0) {
          if (this.interrupted || !roundTools) {
            yield wrapEvent("agent.message.end", {
              ...base,
              stopReason: this.interrupted ? "canceled" : "end_turn",
              usage: {
                inputTokens: Math.max(0, inputTokens - cachedTokens),
                outputTokens,
                cacheReadTokens: cachedTokens,
              },
            });
            return;
          }
          if (++requests >= DEFAULT_MAX_TOOL_ITERATIONS)
            throw new Error("Realtime tool iteration limit reached");
          flushText();
          turnItems.push(...roundResults.splice(0));
          roundDone = false;
          roundTools = false;
          requestResponse();
        }
      }
    } finally {
      toolsAbort.abort();
      signal?.removeEventListener("abort", abort);
      if (this.queue === queue) this.queue = undefined;
      queue.close();
    }
  }
}

/** The canonical transcript is the sole history authority, including synthesized canceled tool results. */
export function realtimeHistoryItems(
  history: ReadonlyArray<ChatMessage>,
  timeZone?: string,
): Array<Record<string, unknown>> {
  return history.flatMap((message) =>
    message.parts.flatMap((part): Array<Record<string, unknown>> => {
      if (part.kind === "text" && part.text)
        return [
          {
            type: "message",
            role: message.role,
            content: [
              { type: message.role === "user" ? "input_text" : "output_text", text: part.text },
            ],
          },
        ];
      if (part.kind === "tool_use")
        return [
          {
            type: "function_call",
            call_id: part.toolCallId,
            name: part.tool,
            arguments: JSON.stringify(part.args),
          },
        ];
      if (part.kind === "tool_result")
        return [
          {
            type: "function_call_output",
            call_id: part.toolCallId,
            output: serializeToolResultForModel(part.result, { timeZone }),
          },
        ];
      return [];
    }),
  );
}
