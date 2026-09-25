// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The cognitive-workflow vocabulary — the names of the semantic procedures the
 * background agent performs, independent of the queue kinds that carry them.
 *
 * A queue kind is a scheduling class: it decides claim priority, retry, and
 * fold behaviour. A workflow is what the run actually *does*. The two are not
 * one-to-one — several kinds multiplex distinct procedures behind one kind
 * string, discriminated only by payload shape:
 *
 *   data        → datum intake | subscription precision
 *   daily       → per-source review | day-ahead review | morning digest
 *   time_based  → scheduled follow-up | loop decay check
 *   feedback    → dismissal learning | provenance recheck
 *   synthesis   → noticing | collision review | contradiction review
 *
 * Attributing cost and behaviour to the kind therefore blends procedures with
 * very different context sizes, tool use, and value. Every mechanism that
 * spends tokens names itself with a workflow id from this module instead, so
 * `cognition_spend` resolves at the granularity a model-assignment decision is
 * actually made at.
 *
 * The ids are durable identifiers written into a permanent accounting table —
 * renaming one splits its history across two buckets. Add ids freely; change
 * them only with a deliberate migration.
 */

import {
  BRIEF_JUDGE_SPEND_MECHANISM,
  WATCH_FIRING_OPENING_SPEND_MECHANISM,
  DEEP_RESEARCH_OTHER_STAGE_MECHANISM,
  ENTAILMENT_GATE_SPEND_MECHANISM,
  INTERACTIVE_SPEND_MECHANISM,
  SUBAGENT_SPEND_MECHANISM,
  deepResearchSpendMechanism,
} from "../../agent/spend-recorder.js";
import {
  parseCognitionDataRunPayload,
  parseCognitionDailyRunPayload,
  parseCognitionMayDayRunPayload,
  parseCognitionDigestRunPayload,
  parseCognitionTimeBasedRunPayload,
  parseCognitionDecayCheckRunPayload,
  parseCognitionFeedbackRunPayload,
  parseCognitionProvenanceRecheckPayload,
  parseCognitionSynthesisRunPayload,
} from "../run-payloads.js";
import type { CognitionRunKind } from "../storage/types.js";

/**
 * One workflow's durable id → what it is called on an operator surface, and
 * which queue kind carries it (`null` for {@link UNRECOGNIZED_WORKFLOW_ID},
 * which by definition has no known kind).
 */
interface CognitiveWorkflowMeta {
  readonly label: string;
  readonly queueKind: CognitionRunKind | null;
  /**
   * The workflow's contract version. Bump it when the prompt, tool surface, or
   * output shape changes enough that artifacts produced by the previous
   * version were made under different rules — that is what lets a later pass
   * ask "which of my artifacts predate this change?" (`run-attribution.ts`).
   *
   * A bump does not itself reprocess anything. Deciding whether superseded
   * artifacts are re-grounded, and at what cost, is a separate call.
   */
  readonly version: number;
}

/**
 * The bucket for work whose workflow could not be determined: a queue row
 * whose `kind` is outside the known union, or whose payload matches no schema
 * for its kind.
 *
 * Deliberately distinct from `unattributed`, which names the day-total spend
 * history folded in when per-mechanism accounting was introduced. Conflating a
 * live "could not tell" with migrated history would make both unreadable.
 */
export const UNRECOGNIZED_WORKFLOW_ID = "unrecognized";

/**
 * Every cognitive workflow: one entry per semantic procedure, not per queue
 * kind. One record rather than parallel maps so a new workflow is declared in
 * a single place.
 */
const WORKFLOWS = {
  "datum-intake": { label: "Datum intake", queueKind: "data", version: 1 },
  // Two workflows nothing produces any more: the retired watch evaluator's
  // per-document precision batches. Kept because their ids are **persisted**
  // — `cognition_spend` is keyed on the mechanism and `cognition_run_attribution`
  // outlives the run rows — and a label lookup that lost them would render
  // months of real accounting as unrecognised work.
  "subscription-precision": { label: "Subscription precision", queueKind: "data", version: 1 },
  "watch-precision": { label: "Watch precision", queueKind: "data", version: 1 },
  "source-bootstrap": { label: "Source catch-up", queueKind: "bootstrap", version: 1 },
  "daily-source-review": { label: "Daily source review", queueKind: "daily", version: 1 },
  "daily-lookahead": { label: "Day-ahead review", queueKind: "daily", version: 1 },
  "morning-digest": { label: "Morning digest", queueKind: "daily", version: 1 },
  "time-reaction": { label: "Time reaction", queueKind: "time_based", version: 1 },
  "loop-decay-check": { label: "Loop decay check", queueKind: "time_based", version: 1 },
  "feedback-learning": { label: "Feedback learning", queueKind: "feedback", version: 1 },
  "provenance-recheck": { label: "Provenance recheck", queueKind: "feedback", version: 1 },
  noticing: { label: "Noticing", queueKind: "synthesis", version: 1 },
  "collision-review": { label: "Collision review", queueKind: "synthesis", version: 1 },
  "contradiction-review": { label: "Contradiction review", queueKind: "synthesis", version: 1 },
  "thematic-sweep": { label: "Thematic sweep", queueKind: "sweep", version: 1 },
  "memory-regrounding": { label: "Memory re-grounding", queueKind: "verification", version: 1 },
  "notes-compaction": { label: "Notes compaction", queueKind: "notes_compaction", version: 1 },
  "identity-adjudication": {
    label: "Identity adjudication",
    queueKind: "merge_adjudication",
    version: 1,
  },
  // Watch compilation runs synchronously inside the authoring request and is
  // recorded into the ledger already settled (`recordSettledCognitionRun`);
  // its kind never sits pending in the queue.
  "subscription-compile": {
    label: "Watch compilation",
    queueKind: "subscription_compile",
    version: 1,
  },
  [UNRECOGNIZED_WORKFLOW_ID]: { label: "Unrecognized work", queueKind: null, version: 1 },
} as const satisfies Record<string, CognitiveWorkflowMeta>;

export type CognitiveWorkflowId = keyof typeof WORKFLOWS;

export const COGNITIVE_WORKFLOW_IDS = Object.keys(WORKFLOWS) as readonly CognitiveWorkflowId[];

/** Display name for a workflow id. */
export function cognitiveWorkflowLabel(id: CognitiveWorkflowId): string {
  return WORKFLOWS[id].label;
}

/**
 * The workflow's current contract version. Accepts any string: the id reaching
 * here is derived from a queue row, and an unknown one must attribute to the
 * unrecognized bucket rather than throw out of a settle transaction — the same
 * discipline `cognitiveWorkflowIdForRun` applies to an unknown kind.
 */
export function cognitiveWorkflowVersion(id: string): number {
  return isCognitiveWorkflowId(id)
    ? WORKFLOWS[id].version
    : WORKFLOWS[UNRECOGNIZED_WORKFLOW_ID].version;
}

/**
 * The queue kind that carries a workflow; `null` for
 * {@link UNRECOGNIZED_WORKFLOW_ID}. Nothing on the claim path reads this —
 * claim priority lives in the run queue's own rank expression. It records the
 * kind↔workflow correspondence so a test can assert every kind stays
 * reachable, and so a reader can see which scheduling class a workflow runs
 * under without tracing its enqueuer.
 */
export function cognitiveWorkflowQueueKind(id: CognitiveWorkflowId): CognitionRunKind | null {
  return WORKFLOWS[id].queueKind;
}

/**
 * The workflow a queued run performs, from its kind + payload.
 *
 * Discrimination rests on the payload schemas being mutually exclusive: each
 * is `.strict()` with a disjoint set of required keys, so at most one parser
 * accepts a given payload. Where a kind carries exactly one workflow the
 * payload is never consulted.
 *
 * A branch that fails to recognise its payload resolves to
 * {@link UNRECOGNIZED_WORKFLOW_ID} rather than falling into a real workflow's
 * bucket — silently folding an undecodable run into `daily-source-review`
 * would pollute the measurement this vocabulary exists to make trustworthy.
 *
 * `kind` is an unvalidated read from SQLite (the queue casts the stored text),
 * so this is an external-data switch and takes a typed default rather than
 * `assertNever`. Returning `undefined` here would violate `cognition_spend`'s
 * NOT NULL mechanism, roll back the settle transaction, and abandon the
 * remaining runs in the drain tick — the spend path must degrade, not wedge.
 */
export function cognitiveWorkflowIdForRun(
  kind: CognitionRunKind,
  payload: unknown,
): CognitiveWorkflowId {
  switch (kind) {
    case "data": {
      const data = parseCognitionDataRunPayload(payload);
      if (!data) return UNRECOGNIZED_WORKFLOW_ID;
      return "datum-intake";
    }
    case "bootstrap":
      return "source-bootstrap";
    case "sweep":
      return "thematic-sweep";
    case "verification":
      return "memory-regrounding";
    case "merge_adjudication":
      return "identity-adjudication";
    case "notes_compaction":
      return "notes-compaction";
    case "subscription_compile":
      return "subscription-compile";
    case "daily":
      if (parseCognitionDigestRunPayload(payload)) return "morning-digest";
      if (parseCognitionMayDayRunPayload(payload)) return "daily-lookahead";
      return parseCognitionDailyRunPayload(payload)
        ? "daily-source-review"
        : UNRECOGNIZED_WORKFLOW_ID;
    case "time_based":
      if (parseCognitionDecayCheckRunPayload(payload)) return "loop-decay-check";
      return parseCognitionTimeBasedRunPayload(payload)
        ? "time-reaction"
        : UNRECOGNIZED_WORKFLOW_ID;
    case "feedback":
      if (parseCognitionProvenanceRecheckPayload(payload)) return "provenance-recheck";
      return parseCognitionFeedbackRunPayload(payload)
        ? "feedback-learning"
        : UNRECOGNIZED_WORKFLOW_ID;
    case "synthesis": {
      const synthesis = parseCognitionSynthesisRunPayload(payload);
      if (!synthesis) return UNRECOGNIZED_WORKFLOW_ID;
      if (synthesis.focus === "collision") return "collision-review";
      if (synthesis.focus === "annotation-contradiction") return "contradiction-review";
      return "noticing";
    }
    default:
      return UNRECOGNIZED_WORKFLOW_ID;
  }
}

/**
 * Display label for any spend mechanism string, including the ones that are
 * not workflow ids (the interactive lanes and the evaluators) and ids written
 * by builds this one does not know about. Unknown values pass through verbatim
 * so a surface never hides a cost it cannot name.
 */
export function cognitionMechanismLabel(mechanism: string): string {
  if (isCognitiveWorkflowId(mechanism)) return cognitiveWorkflowLabel(mechanism);
  return NON_WORKFLOW_MECHANISM_LABELS[mechanism] ?? mechanism;
}

export function isCognitiveWorkflowId(value: string): value is CognitiveWorkflowId {
  return Object.hasOwn(WORKFLOWS, value);
}

/**
 * The mechanisms that spend tokens without being a background workflow: the
 * interactive lanes, the Deep Research stages, and the narrow evaluators.
 *
 * Only mechanisms this build can still write appear here. A row recorded by an
 * older build under a coarser name falls through to the verbatim passthrough
 * in {@link cognitionMechanismLabel} — visible, and unnamed, which is the
 * honest rendering for a figure that cannot be compared with a workflow-level
 * one.
 */
const NON_WORKFLOW_MECHANISM_LABELS: Readonly<Record<string, string>> = {
  [INTERACTIVE_SPEND_MECHANISM]: "Interactive chat",
  [SUBAGENT_SPEND_MECHANISM]: "Interactive sub-agent",
  [ENTAILMENT_GATE_SPEND_MECHANISM]: "Evidence verifier",
  [BRIEF_JUDGE_SPEND_MECHANISM]: "Brief gate",
  [WATCH_FIRING_OPENING_SPEND_MECHANISM]: "Watch opening message",
  [deepResearchSpendMechanism("research-planner")]: "Deep Research · planner",
  [deepResearchSpendMechanism("history-sweep")]: "Deep Research · history sweep",
  [deepResearchSpendMechanism("source-digest")]: "Deep Research · source digest",
  [DEEP_RESEARCH_OTHER_STAGE_MECHANISM]: "Deep Research · other stage",
};
