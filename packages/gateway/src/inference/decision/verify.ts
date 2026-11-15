// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Verifying a decision model: one small invented decision, and a failure
 * turned into what the operator should change — a refused key, a model the
 * server does not have, a server that is not running.
 */

import { DecisionHttpError } from "./transport.js";
import type { DecisionCapability, DecisionRequest } from "@omnesis/core";

/**
 * Why a verify failed:
 * - `refused`: the server answered that it cannot serve this request (a
 *   refused key, an unknown model, a malformed request);
 * - `answer`: the model answered, but outside the questions' scales;
 * - `unavailable`: no definite answer (down, timed out, rate limited,
 *   overloaded, warming up) — it may well work in a moment.
 */
export type DecisionVerifyFailure = "refused" | "answer" | "unavailable";

export interface DecisionVerifyResult {
  ok: boolean;
  /** The model id the server answered with, which may resolve an alias. */
  answeredBy?: string;
  latencyMs?: number;
  failure?: DecisionVerifyFailure;
  /** HTTP status of a refused request. */
  status?: number;
  reason?: string;
}

/** An invented message and two questions every decision model can answer. */
export const VERIFY_REQUEST: DecisionRequest = {
  state: {
    subject: "Appointment moved to Thursday",
    from: "Studio Northstar <frontdesk@example.com>",
    body: "Your appointment has moved to Thursday at 3pm. Reply if that time does not work.",
  },
  questions: {
    verify_noul: { type: "noul", instructions: "Is this message about an appointment?" },
    verify_score: {
      type: "score",
      instructions: "How soon does the recipient need to act on this message?",
      criteria: ["No action needed", "This week", "Today"],
    },
  },
};

/** Statuses that say the request itself cannot succeed; anything else may on a retry. */
const DEFINITE_REFUSALS = new Set([400, 401, 402, 403, 404, 422]);

/** Turn a failed decision into what the operator should change. */
export function describeDecisionFailure(
  err: unknown,
  ctx: { url: string; model: string },
): { reason: string; failure: DecisionVerifyFailure; status?: number } {
  if (err instanceof DecisionHttpError) {
    const status = err.status;
    const failure = DEFINITE_REFUSALS.has(status) ? "refused" : "unavailable";
    if (status === 401 || status === 403) {
      return {
        failure,
        status,
        reason: `The API key was refused (HTTP ${status}). ${err.message}`,
      };
    }
    if (status === 404) {
      return {
        failure,
        status,
        reason: `The server has no model "${ctx.model}", or the URL is not its decision endpoint (HTTP 404). ${err.message}`,
      };
    }
    if (status === 402) {
      return {
        failure,
        status,
        reason: `The account cannot pay for this request (HTTP 402). ${err.message}`,
      };
    }
    return { failure, status, reason: err.message };
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return { failure: "unavailable", reason: `${ctx.url} did not answer in time.` };
  }
  if (err instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(err.message)) {
    return {
      failure: "unavailable",
      reason: `Nothing answered at ${ctx.url}. Is the server running? (${err.message})`,
    };
  }
  // Anything else is the reply failing validation, or a policy refusal before
  // sending: both definite.
  return { failure: "refused", reason: err instanceof Error ? err.message : String(err) };
}

/** Ask the verify questions; disposes the client. */
export async function verifyDecisionModel(
  client: DecisionCapability,
  ctx: { url: string; model: string },
): Promise<DecisionVerifyResult> {
  const started = Date.now();
  try {
    const result = await client.decide(VERIFY_REQUEST);
    const noul = result.answers.verify_noul;
    const score = result.answers.verify_score;
    if (noul?.type !== "noul" || noul.noul < 0 || noul.noul > 1) {
      return {
        ok: false,
        failure: "answer",
        reason: "The model answered a yes/no question with something other than a probability.",
      };
    }
    if (score?.type !== "score" || score.score < 0 || score.score > 2) {
      return {
        ok: false,
        failure: "answer",
        reason: "The model answered a three-level question outside 0–2.",
      };
    }
    return { ok: true, answeredBy: result.model, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, ...describeDecisionFailure(err, ctx) };
  } finally {
    await Promise.resolve(client.dispose()).catch(() => {});
  }
}

/**
 * Whether a decision assignment may be written: refused only when the model
 * definitely cannot serve it — an unknown model, a refused key or request, or
 * answers off the questions' scales. A server that gives no definite answer
 * is let through: it may serve the model once it is up, and health reports it
 * meanwhile.
 */
export async function vetDecisionModel(
  client: DecisionCapability,
  ctx: { url: string; model: string },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await verifyDecisionModel(client, ctx);
  if (result.ok || result.failure === "unavailable") return { ok: true };
  return { ok: false, reason: `${ctx.model} cannot serve the Decision model: ${result.reason}` };
}
