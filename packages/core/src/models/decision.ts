// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Typed decisions — the `decision` capability.
 *
 * A decision model reads a piece of `state` (text or JSON) and answers a map
 * of typed questions with calibrated probabilities instead of generated text.
 * Three question shapes cover every use:
 *
 * - `noul`   — a yes/no question, answered with the probability of yes.
 * - `score`  — a position on 2–10 ordered, described levels, answered with the
 *              probability-weighted level (0 = first level).
 * - `choice` — one option from a named set, answered with the chosen key.
 *
 * The shapes mirror TypeSafe's System One API, the first supported backend,
 * but nothing here is provider-specific: a backend adapts its wire format to
 * these types, and consumers (the Brain's worth gate) only ever see them.
 */

/** Instructions or criteria text, or a structured object referring to named data. */
export type DecisionText = string | Record<string, unknown> | ReadonlyArray<unknown>;

export interface DecisionNoulQuestion {
  readonly type: "noul";
  readonly instructions: DecisionText;
  /** What a yes (value near 1) and a no (value near 0) mean. */
  readonly criteria?: { readonly true?: DecisionText; readonly false?: DecisionText };
}

export interface DecisionScoreQuestion {
  readonly type: "score";
  readonly instructions: DecisionText;
  /** Ordered level descriptions, lowest first (2–10 entries). */
  readonly criteria: ReadonlyArray<DecisionText>;
}

export interface DecisionChoiceQuestion {
  readonly type: "choice";
  readonly instructions: DecisionText;
  /** Option key → description (null when the key says enough). */
  readonly criteria: Readonly<Record<string, DecisionText | null>>;
}

export type DecisionQuestion =
  | DecisionNoulQuestion
  | DecisionScoreQuestion
  | DecisionChoiceQuestion;

export interface DecisionNoulAnswer {
  readonly type: "noul";
  /** Probability that the answer is yes, 0–1. */
  readonly noul: number;
}

export interface DecisionScoreAnswer {
  readonly type: "score";
  /** Probability-weighted level, 0 … levels-1. */
  readonly score: number;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
}

export interface DecisionChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly confidence?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
}

export type DecisionAnswer = DecisionNoulAnswer | DecisionScoreAnswer | DecisionChoiceAnswer;

export interface DecisionRequest {
  /** The content to judge: a string, or a JSON object / array of text values. */
  readonly state: unknown;
  /** Question id → question. Ids are for the caller; they never reach the model. */
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

export interface DecisionResult {
  /** The versioned model that answered (a backend may resolve an alias). */
  readonly model: string;
  /** Question id → answer, one per asked question. */
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  /** Billed input tokens, when the backend reports them. */
  readonly inputTokens?: number;
}

/**
 * The decision capability. Implementations MUST throw rather than guess when
 * they cannot answer (unreachable, unauthorised, rate-limited, malformed
 * reply): callers treat a throw as "decision unavailable" and fail open, which
 * is safer than a fabricated answer silently steering the caller.
 */
export interface DecisionCapability {
  /** The model id requests are sent with (a pinned version, not an alias). */
  readonly modelId: string;
  decide(request: DecisionRequest, opts?: { signal?: AbortSignal }): Promise<DecisionResult>;
  dispose(): void | Promise<void>;
}
