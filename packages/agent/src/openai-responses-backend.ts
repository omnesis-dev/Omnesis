// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `OpenAIResponsesBackend` — an agent backend that speaks the OpenAI
 * **Responses API** (`POST /v1/responses`) instead of Chat Completions.
 *
 * Some OpenAI chat-capable models — `o1-pro`, `gpt-5-pro`, the deep-research
 * models — are served *only* through this protocol and 404 on
 * `/v1/chat/completions`. This backend lets such a model drive the same agent
 * loop: it emits the identical `agent.*` event stream as {@link HttpChatBackend}
 * (text/thinking deltas, tool start/result, message end, error), so the
 * session, portal, and iOS need zero changes.
 *
 * Wire shape (vs. chat-completions):
 *   - Request: `{ model, input, instructions, tools, stream }` where `input`
 *     is an array of typed items and `instructions` is the system prompt.
 *     Tools are flat `{ type: "function", name, description, parameters }`.
 *   - Stream: a typed SSE event taxonomy keyed by each frame's `type`
 *     (`response.output_text.delta`, `response.function_call_arguments.delta`,
 *     `response.output_item.added/done`, `response.completed`, …) rather than
 *     `choices[].delta`.
 *   - Usage: `usage.input_tokens` / `usage.output_tokens`, with the
 *     cache-hit subset in `usage.input_tokens_details.cached_tokens`
 *     (split out into `cacheReadTokens`, chat-completions convention).
 *
 * Tool loop: within a turn we continue with `previous_response_id` + the new
 * `function_call_output` items, which keeps the model's server-side reasoning
 * context intact across tool rounds without replaying encrypted reasoning. The
 * first request of a turn rebuilds the conversation from canonical history as
 * input items.
 */

import {
  createLogger,
  createThinkTagFilter,
  fetchWithInferenceUrlPolicy,
  normalizeApiPathPrefix,
  retryRateLimitedRequest,
  type AgentContextAssessment,
  type AgentEvent,
  type ToolResult,
} from "@omnesis/core";

import { zodToJsonSchema } from "./zod-to-json-schema.js";
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
  DEFAULT_HTTP_CONTEXT_SAFETY_MARGIN_TOKENS,
  decodeHttpError,
  describeDecodedHttpError,
  providerFailureDetail,
  isContextWindowHttpError,
  type DecodedHttpError,
} from "./http-error.js";
import { CONTEXT_WINDOW_EXCEEDED_MESSAGE, OUTPUT_TRUNCATED_MESSAGE } from "./turn-outcome.js";
import {
  initialHttpOutputBudget,
  ORDINARY_HTTP_TIMEOUT_MS,
  EXTENDED_HTTP_TIMEOUT_MS,
  retryHttpOutputBudget,
} from "./http-output-budget.js";
import type { ModelTokenLimits, ModelControls, ModelBehaviorValues } from "@omnesis/core/models";
import type { ChatBackend, ChatMessage, ToolHandle, TurnInput } from "./backend.js";

const log = createLogger("agent:http-responses");

// ─── Responses wire types (subset we build / consume) ────────────────────

/** An input item sent to the Responses API. */
type ResponsesInputItem =
  | { role: "user" | "assistant"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface ResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** A parsed SSE frame; every Responses event carries a discriminating `type`. */
interface ResponsesEvent {
  type: string;
  delta?: string;
  item_id?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    id?: string;
    status?: string;
    error?: { message?: string; type?: string; code?: string; param?: string } | null;
    incomplete_details?: { reason?: string } | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
  error?: { message?: string; type?: string; code?: string; param?: string } | null;
  message?: string;
  code?: string;
  param?: string;
}

/** A function call collected from one Responses turn. */
interface ResponsesFunctionCall {
  callId: string;
  name: string;
  arguments: string;
}

// ─── Public API ──────────────────────────────────────────────────────────

export interface OpenAIResponsesBackendOptions {
  baseUrl: string;
  model: string;
  apiPathPrefix?: string;
  maxToolIterations?: number;
  timeoutMs?: number;
  apiKey?: string;
  allowRemoteInference?: boolean;
  modelLimits?: ModelTokenLimits;
  contextSafetyMarginTokens?: number;
  modelControls?: ModelControls;
  modelBehavior?: ModelBehaviorValues;
}

/**
 * A reasoning bound (`TurnInput.reasoning`) is not expressed here — see #70.
 * This API takes an effort level rather than a token budget, so honouring the
 * bound means giving it a form both can carry.
 */
export class OpenAIResponsesBackend implements ChatBackend {
  readonly name = "http";
  readonly model: string;

  private readonly baseUrl: string;
  private readonly apiPathPrefix: string;
  private readonly maxToolIterations: number;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;
  private readonly allowRemoteInference: boolean;
  private readonly modelLimits: ModelTokenLimits;
  private readonly modelControls?: ModelControls;
  private readonly modelBehavior?: ModelBehaviorValues;
  private readonly extendedOutputTimeoutMs: number;
  private readonly contextSafetyMarginTokens: number;
  private inputTokenCounting: "unknown" | "supported" | "unsupported" = "unknown";
  private observedExtendedOutput = false;

  constructor(opts: OpenAIResponsesBackendOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiPathPrefix = normalizeApiPathPrefix(opts.apiPathPrefix);
    this.model = opts.model;
    this.maxToolIterations = opts.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    this.timeoutMs = opts.timeoutMs ?? ORDINARY_HTTP_TIMEOUT_MS;
    this.extendedOutputTimeoutMs = opts.timeoutMs ?? EXTENDED_HTTP_TIMEOUT_MS;
    this.apiKey = opts.apiKey;
    this.allowRemoteInference = opts.allowRemoteInference === true;
    this.modelLimits = opts.modelLimits ?? {};
    this.modelControls = opts.modelControls;
    this.modelBehavior = opts.modelBehavior;
    this.contextSafetyMarginTokens =
      opts.contextSafetyMarginTokens ?? DEFAULT_HTTP_CONTEXT_SAFETY_MARGIN_TOKENS;
  }

  async *runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const { sessionId, messageId, timeZone, caller } = input;
    yield wrapEvent("agent.message.start", { sessionId, messageId, role: "assistant" });

    const tools = convertToolsToResponses(input.tools);
    const handles = new Map<string, ToolHandle>(input.tools.map((h) => [h.name, h]));
    const { instructions, input: initialInput } = convertHistoryToResponsesInput(
      input.history,
      input.userMessage,
      input.systemPrompt,
    );

    const totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const initialOutputTokenBudget = initialHttpOutputBudget(
      this.observedExtendedOutput,
      this.modelLimits.maxOutputTokens,
    );
    let contextAssessment = initialResponsesContextAssessment(
      this.modelLimits,
      initialOutputTokenBudget,
      this.contextSafetyMarginTokens,
    );
    let selectedFields: Record<string, unknown>;
    try {
      selectedFields = modelReasoningRequestFields(
        this.modelControls,
        this.modelBehavior,
        "responses",
      );
    } catch (err) {
      const code = "http_reasoning_options_invalid";
      const message =
        err instanceof Error ? err.message : "The selected reasoning options cannot be sent.";
      yield wrapEvent("agent.error", { sessionId, messageId, code, message });
      yield wrapEvent("agent.message.end", {
        sessionId,
        messageId,
        stopReason: "error",
        usage: totalUsage,
        context: contextAssessment,
        failure: { code, message, retryable: false, backend: this.name, model: this.model },
      });
      return;
    }
    // First request carries the full rebuilt conversation; later rounds carry
    // only the new tool outputs and continue from the prior response.
    let nextInput: ResponsesInputItem[] = initialInput;
    let previousResponseId: string | undefined;
    let requestIteration = 0;
    let retryNextRequest = false;
    let usedEmptyLengthRetry = false;

    for (let iter = 0; iter < this.maxToolIterations; iter++) {
      requestIteration += 1;
      const extendedOutput = retryNextRequest || this.observedExtendedOutput;
      const outputTokenBudget = retryNextRequest
        ? retryHttpOutputBudget(this.modelLimits.maxOutputTokens)
        : initialHttpOutputBudget(this.observedExtendedOutput, this.modelLimits.maxOutputTokens);
      const generationTimeoutMs = extendedOutput ? this.extendedOutputTimeoutMs : this.timeoutMs;
      retryNextRequest = false;
      contextAssessment = beginResponsesContextIteration(contextAssessment, requestIteration);
      contextAssessment = { ...contextAssessment, reservedOutputTokens: outputTokenBudget };
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

      const body: Record<string, unknown> = {
        model: this.model,
        input: nextInput,
        instructions,
        stream: true,
        truncation: "disabled",
        max_output_tokens: outputTokenBudget,
      };
      if (tools.length > 0) body.tools = tools;
      if (previousResponseId) body.previous_response_id = previousResponseId;
      Object.assign(body, selectedFields);

      const countedInput = await this.countInputTokens(body, signal);
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
      if (countedInput !== undefined) {
        contextAssessment = recordResponsesContextInput(
          contextAssessment,
          countedInput,
          "provider_count",
          requestIteration,
        );
        if (
          exceedsResponsesContext(
            countedInput,
            outputTokenBudget,
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
      }

      // The inference span starts here, after the token-count pre-check:
      // only the model request itself counts as inference wall time.
      const llmReq = startLlmRequest(input.llmProbe, requestIteration);
      let res: Response;
      // Each attempt gets the whole response deadline: a rate-limit wait is
      // bounded by the turn's patience, and must not leave the retried request
      // less time to answer than the first one had.
      let deadline = AbortSignal.timeout(generationTimeoutMs);
      try {
        res = await retryRateLimitedRequest(
          (attempt) => {
            if (attempt > 1) deadline = AbortSignal.timeout(generationTimeoutMs);
            return this.post(body, deadline, signal);
          },
          {
            ...input.rateLimitPatience,
            ...(signal ? { signal } : {}),
            onRetry: ({ attempt, delayMs }) =>
              log.warn(
                `response rate-limited for model=${this.model}; ` +
                  `retrying attempt ${attempt} after ${delayMs}ms`,
              ),
          },
        );
      } catch {
        // The request was attempted but produced no stream: close the span
        // without tokens so the wall time is still accounted.
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
        const timedOut = deadline.aborted;
        const code = timedOut ? "http_request_timeout" : "http_request_error";
        const message = timedOut
          ? `The model did not respond within ${formatTimeoutSeconds(generationTimeoutMs)} seconds.`
          : "HTTP model request failed.";
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

      if (!res.ok) {
        // The request failed: close its span without tokens. Every path
        // below returns out of the turn, so one close covers them all.
        llmReq.end();
        let error: DecodedHttpError;
        try {
          error = await decodeHttpError(res);
        } catch {
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
          const code = deadline.aborted ? "http_request_timeout" : "http_request_error";
          const message = deadline.aborted
            ? `The model did not respond within ${formatTimeoutSeconds(generationTimeoutMs)} seconds.`
            : "HTTP model request failed.";
          yield wrapEvent("agent.error", { sessionId, messageId, code, message });
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
        if (deadline.aborted) {
          const code = "http_request_timeout";
          const message = `The model did not respond within ${formatTimeoutSeconds(generationTimeoutMs)} seconds.`;
          yield wrapEvent("agent.error", { sessionId, messageId, code, message });
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
        log.warn(`response rejected for model=${this.model} ${describeDecodedHttpError(error)}`);
        const code = error.contextWindowExceeded ? "context_window_exceeded" : "http_api_error";
        const message = error.publicMessage;
        yield wrapEvent("agent.error", {
          sessionId,
          messageId,
          code,
          message,
          provider: providerFailureDetail(error),
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
            retryable: !error.contextWindowExceeded,
            backend: this.name,
            model: this.model,
            provider: providerFailureDetail(error),
          },
        });
        return;
      }

      // Parse the stream: accumulate text + function-call args, track the
      // response id (for the next round) and usage.
      const thinkFilter = createThinkTagFilter();
      const callsByItem = new Map<string, ResponsesFunctionCall>();
      let responseId: string | undefined;
      let streamFailure:
        | { code: string; message: string; contextWindowExceeded: boolean }
        | undefined;
      let incompleteReason: string | undefined;
      let visibleOutput = "";
      let iterationUsage = { input: 0, output: 0, cachedInput: 0 };

      try {
        for await (const ev of parseResponsesSSE(res)) {
          if (signal?.aborted) break;
          switch (ev.type) {
            case "response.output_text.delta": {
              const delta = ev.delta ?? "";
              const tail = thinkFilter.push(delta);
              if (thinkFilter.sawThinking) this.observedExtendedOutput = true;
              if (tail) {
                visibleOutput += tail;
                llmReq.markContent();
                yield wrapEvent("agent.text.delta", { sessionId, messageId, delta: tail });
              }
              break;
            }
            case "response.reasoning_summary_text.delta": {
              // Reasoning summary (only streamed by verified orgs). Surface it
              // as thinking; never fed back as input.
              if (ev.delta) {
                this.observedExtendedOutput = true;
                llmReq.markContent();
                yield wrapEvent("agent.thinking.delta", { sessionId, messageId, delta: ev.delta });
              }
              break;
            }
            case "response.output_item.added": {
              if (ev.item?.type === "reasoning") this.observedExtendedOutput = true;
              if (ev.item?.type === "function_call" && ev.item.id && ev.item.call_id) {
                llmReq.markContent();
                callsByItem.set(ev.item.id, {
                  callId: ev.item.call_id,
                  name: ev.item.name ?? "",
                  arguments: ev.item.arguments ?? "",
                });
              }
              break;
            }
            case "response.function_call_arguments.delta": {
              const call = ev.item_id ? callsByItem.get(ev.item_id) : undefined;
              if (call) call.arguments += ev.delta ?? "";
              break;
            }
            case "response.output_item.done": {
              if (ev.item?.type === "reasoning") this.observedExtendedOutput = true;
              // The done item carries the fully-assembled arguments — prefer it
              // over the delta accumulation (handles non-streamed arg cases).
              if (ev.item?.type === "function_call" && ev.item.id && ev.item.call_id) {
                // A call delivered solely via `done` (no prior `added`)
                // still counts as first content for TTFT.
                llmReq.markContent();
                callsByItem.set(ev.item.id, {
                  callId: ev.item.call_id,
                  name: ev.item.name ?? callsByItem.get(ev.item.id)?.name ?? "",
                  arguments: ev.item.arguments ?? callsByItem.get(ev.item.id)?.arguments ?? "",
                });
              }
              break;
            }
            case "response.completed":
            case "response.incomplete": {
              if (ev.type === "response.incomplete") {
                incompleteReason = ev.response?.incomplete_details?.reason ?? "unknown";
              }
              responseId = ev.response?.id;
              {
                // `input_tokens` is the total input (cached + fresh); split the
                // cached portion out so it can be priced at the cache-hit rate,
                // matching the chat-completions backend's convention.
                const reportedInput = ev.response?.usage?.input_tokens;
                const input = reportedInput ?? 0;
                const cached = ev.response?.usage?.input_tokens_details?.cached_tokens ?? 0;
                if ((ev.response?.usage?.output_tokens_details?.reasoning_tokens ?? 0) > 0) {
                  this.observedExtendedOutput = true;
                }
                iterationUsage = {
                  input,
                  output: ev.response?.usage?.output_tokens ?? 0,
                  cachedInput: cached,
                };
                if (reportedInput !== undefined) {
                  contextAssessment = recordResponsesContextInput(
                    contextAssessment,
                    input,
                    "provider_reported",
                    requestIteration,
                  );
                }
              }
              break;
            }
            case "response.failed":
            case "error": {
              const providerError = ev.response?.error ?? ev.error;
              const contextWindowExceeded = isContextWindowHttpError({
                type: providerError?.type,
                code: providerError?.code ?? ev.code,
                param: providerError?.param ?? ev.param,
                message: providerError?.message ?? ev.message,
              });
              streamFailure = {
                code: contextWindowExceeded ? "context_window_exceeded" : "http_stream_error",
                message: contextWindowExceeded
                  ? CONTEXT_WINDOW_EXCEEDED_MESSAGE
                  : "HTTP model response stream failed.",
                contextWindowExceeded,
              };
              break;
            }
            default:
              break;
          }
        }
        const flushed = thinkFilter.flush();
        if (flushed) {
          visibleOutput += flushed;
          llmReq.markContent();
          yield wrapEvent("agent.text.delta", { sessionId, messageId, delta: flushed });
        }
      } catch (err) {
        void err;
        const timedOut = deadline.aborted;
        streamFailure = {
          code: timedOut ? "http_request_timeout" : "http_stream_error",
          message: timedOut
            ? "The model did not respond before the request deadline."
            : "HTTP model response stream failed.",
          contextWindowExceeded: false,
        };
      }
      totalUsage.inputTokens += Math.max(0, iterationUsage.input - iterationUsage.cachedInput);
      totalUsage.cacheReadTokens += iterationUsage.cachedInput;
      totalUsage.outputTokens += iterationUsage.output;
      // The request's stream is fully consumed: close its span. Tool
      // execution downstream is not inference.
      llmReq.end({
        inputTokens: Math.max(0, iterationUsage.input - iterationUsage.cachedInput),
        outputTokens: iterationUsage.output,
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
      if (streamFailure) {
        yield wrapEvent("agent.error", {
          sessionId,
          messageId,
          code: streamFailure.code,
          message: streamFailure.message,
        });
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: "error",
          usage: totalUsage,
          context: contextAssessment,
          failure: {
            code: streamFailure.code,
            message: streamFailure.message,
            retryable: !streamFailure.contextWindowExceeded,
            backend: this.name,
            model: this.model,
          },
        });
        return;
      }

      const calls = [...callsByItem.values()].filter((c) => c.callId && c.name);

      if (incompleteReason) {
        const outputTruncated = incompleteReason === "max_output_tokens";
        const retryOutputTokenBudget = retryHttpOutputBudget(this.modelLimits.maxOutputTokens);
        if (outputTruncated && visibleOutput.trim().length === 0 && calls.length === 0) {
          this.observedExtendedOutput = true;
        }
        if (
          outputTruncated &&
          visibleOutput.trim().length === 0 &&
          calls.length === 0 &&
          !usedEmptyLengthRetry &&
          retryOutputTokenBudget > outputTokenBudget &&
          !signal?.aborted
        ) {
          usedEmptyLengthRetry = true;
          retryNextRequest = true;
          iter -= 1;
          log.warn(
            `empty max-output response for model=${this.model}; retrying with a larger output budget`,
          );
          continue;
        }
        if (!outputTruncated) {
          yield wrapEvent("agent.error", {
            sessionId,
            messageId,
            code: "http_response_incomplete",
            message: "The model response ended before it completed.",
          });
        }
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: outputTruncated ? "max_tokens" : "error",
          usage: totalUsage,
          context: contextAssessment,
          failure: {
            code: outputTruncated ? "output_truncated" : "http_response_incomplete",
            message: outputTruncated
              ? OUTPUT_TRUNCATED_MESSAGE
              : "The model response ended before it completed.",
            retryable: !outputTruncated,
            backend: this.name,
            model: this.model,
          },
        });
        return;
      }

      if (calls.length === 0) {
        yield wrapEvent("agent.message.end", {
          sessionId,
          messageId,
          stopReason: "end_turn",
          usage: totalUsage,
          context: contextAssessment,
        });
        return;
      }

      // Run the tools, then continue the same response with their outputs.
      // A call whose arguments failed to parse is surfaced with `{}` args
      // and answered with an error result below instead of being invoked.
      // The raw argument string is echoed (truncated) inside that error
      // result — so it reaches the model and the persisted transcript — but
      // never the tool.start args field or the logs.
      const parsed = calls.map((c) => ({
        call: c,
        argsResult: parseToolArgs(c.arguments),
        handle: handles.get(c.name),
      }));

      for (const { call, argsResult, handle } of parsed) {
        const args = argsResult.ok ? argsResult.args : {};
        llmReq.markContent();
        yield wrapEvent("agent.tool.input_start", {
          sessionId,
          messageId,
          toolCallId: call.callId,
          tool: call.name,
        });
        yield wrapEvent("agent.tool.start", {
          sessionId,
          messageId,
          toolCallId: call.callId,
          tool: call.name,
          args,
          argsSummary: summarizeToolArgs(handle, args),
        });
      }

      const progress = new ToolProgressQueue<AgentEvent>();
      const toolResultsPromise = Promise.all(
        parsed.map(async ({ call, argsResult, handle }) => {
          const start = Date.now();
          let result: ToolResult;
          if (!handle) {
            result = { kind: "error", code: "unknown_tool", message: `no tool named ${call.name}` };
          } else if (!argsResult.ok) {
            result = toolArgsUnparseableResult(argsResult.error, call.arguments);
          } else {
            try {
              result = await handle.invoke(argsResult.args, {
                sessionId,
                messageId,
                abortSignal: signal,
                timeZone,
                caller,
                ...childEventHooks({ sessionId, messageId, toolCallId: call.callId }, (event) =>
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
          return { call, result, durationMs: Date.now() - start };
        }),
      );
      void toolResultsPromise.finally(() => progress.close());
      for (;;) {
        const event = await progress.next();
        if (!event) break;
        yield event;
      }
      const toolResults = await toolResultsPromise;

      const nextItems: ResponsesInputItem[] = [];
      for (const r of toolResults) {
        yield wrapEvent("agent.tool.result", {
          sessionId,
          messageId,
          toolCallId: r.call.callId,
          result: r.result,
          durationMs: r.durationMs,
        });
        nextItems.push({
          type: "function_call_output",
          call_id: r.call.callId,
          output: JSON.stringify(r.result),
        });
      }

      // Continue from this response; send only the new tool outputs.
      previousResponseId = responseId;
      nextInput = nextItems;
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

  private async countInputTokens(
    createBody: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    if (this.inputTokenCounting === "unsupported") return undefined;
    const countBody = { ...createBody };
    delete countBody.stream;
    delete countBody.max_output_tokens;

    let response: Response;
    try {
      response = await this.postInputTokens(countBody, signal);
    } catch {
      return undefined;
    }
    if (!response.ok) {
      const error = await decodeHttpError(response);
      log.warn(
        `input-token count unavailable for model=${this.model} ${describeDecodedHttpError(error)}`,
      );
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        this.inputTokenCounting = "unsupported";
      }
      return undefined;
    }
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return undefined;
    }

    let inputTokens: unknown;
    try {
      const body = (await response.json()) as { input_tokens?: unknown };
      inputTokens = body.input_tokens;
    } catch {
      return undefined;
    }
    if (typeof inputTokens !== "number" || !Number.isInteger(inputTokens) || inputTokens < 0) {
      return undefined;
    }
    this.inputTokenCounting = "supported";
    return inputTokens;
  }

  private post(
    body: Record<string, unknown>,
    deadline: AbortSignal,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return fetchWithInferenceUrlPolicy(
      `${this.baseUrl}${this.apiPathPrefix}/responses`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      },
      { allowRemoteInference: this.allowRemoteInference },
    );
  }

  private postInputTokens(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return fetchWithInferenceUrlPolicy(
      `${this.baseUrl}${this.apiPathPrefix}/responses/input_tokens`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
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

function initialResponsesContextAssessment(
  limits: ModelTokenLimits,
  reservedOutputTokens: number,
  safetyMarginTokens: number,
): AgentContextAssessment {
  const hasConfiguredLimit =
    limits.maxInputTokens !== undefined || limits.contextWindowTokens !== undefined;
  return {
    ...(limits.maxInputTokens === undefined ? {} : { maxInputTokens: limits.maxInputTokens }),
    ...(limits.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: limits.contextWindowTokens }),
    reservedOutputTokens,
    safetyMarginTokens,
    measurement: "unknown",
    limitSource: hasConfiguredLimit ? "configured" : "unknown",
    requestIteration: 1,
  };
}

function beginResponsesContextIteration(
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

function recordResponsesContextInput(
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

function exceedsResponsesContext(
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

// ─── Conversion helpers (exported for testing) ───────────────────────────

/**
 * Rebuild the canonical history + new user message into Responses `input`
 * items, returning the system prompt separately as `instructions`.
 *
 * Thinking parts are dropped (the Responses reasoning items they'd map to are
 * not retained in canonical history). Assistant `tool_use` parts become
 * `function_call` items and the matching user `tool_result` parts become
 * `function_call_output` items, keyed by the shared call id.
 */
export function convertHistoryToResponsesInput(
  history: ReadonlyArray<ChatMessage>,
  userMessage: string,
  systemPrompt: string,
): { instructions: string; input: ResponsesInputItem[] } {
  const items: ResponsesInputItem[] = [];

  for (const msg of history) {
    if (msg.role === "user") {
      const textParts: string[] = [];
      for (const part of msg.parts) {
        if (part.kind === "text") {
          textParts.push(part.text);
        } else if (part.kind === "tool_result") {
          items.push({
            type: "function_call_output",
            call_id: part.toolCallId,
            output: JSON.stringify(part.result),
          });
        }
      }
      if (textParts.length > 0) items.push({ role: "user", content: textParts.join("\n") });
    } else {
      // Emit the assistant's spoken text before its tool calls, preserving the
      // turn's natural order (the model spoke, then called tools).
      const textParts: string[] = [];
      const calls: ResponsesInputItem[] = [];
      for (const part of msg.parts) {
        if (part.kind === "text") {
          textParts.push(part.text);
        } else if (part.kind === "tool_use") {
          calls.push({
            type: "function_call",
            call_id: part.toolCallId,
            name: part.tool,
            arguments: JSON.stringify(part.args),
          });
        }
        // "thinking" parts are intentionally skipped.
      }
      if (textParts.length > 0) items.push({ role: "assistant", content: textParts.join("\n") });
      items.push(...calls);
    }
  }

  items.push({ role: "user", content: userMessage });
  return { instructions: systemPrompt, input: items };
}

/** Convert tool handles into the flat Responses function-tool shape. */
export function convertToolsToResponses(tools: ReadonlyArray<ToolHandle>): ResponsesTool[] {
  return tools.map((h) => ({
    type: "function" as const,
    name: h.name,
    description: h.description,
    parameters: zodToJsonSchema(h.schema) as Record<string, unknown>,
  }));
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/**
 * Parse a Responses SSE body, yielding each frame's parsed `data:` JSON. The
 * Responses stream prefixes frames with an `event:` line too, but every
 * `data:` payload carries its own `type`, so we key off that and ignore the
 * `event:` line.
 */
export async function* parseResponsesSSE(response: Response): AsyncGenerator<ResponsesEvent> {
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
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          yield JSON.parse(data) as ResponsesEvent;
        } catch {
          log.warn(`failed to parse Responses SSE frame: ${data.slice(0, 200)}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
