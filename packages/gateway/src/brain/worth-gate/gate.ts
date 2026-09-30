// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The worth gate: before a claimed `bootstrap` or `data` run starts its
 * background-agent turn, ask the decision model whether the email behind it is
 * worth one. A skip settles the run with no agent turn at all.
 *
 * Scope and order:
 * - Only emails are judged (the rubric was validated on email); an attachment
 *   is judged by its parent email, so a logo inside an important thread rides
 *   on the thread's verdict. Every other document passes untouched.
 * - It runs after the lanes' own filters — the bootstrap lane's future-date
 *   predicate and the waker's bulk/automated rules — because it sits at claim
 *   time, on runs those filters already admitted.
 * - Mail the user handed to the assistant, and mail carrying structured
 *   `dueAt` / `scheduledAt` dates, always passes: those are the exemptions the
 *   waker already makes, and a cheap judgement must not override them.
 * - Absent unless the decision capability is assigned and ready.
 * - Fails open: an unreachable model, a rejected key or a malformed reply
 *   passes the run and is recorded as `unavailable`.
 *
 * Every judgement is appended to the decision ledger (`cognition_decisions`)
 * with its exact request and answers — the audit trail the runs page shows.
 * An unchanged document (same content hash, same rubric version) reuses its
 * earlier answer instead of paying for a second call.
 */

import {
  canonicalJson,
  type DecisionCapability,
  type DecisionRequest,
  type Logger,
} from "@omnesis/core";
import { documentsMetadataCodec } from "../../data/json-columns.js";
import { resolveContainingDocument } from "../../domain/LinkGraphService.js";
import {
  parseCognitionBootstrapRunPayload,
  parseCognitionDataRunPayload,
} from "../run-payloads.js";
import {
  findReusableDecision,
  type CognitionDecisionRecord,
  type DecisionVerdict,
} from "../storage/decisions.js";
import {
  EMAIL_WORTH_QUESTIONS,
  EMAIL_WORTH_QUESTION_ID,
  EMAIL_WORTH_THRESHOLD,
  WORTH_GATED_DOCUMENT_TYPE,
  WORTH_GATE_RUBRIC_VERSION,
  WORTH_GATE_SPEND_MECHANISM,
  emailWorthState,
} from "./rubric.js";
import type { ClaimedCognitionRun } from "../storage/types.js";
import type { WriteGate } from "../../write-gate.js";
import type Database from "better-sqlite3";

type Db = Database.Database;

/**
 * Record one decision's tokens under the worth-gate mechanism. A decision is
 * not an agent run: its tokens count toward the daily token budget, never the
 * daily run budget.
 */
export function recordWorthGateSpend(
  writeGate: Pick<WriteGate, "recordCognitionSpend">,
  day: string,
  modelId: string,
  inputTokens: number,
): Promise<void> {
  return writeGate.recordCognitionSpend(
    day,
    WORTH_GATE_SPEND_MECHANISM,
    modelId,
    { promptTokens: inputTokens, completionTokens: 0 },
    { countRun: false },
  );
}

/** Per-decision timeout; a slower model is treated as unavailable. */
const DECISION_TIMEOUT_MS = 45_000;

export interface WorthGateDeps {
  /** Read handle; the gate never writes directly. */
  db: Db;
  /** The live decision backend, or null when the capability is absent. */
  getDecision: () => DecisionCapability | null;
  recordDecision: (record: CognitionDecisionRecord) => Promise<void>;
  recordSpend: (modelId: string, inputTokens: number) => Promise<void>;
  clock: () => number;
  idGen: () => string;
  log: Logger;
}

export interface WorthGateOutcome {
  verdict: DecisionVerdict;
  decisionId: string;
  score: number | null;
  threshold: number;
  /** The model the verdict came from (the original answer's, when reused). */
  modelId: string | null;
}

interface DocRow {
  id: string;
  title: string | null;
  content: string | null;
  content_hash: string;
  metadata: string;
}

interface Judgement {
  modelId: string;
  requestJson: string;
  responseJson: string | null;
  score: number | null;
  error: string | null;
  latencyMs: number;
  inputTokens: number | null;
}

export class WorthGate {
  /**
   * Judgements in flight, keyed by subject and content. With several drainer
   * workers, an email and its attachment can be claimed together; both then
   * share one decision-model call instead of paying for two.
   */
  private readonly inFlight = new Map<string, Promise<Judgement>>();

  constructor(private readonly deps: WorthGateDeps) {}

  /**
   * Judge the document behind `run`. Returns null when the gate does not apply
   * (not a gated lane or document, an exempt document, or no decision model),
   * otherwise the recorded verdict. Never throws.
   */
  async evaluate(run: ClaimedCognitionRun, signal?: AbortSignal): Promise<WorthGateOutcome | null> {
    try {
      return await this.evaluateUnsafe(run, signal);
    } catch (err) {
      if (signal?.aborted) return null;
      this.deps.log.warn(
        `worth gate skipped for run ${run.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async evaluateUnsafe(
    run: ClaimedCognitionRun,
    signal: AbortSignal | undefined,
  ): Promise<WorthGateOutcome | null> {
    const target = this.target(run);
    if (!target) return null;
    const doc = this.readDoc(target.docId);
    if (!doc) return null;
    const docMeta = parseMetadata(doc);
    if (hasStructuredDate(docMeta)) return null;

    let subject: DocRow | null = doc;
    let subjectMeta = docMeta;
    if (docMeta.documentType !== WORTH_GATED_DOCUMENT_TYPE) {
      // An attachment is judged by the email that contains it.
      const containment = resolveContainingDocument(this.deps.db, doc.id);
      if (containment.kind !== "contained") return null;
      subject = this.readDoc(containment.parentDocumentId);
      if (!subject) return null;
      subjectMeta = parseMetadata(subject);
      if (subjectMeta.documentType !== WORTH_GATED_DOCUMENT_TYPE) return null;
      if (hasStructuredDate(subjectMeta)) return null;
    }

    const decision = this.deps.getDecision();
    if (!decision) return null;

    const state = emailWorthState({
      title: subject.title,
      content: subject.content,
      metadata: subjectMeta,
    });
    const contentHash = subject.content_hash;

    const base = {
      runId: run.id,
      documentId: doc.id,
      subjectDocumentId: subject.id,
      purpose: "worth-gate" as const,
      lane: target.lane,
      rubricVersion: WORTH_GATE_RUBRIC_VERSION,
      contentHash,
      requestedModelId: decision.modelId,
      threshold: EMAIL_WORTH_THRESHOLD,
    };

    const reusable = findReusableDecision(
      this.deps.db,
      subject.id,
      WORTH_GATE_RUBRIC_VERSION,
      contentHash,
      decision.modelId,
    );
    if (reusable && reusable.score !== null) {
      const verdict = verdictFor(reusable.score);
      const record: CognitionDecisionRecord = {
        ...base,
        id: `dec_${this.deps.idGen()}`,
        modelId: reusable.modelId,
        requestJson: null,
        responseJson: null,
        score: reusable.score,
        verdict,
        error: null,
        reusedFrom: reusable.id,
        recordId: null,
        enforced: true,
        latencyMs: null,
        inputTokens: null,
        createdAt: this.deps.clock(),
      };
      await this.deps.recordDecision(record);
      return {
        verdict,
        decisionId: record.id,
        score: reusable.score,
        threshold: EMAIL_WORTH_THRESHOLD,
        modelId: reusable.modelId,
      };
    }

    const key = `${subject.id}:${contentHash}`;
    let pending = this.inFlight.get(key);
    // The run that started the call carries its tokens; a run sharing it
    // records the same answer without claiming a second call's cost.
    const shared = pending !== undefined;
    if (!pending) {
      pending = this.judge(decision, { state, questions: EMAIL_WORTH_QUESTIONS }).finally(() =>
        this.inFlight.delete(key),
      );
      this.inFlight.set(key, pending);
    }
    // Each run may abandon the shared call on its own abort; the call itself
    // runs to completion for any other run waiting on it.
    const judgement = await raceAbort(pending, signal);
    const record: CognitionDecisionRecord = {
      ...base,
      id: `dec_${this.deps.idGen()}`,
      modelId: judgement.modelId,
      requestJson: judgement.requestJson,
      responseJson: judgement.responseJson,
      score: judgement.score,
      verdict: judgement.score === null ? "unavailable" : verdictFor(judgement.score),
      error: judgement.error,
      reusedFrom: null,
      recordId: null,
      enforced: true,
      latencyMs: judgement.latencyMs,
      inputTokens: shared ? null : judgement.inputTokens,
      createdAt: this.deps.clock(),
    };
    await this.deps.recordDecision(record);
    return {
      verdict: record.verdict,
      decisionId: record.id,
      score: record.score,
      threshold: EMAIL_WORTH_THRESHOLD,
      modelId: record.modelId,
    };
  }

  /**
   * One decision-model call, bounded by its own timeout rather than by any one
   * run's signal, because several runs may be waiting on it. Never throws: a
   * model failure becomes an unavailable judgement.
   */
  private async judge(decision: DecisionCapability, request: DecisionRequest): Promise<Judgement> {
    const requestJson = canonicalJson({ model: decision.modelId, ...request });
    const started = performance.now();
    try {
      const result = await decision.decide(request, {
        signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
      });
      const answer = result.answers[EMAIL_WORTH_QUESTION_ID];
      if (!answer || answer.type !== "score") throw new Error("decision reply has no worth score");
      if (result.inputTokens) await this.deps.recordSpend(result.model, result.inputTokens);
      return {
        modelId: result.model,
        requestJson,
        responseJson: JSON.stringify({ model: result.model, answers: result.answers }),
        score: answer.score,
        error: null,
        latencyMs: Math.round(performance.now() - started),
        inputTokens: result.inputTokens ?? null,
      };
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.deps.log.warn(`worth gate: decision model unavailable (${error})`);
      return {
        modelId: decision.modelId,
        requestJson,
        responseJson: null,
        score: null,
        error,
        latencyMs: Math.round(performance.now() - started),
        inputTokens: null,
      };
    }
  }

  private target(run: ClaimedCognitionRun): { docId: string; lane: "data" | "bootstrap" } | null {
    if (run.kind === "data") {
      const payload = parseCognitionDataRunPayload(run.payload);
      // Content the user handed to the assistant is never second-guessed.
      if (!payload || payload.immediate === true) return null;
      return { docId: payload.docId, lane: "data" };
    }
    if (run.kind === "bootstrap") {
      const payload = parseCognitionBootstrapRunPayload(run.payload);
      return payload ? { docId: payload.docId, lane: "bootstrap" } : null;
    }
    return null;
  }

  private readDoc(id: string): DocRow | null {
    return (
      this.deps.db
        .prepare<
          [string],
          DocRow
        >(`SELECT id, title, content, content_hash, metadata FROM documents WHERE id = ?`)
        .get(id) ?? null
    );
  }
}

/** Resolve with `promise`, or reject as soon as `signal` aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function verdictFor(score: number): "pass" | "skip" {
  return score >= EMAIL_WORTH_THRESHOLD ? "pass" : "skip";
}

function parseMetadata(doc: DocRow): Record<string, unknown> {
  return documentsMetadataCodec.parseWithFallback(doc.metadata, { rowId: doc.id }) as Record<
    string,
    unknown
  >;
}

/** Structured booking/invoice dates — the waker's own bulk-mail exemption. */
function hasStructuredDate(meta: Record<string, unknown>): boolean {
  return typeof meta.dueAt === "string" || typeof meta.scheduledAt === "string";
}
