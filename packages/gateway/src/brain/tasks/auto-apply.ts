// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * When a Brain change to one of the user's own tasks applies on its own.
 *
 * A Brain change to a task the user owns is a proposal the user confirms,
 * unless Omnesis is sure. Being sure takes two things. First this
 * deterministic policy: the Brain stated the fact behind the change as read
 * explicitly in a source, the change is of a kind that can apply on its own
 * (a completion, an addition to the description, a deadline a source
 * states), and it touches nothing the user wrote themselves. Then the
 * entailment verifier, asked whether the quoted evidence establishes the
 * claim this policy builds from the change. Only an entailment verdict
 * applies the change; any other verdict, or no verifier, leaves it a
 * proposal. Striking a task is always the user's call.
 */

import type { OpenLoopRow, ProposedTaskChange, TaskAuthoredField } from "../storage/types.js";

/** The Brain's account of why a task changes. */
export interface TaskChangeEvidence {
  /** The specific fact that establishes the change, as one sentence. */
  fact: string;
  /** Whether a source states the fact (`explicit`) or the Brain concluded it (`inferred`). */
  basis: "explicit" | "inferred";
}

/** A change this policy lets apply once its claim is verified. */
export interface AutoApplicableChange {
  kind: "complete" | "edit";
  fields?: { description?: string; deadline?: unknown };
}

export type TaskAutoApplyPlan =
  | {
      eligible: true;
      change: AutoApplicableChange;
      /** What the evidence must establish for the change to apply. */
      claim: string;
    }
  | { eligible: false; why: string };

/** What the entailment verifier answered, or why it did not. */
export type TaskEvidenceVerdict = "entailment" | "neutral" | "contradiction" | "unavailable";

/**
 * Whether a change could apply on its own, and the claim the verifier must
 * confirm for it to. `proposal` is the change as `taskProposalFor` reads it.
 */
export function planTaskAutoApply(input: {
  enabled: boolean;
  loop: Pick<OpenLoopRow, "title" | "description" | "deadline" | "state">;
  proposal: Pick<ProposedTaskChange, "kind" | "fields">;
  authored: ReadonlySet<TaskAuthoredField>;
  evidence: TaskChangeEvidence | undefined;
}): TaskAutoApplyPlan {
  const { loop, proposal, authored, evidence } = input;
  if (!input.enabled) return no("automatic task changes are turned off");
  if (proposal.kind === "strike") return no("striking a task is always the user's call");
  if (!evidence) return no("no evidence was stated");
  if (evidence.basis !== "explicit") return no("the change rests on an inference");
  const fact = evidence.fact.trim();
  if (!fact) return no("no evidence was stated");

  if (proposal.kind === "complete") {
    if (authored.has("state")) return no("the user reopened this task");
    return {
      eligible: true,
      change: { kind: "complete" },
      claim: `${withStop(fact)} So this is done: ${withStop(loop.title)}`,
    };
  }

  const fields = proposal.fields ?? {};
  if (fields.title !== undefined) return no("a new title is always proposed");
  if (fields.scheduledFor !== undefined) return no("when to do a task is the user's call");
  const change: NonNullable<AutoApplicableChange["fields"]> = {};
  const claims: string[] = [];
  if (fields.description !== undefined) {
    if (authored.has("description")) return no("the user wrote this description");
    const added = descriptionAddition(loop.description, fields.description);
    if (added === null) return no("rewriting a description is always proposed");
    change.description = fields.description;
    claims.push(withStop(added));
  }
  if (fields.deadline !== undefined) {
    if (authored.has("deadline")) return no("the user set this deadline");
    if (fields.deadline === null) return no("removing a deadline is always proposed");
    change.deadline = fields.deadline;
    claims.push(withStop(fact));
  }
  if (claims.length === 0) return no("nothing to change");
  return { eligible: true, change: { kind: "edit", fields: change }, claim: claims.join(" ") };
}

/**
 * The final call: an eligible change applies only on an entailment verdict.
 * Returns why it stays a proposal otherwise.
 */
export function decideTaskAutoApply(
  plan: TaskAutoApplyPlan,
  verdict: TaskEvidenceVerdict | null,
): { apply: true; change: AutoApplicableChange } | { apply: false; why: string } {
  if (!plan.eligible) return { apply: false, why: plan.why };
  switch (verdict) {
    case "entailment":
      return { apply: true, change: plan.change };
    case "neutral":
      return { apply: false, why: "the evidence does not establish the change" };
    case "contradiction":
      return { apply: false, why: "the evidence contradicts the change" };
    case "unavailable":
    case null:
      return { apply: false, why: "the evidence could not be verified" };
  }
}

/**
 * The text a new description adds to the current one, or null when it
 * changes or removes what was there.
 */
export function descriptionAddition(current: string, next: string): string | null {
  const before = current.trim();
  const after = next.trim();
  if (!after.startsWith(before)) return null;
  const added = after.slice(before.length).trim();
  return added.length > 0 ? added : null;
}

function no(why: string): TaskAutoApplyPlan {
  return { eligible: false, why };
}

function withStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
