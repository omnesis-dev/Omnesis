// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The headless Cognition Steward run driver — executes one claimed queue run
 * end-to-end on the `SubagentService.runChild` pattern: build an
 * {@link AgentSession} directly (a NON-broadcasting session — nothing
 * here touches the WS fan-out, so background runs never spam clients),
 * subscribe to harvest text / citations / usage, `await send().completion`,
 * and persist the full event stream as an operator transcript.
 *
 * There is deliberately no HTTP surface: runs enter through the queue
 * and results land in storage. The prompt and tool surfaces are
 * injectable seams — the Cognition Steward's real per-kind prompts and its
 * loop/brief write-tools plug in here; the defaults below are a minimal
 * generic envelope that keeps the driver testable on its own.
 */

import { AgentSession, classifyAgentTurn, type ChatBackend, type ToolHandle } from "@omnesis/agent";
import { transcriptSafeRunPayload } from "./run-payloads.js";
import {
  systemClock,
  type Clock,
  type ClaimedCognitionRun,
  type CognitionRunUsage,
} from "./storage/types.js";
import type {
  AgentContextAssessment,
  AgentEvent,
  AgentTerminalFailure,
  AgentUsage,
  DocRef,
  Logger,
} from "@omnesis/core";
import type { FsCognitionTranscriptStore } from "./transcripts.js";

/** Builds the user-message prompt for one claimed run. The per-kind prompt content plugs in here. */
export type CognitionPromptBuilder = (run: ClaimedCognitionRun) => string | Promise<string>;

/** Backend identity supplied to per-run tools after resolution. */
export interface CognitionRunExecutionContext {
  modelId: string;
}

/**
 * The default prompt envelope: run identity, attempt number, kind, and
 * the payload reference. Every prompt states the run id and attempt so
 * a re-claimed attempt can reconcile — detect and adopt work already
 * stamped with its own run id instead of duplicating it.
 */
export function defaultCognitionPrompt(run: ClaimedCognitionRun): string {
  const reAttempt =
    run.attempts > 1
      ? " — a previous attempt of this run may have partially completed; before creating anything, check for work already stamped with this run id and adopt it"
      : "";
  return [
    "Background Cognition Steward run.",
    `Run id: ${run.id}`,
    `Attempt: ${run.attempts}${reAttempt}`,
    `Kind: ${run.kind}`,
    `Payload: ${JSON.stringify(run.payload ?? {})}`,
  ].join("\n");
}

/** The default (placeholder) system prompt; the real Cognition Steward prompt plugs in via the seam. */
function defaultCognitionSystemPrompt(): string {
  return "You are a background agent processing one queued run. Respond concisely.";
}

/** What one executed attempt produced. */
export interface CognitionRunOutcome {
  ok: boolean;
  /** Present when `ok` is false. */
  errorMessage?: string;
  /**
   * Authoritative terminal model failure. Absent for infrastructure and
   * validation failures, which retain the queue's ordinary retry policy.
   */
  failure?: AgentTerminalFailure;
  /** Context-window assessment captured from the authoritative terminal event. */
  context?: AgentContextAssessment;
  /**
   * Model id of the backend that executed the attempt (resolved fresh per
   * run); null when no backend resolved. Spend accounting attributes the
   * attempt's tokens to this model.
   */
  modelId: string | null;
  /** Tokens this attempt consumed (recorded to spend whatever the outcome). */
  usage: CognitionRunUsage | null;
  finalText: string;
  citations: DocRef[];
  /** Document ids the run opened via `fetch_document` (the bootstrap cross-arc skip). */
  openedDocIds: string[];
}

export interface CognitionRunDriverDeps {
  /**
   * Resolve the `background-agent` chat backend, fresh per run so a
   * live model swap takes effect on the next run. Null (assignment
   * removed mid-flight) fails the attempt softly — the queue retries.
   */
  resolveBackend: () => ChatBackend | null;
  transcripts: FsCognitionTranscriptStore;
  log: Logger;
  /**
   * Seam for the Cognition Steward's tool surface, built fresh per claimed run
   * so the handles carry the run's id (creates stamp `created_by_run`,
   * ledger appends stamp the run id). Default: no tools.
   */
  buildTools?: (run: ClaimedCognitionRun, context: CognitionRunExecutionContext) => ToolHandle[];
  /** Seam for the per-kind run prompts. Default: the generic envelope. */
  promptBuilder?: CognitionPromptBuilder;
  /** Seam for the Cognition Steward system prompt (incl. agent-notes injection). */
  systemPrompt?: () => string;
  /**
   * Post-turn completion barrier. A successful model turn is not allowed to
   * settle its queue row until this confirms every required side effect is
   * durably present. Returning a message (or throwing) makes the attempt fail
   * softly so the queue retries. Subscription precision uses this to enforce
   * fail-closed, all-candidates-decided semantics.
   */
  validateRun?: (
    run: ClaimedCognitionRun,
    context: CognitionRunExecutionContext,
  ) => string | null | Promise<string | null>;
  clock?: Clock;
}

export class CognitionRunDriver {
  private readonly buildTools: (
    run: ClaimedCognitionRun,
    context: CognitionRunExecutionContext,
  ) => ToolHandle[];
  private readonly promptBuilder: CognitionPromptBuilder;
  private readonly systemPrompt: () => string;
  private readonly clock: Clock;

  constructor(private readonly deps: CognitionRunDriverDeps) {
    this.buildTools = deps.buildTools ?? (() => []);
    this.promptBuilder = deps.promptBuilder ?? defaultCognitionPrompt;
    this.systemPrompt = deps.systemPrompt ?? defaultCognitionSystemPrompt;
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Execute one claimed run. Never throws — every path returns an
   * outcome. `signal` (the scheduler's dispose signal) aborts an
   * in-flight model turn on shutdown; the row stays `pending` and is
   * re-claimed on the next boot.
   */
  async execute(
    run: ClaimedCognitionRun,
    opts: { signal?: AbortSignal } = {},
  ): Promise<CognitionRunOutcome> {
    // Deliberately kind-blind: every run kind — including `verification` —
    // resolves the same background-agent backend. Verification runs are agent
    // runs (they re-ground with tools), not entailment-verifier completions;
    // a cheaper per-kind chat role is a future split once the per-mechanism
    // spend data (`cognition_spend`) justifies it.
    const backend = this.deps.resolveBackend();
    if (!backend) {
      // No session ran, so there is no transcript to write.
      return {
        ok: false,
        errorMessage: "background-agent backend unavailable (assignment removed or unresolvable)",
        modelId: null,
        usage: null,
        finalText: "",
        citations: [],
        openedDocIds: [],
      };
    }

    let prompt: string;
    try {
      prompt = await this.promptBuilder(run);
    } catch (err) {
      // Prompt construction may read live derived state (for example the
      // datum's temporal projections). Keep that failure inside the driver's
      // never-throw contract so the queue can retry it like a model failure.
      return {
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        modelId: backend.model,
        usage: null,
        finalText: "",
        citations: [],
        openedDocIds: [],
      };
    }
    const startedAt = this.clock();
    const session = new AgentSession({
      sessionId: `loop-agent-run-${run.id}-a${run.attempts}`,
      backend,
      tools: this.buildTools(run, { modelId: backend.model }),
      systemPrompt: this.systemPrompt(),
    });

    const events: Array<{ type: string; payload: unknown }> = [];
    const citations = new Map<string, DocRef>();
    const usage: AgentUsage = {};
    let sawUsage = false;
    let pendingText = "";
    let finalText = "";
    const openedDocIds = new Set<string>();

    const unsubscribe = session.subscribe((event: AgentEvent) => {
      events.push({ type: event.type, payload: event.payload });
      switch (event.type) {
        case "agent.text.delta":
          pendingText += event.payload.delta;
          break;
        case "agent.citation":
          citations.set(refKey(event.payload.ref), event.payload.ref);
          break;
        case "agent.citations.update":
          for (const ref of event.payload.added) citations.set(refKey(ref), ref);
          break;
        case "agent.tool.start": {
          // Track which documents the run opened, so a bootstrap run that pulls
          // an older document in to resolve an arc can mark it processed too —
          // it never earns its own run (the cross-arc skip). Fetches arrive as a
          // `fetch_many` batch (documents fetched in one round-trip), so every id
          // in the batch counts as opened.
          if (event.payload.tool === "fetch_many") {
            const args = event.payload.args as
              | { documents?: Array<{ documentId?: unknown } | null> }
              | undefined;
            for (const d of args?.documents ?? []) {
              if (d && typeof d.documentId === "string") openedDocIds.add(d.documentId);
            }
          }
          break;
        }
        case "agent.message.end": {
          finalText = pendingText.trim() || finalText;
          const u = event.payload.usage;
          if (u) {
            sawUsage = true;
            usage.inputTokens = (usage.inputTokens ?? 0) + (u.inputTokens ?? 0);
            usage.outputTokens = (usage.outputTokens ?? 0) + (u.outputTokens ?? 0);
            usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0);
            usage.cacheCreationTokens =
              (usage.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0);
          }
          break;
        }
        default:
          break;
      }
    });

    let ok = true;
    let errorMessage: string | undefined;
    let failure: AgentTerminalFailure | undefined;
    let context: AgentContextAssessment | undefined;
    try {
      const { completion } = session.send(prompt, opts.signal ? { signal: opts.signal } : {});
      const terminal = await completion;
      context = terminal.context;
      const turn = classifyAgentTurn(terminal);
      if (turn.status === "failed") {
        ok = false;
        failure = turn.failure;
        errorMessage = turn.failure.message;
      }
    } catch (err) {
      ok = false;
      errorMessage = err instanceof Error ? err.message : String(err);
    } finally {
      unsubscribe();
    }

    if (ok && this.deps.validateRun) {
      try {
        const validationError = await this.deps.validateRun(run, { modelId: backend.model });
        if (validationError !== null) {
          ok = false;
          errorMessage = validationError;
        }
      } catch (err) {
        ok = false;
        errorMessage = err instanceof Error ? err.message : String(err);
      }
    }

    const runUsage = sawUsage ? toCognitionRunUsage(usage) : null;
    const finishedAt = this.clock();
    try {
      this.deps.transcripts.save({
        runId: run.id,
        attempt: run.attempts,
        kind: run.kind,
        // The queue row's payload is cleared when the run settles; this
        // copy keeps the operator decision view able to say which datum
        // (or brief / source / prompt) the run was about. Persisted via
        // the transcript-safe projection — the transient prior-content
        // snapshot must never outlive the queue row.
        payload: transcriptSafeRunPayload(run.payload),
        startedAt,
        finishedAt,
        prompt,
        events,
        finalText,
        outcome: ok ? "completed" : "failed",
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        ...(failure !== undefined ? { failureCode: failure.code } : {}),
        ...(context !== undefined ? { context } : {}),
        usage: runUsage,
      });
    } catch (err) {
      // Losing a debug artifact must not fail (and re-run) the agent's
      // real work — but say so loudly.
      this.deps.log.warn(
        `transcript write failed for run ${run.id} attempt ${run.attempts}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {
      ok,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(failure !== undefined ? { failure } : {}),
      ...(context !== undefined ? { context } : {}),
      modelId: backend.model,
      usage: runUsage,
      finalText,
      citations: [...citations.values()],
      openedDocIds: [...openedDocIds],
    };
  }
}

/**
 * Collapse the agent-protocol usage shape into the queue's shape:
 * `promptTokens` stays the input-side TOTAL (fresh input + cache reads +
 * cache creation) so day totals remain comparable across rows written
 * before the cache split, with the cached portions carried alongside as
 * subsets for hit-rate and pricing visibility. Exported as the one
 * canonical collapse — every lane that records `AgentUsage` into
 * `cognition_spend` (interactive turns, sub-agents) goes through it so
 * prompt-token semantics never drift between mechanisms.
 */
export function toCognitionRunUsage(u: AgentUsage): CognitionRunUsage {
  return {
    promptTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0),
    completionTokens: u.outputTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    cacheCreationTokens: u.cacheCreationTokens ?? 0,
  };
}

function refKey(ref: DocRef): string {
  return `${ref.sourceType}:${ref.sourceId}:${ref.documentId}`;
}
