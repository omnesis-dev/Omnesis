// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * What each cognitive workflow is allowed to write.
 *
 * Without this, every background run would hold the same mutation surface: a
 * merge adjudication could note observations, a morning digest could retract
 * annotations, a re-grounding pass could mint loops. A restriction written
 * into a prompt ("issue the verdict through its dedicated tool and nothing
 * else") is a request, not a permission. A model that ignores one, or a later
 * prompt edit that drops the sentence, would silently gain the whole surface.
 *
 * Authority is declared per workflow here and enforced by the runtime when it
 * assembles the toolset, so a workflow physically cannot call a verb it was
 * not granted. Reads stay broad: a background run that cannot search widely
 * reasons badly, and reading has no side effect to contain.
 */

import { COGNITIVE_WORKFLOW_IDS, UNRECOGNIZED_WORKFLOW_ID } from "./workflows.js";
import type { CognitiveWorkflowId } from "./workflows.js";

/**
 * The kinds of durable state background cognition can write. Grouped by
 * artifact rather than by tool so a new verb over an existing artifact needs
 * no per-workflow grant, while a new artifact is an explicit decision.
 */
export const COGNITIVE_ARTIFACTS = [
  "knowledge",
  "loop",
  "observation",
  "morning-brief",
  "note",
  "scheduled-run",
  "doc-annotation",
  "person-annotation",
  "temporal-annotation",
  "merge-verdict",
] as const;

export type CognitiveArtifact = (typeof COGNITIVE_ARTIFACTS)[number];

/**
 * The mutating tools that write each artifact. Must stay exhaustive over
 * `COGNITION_MUTATING_TOOL_NAMES` — a mutating tool missing from here would
 * be denied to every workflow, which a test pins.
 */
const ARTIFACT_TOOLS: Readonly<Record<CognitiveArtifact, readonly string[]>> = {
  knowledge: [
    "knowledge_link",
    "knowledge_evidence",
    "knowledge_save",
    "knowledge_edit",
    "knowledge_retire",
    "knowledge_propose_page",
    "knowledge_candidate_decide",
    "knowledge_next_frontier",
    "knowledge_discovery_complete",
    "knowledge_organization_complete",
    "knowledge_temporal_context",
  ],
  loop: [
    "loop_synthesis_save",
    "open_loop_create",
    "open_loop_update",
    "open_loop_ledger_append",
    "open_loop_delete",
  ],
  observation: ["observation_note", "observation_withdraw"],
  "morning-brief": ["morning_brief_send"],
  note: ["notes_append", "notes_rewrite", "notes_edit"],
  "scheduled-run": ["schedule_agent_run"],
  "doc-annotation": [
    "doc_annotation_synthesis_save",
    "annotate_durable",
    "annotation_revise",
    "annotation_retract",
    "annotation_supersede",
  ],
  "person-annotation": [
    "person_annotation_synthesis_save",
    "annotate_person",
    "person_annotation_revise",
    "person_annotation_retract",
    "person_annotation_supersede",
  ],
  "temporal-annotation": [
    "temporal_annotation_add",
    "temporal_annotation_update",
    "temporal_annotation_delete",
  ],
  "merge-verdict": ["merge_adjudicate"],
};

/**
 * What a workflow may write when nothing narrower is declared: everything
 * except a merge verdict, which only identity adjudication issues, and the
 * morning brief, which only the morning run sends.
 */
const DEFAULT_AUTHORITY: readonly CognitiveArtifact[] = COGNITIVE_ARTIFACTS.filter(
  (a) => a !== "merge-verdict" && a !== "morning-brief",
);

/**
 * Workflows whose authority is narrower than the default, each because its job
 * is genuinely narrower — not as a guess about what it might misuse.
 */
const NARROWED_AUTHORITY: Partial<Record<CognitiveWorkflowId, readonly CognitiveArtifact[]>> = {
  // Two workflows nothing produces any more — the retired evaluator's
  // precision batches. Their ids survive because they are persisted in spend
  // and attribution rows, so the map still has to answer for them; a run that
  // somehow arrived carrying one would be work nobody can account for, and
  // work nobody can account for writes nothing.
  "subscription-precision": [],
  "watch-precision": [],

  // Work whose procedure could not be determined writes nothing. Falling
  // through to the default would hand the widest authority in the system to
  // the one case we understand least — a run row from a build this one does
  // not know, or a payload that matches no schema. Spend already quarantines
  // the same id; authority must not invert that.
  [UNRECOGNIZED_WORKFLOW_ID]: [],

  // Decides one pending person-merge candidate and records the verdict through
  // its own tool. It reads evidence widely and writes nothing else.
  "identity-adjudication": ["merge-verdict"],

  // Watch compilation runs outside the steward with the restricted retrieval
  // profile from watch/compiler-session.ts (compilerTools), or a tool-less
  // completion fallback. It has no authority over the steward's durable state.
  "subscription-compile": [],

  // Composes and sends the day's one morning brief from observations the
  // morning recheck already ranked. An editorial pass: it writes the message
  // and nothing underneath it.
  "morning-digest": ["morning-brief"],

  // Re-grounds durable annotation memory against current evidence: revise,
  // retract, supersede. It maintains what is already believed and must not
  // turn a re-check into a new interruption.
  "memory-regrounding": ["doc-annotation", "person-annotation", "temporal-annotation"],

  // Re-examines a dependent whose supporting prior died. Same shape as
  // re-grounding — it revises the loop it was pointed at, and may retire
  // a loop that rested on nothing, but does not mint fresh state.
  "provenance-recheck": ["loop", "doc-annotation", "person-annotation"],

  // Rewrites the over-cap notes blob back under its size target. Pure
  // self-maintenance of one artifact — it curates existing memory and must
  // not turn a housekeeping pass into loops, observations, or annotations.
  "notes-compaction": ["note"],
};

/** The artifacts a workflow may write. */
export function mutationAuthorityFor(id: CognitiveWorkflowId): readonly CognitiveArtifact[] {
  return NARROWED_AUTHORITY[id] ?? DEFAULT_AUTHORITY;
}

/**
 * Every tool a workflow may call that writes durable state — the positive
 * allow-list the runtime filters on.
 *
 * Deliberately positive rather than "deny the known-mutating set": a deny-list
 * grants any newly added mutating tool to every workflow until someone
 * remembers to register it, which is the failure mode this module exists to
 * remove. A tool the list does not name is simply not granted.
 */
export function isGrantedMutation(id: CognitiveWorkflowId, toolName: string): boolean {
  return mutatingToolsFor(id).has(toolName);
}

/**
 * The mutating tool names a workflow may call. The runtime filters the
 * assembled toolset through this; a tool absent from the result is not merely
 * discouraged, it is not present for the model to call.
 */
export function mutatingToolsFor(id: CognitiveWorkflowId): ReadonlySet<string> {
  const names = new Set<string>();
  for (const artifact of mutationAuthorityFor(id)) {
    for (const tool of ARTIFACT_TOOLS[artifact]) names.add(tool);
  }
  return names;
}

/** The mutating tools that write one artifact. */
export function toolsForArtifact(artifact: CognitiveArtifact): readonly string[] {
  return ARTIFACT_TOOLS[artifact];
}

/** Every tool this module knows how to grant — the union over all artifacts. */
export function allGrantableMutatingTools(): ReadonlySet<string> {
  return new Set(Object.values(ARTIFACT_TOOLS).flat());
}

/** Workflows that carry a narrower-than-default authority, for the inspector. */
export function narrowedWorkflows(): readonly CognitiveWorkflowId[] {
  return COGNITIVE_WORKFLOW_IDS.filter((id) => NARROWED_AUTHORITY[id] !== undefined);
}
