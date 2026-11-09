// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Typed decisions from a chat model — the pure half shared by the HTTP and
 * local GGUF backends of the decision capability.
 *
 * A chat model never writes its answer as text. Each question becomes a prompt
 * whose answer is exactly one single-token label: `yes`/`no` for a noul, a
 * level digit for a score, a letter for a choice (option keys are relabelled
 * because a key like `needs_review` spans several tokens). The backend then
 * reads the model's distribution over the next token, keeps only the labels'
 * probabilities and renormalises them into the typed answer, so a noul is
 * P(yes), a score is the probability-weighted level and a choice is the most
 * probable key, each with its full distribution.
 *
 * When the labels do not dominate the distribution, the model did not answer
 * the question, and the contract is "throw rather than guess".
 */

import {
  canonicalJson,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionText,
} from "@omnesis/core";

/**
 * The labels must hold at least this share of the next-token probability.
 * Below it the model is about to write something other than a label (a
 * preamble, a refusal, a thinking tag), and its relative preference among the
 * labels is not an answer.
 */
export const MIN_LABEL_MASS = 0.5;

const CHOICE_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_SCORE_LEVELS = 10;

/** One answer option: the label the model writes and the key it stands for. */
export interface DecisionOption {
  readonly label: string;
  readonly key: string;
  readonly description: DecisionText | null;
}

/** The options of a question, in the order they are shown to the model. */
export function decisionOptions(question: DecisionQuestion): DecisionOption[] {
  switch (question.type) {
    case "noul":
      return [
        { label: "yes", key: "true", description: question.criteria?.true ?? null },
        { label: "no", key: "false", description: question.criteria?.false ?? null },
      ];
    case "score": {
      const levels = question.criteria.length;
      if (levels < 2 || levels > MAX_SCORE_LEVELS) {
        throw new Error(`A score question needs 2–${MAX_SCORE_LEVELS} levels, got ${levels}`);
      }
      return question.criteria.map((description, level) => ({
        label: String(level),
        key: String(level),
        description,
      }));
    }
    case "choice": {
      const entries = Object.entries(question.criteria);
      if (entries.length < 2 || entries.length > CHOICE_LABELS.length) {
        throw new Error(
          `A choice question needs 2–${CHOICE_LABELS.length} options, got ${entries.length}`,
        );
      }
      return entries.map(([key, description], i) => ({
        label: CHOICE_LABELS[i]!,
        key,
        description,
      }));
    }
  }
}

export interface DecisionPrompt {
  readonly system: string;
  readonly user: string;
}

const SYSTEM_PROMPT =
  "You are a careful classifier. Read the content, then answer the question " +
  "about it with exactly one of the listed labels and nothing else.";

/**
 * Render one question as a chat prompt. The content comes first and is
 * rendered identically for every question of a request, so a backend that
 * caches prompt prefixes reuses it across them.
 */
export function renderDecisionPrompt(
  state: unknown,
  question: DecisionQuestion,
  options: readonly DecisionOption[],
): DecisionPrompt {
  const lines = options.map((o) =>
    o.description === null ? o.label : `${o.label}: ${renderText(o.description)}`,
  );
  const user = [
    "Content:",
    renderText(state as DecisionText),
    "",
    "Question:",
    renderText(question.instructions),
    "",
    "Labels:",
    ...lines,
    "",
    `Answer with exactly one label (${options.map((o) => o.label).join(", ")}).`,
  ].join("\n");
  return { system: SYSTEM_PROMPT, user };
}

function renderText(text: DecisionText | null | undefined): string {
  if (typeof text === "string") return text;
  if (text === null || text === undefined) return "";
  return canonicalJson(text);
}

/** A candidate next token and its probability (not log-probability). */
export interface TokenProbability {
  readonly token: string;
  readonly probability: number;
}

/**
 * Turn the model's next-token distribution into a typed answer. Tokens are
 * matched to labels ignoring surrounding whitespace and case, and variants of
 * one label (`yes`, ` Yes`) add up. Throws when no label appears or the labels
 * hold less than {@link MIN_LABEL_MASS}.
 */
export function answerFromTokenProbabilities(
  question: DecisionQuestion,
  options: readonly DecisionOption[],
  tokens: readonly TokenProbability[],
): DecisionAnswer {
  const byLabel = new Map(options.map((o) => [o.label.toLowerCase(), o]));
  const mass = new Map<DecisionOption, number>();
  for (const { token, probability } of tokens) {
    if (!Number.isFinite(probability) || probability <= 0) continue;
    const option = byLabel.get(token.trim().toLowerCase());
    if (option) mass.set(option, (mass.get(option) ?? 0) + probability);
  }
  const total = [...mass.values()].reduce((a, b) => a + b, 0);
  if (total === 0) throw new Error("The model's next token is none of the answer labels");
  if (total < MIN_LABEL_MASS) {
    throw new Error(
      `The answer labels hold only ${(total * 100).toFixed(0)}% of the model's next token`,
    );
  }
  const p = (o: DecisionOption) => (mass.get(o) ?? 0) / total;

  switch (question.type) {
    case "noul":
      return { type: "noul", noul: p(options[0]!) };
    case "score": {
      const probabilities: Record<string, number> = {};
      let score = 0;
      for (const [level, o] of options.entries()) {
        probabilities[o.key] = p(o);
        score += level * p(o);
      }
      return {
        type: "score",
        score,
        confidence: Math.max(...Object.values(probabilities)),
        probabilities,
      };
    }
    case "choice": {
      const probabilities: Record<string, number> = {};
      let best = options[0]!;
      for (const o of options) {
        probabilities[o.key] = p(o);
        if (p(o) > p(best)) best = o;
      }
      return { type: "choice", choice: best.key, confidence: p(best), probabilities };
    }
  }
}
