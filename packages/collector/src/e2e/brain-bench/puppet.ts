// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The puppet steward — an OpenAI-compatible server assigned to the
 * `background-agent` role, standing in for the model in a cognition run.
 *
 * It emits real `tool_calls`, so the gateway's run driver executes the REAL
 * tool layer: authority filtering, argument validation, the entailment and
 * judge gates, the write gate and every cascade behind it. A puppet-driven
 * run leaves genuine rows behind; only the reasoning that chose them is
 * scripted.
 *
 * Stateless per request — the whole conversation arrives with each call,
 * and `decideNextTurn` (pure, in `puppet-plan.ts`) derives the next turn
 * from it. That makes a bench run reproducible regardless of retries,
 * concurrency, or which worker claims which run.
 */

import { startOpenAiServer, userPromptOf, type OpenAiServerHandle } from "./openai-server.js";
import {
  decideNextTurn,
  readRunContext,
  type NextTurn,
  type PuppetBehaviors,
} from "./puppet-plan.js";

const PUPPET_MODEL_ID = "brain-bench-puppet-v1";

/** One completion the puppet served, for transcript assertions. */
export interface PuppetCall {
  at: number;
  runId: string | null;
  kind: string | null;
  flavour: string | null;
  subject: string | null;
  prompt: string;
  emitted: NextTurn;
}

export interface PuppetModelServer extends OpenAiServerHandle {
  /** Every completion request served, in order. */
  calls: PuppetCall[];
  /** Calls belonging to runs of one kind. */
  callsOfKind(kind: string): PuppetCall[];
  /** Every tool call the puppet emitted, in order. */
  emittedTools(): Array<{ name: string; args: Record<string, unknown> }>;
  /**
   * Open or close a provider outage.
   *
   * While a status is set every completion is refused with it, before the
   * behavior table is consulted — so an outage looks the way a real one does:
   * indiscriminate, and unrelated to what was being asked. Pass null to
   * restore service, which is what a test does to assert the brain recovers.
   */
  refuseWith(status: number | null, message?: string): void;
}

/**
 * Thrown from a behavior plan to refuse that one call with a chosen HTTP
 * status, the way a real backend refuses.
 *
 * Scoped where a plain throw is scoped — to the runs whose flavour and subject
 * match that behavior — which is what separates it from
 * `PuppetModelServer.refuseWith`, an outage across every call. A test that
 * needs one run to be rejected while the rest of a shared bench keeps working
 * needs this one; a test simulating a dead account needs the other.
 *
 * The status matters because it is what decides whether the brain reads the
 * failure as the payload's fault or the environment's, and the two settle
 * differently: 400 retires the run, 503 waits for the backend to come back.
 */
export class PuppetHttpRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PuppetHttpRefusal";
  }
}

export async function startPuppetModelServer(opts: {
  behaviors: PuppetBehaviors;
  modelId?: string;
}): Promise<PuppetModelServer> {
  const calls: PuppetCall[] = [];
  let refusal: { status: number; message: string } | null = null;
  const handle = await startOpenAiServer({
    modelId: opts.modelId ?? PUPPET_MODEL_ID,
    respond: (messages) => {
      // Before the behavior table: a refusing backend never reaches the point
      // of deciding what the answer would have been.
      if (refusal) return { kind: "httpError", ...refusal };
      let turn: NextTurn;
      try {
        turn = decideNextTurn(messages, opts.behaviors);
      } catch (err) {
        // A refusal is the backend's answer, not the puppet's — it never
        // reaches the point of deciding a turn, so there is no call to record.
        if (err instanceof PuppetHttpRefusal) {
          return { kind: "httpError", status: err.status, message: err.message };
        }
        throw err;
      }
      const prompt = userPromptOf(messages);
      const ctx = readRunContext(prompt);
      calls.push({
        at: Date.now(),
        runId: ctx?.runId ?? null,
        kind: ctx?.kind ?? null,
        flavour: ctx?.flavour ?? null,
        subject: ctx?.subject ?? null,
        prompt,
        emitted: turn,
      });
      return turn.kind === "tool"
        ? { kind: "tool", name: turn.name, args: turn.args }
        : { kind: "text", text: turn.text };
    },
  });

  return {
    ...handle,
    calls,
    refuseWith: (status, message) => {
      refusal = status === null ? null : { status, message: message ?? `HTTP ${status}` };
    },
    callsOfKind: (kind) => calls.filter((c) => c.kind === kind),
    emittedTools: () =>
      calls
        .filter((c) => c.emitted.kind === "tool")
        .map((c) => {
          const e = c.emitted as { kind: "tool"; name: string; args: Record<string, unknown> };
          return { name: e.name, args: e.args };
        }),
  };
}

export type { PuppetBehaviors };
