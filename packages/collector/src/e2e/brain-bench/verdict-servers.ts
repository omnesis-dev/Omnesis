// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Scripted stand-ins for the two gate roles that sit between the steward's
 * decision and the write landing.
 *
 * Durable-memory entailment writes fail open in production, while user-facing
 * Brief writes fail closed when a configured verifier or judge is unavailable.
 * That distinction is also a testing hazard: with the roles unassigned
 * (as every pre-existing suite leaves them), the gates are permanently in
 * their pass arm and their reject arm is unreachable end-to-end. These
 * servers make the reject arm drivable, so a bench can assert BOTH that a
 * refused claim never persists and that an absent verifier still lets the
 * write through.
 *
 * `entailment-verifier` is a completion role: it is handed the claim and
 * the evidence quote and answers with one of the three NLI labels.
 * `brief-judge` is a chat role: it is handed the candidate brief and
 * answers `VERDICT: SHIP` or `VERDICT: HOLD`.
 */

import {
  promptTextOf,
  startOpenAiServer,
  type OpenAiServerHandle,
  type WireMessage,
} from "./openai-server.js";

/** What the verifier said about one claim. */
export type EntailmentLabel = "entailment" | "neutral" | "contradiction";

/**
 * How the verifier answers. A function receives the claim and the evidence
 * quote parsed out of the judge prompt, so a bench can accept most claims
 * and reject one named claim.
 */
export type EntailmentPolicy =
  | "accept-all"
  | "reject-all"
  | "contradict-all"
  | ((input: { claim: string; evidence: string; prompt: string }) => EntailmentLabel);

/** How the judge answers; `hold-all` empties the feed, `ship-all` never blocks. */
export type JudgePolicy =
  | "ship-all"
  | "hold-all"
  | ((input: { prompt: string }) => "ship" | "hold");

/** One verdict served, for assertions about what the gate was asked. */
export interface VerdictCall {
  at: number;
  prompt: string;
  answer: string;
  /** Parsed subject, when the prompt carried one. */
  claim?: string;
  evidence?: string;
}

export interface VerdictServer extends OpenAiServerHandle {
  calls: VerdictCall[];
  /** Toggle an HTTP provider outage without rebuilding the gateway assignment. */
  refuseWith(status: number | null, message?: string): void;
}

/**
 * Pull the claim and its evidence out of the judge prompt.
 *
 * The evidence runs to the `Claim:` line rather than to the end of its own
 * line: a multi-atom grounding is presented as `[1] …\n[2] …`, and a
 * line-anchored capture would silently hand a policy only the first atom —
 * making a test that rejects on the SECOND quote look like it never fired.
 */
function parseEntailmentSubject(prompt: string): { claim: string; evidence: string } {
  const claim = /^Claim: (.*)$/m.exec(prompt)?.[1] ?? "";
  const evidence =
    /^Evidence quote: ([\s\S]*?)(?=\nClaim: |$)/m.exec(prompt)?.[1]?.trim() ??
    // MiniCheck phrasing: `Document: …\nClaim: …`
    /^Document: ([\s\S]*?)(?=\nClaim: |$)/m.exec(prompt)?.[1]?.trim() ??
    "";
  return { claim, evidence };
}

/**
 * Which gate to stand in for, and how it should answer.
 *
 * A discriminated union rather than two loose fields: pairing a role with the
 * other role's policy would type-check, then throw inside the request handler
 * — and a throwing verdict server answers 500, which BOTH gates treat as
 * unavailability and fail open. The bench would then pass while asserting the
 * pass arm of a gate it believed it had driven into reject.
 */
export type VerdictServerOptions =
  | { role: "entailment"; policy: EntailmentPolicy; modelId?: string }
  | { role: "judge"; policy: JudgePolicy; modelId?: string };

export async function startVerdictServer(opts: VerdictServerOptions): Promise<VerdictServer> {
  const calls: VerdictCall[] = [];
  const modelId = opts.modelId ?? `brain-bench-${opts.role}-v1`;
  let refusal: { status: number; message: string } | null = null;

  const respond = (messages: readonly WireMessage[]) => {
    const prompt = promptTextOf(messages);
    if (refusal !== null) {
      calls.push({ at: Date.now(), prompt, answer: `HTTP ${refusal.status}` });
      return { kind: "httpError" as const, ...refusal };
    }
    if (opts.role === "entailment") {
      const subject = parseEntailmentSubject(prompt);
      const { policy } = opts;
      const label: EntailmentLabel =
        policy === "accept-all"
          ? "entailment"
          : policy === "reject-all"
            ? "neutral"
            : policy === "contradict-all"
              ? "contradiction"
              : policy({ ...subject, prompt });
      const answer = label.toUpperCase();
      calls.push({ at: Date.now(), prompt, answer, ...subject });
      return { kind: "text" as const, text: answer };
    }
    const { policy } = opts;
    const decision =
      policy === "ship-all" ? "ship" : policy === "hold-all" ? "hold" : policy({ prompt });
    const answer = `Reason: scripted bench verdict.\nVERDICT: ${decision.toUpperCase()}`;
    calls.push({ at: Date.now(), prompt, answer });
    return { kind: "text" as const, text: answer };
  };

  const handle = await startOpenAiServer({ modelId, respond });
  return {
    ...handle,
    calls,
    refuseWith(status, message = "scripted gate outage") {
      refusal = status === null ? null : { status, message };
    },
  };
}
