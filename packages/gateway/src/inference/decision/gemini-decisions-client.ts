// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Gemini Decisions client — Google's `POST /v1beta/decisions`
 * (`gemini-decision-1`), which asks the same three kinds of question as
 * System One, keyed the same way, and answers in the same shape. The request
 * differs in a few fields:
 *
 * | System One                         | Gemini Decisions                                   |
 * | ---------------------------------- | -------------------------------------------------- |
 * | `state` (text or JSON)             | `input`: text (JSON is sent as its text)           |
 * | `noul` `criteria: {true, false}`   | `criteria: {true_description, false_description}`  |
 * | `choice` `criteria: {key: null}`   | `criteria: {key: ""}`                              |
 * | `usage.input_tokens`               | `usage.total_input_tokens`                         |
 *
 * The key goes in `x-goog-api-key`. A safety block is an HTTP 400 with no
 * answers, so it fails the decision like any other refused request.
 */

import { DecisionTransport, type DecisionTransportOptions } from "./transport.js";
import { parseSystemOneResponse } from "./system-one-client.js";
import type {
  DecisionCapability,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionText,
} from "@omnesis/core";

export interface GeminiDecisionsOptions extends DecisionTransportOptions {
  model: string;
}

/** Question keys Gemini accepts. */
const QUESTION_KEY = /^[A-Za-z0-9_-]{1,64}$/;

export class GeminiDecisionsDecision implements DecisionCapability {
  readonly modelId: string;
  private readonly transport: DecisionTransport;

  constructor(private readonly opts: GeminiDecisionsOptions) {
    this.modelId = opts.model;
    this.transport = new DecisionTransport({ label: "Google", ...opts });
  }

  async decide(
    request: DecisionRequest,
    callOpts?: { signal?: AbortSignal },
  ): Promise<DecisionResult> {
    const body = toGeminiDecisionsRequest(this.opts.model, request);
    const reply = await this.transport.post(this.opts.url, body, callOpts?.signal);
    return fromGeminiDecisionsResponse(reply, request, this.transport.label, this.opts.model);
  }

  dispose(): void {}
}

function text(value: DecisionText | null | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function toQuestion(id: string, q: DecisionQuestion): Record<string, unknown> {
  switch (q.type) {
    case "noul": {
      const yes = text(q.criteria?.true);
      const no = text(q.criteria?.false);
      // Gemini takes both descriptions or neither; a lone one joins the instructions.
      if (yes && no) {
        return {
          type: "noul",
          instructions: text(q.instructions),
          criteria: { true_description: yes, false_description: no },
        };
      }
      const instructions = [
        text(q.instructions),
        yes ? `Yes means: ${yes}` : "",
        no ? `No means: ${no}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { type: "noul", instructions };
    }
    case "choice": {
      const criteria = Object.fromEntries(
        Object.entries(q.criteria).map(([key, description]) => [key, text(description)]),
      );
      if (Object.keys(criteria).length < 2) {
        throw new Error(`Google needs at least two options for "${id}"`);
      }
      return { type: "choice", instructions: text(q.instructions), criteria };
    }
    case "score": {
      if (q.criteria.length < 2) throw new Error(`Google needs at least two levels for "${id}"`);
      return { type: "score", instructions: text(q.instructions), criteria: q.criteria.map(text) };
    }
  }
}

/** Exported for tests. */
export function toGeminiDecisionsRequest(
  model: string,
  request: DecisionRequest,
): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    if (!QUESTION_KEY.test(id)) throw new Error(`Google cannot take the question key "${id}"`);
    questions[id] = toQuestion(id, q);
  }
  const input = typeof request.state === "string" ? request.state : JSON.stringify(request.state);
  return { model, input, questions };
}

/** Exported for tests. */
export function fromGeminiDecisionsResponse(
  raw: unknown,
  request: DecisionRequest,
  label: string,
  model: string,
): DecisionResult {
  const { inputTokens: _systemOneTokens, ...result } = parseSystemOneResponse(raw, request, {
    label,
    model,
    scoreField: "score",
  });
  const usage = (raw as { usage?: { total_input_tokens?: unknown } }).usage;
  const inputTokens = usage?.total_input_tokens;
  return { ...result, ...(typeof inputTokens === "number" ? { inputTokens } : {}) };
}
