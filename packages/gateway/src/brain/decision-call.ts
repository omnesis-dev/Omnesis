// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * One scored question to the decision model, the way every Brain check asks
 * it: bounded by its own timeout, spend-recorded, and never throwing — an
 * unreachable model, a rejected key or a malformed reply becomes an answer
 * with no score, which callers treat as "judgement unavailable" and fail open.
 */

import {
  canonicalJson,
  type DecisionCapability,
  type DecisionRequest,
  type Logger,
} from "@omnesis/core";
import type { WriteGate } from "../write-gate.js";

/** Default per-decision timeout; a slower model is treated as unavailable. */
const DECISION_TIMEOUT_MS = 45_000;

export interface ScoreJudgement {
  /** The model that answered, or the requested one when none did. */
  modelId: string;
  /** The exact request, as the ledger stores it. */
  requestJson: string;
  responseJson: string | null;
  score: number | null;
  error: string | null;
  latencyMs: number;
  inputTokens: number | null;
}

export async function askScore(
  decision: DecisionCapability,
  request: DecisionRequest,
  questionId: string,
  opts: {
    recordSpend: (modelId: string, inputTokens: number) => Promise<void>;
    log: Logger;
    timeoutMs?: number;
    /** Cancels the call as well; the timeout still applies. */
    signal?: AbortSignal;
  },
): Promise<ScoreJudgement> {
  const requestJson = canonicalJson({ model: decision.modelId, ...request });
  const started = performance.now();
  try {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? DECISION_TIMEOUT_MS);
    const result = await decision.decide(request, {
      signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
    });
    const answer = result.answers[questionId];
    if (!answer || answer.type !== "score") {
      throw new Error(`decision reply has no score for "${questionId}"`);
    }
    if (result.inputTokens) await opts.recordSpend(result.model, result.inputTokens);
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
    opts.log.warn(`decision model unavailable (${error})`);
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

/**
 * Record one decision's tokens under `mechanism`. A decision is not an agent
 * run: its tokens count toward the daily token budget, never the daily run
 * budget.
 */
export function recordDecisionSpend(
  writeGate: Pick<WriteGate, "recordCognitionSpend">,
  day: string,
  mechanism: string,
  modelId: string,
  inputTokens: number,
): Promise<void> {
  return writeGate.recordCognitionSpend(
    day,
    mechanism,
    modelId,
    { promptTokens: inputTokens, completionTokens: 0 },
    { countRun: false },
  );
}

/** Resolve with `promise`, or reject as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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
