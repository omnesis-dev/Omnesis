// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The record check: when a background run saves a new annotation, ask the
 * decision model whether the record belongs in the owner's life memory.
 *
 * It judges what the agent decided to write, never what the agent should
 * investigate — every tool call and search still happens; only the final
 * sentence is weighed. Scope:
 * - New document and temporal annotations, person-profile writes, and outcome
 *   creation or substantive revisions made by `data`, `bootstrap`, and
 *   knowledge-maintenance `synthesis` runs. Scheduling-only edits,
 *   self-sourced timeline entries, interactive memory, and user-supplied
 *   content are outside this gate.
 * - Three modes, read live: `off`; `shadow` saves every record at once and
 *   judges it in the background, so it can never delay or lose a write;
 *   `enforce` asks before the write and drops a record scored below the
 *   threshold.
 * - Absent unless the decision capability is assigned. Fails open: an
 *   unreachable or slow model saves the record and is recorded as
 *   `unavailable`. Destructive person withdrawal is the exception: enforce
 *   keeps the predecessor pending when an assessment is unavailable.
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
  PERSON_WITHDRAWAL_VERSION,
  PERSON_WITHDRAWAL_QUESTION,
  PERSON_WITHDRAWAL_THRESHOLD,
  PERSON_WITHDRAWAL_QUESTIONS,
} from "./person-withdrawal.js";
import {
  PROFILE_DISTILLATION_QUESTIONS,
  PROFILE_DISTILLATION_QUESTION_ID,
  PROFILE_DISTILLATION_THRESHOLD,
} from "./profile-distillation.js";
import {
  OUTCOME_DEADLINE_QUESTIONS,
  OUTCOME_DEADLINE_QUESTION_ID,
  OUTCOME_DEADLINE_THRESHOLD,
} from "./outcome-deadline.js";
import {
  WIKI_VALUE_QUESTIONS,
  WIKI_VALUE_RUBRIC_VERSION,
  WIKI_REPAIR_QUESTIONS,
  WIKI_REPAIR_RUBRIC_VERSION,
  WIKI_REPAIR_THRESHOLD,
} from "./wiki-rubric.js";
import {
  DOCUMENT_RECORD_VALUE_QUESTIONS,
  PERSON_RECORD_VALUE_QUESTIONS,
  OUTCOME_RECORD_VALUE_QUESTIONS,
  OUTCOME_INTEGRITY_QUESTIONS,
  OUTCOME_INTEGRITY_QUESTION_ID,
  OUTCOME_INTEGRITY_THRESHOLD,
  RECORD_BELONGS_QUESTIONS,
  RECORD_BELONGS_QUESTION_ID,
  recordCheckThreshold,
  recordCheckPolicyKey,
  outcomeRecordPolicyKey,
  RECORD_CHECK_RUBRIC_VERSION,
  recordBelongsState,
  type RecordType,
} from "./rubric.js";
import type { WikiRecordContext } from "./wiki-context.js";
import type { DocumentRecordContext } from "./document-context.js";
import type { PersonRecordContext } from "./person-context.js";
import type { OutcomeRecordContext } from "./outcome-context.js";
import type { DecisionPayloadCapture } from "../decision-payload.js";
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
  /** Server-owned destructive operation; never inferred from model prose. */
  personWithdrawal?: boolean;
  record: { type: RecordType; kind: string | null; text: string };
  /** The document the record rests on; anchors the ledger row. */
  documentId: string;
  /** Source-vetted bounded context, required to judge doc-fact added value. */
  documentContext?: DocumentRecordContext;
  wikiContext?: WikiRecordContext;
  /** Source-vetted bounded context for person-profile placement. */
  personContext?: PersonRecordContext;
  /** Original source context for an outcome's actor, event and status. */
  outcomeContext?: OutcomeRecordContext;
  /** Trusted privacy ancestry captured before reading the model's supporting context. */
  payloadCapture?: DecisionPayloadCapture;
}

type RecordCheckOutcome =
  | { save: true; assessment?: { policy: string; decisionId: string; rubricVersion?: string } }
  | {
      save: false;
      decisionId: string;
      score: number;
      threshold: number;
      questionId?: string;
      unavailable?: boolean;
    };

/** The check bound to one run. Never throws, except when `signal` aborts. */
export type CheckRecord = ((
  input: RecordCheckInput,
  signal?: AbortSignal,
) => Promise<RecordCheckOutcome>) & {
  /** Live hint avoids source-context work while the gate is inactive. */
  needsDocumentContext?: () => boolean;
  policyKey?: () => string;
  outcomePolicyKey?: () => string;
  enforcesOutcomePolicy?: () => boolean;
};

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

type CheckedLane = string;

const SAVE: RecordCheckOutcome = { save: true };

export class RecordCheck {
  /** Background (shadow) judgements still running. */
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: RecordCheckDeps) {}

  /** The check for `run`'s records, or null when its records are never checked. */
  forRun(
    run: ClaimedCognitionRun,
    options: { autonomousWithdrawals?: boolean } = {},
  ): CheckRecord | null {
    const lane = checkedLane(run);
    const userSupplied =
      run.kind === "data" && parseCognitionDataRunPayload(run.payload)?.immediate === true;
    if (lane === null && (!options.autonomousWithdrawals || userSupplied)) return null;
    const check: CheckRecord = (input, signal) =>
      lane === null && !input.personWithdrawal
        ? Promise.resolve(SAVE)
        : this.check(run.id, lane ?? run.kind, input, signal);
    check.enforcesOutcomePolicy = () => lane !== null && this.deps.getMode() === "enforce";
    check.policyKey = () =>
      recordCheckPolicyKey(this.deps.getMode(), this.deps.getDecision()?.modelId ?? null);
    check.outcomePolicyKey = () =>
      outcomeRecordPolicyKey(this.deps.getMode(), this.deps.getDecision()?.modelId ?? null);
    check.needsDocumentContext = () =>
      lane !== null && this.deps.getMode() !== "off" && this.deps.getDecision() !== null;
    return check;
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
    if (!decision) {
      if (mode === "enforce" && input.personWithdrawal) {
        return this.withdrawalUnavailable(runId, lane, input, "Decision capability unavailable");
      }
      return SAVE;
    }
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
      return input.personWithdrawal
        ? this.withdrawalUnavailable(runId, lane, input, "Withdrawal assessment unavailable")
        : SAVE;
    }
  }

  private async withdrawalUnavailable(
    runId: string,
    lane: CheckedLane,
    input: RecordCheckInput,
    error: string,
  ): Promise<RecordCheckOutcome> {
    const id = `dec_${this.deps.idGen()}`;
    await this.deps.recordDecision({
      id,
      runId,
      documentId: input.documentId,
      subjectDocumentId: input.documentId,
      purpose: "record-check",
      lane,
      rubricVersion: PERSON_WITHDRAWAL_VERSION,
      contentHash: null,
      requestedModelId: this.deps.getDecision()?.modelId ?? "unassigned",
      modelId: null,
      requestJson: null,
      responseJson: null,
      score: null,
      threshold: PERSON_WITHDRAWAL_THRESHOLD,
      verdict: "unavailable",
      error,
      reusedFrom: null,
      recordId: input.recordId,
      enforced: true,
      latencyMs: 0,
      inputTokens: null,
      createdAt: this.deps.clock(),
    });
    return {
      save: false,
      decisionId: id,
      score: 0,
      threshold: PERSON_WITHDRAWAL_THRESHOLD,
      questionId: PERSON_WITHDRAWAL_QUESTION,
      unavailable: true,
    };
  }

  private async judge(
    decision: DecisionCapability,
    runId: string,
    lane: CheckedLane,
    input: RecordCheckInput,
    enforced: boolean,
    signal: AbortSignal | undefined,
  ): Promise<RecordCheckOutcome> {
    const primaryQuestion = input.personWithdrawal
      ? PERSON_WITHDRAWAL_QUESTION
      : RECORD_BELONGS_QUESTION_ID;
    const state = recordBelongsState(
      input.record,
      input.documentContext,
      input.personContext,
      input.outcomeContext,
      input.wikiContext,
    );
    const contextual = input.record.type !== "timeline";
    const contextLabel =
      input.record.type === "wiki"
        ? "Wiki synthesis"
        : input.record.type === "outcome"
          ? "Tracked outcome"
          : input.record.type === "person-fact"
            ? "Person annotation"
            : "Document annotation";
    const contextUnavailable =
      (input.personWithdrawal &&
        (!input.personContext?.withdrawal_sources?.length ||
          input.personContext.evidence_truncated)) ||
      (input.record.type === "doc-fact" && !input.documentContext) ||
      (input.record.type === "person-fact" &&
        (!input.personContext?.reconciliation || input.personContext.reconciliation.truncated)) ||
      (input.record.type === "outcome" && !input.outcomeContext) ||
      (input.record.type === "wiki" && !input.wikiContext);
    const revision = input.record.type === "outcome" && !!input.outcomeContext?.previous;
    const hasDeadline =
      input.record.type === "outcome" && input.outcomeContext?.proposed.deadline != null;
    const extraDimensions = [
      ...(input.record.type === "person-fact" && !input.personWithdrawal
        ? [{ id: PROFILE_DISTILLATION_QUESTION_ID, threshold: PROFILE_DISTILLATION_THRESHOLD }]
        : []),
      ...(revision
        ? [{ id: OUTCOME_INTEGRITY_QUESTION_ID, threshold: OUTCOME_INTEGRITY_THRESHOLD }]
        : []),
      ...(hasDeadline
        ? [{ id: OUTCOME_DEADLINE_QUESTION_ID, threshold: OUTCOME_DEADLINE_THRESHOLD }]
        : []),
    ];
    const questions = input.personWithdrawal
      ? PERSON_WITHDRAWAL_QUESTIONS
      : input.record.type === "wiki"
        ? input.wikiContext?.factualRepair
          ? WIKI_REPAIR_QUESTIONS
          : WIKI_VALUE_QUESTIONS
        : input.record.type === "outcome"
          ? {
              ...OUTCOME_RECORD_VALUE_QUESTIONS,
              ...(revision ? OUTCOME_INTEGRITY_QUESTIONS : {}),
              ...(hasDeadline ? OUTCOME_DEADLINE_QUESTIONS : {}),
            }
          : input.record.type === "doc-fact"
            ? DOCUMENT_RECORD_VALUE_QUESTIONS
            : input.record.type === "person-fact"
              ? { ...PERSON_RECORD_VALUE_QUESTIONS, ...PROFILE_DISTILLATION_QUESTIONS }
              : RECORD_BELONGS_QUESTIONS;
    // Context cannot be inferred from the record alone. Preserve the write
    // without a guessed score if a safe source view is unavailable.
    const judgement = contextUnavailable
      ? {
          modelId: decision.modelId,
          requestJson: JSON.stringify({ model: decision.modelId, state, questions }),
          responseJson: null,
          score: null,
          error: `${contextLabel} source context unavailable`,
          latencyMs: 0,
          inputTokens: null,
        }
      : await askScore(decision, { state, questions }, primaryQuestion, {
          ...(extraDimensions.length
            ? { additionalQuestionIds: extraDimensions.map((dimension) => dimension.id) }
            : {}),
          recordSpend: this.deps.recordSpend,
          log: contextual
            ? {
                ...this.deps.log,
                warn: () => this.deps.log.warn(`${contextLabel} value check unavailable`),
              }
            : this.deps.log,
          ...(enforced ? { timeoutMs: ENFORCE_TIMEOUT_MS } : {}),
          ...(signal ? { signal } : {}),
        });
    const belongsThreshold = input.personWithdrawal
      ? PERSON_WITHDRAWAL_THRESHOLD
      : input.wikiContext?.factualRepair
        ? WIKI_REPAIR_THRESHOLD
        : recordCheckThreshold(input.record.type);
    const dimensions: Record<string, { score: number | null; threshold: number }> = {
      [primaryQuestion]: { score: judgement.score, threshold: belongsThreshold },
      ...Object.fromEntries(
        extraDimensions.map(({ id, threshold }) => [
          id,
          {
            score:
              "additionalScores" in judgement ? (judgement.additionalScores?.[id] ?? null) : null,
            threshold,
          },
        ]),
      ),
    };
    // Independent requirements: relevance cannot compensate for an unsupported date or lost progress.
    const [questionId, limiting] = Object.entries(dimensions).reduce((lowest, entry) => {
      const margin = (value: { score: number | null; threshold: number }) =>
        value.score === null ? -Infinity : value.score - value.threshold;
      return margin(entry[1]) < margin(lowest[1]) ? entry : lowest;
    });
    const { score, threshold } = limiting;
    const assessment = extraDimensions.length
      ? { limiting_question: questionId, dimensions }
      : undefined;
    const verdict: DecisionVerdict =
      score === null ? "unavailable" : score >= threshold ? "pass" : "skip";
    const id = `dec_${this.deps.idGen()}`;
    await this.deps.recordDecision({
      id,
      runId,
      documentId: input.documentId,
      subjectDocumentId: input.documentId,
      purpose: "record-check",
      lane,
      rubricVersion: input.personWithdrawal
        ? PERSON_WITHDRAWAL_VERSION
        : input.record.type === "wiki"
          ? input.wikiContext?.factualRepair
            ? WIKI_REPAIR_RUBRIC_VERSION
            : WIKI_VALUE_RUBRIC_VERSION
          : RECORD_CHECK_RUBRIC_VERSION,
      contentHash: null,
      requestedModelId: decision.modelId,
      modelId: judgement.modelId,
      ...(input.payloadCapture && !contextUnavailable
        ? {
            payloadCapture: input.payloadCapture,
            payload: {
              requestJson: judgement.requestJson,
              responseJson: judgement.responseJson,
              error: judgement.error,
            },
          }
        : {}),
      // Extra-source text has no decision-ledger deletion reference. Retain
      // only an explicitly redacted context summary, not those new contents.
      requestJson:
        input.record.type === "wiki"
          ? JSON.stringify({
              model: decision.modelId,
              questions,
              state: {
                record_type: "wiki",
                record: "[Redacted; inspect the privacy-bound decision payload]",
                wiki_context: {
                  redacted: true,
                  replayable: false,
                  reference_count: input.wikiContext?.references.length ?? 0,
                },
              },
            })
          : input.record.type === "outcome"
            ? JSON.stringify({
                model: decision.modelId,
                questions,
                ...(assessment ? { assessment } : {}),
                state: {
                  record_type: state.record_type,
                  record: "[Redacted; inspect the privacy-bound decision payload]",
                  outcome_context: {
                    redacted: true,
                    replayable: false,
                    source_count: input.outcomeContext?.sources.length ?? 0,
                    sources_omitted: input.outcomeContext?.sources_omitted ?? 0,
                  },
                },
              })
            : input.record.type === "doc-fact"
              ? JSON.stringify({
                  model: decision.modelId,
                  questions,
                  state: {
                    record_type: state.record_type,
                    record: "[Redacted; inspect the privacy-bound decision payload]",
                    document_context: {
                      redacted: true,
                      replayable: false,
                      subject_characters: input.documentContext?.subject_characters,
                      subject_truncated: input.documentContext?.subject_truncated,
                      evidence_truncated: input.documentContext?.evidence_truncated,
                      other_source_count: new Set(
                        (input.documentContext?.evidence ?? [])
                          .filter((e) => !e.is_subject)
                          .map((e) => e.source),
                      ).size,
                    },
                  },
                })
              : input.record.type === "person-fact"
                ? JSON.stringify({
                    model: decision.modelId,
                    questions,
                    state: {
                      record_type: state.record_type,
                      record: "[Redacted; inspect the privacy-bound decision payload]",
                      person_context: {
                        redacted: true,
                        replayable: false,
                        evidence_truncated: input.personContext?.evidence_truncated,
                        source_count: new Set(
                          (input.personContext?.evidence ?? []).map((e) => e.source),
                        ).size,
                      },
                    },
                  })
                : judgement.requestJson,
      responseJson: contextual
        ? judgement.score === null
          ? null
          : JSON.stringify({
              model: decision.modelId,
              answers: {
                [primaryQuestion]: { type: "score", score: judgement.score },
                ...Object.fromEntries(
                  extraDimensions.map(({ id }) => [
                    id,
                    { type: "score", score: dimensions[id]!.score },
                  ]),
                ),
              },
              ...(assessment ? { assessment } : {}),
            })
        : judgement.responseJson,
      score,
      threshold,
      verdict,
      error:
        contextual && judgement.error
          ? contextUnavailable
            ? `${contextLabel} source context unavailable`
            : `${contextLabel} value check unavailable`
          : judgement.error,
      reusedFrom: null,
      recordId: input.recordId,
      enforced,
      latencyMs: judgement.latencyMs,
      inputTokens: judgement.inputTokens,
      createdAt: this.deps.clock(),
    });
    if (
      verdict === "pass" &&
      enforced &&
      (input.record.type === "outcome" || input.record.type === "wiki")
    )
      return {
        save: true,
        assessment: {
          policy:
            input.record.type === "outcome"
              ? outcomeRecordPolicyKey("enforce", decision.modelId)
              : recordCheckPolicyKey("enforce", decision.modelId),
          decisionId: id,
          ...(input.wikiContext?.factualRepair
            ? { rubricVersion: WIKI_REPAIR_RUBRIC_VERSION }
            : {}),
        },
      };
    if (input.personWithdrawal && enforced && verdict === "unavailable")
      return {
        save: false,
        decisionId: id,
        score: 0,
        threshold,
        questionId: primaryQuestion,
        unavailable: true,
      };
    if (verdict !== "skip" || !enforced || score === null) return SAVE;
    this.deps.log.info(
      `record check dropped ${input.recordId} for run ${runId} (${questionId} score ${score.toFixed(2)})`,
    );
    return {
      save: false,
      decisionId: id,
      score,
      threshold,
      ...(extraDimensions.length || input.personWithdrawal ? { questionId } : {}),
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
