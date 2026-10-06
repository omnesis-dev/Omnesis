// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The record check: when a background run saves a new annotation, ask the
 * decision model whether the record belongs in the owner's life memory.
 *
 * It judges what the agent decided to write, never what the agent should
 * investigate — every tool call and search still happens; only the final
 * sentence is weighed. Scope:
 * - New doc, person and document-grounded temporal annotations made by
 *   `data`, `bootstrap` and knowledge-maintenance `synthesis` runs. Revisions,
 *   supersedes and self-sourced scheduling entries are never checked, and neither is interactive memory or
 *   content the user handed to the assistant.
 * - Three modes, read live: `off`; `shadow` saves every record at once and
 *   judges it in the background, so it can never delay or lose a write;
 *   `enforce` asks before the write and drops a record scored below the
 *   threshold.
 * - Absent unless the decision capability is assigned. Fails open: an
 *   unreachable or slow model saves the record and is recorded as
 *   `unavailable`.
 *
 * Every verdict goes to the decision ledger with its record id, so the runs
 * page shows what was judged and whether the verdict was acted on.
 */

import { askScore, raceAbort } from "../decision-call.js";
import {
  parseCognitionDataRunPayload,
  parseCognitionSynthesisRunPayload,
} from "../run-payloads.js";
import {
  RECORD_BELONGS_QUESTIONS,
  RECORD_BELONGS_QUESTION_ID,
  RECORD_BELONGS_THRESHOLD,
  RECORD_CHECK_RUBRIC_VERSION,
  recordBelongsState,
  type RecordType,
} from "./rubric.js";
import type { DecisionCapability, Logger } from "@omnesis/core";
import type { RecordCheckMode } from "../config.js";
import type { CognitionDecisionRecord, DecisionVerdict } from "../storage/decisions.js";
import type { ClaimedCognitionRun } from "../storage/types.js";

/**
 * How long an enforcing check may hold a write. The model answers in well under
 * a second; past this the record is saved unjudged rather than letting the
 * agent's tool call run into its own deadline.
 */
const ENFORCE_TIMEOUT_MS = 15_000;

export interface RecordCheckInput {
  /** The id the record will be saved under. */
  recordId: string;
  record: { type: RecordType; kind: string | null; text: string };
  /** The document the record rests on; anchors the ledger row. */
  documentId: string;
}

type RecordCheckOutcome =
  | { save: true }
  | { save: false; decisionId: string; score: number; threshold: number };

/** The check bound to one run. Never throws, except when `signal` aborts. */
export type CheckRecord = (
  input: RecordCheckInput,
  signal?: AbortSignal,
) => Promise<RecordCheckOutcome>;

interface RecordCheckDeps {
  /** The live decision backend, or null when the capability is absent. */
  getDecision: () => DecisionCapability | null;
  getMode: () => RecordCheckMode;
  recordDecision: (record: CognitionDecisionRecord) => Promise<void>;
  recordSpend: (modelId: string, inputTokens: number) => Promise<void>;
  clock: () => number;
  idGen: () => string;
  log: Logger;
}

type CheckedLane = "data" | "bootstrap" | "synthesis";

const SAVE: RecordCheckOutcome = { save: true };

export class RecordCheck {
  /** Background (shadow) judgements still running. */
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: RecordCheckDeps) {}

  /** The check for `run`'s records, or null when its records are never checked. */
  forRun(run: ClaimedCognitionRun): CheckRecord | null {
    const lane = checkedLane(run);
    if (lane === null) return null;
    return (input, signal) => this.check(run.id, lane, input, signal);
  }

  /** Resolves once every background judgement has been recorded. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private async check(
    runId: string,
    lane: CheckedLane,
    input: RecordCheckInput,
    signal: AbortSignal | undefined,
  ): Promise<RecordCheckOutcome> {
    const mode = this.deps.getMode();
    if (mode === "off") return SAVE;
    const decision = this.deps.getDecision();
    if (!decision) return SAVE;
    if (mode === "shadow") {
      // Judged after the fact, detached from the run: the record is saved now.
      const judged = this.judge(decision, runId, lane, input, false, undefined)
        .then(() => undefined)
        .catch((err: unknown) => this.logSkipped(input, err))
        .finally(() => this.pending.delete(judged));
      this.pending.add(judged);
      return SAVE;
    }
    try {
      return await raceAbort(this.judge(decision, runId, lane, input, true, signal), signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      this.logSkipped(input, err);
      return SAVE;
    }
  }

  private async judge(
    decision: DecisionCapability,
    runId: string,
    lane: CheckedLane,
    input: RecordCheckInput,
    enforced: boolean,
    signal: AbortSignal | undefined,
  ): Promise<RecordCheckOutcome> {
    const judgement = await askScore(
      decision,
      { state: recordBelongsState(input.record), questions: RECORD_BELONGS_QUESTIONS },
      RECORD_BELONGS_QUESTION_ID,
      {
        recordSpend: this.deps.recordSpend,
        log: this.deps.log,
        ...(enforced ? { timeoutMs: ENFORCE_TIMEOUT_MS } : {}),
        ...(signal ? { signal } : {}),
      },
    );
    const verdict: DecisionVerdict =
      judgement.score === null
        ? "unavailable"
        : judgement.score >= RECORD_BELONGS_THRESHOLD
          ? "pass"
          : "skip";
    const id = `dec_${this.deps.idGen()}`;
    await this.deps.recordDecision({
      id,
      runId,
      documentId: input.documentId,
      subjectDocumentId: input.documentId,
      purpose: "record-check",
      lane,
      rubricVersion: RECORD_CHECK_RUBRIC_VERSION,
      contentHash: null,
      requestedModelId: decision.modelId,
      modelId: judgement.modelId,
      requestJson: judgement.requestJson,
      responseJson: judgement.responseJson,
      score: judgement.score,
      threshold: RECORD_BELONGS_THRESHOLD,
      verdict,
      error: judgement.error,
      reusedFrom: null,
      recordId: input.recordId,
      enforced,
      latencyMs: judgement.latencyMs,
      inputTokens: judgement.inputTokens,
      createdAt: this.deps.clock(),
    });
    if (verdict !== "skip" || !enforced || judgement.score === null) return SAVE;
    this.deps.log.info(
      `record check dropped ${input.recordId} for run ${runId} (score ${judgement.score.toFixed(2)})`,
    );
    return {
      save: false,
      decisionId: id,
      score: judgement.score,
      threshold: RECORD_BELONGS_THRESHOLD,
    };
  }

  private logSkipped(input: RecordCheckInput, err: unknown): void {
    this.deps.log.warn(
      `record check skipped for ${input.recordId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** The lane whose records are checked, or null for runs that are never checked. */
function checkedLane(run: ClaimedCognitionRun): CheckedLane | null {
  if (run.kind === "bootstrap") return "bootstrap";
  if (run.kind === "synthesis") {
    const payload = parseCognitionSynthesisRunPayload(run.payload);
    return payload?.focus === "knowledge-maintenance" && payload.batchId ? "synthesis" : null;
  }
  if (run.kind === "data") {
    // Content the user handed to the assistant is never second-guessed.
    const payload = parseCognitionDataRunPayload(run.payload);
    return payload && payload.immediate !== true ? "data" : null;
  }
  return null;
}
