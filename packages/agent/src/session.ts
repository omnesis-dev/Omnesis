// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `AgentSession` — one chat conversation, owned by a single device.
 *
 * Responsibilities:
 *   - Holds the canonical message history (in memory only, see v1 decisions).
 *   - Tracks the citations set: documents the agent explicitly cited via the
 *     `annotate` tool in the current turn, diffed against the previous turn
 *     to emit `agent.citations.update` events with the new in-scope set.
 *   - Drives one turn at a time by calling `backend.runTurn()`, intercepting
 *     events, updating its own state, and re-emitting the same events to
 *     any number of subscribers (the WS connection for the portal, a CLI,
 *     a fixture recorder, …).
 *
 * The session itself does not call any model. The backend does. The session
 * is the state machine that sits between the backend and the rest of the
 * gateway.
 */

import {
  createLogger,
  InferenceUrlPolicyError,
  type AgentEvent,
  type AgentMessageEndEvent,
  type AgentTerminalFailure,
  type Citation,
  type DocRef,
  type RateLimitPatience,
  type ToolResult,
} from "@omnesis/core";

import { CONTEXT_WINDOW_EXCEEDED_MESSAGE, OUTPUT_TRUNCATED_MESSAGE } from "./turn-outcome.js";
import type {
  AssistantPart,
  ChatBackend,
  ChatMessage,
  LlmProbe,
  ReportArtifactPart,
  ToolCaller,
  ReasoningBound,
  ToolHandle,
  UserPart,
} from "./backend.js";

const log = createLogger("agent:session");

/**
 * Who stopped a turn. `user` is the person pressing Stop; `system` is
 * everything else — an output cap, eviction, shutdown, a caller's deadline.
 */
export type CancelCause = "user" | "system";

/**
 * The transcript line a cancelled turn ends on, by cause. Written the way a
 * failed turn's breadcrumb is, so a stopped reply is durable in every
 * backend's history rather than leaving the conversation ending on the
 * user's own message. Only a Stop the user pressed may say the user did it.
 */
const CANCELED_TRANSCRIPT_MESSAGE: Record<CancelCause, string> = {
  user: "You stopped this reply.",
  system: "This reply was stopped.",
};

export interface SessionOptions {
  sessionId: string;
  backend: ChatBackend;
  tools: ReadonlyArray<ToolHandle>;
  systemPrompt: string;
  /** Generates IDs for messages and tool calls. Pluggable for deterministic tests. */
  idGen?: () => string;
  /**
   * Seed the conversation with a prior transcript. Used when the user
   * resumes a stored conversation — the in-memory session starts with
   * the saved messages so the next user message lands on top of the
   * existing context.
   */
  initialHistory?: ReadonlyArray<ChatMessage>;
  /**
   * IANA zone of the caller who opened this session, as their client
   * reported it. Rides every {@link ToolContext} so time-aware tools resolve
   * "today" against the user's calendar rather than the host machine's.
   */
  timeZone?: string;
  /**
   * Who opened this session, as the boundary resolved them. Rides every
   * {@link ToolContext} so a tool that scopes what it returns by audience
   * answers the caller in front of it rather than the most permissive one.
   */
  caller?: ToolCaller;
  /**
   * A ceiling on reasoning for every turn this session runs.
   *
   * Per session rather than per send: the sessions that want one want it for
   * their whole life — a watch compile is a throwaway conversation whose only
   * product is one JSON document — and a bound that varied turn to turn would
   * make the repair turns behave differently from the first attempt, which is
   * the opposite of what a compiler wants.
   *
   * Omitted by every interactive session, which is the point: see
   * {@link TurnInput.reasoning}.
   */
  reasoning?: ReasoningBound;
  /**
   * How long every turn of this session may wait out a provider rate limit.
   * Omitted by interactive sessions; see {@link TurnInput.rateLimitPatience}.
   */
  rateLimitPatience?: RateLimitPatience;
}

export interface SendOptions {
  /** External abort signal. Cancelling causes `agent.message.end { stopReason: "canceled" }`. */
  signal?: AbortSignal;
  /**
   * Optional sink for per-request LLM timings, forwarded to the backend.
   * Only profiling callers set this; every other turn leaves it absent.
   */
  llmProbe?: LlmProbe;
}

export type Subscriber = (event: AgentEvent) => void;

export class AgentSession {
  readonly sessionId: string;

  private readonly backend: ChatBackend;
  private readonly tools: ReadonlyArray<ToolHandle>;
  private readonly systemPrompt: string;
  private readonly idGen: () => string;
  private readonly zone: string | undefined;
  private readonly speaksFor: ToolCaller | undefined;
  /** A ceiling on reasoning for every turn, when this session asked for one. */
  private readonly reasoning: ReasoningBound | undefined;
  private readonly rateLimitPatience: RateLimitPatience | undefined;
  private readonly subscribers = new Set<Subscriber>();

  private history: ChatMessage[] = [];
  private citations = new Map<string, Citation>();
  private currentTurn: TurnState | null = null;

  constructor(opts: SessionOptions) {
    this.sessionId = opts.sessionId;
    this.backend = opts.backend;
    this.tools = opts.tools;
    this.systemPrompt = opts.systemPrompt;
    this.idGen = opts.idGen ?? defaultIdGen;
    this.zone = opts.timeZone;
    this.speaksFor = opts.caller;
    this.reasoning = opts.reasoning;
    this.rateLimitPatience = opts.rateLimitPatience;
    if (opts.initialHistory && opts.initialHistory.length > 0) {
      // Defensive copy: the caller may keep mutating its own copy
      // (we never do, but the API contract says we own the seed).
      this.history = opts.initialHistory.map(
        (m): ChatMessage =>
          m.role === "user"
            ? { role: "user", parts: [...m.parts] }
            : { role: "assistant", parts: [...m.parts] },
      );
      this.seedCitationsFromHistory();
    }
  }

  /**
   * Rebuild `citations` from a seeded `history`. Walks every assistant
   * `tool_use` whose tool is `annotate`, finds the matching user
   * `tool_result` (kind `annotate.recorded`), and aggregates entries by
   * documentId. Mirrors what portal/iOS clients do on conversation
   * resume so the session-level snapshot stays correct.
   */
  private seedCitationsFromHistory(): void {
    const pendingCites = new Map<string, { messageId: string }>();
    let assistantIdx = 0;
    for (const msg of this.history) {
      if (msg.role === "assistant") {
        const synthMessageId = `seed_${assistantIdx++}`;
        for (const part of msg.parts) {
          if (part.kind === "tool_use" && part.tool === "annotate_many") {
            pendingCites.set(part.toolCallId, { messageId: synthMessageId });
          }
        }
      } else {
        for (const part of msg.parts) {
          if (part.kind !== "tool_result") continue;
          const pending = pendingCites.get(part.toolCallId);
          if (!pending) continue;
          const recordedList = extractCitationsFromResult(part.result);
          if (recordedList.length === 0) {
            pendingCites.delete(part.toolCallId);
            continue;
          }
          recordedList.forEach((recorded, idx) => {
            this.appendCitationEntry({
              documentId: recorded.documentId,
              ref: recorded.ref,
              entry: {
                // Stable per-child id so a batch's children stay distinct
                // entries even when they cite the same document.
                toolCallId: recordedList.length > 1 ? `${part.toolCallId}#${idx}` : part.toolCallId,
                messageId: pending.messageId,
                quote: recorded.quote,
                quoteAuthor: recorded.quoteAuthor,
                quoteIsSelf: recorded.quoteIsSelf,
                note: recorded.note,
              },
            });
          });
          pendingCites.delete(part.toolCallId);
        }
      }
    }
  }

  private appendCitationEntry(input: {
    documentId: string;
    ref: DocRef;
    entry: Citation["entries"][number];
  }): Citation {
    const key = refKey(input.ref);
    const existing = this.citations.get(key);
    if (existing) {
      existing.entries.push(input.entry);
      return existing;
    }
    const created: Citation = {
      documentId: input.documentId,
      ref: input.ref,
      entries: [input.entry],
    };
    this.citations.set(key, created);
    return created;
  }

  /** Returns the model the backend reported. */
  get model(): string {
    return this.backend.model;
  }

  /** Returns the backend name (anthropic / replay / openai-compatible). */
  get backendName(): string {
    return this.backend.name;
  }

  /**
   * IANA zone of the caller this session belongs to, or undefined when none was
   * reported. The single source of truth for the session's zone: the prompt was
   * rendered in it and every tool call is framed in it, so a caller that reads
   * it here cannot drift out of step with either.
   */
  get timeZone(): string | undefined {
    return this.zone;
  }

  /**
   * Who this session speaks for, or undefined when the boundary could not say.
   * The single source of truth for the session's audience, read the same way
   * the zone is, so a tool and a caller-scoped read never disagree.
   */
  get caller(): ToolCaller | undefined {
    return this.speaksFor;
  }

  /** Snapshot of the current citations set, sorted by source then ID. */
  citationsSnapshot(): Citation[] {
    return [...this.citations.values()].sort((a, b) => {
      if (a.ref.sourceType !== b.ref.sourceType) {
        return a.ref.sourceType.localeCompare(b.ref.sourceType);
      }
      return a.documentId.localeCompare(b.documentId);
    });
  }

  /** Snapshot of the conversation history. Read-only. */
  historySnapshot(): ReadonlyArray<ChatMessage> {
    return this.history;
  }

  /**
   * Defensive snapshot for a client resuming this session while a turn is in
   * flight. Canonical history deliberately receives assistant/tool segments
   * only when they commit, but a newly attached client must see the partial
   * turn that existing SSE listeners already rendered. This method never
   * mutates or commits the turn; persistence must continue to use
   * {@link historySnapshot}.
   */
  liveHistorySnapshot(): ReadonlyArray<ChatMessage> {
    const snapshot = this.history.map(cloneChatMessage);
    const turn = this.currentTurn;
    if (!turn) return snapshot;
    snapshot.push(...turn.segments.map(cloneChatMessage));
    if (turn.pendingAssistantParts.length > 0) {
      snapshot.push({
        role: "assistant",
        parts: turn.pendingAssistantParts.map((part) => ({ ...part })),
      });
    }
    if (turn.pendingUserParts.length > 0) {
      snapshot.push({
        role: "user",
        parts: turn.pendingUserParts.map((part) => ({ ...part })),
      });
    }
    // `agent.message.start` carries no history part. If the snapshot is taken
    // before the first delta (or while the model is resuming after tool
    // results), preserve the open assistant structurally so post-cursor deltas
    // have a turn to extend after the HTTP/SSE hand-off.
    if (snapshot.at(-1)?.role !== "assistant") {
      snapshot.push({ role: "assistant", parts: [] });
    }
    return snapshot;
  }

  /**
   * Inject a completed user→assistant exchange into history WITHOUT running the
   * backend. The Deep Research orchestrator drives its own
   * plan→fan-out→verify→synthesis loop outside the normal turn loop, then calls
   * this so the parent conversation records the user's question and the final
   * synthesised report — which is what `persistConversation` + the omnesis-chat
   * write-back read. Intermediate sub-agent transcripts are never recorded here
   * (they live in throwaway child sessions), so only the final report is ever
   * written back. Throws if a normal turn is in flight (the caller guards the
   * session is idle first).
   *
   * When `reportArtifact` is supplied, a `report_artifact` assistant part is
   * appended alongside the report text so the verified-report card (verification
   * badge, honest stoppedReason, merged citations, token total) survives a
   * conversation reload — without it, the card lived only in the transient live
   * `agent.deep_research.summary` + `agent.citations.update` events and vanished
   * on resume.
   */
  recordTurn(userText: string, assistantText: string, reportArtifact?: ReportArtifactPart): void {
    if (this.currentTurn) {
      throw new Error("session is busy; cannot record a turn while one is in flight");
    }
    const assistantParts: AssistantPart[] = [{ kind: "text", text: assistantText }];
    if (reportArtifact) assistantParts.push(reportArtifact);
    this.history.push({ role: "user", parts: [{ kind: "text", text: userText }] });
    this.history.push({ role: "assistant", parts: assistantParts });
  }

  /**
   * Replace the visible assistant half of the most recently recorded turn.
   * Deep Research records its user turn immediately so it survives a reload,
   * then fills in the final report when its external orchestration settles.
   */
  replaceLastRecordedAssistantTurn(
    assistantText: string,
    reportArtifact?: ReportArtifactPart,
  ): void {
    if (this.currentTurn) throw new Error("session is busy; cannot replace a recorded turn");
    const last = this.history.at(-1);
    if (!last || last.role !== "assistant")
      throw new Error("no recorded assistant turn to replace");
    const parts: AssistantPart[] = [{ kind: "text", text: assistantText }];
    if (reportArtifact) parts.push(reportArtifact);
    this.history[this.history.length - 1] = { role: "assistant", parts };
  }

  /**
   * Replace the placeholder assistant half of an externally orchestrated turn
   * with the normal assistant/tool-result segments produced by a private
   * continuation. The continuation's private user prompt is intentionally not
   * included: callers retain the original user message already in history.
   */
  replaceLastRecordedAssistantTurnWithContinuation(continuation: ReadonlyArray<ChatMessage>): void {
    if (this.currentTurn) throw new Error("session is busy; cannot replace a recorded turn");
    const last = this.history.at(-1);
    if (!last || last.role !== "assistant")
      throw new Error("no recorded assistant turn to replace");
    if (continuation.length === 0 || continuation[0]?.role !== "assistant")
      throw new Error("continuation must begin with an assistant message");
    this.history.splice(this.history.length - 1, 1, ...continuation);
  }

  /** Subscribe to every event the session emits. Returns an unsubscribe fn. */
  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /**
   * Send a user message and stream the assistant response.
   *
   * Returns `{ messageId, completion }`:
   *   - `messageId` is allocated synchronously so callers (e.g. the gateway
   *     WS handler) can acknowledge the send before the turn runs.
   *   - `completion` resolves when the turn ends (or rejects on error).
   *
   * Concurrent sends on the same session throw synchronously — the caller
   * should `cancel()` first.
   */
  send(
    text: string,
    opts: SendOptions = {},
  ): {
    messageId: string;
    userMessageId: string;
    completion: Promise<AgentMessageEndEvent>;
  } {
    if (this.currentTurn) {
      throw new Error("session is busy; cancel the in-flight turn first");
    }
    const messageId = this.idGen();
    const userMessageId = this.idGen();
    const turn: TurnState = {
      messageId,
      abortController: new AbortController(),
      segments: [],
      pendingAssistantParts: [],
      pendingUserParts: [],
      pendingToolUses: new Map(),
      addedCitationsThisTurn: new Map(),
    };
    this.currentTurn = turn;

    // Forward external cancellation into the internal controller so we can
    // honour our own AbortSignal contract regardless of what the backend
    // chooses to do with the signal we pass it.
    const onExternalAbort = (): void => turn.abortController.abort();
    if (opts.signal) {
      if (opts.signal.aborted) onExternalAbort();
      else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    // Append the user message to history before the turn runs so the
    // backend's view of "history" includes it via userMessage.
    const userTurn: ChatMessage = {
      role: "user",
      parts: [{ kind: "text", text }],
    };

    // Broadcast the user message so devices that didn't originate the
    // send can render it. Originator dedupes by `userMessageId`.
    this.broadcast({
      type: "agent.user.message",
      payload: { sessionId: this.sessionId, userMessageId, text },
    });

    const completion = this.runTurnLoop(turn, userTurn, text, opts, onExternalAbort);
    return { messageId, userMessageId, completion };
  }

  private async runTurnLoop(
    turn: TurnState,
    userTurn: ChatMessage,
    text: string,
    opts: SendOptions,
    onExternalAbort: () => void,
  ): Promise<AgentMessageEndEvent> {
    let thrown: unknown;
    let terminalToBroadcast: Extract<AgentEvent, { type: "agent.message.end" }> | undefined;
    let pendingToolBoundary: Extract<AgentEvent, { type: "agent.message.end" }> | undefined;
    try {
      try {
        const priorHistory = [...this.history];
        // Append user turn to canonical history before asking the backend to
        // build its stream so even a synchronous backend-construction throw
        // leaves a coherent transcript. The backend still receives the
        // pre-turn snapshot per TurnInput's contract.
        this.history.push(userTurn);
        const stream = this.backend.runTurn(
          {
            sessionId: this.sessionId,
            messageId: turn.messageId,
            history: priorHistory,
            userMessage: text,
            tools: this.tools,
            timeZone: this.zone,
            caller: this.speaksFor,
            systemPrompt: this.systemPrompt,
            ...(this.reasoning === undefined ? {} : { reasoning: this.reasoning }),
            ...(this.rateLimitPatience === undefined
              ? {}
              : { rateLimitPatience: this.rateLimitPatience }),
            ...(opts.llmProbe === undefined ? {} : { llmProbe: opts.llmProbe }),
          },
          turn.abortController.signal,
        );

        for await (const rawEvent of stream) {
          // A provider may flush an abort-shaped error/delta while its stream
          // unwinds. Once cancellation is authoritative, none of that late
          // provider output belongs on the client or in canonical history;
          // the synthesized canceled terminal below is the sole outcome.
          if (turn.abortController.signal.aborted) break;
          // A tool_use message-end is ambiguous until the next iterator step:
          // another event makes it an internal provider-iteration boundary;
          // clean exhaustion makes it the turn's incomplete terminal.
          if (pendingToolBoundary) {
            this.handleEvent(pendingToolBoundary, turn);
            turn.intermediateUsage = addUsage(
              turn.intermediateUsage,
              pendingToolBoundary.payload.usage,
            );
            pendingToolBoundary = undefined;
          }

          const event = this.normalizeEvent(rawEvent, turn);
          if (event.type === "agent.message.end") {
            if (event.payload.stopReason === "tool_use") {
              pendingToolBoundary = event;
              continue;
            }
            this.handleEvent(event, turn);
            terminalToBroadcast = event;
            // A non-tool terminal is authoritative. Stop consuming the
            // iterator so malformed trailing output, rejection, or a provider
            // that never closes cannot mutate or strand the completed turn.
            break;
          }
          this.handleEvent(event, turn);
          this.broadcast(event);
          if (turn.abortController.signal.aborted) break;
        }
      } catch (err) {
        // Backend threw synchronously or the iterator threw mid-stream.
        // Surface a typed error event so subscribers see a terminal state,
        // then rethrow so the completion promise rejects for the caller.
        // Cancellation commonly makes provider iterators reject with an
        // AbortError. That rejection is the expected unwind path, not a model
        // failure, so let the canceled terminal synthesis below own it.
        if (!turn.abortController.signal.aborted) {
          thrown = err;
          const message =
            err instanceof Error ? err.message : typeof err === "string" ? err : "backend failed";
          const errorEvent = this.normalizeEvent(
            {
              type: "agent.error",
              payload: {
                sessionId: this.sessionId,
                messageId: turn.messageId,
                code:
                  err instanceof InferenceUrlPolicyError && err.code === "remote_inference_disabled"
                    ? err.code
                    : "internal_error",
                message,
              },
            },
            turn,
          );
          this.handleEvent(errorEvent, turn);
          this.broadcast(errorEvent);
        }
      }

      if (pendingToolBoundary) {
        if (!turn.abortController.signal.aborted && thrown === undefined) {
          // The iterator ended cleanly at tool_use, so this is a genuine
          // incomplete terminal rather than an internal iteration boundary.
          const mergedUsage = addUsage(turn.intermediateUsage, pendingToolBoundary.payload.usage);
          const finalToolBoundary: typeof pendingToolBoundary = {
            ...pendingToolBoundary,
            payload: {
              ...pendingToolBoundary.payload,
              ...(mergedUsage ? { usage: mergedUsage } : {}),
            },
          };
          this.handleEvent(finalToolBoundary, turn);
          turn.endEmitted = true;
          turn.terminalEnd = finalToolBoundary.payload;
          terminalToBroadcast = finalToolBoundary;
          this.broadcastAddedCitations(turn);
        } else {
          // Cancellation/failure owns the terminal, but the already-reported
          // provider usage still belongs to that outcome.
          turn.intermediateUsage = addUsage(
            turn.intermediateUsage,
            pendingToolBoundary.payload.usage,
          );
        }
        pendingToolBoundary = undefined;
      }

      // Any tool_use that didn't receive a matching tool_result would leave
      // history in a shape Anthropic rejects on the next turn. Synthesise
      // an error tool_result for every still-open call before emitting the
      // terminal end event so the assistant turn lands paired.
      for (const toolCallId of [...turn.pendingToolUses.keys()]) {
        const stubResult: ToolResult = {
          kind: "error",
          code: "turn_aborted",
          message: "tool did not complete before the turn ended",
        };
        const stubEvent: AgentEvent = {
          type: "agent.tool.result",
          payload: {
            sessionId: this.sessionId,
            messageId: turn.messageId,
            toolCallId,
            result: stubResult,
            durationMs: 0,
          },
        };
        this.handleEvent(stubEvent, turn);
        this.broadcast(stubEvent);
      }

      // If the backend exited without a terminal event (cancelled, threw,
      // or just buggy), synthesise one. handleEvent commits segments to
      // history when it processes message.end, so route through it rather
      // than calling broadcast directly.
      if (!turn.endEmitted) {
        const stopReason: "canceled" | "error" = turn.abortController.signal.aborted
          ? "canceled"
          : "error";
        const endEvent = this.normalizeEvent(
          {
            type: "agent.message.end",
            payload: {
              sessionId: this.sessionId,
              messageId: turn.messageId,
              stopReason,
            },
          },
          turn,
        );
        if (endEvent.type !== "agent.message.end") {
          throw new Error("terminal normalization changed the event type");
        }
        this.handleEvent(endEvent, turn);
        terminalToBroadcast = endEvent;
      }

      // Belt-and-suspenders: handleEvent on message.end already flushed
      // pending parts into history, but a misbehaving backend could
      // emit message.end while leaving stray pending content from a
      // later event. Push anything still buffered so nothing is
      // silently dropped on the floor.
      flushPending(turn);
      for (const seg of turn.segments) this.history.push(seg);

      log.info(
        `session ${this.sessionId} turn ${turn.messageId} committed (history=${this.history.length})`,
      );
    } finally {
      if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
      this.currentTurn = null;
    }
    // A terminal event is the public hand-off barrier: by the time a client
    // receives it, tool/history repair is complete, `currentTurn` is retired,
    // and the session accepts the next send.
    if (terminalToBroadcast) this.broadcast(terminalToBroadcast);
    if (thrown !== undefined) throw thrown;
    if (!turn.terminalEnd) {
      throw new Error("agent turn ended without an authoritative terminal event");
    }
    return turn.terminalEnd;
  }

  /**
   * Cancel the in-flight turn, if any. No-op if idle. The cause picks the
   * line the transcript ends on and defaults to `system`, so only the Stop
   * path, which passes `user`, can say the user stopped the reply. The first
   * cancellation's cause is the one recorded: a disposal after a Stop is
   * still the user's stop.
   */
  cancel(cause: CancelCause = "system"): void {
    const turn = this.currentTurn;
    // Once a backend terminal has been accepted, the turn is complete even
    // though its deferred broadcast is still finishing synchronously. Treat a
    // cancel in that tiny window as the same idempotent no-op as canceling an
    // idle session; rewriting an already-committed end_turn/error would make
    // canonical history disagree with the provider outcome.
    if (!turn || turn.endEmitted) return;
    if (!turn.abortController.signal.aborted) turn.cancelCause = cause;
    turn.abortController.abort();
  }

  /** Cancel any live turn and tear down backend-owned resources. */
  async dispose(): Promise<void> {
    this.cancel();
    await this.backend.dispose?.();
  }

  /** True when a turn is currently in flight (between send() and end). */
  get busy(): boolean {
    return this.currentTurn !== null;
  }

  // ─── internal ──────────────────────────────────────────────────────────

  private normalizeEvent(event: AgentEvent, turn: TurnState): AgentEvent {
    if (
      event.type === "agent.error" &&
      (event.payload.code === "context_window_exceeded" ||
        event.payload.code === "output_truncated")
    ) {
      return {
        ...event,
        payload: {
          ...event.payload,
          message:
            event.payload.code === "context_window_exceeded"
              ? CONTEXT_WINDOW_EXCEEDED_MESSAGE
              : OUTPUT_TRUNCATED_MESSAGE,
        },
      };
    }
    if (event.type !== "agent.message.end") return event;

    const usage =
      turn.abortController.signal.aborted || event.payload.stopReason !== "tool_use"
        ? addUsage(turn.intermediateUsage, event.payload.usage)
        : event.payload.usage;

    // The caller's cancellation wins over a provider's abort-shaped error
    // terminal. Providers should classify this themselves, but normalizing at
    // the session boundary keeps every backend implementation honest.
    if (turn.abortController.signal.aborted) {
      return {
        ...event,
        payload: {
          sessionId: event.payload.sessionId,
          messageId: event.payload.messageId,
          stopReason: "canceled",
          ...(usage ? { usage } : {}),
          ...(event.payload.context ? { context: event.payload.context } : {}),
        },
      };
    }

    if (usage !== event.payload.usage) {
      event = { ...event, payload: { ...event.payload, ...(usage ? { usage } : {}) } };
    }

    const context = event.payload.context ?? {
      measurement: "unknown" as const,
      limitSource: "unknown" as const,
      requestIteration: 1,
    };
    let failure: AgentTerminalFailure | undefined = event.payload.failure;
    if (failure?.code === "context_window_exceeded") {
      failure = {
        ...failure,
        message: CONTEXT_WINDOW_EXCEEDED_MESSAGE,
        retryable: false,
        backend: this.backend.name,
        model: this.backend.model,
      };
    } else if (event.payload.stopReason === "max_tokens" || failure?.code === "output_truncated") {
      failure = {
        code: "output_truncated",
        message: OUTPUT_TRUNCATED_MESSAGE,
        retryable: false,
        backend: this.backend.name,
        model: this.backend.model,
      };
    } else if (failure) {
      failure = {
        ...failure,
        backend: this.backend.name,
        model: this.backend.model,
      };
    } else if (event.payload.stopReason === "error") {
      const terminalError = turn.terminalError;
      const code = terminalError?.code ?? "internal_error";
      const contextExceeded = code === "context_window_exceeded";
      failure = {
        code,
        message: contextExceeded
          ? CONTEXT_WINDOW_EXCEEDED_MESSAGE
          : (terminalError?.message ?? "The model request failed before completing."),
        retryable: !contextExceeded && code !== "output_truncated",
        backend: this.backend.name,
        model: this.backend.model,
      };
    }

    return {
      ...event,
      payload: {
        ...event.payload,
        context,
        ...(failure ? { failure } : {}),
      },
    };
  }

  private handleEvent(event: AgentEvent, turn: TurnState): void {
    switch (event.type) {
      case "agent.message.start":
        // Nothing to do — the message ID was already known.
        break;
      case "agent.text.delta": {
        // Transitioning back to assistant after a tool_result batch: commit
        // the user(tool_result) segment first.
        if (turn.pendingUserParts.length > 0) commitUserSegment(turn);
        // Coalesce consecutive text deltas into one part for history.
        const last = turn.pendingAssistantParts[turn.pendingAssistantParts.length - 1];
        if (last && last.kind === "text") {
          turn.pendingAssistantParts[turn.pendingAssistantParts.length - 1] = {
            kind: "text",
            text: last.text + event.payload.delta,
          };
        } else {
          turn.pendingAssistantParts.push({ kind: "text", text: event.payload.delta });
        }
        break;
      }
      case "agent.thinking.delta": {
        if (turn.pendingUserParts.length > 0) commitUserSegment(turn);
        const last = turn.pendingAssistantParts[turn.pendingAssistantParts.length - 1];
        if (last && last.kind === "thinking") {
          turn.pendingAssistantParts[turn.pendingAssistantParts.length - 1] = {
            kind: "thinking",
            text: last.text + event.payload.delta,
          };
        } else {
          turn.pendingAssistantParts.push({ kind: "thinking", text: event.payload.delta });
        }
        break;
      }
      case "agent.usage.update":
        // Live-only progress; terminal usage remains on message.end.
        break;
      case "agent.tool.input_start": {
        // Pure UI hint — no state mutation here. The assistant part for
        // this tool call is only created on `agent.tool.start` (below)
        // when the args have finished streaming and history can include
        // the full tool_use block. Broadcast-only event.
        break;
      }
      case "agent.tool.start": {
        if (turn.pendingUserParts.length > 0) commitUserSegment(turn);
        // Persist any opaque provider signature (e.g. Gemini thought_signature)
        // alongside the call so it can be replayed when this turn's history is
        // sent on a later turn.
        const part: AssistantPart = {
          kind: "tool_use",
          toolCallId: event.payload.toolCallId,
          tool: event.payload.tool,
          args: event.payload.args,
          ...(event.payload.extraContent !== undefined
            ? { extraContent: event.payload.extraContent }
            : {}),
          ...(event.payload.reasoningDetails !== undefined
            ? { reasoningDetails: event.payload.reasoningDetails }
            : {}),
        };
        turn.pendingAssistantParts.push(part);
        turn.pendingToolUses.set(event.payload.toolCallId, true);
        const argsSummary =
          event.payload.argsSummary ?? truncate(JSON.stringify(event.payload.args), 200);
        log.info(
          `session ${this.sessionId} turn ${turn.messageId} → tool ${event.payload.tool}(${argsSummary})`,
        );
        break;
      }
      case "agent.tool.result": {
        // Drop orphan tool_result events — a tool_result that doesn't
        // match a preceding tool_use would corrupt the history into a
        // shape Anthropic rejects on the next turn.
        if (!turn.pendingToolUses.has(event.payload.toolCallId)) {
          log.warn(
            `session ${this.sessionId} dropped orphan tool_result for ${event.payload.toolCallId}`,
          );
          break;
        }
        // Crossing from assistant to user: the model has finished emitting
        // its tool_use block(s) and the corresponding tool_result must
        // appear in a new user message AFTER the assistant message. Commit
        // any pending assistant content as a segment first.
        if (turn.pendingAssistantParts.length > 0) commitAssistantSegment(turn);
        turn.pendingUserParts.push({
          kind: "tool_result",
          toolCallId: event.payload.toolCallId,
          result: event.payload.result,
        });
        turn.pendingToolUses.delete(event.payload.toolCallId);

        // Citation update: only annotate results contribute to the Citations
        // panel. Search / fetch / SQL never do — the agent cites explicitly.
        // `annotate_many` fans out to one entry + one live `agent.citation`
        // event per child (stable per-child id).
        const recordedList = extractCitationsFromResult(event.payload.result);
        recordedList.forEach((recorded, idx) => {
          const childCallId =
            recordedList.length > 1
              ? `${event.payload.toolCallId}#${idx}`
              : event.payload.toolCallId;
          const key = refKey(recorded.ref);
          turn.addedCitationsThisTurn.set(key, recorded.ref);
          this.appendCitationEntry({
            documentId: recorded.documentId,
            ref: recorded.ref,
            entry: {
              toolCallId: childCallId,
              messageId: event.payload.messageId,
              quote: recorded.quote,
              quoteAuthor: recorded.quoteAuthor,
              quoteIsSelf: recorded.quoteIsSelf,
              note: recorded.note,
            },
          });
          // Synthesize a live `agent.citation` event so the portal / iOS /
          // Android panels render the entry the moment the annotation resolves,
          // without waiting for the terminal citations.update.
          this.broadcast({
            type: "agent.citation",
            payload: {
              sessionId: this.sessionId,
              messageId: event.payload.messageId,
              toolCallId: childCallId,
              documentId: recorded.documentId,
              ref: recorded.ref,
              quote: recorded.quote,
              quoteAuthor: recorded.quoteAuthor,
              quoteIsSelf: recorded.quoteIsSelf,
              note: recorded.note,
            },
          });
        });

        break;
      }
      case "agent.citation": {
        // Forward-compat: external `agent.citation` events (e.g. from
        // replay fixtures that pre-baked them) carry no state mutation
        // here — the live signal is synthesised from `annotate.recorded`
        // tool results above. Keep the case so the switch stays
        // exhaustive; do nothing.
        break;
      }
      case "agent.citations.update": {
        // Backend explicitly emitted one — apply directly (replay path).
        for (const ref of event.payload.added) {
          const key = refKey(ref);
          if (!this.citations.has(key)) {
            this.citations.set(key, { documentId: ref.documentId, ref, entries: [] });
          }
        }
        // `removed` carries documentIds (wire shape). Drop every
        // citation entry whose documentId matches, regardless of source.
        for (const id of event.payload.removed) {
          for (const key of [...this.citations.keys()]) {
            if (this.citations.get(key)?.documentId === id) this.citations.delete(key);
          }
        }
        // Remember the run's merged set so an `agent.deep_research.summary` on
        // this replay/normal turn can persist it into the report_artifact part.
        turn.deepResearchCitations = [
          ...(turn.deepResearchCitations ?? []),
          ...event.payload.added,
        ];
        break;
      }
      case "agent.deep_research.summary": {
        // A replay/normal turn that scripts a deep-research run (the demo
        // cassette, or any backend that emits the summary) persists the same
        // `report_artifact` part the real engine records via `recordTurn` — so
        // the "answer complete · N/N verified · N sources" card survives a
        // reload instead of being a live-only event. The real-engine
        // path (`runDeepResearch`) bypasses the turn loop and records its own.
        const v = event.payload.verification;
        const artifact: ReportArtifactPart = {
          kind: "report_artifact",
          stoppedReason: event.payload.stoppedReason,
          plan: (event.payload.plan ?? []).map((p) => ({
            specialist: p.specialist,
            title: p.title,
            task: p.task,
          })),
          ...(event.payload.treeUsage
            ? {
                treeUsage: {
                  inputTokens: event.payload.treeUsage.inputTokens ?? 0,
                  outputTokens: event.payload.treeUsage.outputTokens ?? 0,
                },
              }
            : {}),
          verification: {
            quotesChecked: v?.quotesChecked ?? 0,
            quotesVerified: v?.quotesVerified ?? 0,
          },
          citations: turn.deepResearchCitations ?? [],
        };
        if (turn.pendingUserParts.length > 0) commitUserSegment(turn);
        turn.pendingAssistantParts.push(artifact);
        break;
      }
      case "agent.message.end": {
        if (event.payload.stopReason !== "tool_use") {
          turn.endEmitted = true;
          turn.terminalEnd = event.payload;
        }
        if (event.payload.stopReason === "canceled") {
          // The caller's cancellation is the turn's outcome, whatever a
          // provider reported before it: the transcript says the reply was
          // stopped — and by the user only when it was — after any partial
          // answer already streamed. An abort that arrived through the
          // caller's signal rather than `cancel()` recorded no cause.
          turn.terminalError = {
            code: "canceled",
            message: CANCELED_TRANSCRIPT_MESSAGE[turn.cancelCause ?? "system"],
          };
          appendTerminalErrorText(turn);
        } else if (
          event.payload.stopReason === "error" &&
          event.payload.failure?.code !== "context_window_exceeded"
        ) {
          appendTerminalErrorText(turn);
        }
        // Commit segments before the terminal is broadcast so subscribers
        // observing message.end see the final history. The run loop also
        // retires `currentTurn` before that broadcast, making the terminal the
        // safe hand-off point for a follow-up send.
        flushPending(turn);
        for (const seg of turn.segments) this.history.push(seg);
        turn.segments = [];
        // Flush citations accumulated this turn into the session
        // and emit a synthetic citations.update if the backend didn't.
        if (event.payload.stopReason !== "tool_use" && turn.addedCitationsThisTurn.size > 0) {
          this.broadcastAddedCitations(turn);
        }
        break;
      }
      case "agent.user.message":
        break;
      case "agent.error":
        // Keep a small durable breadcrumb so a failed no-output turn doesn't
        // persist as a forever-pending user-only transcript. The live event
        // itself still broadcasts unchanged for clients that render a styled
        // error affordance.
        turn.terminalError = {
          code: event.payload.code,
          message: event.payload.message,
        };
        break;
    }
  }

  private broadcastAddedCitations(turn: TurnState): void {
    if (turn.addedCitationsThisTurn.size === 0) return;
    const added: DocRef[] = [...turn.addedCitationsThisTurn.values()];
    this.broadcast({
      type: "agent.citations.update",
      payload: { sessionId: this.sessionId, added, removed: [] },
    });
  }

  private broadcast(event: AgentEvent): void {
    // Snapshot the subscriber set before iterating — a subscriber callback
    // can call `subscribe()`/`unsubscribe()` synchronously (the portal
    // event-router does), which would otherwise produce undefined ordering
    // on the in-flight broadcast.
    for (const sub of [...this.subscribers]) {
      try {
        sub(event);
      } catch {
        // A misbehaving subscriber must not break the session loop.
      }
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

interface TurnState {
  messageId: string;
  abortController: AbortController;
  /** Recorded by `cancel()`; unset when the abort came through the caller's signal. */
  cancelCause?: CancelCause;
  /**
   * Committed segments in arrival order. Within one turn the model may
   * call tools several times, producing the pattern
   * `assistant(tool_use) → user(tool_result) → assistant(tool_use|text)
   * → user(tool_result) → … → assistant(text)`. Each segment is
   * committed as soon as the role flips.
   */
  segments: ChatMessage[];
  pendingAssistantParts: AssistantPart[];
  pendingUserParts: UserPart[];
  pendingToolUses: Map<string, true>;
  /** New cited-doc refs added during this turn — keyed by refKey. */
  addedCitationsThisTurn: Map<string, DocRef>;
  /**
   * The merged citation set carried by a deep-research run's
   * `agent.citations.update` on a replay/normal turn — used to build the
   * persisted `report_artifact` part when the `agent.deep_research.summary`
   * arrives, so the report card survives a reload (the real-engine path records
   * its artifact directly via `recordTurn`).
   */
  deepResearchCitations?: DocRef[];
  terminalError?: { code: string; message: string };
  terminalErrorPersisted?: boolean;
  /** Usage reported by provider tool-use iteration boundaries. */
  intermediateUsage?: NonNullable<AgentMessageEndEvent["usage"]>;
  endEmitted?: boolean;
  terminalEnd?: AgentMessageEndEvent;
}

function addUsage(
  prior: AgentMessageEndEvent["usage"],
  next: AgentMessageEndEvent["usage"],
): AgentMessageEndEvent["usage"] {
  if (!prior) return next;
  if (!next) return prior;
  return {
    inputTokens: (prior.inputTokens ?? 0) + (next.inputTokens ?? 0),
    outputTokens: (prior.outputTokens ?? 0) + (next.outputTokens ?? 0),
    cacheReadTokens: (prior.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheCreationTokens: (prior.cacheCreationTokens ?? 0) + (next.cacheCreationTokens ?? 0),
  };
}

function commitAssistantSegment(turn: TurnState): void {
  if (turn.pendingAssistantParts.length === 0) return;
  turn.segments.push({ role: "assistant", parts: turn.pendingAssistantParts });
  turn.pendingAssistantParts = [];
}

function commitUserSegment(turn: TurnState): void {
  if (turn.pendingUserParts.length === 0) return;
  turn.segments.push({ role: "user", parts: turn.pendingUserParts });
  turn.pendingUserParts = [];
}

function flushPending(turn: TurnState): void {
  commitAssistantSegment(turn);
  commitUserSegment(turn);
}

function cloneChatMessage(message: ChatMessage): ChatMessage {
  return message.role === "assistant"
    ? { role: "assistant", parts: message.parts.map((part) => ({ ...part })) }
    : { role: "user", parts: message.parts.map((part) => ({ ...part })) };
}

function appendTerminalErrorText(turn: TurnState): void {
  if (!turn.terminalError || turn.terminalErrorPersisted) return;
  if (turn.pendingUserParts.length > 0 && turn.pendingAssistantParts.length === 0) {
    commitUserSegment(turn);
  }
  const text = formatTerminalErrorText(turn.terminalError);
  const last = turn.pendingAssistantParts[turn.pendingAssistantParts.length - 1];
  if (last && last.kind === "text") {
    turn.pendingAssistantParts[turn.pendingAssistantParts.length - 1] = {
      kind: "text",
      text: last.text.trimEnd().length > 0 ? `${last.text.trimEnd()}\n\n${text}` : text,
    };
  } else {
    turn.pendingAssistantParts.push({ kind: "text", text });
  }
  turn.terminalErrorPersisted = true;
}

function formatTerminalErrorText(error: { code: string; message: string }): string {
  const message = error.message.trim() || "unknown error";
  return `Model request failed: ${error.code}: ${message}`;
}

// Citations are agent-driven via the `annotate` tool —
// `extractCitationFromResult` below pulls the documentId + ref + quote
// + note out of an `annotate.recorded` payload so callers (live event
// handler + history reseeder) don't each have to know the shape.

interface RecordedCitation {
  documentId: string;
  ref: DocRef;
  quote?: string;
  quoteAuthor?: string;
  quoteIsSelf?: boolean;
  note?: string;
}

function extractCitationFromResult(result: unknown): RecordedCitation | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const kind = typeof r.kind === "string" ? r.kind : "";
  if (kind !== "annotate.recorded") return null;
  if (typeof r.documentId !== "string" || !r.ref) return null;
  return {
    documentId: r.documentId,
    ref: r.ref as DocRef,
    quote: typeof r.quote === "string" ? r.quote : undefined,
    quoteAuthor: typeof r.quoteAuthor === "string" ? r.quoteAuthor : undefined,
    quoteIsSelf: typeof r.quoteIsSelf === "boolean" ? r.quoteIsSelf : undefined,
    note: typeof r.note === "string" ? r.note : undefined,
  };
}

/**
 * Every recorded citation in a tool result: one for a singular
 * `annotate.recorded`, N (in order) for an `annotate.batch` (annotate_many),
 * none otherwise. Callers fan a batch out to one Timeline/citation entry per
 * child; a failed child (a `kind:"error"` item) yields nothing.
 */
function extractCitationsFromResult(result: unknown): RecordedCitation[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  if (r.kind === "annotate.batch") {
    const items = Array.isArray(r.items) ? r.items : [];
    const out: RecordedCitation[] = [];
    for (const item of items) {
      const c = extractCitationFromResult(item);
      if (c) out.push(c);
    }
    return out;
  }
  const single = extractCitationFromResult(result);
  return single ? [single] : [];
}

function refKey(ref: DocRef): string {
  return `${ref.sourceType}:${ref.sourceId}:${ref.documentId}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function defaultIdGen(): string {
  // crypto.randomUUID is fine for in-process IDs; we don't need them to be
  // global across processes (the WS layer carries device + session scope).
  return `m_${crypto.randomUUID()}`;
}
