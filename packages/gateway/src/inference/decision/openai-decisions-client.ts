// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * OpenAI Decisions client — `POST /v1/decisions` (gpt-6-luna), which answers
 * the same three kinds of question as System One with its own schema:
 *
 * | System One                     | OpenAI Decisions                                   |
 * | ------------------------------ | -------------------------------------------------- |
 * | `state`                        | `input`: a string, or a user message with `input_json` |
 * | `questions: {id: q}`           | `questions: [{name: id, …}]`, in order              |
 * | `noul` (+ `criteria.true/false`) | `predicate` (criteria folded into the instructions) |
 * | `choice` `criteria: {key: d}`  | `choice` `choices: [{value: key, description: d}]`  |
 * | `score` `criteria: [d, …]`     | `score` `levels: [{label: d}, …]`                   |
 * | `answers: {id: a}`             | `answers: [a]`, each echoing its `name`             |
 * | `noul`                         | `probability`                                       |
 * | `probabilities: {key: p}`      | `probabilities: [{value, probability}]`             |
 *
 * A `refusal` answer has no System One counterpart and fails the decision, as
 * any unanswerable request does.
 */

import { DecisionTransport, type DecisionTransportOptions } from "./transport.js";
import type {
  DecisionAnswer,
  DecisionCapability,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionText,
} from "@omnesis/core";

export interface OpenAIDecisionsOptions extends DecisionTransportOptions {
  model: string;
}

export class OpenAIDecisionsDecision implements DecisionCapability {
  readonly modelId: string;
  private readonly transport: DecisionTransport;

  constructor(private readonly opts: OpenAIDecisionsOptions) {
    this.modelId = opts.model;
    this.transport = new DecisionTransport({ label: "OpenAI", ...opts });
  }

  async decide(
    request: DecisionRequest,
    callOpts?: { signal?: AbortSignal },
  ): Promise<DecisionResult> {
    const body = toOpenAIDecisionsRequest(this.opts.model, request);
    const reply = await this.transport.post(this.opts.url, body, callOpts?.signal);
    return fromOpenAIDecisionsResponse(reply, request, this.transport.label, this.opts.model);
  }

  dispose(): void {}
}

function text(value: DecisionText | null | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function stateAsInput(state: unknown): unknown {
  if (typeof state === "string") return state;
  const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  if (isObject(state) || (Array.isArray(state) && state.every(isObject))) {
    return [{ role: "user", content: [{ type: "input_json", data: state }] }];
  }
  return JSON.stringify(state);
}

function toQuestion(name: string, q: DecisionQuestion): Record<string, unknown> {
  switch (q.type) {
    case "noul": {
      const yes = text(q.criteria?.true);
      const no = text(q.criteria?.false);
      const instructions = [
        text(q.instructions),
        yes ? `Yes means: ${yes}` : "",
        no ? `No means: ${no}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return { type: "predicate", name, instructions };
    }
    case "choice": {
      const choices = Object.entries(q.criteria).map(([value, description]) => ({
        value,
        ...(description === null ? {} : { description: text(description) }),
      }));
      if (choices.length < 2) throw new Error(`OpenAI needs at least two options for "${name}"`);
      return { type: "choice", name, instructions: text(q.instructions), choices };
    }
    case "score": {
      if (q.criteria.length < 2) throw new Error(`OpenAI needs at least two levels for "${name}"`);
      return {
        type: "score",
        name,
        instructions: text(q.instructions),
        levels: q.criteria.map((c) => ({ label: text(c) })),
      };
    }
  }
}

/** Exported for tests. */
export function toOpenAIDecisionsRequest(
  model: string,
  request: DecisionRequest,
): Record<string, unknown> {
  return {
    model,
    input: stateAsInput(request.state),
    questions: Object.entries(request.questions).map(([id, q]) => toQuestion(id, q)),
  };
}

type Answer = Record<string, unknown>;

function probabilityMap(value: unknown): Record<string, number> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const entry of value as Answer[]) {
    if (entry && typeof entry.probability === "number") {
      out[String(entry.value)] = entry.probability;
    }
  }
  return out;
}

/** Exported for tests. */
export function fromOpenAIDecisionsResponse(
  raw: unknown,
  request: DecisionRequest,
  label: string,
  model: string,
): DecisionResult {
  const body = raw as { model?: unknown; answers?: unknown; usage?: Answer } | null;
  if (!body || !Array.isArray(body.answers)) throw new Error(`${label} reply has no answers`);
  const replies = body.answers as Answer[];
  // Answers are matched by their echoed name; by position only when the
  // reply names none, so a missing answer is never filled by another's.
  const named = replies.some((a) => typeof a?.name === "string" && a.name);
  const ids = Object.keys(request.questions);
  const answers: Record<string, DecisionAnswer> = {};
  ids.forEach((id, index) => {
    const question = request.questions[id]!;
    const reply = named ? replies.find((a) => a?.name === id) : replies[index];
    if (!reply) throw new Error(`${label} reply lacks an answer for "${id}"`);
    if (reply.type === "refusal") throw new Error(`${label} refused to answer "${id}"`);
    const confidence = typeof reply.confidence === "number" ? reply.confidence : undefined;
    const probabilities = probabilityMap(reply.probabilities);
    const rest = {
      ...(confidence === undefined ? {} : { confidence }),
      ...(probabilities ? { probabilities } : {}),
    };
    if (question.type === "noul" && reply.type === "predicate") {
      if (typeof reply.probability !== "number") throw new Error(`${label} "${id}" has no value`);
      answers[id] = { type: "noul", noul: reply.probability };
    } else if (question.type === "choice" && reply.type === "choice") {
      if (typeof reply.choice !== "string" && typeof reply.choice !== "boolean") {
        throw new Error(`${label} choice "${id}" has no value`);
      }
      answers[id] = { type: "choice", choice: String(reply.choice), ...rest };
    } else if (question.type === "score" && reply.type === "score") {
      if (typeof reply.score !== "number") throw new Error(`${label} score "${id}" has no value`);
      answers[id] = { type: "score", score: reply.score, ...rest };
    } else {
      throw new Error(`${label} reply lacks a ${question.type} answer for "${id}"`);
    }
  });
  const inputTokens = body.usage?.input_tokens;
  return {
    model: typeof body.model === "string" && body.model ? body.model : model,
    answers,
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
  };
}
