// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * When a Brain change to one of the user's own tasks applies on its own.
 *
 * Accepting a suggestion is where the user decides whether a task is worth
 * tracking; once a task is theirs, keeping it current is Omnesis's job. So
 * a Brain change applies on its own unless it takes that decision back from
 * the user or overrides their own words:
 *
 * - Striking a task is always the user's call.
 * - Context applies freely: a new title or description where the user did
 *   not write that field, an addition to a description they did write, and
 *   dropping a deadline Omnesis set.
 * - Facts need proof: completing a task, or setting a deadline the user did
 *   not set, rests on a fact the Brain read explicitly in a source, and the
 *   entailment verifier must confirm that the quoted evidence establishes it.
 * - Anything else that touches what the user wrote (their title, a rewrite
 *   of their description, their deadline, a task they reopened) stays a
 *   proposal they confirm.
 *
 * Every applied change is recorded in the task's history, where the user can
 * undo it; undoing it makes that field the user's.
 */

import type {
  OpenLoopRow,
  OpenLoopState,
  ProposedTaskChange,
  TaskAuthoredField,
} from "../storage/types.js";

/**
 * The proposal a run's update makes to one of the user's own tasks, or null
 * when the update changes nothing the user owns. Resolving proposes
 * completion or striking; other field changes propose an edit. A snooze is
 * not proposed: when to do a task is the user's call.
 */
export function taskProposalFor(
  loop: Pick<OpenLoopRow, "state" | "title" | "description" | "deadline">,
  change: { state?: OpenLoopState; title?: string; description?: string; deadline?: unknown },
): Pick<ProposedTaskChange, "kind" | "fields"> | null {
  if (change.state === "done" && loop.state !== "done") return { kind: "complete" };
  if (change.state === "dismissed" && loop.state !== "dismissed") return { kind: "strike" };
  const fields: NonNullable<ProposedTaskChange["fields"]> = {};
  if (change.title !== undefined && change.title !== loop.title) fields.title = change.title;
  if (change.description !== undefined && change.description !== loop.description)
    fields.description = change.description;
  if (
    change.deadline !== undefined &&
    JSON.stringify(change.deadline) !== JSON.stringify(loop.deadline)
  )
    fields.deadline = change.deadline;
  return Object.keys(fields).length > 0 ? { kind: "edit", fields } : null;
}

/** The Brain's account of why a task changes. */
export interface TaskChangeEvidence {
  /** The specific fact that establishes the change, as one sentence. */
  fact: string;
  /** Whether a source states the fact (`explicit`) or the Brain concluded it (`inferred`). */
  basis: "explicit" | "inferred";
}

/** A change this policy lets apply on its own. */
export interface AutoApplicableChange {
  kind: "complete" | "edit";
  fields?: { title?: string; description?: string; deadline?: unknown };
}

export type TaskAutoApplyPlan =
  | {
      eligible: true;
      change: AutoApplicableChange;
      /**
       * What the evidence must establish for the change to apply; absent
       * when the change is context that needs no proof.
       */
      claim?: string;
    }
  | { eligible: false; why: string };

/** What the entailment verifier answered, or why it did not. */
export type TaskEvidenceVerdict = "entailment" | "neutral" | "contradiction" | "unavailable";

/**
 * Whether a change could apply on its own, and the claim the verifier must
 * confirm when it rests on a fact. `proposal` is the change as
 * `taskProposalFor` reads it.
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
  const fact = provenFact(evidence);

  if (proposal.kind === "complete") {
    if (authored.has("state")) return no("the user reopened this task");
    if (typeof fact !== "string") return no(fact.why);
    return {
      eligible: true,
      change: { kind: "complete" },
      claim: `${withStop(fact)} So this is done: ${withStop(loop.title)}`,
    };
  }

  const fields = proposal.fields ?? {};
  if (fields.scheduledFor !== undefined) return no("when to do a task is the user's call");
  const change: NonNullable<AutoApplicableChange["fields"]> = {};
  const claims: string[] = [];
  if (fields.title !== undefined) {
    if (authored.has("title")) return no("the user wrote this title");
    change.title = fields.title;
  }
  if (fields.description !== undefined) {
    if (
      authored.has("description") &&
      descriptionAddition(loop.description, fields.description) === null
    )
      return no("the user wrote this description");
    change.description = fields.description;
  }
  if (fields.deadline !== undefined) {
    if (authored.has("deadline")) return no("the user set this deadline");
    if (fields.deadline !== null) {
      if (typeof fact !== "string") return no(fact.why);
      claims.push(withStop(fact));
    }
    change.deadline = fields.deadline;
  }
  if (Object.keys(change).length === 0) return no("nothing to change");
  return {
    eligible: true,
    change: { kind: "edit", fields: change },
    ...(claims.length > 0 ? { claim: claims.join(" ") } : {}),
  };
}

/**
 * The final call: an eligible change that rests on a fact applies only on an
 * entailment verdict; context applies as planned. Returns why it stays a
 * proposal otherwise.
 */
export function decideTaskAutoApply(
  plan: TaskAutoApplyPlan,
  verdict: TaskEvidenceVerdict | null,
): { apply: true; change: AutoApplicableChange } | { apply: false; why: string } {
  if (!plan.eligible) return { apply: false, why: plan.why };
  if (plan.claim === undefined) return { apply: true, change: plan.change };
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

/** The stated fact a change can rest on, or why there is none. */
function provenFact(evidence: TaskChangeEvidence | undefined): string | { why: string } {
  if (!evidence) return { why: "no evidence was stated" };
  if (evidence.basis !== "explicit") return { why: "the change rests on an inference" };
  const fact = evidence.fact.trim();
  return fact ? fact : { why: "no evidence was stated" };
}

function no(why: string): TaskAutoApplyPlan {
  return { eligible: false, why };
}

function withStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
