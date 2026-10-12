// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * A scripted decision policy for observation salience — the decision model
 * as the morning brief's editor.
 *
 * The salience request asks three score questions in one call
 * (`consequence` 0–4, `timing` 0–3, `already_known` 0–1) about the
 * observation summary carried in `state.observation`. A bench names the
 * scores per observation by a marker in its summary; the gateway's own
 * deterministic policy then decides ship / hold / already-known from them.
 *
 * Every other decision the bench's gateway asks (the worth gate, the record
 * and outcome checks) is answered at the top level of each score question,
 * so those gates pass and stay out of a salience scenario's way.
 */

import type { DecisionAnswer } from "@omnesis/core";
import type { DecisionPolicy, DecisionServerRequest } from "./decision-server.js";

/** The scores one observation receives, or a provider error for its call. */
export type SalienceScript =
  | { consequence: number; timing: number; alreadyKnown: number }
  | { httpError: number };

/** True when the request is an observation-salience judgement. */
export function isSalienceRequest(request: Pick<DecisionServerRequest, "questions">): boolean {
  const q = request.questions as Record<string, unknown>;
  return "consequence" in q && "timing" in q && "already_known" in q;
}

/** The observation summary a salience request judges. */
export function salienceSubject(request: Pick<DecisionServerRequest, "state">): string | null {
  const state = request.state as { observation?: unknown } | null;
  return state && typeof state.observation === "string" ? state.observation : null;
}

function topAnswers(request: DecisionServerRequest): Record<string, DecisionAnswer> {
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "score")
      answers[id] = { type: "score", score: question.criteria.length - 1 };
    else if (question.type === "noul") answers[id] = { type: "noul", noul: 1 };
    else answers[id] = { type: "choice", choice: Object.keys(question.criteria)[0]! };
  }
  return answers;
}

/**
 * Build the policy. `scripts` is consulted in order: the first marker found
 * in the observation summary decides its scores. An unmatched salience
 * request uses `fallback`.
 */
export function salienceDecisionPolicy(
  scripts: ReadonlyArray<readonly [marker: string, script: SalienceScript]>,
  fallback: SalienceScript = { consequence: 2, timing: 1, alreadyKnown: 0 },
): DecisionPolicy {
  return (request) => {
    if (!isSalienceRequest(request)) return topAnswers(request);
    const subject = salienceSubject(request) ?? "";
    const script = scripts.find(([marker]) => subject.includes(marker))?.[1] ?? fallback;
    if ("httpError" in script) return { httpError: script.httpError };
    return {
      consequence: { type: "score", score: script.consequence },
      timing: { type: "score", score: script.timing },
      already_known: { type: "score", score: script.alreadyKnown },
    };
  };
}
