// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The compiler, with the corpus in front of it.
 *
 * A watch is written against a particular person's life, and until now the
 * compiler was told about that life in one shot: a digest of the declared
 * surface, plus however much of the person directory would fit. It could not
 * ask anything. So "tell me when Aline emails about the lease" had to be
 * answered from a list, and a request naming somebody outside that list could
 * not be bound at all — silently, because a watch with the person filter
 * dropped is a broader watch, not a failed one.
 *
 * Here it can look. The compiler runs as an ordinary agent turn with the
 * gateway's read surface attached: resolve the name, read what a courier's mail
 * actually looks like in this corpus, check what a table holds before writing a
 * predicate over it.
 *
 * ## Why this does not break the package boundary
 *
 * `ChatModel` already says everything this needs to say:
 *
 *     complete(messages: readonly ChatMessage[]): Promise<ModelReply>
 *
 * Messages in, final text out. Whether the implementation resolved a person and
 * read three documents on the way is the host's business — so `@omnesis/watch`
 * keeps its DSL, validator, prompt and reply grammar, and `ScriptedModel` keeps
 * every compiler test deterministic. The package stays what it was; the model
 * behind it got hands.
 *
 * ## Stateless caller, stateful session
 *
 * `complete` is handed the whole conversation each time. `AgentSession` holds
 * its own history and takes one `send` per turn. The bridge between them rests
 * on an invariant of the caller: **the compiler only ever appends**. Its repair
 * loop pushes the assistant's reply and then a diagnostics message; it never
 * rewrites what came before. So one session serves one compile and each call
 * sends only the tail.
 *
 * That invariant is asserted rather than assumed. If a caller ever edits its
 * history, the session's memory and the caller's would diverge — the model
 * would answer the question it remembers instead of the one being asked, and
 * nothing about the reply would look wrong.
 */

import {
  AgentSession,
  selectNonCitationTools,
  selectSubagentTools,
  type ChatBackend,
  type ToolHandle,
} from "@omnesis/agent";
import { createLogger, type AgentEvent, type Logger } from "@omnesis/core";
import { NO_USAGE, type ChatMessage, type ChatModel, type ModelReply } from "@omnesis/watch";

const log: Logger = createLogger("gateway").child("watch-v2:compiler-session");

/**
 * Tools that are read-only but are not *retrieval*.
 *
 * Delegation is the compiler's own job. A compiler that could spawn workers
 * would fan a single request out into a tree of them, each holding the corpus
 * open, for a call whose product is one JSON document — and the budget for that
 * tree belongs to nobody.
 */
const NOT_RETRIEVAL: ReadonlySet<string> = new Set(["spawn_subagent", "join_subagents", "plan"]);

export interface CompilerSessionDeps {
  /** The turn's model. Null when no model is assigned for this work. */
  readonly backend: () => ChatBackend | null;
  /**
   * Every tool the interactive agent holds. Filtered here rather than by the
   * caller: what a compiler may touch is this module's policy, and a caller
   * that assembled its own set would drift from it silently.
   */
  readonly tools: () => readonly ToolHandle[];
  /**
   * How long one turn may take before the caller stops waiting.
   *
   * Required, and owned by whoever asked for the compile. A turn here is not
   * one HTTP call the provider's own timeout would bound: it is a model reply
   * plus however many tool calls it decides to make, and a backend that stalls
   * mid-stream leaves the request hanging for as long as the connection does.
   * The compiler's repair loop is several turns, so this is per turn, matching
   * the single-shot path's per-call deadline rather than budgeting the compile
   * as a whole.
   */
  readonly timeoutMs: number;
  /**
   * How much a compile turn may reason before it has to answer.
   *
   * Absent, the backend decides, which on a model with adaptive thinking means
   * the model decides. That is right for a conversation and wrong here: over 88
   * compiles, every run that missed its deadline had made the same handful of
   * tool calls as one that finished and then reasoned roughly three times as
   * long, emitting six text deltas against a median of nine hundred and fifty.
   * They do not run out of time working; they run out of time deciding.
   *
   * A hint, not a contract — a backend that cannot express a reasoning budget
   * runs the turn unbounded and the compile behaves as it did before.
   */
  readonly reasoningTokens?: number;
  /**
   * Where this compile's agent events go, when somebody is recording it.
   *
   * Every event, verbatim, in order — not a summary. What the compiler looked
   * at and what came back is the whole content of a compile transcript, and a
   * session that decided here which events were worth keeping would be
   * choosing what an operator is allowed to see afterwards.
   *
   * Optional because a compile is not required to be recorded: the eval
   * harness and the package's own tests run this session with no ledger
   * behind them.
   */
  readonly onEvent?: (event: AgentEvent) => void;
}

/**
 * A compile that can look things up, and what it may reach.
 *
 * The names travel with the model because the prompt has to say which tools
 * exist: a compiler told it may look things up, holding a set it was never
 * told about, either does not look or guesses at names.
 */
export interface CompilerSession {
  readonly model: ChatModel;
  readonly toolNames: readonly string[];
}

/**
 * What the compiler may touch: everything the agent can read, and nothing else.
 *
 * A predicate rather than a list. `selectSubagentTools` drops every handle that
 * declares `mutates`, which means a read-only tool added next month is
 * available without anyone remembering to add it, and a writing tool added next
 * month is excluded without anyone remembering either. An allow-list gets those
 * exactly backwards as the surface grows.
 *
 * The citation tools go too. They are not writes in the sense a sub-agent cares
 * about — `annotate_many` is how a delegated worker hands evidence back — but a
 * compile is a throwaway session with no conversation to hold a Timeline, so
 * every citation it recorded would be a row attached to nothing.
 */
export function compilerTools(parentTools: readonly ToolHandle[]): ToolHandle[] {
  return selectNonCitationTools(selectSubagentTools(parentTools)).filter(
    (tool) => !NOT_RETRIEVAL.has(tool.name),
  );
}

/**
 * A compile that answers by running an agent turn, or `null` when this install
 * cannot run one.
 *
 * One instance per compile: the session is the conversation, and two compiles
 * sharing one would each see the other's reasoning.
 *
 * `null` rather than a throw for the unassigned case. The caller has a
 * single-shot path to fall back to, and an install with no chat model — but a
 * completion backend — should compile with less rather than not at all.
 */
export function createCompilerSession(
  deps: CompilerSessionDeps,
  sessionId: string,
): CompilerSession | null {
  const backend = deps.backend();
  if (!backend) return null;
  const tools = compilerTools(deps.tools());
  /** What this compile looked at, in order, for the line logged per turn. */
  const calls: string[] = [];

  let session: AgentSession | null = null;
  /** What has already been said to the session, in order. */
  let sent: ChatMessage[] = [];
  /** The turn's visible text, accumulated as it streams. */
  let text = "";

  const model: ChatModel = {
    name: backend.model,
    async complete(messages: readonly ChatMessage[]): Promise<ModelReply> {
      const system = messages.find((m) => m.role === "system");
      const turns = messages.filter((m) => m.role !== "system");

      if (!session) {
        session = new AgentSession({
          sessionId,
          backend,
          tools,
          systemPrompt: system?.content ?? "",
          ...(deps.reasoningTokens === undefined
            ? {}
            : { reasoning: { maxTokens: deps.reasoningTokens } }),
        });
        session.subscribe((event) => {
          deps.onEvent?.(event);
          if (event.type === "agent.text.delta") text += event.payload.delta;
          else if (event.type === "agent.tool.start") calls.push(event.payload.tool);
        });
      } else {
        assertAppendOnly(sent, turns);
      }

      const next = turns[turns.length - 1];
      if (!next) throw new Error("a compile turn carried no request");

      text = "";
      // One deadline per turn, and it cancels the turn rather than racing it.
      // A race would resolve the caller and leave the session running: tools
      // still reading the corpus, tokens still being billed, for a compile
      // whose answer nobody is waiting for.
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), deps.timeoutMs);
      let end;
      try {
        end = await session.send(next.content, { signal: deadline.signal }).completion;
      } finally {
        clearTimeout(timer);
      }
      // An abandoned turn resolves; it does not throw. **The signal is what
      // says so, not the stop reason.** A backend aborted between tool
      // iterations reports `canceled`, but one aborted mid-stream sees the
      // torn connection first and reports `error` with whatever partial text
      // it had — so a check on the stop reason alone recognises the deadline
      // on one path and, on the common one, hands the compiler an empty reply
      // to repair. That spends the whole repair budget, each attempt with a
      // fresh full-length deadline, and comes back saying the request could
      // not be compiled rather than that this install ran out of time.
      //
      // Named errors because `isTimeout` in the port reads the name: ours is a
      // deadline, and a cancellation nobody here asked for is the backend's
      // own abort. Both are `timed-out` to the caller, which is the honest
      // answer — nothing was decided about their condition.
      if (deadline.signal.aborted || end.stopReason === "canceled") {
        const stopped = new Error(
          deadline.signal.aborted
            ? `a compile turn exceeded ${deps.timeoutMs}ms`
            : "a compile turn was cancelled before it finished",
        );
        stopped.name = deadline.signal.aborted ? "TimeoutError" : "AbortError";
        throw stopped;
      }
      sent = [...turns, { role: "assistant", content: text }];
      // What a compile read is kept because a corpus-grounded compiler can
      // overfit to what it happened to find — a threshold that separates this
      // week's six matching emails, a source named because that is where last
      // month's parcels arrived. Whether that actually happens is a question
      // about real compiles, and it cannot be answered without knowing what
      // each one looked at.
      if (calls.length > 0) {
        log.debug(`compile ${sessionId} looked at ${calls.length} thing(s): ${calls.join(", ")}`);
      }
      // The session reports what the provider billed for the whole turn — the
      // tool calls included, which is the point: a compile that read ten
      // documents cost what it cost, and a report that counted only the final
      // message would understate it by most of the turn.
      return { text, usage: usageOf(end.usage) };
    },
  };
  return { model, toolNames: tools.map((tool) => tool.name) };
}

/** The turn's billed usage, in the shape the compiler's report sums. */
function usageOf(
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
      }
    | undefined,
): ModelReply["usage"] {
  if (!usage) return NO_USAGE;
  return {
    promptTokens: usage.inputTokens ?? 0,
    cachedPromptTokens: usage.cacheReadTokens ?? 0,
    completionTokens: usage.outputTokens ?? 0,
  };
}

/**
 * Hold the caller to the invariant this bridge rests on.
 *
 * Everything already said must still be there, unchanged, in the same order.
 * A caller that rewrote its history would leave the session answering from a
 * conversation nobody is having any more — and the reply would look entirely
 * ordinary, which is why this throws rather than resynchronising.
 */
function assertAppendOnly(sent: readonly ChatMessage[], now: readonly ChatMessage[]): void {
  if (now.length < sent.length) {
    throw new Error("a compile turn dropped earlier messages; this session cannot be reused");
  }
  for (const [index, message] of sent.entries()) {
    const current = now[index];
    if (current?.role !== message.role || current.content !== message.content) {
      throw new Error(
        `a compile turn rewrote message ${index}; a session-backed model can only be appended to`,
      );
    }
  }
}
