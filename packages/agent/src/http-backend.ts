// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import {
  createLogger,
  createThinkTagFilter,
  fetchWithInferenceUrlPolicy,
  normalizeApiPathPrefix,
  retryRateLimitedRequest,
  type AgentContextAssessment,
  type AgentEvent,
  type AgentProviderFailureDetail,
  type RateLimitPatience,
  type ToolResult,
} from "@omnesis/core";

import { zodToJsonSchema } from "./zod-to-json-schema.js";
import { thinkingBudgetTokens } from "./thinking-budget.js";
import { modelReasoningRequestFields } from "./model-reasoning-wire.js";
import {
  childEventHooks,
  DEFAULT_MAX_TOOL_ITERATIONS,
  startLlmRequest,
  ToolProgressQueue,
  wrapEvent,
  parseToolArgs,
  summarizeToolArgs,
  toolArgsUnparseableResult,
} from "./backend.js";
import {
  decodeHttpError,
  describeDecodedHttpError,
  providerFailureDetail,
  type DecodedHttpError,
} from "./http-error.js";
import { OUTPUT_TRUNCATED_MESSAGE } from "./turn-outcome.js";
import {
  initialHttpOutputBudget,
  outputBudgetForSelectedReasoning,
  ORDINARY_HTTP_TIMEOUT_MS,
  EXTENDED_HTTP_TIMEOUT_MS,
  retryHttpOutputBudget,
} from "./http-output-budget.js";
import type { ModelTokenLimits, ModelControls, ModelBehaviorValues } from "@omnesis/core/models";
import type { ChatBackend, ChatMessage, ReasoningBound, ToolHandle, TurnInput } from "./backend.js";

const log = createLogger("agent:http");

// ─── OpenAI wire types (subset we consume) ──────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  /** Exact plaintext reasoning trace required by this model for tool turns. */
  reasoning_content?: string;
  /** Opaque structured reasoning blocks required by this model for tool turns. */
  reasoning_details?: unknown[];
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /**
   * Provider-specific data attached to a tool call that must be echoed back
   * verbatim on the next request. Gemini's OpenAI-compatible shim carries an
   * encrypted `thought_signature` here (`extra_content.google.thought_signature`)
   * and rejects the follow-up turn with a 400 if it is dropped. We preserve it
   * opaquely rather than interpreting it.
   */
  extra_content?: unknown;
}

interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIStreamDelta {
  content?: unknown;
  /**
   * Some reasoning models (DeepSeek, and other servers' thinking models)
   * stream the chain-of-thought in a dedicated field rather than inline.
   * Surfaced as a thinking event. Only models that require the exact trace
   * across tool turns receive it back as `reasoning_content` in history.
   * OpenRouter normalizes the same trace into `reasoning` instead, so both
   * spellings are accepted with `reasoning_content` taking precedence.
   */
  reasoning_content?: string | null;
  reasoning?: string | null;
  reasoning_details?: unknown;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
    extra_content?: unknown;
  }>;
}

interface OpenAIStreamChoice {
  delta: OpenAIStreamDelta;
  finish_reason?: string | null;
}

/**
 * Provider usage, with the three ways OpenAI-compat providers report
 * prompt-cache hits: DeepSeek's top-level `prompt_cache_hit_tokens`,
 * OpenAI's nested `prompt_tokens_details.cached_tokens` (also Azure, xAI,
 * Groq, DashScope), and Moonshot/Kimi's top-level `cached_tokens`. In all
 * three, `prompt_tokens` is the TOTAL input (hit + miss), so the cached
 * count is a subset to be split back out.
 */
interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  cached_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** Cached (prefix-reused) input tokens from any of the provider conventions. */
function cachedInputTokens(u: OpenAIUsage | undefined): number {
  if (!u) return 0;
  return (
    u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cached_tokens ?? 0
  );
}

/** Mistral can return thinking/text chunks instead of a plain content string. */
function splitCompletionContent(raw: unknown): { text: string; thinking: string } {
  if (raw == null) return { text: "", thinking: "" };
  if (typeof raw === "string") return { text: raw, thinking: "" };
  if (!Array.isArray(raw)) return { text: "", thinking: "" };
  let text = "";
  let thinking = "";
  for (const part of raw) {
    if (!part || typeof part !== "object") continue;
    const item = part as { type?: unknown; text?: unknown; thinking?: unknown };
    if (item.type === "text" && typeof item.text === "string") text += item.text;
    if (item.type === "thinking" && Array.isArray(item.thinking)) {
      for (const inner of item.thinking) {
        if (
          inner &&
          typeof inner === "object" &&
          typeof (inner as { text?: unknown }).text === "string"
        ) {
          thinking += (inner as { text: string }).text;
        }
      }
    }
  }
  return { text, thinking };
}

/** Keep structured reasoning blocks opaque; never turn signatures into plaintext. */
function reasoningDetails(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.every((part) => part !== null && typeof part === "object" && !Array.isArray(part))
    ? raw
    : undefined;
}

interface OpenAIStreamChunk {
  choices: OpenAIStreamChoice[];
  usage?: OpenAIUsage;
}

/** Non-streamed `/chat/completions` body (used by the non-streaming fallback). */
interface OpenAINonStreamedResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      reasoning_content?: string | null;
      reasoning?: string | null;
      reasoning_details?: unknown;
      tool_calls?: Array<{
        id: string;
        function?: { name?: string; arguments?: string };
        extra_content?: unknown;
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage;
}

/**
 * Outcome of a single completion request after the resilience ladder. The agent
 * speaks streaming OpenAI Chat Completions by default, but falls back to
 * dropping `stream_options` (providers like Mistral reject it) and then to a
 * non-streamed request (some providers gate streaming of reasoning models
 * behind account verification). The ladder has no per-provider branching.
 */
type CompletionAttempt =
  | { kind: "stream"; response: Response; deadline: AbortSignal }
  | {
      kind: "json";
      content: string;
      reasoning?: string;
      reasoningDetails?: unknown[];
      toolCalls: OpenAIToolCall[];
      finishReason: string | null;
      usage: { prompt: number; completion: number; cachedInput: number; reasoning: number };
    }
  | { kind: "error"; code: string; message: string; provider?: AgentProviderFailureDetail };

// ─── Public API ──────────────────────────────────────────────────────────

export interface HttpChatBackendOptions {
  baseUrl: string;
  model: string;
  apiPathPrefix?: string;
  maxToolIterations?: number;
  timeoutMs?: number;
  apiKey?: string;
  allowRemoteInference?: boolean;
  modelLimits?: ModelTokenLimits;
  modelControls?: ModelControls;
  modelBehavior?: ModelBehaviorValues;
}

export class HttpChatBackend implements ChatBackend {
  readonly name = "http";
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiPathPrefix: string;
  private readonly maxToolIterations: number;
  private readonly timeoutMs: number;
  private readonly extendedOutputTimeoutMs: number;
  private readonly apiKey?: string;
  private readonly allowRemoteInference: boolean;
  private readonly modelLimits: ModelTokenLimits;
  private readonly modelControls?: ModelControls;
  private readonly modelBehavior?: ModelBehaviorValues;
  /** Monotonic runtime capability learned from reasoning output or empty exhaustion. */
  private extendedOutputObserved = false;

  // Resilience flags, learned once per backend so later iterations/turns skip
  // a request shape this provider has already rejected.
  private streamOptionsUnsupported = false;
  private streamingUnsupported = false;
  /**
   * Set once this server has answered that it does not take a `thinking` block,
   * so later requests on this backend stop offering one. Its life is the
   * backend's: a caller that builds one per turn re-learns it per turn, which
   * costs a rejected request each time and is the price of not caching a claim
   * about a server across a reconfiguration.
   *
   * Offered rather than assumed: only some OpenAI-compatible servers accept the
   * field, and one that does not rejects the whole request — so an unconditional
   * bound would take out every install whose model cannot be bounded, to buy a
   * compile a few seconds on the ones that can.
   */
  private thinkingBudgetUnsupported = false;
  /**
   * Whether each of the two outcomes has been reported yet.
   *
   * Separately, because they are opposites and one latch would let whichever
   * happened first silence the other. A turn's output budget is discovered
   * rather than known up front — it widens once the server is seen to emit
   * reasoning — so the ordinary sequence on a server with no configured ceiling
   * is a first request with no room for a bound followed by later ones that
   * carry it. Under a shared latch the operator's only signal would say
   * unbounded about a turn that was bounded from its second request onward.
   *
   * A bound is fail-open in three places, so "the operator set the knob" and
   * "the turn was bounded" are different facts, and a measurement that assumes
   * the first is measuring the wrong thing. This is how the difference shows.
   */
  private boundedLogged = false;
  private noRoomLogged = false;
  private completionLimitField: "max_tokens" | "max_completion_tokens" = "max_tokens";

  constructor(opts: HttpChatBackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiPathPrefix = normalizeApiPathPrefix(opts.apiPathPrefix);
    this.model = opts.model;
    this.maxToolIterations = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    this.extendedOutputTimeoutMs = opts.timeoutMs ?? EXTENDED_HTTP_TIMEOUT_MS;
    this.timeoutMs = opts.timeoutMs ?? ORDINARY_HTTP_TIMEOUT_MS;
    this.apiKey = opts.apiKey;
    this.allowRemoteInference = opts.allowRemoteInference === true;
    this.modelLimits = opts.modelLimits ?? {};
    this.modelControls = opts.modelControls;
    this.modelBehavior = opts.modelBehavior;
  }

  async *runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const { sessionId, messageId, timeZone, caller } = input;
    yield wrapEvent("agent.message.start", { sessionId, messageId, role: "assistant" });

    const tools = convertToolsToOpenAI(input.tools);
    const handles = new Map<string, ToolHandle>(input.tools.map((h) => [h.name, h]));

    const replayReasoningContent =
      this.modelControls?.interleavedReasoningField === "reasoning_content";
    const replayReasoningDetails =
      this.modelControls?.interleavedReasoningField === "reasoning_details";
    const messages = convertHistoryToOpenAI(
      input.history,
      input.userMessage,
      input.systemPrompt,
      replayReasoningContent,
      replayReasoningDetails,
    );

    const totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let initialOutputTokenBudget: number;
    try {
      initialOutputTokenBudget = outputBudgetForSelectedReasoning(
        initialHttpOutputBudget(this.extendedOutputObserved, this.modelLimits.maxOutputTokens),
        this.modelLimits.maxOutputTokens,
        this.modelBehavior?.reasoningBudgetTokens,
      );
    } catch (err) {
      const code = "http_reasoning_options_invalid";
      const message =
        err instanceof Error ? err.message : "The selected reasoning budget cannot fit this model.";
      yield wrapEvent("agent.error", { sessionId, messageId, code, message });
      yield wrapEvent("agent.message.end", {
        sessionId,
        messageId,
        stopReason: "error",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
        failure: { code, message, retryable: false, backend: this.name, model: this.model },
      });
      return;
    }
    let contextAssessment = initialHttpContextAssessment(
      this.modelLimits,
      initialOutputTokenBudget,
    );
    let requestIteration = 0;
    let retryNextRequest = false;
    let usedEmptyLengthRetry = false;

    let iter = 0;
    while (iter < this.maxToolIterations) {
      requestIteration += 1;
      contextAssessment = beginHttpContextIteration(contextAssessment, requestIteration);
      const isEmptyLengthRetry = retryNextRequest;
      const baseOutputBudget = isEmptyLengthRetry
        ? retryHttpOutputBudget(this.modelLimits.maxOutputTokens)
        : initialHttpOutputBudget(this.extendedOutputObserved, this.modelLimits.maxOutputTokens);
      const outputTokenBudget = outputBudgetForSelectedReasoning(
        baseOutputBudget,
        this.modelLimits.maxOutputTokens,
        this.modelBehavior?.reasoningBudgetTokens,
      );
      retryNextRequest = false;
      contextAssessment = {
        ...contextAssessment,
        reservedOutputTokens: outputTokenBudget,
      };
      if (signal?.aborted) {
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: "canceled",
          usage: totalUsage,
          context: contextAssessment,
        });
        return;
      }

      // The inference span starts at the request itself: one tracker per
      // attempt, including budget-raise retries. Pre-request aborts issue
      // no request, so they correctly leave no span.
      const llmReq = startLlmRequest(input.llmProbe, requestIteration);
      const attempt = await this.requestCompletion(
        messages,
        tools,
        signal,
        outputTokenBudget,
        isEmptyLengthRetry ||
          this.extendedOutputObserved ||
          outputTokenBudget > initialHttpOutputBudget(false, undefined)
          ? this.extendedOutputTimeoutMs
          : this.timeoutMs,
        input.reasoning,
        input.rateLimitPatience,
      );

      if (attempt.kind === "error") {
        // The request failed before (or without) streaming: still close the
        // span so a profiled turn accounts the wall time, without tokens.
        llmReq.end();
        if (signal?.aborted) {
          yield wrapEvent("agent.message.end", {
            sessionId,
            messageId,
            stopReason: "canceled",
            usage: totalUsage,
            context: contextAssessment,
          });
          return;
        }
        yield wrapEvent("agent.error", {
          sessionId,
          messageId,
          code: attempt.code,
          message: attempt.message,
          ...(attempt.provider ? { provider: attempt.provider } : {}),
        });
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: "error",
          usage: totalUsage,
          context: contextAssessment,
          failure: {
            code: attempt.code,
            message: attempt.message,
            retryable:
              attempt.code !== "context_window_exceeded" &&
              attempt.code !== "http_reasoning_options_invalid",
            backend: this.name,
            model: this.model,
            ...(attempt.provider ? { provider: attempt.provider } : {}),
          },
        });
        return;
      }

      let finishReason: string | null = null;
      let contentBuf = "";
      let reasoningBuf = "";
      const reasoningDetailsBuf: unknown[] = [];
      const completedToolCalls: OpenAIToolCall[] = [];

      if (attempt.kind === "stream") {
        // Strip <think>…</think> reasoning some providers emit inline in
        // `content`; the filter spans SSE deltas so a tag split across frames
        // isn't leaked.
        const thinkFilter = createThinkTagFilter();
        const toolCallAccumulators = new Map<
          number,
          { id: string; name: string; argumentsBuf: string; extraContent?: unknown }
        >();
        let iterationUsage = { prompt: 0, completion: 0, cachedInput: 0 };

        let streamError: Error | null = null;
        try {
          for await (const chunk of parseSSEStream(attempt.response)) {
            if (signal?.aborted) break;

            if (chunk.usage) {
              if ((chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0) > 0) {
                this.extendedOutputObserved = true;
              }
              // `prompt_tokens` is total input (hit + miss); split the cached
              // portion out so it can be priced at the cache-hit rate.
              const cached = cachedInputTokens(chunk.usage);
              iterationUsage = {
                prompt: chunk.usage.prompt_tokens ?? 0,
                completion: chunk.usage.completion_tokens ?? 0,
                cachedInput: cached,
              };
              contextAssessment = recordHttpContextInput(
                contextAssessment,
                iterationUsage.prompt,
                requestIteration,
              );
              // OpenAI-compatible providers normally put this frame directly
              // before `[DONE]`, but that is still before any following batch
              // tool work. Surface only provider-reported usage — never guess.
              yield wrapEvent("agent.usage.update", {
                sessionId,
                messageId,
                usage: {
                  inputTokens:
                    totalUsage.inputTokens +
                    Math.max(0, iterationUsage.prompt - iterationUsage.cachedInput),
                  cacheReadTokens: totalUsage.cacheReadTokens + iterationUsage.cachedInput,
                  outputTokens: totalUsage.outputTokens + iterationUsage.completion,
                },
              });
            }

            const choice = chunk.choices[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            const delta = choice.delta;

            const thinking = delta.reasoning_content ?? delta.reasoning;
            if (thinking) {
              if (replayReasoningContent) reasoningBuf += thinking;
              this.extendedOutputObserved = true;
              llmReq.markContent();
              yield wrapEvent("agent.thinking.delta", {
                sessionId,
                messageId,
                delta: thinking,
              });
            }

            const details = reasoningDetails(delta.reasoning_details);
            if (details?.length) {
              if (replayReasoningDetails) reasoningDetailsBuf.push(...details);
              this.extendedOutputObserved = true;
              llmReq.markContent();
              if (!thinking) {
                for (const part of details) {
                  const text = (part as { text?: unknown }).text;
                  if (typeof text === "string" && text) {
                    yield wrapEvent("agent.thinking.delta", {
                      sessionId,
                      messageId,
                      delta: text,
                    });
                  }
                }
              }
            }

            const chunks = splitCompletionContent(delta.content);
            if (chunks.thinking) {
              this.extendedOutputObserved = true;
              llmReq.markContent();
              yield wrapEvent("agent.thinking.delta", {
                sessionId,
                messageId,
                delta: chunks.thinking,
              });
            }
            if (chunks.text) {
              const visible = thinkFilter.push(chunks.text);
              if (thinkFilter.sawThinking) this.extendedOutputObserved = true;
              if (visible) {
                contentBuf += visible;
                llmReq.markContent();
                yield wrapEvent("agent.text.delta", { sessionId, messageId, delta: visible });
              }
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                let acc = toolCallAccumulators.get(tc.index);
                if (!acc) {
                  acc = { id: tc.id ?? "", name: tc.function?.name ?? "", argumentsBuf: "" };
                  toolCallAccumulators.set(tc.index, acc);
                  if (acc.id && acc.name) {
                    llmReq.markContent();
                    yield wrapEvent("agent.tool.input_start", {
                      sessionId,
                      messageId,
                      toolCallId: acc.id,
                      tool: acc.name,
                    });
                  }
                }
                if (tc.id && !acc.id) acc.id = tc.id;
                if (tc.function?.name && !acc.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.argumentsBuf += tc.function.arguments;
                // Preserve provider-specific data (e.g. Gemini's thought_signature)
                // so it can be echoed back on the follow-up turn. First-wins, like
                // id/name above, so a later empty delta can't clobber the signature.
                if (tc.extra_content !== undefined && acc.extraContent === undefined) {
                  acc.extraContent = tc.extra_content;
                }
              }
            }
          }
          // Emit any non-think tail the filter held back when the stream ended.
          const tail = thinkFilter.flush();
          if (tail) {
            contentBuf += tail;
            llmReq.markContent();
            yield wrapEvent("agent.text.delta", { sessionId, messageId, delta: tail });
          }
        } catch (err) {
          streamError = err instanceof Error ? err : new Error(String(err));
        }
        totalUsage.inputTokens += Math.max(0, iterationUsage.prompt - iterationUsage.cachedInput);
        totalUsage.cacheReadTokens += iterationUsage.cachedInput;
        totalUsage.outputTokens += iterationUsage.completion;
        // The request's stream is fully consumed here: close its span with
        // this request's provider-reported tokens. Everything downstream
        // (abort, stream error, tool calls, turn end) is not inference.
        llmReq.end({
          inputTokens: Math.max(0, iterationUsage.prompt - iterationUsage.cachedInput),
          outputTokens: iterationUsage.completion,
        });

        if (signal?.aborted) {
          yield wrapEvent("agent.message.end", {
            sessionId,
            messageId,
            stopReason: "canceled",
            usage: totalUsage,
            context: contextAssessment,
          });
          return;
        }
        if (streamError) {
          const timedOut = attempt.deadline.aborted;
          const code = timedOut ? "http_request_timeout" : "http_stream_error";
          const message = timedOut
            ? "The model did not respond before the request deadline."
            : "HTTP model response stream failed.";
          yield wrapEvent("agent.error", {
            sessionId,
            messageId,
            code,
            message,
          });
          yield wrapEvent("agent.message.end", {
            sessionId,
            messageId,
            stopReason: "error",
            usage: totalUsage,
            context: contextAssessment,
            failure: {
              code,
              message,
              retryable: true,
              backend: this.name,
              model: this.model,
            },
          });
          return;
        }

        for (const [, acc] of toolCallAccumulators) {
          const call: OpenAIToolCall = {
            id: acc.id,
            type: "function",
            function: { name: acc.name, arguments: acc.argumentsBuf },
          };
          if (acc.extraContent !== undefined) call.extra_content = acc.extraContent;
          completedToolCalls.push(call);
        }
      } else {
        // Non-streamed fallback: adapt the single response into the same events
        // and state the streaming path produces.
        finishReason = attempt.finishReason;
        totalUsage.inputTokens += Math.max(0, attempt.usage.prompt - attempt.usage.cachedInput);
        totalUsage.cacheReadTokens += attempt.usage.cachedInput;
        totalUsage.outputTokens += attempt.usage.completion;
        contextAssessment = recordHttpContextInput(
          contextAssessment,
          attempt.usage.prompt,
          requestIteration,
        );
        if (attempt.usage.reasoning > 0) this.extendedOutputObserved = true;

        if (attempt.reasoning) {
          if (replayReasoningContent) reasoningBuf = attempt.reasoning;
          this.extendedOutputObserved = true;
          llmReq.markContent();
          yield wrapEvent("agent.thinking.delta", {
            sessionId,
            messageId,
            delta: attempt.reasoning,
          });
        }
        if (attempt.reasoningDetails?.length) {
          if (replayReasoningDetails) reasoningDetailsBuf.push(...attempt.reasoningDetails);
          this.extendedOutputObserved = true;
          llmReq.markContent();
          if (!attempt.reasoning) {
            for (const part of attempt.reasoningDetails) {
              const text = (part as { text?: unknown }).text;
              if (typeof text === "string" && text) {
                yield wrapEvent("agent.thinking.delta", { sessionId, messageId, delta: text });
              }
            }
          }
        }

        const thinkFilter = createThinkTagFilter();
        const visible = `${thinkFilter.push(attempt.content)}${thinkFilter.flush()}`.trim();
        if (thinkFilter.sawThinking) this.extendedOutputObserved = true;
        if (visible) {
          contentBuf = visible;
          llmReq.markContent();
          yield wrapEvent("agent.text.delta", { sessionId, messageId, delta: visible });
        }

        for (const call of attempt.toolCalls) {
          if (call.id && call.function.name) {
            llmReq.markContent();
            yield wrapEvent("agent.tool.input_start", {
              sessionId,
              messageId,
              toolCallId: call.id,
              tool: call.function.name,
            });
          }
          completedToolCalls.push(call);
        }
        // Non-streamed providers deliver the whole response at once: close
        // the span after the content marks above, so a response with content
        // records TTFT and an empty one keeps ttftMs null.
        llmReq.end({
          inputTokens: Math.max(0, attempt.usage.prompt - attempt.usage.cachedInput),
          outputTokens: attempt.usage.completion,
        });
      }

      if (completedToolCalls.length === 0 && contentBuf.trim().length === 0) {
        // A successful response with no visible output and `length` is a
        // characteristic reasoning-budget exhaustion. Retry the exact request
        // once with a larger cap; the first response's reported usage remains
        // accounted above. This is deliberately provider-neutral and never
        // retries ordinary empty `stop` responses.
        const retryBudget = retryHttpOutputBudget(this.modelLimits.maxOutputTokens);
        if (finishReason === "length") this.extendedOutputObserved = true;
        if (
          finishReason === "length" &&
          !usedEmptyLengthRetry &&
          retryBudget > outputTokenBudget &&
          !signal?.aborted
        ) {
          usedEmptyLengthRetry = true;
          retryNextRequest = true;
          log.warn(
            `empty length response for model=${this.model}; retrying with a larger output budget`,
          );
          // This was not a tool-use iteration. Keep the iteration budget for
          // actual tool calls while recording the retry as its own context
          // assessment above.
          continue;
        }
        if (finishReason === "length") {
          yield wrapEvent("agent.message.end", {
            sessionId,
            messageId,
            stopReason: "max_tokens",
            usage: totalUsage,
            context: contextAssessment,
            failure: {
              code: "output_truncated",
              message: OUTPUT_TRUNCATED_MESSAGE,
              retryable: false,
              backend: this.name,
              model: this.model,
            },
          });
          return;
        }
        const finish = finishReason ? ` (finish_reason=${finishReason})` : "";
        yield wrapEvent("agent.error", {
          sessionId,
          messageId,
          code: "http_empty_response",
          message: `Model returned an empty response${finish}.`,
        });
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: "error",
          usage: totalUsage,
          context: contextAssessment,
          failure: {
            code: "http_empty_response",
            message: `Model returned an empty response${finish}.`,
            // The internal larger-budget retry has already been exhausted.
            // Re-running the whole agent turn would just repeat both paid
            // completions against the same deterministic output ceiling.
            retryable: finishReason !== "length",
            backend: this.name,
            model: this.model,
          },
        });
        return;
      }

      const parsed = completedToolCalls.map((tc) => ({
        tc,
        argsResult: parseToolArgs(tc.function.arguments),
        handle: handles.get(tc.function.name),
      }));

      // `length` with arguments that fail to parse means the output budget
      // ran out mid-tool-call. By this point the call's events (any preceding
      // text deltas, its tool.input_start) have already streamed to clients,
      // so the response is never re-requested; the truncated call is answered
      // below with a tool_args_unparseable error result, which resolves the
      // streamed stub through the ordinary result path. The next request in
      // the turn — the one carrying the model's re-issued call — is armed
      // with the larger output budget so that call has room to finish; the
      // shared one-shot flag bounds this and the empty-length recovery to one
      // raised budget per turn between them.
      if (
        finishReason === "length" &&
        parsed.some((p) => !p.argsResult.ok) &&
        !usedEmptyLengthRetry &&
        !signal?.aborted
      ) {
        const retryBudget = retryHttpOutputBudget(this.modelLimits.maxOutputTokens);
        if (retryBudget > outputTokenBudget) {
          usedEmptyLengthRetry = true;
          retryNextRequest = true;
          log.warn(
            `truncated tool-call arguments for model=${this.model}; raising the output budget for the next request`,
          );
        }
      }

      // Append the assistant message to history for the next iteration.
      const assistantMsg: OpenAIMessage = { role: "assistant", content: contentBuf || null };
      if (completedToolCalls.length > 0) {
        assistantMsg.tool_calls = completedToolCalls;
        if (replayReasoningContent && reasoningBuf) assistantMsg.reasoning_content = reasoningBuf;
        if (replayReasoningDetails && reasoningDetailsBuf.length)
          assistantMsg.reasoning_details = reasoningDetailsBuf;
      }
      messages.push(assistantMsg);

      if (completedToolCalls.length > 0) {
        // Emit tool.start for each call, then invoke in parallel. A call
        // whose arguments failed to parse is surfaced with `{}` args and
        // answered with an error result below instead of being invoked.
        // The raw argument string is echoed (truncated) inside that error
        // result — so it reaches the model and the persisted transcript —
        // but never the tool.start args field or the logs.
        for (const { tc, argsResult, handle } of parsed) {
          const args = argsResult.ok ? argsResult.args : {};
          yield wrapEvent("agent.tool.start", {
            sessionId,
            messageId,
            toolCallId: tc.id,
            tool: tc.function.name,
            args,
            argsSummary: summarizeToolArgs(handle, args),
            // Carry any opaque provider signature (e.g. Gemini thought_signature)
            // so the session can persist it on the tool_use history part and
            // replay it on later turns. See #510.
            ...(tc.extra_content !== undefined ? { extraContent: tc.extra_content } : {}),
            // One copy on the first tool call retains this assistant message's
            // exact reasoning blocks in canonical history for resumed turns.
            ...(replayReasoningDetails && tc === completedToolCalls[0] && reasoningDetailsBuf.length
              ? { reasoningDetails: reasoningDetailsBuf }
              : {}),
          });
        }

        const progress = new ToolProgressQueue<AgentEvent>();
        const toolResultsPromise = Promise.all(
          parsed.map(async ({ tc, argsResult, handle }) => {
            const start = Date.now();
            let result: ToolResult;
            if (!handle) {
              result = {
                kind: "error",
                code: "unknown_tool",
                message: `no tool named ${tc.function.name}`,
              };
            } else if (!argsResult.ok) {
              result = toolArgsUnparseableResult(argsResult.error, tc.function.arguments);
            } else {
              try {
                result = await handle.invoke(argsResult.args, {
                  sessionId,
                  messageId,
                  abortSignal: signal,
                  timeZone,
                  caller,
                  ...childEventHooks({ sessionId, messageId, toolCallId: tc.id }, (event) =>
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
            return { tc, result, durationMs: Date.now() - start };
          }),
        );
        void toolResultsPromise.finally(() => progress.close());
        for (;;) {
          const event = await progress.next();
          if (!event) break;
          yield event;
        }
        const toolResults = await toolResultsPromise;

        for (const r of toolResults) {
          yield wrapEvent("agent.tool.result", {
            sessionId,
            messageId,
            toolCallId: r.tc.id,
            result: r.result,
            durationMs: r.durationMs,
          });
          messages.push({
            role: "tool",
            tool_call_id: r.tc.id,
            content: JSON.stringify(r.result),
          });
        }
        iter += 1;
        continue;
      }

      // Non-tool-use stop.
      const outputTruncated = finishReason === "length";
      yield wrapEvent("agent.message.end", {
        sessionId,
        messageId,
        stopReason: outputTruncated ? "max_tokens" : "end_turn",
        usage: totalUsage,
        context: contextAssessment,
        ...(outputTruncated
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

    // Iteration cap reached.
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

  /**
   * Issue one completion request, walking a resilience ladder with no
   * per-provider branching: (1) streaming with `stream_options`; (2) on a
   * 400/422, streaming without `stream_options` (providers like Mistral reject
   * the unknown field); (3) non-streamed (some providers gate streaming of
   * reasoning models behind account verification). The winning shape is
   * remembered so later iterations skip a shape this backend already rejected.
   */
  private async requestCompletion(
    messages: OpenAIMessage[],
    tools: OpenAITool[],
    signal: AbortSignal | undefined,
    outputTokenBudget: number,
    timeoutMs: number,
    reasoning?: ReasoningBound,
    rateLimitPatience?: RateLimitPatience,
  ): Promise<CompletionAttempt> {
    let selectedFields: Record<string, unknown>;
    try {
      selectedFields = modelReasoningRequestFields(
        this.modelControls,
        this.modelBehavior,
        "chat-completions",
      );
    } catch (err) {
      return {
        kind: "error",
        code: "http_reasoning_options_invalid",
        message:
          err instanceof Error ? err.message : "The selected reasoning options cannot be sent.",
      };
    }
    const selected = Object.keys(selectedFields).length > 0;
    const variants: Array<{ stream: boolean; streamOptions: boolean }> = [];
    if (!this.streamingUnsupported) {
      if (!this.streamOptionsUnsupported) variants.push({ stream: true, streamOptions: true });
      variants.push({ stream: true, streamOptions: false });
    }
    variants.push({ stream: false, streamOptions: false });

    let lastError: DecodedHttpError | undefined;
    /**
     * This call has already given up its bound after a rejection it could not
     * read.
     *
     * Separate from the monotonic flag on purpose. A server that names the
     * field is telling us something durable and earns the flag; a 400 we cannot
     * classify might be about anything, so the bound is dropped for this call
     * and offered again on the next one rather than lost for the backend's life
     * on one ambiguous answer.
     */
    let withdrewThinking = false;
    for (const v of variants) {
      while (true) {
        const body: Record<string, unknown> = {
          model: this.model,
          messages,
          stream: v.stream,
          [this.completionLimitField]: outputTokenBudget,
        };
        if (v.stream && v.streamOptions) body.stream_options = { include_usage: true };
        if (tools.length > 0) body.tools = tools;
        Object.assign(body, selectedFields);
        // Reasoning and the answer share `outputTokenBudget`, so the budget is
        // computed against it rather than against what the caller asked for: a
        // bound set at the whole budget relocates the failure instead of
        // preventing it. Recomputed per request rather than fixed for the turn,
        // because unlike a provider that states its output ceiling up front,
        // this one's budget is discovered — it widens once the server is seen to
        // emit reasoning at all — and a bound frozen against the narrowest
        // budget the turn ever had would bind nothing for the rest of it.
        // `undefined` means no bound worth having fits, and the request goes out
        // unbounded rather than under one nobody chose.
        const thinkingBudget =
          selected || this.thinkingBudgetUnsupported || withdrewThinking
            ? undefined
            : thinkingBudgetTokens(reasoning, outputTokenBudget);
        if (thinkingBudget !== undefined) {
          body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
          if (!this.boundedLogged) {
            this.boundedLogged = true;
            log.info(
              `model=${this.model} bounded to ${thinkingBudget} reasoning token(s) ` +
                `within an output budget of ${outputTokenBudget}`,
            );
          }
        } else if (reasoning && !selected && !this.thinkingBudgetUnsupported && !withdrewThinking) {
          if (!this.noRoomLogged) {
            this.noRoomLogged = true;
            log.info(
              `model=${this.model} asked for a ${reasoning.maxTokens}-token reasoning bound, but an ` +
                `output budget of ${outputTokenBudget} leaves no room for one; running unbounded`,
            );
          }
        }

        let res: Response;
        // Each attempt gets the whole response deadline: a rate-limit wait is
        // bounded by the turn's patience, and must not leave the retried
        // request less time to answer than the first one had.
        let deadline = AbortSignal.timeout(timeoutMs);
        try {
          res = await retryRateLimitedRequest(
            (attempt) => {
              if (attempt > 1) deadline = AbortSignal.timeout(timeoutMs);
              return this.post(body, signal, deadline);
            },
            {
              ...rateLimitPatience,
              ...(signal ? { signal } : {}),
              onRetry: ({ attempt, delayMs }) =>
                log.warn(
                  `completion rate-limited for model=${this.model}; ` +
                    `retrying attempt ${attempt} after ${delayMs}ms`,
                ),
            },
          );
        } catch {
          if (signal?.aborted) {
            return {
              kind: "error",
              code: "answer_canceled",
              message: "Model request canceled.",
            };
          }
          if (deadline.aborted) {
            return {
              kind: "error",
              code: "http_request_timeout",
              message: `The model did not respond within ${formatTimeoutSeconds(timeoutMs)} seconds.`,
            };
          }
          return {
            kind: "error",
            code: "http_request_error",
            message: "HTTP model request failed.",
          };
        }

        if (res.ok) {
          if (!v.stream) this.streamingUnsupported = true;
          else if (!v.streamOptions) this.streamOptionsUnsupported = true;
          return v.stream
            ? { kind: "stream", response: res, deadline }
            : this.adaptNonStreamed(res, deadline, signal, timeoutMs);
        }

        try {
          lastError = await decodeHttpError(res);
        } catch {
          if (signal?.aborted) {
            return { kind: "error", code: "answer_canceled", message: "Model request canceled." };
          }
          if (deadline.aborted) {
            return {
              kind: "error",
              code: "http_request_timeout",
              message: `The model did not respond within ${formatTimeoutSeconds(timeoutMs)} seconds.`,
            };
          }
          return {
            kind: "error",
            code: "http_request_error",
            message: "HTTP model request failed.",
          };
        }
        if (signal?.aborted) {
          return { kind: "error", code: "answer_canceled", message: "Model request canceled." };
        }
        if (deadline.aborted) {
          return {
            kind: "error",
            code: "http_request_timeout",
            message: `The model did not respond within ${formatTimeoutSeconds(timeoutMs)} seconds.`,
          };
        }
        log.warn(
          `completion rejected for model=${this.model} ${describeDecodedHttpError(lastError)}`,
        );
        if (lastError.contextWindowExceeded) {
          return {
            kind: "error",
            code: "context_window_exceeded",
            message: lastError.publicMessage,
            provider: providerFailureDetail(lastError),
          };
        }
        if (lastError.protocolMismatch) {
          return {
            kind: "error",
            code: "http_protocol_mismatch",
            message: lastError.publicMessage,
            provider: providerFailureDetail(lastError),
          };
        }
        // Withdraw the bound before anything else, and only when this request
        // actually carried one — a model id containing the word would otherwise
        // match the wording on a turn that never asked to be bounded.
        //
        // Two strengths of evidence. A server that names the field is stating a
        // fact about itself, so the whole backend stops offering one. Any other
        // rejection we cannot classify is treated as *possibly* about the field:
        // the bound is dropped for this call and the request re-issued, because
        // the shapes servers use to say "I do not take that" are too varied to
        // enumerate — a rejection rendered field-name-first, or across lines, or
        // as a validation-error list, would otherwise ride the whole variant
        // ladder and take the turn down with it. That would make an opt-in
        // latency knob into a switch that breaks every compile on such a server,
        // which is the one outcome a bound must never produce.
        if (body.thinking !== undefined && !selected) {
          if (lastError.unsupportedThinkingField) {
            this.thinkingBudgetUnsupported = true;
            log.info(`model=${this.model} does not accept a thinking budget; running unbounded`);
            continue;
          }
          if (lastError.status === 400 || lastError.status === 422) {
            withdrewThinking = true;
            log.info(
              `model=${this.model} rejected a request carrying a thinking budget ` +
                `(status ${lastError.status}); retrying this call without one`,
            );
            continue;
          }
        }
        if (lastError.unsupportedOutputLimitField === this.completionLimitField) {
          if (this.completionLimitField === "max_tokens") {
            this.completionLimitField = "max_completion_tokens";
            continue;
          }
          return {
            kind: "error",
            code: "http_api_error",
            message: "The model API cannot enforce an output-token limit.",
            provider: providerFailureDetail(lastError),
          };
        }
        break;
      }
      // Only a 400/422 is plausibly a request-shape problem worth retrying with
      // a different shape; any other status (401/404/429/5xx) is terminal.
      if (lastError.status !== 400 && lastError.status !== 422) break;
    }

    return {
      kind: "error",
      code: "http_api_error",
      message: lastError?.publicMessage ?? "Model API request failed.",
      ...(lastError ? { provider: providerFailureDetail(lastError) } : {}),
    };
  }

  /** Read a non-streamed completion into the same shape the SSE path yields. */
  private async adaptNonStreamed(
    res: Response,
    deadline: AbortSignal,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<CompletionAttempt> {
    let json: OpenAINonStreamedResponse;
    try {
      json = (await res.json()) as OpenAINonStreamedResponse;
    } catch (err) {
      if (signal?.aborted) {
        return { kind: "error", code: "answer_canceled", message: "Model request canceled." };
      }
      if (deadline.aborted) {
        return {
          kind: "error",
          code: "http_request_timeout",
          message: `The model did not respond within ${formatTimeoutSeconds(timeoutMs)} seconds.`,
        };
      }
      // The parse error's own message quotes the offending input, and that
      // input is the model's answer — corpus-derived. Report the condition,
      // not the excerpt: this message is forwarded to external callers and
      // spoken aloud by the voice surfaces.
      void err;
      return {
        kind: "error",
        code: "http_stream_error",
        message: "The model returned a response Omnesis could not parse.",
      };
    }
    const choice = json.choices?.[0];
    const message = choice?.message;
    const split = splitCompletionContent(message?.content);
    const toolCalls: OpenAIToolCall[] = (message?.tool_calls ?? []).map((tc) => {
      const call: OpenAIToolCall = {
        id: tc.id,
        type: "function",
        function: { name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" },
      };
      if (tc.extra_content !== undefined) call.extra_content = tc.extra_content;
      return call;
    });
    return {
      kind: "json",
      content: split.text,
      reasoning: (message?.reasoning_content ?? message?.reasoning ?? split.thinking) || undefined,
      reasoningDetails: reasoningDetails(message?.reasoning_details),
      toolCalls,
      finishReason: choice?.finish_reason ?? null,
      usage: {
        prompt: json.usage?.prompt_tokens ?? 0,
        completion: json.usage?.completion_tokens ?? 0,
        cachedInput: cachedInputTokens(json.usage),
        reasoning: json.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      },
    };
  }

  private post(
    body: Record<string, unknown>,
    signal?: AbortSignal,
    deadline = AbortSignal.timeout(this.timeoutMs),
  ): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    return fetchWithInferenceUrlPolicy(
      `${this.baseUrl}${this.apiPathPrefix}/chat/completions`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      },
      { allowRemoteInference: this.allowRemoteInference },
    );
  }
}

function formatTimeoutSeconds(timeoutMs: number): string {
  return Number.isInteger(timeoutMs / 1_000)
    ? String(timeoutMs / 1_000)
    : (timeoutMs / 1_000).toFixed(1);
}

function initialHttpContextAssessment(
  limits: ModelTokenLimits,
  reservedOutputTokens: number,
): AgentContextAssessment {
  const hasConfiguredLimit =
    limits.maxInputTokens !== undefined || limits.contextWindowTokens !== undefined;
  return {
    ...(limits.maxInputTokens === undefined ? {} : { maxInputTokens: limits.maxInputTokens }),
    ...(limits.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: limits.contextWindowTokens }),
    reservedOutputTokens,
    measurement: "unknown",
    limitSource: hasConfiguredLimit ? "configured" : "unknown",
    requestIteration: 1,
  };
}

function beginHttpContextIteration(
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

function recordHttpContextInput(
  previous: AgentContextAssessment,
  inputTokens: number,
  requestIteration: number,
): AgentContextAssessment {
  return {
    ...previous,
    inputTokens,
    peakInputTokens: Math.max(previous.peakInputTokens ?? 0, inputTokens),
    measurement: "provider_reported",
    requestIteration,
  };
}

// ─── Conversion helpers (exported for testing) ──────────────────────────

export function convertHistoryToOpenAI(
  history: ReadonlyArray<ChatMessage>,
  userMessage: string,
  systemPrompt: string,
  replayReasoningContent = false,
  replayReasoningDetails = false,
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [{ role: "system", content: systemPrompt }];

  for (const msg of history) {
    if (msg.role === "user") {
      // User parts can contain text and tool_result entries. Tool results
      // become separate `role: "tool"` messages; text becomes a user message.
      const textParts: string[] = [];
      for (const part of msg.parts) {
        if (part.kind === "text") {
          textParts.push(part.text);
        } else if (part.kind === "tool_result") {
          out.push({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: JSON.stringify(part.result),
          });
        }
      }
      if (textParts.length > 0) {
        out.push({ role: "user", content: textParts.join("\n") });
      }
    } else {
      // Assistant: text parts become content; tool_use parts become tool_calls.
      // Thinking parts are dropped except for models that require replay.
      // A tool_use part's opaque `extraContent` (e.g. a Gemini thought_signature)
      // is replayed verbatim as the tool call's `extra_content` so a multi-turn
      // reasoning conversation stays valid across turns. See #510.
      const textParts: string[] = [];
      const thinkingParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];

      for (const part of msg.parts) {
        if (part.kind === "text") {
          textParts.push(part.text);
        } else if (part.kind === "thinking" && replayReasoningContent) {
          thinkingParts.push(part.text);
        } else if (part.kind === "tool_use") {
          const call: OpenAIToolCall = {
            id: part.toolCallId,
            type: "function",
            function: {
              name: part.tool,
              arguments: JSON.stringify(part.args),
            },
          };
          if (part.extraContent !== undefined) call.extra_content = part.extraContent;
          toolCalls.push(call);
        }
        // Most providers reject reasoning text in history. Only models that
        // require its exact tool-call replay receive it below.
      }

      const assistantMsg: OpenAIMessage = {
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("\n") : null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      if (toolCalls.length > 0 && replayReasoningDetails) {
        const toolPart = msg.parts.find(
          (part) => part.kind === "tool_use" && part.reasoningDetails?.length,
        );
        if (toolPart?.kind === "tool_use") {
          const details = reasoningDetails(toolPart.reasoningDetails);
          if (details?.length) assistantMsg.reasoning_details = details;
        }
      }
      if (thinkingParts.length > 0) assistantMsg.reasoning_content = thinkingParts.join("");
      out.push(assistantMsg);
    }
  }

  out.push({ role: "user", content: userMessage });
  return out;
}

export function convertToolsToOpenAI(tools: ReadonlyArray<ToolHandle>): OpenAITool[] {
  return tools.map((h) => ({
    type: "function" as const,
    function: {
      name: h.name,
      description: h.description,
      parameters: zodToJsonSchema(h.schema) as Record<string, unknown>,
    },
  }));
}

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Parse a fetch Response body as an SSE stream, yielding parsed JSON
 * chunks. Handles the `data: [DONE]` sentinel and multi-line SSE frames.
 */
async function* parseSSEStream(response: Response): AsyncGenerator<OpenAIStreamChunk> {
  const reader = response.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // Keep the last (potentially incomplete) line in the buffer.
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;

        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();

        if (data === "[DONE]") return;

        try {
          const chunk = JSON.parse(data) as OpenAIStreamChunk;
          yield chunk;
        } catch {
          log.warn(`failed to parse SSE chunk: ${data.slice(0, 200)}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
