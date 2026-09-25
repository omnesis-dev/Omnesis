// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `ChatBackend` is the only seam between the agent loop and a specific LLM.
 *
 * One implementation wraps the Anthropic Messages API (streaming + tool use).
 * Another reads a recorded `.jsonl` fixture and replays the events with
 * realistic pacing — used for tests, the portal demo, and zero-cost local
 * iteration. A future implementation will wrap any OpenAI-compatible
 * endpoint (llama-server, vLLM, Ollama) so a locally-hosted Qwen 3 etc.
 * runs the same loop.
 *
 * The backend's contract is narrow and deliberately stateless:
 *
 *   - Receives the canonical conversation history, the user's new message,
 *     and a registry of tool *handles* the model can invoke.
 *   - Orchestrates the entire tool-use loop internally (search → result →
 *     followup → result → final response). The session does not see the
 *     loop iterations — it sees a flat stream of events.
 *   - Yields `AgentEvent`s through an `AsyncIterable`. The session consumes
 *     them, updates its state, and re-emits to subscribers.
 *   - Honours `AbortSignal` cancellation.
 *
 * Why an async iterable rather than callbacks: the consumer (an `AgentSession`,
 * or a CLI driver, or a fixture recorder) can await events naturally and
 * `break` out on cancellation without an extra escape hatch.
 */

import type { z } from "zod";

import type { AgentEvent, DocRef, RateLimitPatience, ToolResult } from "@omnesis/core";

/** Shared default tool-loop ceiling for every production chat backend. */
export const DEFAULT_MAX_TOOL_ITERATIONS = 50;

/**
 * Whether a provider should mark a tool result as failed. Batch tools preserve
 * successful siblings alongside per-item errors, so checking only the
 * top-level kind would hide a partial failure from model runtimes that expose a
 * separate success/error signal.
 */
export function toolResultHasErrors(result: ToolResult): boolean {
  if (result.kind === "error") return true;
  if (
    result.kind === "search.batch" ||
    result.kind === "document.batch" ||
    result.kind === "annotate.batch"
  ) {
    return result.items.some((item) => item.kind === "error");
  }
  return false;
}

// ─── Tool handle ──────────────────────────────────────────────────────────

/**
 * A bound, invocable tool. The session/orchestrator builds these from the
 * tool *registry* (`tools/registry.ts`) and passes them to the backend per
 * turn. The backend translates the schema into whatever shape the model
 * provider expects (Anthropic tool blocks, OpenAI function calls, …) and
 * invokes `handle.invoke(args, ctx)` when the model emits a call.
 */
export interface ToolHandle {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<unknown>;
  /**
   * True when invoking this tool writes state (create/update/delete
   * anywhere). Delegated sub-agent tool sets drop every mutating tool
   * (`selectSubagentTools`), and so does the watch compiler's read-only
   * session — so this field is the only thing standing between a new write
   * tool and every surface that must not hold one. Declare it on the handle;
   * `builtin-tools.mutates.test.ts` reddens for a tool that does not.
   */
  readonly mutates?: boolean;
  invoke(args: unknown, ctx: ToolContext): Promise<ToolResult>;
  /**
   * Optional one-line summary of `args`, shown by every renderer (portal /
   * iOS / CLI) on the tool chip. Tools own this so a vendor-specific
   * shorthand (e.g. dropping the table prefix from a SQL string) stays
   * inside the tool, not in the backend.
   */
  summarize?(args: unknown): string | undefined;
}

/**
 * Who a turn speaks for, as far as a tool is concerned.
 *
 * Deliberately not a token or a device id: a tool needs to know which of the
 * gateway's two audiences it is answering, not how that audience authenticated.
 * The operator's own surfaces — the portal, the phone, a conversation they are
 * having — are one caller however many devices they hold; an off-host
 * integration is another, and which one it is decides what it may be shown of
 * other integrations' work.
 */
export type ToolCaller =
  /** The operator, through a surface of their own. */
  | { kind: "operator" }
  /** A named off-host integration, speaking only for itself. */
  | { kind: "integration"; slug: string };

/**
 * The caller a boundary that could not say who is asking must fall back to:
 * an integration whose name is the empty string, which is the narrowest
 * audience there is — it sees no watch at all.
 *
 * Reading the other way, an unidentified caller standing in for the operator,
 * would hand every watch on the install to any path that forgot to thread its
 * identity, and a path can only forget once. That bug shipped once already.
 *
 * The safety rests on a cross-package invariant: what this is compared against
 * is a watch's `delivery.integration`, and the watch DSL types that field as
 * `z.string().min(1).regex(/^[a-z][a-z0-9-]*$/)` — so no stored watch can name
 * the empty slug, and this caller matches nothing by construction. Both halves
 * are pinned by `unattributed-caller.test.ts`; loosening the DSL to accept an
 * empty integration name would turn this sentinel into a wildcard.
 */
export const UNATTRIBUTED_CALLER: Readonly<Extract<ToolCaller, { kind: "integration" }>> =
  Object.freeze({ kind: "integration", slug: "" });

export interface ToolContext {
  sessionId: string;
  messageId: string;
  abortSignal?: AbortSignal;
  /**
   * Who this turn speaks for, when the boundary that opened the session could
   * say. Tools that scope what they return by audience read it. Unset for
   * background work and test rigs, where a tool must fall back to whichever
   * treatment discloses least.
   */
  caller?: ToolCaller;
  /**
   * IANA zone of the caller this session belongs to, when their client sent
   * one. Time-aware tools resolve relative and date-only arguments against it
   * so a window like "today" is the user's day rather than the host machine's.
   * Unset for background work and test rigs, where the host's zone stands in.
   */
  timeZone?: string;
  /**
   * Per-child progress hooks for the batch tools (`search_many` /
   * `fetch_many` / `annotate_many`). A batch tool calls {@link onChildStart}
   * before dispatching each child and {@link onChildResult} when that child
   * settles, so the session can broadcast `agent.tool.child.*` events and each
   * client animates one live ephemeral card per child (concurrent lifecycles).
   * The single `tool_result` the tool returns is still the durable record; a
   * resumed conversation re-projects the cards from it. Unset for singular
   * tools and in test rigs — batch tools no-op when these are absent.
   */
  onChildStart?(child: { index: number; tool: string; argsSummary?: string }): void;
  onChildResult?(child: { index: number; result: ToolResult }): void;
}

// ─── Chat message (canonical history shape) ───────────────────────────────

/**
 * One turn of the conversation, as the session stores it. This is the
 * canonical shape the session passes to every backend; each backend
 * translates it into provider-native message blocks at the wire boundary.
 */
export type ChatMessage =
  | { role: "user"; parts: ReadonlyArray<UserPart> }
  | { role: "assistant"; parts: ReadonlyArray<AssistantPart> };

export type UserPart =
  | { kind: "text"; text: string }
  | { kind: "tool_result"; toolCallId: string; result: ToolResult };

export type AssistantPart =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool_use";
      toolCallId: string;
      tool: string;
      args: unknown;
      /**
       * Opaque provider metadata for this tool call (e.g. a Gemini
       * `thought_signature`), echoed back to the model verbatim when the
       * history is replayed on a later turn. Absent for providers that
       * don't emit one. See #510.
       */
      extraContent?: unknown;
      /** Opaque assistant-level reasoning blocks kept with the tool turn. */
      reasoningDetails?: unknown[];
    }
  | ReportArtifactPart;

/**
 * Durable record of a Deep Research run's verified-report artifact (#748),
 * persisted alongside the assistant message's report text so the artifact card
 * (the verification badge, the honest `stoppedReason`, the merged citations, the
 * whole-tree token total) survives a conversation reload. It carries exactly the
 * structured facts the live `agent.deep_research.summary` event delivers, plus
 * the merged `citations` that arrive live via `agent.citations.update` — so a
 * resumed transcript rebuilds the same card the live run rendered.
 *
 * It is never sent to a model: backends translate `tool_use`/`text`/`thinking`
 * parts into provider-native blocks and SKIP this one when serialising history
 * for the wire (it has no model-facing representation). The session appends it
 * only via `recordTurn`, the Deep Research write-back path.
 */
export interface ReportArtifactPart {
  kind: "report_artifact";
  /** Honest terminal reason (mirrors `DeepResearchStoppedReason`). */
  stoppedReason: string;
  /** The planner's decomposition — which specialist chased which slice. */
  plan: Array<{ specialist: string; title: string; task: string }>;
  /** Whole-tree token total at run end, if known. */
  treeUsage?: { inputTokens: number; outputTokens: number };
  /** Quote-verification tally from the citation-verify pass. */
  verification: { quotesChecked: number; quotesVerified: number };
  /** The single merged, deduped citation set (no per-sub-agent attribution). */
  citations: DocRef[];
}

// ─── LLM request probe ────────────────────────────────────────────────────

/**
 * Timing for one model request inside a turn. A turn with tool use makes
 * several sequential requests (one per tool-loop iteration); each one is
 * reported separately so callers can attribute wall time and tokens per
 * request rather than per turn.
 *
 * `ttftMs` is null when the request produced no content (an early error or
 * abort). Token counts are provider-reported and null when the backend
 * could not attribute them to this request.
 */
export interface LlmRequestTiming {
  requestIndex: number;
  ttftMs: number | null;
  wallMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Optional per-request timing sink, threaded through {@link TurnInput}. */
export type LlmProbe = (timing: LlmRequestTiming) => void;

export interface LlmRequestTracker {
  markContent(): void;
  end(tokens?: { inputTokens?: number; outputTokens?: number }): void;
}

/**
 * Report one timing span per turn for backends whose internal model calls
 * are opaque to the gateway (the runtime owns its own loop and surfaces a
 * single event stream). First content marks TTFT; the terminal
 * `message.end` (or the latest `usage.update`) supplies token counts.
 * A stream that ends without a terminal event is still closed, without
 * tokens. Pass-through when no probe is installed.
 */
export async function* probeTurnEvents(
  probe: LlmProbe | undefined,
  source: AsyncIterable<AgentEvent>,
): AsyncIterable<AgentEvent> {
  if (!probe) {
    yield* source;
    return;
  }
  const tracker = startLlmRequest(probe, 1);
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let seenEvent = false;
  try {
    for await (const event of source) {
      seenEvent = true;
      switch (event.type) {
        case "agent.text.delta":
        case "agent.thinking.delta":
          if (event.payload.delta) tracker.markContent();
          break;
        case "agent.tool.input_start":
        case "agent.tool.start":
          tracker.markContent();
          break;
        case "agent.usage.update":
          if (event.payload.usage) {
            const u = event.payload.usage;
            usage = {
              ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
              ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
            };
          }
          break;
        case "agent.message.end":
          if (event.payload.usage) {
            const u = event.payload.usage;
            usage = {
              ...(u.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
              ...(u.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
            };
          }
          tracker.end(usage);
          break;
        default:
          break;
      }
      yield event;
    }
  } finally {
    // A stream that threw or ended without a terminal event still closes
    // the span (end() is idempotent, so the normal path is unaffected).
    // A stream that yielded nothing at all made no request: no span.
    if (seenEvent) tracker.end(usage);
  }
}

/**
 * Start tracking one model request. When no probe is installed the tracker
 * is a no-op (it does not even read the clock), so production turns pay
 * nothing for profiling they did not ask for.
 */
export function startLlmRequest(
  probe: LlmProbe | undefined,
  requestIndex: number,
): LlmRequestTracker {
  if (!probe) return { markContent: () => {}, end: () => {} };
  const startMs = Date.now();
  let firstMs = 0;
  let ended = false;
  return {
    markContent(): void {
      if (firstMs === 0) firstMs = Date.now();
    },
    end(tokens?: { inputTokens?: number; outputTokens?: number }): void {
      if (ended) return;
      ended = true;
      const endMs = Date.now();
      probe({
        requestIndex,
        ttftMs: firstMs === 0 ? null : Math.max(0, firstMs - startMs),
        wallMs: Math.max(0, endMs - startMs),
        ...(tokens?.inputTokens !== undefined ? { inputTokens: tokens.inputTokens } : {}),
        ...(tokens?.outputTokens !== undefined ? { outputTokens: tokens.outputTokens } : {}),
      });
    },
  };
}

// ─── Backend interface ────────────────────────────────────────────────────

export interface TurnInput {
  sessionId: string;
  /** ID the session pre-allocates for the assistant message we're about to emit. */
  messageId: string;
  /** Full history prior to this turn. Does NOT include the new user message. */
  history: ReadonlyArray<ChatMessage>;
  /** The just-arrived user message text. */
  userMessage: string;
  /** Inline image inputs for vision-capable backends; callers check model support. */
  images?: ReadonlyArray<{ url: string }>;
  /** Tool handles the model may invoke. */
  tools: ReadonlyArray<ToolHandle>;
  /** Single-shot callers need the completed answer, excluding progress commentary. */
  finalAnswerOnly?: boolean;
  /**
   * Optional sink for per-request LLM timings. Backends report one entry
   * per model request they issue; absent means no timing is collected.
   */
  llmProbe?: LlmProbe;
  /** System prompt to send to the model. */
  systemPrompt: string;
  /**
   * IANA zone of the caller this turn belongs to. Forwarded verbatim onto
   * every {@link ToolContext} the backend builds; see the field there.
   */
  timeZone?: string;
  /**
   * Who this turn speaks for. Forwarded verbatim onto every
   * {@link ToolContext} the backend builds; see the field there.
   */
  caller?: ToolCaller;
  /**
   * A ceiling on how much this turn may reason before it answers.
   *
   * Absent — the ordinary case, and every interactive turn — the backend picks,
   * which on models that support it means letting the model decide. That is the
   * right default for a conversation: a hard question deserves a long think and
   * the person asking is watching it happen.
   *
   * It is the wrong default for a turn with a deadline and one JSON document to
   * produce. Measured over 88 watch compiles, the runs that missed their
   * deadline made the same handful of tool calls as the ones that finished and
   * then reasoned roughly three times as long, emitting six text deltas against
   * a median of nine hundred and fifty. They ran out of time deciding, not
   * working, and a ceiling converts some of those from no answer at all into an
   * answer.
   *
   * A hint rather than a contract: a backend that cannot express it runs the
   * turn unbounded, so a caller may set this and still get an unbounded turn.
   */
  reasoning?: ReasoningBound;
  /**
   * How long each model request of this turn may wait out a provider's rate
   * limit before the turn fails.
   *
   * Absent — every interactive turn — the backend keeps the short default, so
   * a person watching a reply is told about a quota promptly instead of
   * staring at a stalled turn. A task that runs unattended sets a longer one so
   * a quota that resets in a minute delays it rather than failing it.
   *
   * Honoured by the OpenAI-compatible chat-completions and Responses backends,
   * which issue their own HTTP requests; the Anthropic and Codex backends keep
   * their client's own retry policy.
   */
  rateLimitPatience?: RateLimitPatience;
}

/** How much a turn may reason before it has to answer. */
export interface ReasoningBound {
  /**
   * Tokens of reasoning, at most.
   *
   * Interpreted per backend against its own units. A backend whose budget must
   * clear a floor raises it rather than refusing the turn: the point of a bound
   * is to make a turn finish, so failing closed would take out the very compile
   * it exists to rescue.
   */
  readonly maxTokens: number;
}

export interface ChatBackend {
  readonly name: string;
  readonly model: string;

  /**
   * Run one user→assistant turn. Yields events ending in `agent.message.end`
   * (or `agent.error`). The session updates its history from the assistant
   * parts it observes in the stream — it does NOT re-fetch them from the
   * backend after the turn ends.
   */
  runTurn(input: TurnInput, signal?: AbortSignal): AsyncIterable<AgentEvent>;

  dispose?(): Promise<void>;
}

// ─── Helpers for backends to build events ─────────────────────────────────

/** Wrap a payload in the discriminated event shape used by the stream. */
export function wrapEvent<T extends AgentEvent["type"]>(
  type: T,
  payload: Extract<AgentEvent, { type: T }>["payload"],
): AgentEvent {
  return { type, payload } as AgentEvent;
}

/**
 * Build the {@link ToolContext} per-child progress hooks for a batch tool call.
 * A backend passes its own `emit` so the batch runner streams one
 * `agent.tool.child.*` pair per child as the children settle. Every production
 * backend wires these hooks through its progress queue. `toolCallId` is the
 * parent batch call; renderers key a live card by `(toolCallId, childIndex)`.
 */
export function childEventHooks(
  base: { sessionId: string; messageId: string; toolCallId: string },
  emit: (event: AgentEvent) => void,
): Pick<ToolContext, "onChildStart" | "onChildResult"> {
  return {
    onChildStart: (c) =>
      emit(
        wrapEvent("agent.tool.child.start", {
          sessionId: base.sessionId,
          messageId: base.messageId,
          toolCallId: base.toolCallId,
          childIndex: c.index,
          tool: c.tool,
          ...(c.argsSummary !== undefined ? { argsSummary: c.argsSummary } : {}),
        }),
      ),
    onChildResult: (c) =>
      emit(
        wrapEvent("agent.tool.child.result", {
          sessionId: base.sessionId,
          messageId: base.messageId,
          toolCallId: base.toolCallId,
          childIndex: c.index,
          result: c.result,
        }),
      ),
  };
}

/**
 * Minimal async queue for progress emitted while a backend awaits tool calls.
 *
 * The HTTP, Responses, and Anthropic backends are async generators: awaiting a
 * batch tool directly would otherwise hold its child-progress callbacks until
 * the whole batch completed. Closing the queue wakes the consumer after the
 * tool promises settle; queued events always drain before `undefined`.
 */
export class ToolProgressQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: T | undefined) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!(undefined);
  }

  next(): Promise<T | undefined> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

/** Parse a JSON string, returning `{}` on malformed input. */
export function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Parse a tool call's raw arguments string. An empty or whitespace-only
 * string is a legitimate no-argument call (providers send `""` — or omit the
 * field entirely — for tools without parameters), so it parses to `{}`.
 * Anything else must be valid JSON: a failure (truncated stream, wrapped or
 * double-encoded JSON) is surfaced to the caller so the backend can bounce
 * an error back to the model instead of silently invoking the tool with
 * fabricated `{}` arguments.
 */
export function parseToolArgs(
  raw: string,
): { ok: true; args: unknown } | { ok: false; error: string } {
  if (raw.trim().length === 0) return { ok: true, args: {} };
  try {
    return { ok: true, args: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: (err as Error).message ?? "invalid JSON" };
  }
}

/** Longest raw-arguments echo carried in a `tool_args_unparseable` result. */
const TOOL_ARGS_RAW_ECHO_MAX_CHARS = 2000;

/**
 * Fabricated `ToolResult` for a tool call whose arguments were not valid
 * JSON. Flows back to the model through the ordinary tool-result path —
 * the tool itself is never invoked. The raw string is echoed (truncated)
 * so the model can repair its own call; callers must not write it to logs,
 * where corpus PII riding tool arguments would leak.
 */
export function toolArgsUnparseableResult(parseError: string, raw: string): ToolResult {
  const echo =
    raw.length > TOOL_ARGS_RAW_ECHO_MAX_CHARS
      ? `${raw.slice(0, TOOL_ARGS_RAW_ECHO_MAX_CHARS)}… [truncated]`
      : raw;
  return {
    kind: "error",
    code: "tool_args_unparseable",
    message: `tool-call arguments were not valid JSON (${parseError}); raw arguments as received: ${echo}. Re-issue the call with complete JSON arguments.`,
  };
}

/**
 * Render a tool's args as a one-line summary. Lives server-side so every
 * renderer (portal / iOS / CLI) shows the same chip text. The tool itself
 * owns the per-tool shorthand via `ToolHandle.summarize`; unknown tools
 * (or tools that decline to summarize) fall back to a truncated JSON dump.
 */
export function summarizeToolArgs(handle: ToolHandle | undefined, args: unknown): string {
  const own = handle?.summarize?.(args);
  if (typeof own === "string") return own;
  if (!args || typeof args !== "object") return "";
  try {
    return JSON.stringify(args).slice(0, 120);
  } catch {
    return "";
  }
}
