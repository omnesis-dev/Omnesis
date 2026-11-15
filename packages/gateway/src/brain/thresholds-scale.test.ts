// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, it } from "vitest";
import { validateConfig } from "@omnesis/config";
import { EMAIL_WORTH_QUESTIONS } from "../worth/rubric.js";
import { BRAIN_DEFAULTS, type BrainThresholds } from "./config.js";
import { OUTCOME_DEADLINE_QUESTIONS } from "./record-check/outcome-deadline.js";
import { PERSON_WITHDRAWAL_QUESTIONS } from "./record-check/person-withdrawal.js";
import { PROFILE_DISTILLATION_QUESTIONS } from "./record-check/profile-distillation.js";
import {
  DOCUMENT_RECORD_VALUE_QUESTIONS,
  OUTCOME_INTEGRITY_QUESTIONS,
  OUTCOME_RECORD_VALUE_QUESTIONS,
  PERSON_RECORD_VALUE_QUESTIONS,
  RECORD_BELONGS_QUESTIONS,
} from "./record-check/rubric.js";
import { WIKI_REPAIR_QUESTIONS, WIKI_VALUE_QUESTIONS } from "./record-check/wiki-rubric.js";
import { NEW_NOTE_QUESTIONS, SAME_TASK_QUESTIONS } from "./tasks/task-checks.js";
import { TIER_QUESTIONS } from "./tasks/task-propose.js";
import type { DecisionQuestion } from "@omnesis/core";

type Questions = Readonly<Record<string, DecisionQuestion>>;

/**
 * The questions each threshold is compared with, or "normalized" for the
 * knowledge decisions, whose scores the engine maps onto 0–1.
 */
const COMPARED_WITH: Record<keyof BrainThresholds, readonly Questions[] | "normalized"> = {
  worthGate: [EMAIL_WORTH_QUESTIONS],
  discovery: "normalized",
  impact: "normalized",
  reviewNow: "normalized",
  reviewDormant: "normalized",
  recordBelongs: [RECORD_BELONGS_QUESTIONS, OUTCOME_RECORD_VALUE_QUESTIONS, WIKI_VALUE_QUESTIONS],
  documentRecordValue: [DOCUMENT_RECORD_VALUE_QUESTIONS],
  personRecordValue: [PERSON_RECORD_VALUE_QUESTIONS],
  personWithdrawal: [PERSON_WITHDRAWAL_QUESTIONS],
  profileDistillation: [PROFILE_DISTILLATION_QUESTIONS],
  wikiRepair: [WIKI_REPAIR_QUESTIONS],
  outcomeIntegrity: [OUTCOME_INTEGRITY_QUESTIONS],
  outcomeDeadline: [OUTCOME_DEADLINE_QUESTIONS],
  sameTask: [SAME_TASK_QUESTIONS],
  taskNoteNew: [NEW_NOTE_QUESTIONS],
  taskAdopt: [TIER_QUESTIONS],
  taskWithhold: [TIER_QUESTIONS],
};

/** The top of a score question's scale: one level per criterion, from 0. */
function top(questions: Questions): number {
  const [question] = Object.values(questions);
  if (question?.type !== "score") throw new Error("not a score question");
  return question.criteria.length - 1;
}

/** The partner a value at either end of the scale needs to keep an ordered pair valid. */
function withPartner(key: keyof BrainThresholds, value: number): Record<string, number> {
  if (key === "reviewDormant") return { reviewDormant: value, reviewNow: 1 };
  if (key === "reviewNow") return { reviewNow: value, reviewDormant: 0 };
  if (key === "taskWithhold") return { taskWithhold: value, taskAdopt: 2 };
  if (key === "taskAdopt") return { taskAdopt: value, taskWithhold: 0 };
  return { [key]: value };
}

const accepts = (thresholds: Record<string, number>) =>
  validateConfig({ brain: { thresholds } }).ok;

describe("decision threshold scales", () => {
  it.each(Object.keys(COMPARED_WITH) as Array<keyof BrainThresholds>)(
    "%s accepts exactly its question's scale, and its default lies on it",
    (key) => {
      const source = COMPARED_WITH[key];
      const tops = source === "normalized" ? [1] : source.map(top);
      // Every question a threshold is compared with has the same scale.
      expect(new Set(tops).size).toBe(1);
      const max = tops[0]!;
      expect(accepts(withPartner(key, max))).toBe(true);
      expect(accepts(withPartner(key, max + 0.01))).toBe(false);
      expect(BRAIN_DEFAULTS.thresholds[key]).toBeGreaterThanOrEqual(0);
      expect(BRAIN_DEFAULTS.thresholds[key]).toBeLessThanOrEqual(max);
    },
  );

  it("bounds the mention worth threshold by the email worth question", () => {
    const max = top(EMAIL_WORTH_QUESTIONS);
    expect(validateConfig({ enrichment: { dates: { worthThreshold: max } } }).ok).toBe(true);
    expect(validateConfig({ enrichment: { dates: { worthThreshold: max + 0.01 } } }).ok).toBe(
      false,
    );
  });
});
