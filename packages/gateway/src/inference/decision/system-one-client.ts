// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * System One client — the decision backends that speak TypeSafe's System One
 * format: TypeSafe itself, local servers (Ollaya, Ollama) and the hosted APIs
 * that copied it.
 *
 * One request per decision: `POST <url>` with `{model, state, questions}`;
 * the reply carries one typed answer per question and the billed input
 * tokens. Providers differ in small ways this client absorbs:
 *
 * - the auth header (`Authorization: Bearer`, Foundry's `api-key`, Fastino's
 *   `X-API-Key`), and no header at all for a keyless local server;
 * - which field holds a score's weighted level (`scoreField`);
 * - Cloudflare Workers AI (`workers-ai`) names the model twice — its full id
 *   (`@cf/cloudflare/clef`) in the URL and the short name (`clef`) in the body —
 *   and wraps its reply in `{result}`;
 * - extra reply fields (OpenRouter's `provider`, Perplexity's search results),
 *   which are ignored, and a reply without a model id, which is the model asked.
 *
 * Rate limiting (429) and overload (529, 5xx) are retried with backoff,
 * honouring `retry-after`; every other failure — a rejected key, an unknown
 * model, a malformed reply — throws, because the capability contract is
 * "throw rather than guess" and callers fail open.
 */

import {
  isWorkersAiModelId,
  type DecisionAnswer,
  type DecisionCapability,
  type DecisionRequest,
  type DecisionResult,
  type DecisionScoreField,
} from "@omnesis/core";
import { DecisionTransport, type DecisionTransportOptions } from "./transport.js";

export interface SystemOneDecisionOptions extends DecisionTransportOptions {
  model: string;
  /** `systemone` posts to the URL as given; `workers-ai` appends the model id to it. */
  protocol?: "systemone" | "workers-ai";
  scoreField?: DecisionScoreField;
}

export class SystemOneDecision implements DecisionCapability {
  readonly modelId: string;
  private readonly endpoint: string;
  private readonly bodyModel: string;
  private readonly transport: DecisionTransport;

  constructor(private readonly opts: SystemOneDecisionOptions) {
    this.modelId = opts.model;
    const workersAi = opts.protocol === "workers-ai";
    this.endpoint = workersAi
      ? `${opts.url.replace(/\/+$/, "")}/${workersAiModelPath(opts.model)}`
      : opts.url;
    this.bodyModel = workersAi ? opts.model.split("/").pop()! : opts.model;
    this.transport = new DecisionTransport(opts);
  }

  async decide(
    request: DecisionRequest,
    callOpts?: { signal?: AbortSignal },
  ): Promise<DecisionResult> {
    const reply = await this.transport.post(
      this.endpoint,
      { model: this.bodyModel, state: request.state, questions: request.questions },
      callOpts?.signal,
    );
    return parseSystemOneResponse(reply, request, {
      label: this.transport.label,
      model: this.opts.model,
      scoreField: this.opts.scoreField ?? "score",
    });
  }

  dispose(): void {}
}

/** The model id as a URL path, refused unless it is a Workers AI model id. */
export function workersAiModelPath(model: string): string {
  if (!isWorkersAiModelId(model)) throw new Error(`"${model}" is not a Workers AI model id`);
  return model;
}

interface ParseContext {
  label: string;
  /** The model asked for: what a reply without a model id is reported as. */
  model: string;
  scoreField: DecisionScoreField;
}

/**
 * Validate a System One reply against the questions asked. A reply missing an
 * answer, or carrying an answer of the wrong type, is a malformed reply —
 * never papered over with a default. A reply wrapped in `{result}` (Workers
 * AI's envelope) is unwrapped first.
 */
export function parseSystemOneResponse(
  raw: unknown,
  request: DecisionRequest,
  ctx: ParseContext,
): DecisionResult {
  let body = raw as Record<string, unknown> | null;
  if (body && typeof body === "object" && !("answers" in body) && isRecord(body.result)) {
    body = body.result;
  }
  if (!body || typeof body !== "object") throw new Error(`${ctx.label} reply is not an object`);
  if (!isRecord(body.answers)) throw new Error(`${ctx.label} reply has no answers`);
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = body.answers[id];
    if (!isRecord(answer) || answer.type !== question.type) {
      throw new Error(`${ctx.label} reply lacks a ${question.type} answer for "${id}"`);
    }
    answers[id] = validateAnswer(id, answer, ctx);
  }
  const usage = isRecord(body.usage) ? body.usage : undefined;
  const inputTokens = usage?.input_tokens;
  return {
    model: typeof body.model === "string" && body.model ? body.model : ctx.model,
    answers,
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
  };
}

function validateAnswer(
  id: string,
  answer: Record<string, unknown>,
  ctx: ParseContext,
): DecisionAnswer {
  const probabilities = numberRecord(answer.probabilities);
  const confidence = typeof answer.confidence === "number" ? answer.confidence : undefined;
  switch (answer.type) {
    case "noul":
      if (typeof answer.noul !== "number")
        throw new Error(`${ctx.label} noul "${id}" has no value`);
      return { type: "noul", noul: answer.noul };
    case "score": {
      const value = answer[ctx.scoreField];
      if (typeof value !== "number") {
        throw new Error(`${ctx.label} score "${id}" has no ${ctx.scoreField}`);
      }
      return {
        type: "score",
        score: value,
        ...(confidence === undefined ? {} : { confidence }),
        ...(probabilities ? { probabilities } : {}),
      };
    }
    case "choice":
      if (typeof answer.choice !== "string") {
        throw new Error(`${ctx.label} choice "${id}" has no value`);
      }
      return {
        type: "choice",
        choice: answer.choice,
        ...(confidence === undefined ? {} : { confidence }),
        ...(probabilities ? { probabilities } : {}),
      };
    default:
      throw new Error(`${ctx.label} answer "${id}" has unknown type`);
  }
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "number") out[k] = v;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
