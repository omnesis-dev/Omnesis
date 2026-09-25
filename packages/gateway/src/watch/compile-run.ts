// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Every watch compile, recorded in the cognition ledger.
 *
 * A compile is the one piece of reasoning in this subsystem that decides what
 * a watch *means*. It reads the corpus, resolves the people a request names,
 * checks what a table holds before writing a predicate over it, and repairs
 * its own answer when the validator rejects it — and until this existed none
 * of that left a trace. A watch that catches nothing and a watch that was
 * compiled against the wrong source look identical from the outside; the only
 * thing that tells them apart is what the compiler saw and said.
 *
 * So a compile is written into the same ledger the operator already reads for
 * every other kind of run: one settled row (`recordSettledCognitionRun`, kind
 * `subscription_compile`) plus one transcript file carrying the agent event
 * stream verbatim — tool calls with their arguments, tool results, the model's
 * replies, and the diagnostics the repair loop fed back. The portal's run
 * viewer renders that stream directly, so nothing here formats anything.
 *
 * **Refusals are recorded too, deliberately.** A compilation that ends in a
 * typed rejection is the case an operator most needs to inspect: the run row
 * carries the codes, and the transcript shows the answer that led to them.
 *
 * ## What the ledger is told about, and why that is safe
 *
 * The transcript holds corpus content — a compile with tools reads documents,
 * and a tool result is part of the stream. That is the same class as every
 * other recorded run: an on-host debug artifact behind the admin surface,
 * never indexed, never read back by a later run, never crossing the privacy
 * membrane. Nothing new leaves the host because a compile is written down.
 *
 * ## Recording never fails a compile
 *
 * Every write here is swallow-and-warn. Losing a debug artifact must not fail
 * the operator's real work — but {@link WatchCompileRecording.settle} reports
 * whether the *row* landed, because a caller is about to hand the run id
 * onward. A durable reference to a run the ledger never received would render
 * as a link to nothing.
 */

import { randomUUID } from "node:crypto";
import { toCognitionRunUsage } from "../brain/run-driver.js";
import { cognitionSpendDay } from "../brain/storage/spend.js";
import type { AgentEvent, AgentUsage, Logger } from "@omnesis/core";
import type { CognitionRunTranscript } from "../brain/transcripts.js";
import type { RecordSettledCognitionRunInput } from "../brain/storage/run-queue.js";
import type { CognitionSubscriptionCompileRunPayload } from "../brain/run-payloads.js";
import type { WatchV2Author } from "../subscriptions/watch-v2-plan.js";

/** The one write-gate verb the recorder needs. */
export interface WatchCompileRunSink {
  recordSettledCognitionRun(input: RecordSettledCognitionRunInput): Promise<void>;
}

/** The one transcript-store verb the recorder needs. */
export interface WatchCompileTranscriptSink {
  save(transcript: CognitionRunTranscript): void;
}

export interface WatchCompileRecorderDeps {
  readonly writeGate: WatchCompileRunSink;
  readonly transcripts: WatchCompileTranscriptSink;
  readonly log: Logger;
  readonly clock?: () => number;
  readonly id?: () => string;
}

/** What a compile was asked to do, as the ledger records it. */
export interface BeginWatchCompileInput {
  /** The request, in the asker's own words. */
  readonly request: string;
  /** Who asked. */
  readonly authoredBy: WatchV2Author;
  /** The watch this compile rewrites, when it replaces one. */
  readonly replaces?: string;
  /**
   * Whether this compile installs nothing — a preview, asked so somebody can
   * see what a request would become before agreeing to it.
   *
   * Recorded because a run that installed nothing is otherwise indistinguishable
   * from one whose install failed after it.
   */
  readonly compileOnly?: boolean;
  /**
   * Whether this compile was asked to skip replaying its own candidate.
   *
   * The run row is where a compile's duration lives, so it is where the replay's
   * cost has to be attributable from. Recorded rather than inferred from whether
   * a backtest came back: a compile has none when the install has no runtime to
   * replay against, when the replay declined the candidate, when the journal was
   * empty — and on every refusal, which never carries one at all. Inferring the
   * arm from an absence would put all of those in the control group.
   */
  readonly withoutBacktest?: boolean;
}

/**
 * How a compile ended.
 *
 * Five outcomes rather than a boolean, because they mean different things to
 * whoever asked — and the port collapses two of them before it answers its
 * caller, so the ledger is the only place the difference survives. A
 * **refusal** is the compiler declining a request it could not justify, and
 * asking again gets the same answer. A **failure** is the model not producing
 * something the validator would accept after its repairs, and asking again may
 * well work. A **timeout** decided nothing at all.
 */
export type WatchCompileOutcome =
  | {
      readonly kind: "compiled";
      readonly attempts: number;
      /**
       * What the candidate would have done over the history it was replayed
       * against, when anything replayed it.
       *
       * Kept on the run rather than only in the answer, because the run is what
       * an operator opens when a watch turns out to behave differently from what
       * they expected. Without it the ledger records that a compile happened and
       * not what it was shown — and the reach numbers are the half of that a
       * transcript cannot reconstruct.
       */
      readonly backtest?: {
        readonly days: number;
        readonly events: number;
        readonly firings: number;
        readonly totalReaches: number;
      };
    }
  | {
      readonly kind: "refused";
      readonly codes: readonly string[];
      readonly reasons: readonly string[];
      readonly attempts: number;
    }
  | {
      readonly kind: "failed";
      /** `unparseable` if the last reply was unreadable, else `invalid`. */
      readonly reason: string;
      /** What the validator said about the last attempt. */
      readonly diagnostics: readonly string[];
      readonly attempts: number;
    }
  | { readonly kind: "timed-out" }
  | { readonly kind: "error"; readonly message: string };

/** The run row's `failure_code`, one per way of not producing a watch. */
const FAILURE_CODES: Record<Exclude<WatchCompileOutcome["kind"], "compiled">, string> = {
  refused: "refused",
  failed: "compiler_failed",
  "timed-out": "timed_out",
  error: "compile_error",
};

/**
 * One compile being recorded.
 *
 * The recording's only input is an agent event stream. The session path taps
 * the compiler's own `AgentSession` and forwards it verbatim; the single-shot
 * path has no session, so {@link synthesizeSingleShotTurn} manufactures the
 * same three events a prompt-and-reply turn would have produced. Both arrive
 * here through {@link record}, which means the transcript has one format and
 * the viewer needs to know nothing about which path ran.
 */
export class WatchCompileRecording {
  readonly runId: string;

  private readonly startedAt: number;
  private readonly events: Array<{ type: string; payload: unknown }> = [];
  private readonly usage: AgentUsage = {};
  private sawUsage = false;
  private prompt = "";
  private pendingText = "";
  private finalText = "";
  private modelId: string | null = null;
  private path: CognitionSubscriptionCompileRunPayload["path"] | null = null;
  private settled = false;

  constructor(
    private readonly deps: WatchCompileRecorderDeps,
    private readonly input: BeginWatchCompileInput,
    private readonly clock: () => number,
  ) {
    this.runId = `run_${(deps.id ?? randomUUID)()}`;
    this.startedAt = clock();
  }

  /**
   * Which of the two compile paths this install ran, and on what model.
   *
   * Declared by the caller rather than inferred from the events, because the
   * distinction survives a compile that produced no events at all — a session
   * whose first turn threw still ran on the session path, and a ledger that
   * called it single-shot would be describing a different install.
   */
  begins(path: CognitionSubscriptionCompileRunPayload["path"], modelId: string): void {
    this.path = path;
    this.modelId = modelId;
  }

  /**
   * Keep one agent event, verbatim.
   *
   * Verbatim because the portal's run viewer is the live agent reducer reading
   * a stored stream: it switches on the wire event types and reads their wire
   * payloads. Anything reshaped here would have to be un-reshaped there, and
   * the two would drift the first time a new event type shipped.
   */
  record(event: AgentEvent): void {
    if (this.settled) return;
    this.events.push({ type: event.type, payload: event.payload });
    switch (event.type) {
      case "agent.user.message":
        // The first user message is the compile's prompt. The ones after it
        // are the repair loop handing the model its own diagnostics back, and
        // they stay in the stream where their order is what explains them.
        if (this.prompt === "") this.prompt = event.payload.text;
        // A new turn begins: the session broadcasts the user message before
        // running it, so this is the boundary at which the previous turn's
        // streamed text stops accumulating.
        this.pendingText = "";
        break;
      case "agent.text.delta":
        this.pendingText += event.payload.delta;
        break;
      case "agent.message.end": {
        this.finalText = this.pendingText.trim() || this.finalText;
        const turn = event.payload.usage;
        if (turn) {
          this.sawUsage = true;
          this.usage.inputTokens = (this.usage.inputTokens ?? 0) + (turn.inputTokens ?? 0);
          this.usage.outputTokens = (this.usage.outputTokens ?? 0) + (turn.outputTokens ?? 0);
          this.usage.cacheReadTokens =
            (this.usage.cacheReadTokens ?? 0) + (turn.cacheReadTokens ?? 0);
          this.usage.cacheCreationTokens =
            (this.usage.cacheCreationTokens ?? 0) + (turn.cacheCreationTokens ?? 0);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Write the settled run, and the transcript when anything was observed.
   *
   * Reports whether the run row landed. Safe to call exactly once; a second
   * call is a no-op reporting `false`. Never throws.
   */
  async settle(outcome: WatchCompileOutcome): Promise<boolean> {
    if (this.settled) return false;
    this.settled = true;
    const finishedAt = this.clock();
    const failed = outcome.kind !== "compiled";
    const errorMessage =
      outcome.kind === "refused"
        ? `refused (${outcome.codes.join(", ")}): ${outcome.reasons.join("; ")}`
        : outcome.kind === "failed"
          ? `no valid watch after ${outcome.attempts} attempt(s) (${outcome.reason}): ${outcome.diagnostics.join(", ")}`
          : outcome.kind === "timed-out"
            ? "the compiler did not finish in the time it was given"
            : outcome.kind === "error"
              ? outcome.message
              : undefined;
    const payload: CognitionSubscriptionCompileRunPayload = {
      request: this.input.request,
      authoredBy: this.input.authoredBy,
      // A compile that never reached a model — no backend assigned — is
      // recorded as the path it would have taken, which is the honest answer
      // about this install rather than an invented one.
      path: this.path ?? "single-shot",
      ...(this.input.replaces === undefined ? {} : { replaces: this.input.replaces }),
      ...("attempts" in outcome ? { attempts: outcome.attempts } : {}),
      ...(outcome.kind === "compiled" && outcome.backtest ? { backtest: outcome.backtest } : {}),
      ...(outcome.kind === "refused" ? { refusalCodes: [...outcome.codes] } : {}),
      ...(this.input.compileOnly === true ? { compileOnly: true as const } : {}),
      ...(this.input.withoutBacktest === true ? { withoutBacktest: true as const } : {}),
    };
    const usage = this.sawUsage ? toCognitionRunUsage(this.usage) : null;
    // A stable code per way of not producing a watch, so the runs list can be
    // filtered by it and a refusal is never confused with a deadline.
    const failureCode = outcome.kind === "compiled" ? undefined : FAILURE_CODES[outcome.kind];
    let recorded = true;
    try {
      await this.deps.writeGate.recordSettledCognitionRun({
        runId: this.runId,
        kind: "subscription_compile",
        payload,
        startedAt: this.startedAt,
        now: finishedAt,
        day: cognitionSpendDay(finishedAt),
        mechanism: "subscription-compile",
        modelId: this.modelId,
        usage,
        outcome: failed
          ? {
              kind: "failed",
              errorMessage: errorMessage ?? "the compile did not produce a watch",
              ...(failureCode === undefined ? {} : { failureCode }),
            }
          : { kind: "completed" },
      });
    } catch (err) {
      recorded = false;
      this.deps.log.warn(
        `compile run row write failed for ${this.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Still worth keeping when the row write failed: the transcript is what
    // carries the model's own words, and the transcript routes serve it by run
    // id whether or not a row exists.
    if (this.events.length === 0) return recorded;
    try {
      this.deps.transcripts.save({
        runId: this.runId,
        attempt: 1,
        kind: "subscription_compile",
        payload,
        startedAt: this.startedAt,
        finishedAt,
        prompt: this.prompt,
        events: this.events,
        finalText: this.finalText,
        outcome: failed ? "failed" : "completed",
        ...(errorMessage !== undefined ? { errorMessage } : {}),
        ...(failureCode === undefined ? {} : { failureCode }),
        usage,
      });
    } catch (err) {
      this.deps.log.warn(
        `compile transcript write failed for ${this.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return recorded;
  }
}

/** Factory the composition root wires into the compile port. */
export class WatchCompileRecorder {
  constructor(private readonly deps: WatchCompileRecorderDeps) {}

  begin(input: BeginWatchCompileInput): WatchCompileRecording {
    return new WatchCompileRecording(this.deps, input, this.deps.clock ?? Date.now);
  }
}

/**
 * The events a single-shot turn would have broadcast, had it been a session.
 *
 * The single-shot path is one prompt string in and one text reply out — there
 * is no `AgentSession` behind it and so no event stream. Left alone it would
 * record a run with an empty transcript, which reads exactly like a compile
 * that never reached a model. Manufacturing the three events a plain turn
 * produces makes the two paths render the same way and keeps the difference
 * where it belongs: on the payload's `path`, and in the absence of any tool
 * calls.
 */
export function synthesizeSingleShotTurn(input: {
  readonly sessionId: string;
  readonly turn: number;
  readonly prompt: string;
  readonly reply: string;
}): AgentEvent[] {
  const messageId = `${input.sessionId}-m${input.turn}`;
  return [
    {
      type: "agent.user.message",
      payload: {
        sessionId: input.sessionId,
        userMessageId: `${input.sessionId}-u${input.turn}`,
        text: input.prompt,
      },
    },
    {
      type: "agent.message.start",
      payload: { sessionId: input.sessionId, messageId, role: "assistant" },
    },
    {
      type: "agent.text.delta",
      payload: { sessionId: input.sessionId, messageId, delta: input.reply },
    },
    {
      type: "agent.message.end",
      payload: { sessionId: input.sessionId, messageId, stopReason: "end_turn" },
    },
  ];
}
