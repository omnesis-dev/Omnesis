// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The record check's rubric: the one question the decision model answers about
 * a record a background run is about to save.
 *
 * The state is the record alone — its kind and its sentence — never the
 * document it came from: the question is whether this sentence belongs in the
 * owner's life memory, not whether its source was worth reading (the worth
 * gate already asked that). On a set of background-run outputs graded useful
 * or noise, the 4-level score separates them at AUC ≈ 0.93; at the threshold
 * below it keeps 95% of the useful records and drops about half the noise
 * (newsletter and marketing dates, product news, descriptions of what a
 * document is).
 *
 * Bump {@link RECORD_CHECK_RUBRIC_VERSION} whenever the question, the state or
 * the threshold changes.
 */

import type { DecisionQuestion } from "@omnesis/core";

export const RECORD_CHECK_RUBRIC_VERSION = "record-belongs-v1";

/** Spend mechanism the check's decision-model tokens are recorded under. */
export const RECORD_CHECK_SPEND_MECHANISM = "record-check";

/** Keep when the score is at or above this (levels run 0–3). */
export const RECORD_BELONGS_THRESHOLD = 0.81;

export const RECORD_BELONGS_QUESTION_ID = "belongs";

export const RECORD_BELONGS_QUESTIONS: Readonly<Record<string, DecisionQuestion>> = {
  [RECORD_BELONGS_QUESTION_ID]: {
    type: "score",
    instructions: "How much does `record` belong in the owner's personal life memory?",
    criteria: [
      "Not at all: news, newsletter or marketing content, offer or event promotion, routine automated notice, or a description of what a document is.",
      "Barely: a routine automated fact about the owner's accounts or tools.",
      "Yes: a fact, event, plan or obligation in the owner's own life or work.",
      "Definitely: a commitment, deadline, money, travel, health, legal matter, or something about a person they know.",
    ],
  },
};

/** The kinds of record the check judges, named as the rubric was validated. */
export type RecordType = "timeline" | "doc-fact" | "person-fact";

interface RecordBelongsState {
  record_type: RecordType;
  record_kind: string;
  record: string;
}

export function recordBelongsState(record: {
  type: RecordType;
  kind: string | null;
  text: string;
}): RecordBelongsState {
  return { record_type: record.type, record_kind: record.kind ?? "", record: record.text };
}
