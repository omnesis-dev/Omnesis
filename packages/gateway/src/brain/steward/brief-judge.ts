// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The brief judge — the push bar as a separate model pass.
 *
 * A brief is a push notification into someone's life, so the generator that
 * DRAFTS one is the wrong place to decide whether it earns the interrupt: a
 * model asked to gate its own output rationalises the thing it just chose to
 * write. The judge is an independent second pass — its own prompt, its own
 * completion — whose only job is to say SHIP or HOLD against four gates, and
 * whose bias is HOLD. It runs at the single write choke point (`brief_create`)
 * so every candidate faces the bar before it is persisted.
 *
 * The bar is calibrated to the drafting lane ({@link CognitionBriefLane}),
 * because the four gates are written for a REACTIVE card — one that fires
 * because a datum arrived — and three lanes are not reactive. A `lookahead` or
 * `dated_reminder` card exists precisely to resurface something the user
 * already knows AT THE MOMENT IT MATTERS, so it is judged on PREPARATION
 * instead of awareness; a `noticing` card exists to name a pattern that
 * carries no action, so it is judged on NON-OBVIOUSNESS instead of
 * consequence; and the `digest` — one scheduled card a day, the only brief
 * that pushes — does not face ship/hold at all, since it cannot spam and its
 * real question is whether the selection is right. Every other lane faces all
 * four gates: those are the reactive cards, where echoing back what the user
 * just did is the failure this bar exists to catch.
 *
 * Structurally it mirrors the entailment gate (`runEntailmentGate` in
 * tools.ts): fail OPEN — an absent, disabled, timed-out, or unparseable judge
 * never blocks a brief (the generator's own chain-of-verification discipline
 * is the belt; the judge is the suspenders), and every verdict is logged so
 * the bar can be watched and tuned live rather than in a shadow harness.
 *
 * The judge runs on its own `brief-judge` model role. Codex judge turns use
 * independent execution capacity so a background turn can wait for its judge.
 * An unassigned backend leaves the gate absent; a running judge's failure holds
 * the brief for review rather than publishing it without a verdict.
 */

import { randomUUID } from "node:crypto";
import { AgentSession, classifyAgentTurn, type ChatBackend } from "@omnesis/agent";
import type { CognitionBriefLane } from "../run-payloads.js";
import type { AgentEvent, AgentMessageEndEvent, AgentTerminalFailure, Logger } from "@omnesis/core";

/** The candidate brief the judge weighs — its user-visible content plus the timing signals it can't read off the prose. */
export interface BriefJudgeCandidate {
  /** The brief kind the lane filed it as (e.g. `info`, `action`). */
  kind: string;
  /**
   * The editorial lane that drafted it — selects which gates apply. A
   * `lookahead` or `dated_reminder` card is MEANT to restate something the
   * user already knows, at the moment it matters; a `noticing` card is MEANT
   * to carry no action. Judging those on awareness and consequence
   * respectively kills the lane's whole purpose.
   */
  lane: CognitionBriefLane;
  title: string;
  description?: string | undefined;
  body?: string | undefined;
  /** How many documents ground it — a bare, uncited assertion is weaker. */
  citationCount: number;
  /** How many tracked obligations it rolls up — 0 ⇒ a standalone observation. */
  relatedLoopCount: number;
  /**
   * The card is scheduled to surface later (a dated reminder set to appear on
   * its day), so it passes the TIMING gate by construction — judge it on the
   * other three.
   */
  scheduledForLater: boolean;
  /** It carries a concrete event/due moment — a signal it is time-bound, not a passing note. */
  hasEventAt: boolean;
}

/** SHIP (persist and surface) or HOLD (do not create), with a one-line reason for the log. */
export interface BriefJudgeVerdict {
  decision: "ship" | "hold";
  reason: string;
}

/** The judge capability. Resolved fresh per call so a live model swap takes effect on the next brief. */
export interface BriefJudge {
  judge(candidate: BriefJudgeCandidate): Promise<BriefJudgeVerdict>;
}

export type BriefJudgeGateSet = "reactive" | "preparation" | "non_obviousness";

/** Select the semantic gate set independently of its human-readable rendering. */
export function briefJudgeGateSet(lane: CognitionBriefLane): BriefJudgeGateSet {
  return lane === "lookahead" || lane === "dated_reminder"
    ? "preparation"
    : lane === "noticing"
      ? "non_obviousness"
      : "reactive";
}

/** Hard ceiling on one judge call; beyond it the gate fails open (ships). */
const BRIEF_JUDGE_TIMEOUT_MS = 45_000;

/** The gates, as prompt lines. `reactive` gets all four; a lane swaps the one that contradicts its charter. */
const GATE_AWARENESS =
  '1. AWARENESS — it tells the user something they do not already have. HOLD if it merely reflects back an action the user just took or a note they just wrote/received themselves; a bare receipt ("noted", "scheduled", "you created X") adds nothing.';
const GATE_TIMING =
  "2. TIMING — it lands before it matters. HOLD if the moment it refers to has already passed. (A card scheduled to surface later passes this gate by construction — judge it on the other three.)";
const GATE_CONSEQUENCE =
  "3. CONSEQUENCE — there is a real cost to NOT seeing it: a missed deadline, a shortfall, a broken commitment, a closing window. HOLD if nothing happens when it is ignored.";
const GATE_SYNTHESIS =
  "4. SYNTHESIS or SIGNIFICANCE — it states a conclusion the user could not read off a single document at a glance (a projection, a cross-source connection, a pattern over time), OR it is a genuinely significant standalone obligation worth resurfacing on its own. HOLD if it is a trivial restatement of one document.";

/**
 * Stands in for awareness on the two lanes whose product IS restating
 * something known at the moment it matters. Novelty is the wrong question
 * there; added preparation is the right one.
 */
const GATE_PREPARATION =
  "1. PREPARATION (this card's lane exists to resurface known things at the moment they matter, so novelty is NOT the test) — it carries something beyond the bare calendar entry or the reminder's own words: the context, the counterparty history, the logistics, the thing to bring, the conflict. HOLD only if it is the calendar line or the reminder text restated with nothing added.";

/**
 * Stands in for consequence on the awareness lane, which is chartered to
 * surface patterns carrying no action at all — a cost-of-ignoring test reads
 * those as costless by construction. Non-obviousness is the bar that fits.
 */
const GATE_NON_OBVIOUS =
  "3. NON-OBVIOUSNESS (this card's lane exists to surface patterns with no action attached, so cost-of-ignoring is NOT the test) — the observation is one the user could not have assembled themselves from what they have already seen: a trend across time, a contradiction between sources, a gap, a slow-building situation. Do NOT hold merely because the user lived through the underlying events — seeing them collected and named in one place is the value. HOLD if it is banal, forced, or something a single glance would have given them.";

/**
 * The bar, as a system prompt, calibrated to the drafting lane. The gates are
 * the product contract for what deserves a slot in someone's feed; the
 * default is HOLD.
 */
export function buildBriefJudgeSystemPrompt(lane: CognitionBriefLane): string {
  const gateSet = briefJudgeGateSet(lane);
  const gates =
    gateSet === "preparation"
      ? [GATE_PREPARATION, GATE_TIMING, GATE_CONSEQUENCE, GATE_SYNTHESIS]
      : gateSet === "non_obviousness"
        ? [GATE_AWARENESS, GATE_TIMING, GATE_NON_OBVIOUS, GATE_SYNTHESIS]
        : [GATE_AWARENESS, GATE_TIMING, GATE_CONSEQUENCE, GATE_SYNTHESIS];
  return [
    "You are the bar for Omnesis Briefs. A brief is a card pushed into someone's life — you decide whether a candidate is worth INTERRUPTING them for. Most candidates are not; your default is HOLD.",
    "",
    "SHIP only when the candidate clears ALL FOUR gates:",
    ...gates,
    "",
    "When uncertain, HOLD. An empty feed is a good outcome; a feed full of things the user already knew erodes trust far more than a missed minor card.",
    "",
    "Answer in one or two sentences naming which gate(s) decided it, then a FINAL line that is exactly one of:",
    "VERDICT: SHIP",
    "VERDICT: HOLD",
  ].join("\n");
}

/** Render the candidate for the judge. */
export function buildBriefJudgeUserPrompt(c: BriefJudgeCandidate): string {
  const lines: string[] = ["Candidate brief:", `- kind: ${c.kind}`, `- title: ${c.title}`];
  if (c.description !== undefined && c.description.trim() !== "") {
    lines.push(`- description: ${c.description}`);
  }
  if (c.body !== undefined && c.body.trim() !== "") {
    lines.push(`- body: ${c.body}`);
  }
  lines.push(
    `- grounded in ${c.citationCount} cited document(s)`,
    `- rolls up ${c.relatedLoopCount} tracked obligation(s)`,
    c.scheduledForLater
      ? "- scheduled to surface later (a dated reminder) — TIMING is satisfied by construction"
      : "- would surface now",
    c.hasEventAt ? "- carries a concrete event/due moment" : "- carries no specific moment",
    "",
    "Does this clear the bar?",
  );
  return lines.join("\n");
}

/**
 * Parse the judge's answer: the LAST `VERDICT: SHIP|HOLD` line wins (the model
 * is asked to end with it), and the preceding text is the reason. Null when no
 * verdict token is present — the caller treats that as a fail-open ship.
 */
export function parseBriefJudgeVerdict(text: string): BriefJudgeVerdict | null {
  const matches = [...text.matchAll(/verdict:\s*(ship|hold)/gi)];
  const last = matches.at(-1);
  if (!last) return null;
  const decision = last[1]!.toLowerCase() === "hold" ? "hold" : "ship";
  const reason = text.slice(0, last.index).replace(/\s+/g, " ").trim();
  return { decision, reason: reason === "" ? "(no reason given)" : reason };
}

/** Token usage of one judge call, folded into `cognition_spend`. */
interface BriefJudgeUsage {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  /** Whether the judge produced a valid verdict; failed turns retain tokens without counting a run. */
  countRun: boolean;
}

export interface LlmBriefJudgeDeps {
  /** Resolve the background-agent chat backend fresh per call; null ⇒ fail open. */
  resolveBackend: () => ChatBackend | null;
  /** Record the call's token spend (fire-and-forget); omitted in tests. */
  recordUsage?: ((usage: BriefJudgeUsage) => void) | undefined;
  log: Logger;
}

export class BriefJudgeModelFailureError extends Error {
  override readonly name = "BriefJudgeModelFailureError";

  constructor(readonly failure: AgentTerminalFailure) {
    super(`brief judge failed: ${failure.code}`);
  }
}

/** The production judge: one no-tools completion on the background-agent backend. */
export class LlmBriefJudge implements BriefJudge {
  constructor(private readonly deps: LlmBriefJudgeDeps) {}

  async judge(candidate: BriefJudgeCandidate): Promise<BriefJudgeVerdict> {
    const backend = this.deps.resolveBackend();
    if (!backend) {
      // No runnable judge backend — the optional gate is absent.
      return { decision: "ship", reason: "judge backend unavailable (fail-open)" };
    }
    const session = new AgentSession({
      sessionId: `brief-judge-${randomUUID()}`,
      backend,
      tools: [],
      systemPrompt: buildBriefJudgeSystemPrompt(candidate.lane),
    });
    let pendingText = "";
    let finalText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    const unsubscribe = session.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case "agent.text.delta":
          pendingText += event.payload.delta;
          break;
        case "agent.message.end": {
          finalText = pendingText.trim() || finalText;
          const u = event.payload.usage;
          if (u) {
            inputTokens +=
              (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0);
            outputTokens += u.outputTokens ?? 0;
          }
          break;
        }
        default:
          break;
      }
    });
    let terminal: AgentMessageEndEvent;
    try {
      const { completion } = session.send(buildBriefJudgeUserPrompt(candidate));
      try {
        terminal = await completion;
      } catch (err) {
        this.recordUsage(backend.model, inputTokens, outputTokens, false);
        throw err;
      }
    } finally {
      unsubscribe();
    }
    const turn = classifyAgentTurn(terminal);
    if (turn.status === "failed") {
      this.recordUsage(backend.model, inputTokens, outputTokens, false);
      throw new BriefJudgeModelFailureError(turn.failure);
    }
    const verdict = parseBriefJudgeVerdict(finalText);
    if (!verdict) {
      this.recordUsage(backend.model, inputTokens, outputTokens, false);
      // Unparseable answer ⇒ fail open, but say so loudly.
      throw new Error(`brief judge returned no verdict: ${finalText.slice(0, 200)}`);
    }
    this.recordUsage(backend.model, inputTokens, outputTokens, true);
    return verdict;
  }

  private recordUsage(
    modelId: string,
    promptTokens: number,
    completionTokens: number,
    countRun: boolean,
  ): void {
    if (!this.deps.recordUsage || (promptTokens === 0 && completionTokens === 0)) return;
    this.deps.recordUsage({ modelId, promptTokens, completionTokens, countRun });
  }
}

/** Outcome of the gate: pass (persist) or hold (do not persist), with the reason to relay. */
type BriefJudgeGateOutcome = { kind: "pass" } | { kind: "hold"; reason: string };

/**
 * The write-time judge gate over `brief_create`. Mirrors `runEntailmentGate`:
 * absent/disabled judge ⇒ pass (no gate); a HOLD verdict ⇒ hold; a configured
 * judge timeout or error ⇒ hold, logged. Every verdict is logged so the bar is
 * observable live and an outage cannot silently ship an unreviewed card.
 */
export async function runBriefJudgeGate(
  deps: {
    getBriefJudge?: (() => BriefJudge | null) | undefined;
    log: Logger;
    /** The run whose brief this is — stamped on every verdict so the bar is measurable per lane rather than reconstructable by timestamp. */
    runId: string;
  },
  candidate: BriefJudgeCandidate,
): Promise<BriefJudgeGateOutcome> {
  const { lane } = candidate;
  // The morning digest never faces ship/hold. It is a scheduled composition
  // the user subscribed to — one card a day, collapsed into one push — so it
  // cannot spam, and "does this earn an interrupt?" is the wrong question to
  // ask of a daily summary. Its quality question is whether the SELECTION is
  // right, which the digest prompt owns; a gate here only ever produces a
  // silent morning. Skipped before the backend resolve so it costs no call.
  if (lane === "digest") return { kind: "pass" };
  if (!deps.getBriefJudge) return { kind: "pass" };
  const where = `run ${deps.runId}, ${lane} lane`;
  try {
    const judge = deps.getBriefJudge();
    if (judge === null) return { kind: "pass" };
    const verdict = await withJudgeDeadline(judge.judge(candidate), BRIEF_JUDGE_TIMEOUT_MS);
    deps.log.info(
      `brief judge: ${verdict.decision.toUpperCase()} on ${where} — "${truncate(candidate.title, 80)}": ${truncate(verdict.reason, 160)}`,
    );
    return verdict.decision === "hold"
      ? { kind: "hold", reason: verdict.reason }
      : { kind: "pass" };
  } catch (err) {
    const reason =
      "the configured Brief judge was unavailable, so the card was held rather than shipped without review";
    deps.log.warn(
      `brief judge failed on ${where} — holding unjudged: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "hold", reason };
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

async function withJudgeDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`brief judge timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
