// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `AnthropicBackend` — production backend wrapping `@anthropic-ai/sdk`.
 *
 * Runs the full tool-use loop internally and surfaces only typed
 * `AgentEvent`s to the consumer. The agent loop:
 *
 *   1. Convert canonical history + new user message → Anthropic message blocks.
 *   2. Open a streaming request with tools, system prompt (cache-controlled).
 *   3. Stream `content_block_*` events; translate text/thinking deltas into
 *      `agent.text.delta` / `agent.thinking.delta`, accumulate `input_json`
 *      deltas for each tool_use block.
 *   4. On `message_stop` if stop_reason was `tool_use`: invoke every tool in
 *      parallel, emit `agent.tool.start` (with the full args) and
 *      `agent.tool.result` for each, then loop back to (2) with the
 *      assistant turn + tool_result user turn appended.
 *   5. Otherwise emit `agent.message.end` and exit.
 *
 * Capped at `maxToolIterations` to keep a misbehaving model from looping
 * forever. Default: 50.
 *
 * Prompt caching: the system prompt is sent as a single text block with
 * `cache_control: { type: "ephemeral" }`. Tool schemas inherit the cache
 * key implicitly. The history carries ONE moving breakpoint — each
 * iteration `refreshHistoryCacheMarker` strips prior markers and stamps
 * the last block of the last message, so a follow-up request reuses the
 * prefix the previous iteration cached and only the new content pays
 * full price (two breakpoints total, well under the API's cap of 4).
 */

import Anthropic from "@anthropic-ai/sdk";
import {
  createLogger,
  sanitizeProviderFailureField,
  type AgentContextAssessment,
  type AgentEvent,
  type AgentProviderFailureDetail,
  type ToolResult,
} from "@omnesis/core";

const log = createLogger("agent:anthropic");
const UNKNOWN_MODEL_MAX_TOKENS = 4_096;
export const DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS = 256;
import { zodToJsonSchema } from "./zod-to-json-schema.js";
import { thinkingBudgetTokens } from "./thinking-budget.js";
import {
  childEventHooks,
  DEFAULT_MAX_TOOL_ITERATIONS,
  startLlmRequest,
  ToolProgressQueue,
  wrapEvent,
  parseToolArgs,
  summarizeToolArgs,
  toolArgsUnparseableResult,
  toolResultHasErrors,
} from "./backend.js";
import { CONTEXT_WINDOW_EXCEEDED_MESSAGE, OUTPUT_TRUNCATED_MESSAGE } from "./turn-outcome.js";
import { describeHttpStatus } from "./http-error.js";
import type { ModelTokenLimits } from "@omnesis/core/models";
import type {
  ContentBlockParam,
  MessageCountTokensParams,
  MessageTokensCount,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  StopReason,
  ThinkingConfigParam,
  Tool,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.js";

import type {
  AssistantPart,
  ChatBackend,
  ChatMessage,
  ReasoningBound,
  ToolHandle,
  TurnInput,
  UserPart,
} from "./backend.js";

/**
 * The beta the API wants before it will interleave thinking with tool calls
 * under an explicit budget.
 *
 * Adaptive thinking turns interleaving on by itself, which is why the unbounded
 * path sends no header. `{ type: "enabled" }` does not: without this the model
 * thinks once, before its first tool call, and then reads everything it reads
 * without thinking again. For a compiler whose whole job is to find out what a
 * request means on this install and only then choose a predicate, that is the
 * more damaging half of bounding the turn — so a bounded turn asks for the
 * interleaving back rather than trading it away unnoticed.
 */
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

export interface AnthropicBackendOptions {
  apiKey: string;
  model: string;
  maxTokens?: number;
  /**
   * Model-advertised ceiling. Unknown models use a conservative 4,096-token
   * ceiling until discovery supplies their actual limit.
   */
  modelMaxTokens?: number;
  /** Provider-reported token ceilings for this exact model. */
  modelLimits?: ModelTokenLimits;
  /** Headroom for the counting endpoint's documented estimate variance. */
  contextSafetyMarginTokens?: number;
  maxToolIterations?: number;
  /**
   * Capability value reported by Anthropic's Models API. When omitted,
   * model-family detection preserves compatibility with bundled/configured
   * model ids that do not have live capability metadata.
   */
  adaptiveThinking?: boolean;
  /**
   * Injectable Anthropic client. Defaults to `new Anthropic({ apiKey })`.
   * Tests pass in a stub whose `messages.create` returns a canned stream.
   */
  client?: AnthropicClientLike;
}

/**
 * The slice of the Anthropic SDK we depend on. Lets tests inject a stub
 * without typing the whole `Anthropic` surface.
 */
export interface AnthropicClientLike {
  messages: {
    create(
      params: MessageCreateParamsStreaming,
      opts?: { signal?: AbortSignal; headers?: Record<string, string> },
    ): Promise<AsyncIterable<RawMessageStreamEvent>> | AsyncIterable<RawMessageStreamEvent>;
    countTokens?(
      params: MessageCountTokensParams,
      opts?: { signal?: AbortSignal },
    ): Promise<MessageTokensCount>;
  };
}

export class AnthropicBackend implements ChatBackend {
  readonly name = "anthropic";
  readonly model: string;

  private readonly client: AnthropicClientLike;
  private readonly maxTokens: number;
  private readonly maxToolIterations: number;
  private readonly modelLimits: ModelTokenLimits;
  private readonly contextSafetyMarginTokens: number;
  /**
   * The `thinking` request config for this model, or `undefined` to leave
   * thinking off. Adaptive thinking (`{ type: "adaptive" }`) auto-enables
   * interleaved thinking between tool calls — so reasoning streams to the
   * client in the beats between an assistant text block and its next tool
   * call, which is exactly where the conversation UI would otherwise sit
   * silent. `display: "summarized"` opts back into readable reasoning text
   * (the API default is `omitted`, which streams empty thinking blocks).
   * Left `undefined` on models that don't support adaptive thinking — see
   * `supportsAdaptiveThinking`.
   */
  private readonly thinking: ThinkingConfigParam | undefined;
  /** So a model that cannot be bounded says so once rather than every turn. */
  private unboundableLogged = false;

  constructor(opts: AnthropicBackendOptions) {
    if (!opts.apiKey) throw new Error("AnthropicBackend requires apiKey");
    this.model = opts.model;
    this.client =
      opts.client ?? (new Anthropic({ apiKey: opts.apiKey }) as unknown as AnthropicClientLike);
    // A generous per-turn output cap. With adaptive thinking enabled the
    // reasoning and the visible answer SHARE this budget, so the old 4096
    // could truncate a reasoning-heavy turn mid-sentence. The request streams,
    // so a large cap costs nothing extra — the model stops well short of it on
    // `end_turn` (it's a ceiling, not a target) and streaming avoids the SDK
    // HTTP timeout a large non-streaming `max_tokens` would risk.
    const requestedMaxTokens = opts.maxTokens ?? 16_000;
    this.modelLimits = opts.modelLimits ?? {};
    this.maxTokens = Math.min(
      requestedMaxTokens,
      this.modelLimits.maxOutputTokens ?? opts.modelMaxTokens ?? UNKNOWN_MODEL_MAX_TOKENS,
    );
    this.maxToolIterations = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    this.contextSafetyMarginTokens =
      opts.contextSafetyMarginTokens ?? DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS;
    this.thinking =
      (opts.adaptiveThinking ?? supportsAdaptiveThinking(this.model))
        ? { type: "adaptive", display: "summarized" }
        : undefined;
  }

  /**
   * The `thinking` config for one turn: this backend's own, unless the turn
   * asked to be bounded and this model will take a bound.
   *
   * Adaptive thinking lets the model decide how long to reason, which is right
   * for a conversation someone is watching and wrong for a turn on a deadline
   * — a watch compile that misses its deadline has typically reasoned far
   * longer than one that finished and emitted almost no answer.
   *
   * Two things have to hold before a budget is worth sending. Thinking must be
   * on at all: a model that is not reasoning at length has nothing to cap, and
   * the config would be one the API rejects in exchange for nothing. And the
   * model must still accept a budget — see {@link supportsThinkingBudget}, and
   * note that a request bounced for naming a shape the model retired takes the
   * whole turn with it, which is a far worse outcome than an unbounded compile.
   *
   * Where a budget is sent it is clamped rather than refused — under
   * `max_tokens`, which reasoning and the answer share, and at or above the
   * API's own floor — because a caller asking for less thinking never wants no
   * answer. Where the two cannot both hold, no budget is sent at all rather
   * than a floor nobody chose.
   */
  private thinkingFor(reasoning: ReasoningBound | undefined): ThinkingConfigParam | undefined {
    if (!reasoning || this.thinking === undefined) return this.thinking;
    if (!supportsThinkingBudget(this.model)) {
      if (!this.unboundableLogged) {
        this.unboundableLogged = true;
        log.info(`model=${this.model} takes no thinking budget; running unbounded`);
      }
      return this.thinking;
    }
    // Reasoning and the answer share `max_tokens`, and the API additionally
    // requires the budget strictly below it and at or above its own floor.
    // `undefined` means those two could not both hold, so the turn keeps the
    // backend's own config rather than quietly becoming something else.
    const budget = thinkingBudgetTokens(reasoning, this.maxTokens);
    if (budget === undefined) return this.thinking;
    // `display` stated rather than defaulted: the reasoning stream is how a
    // compile's transcript shows where its time went, and that measurement is
    // the only reason this bound exists.
    return { type: "enabled", budget_tokens: budget, display: "summarized" };
  }

  async *runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const { sessionId, messageId, timeZone, caller } = input;
    // Resolved once per turn, not per tool iteration: every request this turn
    // makes has to carry the same thinking config, or the model would reason
    // under one rule before its first tool call and another after it.
    const turnThinking = this.thinkingFor(input.reasoning);
    // Sent only alongside an explicit budget. Adaptive thinking interleaves on
    // its own, and a turn that is not thinking has nothing to interleave — in
    // both cases the header would be a request for a beta the turn does not
    // use.
    const turnHeaders: Record<string, string> | undefined =
      turnThinking?.type === "enabled"
        ? { "anthropic-beta": INTERLEAVED_THINKING_BETA }
        : undefined;
    yield wrapEvent("agent.message.start", { sessionId, messageId, role: "assistant" });

    const tools: Tool[] = input.tools.map((h) => ({
      name: h.name,
      description: h.description,
      input_schema: zodToJsonSchema(h.schema) as Tool["input_schema"],
    }));
    const handles = new Map<string, ToolHandle>(input.tools.map((h) => [h.name, h]));

    const messages: MessageParam[] = convertHistoryToAnthropic(input.history);
    messages.push({ role: "user", content: input.userMessage });

    // Start pessimistic: a stream that never emits `message_delta` (e.g. the
    // SDK throws before any output) maps to stopReason "error" rather than
    // silently presenting as a clean end_turn.
    let finalStopReason: AnthropicStopReason = "refusal";
    const totalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    let contextAssessment = initialContextAssessment(
      this.modelLimits,
      this.maxTokens,
      this.contextSafetyMarginTokens,
    );
    const canceledEnd = (): AgentEvent =>
      wrapEvent("agent.message.end", {
        sessionId,
        messageId,
        stopReason: "canceled",
        usage: totalUsage,
        context: contextAssessment,
      });

    for (let iter = 0; iter < this.maxToolIterations; iter++) {
      const requestIteration = iter + 1;
      // Input tokens arrive on this iteration's `message_start`; captured
      // per-iteration so the probe can attribute them to this request.
      let iterationInputTokens = 0;
      contextAssessment = beginContextIteration(contextAssessment, requestIteration);
      if (signal?.aborted) {
        yield canceledEnd();
        return;
      }

      // Place a `cache_control: ephemeral` marker on the last block of the
      // current `messages` array. The system prompt is already cached;
      // adding a second breakpoint here lets the conversation history
      // (which grows with each turn AND each tool-use iteration) ride the
      // cache too. Every subsequent request that shares the same prefix
      // pays only for the incremental tokens past this marker. Crucial
      // for multi-turn conversations where the history accumulates large
      // tool_result payloads (full search results, fetched doc bodies).
      refreshHistoryCacheMarker(messages);

      const requestInput = {
        model: this.model,
        system: [
          {
            type: "text" as const,
            text: input.systemPrompt,
            cache_control: { type: "ephemeral" as const },
          },
        ],
        tools,
        messages,
        ...(turnThinking ? { thinking: turnThinking } : {}),
      };

      if (this.client.messages.countTokens) {
        try {
          const count = await this.client.messages.countTokens(requestInput, { signal });
          contextAssessment = recordContextInput(
            contextAssessment,
            count.input_tokens,
            "provider_count",
            requestIteration,
          );
          if (
            exceedsAnthropicContext(
              count.input_tokens,
              this.maxTokens,
              this.contextSafetyMarginTokens,
              this.modelLimits,
            )
          ) {
            yield wrapEvent("agent.error", {
              sessionId,
              messageId,
              code: "context_window_exceeded",
              message: CONTEXT_WINDOW_EXCEEDED_MESSAGE,
            });
            yield wrapEvent("agent.message.end", {
              sessionId,
              messageId,
              stopReason: "error",
              usage: totalUsage,
              context: contextAssessment,
              failure: {
                code: "context_window_exceeded",
                message: CONTEXT_WINDOW_EXCEEDED_MESSAGE,
                retryable: false,
                backend: this.name,
                model: this.model,
              },
            });
            return;
          }
        } catch (err) {
          if (signal?.aborted) {
            yield canceledEnd();
            return;
          }
          log.warn(
            `token count unavailable for model=${this.model} iteration=${requestIteration} ${anthropicErrorMetadata(err)}`,
          );
        }
      }

      // The inference span starts here, after the token-count pre-check:
      // only the model request itself counts as inference wall time.
      const llmReq = startLlmRequest(input.llmProbe, requestIteration);
      let stream: AsyncIterable<RawMessageStreamEvent>;
      try {
        const streamMaybe = this.client.messages.create(
          {
            ...requestInput,
            max_tokens: this.maxTokens,
            stream: true,
          },
          { signal, ...(turnHeaders ? { headers: turnHeaders } : {}) },
        );
        stream = await streamMaybe;
      } catch (err) {
        // The request was attempted but produced no stream: close the span
        // without tokens so the wall time is still accounted.
        llmReq.end();
        if (signal?.aborted) {
          yield canceledEnd();
          return;
        }
        const contextExceeded = isAnthropicContextWindowError(err);
        log.warn(
          `request rejected for model=${this.model} iteration=${requestIteration} ${anthropicErrorMetadata(err)}`,
        );
        // API rejected the request (rate-limit, auth, network). Surface as
        // a typed agent.error so the portal renders an actionable message
        // and the session shuts down cleanly.
        const failureMessage = contextExceeded
          ? CONTEXT_WINDOW_EXCEEDED_MESSAGE
          : anthropicFailureMessage(err);
        yield wrapEvent("agent.error", {
          sessionId,
          messageId,
          code: contextExceeded ? "context_window_exceeded" : "anthropic_api_error",
          message: failureMessage,
          provider: anthropicProviderFailure(err),
        });
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: "error",
          usage: totalUsage,
          context: contextAssessment,
          failure: {
            code: contextExceeded ? "context_window_exceeded" : "anthropic_api_error",
            message: failureMessage,
            retryable: !contextExceeded,
            backend: this.name,
            model: this.model,
            provider: anthropicProviderFailure(err),
          },
        });
        return;
      }

      const blocks = new Map<number, BlockState>();
      const completedContent: ContentBlockParam[] = [];
      const completedToolUses: ToolUseBlockParam[] = [];
      // Tool-use blocks whose accumulated JSON failed to parse, keyed by
      // tool-use id. They are replayed with `{}` input (the wire needs a
      // valid object) and answered with an error result instead of being
      // invoked.
      const unparseableToolUses = new Map<string, { error: string; raw: string }>();

      let streamError: Error | null = null;
      let iterationOutputTokens = 0;
      try {
        for await (const event of stream) {
          if (signal?.aborted) break;

          switch (event.type) {
            case "message_start": {
              const u = event.message.usage;
              if (u) {
                totalUsage.inputTokens += u.input_tokens ?? 0;
                totalUsage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
                totalUsage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
                iterationInputTokens += u.input_tokens ?? 0;
                contextAssessment = recordContextInput(
                  contextAssessment,
                  (u.input_tokens ?? 0) +
                    (u.cache_read_input_tokens ?? 0) +
                    (u.cache_creation_input_tokens ?? 0),
                  "provider_reported",
                  requestIteration,
                );
              }
              break;
            }
            case "content_block_start": {
              const cb = event.content_block;
              if (cb.type === "text") {
                blocks.set(event.index, { kind: "text", text: "" });
              } else if (cb.type === "tool_use") {
                blocks.set(event.index, {
                  kind: "tool_use",
                  id: cb.id,
                  tool: cb.name,
                  jsonBuf: "",
                });
                // Surface the "model is generating a tool call" moment
                // ASAP — without this the UI sits silent for the seconds
                // it takes Anthropic to stream the args JSON, and the
                // card pops in fully-formed at content_block_stop.
                llmReq.markContent();
                yield wrapEvent("agent.tool.input_start", {
                  sessionId,
                  messageId,
                  toolCallId: cb.id,
                  tool: cb.name,
                });
              } else if (cb.type === "thinking") {
                blocks.set(event.index, { kind: "thinking", text: "", signature: "" });
              } else if (cb.type === "redacted_thinking") {
                // Delivered whole (no deltas) — capture the opaque payload now
                // so it can be replayed verbatim in the assistant turn.
                blocks.set(event.index, { kind: "redacted_thinking", data: cb.data });
              } else {
                blocks.set(event.index, { kind: "other" });
              }
              break;
            }
            case "content_block_delta": {
              const slot = blocks.get(event.index);
              if (!slot) {
                // Out-of-order or unknown-index deltas would silently drop
                // tool arguments without this warning.
                log.warn(
                  `content_block_delta for unknown index ${event.index} — tool args may be lost`,
                );
                break;
              }
              const d = event.delta;
              if (d.type === "text_delta" && slot.kind === "text") {
                slot.text += d.text;
                llmReq.markContent();
                yield wrapEvent("agent.text.delta", { sessionId, messageId, delta: d.text });
              } else if (d.type === "input_json_delta" && slot.kind === "tool_use") {
                slot.jsonBuf += d.partial_json;
              } else if (d.type === "thinking_delta" && slot.kind === "thinking") {
                slot.text += d.thinking;
                llmReq.markContent();
                yield wrapEvent("agent.thinking.delta", {
                  sessionId,
                  messageId,
                  delta: d.thinking,
                });
              } else if (d.type === "signature_delta" && slot.kind === "thinking") {
                // The signature validates the thinking block on replay; capture
                // it so the block can be sent back in the next iteration's
                // assistant turn.
                slot.signature += d.signature;
              }
              break;
            }
            case "content_block_stop": {
              const slot = blocks.get(event.index);
              if (!slot) break;
              if (slot.kind === "text") {
                completedContent.push({ type: "text", text: slot.text });
              } else if (slot.kind === "thinking") {
                // With adaptive/interleaved thinking enabled, Anthropic REQUIRES
                // the thinking blocks that preceded a tool_use to be replayed
                // verbatim — including their signature — in the assistant turn
                // we send back next iteration; dropping them, or reordering so a
                // tool_use leads, 400s the follow-up request. Real thinking
                // blocks always carry a signature (even under display "omitted",
                // where only the text is blank), so we replay the block as-is.
                // Appended at content_block_stop, i.e. in generation order —
                // before the tool_use blocks — so the sequence stays valid.
                completedContent.push({
                  type: "thinking",
                  thinking: slot.text,
                  signature: slot.signature,
                });
              } else if (slot.kind === "redacted_thinking") {
                completedContent.push({ type: "redacted_thinking", data: slot.data });
              } else if (slot.kind === "tool_use") {
                // An empty buffer is a legitimate no-argument call; anything
                // else must be valid JSON (parseToolArgs handles both).
                const argsResult = parseToolArgs(slot.jsonBuf);
                if (!argsResult.ok) {
                  unparseableToolUses.set(slot.id, { error: argsResult.error, raw: slot.jsonBuf });
                }
                const args = argsResult.ok ? argsResult.args : {};
                const block: ToolUseBlockParam = {
                  type: "tool_use",
                  id: slot.id,
                  name: slot.tool,
                  input: args,
                };
                completedContent.push(block);
                completedToolUses.push(block);
                yield wrapEvent("agent.tool.start", {
                  sessionId,
                  messageId,
                  toolCallId: slot.id,
                  tool: slot.tool,
                  args,
                  argsSummary: summarizeToolArgs(handles.get(slot.tool), args),
                });
              }
              blocks.delete(event.index);
              break;
            }
            case "message_delta": {
              if (event.delta.stop_reason) {
                finalStopReason = event.delta.stop_reason as AnthropicStopReason;
              }
              if (event.usage) {
                const nextOutputTokens = event.usage.output_tokens ?? 0;
                iterationOutputTokens = nextOutputTokens;
                const reportedInput =
                  (event.usage.input_tokens ?? 0) +
                  (event.usage.cache_read_input_tokens ?? 0) +
                  (event.usage.cache_creation_input_tokens ?? 0);
                if (reportedInput > 0) {
                  contextAssessment = recordContextInput(
                    contextAssessment,
                    reportedInput,
                    "provider_reported",
                    requestIteration,
                  );
                }
              }
              break;
            }
            case "message_stop":
              // No state change here; we use the accumulated stop_reason from
              // message_delta.
              break;
          }
        }
      } catch (err) {
        // Mid-stream error (connection reset, model timeout, etc.).
        streamError = err instanceof Error ? err : new Error(String(err));
      }
      totalUsage.outputTokens += iterationOutputTokens;
      // The request's stream is fully consumed: close its span with this
      // request's provider-reported tokens. Tool execution downstream is
      // not inference.
      llmReq.end({ inputTokens: iterationInputTokens, outputTokens: iterationOutputTokens });

      // Aborting an SDK stream may either throw or end iteration normally.
      // In both cases cancellation wins over the transport-shaped outcome.
      if (signal?.aborted) {
        yield canceledEnd();
        return;
      }

      if (streamError) {
        const contextExceeded = isAnthropicContextWindowError(streamError);
        log.warn(
          `stream failed for model=${this.model} iteration=${requestIteration} ${anthropicErrorMetadata(streamError)}`,
        );
        yield wrapEvent("agent.error", {
          sessionId,
          messageId,
          code: contextExceeded ? "context_window_exceeded" : "anthropic_stream_error",
          message: contextExceeded
            ? CONTEXT_WINDOW_EXCEEDED_MESSAGE
            : "Anthropic response stream failed.",
        });
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: "error",
          usage: totalUsage,
          context: contextAssessment,
          failure: {
            code: contextExceeded ? "context_window_exceeded" : "anthropic_stream_error",
            message: contextExceeded
              ? CONTEXT_WINDOW_EXCEEDED_MESSAGE
              : "Anthropic response stream failed.",
            retryable: !contextExceeded,
            backend: this.name,
            model: this.model,
          },
        });
        return;
      }

      // Append the assistant turn to the message list for the next iteration
      // (or for the final state — never re-read by us once the loop ends).
      messages.push({ role: "assistant", content: completedContent });

      if (finalStopReason === "model_context_window_exceeded") {
        yield wrapEvent("agent.error", {
          sessionId,
          messageId,
          code: "context_window_exceeded",
          message: CONTEXT_WINDOW_EXCEEDED_MESSAGE,
        });
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: "error",
          usage: totalUsage,
          context: contextAssessment,
          failure: {
            code: "context_window_exceeded",
            message: CONTEXT_WINDOW_EXCEEDED_MESSAGE,
            retryable: false,
            backend: this.name,
            model: this.model,
          },
        });
        return;
      }

      if (finalStopReason === "tool_use" && completedToolUses.length > 0) {
        // Invoke every tool the model requested, in parallel.
        const progress = new ToolProgressQueue<AgentEvent>();
        const toolResultsPromise = Promise.all(
          completedToolUses.map(async (use) => {
            const handle = handles.get(use.name);
            const unparseable = unparseableToolUses.get(use.id);
            const start = Date.now();
            let result: ToolResult;
            if (!handle) {
              result = {
                kind: "error",
                code: "unknown_tool",
                message: `no tool named ${use.name}`,
              };
            } else if (unparseable) {
              result = toolArgsUnparseableResult(unparseable.error, unparseable.raw);
            } else {
              try {
                result = await handle.invoke(use.input, {
                  sessionId,
                  messageId,
                  abortSignal: signal,
                  timeZone,
                  caller,
                  ...childEventHooks({ sessionId, messageId, toolCallId: use.id }, (event) =>
                    progress.push(event),
                  ),
                });
              } catch (err) {
                result = {
                  kind: "error",
                  code: "tool_threw",
                  message: (err as Error).message ?? "tool threw",
                };
              }
            }
            return { use, result, durationMs: Date.now() - start };
          }),
        );
        void toolResultsPromise.finally(() => progress.close());
        for (;;) {
          const event = await progress.next();
          if (!event) break;
          yield event;
        }
        const toolResults = await toolResultsPromise;

        const toolResultBlocks: ToolResultBlockParam[] = [];
        for (const r of toolResults) {
          yield wrapEvent("agent.tool.result", {
            sessionId,
            messageId,
            toolCallId: r.use.id,
            result: r.result,
            durationMs: r.durationMs,
          });
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: r.use.id,
            content: JSON.stringify(r.result),
            is_error: toolResultHasErrors(r.result) ? true : undefined,
          });
        }
        messages.push({ role: "user", content: toolResultBlocks });
        // Continue the loop — Anthropic gives us another assistant turn.
        continue;
      }

      // Non-tool-use stop. Emit end and return.
      const mappedStopReason = mapStopReason(finalStopReason);
      yield wrapEvent("agent.message.end", {
        sessionId,
        messageId,
        stopReason: mappedStopReason,
        usage: totalUsage,
        context: contextAssessment,
        ...(mappedStopReason === "max_tokens"
          ? {
              failure: {
                code: "output_truncated",
                message: OUTPUT_TRUNCATED_MESSAGE,
                retryable: false,
                backend: this.name,
                model: this.model,
              },
            }
          : {}),
      });
      return;
    }

    // Iteration cap reached — surface as an error end.
    yield wrapEvent("agent.error", {
      sessionId,
      messageId,
      code: "tool_iteration_cap",
      message: `model exceeded ${this.maxToolIterations} tool-use iterations`,
    });
    yield wrapEvent("agent.message.end", {
      sessionId,
      messageId,
      stopReason: "error",
      usage: totalUsage,
      context: contextAssessment,
      failure: {
        code: "tool_iteration_cap",
        message: `model exceeded ${this.maxToolIterations} tool-use iterations`,
        retryable: false,
        backend: this.name,
        model: this.model,
      },
    });
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

type BlockState =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; signature: string }
  | { kind: "redacted_thinking"; data: string }
  | { kind: "tool_use"; id: string; tool: string; jsonBuf: string }
  | { kind: "other" };

type AnthropicStopReason = StopReason | "model_context_window_exceeded";

function initialContextAssessment(
  limits: ModelTokenLimits,
  reservedOutputTokens: number,
  safetyMarginTokens: number,
): AgentContextAssessment {
  const hasProviderLimit =
    limits.maxInputTokens !== undefined || limits.contextWindowTokens !== undefined;
  return {
    ...(limits.maxInputTokens === undefined ? {} : { maxInputTokens: limits.maxInputTokens }),
    ...(limits.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: limits.contextWindowTokens }),
    reservedOutputTokens,
    safetyMarginTokens,
    measurement: "unknown",
    limitSource: hasProviderLimit ? "provider" : "unknown",
    requestIteration: 1,
  };
}

function recordContextInput(
  previous: AgentContextAssessment,
  inputTokens: number,
  measurement: "provider_count" | "provider_reported",
  requestIteration: number,
): AgentContextAssessment {
  return {
    ...previous,
    inputTokens,
    peakInputTokens: Math.max(previous.peakInputTokens ?? 0, inputTokens),
    measurement,
    requestIteration,
  };
}

function beginContextIteration(
  previous: AgentContextAssessment,
  requestIteration: number,
): AgentContextAssessment {
  const { inputTokens: _inputTokens, ...withoutCurrentInput } = previous;
  return {
    ...withoutCurrentInput,
    measurement: "unknown",
    requestIteration,
  };
}

function exceedsAnthropicContext(
  inputTokens: number,
  reservedOutputTokens: number,
  safetyMarginTokens: number,
  limits: ModelTokenLimits,
): boolean {
  if (
    limits.maxInputTokens !== undefined &&
    inputTokens + safetyMarginTokens > limits.maxInputTokens
  ) {
    return true;
  }
  return (
    limits.contextWindowTokens !== undefined &&
    inputTokens + reservedOutputTokens + safetyMarginTokens > limits.contextWindowTokens
  );
}

interface AnthropicErrorDetails {
  status?: number;
  type?: string;
  message: string;
  requestId?: string;
}

function anthropicErrorDetails(err: unknown): AnthropicErrorDetails {
  const record = asRecord(err);
  const envelope = asRecord(record?.error);
  const nested = asRecord(envelope?.error) ?? envelope;
  const message =
    stringField(nested, "message") ??
    stringField(record, "message") ??
    (err instanceof Error ? err.message : "");
  return {
    status: numberField(record, "status"),
    type: stringField(record, "type") ?? stringField(nested, "type"),
    message,
    requestId:
      stringField(record, "requestID") ??
      stringField(record, "request_id") ??
      stringField(envelope, "request_id"),
  };
}

function isAnthropicContextWindowError(err: unknown): boolean {
  const details = anthropicErrorDetails(err);
  if (details.status !== 400 || details.type !== "invalid_request_error") return false;
  return (
    /\bprompt is too long\b/i.test(details.message) ||
    /\bprompt\b.{0,80}\bexceeds?\b.{0,80}\bcontext\b/i.test(details.message) ||
    /\bmaximum context length\b.{0,120}\b(?:exceed|requested)\w*/i.test(details.message) ||
    /\bcontext window\b.{0,80}\b(?:exceed|too long|limit)\w*/i.test(details.message)
  );
}

export function anthropicErrorMetadata(err: unknown): string {
  const details = anthropicErrorDetails(err);
  return [
    `status=${details.status ?? "none"}`,
    `type=${safeAnthropicMetadata(details.type)}`,
    `requestId=${safeAnthropicMetadata(details.requestId)}`,
  ].join(" ");
}

/**
 * The subset of an Anthropic SDK error that describes the request's
 * disposition. The provider's own `message` is excluded by construction: it is
 * prose, and prose from a model server can quote the submitted prompt.
 */
export function anthropicProviderFailure(err: unknown): AgentProviderFailureDetail {
  const details = anthropicErrorDetails(err);
  const type = sanitizeProviderFailureField(details.type);
  const requestId = sanitizeProviderFailureField(details.requestId);
  return {
    ...(details.status !== undefined && details.status > 0 ? { status: details.status } : {}),
    ...(type ? { type } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

/** Operator-facing sentence for a rejected Anthropic request. */
export function anthropicFailureMessage(err: unknown): string {
  const { status } = anthropicErrorDetails(err);
  return status === undefined
    ? "Anthropic API request failed."
    : describeHttpStatus(status).replace("The model provider", "Anthropic");
}

function safeAnthropicMetadata(value: string | undefined): string {
  return sanitizeProviderFailureField(value) ?? "none";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Whether `model` accepts adaptive thinking (`{ type: "adaptive" }`), which
 * auto-enables interleaved thinking with no beta header. True for Claude 4.6+
 * Opus/Sonnet and the "5" family (Sonnet 5, Fable 5, Mythos 5). Older tiers —
 * Haiku 4.5, Sonnet 4.5, Opus ≤4.5 — reject `adaptive` with a 400 and would
 * need `{ type: "enabled", budget_tokens }` plus a beta header for interleaving,
 * so we leave thinking off there rather than send a request the API rejects.
 * The gateway's agent catalog currently offers `claude-sonnet-4-6` (adaptive)
 * and `claude-haiku-4-5` (left off) for the agent role.
 */
/**
 * Whether `thinking: { type: "enabled", budget_tokens }` is a shape this model
 * still accepts.
 *
 * Narrower than {@link supportsAdaptiveThinking}, and the gap is what matters:
 * the models that gained adaptive thinking first kept the explicit budget
 * beside it, and the ones after them removed it. Sending a budget to one of
 * those is answered with
 * `"thinking.type.enabled" is not supported for this model. Use
 * "thinking.type.adaptive" and "output_config.effort" to control thinking
 * behavior.` — an HTTP 400 that fails the whole turn, so a caller who asked
 * for less thinking gets no answer at all.
 *
 * `output_config.effort` is the replacement the API names, and expressing a
 * bound that way is tracked in #1973. Until then a model past the budget is
 * left to decide for itself, which is what it did before anyone asked.
 */
export function supportsThinkingBudget(model: string): boolean {
  return /claude-(?:opus|sonnet)-4-6\b/.test(model.toLowerCase());
}

export function supportsAdaptiveThinking(model: string): boolean {
  const m = model.toLowerCase();
  // Claude 4.6 / 4.7 / 4.8 Opus and Sonnet.
  if (/claude-(?:opus|sonnet)-4-(?:6|7|8)\b/.test(m)) return true;
  // The "5" family: Sonnet 5, Fable 5, Mythos 5 (Opus 5 if/when it ships).
  if (/claude-(?:opus|sonnet|fable|mythos)-5\b/.test(m)) return true;
  return false;
}

export function convertHistoryToAnthropic(history: ReadonlyArray<ChatMessage>): MessageParam[] {
  const out: MessageParam[] = [];
  for (const msg of history) {
    if (msg.role === "user") {
      const content: ContentBlockParam[] = msg.parts.map((p) => convertUserPart(p));
      out.push({ role: "user", content });
    } else {
      const content: ContentBlockParam[] = [];
      for (const part of msg.parts) {
        const block = convertAssistantPart(part);
        if (block) content.push(block);
      }
      // Thinking-only assistant turns survive convertAssistantPart as empty
      // content arrays. Anthropic 400s on `{ role: "assistant", content: [] }`,
      // so drop the entry instead of emitting a degenerate message.
      if (content.length === 0) continue;
      out.push({ role: "assistant", content });
    }
  }
  return out;
}

function convertUserPart(part: UserPart): ContentBlockParam {
  if (part.kind === "text") return { type: "text", text: part.text };
  return {
    type: "tool_result",
    tool_use_id: part.toolCallId,
    content: JSON.stringify(part.result),
    is_error: toolResultHasErrors(part.result) ? true : undefined,
  };
}

function convertAssistantPart(part: AssistantPart): ContentBlockParam | null {
  if (part.kind === "text") return { type: "text", text: part.text };
  if (part.kind === "tool_use") {
    return {
      type: "tool_use",
      id: part.toolCallId,
      name: part.tool,
      input: part.args as Record<string, unknown>,
    };
  }
  // Thinking blocks aren't replayable across requests without the signature
  // the API returned, which we don't have at this point. Skip them — the
  // model will think again next turn if it needs to.
  return null;
}

/**
 * Place a single `cache_control: ephemeral` marker on the last content
 * block of the last message in the history. Strips any pre-existing
 * markers from earlier messages so we don't accumulate breakpoints
 * across tool-use iterations (Anthropic caps total breakpoints at 4 per
 * request — system prompt already uses one, so we keep the messages
 * array down to one).
 *
 * Per-iteration effect inside a single user turn: each follow-up
 * request re-uses the prefix written by the prior iteration's marker,
 * so only the new assistant content + tool result pay full tokens.
 *
 * Across turns: marker moves forward each turn, so turn N+1 hits the
 * cache written by turn N. Saves the full prior conversation's tokens
 * (which include serialised tool_result blobs — these can be large).
 *
 * The `string`-content case (Anthropic accepts `content: string` as a
 * shorthand for a single text block) is rewritten into block form so
 * we can attach the marker — the wire shape stays equivalent.
 */
function refreshHistoryCacheMarker(messages: MessageParam[]): void {
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block && typeof block === "object" && "cache_control" in block) {
        delete (block as { cache_control?: unknown }).cache_control;
      }
    }
  }
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }];
    return;
  }
  if (last.content.length === 0) return;
  const lastBlock = last.content[last.content.length - 1] as ContentBlockParam & {
    cache_control?: { type: "ephemeral" };
  };
  lastBlock.cache_control = { type: "ephemeral" };
}

function mapStopReason(r: AnthropicStopReason): "end_turn" | "max_tokens" | "tool_use" | "error" {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "model_context_window_exceeded":
    case "pause_turn":
    case "refusal":
      return "error";
    default: {
      // New StopReason values from the Anthropic SDK should be classified
      // explicitly. The compile-time `never` assertion plus the warn line
      // make sure neither silently slips to "end_turn".
      const _exhaustive: never = r;
      void _exhaustive;
      log.warn(`unknown Anthropic StopReason: ${String(r)} — treating as error`);
      return "error";
    }
  }
}
