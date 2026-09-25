// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cognition-spend seam for the interactive agent stack. The gateway
 * wires it (see `createAgentService`) to fold token usage into the durable
 * `cognition_spend` table via the write gate; the agent services stay
 * ignorant of storage and just report what each turn / child run consumed.
 *
 * Every mechanism string that is not a background cognitive workflow is named
 * here, so a recording lane and the surface that labels it read one
 * definition. The background lanes name themselves with a cognitive workflow
 * id instead (`brain/cognition/workflows.ts`), derived from the queue row.
 */

import type { AgentUsage } from "@omnesis/core";

/** User-driven chat turns (SSE/WS sessions, incl. anchored talk-back threads). */
export const INTERACTIVE_SPEND_MECHANISM = "interactive";

/** Children the interactive agent spawns via `spawn_subagent`. */
export const SUBAGENT_SPEND_MECHANISM = "subagent";

/** The annotation write gate's atomic evidence-entailment check. */
export const ENTAILMENT_GATE_SPEND_MECHANISM = "entailment-gate";

/** The independent ship/hold judgement over a candidate brief. */
export const BRIEF_JUDGE_SPEND_MECHANISM = "brief-judge";

/**
 * The opening message the agent writes when a watch fires and hands the
 * operator a conversation instead of a bare notification.
 *
 * Its own bucket rather than `interactive`: this turn runs whether or not
 * anyone is at the phone, so it is the one part of a watch's cost the
 * operator never chose to spend turn by turn. The operator's replies in
 * that thread are ordinary interactive chat and record as such.
 */
export const WATCH_FIRING_OPENING_SPEND_MECHANISM = "watch-firing-opening";

/**
 * The Deep Research stages that record their own mechanism. The planner and
 * the synthesis stage are spawned by name; the readers are named by the plan,
 * so this set also bounds what a plan may contribute to the accounting.
 */
const DEEP_RESEARCH_SPECIALISTS: ReadonlySet<string> = new Set([
  "research-planner",
  "history-sweep",
  "source-digest",
]);

/** Bucket for a Deep Research stage run by a specialist outside the known set. */
export const DEEP_RESEARCH_OTHER_STAGE_MECHANISM = "deep-research:other";

/**
 * One Deep Research pipeline stage, named by the specialist that ran it.
 * Per-specialist rather than one `deep-research` bucket: the planner, the
 * parallel readers, and the synthesis stage have very different context sizes
 * and cost profiles, and the useful split (if measurement ever justifies one)
 * is planner/reader/synthesis — a judgement the accounting has to resolve.
 *
 * The reader names come from the planner model's own JSON plan, so an unknown
 * name folds into {@link DEEP_RESEARCH_OTHER_STAGE_MECHANISM} rather than
 * being interpolated. `mechanism` is part of `cognition_spend`'s primary key
 * in a table that survives every prune: model-invented names would grow the
 * key space without bound, and the plan echoes the user's question, so its
 * text must not reach a durable schema key.
 */
export function deepResearchSpendMechanism(specialist: string): string {
  return DEEP_RESEARCH_SPECIALISTS.has(specialist)
    ? `deep-research:${specialist}`
    : DEEP_RESEARCH_OTHER_STAGE_MECHANISM;
}

/** One settled turn / child run's token spend, ready to record. */
export interface AgentSpendSample {
  mechanism: string;
  /** The resolved backend's model id (`""` when unknown). */
  modelId: string;
  /** Total usage the backend reported across the turn's model calls. */
  usage: AgentUsage;
  /**
   * False when the turn/child failed, was canceled, or hit a budget stop —
   * the tokens still fold into the day bucket, but the sample is not
   * counted as a completed run (mirrors the run queue's failed-attempt
   * accounting).
   */
  completed: boolean;
}

/**
 * Records one spend sample. Fire-and-forget from the caller's view: the
 * implementation owns error handling — a lost sample must never fail an
 * agent turn.
 */
export type AgentSpendRecorder = (sample: AgentSpendSample) => void;
