// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Cognition Steward's own tools — the mutating surface over open loops and
 * observations, the agent-notes memory, and point-in-time scheduling. Built
 * fresh per claimed run so every handle carries the run's id: creates
 * stamp `created_by_run`, ledger appends stamp the run id, and a
 * re-claimed attempt can recognise its own partial work.
 *
 * Only the Cognition Steward gets these handles (only the agent mutates
 * loops/observations in the background). Every mutating handle declares `mutates: true`, so a
 * delegated research sub-agent's tool selection (`selectSubagentTools`)
 * can never include them.
 *
 * Boundary rules:
 *   - zod-at-boundary on every argument object (strict schemas);
 *   - referenced document ids (`docs[]`, `citations[]`) and loop ids
 *     (`relatedLoopIds[]`) are validated against the store — unknown or
 *     privacy-deleted ids are dropped and reported back to the model
 *     rather than persisted as dangling references;
 *   - person refs (`actors[]`/`involved[]`) are resolved to canonical
 *     person ids at this boundary (an email resolves through its alias);
 *     refs matching no known person are dropped and reported back, so
 *     the loop store never carries a value the people surfaces cannot
 *     link to (see `person-refs.ts`);
 *   - all writes go through the write gate (single-writer invariant);
 *   - every loop mutation re-projects the loop's searchable mirror
 *     document (tables-as-truth, document-as-copy).
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TEMPORAL_KINDS } from "@omnesis/core";
import { raceAbort } from "../decision-call.js";
import { readKnowledgeSourceRevision } from "../knowledge/source-revision.js";
import { annotationEntailmentFailures } from "../../inference/annotation-entailment.js";
import {
  annotationVerificationContext,
  annotationEvidenceFrame,
} from "../annotation-verification.js";
import {
  captureOutcomeWriteFence,
  type OutcomeWriteFence,
} from "../storage/outcome-write-fence.js";
import { knowledgeOwnerReadPredicate } from "../knowledge/storage-fence.js";
import { isKnowledgeEvidenceReadable } from "../knowledge/storage-source-fence.js";
import { documentRecordContext } from "../record-check/document-context.js";
import {
  outcomeProposal,
  prepareOutcomeRecordContext,
  type OutcomeProposal,
} from "../record-check/outcome-context.js";
import {
  personRecordContext,
  readPersonReconciliationContext,
} from "../record-check/person-context.js";
import { makeOutcomeAssessment, outcomeReviewBatch } from "../knowledge/outcome-assessment.js";
import { KnowledgeStorageError } from "../knowledge/types.js";
import {
  captureDecisionPayloadSubjects,
  decisionPayloadErasureGeneration,
} from "../decision-payload.js";
import { getOpenLoop, listOpenLoopLedger, searchOpenLoopsLexical } from "../storage/open-loops.js";
import { searchRetiredLoopsLexical } from "../storage/retired-loops.js";
import {
  findOpenObservationsForLoops,
  listObservations,
  listOpenObservations,
} from "../storage/observations.js";
import { searchOpenLoopsByIdentity } from "../reconcile/identity-candidates.js";
import { partitionPersonRefs, resolveLoopPersonRef } from "../person-refs.js";
import { containsNormalizedForContent } from "../quote-match.js";
import {
  getDocAnnotation,
  listDocAnnotationEvidence,
  listLiveAnnotationsForDoc,
  listLiveSameClaimTypeAnnotationsForDoc,
  type AnnotationClaimBasis,
  type AnnotationEvidenceInput,
  type AnnotationVerificationState,
  type DocAnnotationRow,
  type UpdateDocAnnotationPatch,
} from "../storage/annotations.js";
import {
  getPersonAnnotation,
  findUnchangedPersonAnnotation,
  DEFAULT_PERSON_PROFILE_BUDGET,
  getPersonProfileStats,
  enforcePersonProfileBudget,
  listLiveSameClaimTypePersonAnnotations,
  listPersonAnnotationEvidence,
  type PersonAnnotationRow,
  type UpdatePersonAnnotationPatch,
} from "../storage/person-annotations.js";
import { COGNITION_NOTES_OVERFLOW_FACTOR } from "../storage/notes.js";
import {
  getCognitionRun,
  getPendingRunByDedupeKey,
  type EnqueueCognitionRunResult,
} from "../storage/run-queue.js";
import {
  notesCompactionRunDedupeKey,
  parseCognitionTimeBasedRunPayload,
  SCHEDULED_INSTRUCTION_MAX_CHARS,
  SCHEDULED_INSTRUCTION_REQUEST_MAX_CHARS,
} from "../run-payloads.js";
import { fetchSelfPersonId } from "../../domain/InteractionScoreService.js";
import { OPEN_LOOP_DOCUMENT_TYPE, OPEN_LOOP_SOURCE_ID } from "../open-loop-source/source-meta.js";
import { KNOWLEDGE_DOCUMENT_TYPE, KNOWLEDGE_SOURCE_ID } from "../knowledge/source-meta.js";
import {
  expandCanonical,
  getTemporalAnnotationById,
  listTemporalAnnotationEvidence,
  listTemporalAnnotationsForLoop,
  queryTemporalAnnotationReconcileCandidates,
  type TemporalAnnotation,
} from "../../enrichment/temporal-annotations/storage.js";
import { isOwnedTask } from "../storage/types.js";
import { readTaskAuthorship } from "../storage/tasks.js";
import {
  decideTaskAutoApply,
  planTaskAutoApply,
  type TaskEvidenceVerdict,
} from "../tasks/auto-apply.js";
import { jointContextualEvidence } from "./annotation-gate-evidence.js";
import { assessPersonWithdrawal } from "./person-withdrawal.js";
import { PersonProfileReads } from "./person-profile-reads.js";
import type { ObservationScoringInput, ObservationScoringResult } from "../observations/noting.js";
import type { ConsumedAnnotationRef, RunConsumptionTracker } from "./consumption.js";
import type { IdentityCandidate } from "../reconcile/identity-candidates.js";
import type Database from "better-sqlite3";
import type {
  EntailCapability,
  Logger,
  TemporalItem,
  TemporalPrecision,
  ToolResult,
} from "@omnesis/core";
import type { SearchPort, TemporalReadPort, ToolHandle } from "@omnesis/agent";
import type { WriteGate } from "../../write-gate.js";
import type { OpenLoopMirror } from "./mirror.js";
import type { CheckRecord, RecordCheckInput } from "../record-check/check.js";
import type {
  Clock,
  ObservationRow,
  OpenLoopRow,
  OpenLoopState,
  ProposedTaskChange,
} from "../storage/types.js";

type Db = Database.Database;

/** The write-gate slice the tool layer drives. */
export type CognitionWriteOps = Pick<
  WriteGate,
  | "applyMergeAdjudication"
  | "createOpenLoop"
  | "updateOpenLoop"
  | "appendOpenLoopLedger"
  | "deleteOpenLoop"
  | "createObservation"
  | "transitionObservation"
  | "dropObservationsForResolvedLoop"
  | "proposeTaskChange"
  | "autoApplyTaskChange"
  | "writeCognitionNotes"
  | "appendCognitionNotes"
  | "editCognitionNotes"
  | "enqueueCognitionRun"
  | "cancelScheduledRunsForLoop"
  | "createDocAnnotation"
  | "createDocAnnotationSuperseding"
  | "supersedeDocAnnotationBy"
  | "updateDocAnnotation"
  | "deleteDocAnnotation"
  | "createPersonAnnotation"
  | "createPersonAnnotationSuperseding"
  | "supersedePersonAnnotationBy"
  | "revisePersonAnnotation"
  | "retractPersonAnnotation"
  | "createTemporalAnnotation"
  | "updateTemporalAnnotation"
  | "invalidateTemporalAnnotation"
  | "recordSweepTally"
>;

export interface CognitionToolDeps {
  personProfileReads?: PersonProfileReads;
  /** Source-owned speaker/provenance check in addition to document quote matching. */
  validateAnnotationEvidence?: (
    documentId: string,
    quote: string,
  ) => Promise<{ code: string; message: string } | null>;
  /** Read-side handle (existence checks, fetches, list queries). */
  db: Db;
  writeGate: CognitionWriteOps;
  /** Search scoped by the tools to `documentType: "open-loop"`. */
  searchPort: SearchPort;
  /** Unified projection + annotation read used by annotation reconciliation. */
  temporalPort?: TemporalReadPort;
  mirror: OpenLoopMirror;
  /** Live notes byte cap (config `brain.notesMaxBytes`). */
  getNotesMaxBytes: () => number;
  clock: Clock;
  /** The claimed run these handles execute inside. */
  runId: string;
  /**
   * Scores a new observation with the decision model before it is stored,
   * and computes whether it would have earned a same-day push. Absent (no
   * decision model, or unit tests) the observation is stored unscored.
   */
  scoreObservation?: (input: ObservationScoringInput) => Promise<ObservationScoringResult>;
  /**
   * The open loop this run is itself scoped to, if any (a loop-scoped
   * `time_based` or decay check). Lets `schedule_agent_run` auto-attach a
   * structured `loopId` onto a follow-up check the agent schedules without
   * one, so the resolve/delete cascade doesn't rely on the model's
   * discipline. Absent for un-scoped runs (`data`/`daily`/`feedback` and
   * loop-less checks). See {@link runScopeLoopId}.
   */
  triggeringLoopId?: string;
  /**
   * The documents this run is about — a data run's datum, or a loop-scoped
   * check's target-loop docs. `open_loop_search` gathers identity-based
   * reconcile candidates (shared people / thread / linked docs / nearby
   * deadline) from these before the lexical overlay. Empty/absent for runs
   * with no single datum focus (feedback, most daily) → search stays
   * lexical + semantic exactly as before.
   */
  seedDocIds?: readonly string[];
  /** 1-hop neighbour fanout for identity reconcile (config-derived). */
  reconcileNeighborFanout?: number;
  /** Deadline-proximity window (ms) for identity reconcile (config-derived). */
  reconcileDeadlineWindowMs?: number;
  /** Id generator for created loops/observations/scheduled runs (tests pin it). */
  idGen?: () => string;
  /** Expose the `annotate_durable` tool and accept its writes. */
  annotationsEnabled?: boolean;
  /** Hard ceiling applied to an annotation's recorded confidence. */
  annotationConfidenceCeiling?: number;
  /**
   * Per-claim-basis confidence ceilings, applied before the global ceiling:
   * the further a claim reasons from its evidence (quoted → inferred →
   * synthesized), the lower its recorded confidence may go.
   */
  annotationBasisCeilings?: { quoted: number; inferred: number; synthesized: number };
  /**
   * Abstention floor: a new annotation whose post-clamp confidence falls
   * below this is refused outright rather than persisted as a weak prior.
   */
  annotationConfidenceFloor?: number;
  personProfileBudget?: { maxFacts: number; maxCharacters: number };
  /**
   * Resolve the entailment verifier for the annotation firewall, fresh per
   * call (so a model swap takes effect without rebuilding the toolset).
   * Absent, or resolving to null (role unset), the gate is skipped and
   * annotation writes behave exactly as without it.
   */
  getEntailmentVerifier?: (signal?: AbortSignal) => Promise<EntailCapability | null>;
  /**
   * The record check bound to this run, consulted when a NEW annotation is
   * saved: in enforce mode its answer decides whether the write happens.
   * Absent (interactive memory, unchecked lanes, no decision model) every
   * record is saved unchecked.
   */
  checkRecord?: CheckRecord;
  /**
   * Apply a Brain change to one of the user's own tasks directly, under the
   * auto-apply policy, instead of proposing it (config `brain.tasks.autoApply`). Absent or
   * false, every such change is a proposal.
   */
  taskAutoApply?: boolean;
  /**
   * Per-run surfaced-prior tracker (consumption provenance). Search results,
   * prompt-inlined priors and self-memory become candidates that a later
   * observation/loop mutation can explicitly select as material dependencies.
   * Absent (pure-composition unit tests) ⇒ only an explicit empty selection
   * is valid and no edges are recorded.
   */
  consumption?: RunConsumptionTracker;
  log: Logger;
}

/** Names of the Cognition Steward's mutating tools (the sub-agent split contract). */
export const COGNITION_MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "open_loop_create",
  "open_loop_update",
  "open_loop_ledger_append",
  "open_loop_delete",
  "observation_note",
  "observation_withdraw",
  "notes_append",
  "notes_rewrite",
  "notes_edit",
  "schedule_agent_run",
  "annotate_durable",
  "annotation_revise",
  "annotation_retract",
  "annotation_supersede",
  "annotate_person",
  "person_annotation_revise",
  "person_annotation_retract",
  "person_annotation_supersede",
  "temporal_annotation_add",
  "temporal_annotation_update",
  "temporal_annotation_delete",
  // Added to a merge-adjudication run's toolset from the runtime, not built
  // here — listed so the authority filter covers it like every other verb
  // that writes durable state.
  "merge_adjudicate",
  // Added by the runtime for the morning run alone, like merge_adjudicate.
  "morning_brief_send",
]);

// ── shared schema fragments ────────────────────────────────────────────────

const fraction = z.number().min(0).max(1);

const claimBasisEnum = z.enum(["quoted", "inferred", "synthesized"]);

/**
 * claimType is an equality KEY — the one-belief invariant compares on it —
 * so it is normalized at the tool boundary (trimmed + lowercased) before any
 * compare or persist: "Topic" and " topic" are the same claim kind. Stored
 * rows may predate this normalization, so every read-side compare is
 * case-insensitive to match (COLLATE NOCASE in the probes and the sweep).
 */
const claimTypeField = z.string().trim().toLowerCase().min(1).max(60);

/** Case/whitespace-insensitive claimType equality (stored rows may carry legacy casing). */
function claimTypeEquals(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date-time");

const idList = z.array(z.string().min(1)).max(100);

const annotationDependenciesField = z
  .array(
    z
      .object({
        store: z.enum(["doc", "person"]),
        annotationId: z.string().min(1),
      })
      .strict(),
  )
  .max(100)
  .describe(
    "The complete set of annotation priors that materially informed THIS output mutation. " +
      "Use only ids surfaced in this run; pass [] when none did. Do not include priors merely visible in context.",
  );

function isoToMs(iso: string): number {
  return Date.parse(iso);
}

function msToIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

// ── result helpers ─────────────────────────────────────────────────────────

function ok(resultType: string, data: unknown): ToolResult {
  return { kind: "structured", resultType, data };
}

function invalidArgs(error: z.ZodError): ToolResult {
  const issue = error.issues[0];
  const path = issue?.path.join(".") ?? "";
  return {
    kind: "error",
    code: "invalid_args",
    message: `${path ? `${path}: ` : ""}${issue?.message ?? "invalid arguments"}`,
  };
}

function notFound(what: string, id: string): ToolResult {
  return { kind: "error", code: "not_found", message: `${what} ${id} does not exist` };
}

// ── reference validation ───────────────────────────────────────────────────

/** Split ids into those present in `documents` and those unknown/deleted. */
function partitionDocIds(db: Db, ids: readonly string[]): { known: string[]; dropped: string[] } {
  const stmt = db.prepare<[string], { id: string }>("SELECT id FROM documents WHERE id = ?");
  const known: string[] = [];
  const dropped: string[] = [];
  for (const id of ids) (stmt.get(id) ? known : dropped).push(id);
  return { known, dropped };
}

/** Split ids into existing open loops and unknown ones. */
function partitionLoopIds(db: Db, ids: readonly string[]): { known: string[]; dropped: string[] } {
  const stmt = db.prepare<[string], { id: string }>("SELECT id FROM open_loops WHERE id = ?");
  const known: string[] = [];
  const dropped: string[] = [];
  for (const id of ids) (stmt.get(id) ? known : dropped).push(id);
  return { known, dropped };
}

/**
 * True when every cited document was written or sent by the user: each has
 * an author or sender person marked as self.
 */
function citationsAuthoredBySelf(db: Db, docIds: readonly string[]): boolean {
  if (docIds.length === 0) return false;
  const stmt = db.prepare<[string], { one: number }>(
    `SELECT 1 AS one FROM document_people dp JOIN people p ON p.id = dp.person_id
      WHERE dp.document_id = ? AND dp.role IN ('author','sender') AND p.is_self = 1 LIMIT 1`,
  );
  return docIds.every((id) => stmt.get(id) !== undefined);
}

// ── annotation firewall helpers ────────────────────────────────────────

function docExists(db: Db, id: string): boolean {
  return (
    db.prepare<[string], { id: string }>("SELECT id FROM documents WHERE id = ?").get(id) !==
    undefined
  );
}

interface EvidenceDoc {
  content: string;
  contentHash: string;
  generated: boolean;
}
function fetchEvidenceDoc(db: Db, id: string): EvidenceDoc | null {
  const sourceColumn = db
    .prepare<[], { name: string }>("PRAGMA table_info(documents)")
    .all()
    .some((column) => column.name === "source_id")
    ? "source_id"
    : "NULL";
  const row = db
    .prepare<
      [string],
      {
        content: string | null;
        content_hash: string;
        document_type: string | null;
        source_id: string | null;
      }
    >(
      `SELECT content, content_hash, json_extract(metadata, '$.documentType') AS document_type, ${sourceColumn} AS source_id FROM documents WHERE id = ?`,
    )
    .get(id);
  return row === undefined
    ? null
    : {
        content: row.content ?? "",
        contentHash: row.content_hash,
        generated:
          [OPEN_LOOP_DOCUMENT_TYPE, KNOWLEDGE_DOCUMENT_TYPE].includes(row.document_type ?? "") ||
          [OPEN_LOOP_SOURCE_ID, KNOWLEDGE_SOURCE_ID].includes(row.source_id ?? ""),
      };
}

/** The evidence firewall's quote test, memoized on the doc's content hash so a
 *  run's repeated checks against one evidence doc normalize its body once. */
function quoteInEvidence(doc: EvidenceDoc, quote: string): boolean {
  return !doc.generated && containsNormalizedForContent(doc.contentHash, doc.content, quote);
}

/** Grounding atoms beyond the primary pair — capped so a claim stays reviewable. */
const additionalEvidenceField = z
  .array(
    z
      .object({
        docId: z.string().min(1).describe("Document id of the further grounding atom."),
        quote: z
          .string()
          .min(12)
          .max(500)
          .describe(
            "A VERBATIM quote (a substantive span) from that document supporting the claim.",
          ),
      })
      .strict(),
  )
  .max(8);

/**
 * The per-item cheap-SQL teeth over an annotation's ADDITIONAL evidence
 * atoms — every item is checked before any verifier call: the document must
 * exist, must be a real source (never a generated synthesis
 * mirror), and the quote must appear in it (`quoteInEvidence`). A refusal
 * names the failing item's index so the model can fix exactly that atom and
 * re-call. Returns null when every item passes.
 */
function vetAdditionalEvidence(
  db: Db,
  items: readonly AnnotationEvidenceInput[],
): ToolResult | null {
  for (const [i, item] of items.entries()) {
    const doc = fetchEvidenceDoc(db, item.docId);
    if (doc === null) {
      return {
        kind: "error",
        code: "not_found",
        message: `additionalEvidence[${i}]: document ${item.docId} does not exist — cite a real document id`,
      };
    }
    if (doc.generated) {
      return {
        kind: "error",
        code: "invalid_evidence",
        message: `additionalEvidence[${i}]: ${item.docId} is a generated synthesis record, not a source document — ground the observation on the original source`,
      };
    }
    if (!quoteInEvidence(doc, item.quote)) {
      return {
        kind: "error",
        code: "evidence_not_found",
        message: `additionalEvidence[${i}]: the quote was not found in ${item.docId} — quote the source text exactly (whitespace-insensitive; curly/straight quotes and dash variants are also normalized — other punctuation must match the source exactly)`,
      };
    }
  }
  return null;
}

/** Call only after the source-read and quote-membership firewalls pass. */
function annotationGateEvidence(
  db: Db,
  atoms: readonly { docId: string; quote: string }[],
  structured = true,
): string {
  return (structured ? annotationEvidenceFrame : jointContextualEvidence)(
    atoms.map((atom) => ({
      quote: atom.quote,
      source: fetchEvidenceDoc(db, atom.docId)?.content ?? "",
    })),
  );
}

// Fallbacks when the deps carry no config-derived values — mirror
// `BRAIN_DEFAULTS.annotations` in `../config.ts`.
const DEFAULT_BASIS_CEILINGS = { quoted: 0.9, inferred: 0.7, synthesized: 0.55 } as const;
const DEFAULT_CONFIDENCE_FLOOR = 0.25;

/**
 * Two-stage confidence clamp: the per-basis ceiling first (the further a
 * claim reasons from its evidence, the lower it may go), then the global
 * hard cap. Returns the clamped value plus the effective ceiling so a capped
 * write can report `confidenceCappedTo`.
 */
function clampConfidence(
  deps: Pick<CognitionToolDeps, "annotationBasisCeilings" | "annotationConfidenceCeiling">,
  basis: AnnotationClaimBasis,
  reported: number,
): { confidence: number; ceiling: number } {
  const ceiling = Math.min(
    (deps.annotationBasisCeilings ?? DEFAULT_BASIS_CEILINGS)[basis],
    deps.annotationConfidenceCeiling ?? 0.9,
  );
  return { confidence: Math.min(reported, ceiling), ceiling };
}

/** The abstention floor's re-askable refusal on a too-weak NEW claim. */
function insufficientConfidence(confidence: number, floor: number): ToolResult {
  return {
    kind: "error",
    code: "insufficient_confidence_to_persist",
    message:
      `confidence ${confidence.toFixed(2)} (after the claim-basis ceiling) is below the ` +
      `persistence floor ${floor.toFixed(2)} — gather corroborating evidence that supports ` +
      `a stronger claim, or drop the claim entirely; a prior this weak misleads more than ` +
      `it helps`,
  };
}

/** The floor's revise-side refusal: a claim weakened this far is a retract, not an edit. */
function retractInsteadOfWeakRevise(confidence: number, floor: number): ToolResult {
  return {
    kind: "error",
    code: "insufficient_confidence_to_persist",
    message:
      `this revise would leave confidence ${confidence.toFixed(2)} below the persistence ` +
      `floor ${floor.toFixed(2)} — a claim that weak should not be kept as a prior: retract ` +
      `the annotation instead`,
  };
}

/**
 * Outcome of the entailment gate (the final firewall over annotation writes).
 * `pass` carries the verification stamp to persist: `verified` when the
 * verifier judged entailment, `unverified` when a configured verifier was
 * unavailable (fail-open; the re-verification sweep picks the row up), and
 * null when no verifier is configured — the write is then byte-for-byte what
 * it was before the gate existed. `refused` blocks the write. A pass never
 * stamps `failed` (that state exists only as a later re-check's verdict), so
 * the state union here is the narrower write-time one.
 */
type EntailmentGateOutcome =
  | {
      kind: "pass";
      state: Extract<AnnotationVerificationState, "verified" | "unverified"> | null;
      verifiedAt: number | null;
    }
  | {
      kind: "refused";
      verdict: "neutral" | "contradiction";
      assertions?: ReturnType<typeof annotationEntailmentFailures>;
    };

/**
 * The entailment gate: after `quoteInEvidence` proves the
 * quote is really in the cited document, judge whether the quote actually
 * ESTABLISHES the claim at its stated modality. Refuses on a neutral or
 * contradiction verdict; fails open (persist as `unverified`) when the
 * verifier resolves but cannot answer — availability of a model must never
 * decide whether the agent can remember.
 */
async function runEntailmentGate(
  deps: Pick<CognitionToolDeps, "getEntailmentVerifier" | "log">,
  input: { claim: string; evidence: string; context?: string; assessment?: "annotation_atomic" },
  now: number,
  callerSignal?: AbortSignal,
): Promise<EntailmentGateOutcome> {
  callerSignal?.throwIfAborted();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(ENTAILMENT_GATE_TIMEOUT_MS)])
    : AbortSignal.timeout(ENTAILMENT_GATE_TIMEOUT_MS);
  if (!deps.getEntailmentVerifier) return { kind: "pass", state: null, verifiedAt: null };
  let verifier: EntailCapability | null = null;
  let resolveFailed = false;
  try {
    verifier = await raceAbort(deps.getEntailmentVerifier(signal), signal);
  } catch (err) {
    callerSignal?.throwIfAborted();
    resolveFailed = true;
    deps.log.warn(
      `entailment verifier resolution failed — marking write unverified: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (verifier === null) {
    // Resolver threw ⇒ a verifier is configured but unavailable → fail open.
    // Resolved to null ⇒ the role is unset → no gate, no stamp.
    return resolveFailed
      ? { kind: "pass", state: "unverified", verifiedAt: null }
      : { kind: "pass", state: null, verifiedAt: null };
  }
  try {
    // Gate-level deadline: the transports bound their own requests unevenly
    // (HTTP tightly, others less so), and one hung verifier call must not
    // stall the annotation write — and the whole run behind it. A timeout
    // fails open exactly like a thrown verify. (The local GGUF path also
    // generates on the main event loop — see llama-cpp.ts — so a local judge
    // trades a few seconds of gateway latency per write until the local
    // models move off-thread.)
    const verdict = await raceAbort(verifier.verify({ ...input, signal }), signal);
    if (verdict.label === "entailment") {
      return { kind: "pass", state: "verified", verifiedAt: now };
    }
    return {
      kind: "refused",
      verdict: verdict.label,
      ...(input.assessment === "annotation_atomic" && verdict.raw
        ? { assertions: annotationEntailmentFailures(verdict.raw, input.claim) }
        : {}),
    };
  } catch (err) {
    callerSignal?.throwIfAborted();
    deps.log.warn(
      `entailment verification failed — marking write unverified: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "pass", state: "unverified", verifiedAt: null };
  }
}

/** Hard ceiling on one entailment check; beyond it the gate fails open. */
const ENTAILMENT_GATE_TIMEOUT_MS = 45_000;

/** Capture privacy ancestry before evidence reads or asynchronous verification. */
function captureRecordCheckPayload(
  deps: Pick<CognitionToolDeps, "db" | "checkRecord">,
  sourceIds: readonly string[],
) {
  if (!deps.checkRecord || !(deps.checkRecord.needsDocumentContext?.() ?? true)) return undefined;
  return (
    captureDecisionPayloadSubjects(
      deps.db,
      { sourceIds },
      decisionPayloadErasureGeneration(deps.db),
    ) ?? undefined
  );
}

/** Ask the record check; return its refusal instead of writing a dropped record. */
async function recordCheckRefusal(
  deps: Pick<CognitionToolDeps, "checkRecord">,
  input: RecordCheckInput,
  signal: AbortSignal | undefined,
  onAssessment?: (assessment: { policy: string; decisionId: string }) => void,
): Promise<ToolResult | null> {
  if (!deps.checkRecord) return null;
  const outcome = await deps.checkRecord(input, signal);
  if (outcome.save) {
    if (outcome.assessment) onAssessment?.(outcome.assessment);
    return null;
  }
  if (outcome.questionId === "profile_distillation")
    return ok("record.not_saved", {
      reason: `Person fact is not sufficiently distilled or distinct in the final profile (profile_distillation score ${outcome.score.toFixed(2)}, below ${outcome.threshold})`,
      guidance:
        "Read the complete current profile. Distill the useful person-level meaning and consolidate overlapping facts with annotate_person supersedes:[ids], preserving useful supported scope. Keep corroborating source details in evidence instead of enumerating them in profile prose. Preserve historical uncertainty; do not invent continuous dates or current status. Existing facts are unchanged. Submit a substantively corrected profile, not the same inventory reworded.",
    });
  if (outcome.questionId === "deadline_support")
    return ok("record.not_saved", {
      reason: `Outcome deadline lacks support for this exact action and temporal role (deadline_support score ${outcome.score.toFixed(2)}, below ${outcome.threshold})`,
      guidance:
        "Keep a useful outcome, but clear its unsupported deadline with null or retrieve evidence for the actual action due time. Preserve source precision and conditions. Expected events and monitoring times are not action deadlines; schedule review separately. Submit a substantively corrected proposal, not the same date reworded.",
    });
  if (outcome.questionId === "transition_integrity")
    return ok("record.not_saved", {
      reason: `Outcome revision has not preserved or justified changing the supported action, progress or scope (transition_integrity score ${outcome.score.toFixed(2)}, below ${outcome.threshold})`,
      guidance:
        "Existing content is unchanged. Re-read the current outcome and its original supporting evidence, reconcile the missing action or progress, then submit a substantively corrected revision. Do not repeat the same proposal or merely rephrase it to bypass this check.",
    });
  return ok("record.not_saved", {
    reason:
      (input.record.type === "doc-fact"
        ? "judged not to add sufficient value beyond the document source"
        : input.record.type === "person-fact"
          ? "judged not to add useful person-specific profile context"
          : input.record.type === "outcome"
            ? "judged not to establish this actor, outcome or status from the evidence"
            : "judged not to belong in the owner's life memory") +
      ` (${outcome.questionId ? `${outcome.questionId} ` : ""}score ${outcome.score.toFixed(2)}, ` +
      `below ${outcome.threshold})`,
    guidance:
      "Not saved. Do not retry or reword this record; continue with anything else the " +
      "datum warrants.",
  });
}

/** The re-askable refusal the annotation tools return on a failed entailment check. */
function entailmentRefusal(
  verdict: "neutral" | "contradiction",
  assertions?: ReturnType<typeof annotationEntailmentFailures>,
): ToolResult {
  return {
    kind: "error",
    code: "evidence_does_not_entail_claim",
    message:
      `the evidence quote does not establish the claim at its stated modality ` +
      `(verifier verdict: ${verdict}) — weaken the claim to what the quote actually ` +
      `supports, or cite stronger evidence that establishes the full claim` +
      (assertions?.length
        ? `. Unsupported candidate assertions: ${JSON.stringify(assertions)}. Revise those assertions while preserving supported meaning; do not repeat the unchanged proposal.`
        : ""),
  };
}

/**
 * The temporal-annotation conditional teeth: when a write declares its grounding
 * (`evidence: {docId, quote}`), the quote must appear in that document and
 * the entailment gate must find it establishes the entry's sentence. Cheap
 * checks first, gate last; a write without evidence is never gated (pure
 * scheduling / self-sourced entries stay legal). Returns null on pass — the
 * teeth are write-time only; no verification stamp is stored.
 */
function vetTemporalSourceEvidence(
  db: Db,
  evidence: { docId: string; quote: string },
): ToolResult | null {
  if (!isKnowledgeEvidenceReadable(db, evidence.docId))
    return notFound("evidence document", evidence.docId);
  const doc = fetchEvidenceDoc(db, evidence.docId);
  if (doc === null) return notFound("evidence document", evidence.docId);
  if (doc.generated)
    return {
      kind: "error",
      code: "invalid_evidence",
      message: "Ground entries in original source evidence, not a generated synthesis record",
    };
  if (!quoteInEvidence(doc, evidence.quote)) {
    return {
      kind: "error",
      code: "evidence_not_found",
      message:
        "evidence.quote was not found in evidence.docId — quote the source text " +
        "exactly (whitespace-insensitive; curly/straight quotes and dash variants " +
        "are also normalized — other punctuation must match the source exactly); " +
        "a document-derived entry must rest on what the document actually says",
    };
  }
  return null;
}

async function vetTemporalAnnotationEvidence(
  deps: Pick<CognitionToolDeps, "db" | "getEntailmentVerifier" | "log">,
  evidence: { docId: string; quote: string },
  sentence: string,
  now: number,
  signal?: AbortSignal,
): Promise<ToolResult | null> {
  signal?.throwIfAborted();
  const refusal = vetTemporalSourceEvidence(deps.db, evidence);
  if (refusal) return refusal;
  const revision = readKnowledgeSourceRevision(deps.db, evidence.docId);
  const gate = await runEntailmentGate(
    deps,
    { claim: sentence, evidence: evidence.quote },
    now,
    signal,
  );
  signal?.throwIfAborted();
  if (
    !isKnowledgeEvidenceReadable(deps.db, evidence.docId) ||
    readKnowledgeSourceRevision(deps.db, evidence.docId) !== revision
  )
    return {
      kind: "error",
      code: "revision_conflict",
      message:
        "Temporal source evidence changed during assessment; reread and reconcile before retrying.",
    };
  if (gate.kind === "refused") {
    return {
      kind: "error",
      code: "evidence_does_not_entail_claim",
      message:
        `the evidence quote does not establish this entry's sentence (verifier ` +
        `verdict: ${gate.verdict}) — reword the sentence to what the quote actually ` +
        `supports, or cite stronger evidence`,
    };
  }
  return null;
}

/**
 * Ask the entailment verifier whether the quoted evidence establishes the
 * claim a task change rests on. Each quote must first be found in a
 * readable source document; a quote that is not, a verifier that is not
 * configured or cannot answer, all come back without an entailment verdict,
 * which leaves the change a proposal.
 */
async function verifyTaskEvidence(
  deps: Pick<CognitionToolDeps, "db" | "getEntailmentVerifier" | "log" | "clock">,
  quotes: readonly { docId: string; quote: string }[],
  claim: string,
  signal?: AbortSignal,
): Promise<{ verdict: TaskEvidenceVerdict; why?: string }> {
  for (const quote of quotes) {
    const refusal = vetTemporalSourceEvidence(deps.db, quote);
    if (refusal)
      return {
        verdict: "unavailable",
        why: `a quote could not be checked against ${quote.docId}: ${refusal.kind === "error" ? refusal.message : "invalid evidence"}`,
      };
  }
  const evidence =
    quotes.length === 1
      ? quotes[0]!.quote
      : quotes.map((q, i) => `[${i + 1}] ${q.quote}`).join("\n");
  const gate = await runEntailmentGate(deps, { claim, evidence }, deps.clock(), signal);
  if (gate.kind === "refused") return { verdict: gate.verdict };
  return gate.state === "verified" ? { verdict: "entailment" } : { verdict: "unavailable" };
}

/**
 * Structured error on a bad `supersedes` target: unknown in this store,
 * already dead, or naming a different subject. Re-askable — the message says
 * what to fix.
 */
function invalidSupersede(reason: string): ToolResult {
  return {
    kind: "error",
    code: "invalid_supersede",
    message:
      `${reason} — supersedes must name a LIVE annotation in this store about the ` +
      `SAME subject (annotation_search the subject to find it), or be omitted`,
  };
}

/**
 * The pure supersede tools' variant of {@link invalidSupersede}: both
 * arguments are mandatory, so the re-ask guidance drops "or be omitted".
 */
function invalidPureSupersede(reason: string): ToolResult {
  return {
    kind: "error",
    code: "invalid_supersede",
    message:
      `${reason} — id and supersededBy must name two DISTINCT LIVE annotations in this ` +
      `store about the SAME subject (annotation_search the subject to find them)`,
  };
}

/**
 * Cap on the standing candidates a conflict refusal returns to the model.
 * Matching runs in SQL over ALL live rows on the subject (see the
 * same-claimType probe functions), so this bounds only the echo, never
 * which rows can trigger a refusal.
 */
const CONFLICT_PROBE_LIMIT = 100;

/** Re-ask guidance on a refused CREATE (a standing same-claimType belief exists). */
const CREATE_CONFLICT_GUIDANCE =
  "Not created. These live annotations already make this kind of claim about this " +
  "subject. If yours is the SAME claim, do not duplicate it — leave it standing (or " +
  "revise it if only the wording should change). If your claim UPDATES or CONTRADICTS " +
  "one, re-call with supersedes:<thatId> to replace it. If it is a genuinely different " +
  "aspect of the subject, re-call with a more specific claimType.";

/** Re-ask guidance on a refused REVISE whose claimType change would collide. */
function reviseConflictGuidance(supersedeTool: string): string {
  return (
    "Not revised. Changing this annotation's claimType would land it beside these live " +
    "annotations that already make that kind of claim about the same subject. If the " +
    "revised claim replaces one of them, first retire it with " +
    `${supersedeTool} (id: <standing id>, supersededBy: <this annotation's id>), then ` +
    "re-run the revise. If it is a genuinely different aspect, pick a more specific claimType."
  );
}

/**
 * The one-belief-invariant refusal: a same-subject, same-claimType live
 * annotation already stands in the way of a create or a claimType-changing
 * revise. A structured
 * `ok` (not an error) carrying the standing candidates plus re-ask guidance.
 */
function annotationConflictRefusal(
  resultType: string,
  candidates: ReadonlyArray<{
    id: string;
    claimType: string;
    claimText: string;
    confidence: number;
    claimBasis: AnnotationClaimBasis;
  }>,
  guidance: string,
): ToolResult {
  return ok(resultType, {
    candidates: candidates.map((c) => ({
      id: c.id,
      claimType: c.claimType,
      claimText: c.claimText,
      confidence: c.confidence,
      claimBasis: c.claimBasis,
    })),
    guidance,
  });
}

/**
 * Guidance echoed when a supersede's retire half was lost to a concurrent
 * write (the target died between the tool's validation read and the
 * serialized write) — the agent must re-read the subject's live rows and
 * reconcile against what actually stands, instead of trusting the retire.
 */
const SUPERSEDE_LOST_GUIDANCE =
  "the supersede target was already retired by a concurrent write — re-run " +
  "annotation_search on this subject and reconcile against the live annotations";

// ── projections the model reads ────────────────────────────────────────────

/** Compact summaries of the open observations attached to a loop. */
function observationSummariesForLoop(db: Db, loopId: string) {
  return findOpenObservationsForLoops(db, [loopId]).map((o) => ({
    id: o.id,
    summary: o.summary,
    state: o.state,
  }));
}

/**
 * Compact loop→temporal-annotation backlink hint — meaning + when, so the
 * agent sees a loop's deadlines/events inline without a second fetch. Mirrors
 * the overlap-candidate shape (id/when/precision/kind/sentence).
 */
function loopTemporalAnnotationHint(e: TemporalAnnotation): unknown {
  return {
    id: e.id,
    when: e.canonical,
    precision: e.precision,
    kind: e.kind,
    sentence: e.sentence,
  };
}

function loopToModelJson(
  db: Db,
  loop: OpenLoopRow,
  opts: {
    ledger: boolean;
    matchedBy?: readonly string[];
    temporalAnnotations?: boolean;
  },
): unknown {
  return {
    id: loop.id,
    createdByRun: loop.createdByRun,
    state: loop.state,
    confidence: loop.confidence,
    importance: loop.importance,
    title: loop.title,
    description: loop.description,
    deadline: loop.deadline,
    // The user's own task: its state, title, description and deadline change
    // only by proposal (open_loop_update records one for the user to confirm).
    userTask: isOwnedTask(loop),
    // The user chose not to see this suggestion among their tasks; the loop
    // is still the Brain's to maintain, and must not be re-created to put it
    // back in front of them.
    ...(loop.ignored ? { ignoredByUser: true } : {}),
    ...(loop.scheduledFor ? { scheduledFor: loop.scheduledFor } : {}),
    ...(loop.proposedChange
      ? { pendingProposal: { kind: loop.proposedChange.kind, reason: loop.proposedChange.reason } }
      : {}),
    actors: loop.actors,
    involved: loop.involved,
    docs: loop.docs,
    blockedBy: loop.blockedBy,
    createdAt: msToIso(loop.createdAt),
    lastUpdate: msToIso(loop.lastUpdate),
    attachedObservations: observationSummariesForLoop(db, loop.id),
    // Linked temporal annotations (deadlines/events) via the annotation-loop
    // join. Only on read tools (fetch/search); create/update omit it to keep
    // their echoes minimal.
    ...(opts.temporalAnnotations
      ? {
          temporalAnnotations: listTemporalAnnotationsForLoop(db, loop.id).map(
            loopTemporalAnnotationHint,
          ),
        }
      : {}),
    // How reconcile surfaced this loop — identity tags (`person:…`,
    // `linked-doc:…`, `deadline-proximity`), `lexical`, and/or `semantic`,
    // merged when it matched several ways. Absent when not a search result.
    ...(opts.matchedBy && opts.matchedBy.length > 0 ? { matchedBy: [...opts.matchedBy] } : {}),
    ...(opts.ledger
      ? {
          ledger: listOpenLoopLedger(db, loop.id).map((e) => ({
            at: msToIso(e.at),
            runId: e.runId,
            note: e.note,
          })),
        }
      : {}),
  };
}

/**
 * Terminal open-loop states — the loop is resolved and needs no further
 * agent-scheduled checks. Transitioning into one cascade-cancels the
 * loop's never-claimed `schedule_agent_run` checks. `snoozed` is
 * deliberately excluded: a snooze is a "revisit later" deferral, so its
 * scheduled check is exactly what should still fire.
 */
const RESOLVED_OPEN_LOOP_STATES: ReadonlySet<OpenLoopState> = new Set(["done", "dismissed"]);

// ── the tools ──────────────────────────────────────────────────────────────

export function buildCognitionOwnTools(deps: CognitionToolDeps): ToolHandle[] {
  const { db, writeGate, mirror, clock, runId, log } = deps;
  async function checkOutcome(
    id: string,
    previous: OutcomeProposal | null,
    proposed: OutcomeProposal,
    documentIds: readonly string[],
    signal?: AbortSignal,
    writeFence?: OutcomeWriteFence,
    priorityDocumentIds?: readonly string[],
  ): Promise<ToolResult | null> {
    if (!deps.checkRecord) return null;
    if (!documentIds.length)
      return {
        kind: "error",
        code: "outcome_evidence_required",
        message:
          "An autonomous outcome assertion requires original source documents. Read and cite supporting evidence before creating, reviving, or materially changing this outcome.",
      };
    if (!(deps.checkRecord.needsDocumentContext?.() ?? true)) return null;
    const prepared = prepareOutcomeRecordContext(db, {
      outcomeId: id,
      documentIds,
      priorityDocumentIds: [...(priorityDocumentIds ?? documentIds), ...(deps.seedDocIds ?? [])],
      previous,
      proposed,
      ...(previous && db.prepare("SELECT 1 FROM knowledge_nodes WHERE id=?").get(id)
        ? { ownerId: id }
        : {}),
      now: clock(),
    });
    if (writeFence && prepared?.outcomeFence) {
      writeFence.actorRoles = prepared.outcomeFence.actorRoles;
      // Keep the pre-judge owner/source snapshot; add ancestry read by the judge.
      writeFence.sources = [
        ...new Map([
          ...prepared.outcomeFence.sources.map((source) => [source.id, source] as const),
          ...writeFence.sources.map((source) => [source.id, source] as const),
        ]).values(),
      ];
    }
    const reviewBatchId = outcomeReviewBatch(db, id, runId);
    return recordCheckRefusal(
      deps,
      {
        recordId: id,
        documentId: prepared?.documentId ?? documentIds[0]!,
        record: {
          type: "outcome",
          kind: previous ? "revision" : "creation",
          text: JSON.stringify(proposed),
        },
        ...(prepared
          ? { outcomeContext: prepared.context, payloadCapture: prepared.payloadCapture }
          : {}),
      },
      signal,
      writeFence
        ? (assessment) => {
            writeFence.assessment = makeOutcomeAssessment(
              assessment.policy,
              proposed,
              writeFence.sources,
              assessment.decisionId,
              reviewBatchId,
              writeFence.actorRoles,
              prepared?.context.sources.map((source) => source.id),
            );
          }
        : undefined,
    );
  }
  const idGen = deps.idGen ?? (() => randomUUID());

  // Loops this run created or updated — the per-run tracking that lets
  // `schedule_agent_run` auto-attach a `loopId` when the run is
  // unambiguously about a single loop (see the tool's invoke). Scoped to
  // this toolset build (one claimed run), so it never leaks across runs.
  const mutatedLoopIds = new Set<string>();

  /**
   * The single open loop this run is unambiguously scoped to, or undefined
   * when that scope is ambiguous. A run is scoped to one loop when the
   * union of {loops it created/updated this run} ∪ {the loop that triggered
   * it} has exactly one member. 0 members (touched nothing, un-scoped run)
   * or >1 (touched several loops) is ambiguous → undefined, and the
   * prompt-text fallback in `cancelScheduledRunsForLoop` covers the cascade.
   */
  function unambiguousLoopScope(): string | undefined {
    const candidates = new Set(mutatedLoopIds);
    if (deps.triggeringLoopId !== undefined) candidates.add(deps.triggeringLoopId);
    return candidates.size === 1 ? [...candidates][0] : undefined;
  }

  function selectDeclaredDependencies(
    declared: readonly ConsumedAnnotationRef[],
  ): { ok: true; refs: ConsumedAnnotationRef[] } | { ok: false; result: ToolResult } {
    const selected =
      deps.consumption?.select(declared) ??
      (declared.length === 0
        ? { ok: true as const, refs: [] }
        : { ok: false as const, unseen: [...declared] });
    if (!selected.ok) {
      return {
        ok: false,
        result: {
          kind: "error",
          code: "invalid_args",
          message:
            "annotationDependencies must name only priors surfaced earlier in this run; unseen: " +
            selected.unseen.map((ref) => `${ref.store}:${ref.annotationId}`).join(", "),
        },
      };
    }
    return selected;
  }

  function dependencyContext(refs: readonly ConsumedAnnotationRef[]) {
    return {
      priors: refs.map((ref) => ({
        priorStore: ref.store,
        priorAnnotationId: ref.annotationId,
      })),
      runId,
    } as const;
  }

  function deadDependenciesResult(
    dead: readonly { priorStore: "doc" | "person"; priorAnnotationId: string }[],
  ): ToolResult {
    return {
      kind: "error",
      code: "invalid_args",
      message:
        "annotationDependencies must remain live at write time; dead or missing: " +
        dead.map((ref) => `${ref.priorStore}:${ref.priorAnnotationId}`).join(", "),
    };
  }

  // ---- open_loop_search ----
  const openLoopSearchSchema = z
    .object({
      query: z.string().min(1).describe("Free-text query over the open-loop store."),
      limit: z.number().int().min(1).max(25).optional().describe("Max loops returned (default 8)."),
    })
    .strict();
  const openLoopSearch: ToolHandle = {
    name: "open_loop_search",
    description:
      "Search the tracked open loops. Beyond full-text + semantic matching over " +
      "their titles, descriptions, and history, this also surfaces loops that " +
      "share the current datum's people, thread, linked documents, or a nearby " +
      "deadline — so a later message reconciles onto its loop even when the " +
      "wording is different. ALWAYS reconcile through this before creating a " +
      "loop: if a matching loop exists, update or resolve it instead of minting " +
      "a duplicate. Each result carries its current fields, attached-observation " +
      "summaries, and a `matchedBy` explaining how it matched. The result " +
      "also includes a `retired` list of past loops with the same wording " +
      "that were already resolved or removed — with their outcome, cadence, " +
      "and recurrence count — so a commitment that keeps coming back is " +
      "recognised as a known recurrence.",
    schema: openLoopSearchSchema,
    summarize: (args) =>
      typeof (args as { query?: unknown })?.query === "string"
        ? (args as { query: string }).query
        : undefined,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = openLoopSearchSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const limit = parsed.data.limit ?? 8;

      // Merge the reconcile signals in priority order —
      //   strong identity → lexical → deadline-only identity → semantic —
      // deduping by loop id: the FIRST signal to surface a loop fixes its
      // position, and later signals only merge their `matchedBy` tag onto it.
      //
      //   1. STRONG IDENTITY: loops sharing the datum's people, thread, or
      //      linked docs — real-world matches the lexical/semantic passes
      //      miss when the wording differs.
      //   2. LEXICAL overlay (tables-as-truth): the pipeline reads index.db
      //      through a coarsely-refreshed snapshot and its chunk/embedding
      //      writes land asynchronously, so a loop created or updated moments
      //      ago — typically by the immediately preceding run — can be
      //      invisible to semantic search; the direct-table lexical scan
      //      never misses it.
      //   3. DEADLINE-ONLY IDENTITY: deadline proximity with no shared
      //      person/thread/doc is the weakest signal — on a busy day it
      //      matches much of the loop store, and ranked above lexical it can
      //      crowd the query's own marker match out of the limit entirely
      //      (a late resolution datum then never finds its buried loop).
      //   4. SEMANTIC pipeline: the remainder.
      const seen = new Map<string, { loop: OpenLoopRow; tags: string[] }>();
      const order: string[] = [];
      const surface = (loopId: string, loop: OpenLoopRow, tags: readonly string[]): void => {
        const existing = seen.get(loopId);
        if (existing) {
          for (const t of tags) if (!existing.tags.includes(t)) existing.tags.push(t);
          return;
        }
        seen.set(loopId, { loop, tags: [...tags] });
        order.push(loopId);
      };

      const seedDocIds = deps.seedDocIds ?? [];
      let deadlineOnly: IdentityCandidate[] = [];
      if (seedDocIds.length > 0) {
        const identity = searchOpenLoopsByIdentity(db, {
          seedDocIds,
          now: clock(),
          limit,
          // 0 disables the deadline signal when the config knob isn't wired
          // (direct unit tests); the production runtime always supplies it.
          deadlineWindowMs: deps.reconcileDeadlineWindowMs ?? 0,
          selfPersonId: fetchSelfPersonId(db),
          ...(deps.reconcileNeighborFanout !== undefined
            ? { neighborFanout: deps.reconcileNeighborFanout }
            : {}),
        });
        deadlineOnly = identity.filter((c) =>
          c.matchedBy.every((tag) => tag === "deadline-proximity"),
        );
        for (const c of identity) {
          if (deadlineOnly.includes(c)) continue;
          surface(c.loop.id, c.loop, c.matchedBy);
        }
      }

      const overlay = searchOpenLoopsLexical(db, parsed.data.query, { limit });
      for (const loop of overlay) surface(loop.id, loop, ["lexical"]);

      for (const c of deadlineOnly) surface(c.loop.id, c.loop, c.matchedBy);

      const res = await deps.searchPort.search({
        query: parsed.data.query,
        limit,
        // The explicit type filter is the hidden-source bypass: ordinary
        // (unscoped) search never sees open-loop documents.
        filters: { documentTypes: ["open-loop"] },
      });
      const externalIdStmt = db.prepare<[string], { external_id: string }>(
        "SELECT external_id FROM documents WHERE id = ?",
      );
      for (const ref of res.results) {
        const loopId = externalIdStmt.get(ref.documentId)?.external_id;
        if (!loopId) continue;
        if (seen.has(loopId)) {
          surface(loopId, seen.get(loopId)!.loop, ["semantic"]);
          continue;
        }
        const loop = getOpenLoop(db, loopId);
        if (!loop) continue; // mirror lagging a concurrent delete
        surface(loopId, loop, ["semantic"]);
      }

      const loops = order.slice(0, limit).map((id) => {
        const e = seen.get(id)!;
        return loopToModelJson(db, e.loop, {
          ledger: false,
          matchedBy: e.tags,
          temporalAnnotations: true,
        });
      });

      // Consolidation surface: lexical matches from the append-only store of
      // resolved/removed loops, so the agent recognises a recurring
      // commitment (with its cadence + recurrence count) as a known
      // recurrence rather than minting yet another fresh loop.
      const retired = searchRetiredLoopsLexical(db, parsed.data.query, { limit: 5 }).map((r) => ({
        title: r.title,
        outcome: r.outcome,
        retiredAt: msToIso(r.retiredAt),
        cadenceDays: r.cadenceDays,
        recurrenceCount: r.recurrenceCount,
      }));

      return ok("open_loop.search_results", { query: parsed.data.query, loops, retired });
    },
  };

  // ---- open_loop_fetch ----
  const openLoopFetchSchema = z
    .object({ id: z.string().min(1).describe("Open-loop id.") })
    .strict();
  const openLoopFetch: ToolHandle = {
    name: "open_loop_fetch",
    description:
      "Fetch one open loop's full JSON — every field plus the complete " +
      "run-stamped ledger history and attached-observation summaries.",
    schema: openLoopFetchSchema,
    // eslint-disable-next-line @typescript-eslint/require-await -- sync sqlite reads behind the async ToolHandle contract
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = openLoopFetchSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const loop = getOpenLoop(db, parsed.data.id);
      if (!loop) return notFound("open loop", parsed.data.id);
      return ok(
        "open_loop.fetched",
        loopToModelJson(db, loop, { ledger: true, temporalAnnotations: true }),
      );
    },
  };

  // ---- open_loop_create ----
  const openLoopCreateSchema = z
    .object({
      title: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "Short tracked-outcome title matching the supported action stage, responsible actor and conditions in the description; preserve waiting or uncertain status rather than implying an unconditional action.",
        ),
      description: z
        .string()
        .max(2000)
        .optional()
        .describe("<100-word summary of the loop's current state."),
      confidence: fraction.describe("Confidence the loop is correct (0-1)."),
      importance: fraction.describe("Likelihood this matters to the user (0-1)."),
      deadline: z
        .unknown()
        .optional()
        .describe(
          'Optional action due boundary, supported for this exact action and actor; an expected event window is not an action deadline. Recommended shape: {"type": "any_time"|"by"|"approximate"|"on_day", "date"?: "YYYY-MM-DD", "note"?: string} — Preserve source precision and modality: estimates use type "approximate" with a note containing the source window and event/date anchor, and date only when supported. Do not invent HH:mm, midnight or end-of-day precision. A review time is not the deadline.',
        ),
      actors: idList
        .optional()
        .describe(
          "People expected to act — person ids (from lookup_people or the " +
            "datum's people). A bare email is accepted and resolved to its " +
            "person; refs matching no known person are dropped.",
        ),
      involved: idList
        .optional()
        .describe(
          "People impacted or with a stake — person ids (or emails, " + "resolved like `actors`).",
        ),
      docs: idList.optional().describe("Document ids of relevant source material."),
      blockedBy: idList.optional().describe("Open-loop ids that must resolve first."),
      annotationDependencies: annotationDependenciesField,
    })
    .strict();
  const openLoopCreate: ToolHandle = {
    name: "open_loop_create",
    description:
      "Create a new tracked open loop. Reconcile FIRST (open_loop_search): " +
      "prefer updating or resolving an existing loop over creating a " +
      "duplicate — but keep one loop per distinct obligation: two different " +
      "asks are two loops, even from the same person for the same trip, " +
      "while one request with a single settlement normally stays one loop. " +
      "Only separately closable material sub-outcomes warrant decomposition; " +
      "when a meaningful parent remains, read both nodes, link child to parent " +
      "with knowledge_link part_of, and make the parent's remaining scope explicit. " +
      "Links provide neither evidence nor automatic closure. The loop is " +
      "stamped with this run's id. Require evidence of a currently actionable " +
      "outcome for the user: a historical status or unsuccessful attempt alone " +
      "does not establish a current obligation. Missing later indexed evidence " +
      "proves neither resolution nor non-resolution; preserve unknown current status.",
    schema: openLoopCreateSchema,
    mutates: true,
    summarize: (args) => (args as { title?: string })?.title,
    async invoke(rawArgs, ctx): Promise<ToolResult> {
      const parsed = openLoopCreateSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      const dependencies = selectDeclaredDependencies(a.annotationDependencies);
      if (!dependencies.ok) return dependencies.result;
      const docs = partitionDocIds(db, a.docs ?? []);
      const blockedBy = partitionLoopIds(db, a.blockedBy ?? []);
      const actors = partitionPersonRefs(db, a.actors ?? []);
      const involved = partitionPersonRefs(db, a.involved ?? []);
      const id = `loop_${idGen()}`;
      const outcomeFence = captureOutcomeWriteFence(db, id, []);
      const refused = await checkOutcome(
        id,
        null,
        {
          title: a.title,
          description: a.description ?? "",
          state: "open",
          deadline: a.deadline ?? null,
          actors: actors.known,
        },
        docs.known,
        ctx.abortSignal,
        outcomeFence,
      );
      if (refused) return refused;
      const persisted = await writeGate.createOpenLoop(
        {
          id,
          createdByRun: runId,
          title: a.title,
          ...(a.description !== undefined ? { description: a.description } : {}),
          confidence: a.confidence,
          importance: a.importance,
          ...(a.deadline !== undefined ? { deadline: a.deadline } : {}),
          actors: actors.known,
          involved: involved.known,
          docs: docs.known,
          blockedBy: blockedBy.known,
        },
        { ...dependencyContext(dependencies.refs), outcomeFence },
        clock(),
      );
      if (!persisted.ok)
        return persisted.conflict
          ? {
              kind: "error",
              code: "revision_conflict",
              message:
                "Outcome or supporting evidence changed during validation. Read the current state before retrying.",
            }
          : deadDependenciesResult(persisted.dead);
      const loop = persisted.value;
      await mirror.refresh(id);
      mutatedLoopIds.add(id);
      log.info(`Cognition Steward run ${runId} created open loop ${id}: ${a.title}`);
      return ok("open_loop.created", {
        loop: loopToModelJson(db, loop, { ledger: false }),
        ...(docs.dropped.length > 0 ? { droppedDocIds: docs.dropped } : {}),
        ...(blockedBy.dropped.length > 0 ? { droppedBlockedByIds: blockedBy.dropped } : {}),
        ...(actors.dropped.length > 0 ? { droppedActors: actors.dropped } : {}),
        ...(involved.dropped.length > 0 ? { droppedInvolved: involved.dropped } : {}),
      });
    },
  };

  // ---- open_loop_update ----
  const openLoopUpdateSchema = z
    .object({
      id: z.string().min(1),
      state: z.enum(["open", "snoozed", "done", "dismissed"]).optional(),
      confidence: fraction.optional(),
      importance: fraction.optional(),
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).optional(),
      deadline: z
        .unknown()
        .optional()
        .describe(
          "New action due boundary (same recommended shape as open_loop_create); expected events are not action deadlines; estimates stay approximate with a note and source event/date anchor. Do not invent clock precision or replace the deadline with a review time; pass null to clear.",
        ),
      actors: idList
        .optional()
        .describe(
          "REPLACES the actor list — person ids or emails, resolved like open_loop_create.",
        ),
      involved: idList
        .optional()
        .describe(
          "REPLACES the involved list — person ids or emails, resolved like open_loop_create.",
        ),
      docs: idList.optional().describe("REPLACES the doc list when present."),
      blockedBy: idList.optional(),
      decayCheckPassed: z
        .boolean()
        .optional()
        .describe(
          "Set true ONLY during a decay status-check to record a KEEP " +
            "verdict (stamps last_decay_check; the next check backs off " +
            "further out).",
        ),
      annotationDependencies: annotationDependenciesField,
      reason: z
        .string()
        .min(1)
        .max(300)
        .optional()
        .describe(
          "Why, in one sentence citing what changed. Required when the loop is one of the user's own tasks (userTask: true) and you change its state, title, description or deadline.",
        ),
      evidence: z
        .object({
          fact: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .describe(
              "The specific fact that establishes the change, as one plain sentence (e.g. that the invoice was paid in full, or the date the form is due by).",
            ),
          basis: z
            .enum(["explicit", "inferred"])
            .describe(
              '"explicit" when a source states the fact itself; "inferred" when you concluded it from what the sources say.',
            ),
          quotes: z
            .array(
              z
                .object({
                  docId: z.string().min(1),
                  quote: z
                    .string()
                    .min(12)
                    .max(500)
                    .describe("A VERBATIM quote from that document establishing the fact."),
                })
                .strict(),
            )
            .min(1)
            .max(4),
        })
        .strict()
        .optional()
        .describe(
          "For a change to the user's own task (userTask: true): the fact behind it and the verbatim quotes that establish it. A new title or description applies directly unless the user wrote that field (an addition to their description also applies). A completion or a new deadline applies directly once the quotes are verified to establish it. Striking a task, and anything else that overrides what the user wrote, is proposed for the user to confirm.",
        ),
    })
    .strict();
  const openLoopUpdate: ToolHandle = {
    name: "open_loop_update",
    description:
      "Partially update an existing open loop — pass only the fields to " +
      "change (`docs`/`actors`/etc. replace the whole list). Bumps the " +
      "loop's last_update. Prefer this (plus open_loop_ledger_append) over " +
      "creating a new loop when the datum concerns the SAME obligation an " +
      "existing loop tracks. Clarify title/description only for the same " +
      "outcome; a shared person, topic, or project does not establish identity. " +
      "Never replace the completion criterion to make the old loop look done. " +
      "Correct unsupported or misunderstood framing with a transparent ledger " +
      "note, or dismiss/remove under the retirement rules with an explicit " +
      "reason; a different task's completion does not " +
      "fulfil it. Track a distinct supported action in a separate loop, " +
      "preserving relevant context links. On the user's own task (userTask: " +
      "true) a change to state, title, description or deadline needs `reason`. " +
      "With `evidence` stating the fact explicitly in a source, a completion, an " +
      "addition to the description or a stated deadline is verified and applied " +
      "directly (the user can undo it); anything else — striking, a new title, " +
      "rewriting what the user wrote, an inference, evidence that does not verify " +
      "— is recorded as a proposal the user confirms or refuses. Links, people, " +
      "importance and decay checks always apply directly.",
    schema: openLoopUpdateSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs, ctx): Promise<ToolResult> {
      const parsed = openLoopUpdateSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { id, docs, blockedBy, deadline, evidence, ...rest } = parsed.data;
      const dependencies = selectDeclaredDependencies(rest.annotationDependencies);
      if (!dependencies.ok) return dependencies.result;
      const docsPart = docs !== undefined ? partitionDocIds(db, docs) : null;
      const blockedPart = blockedBy !== undefined ? partitionLoopIds(db, blockedBy) : null;
      const actorsPart = rest.actors !== undefined ? partitionPersonRefs(db, rest.actors) : null;
      const involvedPart =
        rest.involved !== undefined ? partitionPersonRefs(db, rest.involved) : null;
      const { existing, outcomeFence } = db.transaction(() => {
        const existing = getOpenLoop(db, id);
        return {
          existing,
          outcomeFence: captureOutcomeWriteFence(db, id, []),
        };
      })();
      if (!existing) return notFound("open loop", id);
      const userTask = isOwnedTask(existing);
      const proposal = userTask
        ? taskProposalFor(existing, {
            ...(rest.state !== undefined ? { state: rest.state as OpenLoopState } : {}),
            ...(rest.title !== undefined ? { title: rest.title } : {}),
            ...(rest.description !== undefined ? { description: rest.description } : {}),
            ...(deadline !== undefined ? { deadline } : {}),
          })
        : null;
      if (proposal && !rest.reason)
        return {
          kind: "error",
          code: "reason_required",
          message:
            "This loop is one of the user's own tasks: a change to it needs `reason`. Retry with `reason`, one sentence citing what changed, and `evidence` when a source states the fact behind it.",
        };
      const previous = outcomeProposal(existing);
      const proposed = outcomeProposal({
        ...existing,
        title: rest.title ?? existing.title,
        description: rest.description ?? existing.description,
        state: rest.state ?? existing.state,
        deadline: deadline === undefined ? existing.deadline : deadline,
        actors: actorsPart?.known ?? existing.actors,
      });
      // Scheduling, confidence and proof-only refreshes do not create new outcome assertions.
      const assertionChanged =
        proposed.title !== previous.title ||
        proposed.description !== previous.description ||
        JSON.stringify(proposed.deadline) !== JSON.stringify(previous.deadline) ||
        JSON.stringify([...proposed.actors].sort()) !==
          JSON.stringify([...previous.actors].sort()) ||
        (proposed.state !== previous.state &&
          (["open", "done"].includes(proposed.state) ||
            (proposed.state === "snoozed" && RESOLVED_OPEN_LOOP_STATES.has(previous.state))));
      if (assertionChanged) {
        const refused = await checkOutcome(
          id,
          previous,
          proposed,
          [...new Set([...(docsPart?.known ?? []), ...existing.docs])],
          ctx.abortSignal,
          outcomeFence,
          [
            ...new Set([
              ...(docsPart?.known ?? []).filter((docId) => !existing.docs.includes(docId)),
              ...(deps.seedDocIds ?? []),
            ]),
          ],
        );
        if (refused) return refused;
      }
      const appliesTaskFields = !userTask;
      const persisted = await writeGate.updateOpenLoop(
        id,
        {
          ...(appliesTaskFields && rest.state !== undefined
            ? { state: rest.state as OpenLoopState }
            : {}),
          ...(rest.confidence !== undefined ? { confidence: rest.confidence } : {}),
          ...(rest.importance !== undefined ? { importance: rest.importance } : {}),
          ...(appliesTaskFields && rest.title !== undefined ? { title: rest.title } : {}),
          ...(appliesTaskFields && rest.description !== undefined
            ? { description: rest.description }
            : {}),
          ...(appliesTaskFields && deadline !== undefined ? { deadline } : {}),
          ...(actorsPart ? { actors: actorsPart.known } : {}),
          ...(involvedPart ? { involved: involvedPart.known } : {}),
          ...(docsPart ? { docs: docsPart.known } : {}),
          ...(blockedPart ? { blockedBy: blockedPart.known } : {}),
          ...(rest.decayCheckPassed === true ? { lastDecayCheck: clock() } : {}),
        },
        { ...dependencyContext(dependencies.refs), outcomeFence },
        clock(),
      );
      if (!persisted.ok)
        return persisted.conflict
          ? {
              kind: "error",
              code: "revision_conflict",
              message:
                "Outcome or supporting evidence changed during validation. Read the current state before retrying.",
            }
          : deadDependenciesResult(persisted.dead);
      let updated = persisted.value;
      if (!updated) return notFound("open loop", id);
      let applied: { resolved: boolean } | null = null;
      let notApplied: string | null = null;
      if (proposal && rest.reason) {
        const evidenceDocs = [
          ...new Set([
            ...(docsPart?.known ?? []).filter((docId) => !existing.docs.includes(docId)),
            ...(deps.seedDocIds ?? []),
            ...(evidence?.quotes.map((q) => q.docId) ?? []),
          ]),
        ];
        const { authored, latestEventSeq } = readTaskAuthorship(db, id);
        const plan = planTaskAutoApply({
          enabled: deps.taskAutoApply === true,
          loop: existing,
          proposal,
          authored,
          evidence,
        });
        const verdict =
          plan.eligible && plan.claim !== undefined && evidence
            ? await verifyTaskEvidence(deps, evidence.quotes, plan.claim, ctx.abortSignal)
            : null;
        const decision = decideTaskAutoApply(plan, verdict?.verdict ?? null);
        if (decision.apply) {
          const result = await writeGate.autoApplyTaskChange(
            id,
            {
              ...decision.change,
              reason: rest.reason,
              evidence: evidenceDocs,
              runId,
              basedOnSeq: latestEventSeq,
            },
            clock(),
          );
          if (result.applied) applied = { resolved: result.resolved };
          else notApplied = "the task changed while the evidence was checked";
        } else {
          notApplied = verdict?.why ?? decision.why;
        }
        if (!applied)
          await writeGate.proposeTaskChange(
            id,
            {
              ...proposal,
              reason: rest.reason,
              evidence: evidenceDocs,
              runId,
              proposedAt: clock(),
            },
            clock(),
          );
        updated = getOpenLoop(db, id) ?? updated;
      }
      await mirror.refresh(id);
      mutatedLoopIds.add(id);
      // Resolve cascade: a loop moving to a resolved state (done/dismissed)
      // (1) retracts its never-claimed scheduled checks, so an
      // already-handled loop never wakes an agent run to rediscover
      // "nothing to do" (mirrors the decay sweep's retraction of a resolved
      // loop's decay check), and (2) drops the loop's open observations,
      // so tomorrow's brief never raises something already handled.
      if (
        applied?.resolved ||
        (appliesTaskFields &&
          rest.state !== undefined &&
          RESOLVED_OPEN_LOOP_STATES.has(rest.state as OpenLoopState))
      ) {
        await writeGate.cancelScheduledRunsForLoop(id);
        const dropped = await writeGate.dropObservationsForResolvedLoop(id, clock());
        if (dropped.length > 0) {
          log.info(
            `Cognition Steward run ${runId} resolved loop ${id}: dropped ${dropped.length} observation(s)`,
          );
        }
      }
      return ok(
        applied
          ? "open_loop.change_applied"
          : proposal
            ? "open_loop.change_proposed"
            : "open_loop.updated",
        {
          loop: loopToModelJson(db, updated, { ledger: false }),
          ...(applied
            ? {
                applied:
                  "Your change was applied to the user's task and shown in its history, where the user can undo it.",
              }
            : proposal
              ? {
                  proposed:
                    "The user's task keeps its current values; your change is shown to them to confirm or refuse.",
                  notAppliedBecause: notApplied,
                }
              : {}),
          ...(docsPart && docsPart.dropped.length > 0 ? { droppedDocIds: docsPart.dropped } : {}),
          ...(blockedPart && blockedPart.dropped.length > 0
            ? { droppedBlockedByIds: blockedPart.dropped }
            : {}),
          ...(actorsPart && actorsPart.dropped.length > 0
            ? { droppedActors: actorsPart.dropped }
            : {}),
          ...(involvedPart && involvedPart.dropped.length > 0
            ? { droppedInvolved: involvedPart.dropped }
            : {}),
        },
      );
    },
  };

  // ---- open_loop_ledger_append ----
  const ledgerAppendSchema = z
    .object({
      id: z.string().min(1).describe("Open-loop id."),
      note: z
        .string()
        .min(1)
        .max(2000)
        .describe("What happened / what you observed or decided, for future runs."),
    })
    .strict();
  const openLoopLedgerAppend: ToolHandle = {
    name: "open_loop_ledger_append",
    description:
      "Append a timestamped note to a loop's ledger — the traceable history " +
      "future runs read to rebuild context. The entry is stamped with this " +
      "run's id (a re-claimed attempt uses those stamps to adopt its own " +
      "partial work instead of duplicating it). Bumps last_update.",
    schema: ledgerAppendSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = ledgerAppendSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { id, note } = parsed.data;
      if (!getOpenLoop(db, id)) return notFound("open loop", id);
      await writeGate.appendOpenLoopLedger(id, { runId, note }, clock());
      await mirror.refresh(id);
      return ok("open_loop.ledger_appended", { loopId: id, runId, note });
    },
  };

  // ---- open_loop_delete ----
  const openLoopDeleteSchema = z
    .object({ id: z.string().min(1).describe("Open-loop id.") })
    .strict();
  const openLoopDelete: ToolHandle = {
    name: "open_loop_delete",
    description:
      "Delete an open loop — this ERASES its record, ledger included. " +
      "Reserve it for loops that should never have existed (a misread, a " +
      "true duplicate, an obligation retracted or redirected to someone " +
      "else), loops that decayed to irrelevance, and feedback cleanup. An " +
      "obligation that was actually fulfilled closes with open_loop_update " +
      'state "done" instead, so the record survives as the user\'s history ' +
      "— but a rescinded obligation was never fulfilled, so it is deleted, " +
      "never marked done. Engine-enforced invariant: its open observations " +
      "are deleted with it.",
    schema: openLoopDeleteSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = openLoopDeleteSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { id } = parsed.data;
      const target = getOpenLoop(db, id);
      if (target && isOwnedTask(target))
        return {
          kind: "error",
          code: "user_task",
          message:
            'This loop is one of the user\'s own tasks and cannot be deleted by a run. Propose striking it instead: open_loop_update with state "dismissed" and a reason.',
        };
      const result = await writeGate.deleteOpenLoop(id, clock());
      if (!result.deleted) return notFound("open loop", id);
      await mirror.remove([id]);
      // A deleted loop's scheduled checks would only wake a run to find
      // the loop gone — retract the never-claimed ones (same cascade the
      // resolve path uses). Its open observations need no separate step:
      // `deleteOpenLoop` enforces the deletion invariant and deletes them.
      await writeGate.cancelScheduledRunsForLoop(id);
      log.info(
        `Cognition Steward run ${runId} deleted open loop ${id} (+${result.deletedObservationIds.length} observation(s))`,
      );
      return ok("open_loop.deleted", {
        loopId: id,
        deletedObservationIds: result.deletedObservationIds,
      });
    },
  };

  // ---- observation_list ----
  const observationListSchema = z.object({}).strict();
  const observationList: ToolHandle = {
    name: "observation_list",
    description:
      "List the observations still waiting for a morning brief, plus those shipped in the " +
      "last three days. Read this before noting an observation so you never note the same " +
      "thing twice; supersede an outdated one instead.",
    schema: observationListSchema,
    // eslint-disable-next-line @typescript-eslint/require-await -- sync sqlite reads behind the async ToolHandle contract
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = observationListSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) return invalidArgs(parsed.error);
      const view = (o: ObservationRow) => ({
        id: o.id,
        summary: o.summary,
        why: o.why,
        state: o.state,
        relatedLoopIds: o.relatedLoopIds,
        citations: o.citations,
        windowStart: msToIso(o.windowStart),
        relevantUntil: msToIso(o.relevantUntil),
        notedAt: msToIso(o.createdAt),
      });
      const since = clock() - 3 * 86_400_000;
      return ok("observation.list", {
        observations: listOpenObservations(db).map(view),
        recentlyShipped: listObservations(db, { states: ["shipped"], limit: 50 })
          .filter((o) => (o.shippedAt ?? 0) >= since)
          .map(view),
      });
    },
  };

  // ---- observation_note ----
  const observationClaimSchema = z
    .object({
      docId: z.string().min(1).describe("Cited document the quote comes from."),
      quote: z
        .string()
        .min(12)
        .max(500)
        .describe("A VERBATIM quote from docId that establishes the observation."),
    })
    .strict();
  const observationNoteSchema = z
    .object({
      summary: z
        .string()
        .min(1)
        .max(300)
        .describe("One plain sentence: what you observed. No greeting, no bold, no padding."),
      why: z
        .string()
        .max(400)
        .default("")
        .describe("Why it might matter to the user, in one sentence. Empty when obvious."),
      citations: idList.min(1).describe("Original source documents the observation rests on."),
      claims: z
        .array(observationClaimSchema)
        .max(8)
        .default([])
        .describe("Verbatim quotes that establish the observation, checked before it ships."),
      relatedLoopIds: idList.optional().describe("Loops this observation concerns."),
      windowStart: isoDateTime
        .optional()
        .describe("When it starts to matter (ISO 8601). Omit when it matters now."),
      relevantUntil: isoDateTime
        .optional()
        .describe("When it stops mattering (ISO 8601): a deadline or the event's end."),
      supersedes: idList
        .optional()
        .describe("Ids of open observations this one replaces; they are dropped."),
      annotationDependencies: annotationDependenciesField,
    })
    .strict();
  const observationNote: ToolHandle = {
    name: "observation_note",
    description:
      "Note something the user may want to hear in tomorrow's morning brief. Nothing you " +
      "note reaches the user directly: the morning run rechecks every observation, ranks " +
      "them, and decides what to say. Note only what the user probably does not already " +
      "know and would act on. Read observation_list first and supersede rather than " +
      "duplicate. Cite original sources; quote what establishes the observation.",
    schema: observationNoteSchema,
    mutates: true,
    summarize: (args) => (args as { summary?: string })?.summary,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = observationNoteSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      const dependencies = selectDeclaredDependencies(a.annotationDependencies);
      if (!dependencies.ok) return dependencies.result;
      const now = clock();
      const relevantUntil = a.relevantUntil === undefined ? null : isoToMs(a.relevantUntil);
      if (relevantUntil !== null && relevantUntil <= now)
        return {
          kind: "error",
          code: "invalid_args",
          message: "relevantUntil has already passed — do not note what no longer matters",
        };
      const citations: string[] = [];
      for (const docId of new Set(a.citations)) {
        const doc = isKnowledgeEvidenceReadable(db, docId) ? fetchEvidenceDoc(db, docId) : null;
        if (!doc) return notFound("document", docId);
        citations.push(docId);
      }
      for (const claim of a.claims) {
        if (!citations.includes(claim.docId))
          return {
            kind: "error",
            code: "invalid_args",
            message: `claim quotes ${claim.docId}, which is not among citations`,
          };
        const doc = fetchEvidenceDoc(db, claim.docId)!;
        if (!quoteInEvidence(doc, claim.quote))
          return {
            kind: "error",
            code: "evidence_not_found",
            message: `quote not found in ${claim.docId} — quote the source text exactly`,
          };
      }
      const loops = partitionLoopIds(db, a.relatedLoopIds ?? []);
      const open = new Set(listOpenObservations(db).map((o) => o.id));
      const superseded = (a.supersedes ?? []).filter((id) => open.has(id));
      const id = `obs_${idGen()}`;
      const userAuthored = citationsAuthoredBySelf(db, citations);
      const windowStart = a.windowStart === undefined ? null : isoToMs(a.windowStart);
      const noted = deps.scoreObservation
        ? await deps.scoreObservation({
            id,
            summary: a.summary,
            why: a.why,
            userAuthored,
            citations,
            windowStart,
            relevantUntil,
            notedAt: now,
          })
        : { scores: null, wouldPushAt: null };
      const result = await deps.writeGate.createObservation(
        {
          id,
          createdByRun: runId,
          summary: a.summary,
          why: a.why,
          userAuthored,
          windowStart,
          relevantUntil,
          citations,
          relatedLoopIds: loops.known,
          claims: a.claims.map((c) => ({ ...c, verification: "unverified" as const })),
          notedScores: noted.scores,
          wouldPushAt: noted.wouldPushAt,
        },
        dependencyContext(dependencies.refs),
        now,
      );
      if (!result.ok) return deadDependenciesResult(result.dead);
      for (const sid of superseded)
        await deps.writeGate.transitionObservation(
          sid,
          { state: "dropped", reason: "superseded" },
          now,
        );
      return ok("observation.noted", {
        id,
        userAuthored,
        superseded,
        ...(loops.dropped.length ? { unknownLoopIds: loops.dropped } : {}),
        ...(noted.scores ? { scores: noted.scores } : {}),
      });
    },
  };

  // ---- observation_withdraw ----
  const observationWithdrawSchema = z
    .object({
      id: z.string().min(1).describe("Open observation id."),
    })
    .strict();
  const observationWithdraw: ToolHandle = {
    name: "observation_withdraw",
    description:
      "Withdraw an open observation you or another run noted, when it no longer holds or " +
      "no longer matters. It is dropped and never shown.",
    schema: observationWithdrawSchema,
    mutates: true,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = observationWithdrawSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const withdrawn = await deps.writeGate.transitionObservation(
        parsed.data.id,
        { state: "dropped", reason: "withdrawn" },
        clock(),
      );
      if (!withdrawn) return notFound("open observation", parsed.data.id);
      return ok("observation.withdrawn", { id: parsed.data.id });
    },
  };

  // ---- notes tools ----
  // The zod `.max` on the notes schemas is a sanity bound over argument SIZE
  // (characters), not the cap: the byte cap is enforced in the handlers
  // against the live configured `getNotesMaxBytes()`. The config schema
  // bounds `brain.notesMaxBytes` at 32768, so the largest handler-accepted
  // write (2x the cap = 65536 bytes, and a string's UTF-8 byte length is
  // never below its char count) always fits the 65536-char schema bound —
  // the schema ceiling can never bind before the byte check does.

  /**
   * Arm the background notes-compaction run after an over-cap notes write.
   * Returns whether a compaction run is pending afterwards. Three guards:
   *   - the compaction run itself never re-arms: its own curation writes may
   *     sit over the cap mid-rewrite, and a self-enqueue would fold into its
   *     own in-flight row and resurrect it after every settle;
   *   - an already-pending compaction is left untouched — the payload is
   *     fixed and the run reads the live notes at claim time, so a fold
   *     would add nothing while resetting the row's attempt budget;
   *   - the payload carries no live byte counts, so an enqueue that does
   *     race the pending check folds byte-identically and never resurrects
   *     a settled run.
   */
  async function scheduleNotesCompaction(): Promise<boolean> {
    if (getCognitionRun(db, runId)?.kind === "notes_compaction") return false;
    if (getPendingRunByDedupeKey(db, notesCompactionRunDedupeKey()) !== null) return true;
    await writeGate.enqueueCognitionRun(
      {
        id: `run_${idGen()}`,
        kind: "notes_compaction",
        payload: { reason: "notes over soft cap" },
        dedupeKey: notesCompactionRunDedupeKey(),
      },
      clock(),
    );
    return true;
  }

  const notesAppendSchema = z
    .object({ text: z.string().min(1).max(65536).describe("Lesson/fact to append.") })
    .strict();
  const notesAppend: ToolHandle = {
    name: "notes_append",
    description:
      "Append a line to your persistent notes file (its full contents are " +
      "already in this prompt). Use it for durable cross-run lessons — user " +
      "preferences, disambiguations, recurring context. Appends always land, " +
      "even above the soft size cap: an over-cap append is accepted and a " +
      "background compaction run is scheduled to curate the file back under " +
      "the cap. Only an append beyond twice the cap is refused.",
    schema: notesAppendSchema,
    mutates: true,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = notesAppendSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const maxBytes = deps.getNotesMaxBytes();
      // Atomic read-modify-write inside the write gate — two concurrent
      // daily runs appending at once can't erase each other's lesson.
      const result = await writeGate.appendCognitionNotes(parsed.data.text, {
        maxBytes,
        now: clock(),
      });
      if (!result.applied) {
        // Even a refused write arms compaction: the blob may already sit
        // over the soft cap with nothing scheduled, and the fixed dedupe
        // key makes arming idempotent.
        await scheduleNotesCompaction();
        const ceiling = maxBytes * COGNITION_NOTES_OVERFLOW_FACTOR;
        return {
          kind: "error",
          code: "notes_cap_exceeded",
          message:
            `appending would use ${result.bytes} bytes, ${result.bytes - ceiling} over the ` +
            `${ceiling}-byte hard ceiling (${COGNITION_NOTES_OVERFLOW_FACTOR}x the ` +
            `${maxBytes}-byte cap) — remove at least that much with notes_edit or ` +
            `notes_rewrite first`,
        };
      }
      if (result.overCap) {
        // Landed above the soft cap: the write stands (memory writes must
        // succeed immediately) and curation is deferred to the background
        // compaction run.
        const compactionScheduled = await scheduleNotesCompaction();
        return ok("notes.appended", {
          bytesUsed: result.bytes,
          maxBytes,
          overCap: true,
          ...(compactionScheduled ? { compactionScheduled: true } : {}),
        });
      }
      return ok("notes.appended", { bytesUsed: result.bytes, maxBytes });
    },
  };

  const notesRewriteSchema = z
    .object({ text: z.string().max(65536).describe("Full replacement notes content.") })
    .strict();
  const notesRewrite: ToolHandle = {
    name: "notes_rewrite",
    description:
      "Replace the entire persistent notes file — the curate-and-compact " +
      "primitive. Returns the post-write content so you see exactly what " +
      "future runs will be given. Keep only durable, still-true lessons.",
    schema: notesRewriteSchema,
    mutates: true,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = notesRewriteSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const maxBytes = deps.getNotesMaxBytes();
      const bytes = Buffer.byteLength(parsed.data.text, "utf8");
      if (bytes > maxBytes) {
        return {
          kind: "error",
          code: "notes_cap_exceeded",
          message:
            `content is ${bytes} bytes, ${bytes - maxBytes} over the ${maxBytes}-byte cap — ` +
            `remove at least that much`,
        };
      }
      const content = await writeGate.writeCognitionNotes(parsed.data.text, {
        maxBytes,
        now: clock(),
      });
      return ok("notes.rewritten", { content, bytesUsed: bytes, maxBytes });
    },
  };

  const notesEditSchema = z
    .object({
      oldText: z
        .string()
        .min(1)
        .max(65536)
        .describe("Exact substring of the current notes to replace — must occur exactly once."),
      newText: z.string().max(65536).describe("Replacement text; empty deletes the span."),
    })
    .strict();
  const notesEdit: ToolHandle = {
    name: "notes_edit",
    description:
      "Replace one exact substring of your persistent notes file — targeted " +
      "upkeep without re-emitting the whole file. oldText must match the " +
      "current notes (shown in this prompt) exactly and occur exactly once; " +
      "pass a longer span to disambiguate, or an empty newText to delete.",
    schema: notesEditSchema,
    mutates: true,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = notesEditSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const maxBytes = deps.getNotesMaxBytes();
      // Same single-transaction read-modify-write discipline as append.
      const result = await writeGate.editCognitionNotes(parsed.data.oldText, parsed.data.newText, {
        maxBytes,
        now: clock(),
      });
      if (!result.applied) {
        switch (result.reason) {
          case "not_found": {
            const needle =
              parsed.data.oldText.length > 200
                ? `${parsed.data.oldText.slice(0, 200)}…`
                : parsed.data.oldText;
            return {
              kind: "error",
              code: "notes_edit_not_found",
              message:
                `oldText was not found in the current notes: "${needle}" — copy an ` +
                `exact span from the notes shown in your prompt`,
            };
          }
          case "ambiguous":
            return {
              kind: "error",
              code: "notes_edit_ambiguous",
              message:
                `oldText occurs ${result.occurrences} times in the current notes — ` +
                `pass a longer span that is unique`,
            };
          case "malformed":
            return {
              kind: "error",
              code: "notes_edit_malformed",
              message:
                "oldText or newText is not well-formed UTF-16 (it contains a lone " +
                "surrogate half, e.g. half of an emoji) — re-issue the edit with " +
                "whole characters only",
            };
          case "over_ceiling": {
            // Even a refused edit arms compaction: the blob may already sit
            // over the soft cap with nothing scheduled, and the fixed dedupe
            // key makes arming idempotent.
            await scheduleNotesCompaction();
            const ceiling = maxBytes * COGNITION_NOTES_OVERFLOW_FACTOR;
            return {
              kind: "error",
              code: "notes_cap_exceeded",
              message:
                `the edit would use ${result.bytes} bytes, ${result.bytes - ceiling} over the ` +
                `${ceiling}-byte hard ceiling (${COGNITION_NOTES_OVERFLOW_FACTOR}x the ` +
                `${maxBytes}-byte cap) — remove more than you add`,
            };
          }
        }
      }
      if (result.overCap) {
        // An edit that grows the blob past the soft cap needs curation just
        // as much as an over-cap append does.
        const compactionScheduled = await scheduleNotesCompaction();
        return ok("notes.edited", {
          bytesUsed: result.bytes,
          maxBytes,
          overCap: true,
          ...(compactionScheduled ? { compactionScheduled: true } : {}),
        });
      }
      return ok("notes.edited", { bytesUsed: result.bytes, maxBytes });
    },
  };

  // ---- schedule_agent_run ----
  const scheduleSchema = z
    .object({
      when: isoDateTime.describe("ISO 8601 date-time the run should execute at."),
      prompt: z
        .string()
        .min(1)
        .max(SCHEDULED_INSTRUCTION_REQUEST_MAX_CHARS)
        .describe("The instruction the future run receives (reference loop/doc ids explicitly)."),
      loopId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "If this check is tied to a specific open loop, pass its id: the " +
            "run is auto-cancelled if that loop resolves or is deleted before " +
            "it fires, so an already-handled loop never burns a run.",
        ),
      onConflict: z
        .enum(["merge", "add"])
        .optional()
        .describe(
          "Only on a retry after a schedule_conflict error (a check for the " +
            'same loop is already pending that day). "merge": append this ' +
            "instruction to that existing check, which keeps ITS fire time. " +
            '"add": schedule this as a second, separate run at `when`. Omit ' +
            "on a first call. If the existing check already covers this, do " +
            "not call again — it stands.",
        ),
    })
    .strict();
  const scheduleAgentRun: ToolHandle = {
    name: "schedule_agent_run",
    description:
      "Schedule a future run of yourself at a specific date/time, with an " +
      "open-ended prompt as its input. Use for pre-event refreshes, " +
      "deadline-day checks, and re-checks of loops that went quiet. When " +
      "the check is about a specific open loop, pass its loopId so it " +
      "auto-cancels if the loop resolves first. When that loop already has " +
      "a check pending on the same day, the call is refused with a " +
      "schedule_conflict error that names the existing check's fire time " +
      "and instruction; resolve it by calling again with onConflict " +
      '("merge" or "add"), or by not calling again if that check ' +
      "already covers what you wanted. The returned scheduledFor is the " +
      "time the check will actually fire.",
    schema: scheduleSchema,
    mutates: true,
    summarize: (args) => (args as { when?: string })?.when,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = scheduleSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const notBefore = isoToMs(parsed.data.when);
      // Resolve the loop this check links to, so a resolve/delete of that
      // loop auto-cancels the check (see `cancelScheduledRunsForLoop`).
      //
      // When the agent passed a `loopId`, validate it against the store (the
      // dangling-reference contract): an unknown/deleted id is
      // dropped-and-reported rather than persisted as a link that could
      // never cascade.
      //
      // When the agent passed none, the engine auto-attaches the loop the
      // run is unambiguously scoped to (`unambiguousLoopScope`) — so the
      // structured link doesn't depend on the model remembering to set it.
      // An auto-candidate is still store-validated (it could have been
      // deleted later this run); an ambiguous scope leaves the check
      // loop-less and the prompt-text fallback covers the cascade.
      const requestedLoopId = parsed.data.loopId;
      let linkedLoopId: string | undefined;
      let droppedLoopId: string | undefined;
      if (requestedLoopId !== undefined) {
        if (getOpenLoop(db, requestedLoopId)) linkedLoopId = requestedLoopId;
        else droppedLoopId = requestedLoopId;
      } else {
        const auto = unambiguousLoopScope();
        if (auto !== undefined && getOpenLoop(db, auto)) linkedLoopId = auto;
      }
      const result = await writeGate.enqueueCognitionRun(
        {
          id: `run_${idGen()}`,
          kind: "time_based",
          payload: {
            prompt: parsed.data.prompt,
            ...(linkedLoopId !== undefined ? { loopId: linkedLoopId } : {}),
          },
          notBefore,
          ...(parsed.data.onConflict !== undefined
            ? { onScheduleConflict: parsed.data.onConflict }
            : {}),
        },
        clock(),
      );
      if (result.outcome === "refused") return scheduleConflict(result, parsed.data.when);
      return ok("agent_run.scheduled", {
        runId: result.runId,
        // The hour the run this call landed on will actually fire — for a
        // merge that is the existing check's hour, not the one requested.
        scheduledFor: new Date(result.nextAttemptAt).toISOString(),
        // The instruction joined an already-pending same-loop, same-day check
        // rather than becoming a run of its own. Told to the agent so it doesn't
        // read the returned id as a second, distinct check it must also track.
        ...(result.outcome === "merged" ? { merged: true } : {}),
        ...(droppedLoopId !== undefined ? { droppedLoopId } : {}),
      });
    },
  };

  /**
   * The refusal a loop-scoped check meets when a check for the same loop is
   * already pending that day. It is an error so the run cannot mistake it
   * for a scheduled run, and it carries everything the agent needs to decide
   * without another lookup: the existing check's real fire time and stored
   * instruction, and the two retries that resolve the conflict. Not retrying
   * is the third resolution — the existing check stands as it is.
   */
  function scheduleConflict(
    refusal: Extract<EnqueueCognitionRunResult, { outcome: "refused" }>,
    requestedWhen: string,
  ): ToolResult {
    const loopId = refusal.loopId;
    const firesAt = new Date(refusal.nextAttemptAt).toISOString();
    const existing = parseCognitionTimeBasedRunPayload(refusal.existingPayload)?.prompt;
    const instruction = existing === undefined ? "(no instruction stored)" : `"${existing}"`;
    const retryAdd =
      `call schedule_agent_run again with the same arguments plus onConflict: "add" to ` +
      `schedule this as a second, separate check at ${requestedWhen}`;
    const stands = "do NOT call again: that check stands as it is";
    return {
      kind: "error",
      code: "schedule_conflict",
      message:
        refusal.reason === "pending_check"
          ? `Nothing was scheduled: loop ${loopId} already has a check pending that day — ` +
            `run ${refusal.runId}, firing at ${firesAt}, with the instruction ${instruction}. ` +
            `Choose one: (1) if that check already covers what you wanted, ${stands}; ` +
            `(2) call schedule_agent_run again with the same arguments plus onConflict: "merge" ` +
            `to append this instruction to that check, which keeps firing at ${firesAt}; ` +
            `(3) ${retryAdd}.`
          : `Nothing was scheduled: loop ${loopId} already has a check pending that day — ` +
            `run ${refusal.runId}, firing at ${firesAt} — and its stored instruction is at the ` +
            `${SCHEDULED_INSTRUCTION_MAX_CHARS}-character cap, so this one cannot be merged into it. ` +
            `Choose one: (1) if that check already covers what you wanted, ${stands}; (2) ${retryAdd}.`,
    };
  }

  // ---- temporal_annotation_add / _update / _delete ----
  // The mutable, LLM-owned temporal surface. The read side is the shared
  // `temporal_query` tool, which also reads immutable source projections.
  // The one shared vocabulary: an annotation classifies a time with exactly the
  // kinds a source projection can, so a caller filtering on a kind is not also
  // filtering on which producer wrote it.
  const timeKind = z.enum(TEMPORAL_KINDS);
  const temporalAnnotationId = z
    .string()
    .min(1)
    .refine((id) => !id.startsWith("tp_"), {
      message: "projection ids (tp_) are immutable; only temporal annotations can be mutated",
    });

  /**
   * Optional grounding on a temporal-annotation write — the conditional teeth:
   * document-derived entry declares where its time/meaning comes from, and
   * the write verifies it (quote-in-document, then the entailment gate
   * against the sentence). A write without evidence is never gated.
   */
  const timeEvidenceSchema = z
    .object({
      docId: z.string().min(1).describe("The source document this entry is derived from."),
      quote: z
        .string()
        .min(12)
        .max(500)
        .describe("A VERBATIM quote from that document establishing the entry's time and meaning."),
    })
    .strict();

  /** Expand a `when` (+ optional `until`) into interval bounds + display form. */
  function resolveEntryInterval(
    when: string,
    until?: string,
  ):
    | {
        intervalStartMs: number;
        intervalEndMs: number;
        precision: TemporalPrecision;
        canonical: string;
      }
    | { error: string } {
    const start = expandCanonical(when);
    if (!start) return { error: `'${when}' is not a YYYY[-MM[-DD]] date or ISO instant` };
    if (until === undefined) {
      return {
        intervalStartMs: start.startMs,
        intervalEndMs: start.endMs,
        precision: start.precision,
        canonical: when,
      };
    }
    const end = expandCanonical(until);
    if (!end) return { error: `'${until}' is not a YYYY[-MM[-DD]] date or ISO instant` };
    const lo = Math.min(start.startMs, end.startMs);
    const hi = Math.max(start.endMs, end.endMs);
    return {
      intervalStartMs: lo,
      intervalEndMs: hi,
      precision: "range",
      canonical: `${when} .. ${until}`,
    };
  }

  /** Max overlap candidates surfaced by the add-reconcile probe. */
  const OVERLAP_CANDIDATE_LIMIT = 8;

  /**
   * Widest existing entry the reconcile probe may surface as a duplicate
   * candidate — coarse periods (and anything wider than this) overlap far
   * too much to plausibly be the SAME event as a concrete new entry.
   */
  const OVERLAP_PROBE_MAX_SPAN_MS = 35 * 24 * 3_600_000;

  /**
   * Widen an entry's interval to whole UTC days for the reconcile probe when
   * its precision is instant or day — so a "09:00 coffee" instant meets the
   * day-precision entry (and the 10:00 restatement) for the same event.
   * Ranges and coarser periods probe their exact interval.
   */
  function widenProbeToUtcDays(interval: {
    intervalStartMs: number;
    intervalEndMs: number;
    precision: TemporalPrecision;
  }): { startMs: number; endMs: number } {
    if (interval.precision !== "instant" && interval.precision !== "day") {
      return { startMs: interval.intervalStartMs, endMs: interval.intervalEndMs };
    }
    const DAY_MS = 24 * 3_600_000;
    return {
      startMs: Math.floor(interval.intervalStartMs / DAY_MS) * DAY_MS,
      endMs: Math.floor(interval.intervalEndMs / DAY_MS) * DAY_MS + DAY_MS - 1,
    };
  }

  async function validateProjectionLinks(
    projectionIds: readonly string[] | undefined,
    interval: { intervalStartMs: number; intervalEndMs: number },
    abortSignal?: AbortSignal,
  ): Promise<ToolResult | null> {
    if (!projectionIds?.length) return null;
    if (!deps.temporalPort) {
      return {
        kind: "error",
        code: "invalid_args",
        message:
          "projectionIds cannot be verified because temporal_query is unavailable; " +
          "omit the links and retry after the temporal read surface is available",
      };
    }
    const page = await deps.temporalPort.query(
      {
        from: new Date(interval.intervalStartMs).toISOString(),
        to: new Date(interval.intervalEndMs + 1).toISOString(),
        timeZone: "UTC",
        origins: ["projection"],
        statuses: ["active", "completed", "cancelled"],
        entityIds: [...projectionIds],
        limit: Math.min(projectionIds.length, 100),
      },
      abortSignal,
    );
    const found = new Set(page.items.map((item) => item.id));
    const unknown = projectionIds.filter((id) => !found.has(id));
    if (unknown.length === 0) return null;
    return {
      kind: "error",
      code: "invalid_args",
      message:
        "projectionIds must name projections returned by temporal_query that overlap " +
        `this annotation; unknown or non-overlapping ids: ${unknown.join(", ")}`,
    };
  }

  const temporalAnnotationAddSchema = z
    .object({
      when: z
        .string()
        .min(1)
        .describe("The time: a calendar date (YYYY, YYYY-MM, or YYYY-MM-DD) or an ISO instant."),
      until: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Inclusive end of a range (same formats); temporal_query to is exclusive, so query beyond the final included instant or day. Only for lived spans where each covered day " +
            "matters (a trip, a visit, a closure window) — an expiry/deadline/renewal is " +
            "filed as its single lapse/due date via `when`, with the validity window in " +
            "the sentence, never as a range spanning it.",
        ),
      sentence: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          "One line naming what this time means to the user (e.g. 'passport " +
            "expires'). State only what the source displays, scoped to the " +
            "section it appears in — never an exhaustive or negative claim " +
            "('only', 'no X') inferred from what a source fails to show.",
        ),
      kind: timeKind.optional().describe("Optional classification of the time."),
      documentIds: idList.optional().describe("Source document(s) grounding this time."),
      loopIds: idList
        .optional()
        .describe(
          "Open-loop id(s) this time belongs to — backlinks the entry to those " +
            "loops. Unknown/deleted ids are dropped and reported.",
        ),
      personIds: idList
        .optional()
        .describe(
          "Person id(s) (or emails, resolved to their person) this time concerns. " +
            "Refs matching no known person are dropped and reported.",
        ),
      projectionIds: idList
        .refine((ids) => ids.every((id) => id.startsWith("tp_")), {
          message: "projectionIds must contain only tp_ projection ids",
        })
        .optional()
        .describe(
          "Projection id(s) this annotation adds meaning to. Use ids returned by " +
            "temporal_query or injected in the datum prompt; projections remain read-only.",
        ),
      evidence: timeEvidenceSchema
        .optional()
        .describe(
          "Grounding for a DOCUMENT-DERIVED entry: the write verifies the quote " +
            "appears in the document and establishes the sentence, links the " +
            "document as a source, and persists the quote as the entry's " +
            "grounding — survival across source-document edits is checked " +
            "against it. REQUIRED whenever documentIds are supplied (the add " +
            "is refused without it); omit only for pure scheduling / " +
            "self-sourced entries with no documentIds.",
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Insert despite temporal overlaps or a matching linked loop deadline. Only set after reviewing " +
            "the overlap candidates a first attempt returned and confirming this is a " +
            "genuinely distinct event, not the same one restated.",
        ),
    })
    .strict();
  const temporalAnnotationAdd: ToolHandle = {
    name: "temporal_annotation_add",
    description:
      "Before writing, obtain a complete annotation-inclusive temporal_query covering the full interval and subject. Only the latest query supplies the active scope, and it must be complete; separate queries are not combined. Read then mutate within that scope, or use one complete document-filtered window for the batch. Record a dated fact in the time index, with a one-line sentence and its " +
      "source document(s). The index bar is near-exhaustive: every dated thing " +
      "a document establishes belongs here, except a date that merely times an " +
      "obligation: keep that in the loop deadline. Independently established " +
      "events still belong here. Skip an add when a queried " +
      "projection or annotation already carries the same interval and fact. " +
      "Pass evidence {docId, quote} whenever the " +
      "entry derives from a document — the quote is verified against " +
      "the document and the sentence at write time, then persisted as the " +
      "entry's grounding. The sentence states only what the source displays, " +
      "scoped to the section it appears in — never an exhaustive or negative " +
      "claim ('only', 'no X') inferred from what a source fails to show. " +
      "Reconcile is enforced: when " +
      "live temporal entries overlap the time or a linked loop carries the same " +
      "deadline interval, the add is refused and both sets of candidates " +
      "returned — temporal_annotation_update the matching one, or re-call with " +
      "force:true if it is " +
      "truly distinct.",
    schema: temporalAnnotationAddSchema,
    mutates: true,
    summarize: (args) => (args as { when?: string })?.when,
    async invoke(rawArgs, ctx): Promise<ToolResult> {
      const parsed = temporalAnnotationAddSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      const payloadCapture = a.evidence
        ? captureRecordCheckPayload(deps, [...(a.documentIds ?? []), a.evidence.docId])
        : undefined;
      // Document-derived entries MUST ground themselves: without a quote the
      // content-change invalidator has nothing to re-check, so the entry can
      // neither survive source edits deliberately nor be retired honestly.
      if ((a.documentIds?.length ?? 0) > 0 && a.evidence === undefined) {
        return {
          kind: "error",
          code: "invalid_args",
          message:
            "documentIds were supplied without evidence. A document-derived entry " +
            "requires evidence {docId, quote}: quote the verbatim passage (from one " +
            "of the linked documents) that establishes the sentence. Omit " +
            "documentIds only for a pure scheduling / self-sourced entry.",
        };
      }
      const interval = resolveEntryInterval(a.when, a.until);
      if ("error" in interval)
        return { kind: "error", code: "invalid_args", message: interval.error };
      const invalidProjectionLinks = await validateProjectionLinks(
        a.projectionIds,
        interval,
        ctx.abortSignal,
      );
      if (invalidProjectionLinks !== null) return invalidProjectionLinks;
      if (a.force !== true) {
        // A matching deadline is a reconciliation candidate, not proof of
        // semantic duplication. Read only explicitly linked loops by primary
        // key; distinct same-time facts can still be added with force.
        let loopDeadlineCandidates: Array<{ id: string; title: string; deadline: unknown }> = [];
        if (a.kind === "deadline") {
          loopDeadlineCandidates = [...new Set(a.loopIds ?? [])].flatMap((id) => {
            const loop = getOpenLoop(db, id);
            if (loop === null) return [];
            const deadline = loop.deadline;
            const date =
              typeof deadline === "string"
                ? deadline
                : typeof deadline === "object" && deadline !== null && "date" in deadline
                  ? deadline.date
                  : null;
            if (typeof date !== "string") return [];
            const due = expandCanonical(date);
            if (
              due === null ||
              due.startMs !== interval.intervalStartMs ||
              due.endMs !== interval.intervalEndMs
            )
              return [];
            return [{ id: loop.id, title: loop.title, deadline: loop.deadline }];
          });
        }
        // Reconcile-before-create as a tool contract, not prompt discipline:
        // probe the entry's own interval — widened to whole UTC days for
        // instant/day precision, so a 09:00 instant meets a same-day
        // entry — and refuse with the candidates when anything overlaps.
        const probe = widenProbeToUtcDays(interval);
        let overlapping: Array<TemporalAnnotation | TemporalItem> = [];
        if (interval.intervalEndMs - interval.intervalStartMs <= OVERLAP_PROBE_MAX_SPAN_MS) {
          overlapping = deps.temporalPort
            ? (
                await deps.temporalPort.query(
                  {
                    from: new Date(probe.startMs).toISOString(),
                    to: new Date(probe.endMs + 1).toISOString(),
                    timeZone: "UTC",
                    origins: ["projection", "annotation"],
                    statuses: ["active", "completed"],
                    limit: OVERLAP_CANDIDATE_LIMIT,
                  },
                  ctx.abortSignal,
                )
              ).items
            : queryTemporalAnnotationReconcileCandidates(
                db,
                probe.startMs,
                probe.endMs,
                OVERLAP_PROBE_MAX_SPAN_MS,
                OVERLAP_CANDIDATE_LIMIT,
              );
        }
        if (overlapping.length > 0 || loopDeadlineCandidates.length > 0) {
          return ok("temporal_annotation.overlap_candidates", {
            when: interval.canonical,
            loopDeadlineCandidates,
            candidates: overlapping.map((entry) =>
              "origin" in entry
                ? {
                    id: entry.id,
                    origin: entry.origin,
                    start: entry.start,
                    endExclusive: entry.endExclusive,
                    precision: entry.precision,
                    kind: entry.kind,
                    label: entry.label,
                    documentIds:
                      entry.annotation?.documentIds ??
                      (entry.projection?.documentId ? [entry.projection.documentId] : []),
                  }
                : {
                    id: entry.id,
                    origin: "annotation",
                    when: entry.canonical,
                    precision: entry.precision,
                    kind: entry.kind,
                    label: entry.sentence,
                    sentence: entry.sentence,
                    documentIds: entry.documentIds,
                  },
            ),
            guidance:
              "Not added. Review both temporal candidates and linked loop deadlines. " +
              "If the date merely times a linked loop's obligation, keep it loop-only. " +
              "If an annotation is the SAME interpretation, update it. " +
              "If a projection already carries the whole fact, do nothing. If this adds " +
              "meaning beyond a projection, re-call with force:true and link its tp_ id " +
              "in projectionIds. Only use force without a link for a genuinely separate item.",
          });
        }
      }
      ctx.abortSignal?.throwIfAborted();
      // Cheap evidence validation precedes either paid gate. The current source
      // generation is rechecked after value admission before verifier exposure.
      if (a.evidence !== undefined) {
        const refusal = vetTemporalSourceEvidence(db, a.evidence);
        if (refusal !== null) return refusal;
      }
      const evidenceRevision = a.evidence
        ? readKnowledgeSourceRevision(db, a.evidence.docId)
        : undefined;
      const docIdInputs = [
        ...new Set([...(a.documentIds ?? []), ...(a.evidence ? [a.evidence.docId] : [])]),
      ];
      const { known, dropped } = partitionDocIds(db, docIdInputs);
      const loops = partitionLoopIds(db, a.loopIds ?? []);
      const people = partitionPersonRefs(db, a.personIds ?? []);
      const id = `ta_${idGen()}`;
      // Only document-grounded entries are checked; a self-sourced scheduling
      // entry is the agent's own bookkeeping.
      if (a.evidence !== undefined) {
        const dropped = await recordCheckRefusal(
          deps,
          {
            recordId: id,
            record: { type: "timeline", kind: a.kind ?? null, text: a.sentence },
            documentId: a.evidence.docId,
            ...(payloadCapture ? { payloadCapture } : {}),
          },
          ctx.abortSignal,
        );
        if (dropped !== null) return dropped;
      }
      ctx.abortSignal?.throwIfAborted();
      if (a.evidence !== undefined) {
        if (
          !isKnowledgeEvidenceReadable(db, a.evidence.docId) ||
          readKnowledgeSourceRevision(db, a.evidence.docId) !== evidenceRevision
        )
          return {
            kind: "error",
            code: "revision_conflict",
            message:
              "Temporal source evidence changed during value assessment; reread and reconcile before retrying.",
          };
        const refusal = await vetTemporalAnnotationEvidence(
          deps,
          a.evidence,
          a.sentence,
          clock(),
          ctx.abortSignal,
        );
        if (refusal !== null) return refusal;
      }
      ctx.abortSignal?.throwIfAborted();
      const annotation = await writeGate.createTemporalAnnotation(
        {
          id,
          intervalStartMs: interval.intervalStartMs,
          intervalEndMs: interval.intervalEndMs,
          precision: interval.precision,
          canonical: interval.canonical,
          sentence: a.sentence,
          kind: a.kind ?? null,
          documentIds: known,
          loopIds: loops.known,
          personIds: people.known,
          projectionIds: a.projectionIds ?? [],
          ...(a.evidence !== undefined
            ? { evidence: [{ docId: a.evidence.docId, quote: a.evidence.quote }] }
            : {}),
          createdByRun: runId,
        },
        clock(),
      );
      log.info(
        `Cognition Steward run ${runId} added temporal annotation ${id} (${interval.canonical})`,
      );
      return ok("temporal_annotation.added", {
        id: annotation.id,
        when: interval.canonical,
        precision: interval.precision,
        documentIds: annotation.documentIds,
        loopIds: annotation.loopIds,
        personIds: annotation.personIds,
        projectionIds: annotation.projectionIds,
        ...(dropped.length ? { droppedDocumentIds: dropped } : {}),
        ...(loops.dropped.length ? { droppedLoopIds: loops.dropped } : {}),
        ...(people.dropped.length ? { droppedPersonIds: people.dropped } : {}),
      });
    },
  };

  const temporalAnnotationUpdateSchema = z
    .object({
      annotationId: temporalAnnotationId.describe(
        "The annotation id (from temporal_query; never a tp_ projection id).",
      ),
      when: z.string().min(1).optional().describe("New time (YYYY[-MM[-DD]] or ISO)."),
      until: z.string().min(1).optional().describe("New range end; pair with `when`."),
      sentence: z
        .string()
        .min(1)
        .max(2000)
        .optional()
        .describe(
          "New one-line meaning — states only what the source displays, scoped " +
            "to its section; never an exhaustive or negative claim inferred " +
            "from what a source fails to show.",
        ),
      kind: timeKind.optional().describe("New classification."),
      documentIds: idList.optional().describe("Replacement source document(s)."),
      loopIds: idList
        .optional()
        .describe("REPLACES the entry's open-loop backlinks (unknown ids dropped)."),
      personIds: idList
        .optional()
        .describe("REPLACES the entry's person backlinks (unresolved refs dropped)."),
      projectionIds: idList
        .refine((ids) => ids.every((id) => id.startsWith("tp_")), {
          message: "projectionIds must contain only tp_ projection ids",
        })
        .optional()
        .describe("REPLACES the source projections interpreted by this annotation."),
      evidence: timeEvidenceSchema
        .optional()
        .describe(
          "Grounding for a DOCUMENT-DERIVED edit: verified against the entry's " +
            "(new or standing) sentence at write time, then persisted as the " +
            "entry's grounding, REPLACING its previous evidence; the document " +
            "is also linked as a source. Survival across source-document edits " +
            "is checked against it. Omit for self-sourced edits.",
        ),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.until !== undefined && value.when === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["until"],
          message: "until requires when",
        });
      }
      if (
        value.when === undefined &&
        value.sentence === undefined &&
        value.kind === undefined &&
        value.documentIds === undefined &&
        value.loopIds === undefined &&
        value.personIds === undefined &&
        value.projectionIds === undefined &&
        value.evidence === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          message: "at least one annotation field must be updated",
        });
      }
    });
  const temporalAnnotationUpdate: ToolHandle = {
    name: "temporal_annotation_update",
    description:
      "Edit an LLM-owned temporal annotation. Deterministic temporal projections " +
      "are read-only and cannot be targeted by this tool. Only supplied fields " +
      "change; `documentIds` replaces the annotation's sources. The sentence " +
      "states only what the source displays, scoped to the section it appears " +
      "in — never an exhaustive or negative claim inferred from what a source " +
      "fails to show; pass `evidence` whenever the edit derives from a document.",
    schema: temporalAnnotationUpdateSchema,
    mutates: true,
    summarize: (args) => (args as { annotationId?: string })?.annotationId,
    async invoke(rawArgs, ctx): Promise<ToolResult> {
      const parsed = temporalAnnotationUpdateSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      const standing = getTemporalAnnotationById(db, a.annotationId);
      if (standing === null) return notFound("temporal annotation", a.annotationId);
      // The add tool's evidence requirement, carried through edits: setting
      // document links on an entry with no unbroken grounding atom must
      // supply evidence, or the edit would mint exactly the unverifiable
      // doc-linked shape temporal_annotation_add refuses. Entries with a
      // standing unbroken atom keep their grounding, so plain link edits
      // stay legal.
      if (
        a.documentIds !== undefined &&
        a.documentIds.length > 0 &&
        a.evidence === undefined &&
        !listTemporalAnnotationEvidence(db, a.annotationId).some((atom) => atom.brokenAt === null)
      ) {
        return {
          kind: "error",
          code: "invalid_args",
          message:
            "documentIds were supplied for an entry with no live grounding quote. " +
            "Pass evidence {docId, quote} with the link change: quote the verbatim " +
            "passage that establishes the sentence, so the entry can be checked " +
            "against future edits.",
        };
      }
      // The conditional teeth, against the sentence the entry will carry
      // after this edit (the new one when supplied, else the standing one).
      // The entry is ALWAYS resolved first — a dead or mistyped id refuses
      // cheaply here, never after burning an entailment-gate call on the
      // supplied evidence; the gate call comes last.
      if (a.evidence !== undefined) {
        const refusal = await vetTemporalAnnotationEvidence(
          deps,
          a.evidence,
          a.sentence ?? standing.sentence,
          clock(),
          ctx.abortSignal,
        );
        if (refusal !== null) return refusal;
      }
      const patch: {
        intervalStartMs?: number;
        intervalEndMs?: number;
        precision?: TemporalPrecision;
        canonical?: string;
        sentence?: string;
        kind?: string | null;
        documentIds?: string[];
        loopIds?: string[];
        personIds?: string[];
        projectionIds?: string[];
        evidence?: Array<{ docId: string; quote: string }>;
      } = {};
      if (a.when !== undefined) {
        const interval = resolveEntryInterval(a.when, a.until);
        if ("error" in interval)
          return { kind: "error", code: "invalid_args", message: interval.error };
        patch.intervalStartMs = interval.intervalStartMs;
        patch.intervalEndMs = interval.intervalEndMs;
        patch.precision = interval.precision;
        patch.canonical = interval.canonical;
      }
      // Moving an annotation must not strand links to projections that no
      // longer overlap it. A supplied list replaces the standing list; when
      // only the interval moves, revalidate the standing links.
      const projectionIdsToValidate =
        a.projectionIds ?? (a.when !== undefined ? standing.projectionIds : undefined);
      const invalidProjectionLinks = await validateProjectionLinks(
        projectionIdsToValidate,
        {
          intervalStartMs: patch.intervalStartMs ?? standing.intervalStartMs,
          intervalEndMs: patch.intervalEndMs ?? standing.intervalEndMs,
        },
        ctx.abortSignal,
      );
      if (invalidProjectionLinks !== null) return invalidProjectionLinks;
      if (a.sentence !== undefined) patch.sentence = a.sentence;
      if (a.kind !== undefined) patch.kind = a.kind;
      if (a.documentIds !== undefined) patch.documentIds = partitionDocIds(db, a.documentIds).known;
      if (a.loopIds !== undefined) patch.loopIds = partitionLoopIds(db, a.loopIds).known;
      if (a.personIds !== undefined) patch.personIds = partitionPersonRefs(db, a.personIds).known;
      if (a.projectionIds !== undefined) patch.projectionIds = a.projectionIds;
      // Vetted evidence re-grounds the entry: the store replaces the atom set
      // and unions the evidence doc into the entry's source links, so an edit
      // citing one new doc never silently drops the standing links.
      if (a.evidence !== undefined) {
        patch.evidence = [{ docId: a.evidence.docId, quote: a.evidence.quote }];
      }
      ctx.abortSignal?.throwIfAborted();
      const existed = await writeGate.updateTemporalAnnotation(a.annotationId, patch, clock());
      if (!existed) return notFound("temporal annotation", a.annotationId);
      log.info(`Cognition Steward run ${runId} updated temporal annotation ${a.annotationId}`);
      return ok("temporal_annotation.updated", { annotationId: a.annotationId });
    },
  };

  const temporalAnnotationDeleteSchema = z
    .object({
      annotationId: temporalAnnotationId.describe(
        "The annotation id to remove (from temporal_query; never a tp_ projection id).",
      ),
    })
    .strict();
  const temporalAnnotationDelete: ToolHandle = {
    name: "temporal_annotation_delete",
    description:
      "Remove an LLM-owned temporal annotation that is no longer valid. " +
      "Deterministic temporal projections are read-only and cannot be targeted.",
    schema: temporalAnnotationDeleteSchema,
    mutates: true,
    summarize: (args) => (args as { annotationId?: string })?.annotationId,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = temporalAnnotationDeleteSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const existed = await writeGate.invalidateTemporalAnnotation(
        parsed.data.annotationId,
        clock(),
      );
      if (!existed) return notFound("temporal annotation", parsed.data.annotationId);
      log.info(
        `Cognition Steward run ${runId} deleted temporal annotation ${parsed.data.annotationId}`,
      );
      return ok("temporal_annotation.deleted", {
        annotationId: parsed.data.annotationId,
      });
    },
  };

  return [
    openLoopSearch,
    openLoopFetch,
    openLoopCreate,
    openLoopUpdate,
    openLoopLedgerAppend,
    openLoopDelete,
    observationList,
    observationNote,
    observationWithdraw,
    notesAppend,
    notesRewrite,
    notesEdit,
    scheduleAgentRun,
    ...(deps.annotationsEnabled ? buildAnnotationTools(deps) : []),
    temporalAnnotationAdd,
    temporalAnnotationUpdate,
    temporalAnnotationDelete,
  ];
}

/** Dependencies of durable memory, independent of background cognition. */
export type AnnotationToolDeps = Pick<
  CognitionToolDeps,
  | "db"
  | "clock"
  | "runId"
  | "log"
  | "idGen"
  | "annotationConfidenceCeiling"
  | "annotationBasisCeilings"
  | "annotationConfidenceFloor"
  | "personProfileBudget"
  | "personProfileReads"
  | "getEntailmentVerifier"
  | "checkRecord"
  | "consumption"
  | "validateAnnotationEvidence"
> & {
  writeGate: Pick<
    CognitionWriteOps,
    | "createDocAnnotation"
    | "createDocAnnotationSuperseding"
    | "supersedeDocAnnotationBy"
    | "updateDocAnnotation"
    | "deleteDocAnnotation"
    | "createPersonAnnotation"
    | "createPersonAnnotationSuperseding"
    | "supersedePersonAnnotationBy"
    | "revisePersonAnnotation"
    | "retractPersonAnnotation"
  >;
};

/** Check every evidence atom before an asynchronous verifier or write. */
async function vetAnnotationSourceEvidence(
  deps: AnnotationToolDeps,
  atoms: readonly AnnotationEvidenceInput[],
): Promise<ToolResult | null> {
  if (!deps.validateAnnotationEvidence) return null;
  for (const atom of atoms) {
    const refusal = await deps.validateAnnotationEvidence(atom.docId, atom.quote);
    if (refusal) return { kind: "error", ...refusal };
  }
  return null;
}

/** Shared evidence-grounded document/person memory tools, with no Brain runtime. */
export function buildAnnotationTools(deps: AnnotationToolDeps): ToolHandle[] {
  const { db, writeGate, clock, runId, log } = deps;
  const idGen = deps.idGen ?? (() => randomUUID());
  const personProfiles = deps.personProfileReads ?? new PersonProfileReads(db);
  const personBudget = deps.personProfileBudget ?? DEFAULT_PERSON_PROFILE_BUDGET;
  function profileRefusal(error: unknown): ToolResult | null {
    if (error instanceof KnowledgeStorageError)
      return { kind: "error", code: error.code, message: error.message };
    if (error instanceof Error && error.message.startsWith("Person profile changed"))
      return {
        kind: "error",
        code: "revision_conflict",
        message:
          "The person's profile changed; reread its complete current annotation_search pages before reconciling.",
      };
    if (error instanceof Error && error.message.startsWith("Person profile budget exceeded"))
      return {
        kind: "error",
        code: "profile_budget_exceeded",
        message:
          "The proposed fact exceeds the compact person-profile budget. Compare the complete profile; keep, merge, replace or omit facts by usefulness. A supported supersedes replacement can shrink a legacy oversized profile. Do not invent a replacement or pad evidence to fit.",
      };
    return null;
  }
  function readProfile<T>(
    read: () => T,
  ): { value: T; refusal: null } | { value: null; refusal: ToolResult } {
    try {
      return { value: read(), refusal: null };
    } catch (error) {
      const refusal = profileRefusal(error);
      if (refusal === null) throw error;
      return { value: null, refusal };
    }
  }
  async function writeProfile<T>(
    write: () => Promise<T>,
  ): Promise<{ value: T; refusal: null } | { value: null; refusal: ToolResult }> {
    try {
      return { value: await write(), refusal: null };
    } catch (error) {
      const refusal = profileRefusal(error);
      if (refusal === null) throw error;
      return { value: null, refusal };
    }
  }
  function preflightProfile(
    personId: string,
    predecessors: readonly PersonAnnotationRow[],
    text: string,
  ) {
    return readProfile(() => {
      const before = getPersonProfileStats(db, personId);
      enforcePersonProfileBudget(
        before,
        {
          totalFacts: before.totalFacts - predecessors.length + 1,
          totalCharacters:
            before.totalCharacters -
            predecessors.reduce((sum, row) => sum + Array.from(row.claimText).length, 0) +
            Array.from(text).length,
        },
        personBudget,
      );
    }).refusal;
  }

  // ---- annotate_durable ----
  // Shared by interactive memory and the enabled background annotation layer;
  // the evidence firewall ("hints, then reground") is enforced here.
  const annotateDurableSchema = z
    .object({
      docId: z.string().min(1).describe("The document this observation is about."),
      claimType: claimTypeField.describe(
        'Short kind of claim, e.g. "topic", "entity-role", "commitment-status", "key-date".',
      ),
      claimText: z
        .string()
        .min(1)
        .max(1000)
        .describe(
          'The observation itself, concise — stating ONLY what the evidence establishes; never upgrade a quote/estimate/application/intention into a possession or completed fact (a price quote supports "requested a quote", not "holds").',
        ),
      evidenceDocId: z
        .string()
        .min(1)
        .describe("Document id the claim is grounded in — an immutable source atom."),
      evidenceQuote: z
        .string()
        .min(12)
        .max(500)
        .describe(
          "A VERBATIM quote (a substantive span, not a stray word) from evidenceDocId that supports the FULL claim — not merely mentions its topic; a quote showing a request, estimate, or application supports only that, never a completed fact.",
        ),
      confidence: fraction.describe("Confidence in the claim (0-1; capped below certainty)."),
      claimBasis: claimBasisEnum.describe(
        "How far the claim reasons from its evidence: 'quoted' = the evidence essentially states the claim (a restatement); 'inferred' = one licensed deduction from this single source; 'synthesized' = assembled across sources — a pattern no single quote states. Confidence is capped tighter the further down this ladder the claim sits.",
      ),
      supersedes: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Id of a LIVE annotation on this SAME document that this claim REPLACES (an updated or corrected belief) — it is retired the moment this one persists, audit-linked to its successor.",
        ),
      additionalEvidence: additionalEvidenceField
        .optional()
        .describe(
          "Further grounding atoms beside the primary evidenceDocId/evidenceQuote pair — a synthesized claim should cite EACH source it rests on. Every atom gets the same teeth (real document, verbatim quote), and the entailment gate judges the claim against all quotes jointly.",
        ),
    })
    .strict();
  const annotateDurable: ToolHandle = {
    name: "annotate_durable",
    description:
      "Persist a durable, evidence-grounded observation about a document as a " +
      "PRIOR future runs can read (a topic, an entity's role, a commitment's " +
      "status, a key date). The evidence firewall is enforced: the claim MUST " +
      "quote verbatim source text from an existing document, and its recorded " +
      "confidence is capped below certainty. One belief per (document, " +
      "claimType): when a live annotation of the same claimType already covers " +
      "this document, the create is refused and the candidates returned — " +
      "revise that one, or re-call with supersedes:<id> to replace it. " +
      "Annotations are hints to be re-grounded, never facts — never ground one " +
      "only in your own prior annotations.",
    schema: annotateDurableSchema,
    mutates: true,
    summarize: (args) => (args as { claimType?: string })?.claimType,
    async invoke(rawArgs, ctx): Promise<ToolResult> {
      const parsed = annotateDurableSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      const payloadCapture = captureRecordCheckPayload(deps, [
        a.docId,
        a.evidenceDocId,
        ...(a.additionalEvidence ?? []).map((atom) => atom.docId),
      ]);
      // Firewall 1: both the subject and the grounding atom must be real docs
      // (grounding on a document, never another annotation — no compounding).
      if (!docExists(db, a.docId)) return notFound("document", a.docId);
      const evidence = fetchEvidenceDoc(db, a.evidenceDocId);
      if (evidence === null) return notFound("evidence document", a.evidenceDocId);
      // Firewall 2: the evidence must be a real source document, never one of
      // generated synthesis mirror docs — grounding on your own
      // tracked state is exactly the self-reference the firewall forbids.
      if (evidence.generated) {
        return {
          kind: "error",
          code: "invalid_evidence",
          message:
            "evidenceDocId is a generated synthesis record, not a source document — " +
            "ground the observation on the original source, not your own tracked state",
        };
      }
      // Firewall 3 (the reground teeth): the quote must appear in the cited doc.
      if (!quoteInEvidence(evidence, a.evidenceQuote)) {
        return {
          kind: "error",
          code: "evidence_not_found",
          message:
            "evidenceQuote was not found in evidenceDocId — quote the source text " +
            "exactly (whitespace-insensitive; curly/straight quotes and dash " +
            "variants are also normalized — other punctuation must match the " +
            "source exactly); an annotation must rest on what the document " +
            "actually says",
        };
      }
      // The same cheap teeth over every ADDITIONAL grounding atom — all items
      // checked before any verifier call; a refusal names the failing index.
      const additional = a.additionalEvidence ?? [];
      const additionalRefusal = vetAdditionalEvidence(db, additional);
      if (additionalRefusal !== null) return additionalRefusal;
      const sourceRefusal = await vetAnnotationSourceEvidence(deps, [
        { docId: a.evidenceDocId, quote: a.evidenceQuote },
        ...additional,
      ]);
      if (sourceRefusal !== null) return sourceRefusal;
      // Firewall 4: cap confidence below certainty — the per-basis ceiling
      // (tighter the further the claim reasons from its evidence), then the
      // global hard cap.
      const { confidence, ceiling } = clampConfidence(deps, a.claimBasis, a.confidence);
      // Abstention floor: a claim this weak after clamping is refused outright
      // — the agent should corroborate it or drop it, not persist it.
      const floor = deps.annotationConfidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
      if (confidence < floor) return insufficientConfidence(confidence, floor);
      // Reconcile-before-create: a claim that would sit beside a live
      // same-claimType belief must either supersede it explicitly or be
      // refused with the standing candidates (never a silent contradiction).
      // Pure SQL, deliberately ahead of the model-backed entailment gate so a
      // routine refusal never spends a verifier call.
      if (a.supersedes !== undefined) {
        const target = getDocAnnotation(db, a.supersedes);
        if (target === null) {
          return invalidSupersede(
            `annotation ${a.supersedes} does not exist in the document store`,
          );
        }
        if (target.invalidatedAt !== null) {
          return invalidSupersede(`annotation ${a.supersedes} is no longer live`);
        }
        if (target.docId !== a.docId) {
          return invalidSupersede(
            `annotation ${a.supersedes} is about document ${target.docId}, not ${a.docId}`,
          );
        }
      }
      // The one-belief invariant holds through BOTH doors: with no supersedes,
      // any standing same-claimType belief refuses the create; with one, any
      // same-claimType belief OTHER than the supersede target still refuses —
      // retiring one belief must not slip the new claim in beside another.
      // The target's own claimType is deliberately unconstrained: replacing a
      // belief under a refined claimType is a legitimate revision. Matching is
      // SQL over ALL live rows on the subject (case-insensitive), so a
      // standing belief can't escape behind newer rows.
      const standing = listLiveSameClaimTypeAnnotationsForDoc(db, a.docId, a.claimType, {
        limit: CONFLICT_PROBE_LIMIT,
        ...(a.supersedes !== undefined ? { excludeId: a.supersedes } : {}),
      });
      if (standing.length > 0) {
        return annotationConflictRefusal(
          "annotation.conflict_candidates",
          standing,
          CREATE_CONFLICT_GUIDANCE,
        );
      }
      ctx.abortSignal?.throwIfAborted();
      const atoms = [{ docId: a.evidenceDocId, quote: a.evidenceQuote }, ...additional];
      const sourceVersions = new Map(
        [a.docId, ...atoms.map((atom) => atom.docId)].map((id) => [
          id,
          readKnowledgeSourceRevision(db, id),
        ]),
      );
      const id = `anno_${idGen()}`;
      if (a.supersedes === undefined) {
        // Marginal-value checks need the subject, not merely a supporting
        // quote. Read only safe original sources; unavailable context leaves
        // this relevance gate open without sending source text to the model.
        let documentContext;
        if (
          deps.checkRecord &&
          (deps.checkRecord.needsDocumentContext?.() ?? true) &&
          isKnowledgeEvidenceReadable(db, a.docId)
        ) {
          const subject = fetchEvidenceDoc(db, a.docId);
          const atoms = [{ docId: a.evidenceDocId, quote: a.evidenceQuote }, ...additional];
          const currentAtomsReadable = () =>
            atoms.every((atom) => {
              if (!isKnowledgeEvidenceReadable(db, atom.docId)) return false;
              const current = fetchEvidenceDoc(db, atom.docId);
              return current !== null && quoteInEvidence(current, atom.quote);
            });
          if (subject && !subject.generated && currentAtomsReadable()) {
            const subjectRefusal = await vetAnnotationSourceEvidence(deps, [
              { docId: a.docId, quote: subject.content },
            ]);
            if (
              subjectRefusal === null &&
              isKnowledgeEvidenceReadable(db, a.docId) &&
              fetchEvidenceDoc(db, a.docId)?.contentHash === subject.contentHash &&
              currentAtomsReadable()
            ) {
              documentContext = documentRecordContext(a.docId, subject.content, atoms);
            }
          }
        }
        const dropped = await recordCheckRefusal(
          deps,
          {
            recordId: id,
            record: { type: "doc-fact", kind: a.claimType, text: a.claimText },
            documentId: a.docId,
            ...(payloadCapture ? { payloadCapture } : {}),
            ...(documentContext ? { documentContext } : {}),
          },
          ctx.abortSignal,
        );
        if (dropped !== null) return dropped;
      }
      ctx.abortSignal?.throwIfAborted();
      // The value check awaits a remote decision. Recheck authority before
      // exposing evidence to another model, even when the eventual writer
      // would reject the stale source snapshot.
      const currentSourceRefusal = await vetAnnotationSourceEvidence(deps, atoms);
      if (currentSourceRefusal) return currentSourceRefusal;
      ctx.abortSignal?.throwIfAborted();
      if (
        [...sourceVersions].some(
          ([id, version]) =>
            !isKnowledgeEvidenceReadable(db, id) || readKnowledgeSourceRevision(db, id) !== version,
        ) ||
        atoms.some((atom) => {
          const current = fetchEvidenceDoc(db, atom.docId);
          return !current || current.generated || !quoteInEvidence(current, atom.quote);
        })
      ) {
        return {
          kind: "error",
          code: "revision_conflict",
          message:
            "Annotation source evidence changed during value assessment; reread the current sources and reconcile before retrying.",
        };
      }
      // Firewall 5 (the entailment gate): the evidence must ESTABLISH the
      // claim, not merely appear in the documents — ONE call judging the
      // claim against the CONCATENATED quotes (a multi-atom grounding is
      // judged jointly, preserving each clause’s factual scope).
      const gate = await runEntailmentGate(
        deps,
        {
          claim: a.claimText,
          context: annotationVerificationContext("doc_annotation"),
          assessment: "annotation_atomic",
          evidence: annotationGateEvidence(db, [
            { docId: a.evidenceDocId, quote: a.evidenceQuote },
            ...additional,
          ]),
        },
        clock(),
        ctx.abortSignal,
      );
      if (gate.kind === "refused") return entailmentRefusal(gate.verdict, gate.assertions);
      ctx.abortSignal?.throwIfAborted();
      const input = {
        id,
        docId: a.docId,
        claimType: a.claimType,
        claimText: a.claimText,
        evidenceDocId: a.evidenceDocId,
        evidenceQuote: a.evidenceQuote,
        confidence,
        claimBasis: a.claimBasis,
        createdByRun: runId,
        verificationState: gate.state,
        lastVerifiedAt: gate.verifiedAt,
        ...(additional.length > 0 ? { additionalEvidence: additional } : {}),
      };
      // The superseding create is ONE writer op (create + retire in a single
      // transaction), so a crash can never leave both claims standing. The
      // retire half can still be LOST to a concurrent write (the target died
      // between the validation read above and the serialized write): the
      // create lands, but the result must say the supersede did not happen —
      // reporting `supersededId` then would hide a live duplicate.
      let annotation: DocAnnotationRow;
      let supersedeLost = false;
      if (a.supersedes !== undefined) {
        const res = await writeGate.createDocAnnotationSuperseding(input, a.supersedes, clock());
        annotation = res.annotation;
        supersedeLost = !res.superseded;
      } else {
        annotation = await writeGate.createDocAnnotation(input, clock());
      }
      if (supersedeLost) {
        log.warn(
          `Cognition Steward run ${runId} created annotation ${annotation.id} but lost the supersede of ${a.supersedes} to a concurrent write`,
        );
      }
      deps.consumption?.note("doc", [annotation.id]);
      log.info(
        `Cognition Steward run ${runId} annotated doc ${a.docId} (${a.claimType})` +
          (a.supersedes !== undefined && !supersedeLost ? ` superseding ${a.supersedes}` : ""),
      );
      return ok("annotation.created", {
        id: annotation.id,
        docId: annotation.docId,
        claimType: annotation.claimType,
        confidence: annotation.confidence,
        claimBasis: annotation.claimBasis,
        ...(additional.length > 0 ? { evidenceCount: 1 + additional.length } : {}),
        ...(a.supersedes !== undefined && !supersedeLost ? { supersededId: a.supersedes } : {}),
        ...(supersedeLost ? { supersedeLost: true, guidance: SUPERSEDE_LOST_GUIDANCE } : {}),
        ...(confidence < a.confidence ? { confidenceCappedTo: ceiling } : {}),
      });
    },
  };

  // ---- annotation_revise ----
  // Re-word / re-confidence an existing prior. The evidence firewall is
  // re-checked (the grounding quote must still appear in the — possibly
  // changed — cited doc) and confidence re-capped, so a revise can never
  // launder a stale prior back to certainty. Evidence is immutable here.
  const annotationReviseSchema = z
    .object({
      id: z.string().min(1).describe("The annotation id to revise (from your priors)."),
      claimType: claimTypeField.optional().describe("New claim kind, if changing."),
      claimText: z.string().min(1).max(1000).optional().describe("Revised observation."),
      confidence: fraction.optional().describe("Revised confidence (0-1; capped below certainty)."),
      claimBasis: claimBasisEnum
        .optional()
        .describe("Re-declared claim basis (quoted | inferred | synthesized), if changing."),
    })
    .strict()
    .refine(
      (a) =>
        a.claimType !== undefined ||
        a.claimText !== undefined ||
        a.confidence !== undefined ||
        a.claimBasis !== undefined,
      { message: "supply at least one of claimType, claimText, confidence, claimBasis" },
    );
  const annotationRevise: ToolHandle = {
    name: "annotation_revise",
    description:
      "Revise a durable observation you recorded earlier — its wording, kind, or " +
      "confidence — when a later read changes your understanding. The evidence " +
      "firewall is re-checked: the annotation's original grounding quote must " +
      "still appear in its cited document, and confidence stays capped below " +
      "certainty. To change the grounding itself, retract and re-annotate.",
    schema: annotationReviseSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = annotationReviseSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      const existing = getDocAnnotation(db, a.id);
      if (existing === null) return notFound("annotation", a.id);
      // Firewall re-check: the immutable grounding must still hold. The evidence
      // doc may have been deleted (cascade) or changed under it.
      const evidence = fetchEvidenceDoc(db, existing.evidenceDocId);
      if (evidence === null) return notFound("evidence document", existing.evidenceDocId);
      if (!quoteInEvidence(evidence, existing.evidenceQuote)) {
        return {
          kind: "error",
          code: "evidence_not_found",
          message:
            "the annotation's grounding quote is no longer present in its cited " +
            "document — retract this prior and re-annotate against the current source",
        };
      }
      // Re-clamp under the EFFECTIVE basis (re-declared when given, standing
      // otherwise): a basis downgrade pulls the standing confidence under its
      // tighter ceiling even when no new confidence was supplied. The floor
      // refuses only a revise that genuinely LOWERS confidence below it (a
      // retract in disguise) — an edit that leaves a legacy sub-floor row no
      // weaker than it already was passes, whichever fields it touches, so
      // whether a row can be edited never flips on a no-op re-declaration.
      let cappedTo: number | undefined;
      let clampedConfidence: number | undefined;
      if (a.confidence !== undefined || a.claimBasis !== undefined) {
        const basis = a.claimBasis ?? existing.claimBasis;
        const requested = a.confidence ?? existing.confidence;
        const { confidence, ceiling } = clampConfidence(deps, basis, requested);
        if (confidence < requested) cappedTo = ceiling;
        const floor = deps.annotationConfidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
        if (confidence < floor && confidence < existing.confidence) {
          return retractInsteadOfWeakRevise(confidence, floor);
        }
        if (a.confidence !== undefined || confidence !== existing.confidence) {
          clampedConfidence = confidence;
        }
      }
      // A claimType change re-keys the belief, so it runs the same standing
      // same-claimType probe as a create (excluding the revised row itself):
      // revising into a slot a live claim already occupies would mint the very
      // same-subject contradiction the create door refuses. A probe-clean
      // refinement stays legal. Pure SQL, ahead of the entailment gate.
      if (a.claimType !== undefined && !claimTypeEquals(a.claimType, existing.claimType)) {
        const standing = listLiveSameClaimTypeAnnotationsForDoc(db, existing.docId, a.claimType, {
          excludeId: a.id,
          limit: CONFLICT_PROBE_LIMIT,
        });
        if (standing.length > 0) {
          return annotationConflictRefusal(
            "annotation.conflict_candidates",
            standing,
            reviseConflictGuidance("annotation_supersede"),
          );
        }
      }
      // The entailment gate re-judges the EFFECTIVE claim (revised wording when
      // given, the standing wording otherwise) against the annotation's FULL
      // live evidence set, concatenated exactly as the create gate judged it —
      // a synthesized claim whose atoms only jointly entail it must remain
      // re-affirmable. Scalar-mirror fallback covers a row with no atom rows.
      const atoms = listDocAnnotationEvidence(db, a.id);
      const sourceRefusal = await vetAnnotationSourceEvidence(
        deps,
        atoms.length
          ? atoms.map((atom) => ({ docId: atom.evidenceDocId, quote: atom.evidenceQuote }))
          : [{ docId: existing.evidenceDocId, quote: existing.evidenceQuote }],
      );
      if (sourceRefusal !== null) return sourceRefusal;
      const gate = await runEntailmentGate(
        deps,
        {
          claim: a.claimText ?? existing.claimText,
          context: annotationVerificationContext("doc_annotation"),
          assessment: "annotation_atomic",
          evidence: annotationGateEvidence(
            db,
            atoms.length > 0
              ? atoms.map((e) => ({ docId: e.evidenceDocId, quote: e.evidenceQuote }))
              : [{ docId: existing.evidenceDocId, quote: existing.evidenceQuote }],
          ),
        },
        clock(),
      );
      if (gate.kind === "refused") return entailmentRefusal(gate.verdict, gate.assertions);
      const patch: UpdateDocAnnotationPatch = {};
      if (gate.state !== null) {
        patch.verificationState = gate.state;
        patch.lastVerifiedAt = gate.verifiedAt;
      } else {
        // No verifier configured (state null): the quote firewall above still
        // mechanically re-checked the evidence, so a successful revise counts
        // as a re-grounding — advance the last-checked stamp (otherwise the
        // row would stay permanently due under the re-verification sweep)
        // while leaving the verification STATE to a configured verifier.
        patch.lastVerifiedAt = clock();
      }
      if (a.claimType !== undefined) patch.claimType = a.claimType;
      if (a.claimText !== undefined) patch.claimText = a.claimText;
      if (a.claimBasis !== undefined) patch.claimBasis = a.claimBasis;
      if (clampedConfidence !== undefined) patch.confidence = clampedConfidence;
      const revised = await writeGate.updateDocAnnotation(a.id, patch, clock());
      if (revised === null) return notFound("annotation", a.id);
      log.info(`Cognition Steward run ${runId} revised annotation ${a.id}`);
      return ok("annotation.revised", {
        id: revised.id,
        claimType: revised.claimType,
        confidence: revised.confidence,
        claimBasis: revised.claimBasis,
        ...(cappedTo !== undefined ? { confidenceCappedTo: cappedTo } : {}),
      });
    },
  };

  // ---- annotation_retract ----
  const annotationRetractSchema = z
    .object({ id: z.string().min(1).describe("The annotation id whose belief is withdrawn.") })
    .strict();
  const annotationRetract: ToolHandle = {
    name: "annotation_retract",
    description:
      "Withdraw a durable observation you recorded earlier " +
      "when it is wrong or no longer relevant — a mistaken read, a superseded " +
      "conclusion. It leaves active memory; retained synthesis is marked withdrawn and dependents require repair. Privacy deletion is a separate source-removal action.",
    schema: annotationRetractSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = annotationRetractSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const removed = await writeGate.deleteDocAnnotation(parsed.data.id, clock());
      if (!removed) return notFound("annotation", parsed.data.id);
      log.info(`Cognition Steward run ${runId} retracted annotation ${parsed.data.id}`);
      return ok("annotation.retracted", { id: parsed.data.id });
    },
  };

  // ---- annotation_supersede ----
  // Pure belief retirement — no create: retire an outdated live annotation in
  // favour of another EXISTING live annotation on the same document. This is
  // the contradiction repair that CONVERGES to one live belief (re-issuing
  // via annotate_durable + supersedes always mints a new row).
  const annotationSupersedeSchema = z
    .object({
      id: z.string().min(1).describe("The OUTDATED live annotation to retire."),
      supersededBy: z
        .string()
        .min(1)
        .describe(
          "The EXISTING live annotation on the SAME document that replaces it (no new row is created).",
        ),
    })
    .strict();
  const annotationSupersede: ToolHandle = {
    name: "annotation_supersede",
    description:
      "Retire an outdated live annotation in favour of another EXISTING live " +
      "annotation on the SAME document — belief revision with no new row. The " +
      "retired claim keeps an audit link to its successor. Use this when two " +
      "live claims disagree and one is simply right: keep it, supersede the " +
      "other. To replace a claim with a NEW corrected claim, use " +
      "annotate_durable with supersedes instead.",
    schema: annotationSupersedeSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = annotationSupersedeSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      if (a.id === a.supersededBy) {
        return invalidPureSupersede(`annotation ${a.id} cannot supersede itself`);
      }
      const target = getDocAnnotation(db, a.id);
      if (target === null) return notFound("annotation", a.id);
      if (target.invalidatedAt !== null) {
        return invalidPureSupersede(`annotation ${a.id} is no longer live`);
      }
      const successor = getDocAnnotation(db, a.supersededBy);
      if (successor === null) {
        return invalidPureSupersede(
          `annotation ${a.supersededBy} does not exist in the document store`,
        );
      }
      if (successor.invalidatedAt !== null) {
        return invalidPureSupersede(`annotation ${a.supersededBy} is no longer live`);
      }
      if (successor.docId !== target.docId) {
        return invalidPureSupersede(
          `annotation ${a.supersededBy} is about document ${successor.docId}, not ${target.docId}`,
        );
      }
      // Liveness is re-checked inside the serialized write; a row that died
      // between the reads above and the write comes back un-superseded.
      const { superseded } = await writeGate.supersedeDocAnnotationBy(
        a.id,
        a.supersededBy,
        clock(),
      );
      if (!superseded) {
        log.warn(
          `Cognition Steward run ${runId} lost the supersede of annotation ${a.id} to a concurrent write`,
        );
        return {
          kind: "error",
          code: "supersede_lost",
          message: SUPERSEDE_LOST_GUIDANCE,
        };
      }
      log.info(`Cognition Steward run ${runId} superseded annotation ${a.id} → ${a.supersededBy}`);
      return ok("annotation.superseded", { id: a.id, supersededBy: a.supersededBy });
    },
  };

  // ---- annotation_search ----
  // The read half of the annotation memory: list the LIVE priors already
  // recorded about one subject (a document or a person), each with its
  // evidence pointer so the reader can re-ground before asserting. This is
  // how a run checks what it already believes — to reconcile, revise, or
  // supersede instead of re-deriving or duplicating.
  const annotationSearchSchema = z
    .object({
      docId: z.string().min(1).optional().describe("List annotations ABOUT this document."),
      personId: z
        .string()
        .min(1)
        .optional()
        .describe("List annotations ABOUT this person — a person id or a known email."),
      limit: z.number().int().min(1).max(50).optional().describe("Max rows (default 20)."),
      cursor: z
        .string()
        .min(1)
        .max(2048)
        .optional()
        .describe(
          "For a person's profile, copy the exact nextCursor from the preceding page; omit it to start a complete read.",
        ),
    })
    .strict()
    .refine((a) => (a.docId !== undefined) !== (a.personId !== undefined), {
      message: "supply exactly one of docId or personId",
    })
    .refine((a) => a.cursor === undefined || a.personId !== undefined, {
      message: "cursor is supported only for a person profile",
    });
  const annotationSearch: ToolHandle = {
    name: "annotation_search",
    description:
      "List the durable annotations already recorded about ONE subject — a " +
      "document (docId) or a person (personId). Read this BEFORE recording a " +
      "new observation on the same subject: revise or supersede an existing " +
      "claim instead of duplicating or contradicting it. Each row carries its " +
      "evidence doc id and verbatim quote — priors to re-ground, never facts. " +
      "Person results page the complete readable profile, with totals and its compact budget. " +
      "Follow every exact nextCursor before creating, consolidating or revising a person fact; " +
      "compare the whole profile and keep the most useful supported context, not the first page.",
    schema: annotationSearchSchema,
    mutates: false,
    summarize: (args) =>
      (args as { docId?: string; personId?: string })?.docId ??
      (args as { docId?: string; personId?: string })?.personId,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = annotationSearchSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      const limit = a.limit ?? 20;
      const project = (
        rows: ReadonlyArray<{
          id: string;
          claimType: string;
          claimText: string;
          evidenceDocId: string;
          evidenceQuote: string;
          confidence: number;
          createdAt: number;
        }>,
      ) =>
        rows.map((r) => ({
          id: r.id,
          claimType: r.claimType,
          claimText: r.claimText,
          evidenceDocId: r.evidenceDocId,
          evidenceQuote: r.evidenceQuote,
          confidence: r.confidence,
          createdAt: new Date(r.createdAt).toISOString(),
        }));
      if (a.docId !== undefined) {
        if (!docExists(db, a.docId)) return notFound("document", a.docId);
        const rows = listLiveAnnotationsForDoc(db, a.docId, limit);
        // Consumption provenance: these priors are now in front of the model.
        deps.consumption?.note(
          "doc",
          rows.map((r) => r.id),
        );
        return ok("annotation.search_results", {
          docId: a.docId,
          annotations: project(rows),
        });
      }
      const personId = resolveLoopPersonRef(db, a.personId ?? "");
      if (personId === null) return notFound("person", a.personId ?? "");
      const reading = readProfile(() =>
        personProfiles.page(personId, limit, a.cursor, personBudget),
      );
      if (reading.refusal !== null) return reading.refusal;
      const page = reading.value;
      const rows = page.annotations;
      deps.consumption?.note(
        "person",
        rows.map((r) => r.id),
      );
      return ok("annotation.search_results", page);
    },
  };

  // ---- annotate_person ----
  // Person-keyed sibling of annotate_durable. Same evidence firewall (real
  // evidence doc, verbatim quote, confidence ceiling, no self-grounding on a
  // generated synthesis mirror), but the subject is a PERSON resolved to its
  // canonical id — not a document.
  const annotatePersonSchema = z
    .object({
      personId: z
        .string()
        .min(1)
        .describe(
          "The person this observation is about — a person id (from lookup_people) or a known email.",
        ),
      claimType: claimTypeField.describe(
        'Short kind of claim, e.g. "role", "relationship", "preference", "affiliation".',
      ),
      claimText: z
        .string()
        .min(1)
        .max(1000)
        .describe(
          'The observation itself, concise — stating ONLY what the evidence establishes; never upgrade a quote/estimate/application/intention into a possession or completed fact (a price quote supports "requested a quote", not "holds").',
        ),
      evidenceDocId: z
        .string()
        .min(1)
        .describe("Document id the claim is grounded in — an immutable source atom."),
      evidenceQuote: z
        .string()
        .min(12)
        .max(500)
        .describe(
          "A VERBATIM quote from evidenceDocId that supports the FULL claim — not merely mentions its topic; a quote showing a request, estimate, or application supports only that, never a completed fact.",
        ),
      confidence: fraction.describe("Confidence in the claim (0-1; capped below certainty)."),
      claimBasis: claimBasisEnum.describe(
        "How far the claim reasons from its evidence: 'quoted' = the evidence essentially states the claim (a restatement); 'inferred' = one licensed deduction from this single source; 'synthesized' = assembled across sources — a pattern no single quote states. Confidence is capped tighter the further down this ladder the claim sits.",
      ),
      supersedes: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(128)])
        .optional()
        .describe(
          "Id or bounded array of LIVE annotations on this SAME person that this supported fact REPLACES. Read the complete profile first; replacement and all retirements commit atomically. Consolidate redundant observations into one useful grounded fact, preserving the scope established by its sources; do not combine unrelated facts merely to fit the budget.",
        ),
      reconciliationReason: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .optional()
        .describe(
          "For replacement, explain useful older scope retained and intentional editorial omissions (duplicate, outdated or low-value details). Do not claim separate dated observations establish a continuous period. This rationale is checked, not authority to discard useful scope.",
        ),
      additionalEvidence: additionalEvidenceField
        .optional()
        .describe(
          "Further grounding atoms beside the primary evidenceDocId/evidenceQuote pair — a synthesized claim should cite EACH source it rests on. Every atom gets the same teeth (real document, verbatim quote), and the entailment gate judges the claim against all quotes jointly.",
        ),
    })
    .strict();
  const annotatePerson: ToolHandle = {
    name: "annotate_person",
    description:
      "Persist a durable, evidence-grounded observation about a PERSON as a " +
      "PRIOR future runs can read (a role, a relationship, a stable preference or standing responsibility). " +
      "A one-off message or event summary merely involving the person is not person-profile context. " +
      "The evidence firewall is enforced exactly as annotate_durable: the claim " +
      "MUST quote verbatim source text from an existing document, its recorded " +
      "confidence is capped below certainty, and it cannot be grounded on your " +
      "own derived state. One belief per (person, claimType): when a live " +
      "annotation of the same claimType already covers this person, the create " +
      "is refused and the candidates returned — revise that one, or re-call " +
      "with supersedes:<id> to replace it. Annotations are hints to be " +
      "re-grounded, never facts.",
    schema: annotatePersonSchema,
    mutates: true,
    summarize: (args) => (args as { claimType?: string })?.claimType,
    async invoke(rawArgs, ctx): Promise<ToolResult> {
      const parsed = annotatePersonSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      const payloadGeneration = decisionPayloadErasureGeneration(db);
      const supersedes =
        a.supersedes === undefined
          ? []
          : typeof a.supersedes === "string"
            ? [a.supersedes]
            : [...new Set(a.supersedes)];
      // Firewall 1 (person side): the subject must resolve to a known person
      // (walks merge chains / resolves an email through aliases). Unknown → 404.
      const personId = resolveLoopPersonRef(db, a.personId);
      if (personId === null) return notFound("person", a.personId);
      // Firewall 2: the grounding atom must be a real source document.
      const evidence = fetchEvidenceDoc(db, a.evidenceDocId);
      if (evidence === null) return notFound("evidence document", a.evidenceDocId);
      // Firewall 3: never ground on a generated synthesis mirror doc.
      if (evidence.generated) {
        return {
          kind: "error",
          code: "invalid_evidence",
          message:
            "evidenceDocId is a generated synthesis record, not a source document — " +
            "ground the observation on the original source, not your own tracked state",
        };
      }
      // Firewall 4 (reground teeth): the quote must appear in the cited doc.
      if (!quoteInEvidence(evidence, a.evidenceQuote)) {
        return {
          kind: "error",
          code: "evidence_not_found",
          message:
            "evidenceQuote was not found in evidenceDocId — quote the source text " +
            "exactly (whitespace-insensitive; curly/straight quotes and dash " +
            "variants are also normalized — other punctuation must match the " +
            "source exactly)",
        };
      }
      // The same cheap teeth over every ADDITIONAL grounding atom — all items
      // checked before any verifier call; a refusal names the failing index.
      const additional = a.additionalEvidence ?? [];
      const additionalRefusal = vetAdditionalEvidence(db, additional);
      if (additionalRefusal !== null) return additionalRefusal;
      const sourceRefusal = await vetAnnotationSourceEvidence(deps, [
        { docId: a.evidenceDocId, quote: a.evidenceQuote },
        ...additional,
      ]);
      if (sourceRefusal !== null) return sourceRefusal;
      // Firewall 5: cap confidence below certainty — the per-basis ceiling,
      // then the global hard cap.
      const { confidence, ceiling } = clampConfidence(deps, a.claimBasis, a.confidence);
      // Abstention floor: refuse a claim too weak to be worth keeping.
      const floor = deps.annotationConfidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
      if (confidence < floor) return insufficientConfidence(confidence, floor);
      // Reconcile-before-create (as annotate_durable): pure SQL, deliberately
      // ahead of the model-backed entailment gate so a routine refusal never
      // spends a verifier call. The subject compare is over CANONICAL person
      // ids: an annotation authored against a since-merged-away id still names
      // the same person, so its subject resolves through the merge chain
      // before the match.
      const predecessors: PersonAnnotationRow[] = [];
      for (const predecessor of supersedes) {
        const target = getPersonAnnotation(db, predecessor);
        if (target === null) {
          return invalidSupersede(`annotation ${predecessor} does not exist in the person store`);
        }
        if (target.invalidatedAt !== null) {
          return invalidSupersede(`annotation ${predecessor} is no longer live`);
        }
        predecessors.push(target);
        const targetCanonical = resolveLoopPersonRef(db, target.personId) ?? target.personId;
        if (targetCanonical !== personId) {
          return invalidSupersede(
            `annotation ${predecessor} is about person ${targetCanonical}, not ${personId}`,
          );
        }
      }
      // The one-belief invariant holds through BOTH doors: with no supersedes,
      // any standing same-claimType belief refuses the create; with one, any
      // same-claimType belief OTHER than the supersede target still refuses —
      // retiring one belief must not slip the new claim in beside another.
      // The target's own claimType is deliberately unconstrained: replacing a
      // belief under a refined claimType is a legitimate revision. Matching is
      // SQL over ALL live rows in the person's merge equivalence class
      // (case-insensitive), so a standing belief can't escape behind newer rows.
      const standing = listLiveSameClaimTypePersonAnnotations(db, personId, a.claimType, {
        limit: CONFLICT_PROBE_LIMIT + supersedes.length,
      })
        .filter((row) => !supersedes.includes(row.id))
        .slice(0, CONFLICT_PROBE_LIMIT);
      if (standing.length > 0) {
        return annotationConflictRefusal(
          "person_annotation.conflict_candidates",
          standing,
          CREATE_CONFLICT_GUIDANCE,
        );
      }
      const reading = readProfile(() => personProfiles.require(personId, personBudget));
      if (reading.refusal !== null) return reading.refusal;
      const profileBudget = reading.value;
      if (supersedes.length === 1) {
        const unchanged = readProfile(() =>
          findUnchangedPersonAnnotation(db, supersedes[0]!, { ...a, confidence }, profileBudget),
        );
        if (unchanged.refusal !== null) return unchanged.refusal;
        if (unchanged.value)
          return ok("person_annotation.unchanged", {
            id: unchanged.value.id,
            personId,
            unchanged: true,
            guidance:
              "This verified fact and its evidence already match. No replacement or verification refresh was written.",
          });
      }
      const budgetRefusal = preflightProfile(personId, predecessors, a.claimText);
      if (budgetRefusal !== null) return budgetRefusal;
      const id = `panno_${idGen()}`;
      const judging = db.transaction(() => {
        const profile = readPersonReconciliationContext(
          db,
          personId,
          supersedes,
          supersedes.length ? "replace" : "create",
          a.reconciliationReason,
        );
        const payloadCapture =
          deps.checkRecord && (deps.checkRecord.needsDocumentContext?.() ?? true)
            ? (captureDecisionPayloadSubjects(
                db,
                {
                  sourceIds: [
                    a.evidenceDocId,
                    ...additional.map((atom) => atom.docId),
                    ...profile.sourceIds,
                  ],
                  nodeIds: profile.nodeIds,
                },
                payloadGeneration,
              ) ?? undefined)
            : undefined;
        return {
          ...(payloadCapture
            ? {
                personContext: personRecordContext(
                  personId,
                  [{ docId: a.evidenceDocId, quote: a.evidenceQuote }, ...additional],
                  profile.reconciliation,
                ),
              }
            : {}),
          ...(payloadCapture ? { payloadCapture } : {}),
        };
      })();
      const dropped = await recordCheckRefusal(
        deps,
        {
          recordId: id,
          record: { type: "person-fact", kind: a.claimType, text: a.claimText },
          documentId: a.evidenceDocId,
          ...judging,
        },
        ctx.abortSignal,
      );
      if (dropped !== null) return dropped;
      // Firewall 6 (the entailment gate): the evidence must ESTABLISH the
      // claim — ONE call judging it against the CONCATENATED quotes (a
      // structured judgment preserves each clause’s factual scope).
      const gate = await runEntailmentGate(
        deps,
        {
          claim: a.claimText,
          context: annotationVerificationContext("person_annotation"),
          assessment: "annotation_atomic",
          evidence: annotationGateEvidence(db, [
            { docId: a.evidenceDocId, quote: a.evidenceQuote },
            ...additional,
          ]),
        },
        clock(),
      );
      if (gate.kind === "refused") return entailmentRefusal(gate.verdict, gate.assertions);
      const input = {
        id,
        personId,
        claimType: a.claimType,
        claimText: a.claimText,
        evidenceDocId: a.evidenceDocId,
        evidenceQuote: a.evidenceQuote,
        confidence,
        claimBasis: a.claimBasis,
        createdByRun: runId,
        verificationState: gate.state,
        lastVerifiedAt: gate.verifiedAt,
        ...(additional.length > 0 ? { additionalEvidence: additional } : {}),
      };
      // The superseding create is ONE writer op (create + retire atomically).
      // As annotate_durable: a retire half lost to a concurrent write must be
      // reported, never masked behind a `supersededId` echo.
      let annotation: PersonAnnotationRow;
      let supersedeLost = false;
      if (a.supersedes !== undefined) {
        const writing = await writeProfile(() =>
          writeGate.createPersonAnnotationSuperseding(input, a.supersedes!, clock(), profileBudget),
        );
        if (writing.refusal !== null) return writing.refusal;
        annotation = writing.value.annotation;
        supersedeLost = !writing.value.superseded;
      } else {
        const writing = await writeProfile(() =>
          writeGate.createPersonAnnotation(input, clock(), profileBudget),
        );
        if (writing.refusal !== null) return writing.refusal;
        annotation = writing.value;
      }
      if (supersedeLost) {
        log.warn(
          `Cognition Steward run ${runId} created person annotation ${annotation.id} but lost the supersede of ${a.supersedes} to a concurrent write`,
        );
      }
      deps.consumption?.note("person", [annotation.id]);
      log.info(
        `Cognition Steward run ${runId} annotated person ${personId} (${a.claimType})` +
          (a.supersedes !== undefined && !supersedeLost ? ` superseding ${a.supersedes}` : ""),
      );
      return ok("person_annotation.created", {
        id: annotation.id,
        personId: annotation.personId,
        claimType: annotation.claimType,
        confidence: annotation.confidence,
        claimBasis: annotation.claimBasis,
        ...(additional.length > 0 ? { evidenceCount: 1 + additional.length } : {}),
        ...(a.supersedes !== undefined && !supersedeLost
          ? typeof a.supersedes === "string"
            ? { supersededId: a.supersedes }
            : { supersededIds: supersedes }
          : {}),
        ...(supersedeLost ? { supersedeLost: true, guidance: SUPERSEDE_LOST_GUIDANCE } : {}),
        ...(confidence < a.confidence ? { confidenceCappedTo: ceiling } : {}),
      });
    },
  };

  // ---- person_annotation_revise / person_annotation_retract ----
  const personAnnotationReviseSchema = z
    .object({
      id: z.string().min(1).describe("Person-annotation id (panno_…)."),
      claimType: claimTypeField.optional(),
      claimText: z.string().min(1).max(1000).optional(),
      reconciliationReason: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .optional()
        .describe(
          "Explain retained useful scope and intentional editorial omissions when revising meaning. Separate dated observations do not establish continuous duration.",
        ),
      confidence: fraction.optional().describe("New confidence (still capped below certainty)."),
      claimBasis: claimBasisEnum
        .optional()
        .describe("Re-declared claim basis (quoted | inferred | synthesized), if changing."),
    })
    .strict()
    .refine(
      (a) =>
        a.claimType !== undefined ||
        a.claimText !== undefined ||
        a.confidence !== undefined ||
        a.claimBasis !== undefined,
      { message: "supply at least one of claimType, claimText, confidence, claimBasis" },
    );
  const personAnnotationRevise: ToolHandle = {
    name: "person_annotation_revise",
    description:
      "Revise a person annotation you previously recorded — refine its claim " +
      "text/type or lower its confidence. To re-verify unchanged grounding, supply only id and confidence (the current confidence is allowed). Replaying unchanged claim text does not refresh verification. The evidence grounding is immutable; " +
      "to re-ground on different quotes, use annotate_person with supersedes after reading the complete profile. Useful older scope must survive unless its omission is a justified editorial choice.",
    schema: personAnnotationReviseSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs, ctx): Promise<ToolResult> {
      const parsed = personAnnotationReviseSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { id, reconciliationReason, ...rest } = parsed.data;
      const payloadGeneration = decisionPayloadErasureGeneration(db);
      const existing = getPersonAnnotation(db, id);
      if (existing === null) return notFound("person annotation", id);
      // Firewall re-check (as annotation_revise): the immutable grounding must
      // still hold — the evidence doc may have been deleted or changed under it,
      // so a revise can never launder a stale prior back into circulation.
      const evidence = fetchEvidenceDoc(db, existing.evidenceDocId);
      if (evidence === null) return notFound("evidence document", existing.evidenceDocId);
      if (!quoteInEvidence(evidence, existing.evidenceQuote)) {
        return {
          kind: "error",
          code: "evidence_not_found",
          message:
            "the annotation's grounding quote is no longer present in its cited " +
            "document — retract this prior and re-annotate against the current source",
        };
      }
      // Re-clamp under the EFFECTIVE basis (as annotation_revise); a revise
      // landing below the floor is a retract in disguise — refuse and say so.
      let cappedTo: number | undefined;
      let clampedConfidence: number | undefined;
      if (rest.confidence !== undefined || rest.claimBasis !== undefined) {
        const basis = rest.claimBasis ?? existing.claimBasis;
        const requested = rest.confidence ?? existing.confidence;
        const { confidence, ceiling } = clampConfidence(deps, basis, requested);
        if (confidence < requested) cappedTo = ceiling;
        const floor = deps.annotationConfidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
        if (confidence < floor) return retractInsteadOfWeakRevise(confidence, floor);
        if (rest.confidence !== undefined || confidence !== existing.confidence) {
          clampedConfidence = confidence;
        }
      }
      // A claimType change re-keys the belief — run the standing
      // same-claimType probe over the person's merge equivalence class,
      // excluding the revised row itself (as annotation_revise).
      if (rest.claimType !== undefined && !claimTypeEquals(rest.claimType, existing.claimType)) {
        const subject = resolveLoopPersonRef(db, existing.personId) ?? existing.personId;
        const standing = listLiveSameClaimTypePersonAnnotations(db, subject, rest.claimType, {
          excludeId: id,
          limit: CONFLICT_PROBE_LIMIT,
        });
        if (standing.length > 0) {
          return annotationConflictRefusal(
            "person_annotation.conflict_candidates",
            standing,
            reviseConflictGuidance("person_annotation_supersede"),
          );
        }
      }
      const canonicalPerson = resolveLoopPersonRef(db, existing.personId) ?? existing.personId;
      const reading = readProfile(() => personProfiles.require(canonicalPerson, personBudget));
      if (reading.refusal !== null) return reading.refusal;
      const profileBudget = reading.value;
      if (rest.claimText !== undefined && rest.claimText !== existing.claimText) {
        const budgetRefusal = preflightProfile(canonicalPerson, [existing], rest.claimText);
        if (budgetRefusal !== null) return budgetRefusal;
      }
      // The entailment gate re-judges the EFFECTIVE claim against the FULL
      // live evidence set, concatenated as the create gate judged it (as
      // annotation_revise); scalar-mirror fallback covers a row with no atoms.
      const atoms = listPersonAnnotationEvidence(db, id);
      const sourceRefusal = await vetAnnotationSourceEvidence(
        deps,
        atoms.length
          ? atoms.map((atom) => ({ docId: atom.evidenceDocId, quote: atom.evidenceQuote }))
          : [{ docId: existing.evidenceDocId, quote: existing.evidenceQuote }],
      );
      if (sourceRefusal !== null) return sourceRefusal;
      const effective = {
        claimType: rest.claimType ?? existing.claimType,
        claimText: rest.claimText ?? existing.claimText,
        confidence: clampedConfidence ?? existing.confidence,
        claimBasis: rest.claimBasis ?? existing.claimBasis,
        evidenceDocId: existing.evidenceDocId,
        evidenceQuote: existing.evidenceQuote,
        additionalEvidence: atoms
          .slice(1)
          .map((atom) => ({ docId: atom.evidenceDocId, quote: atom.evidenceQuote })),
      };
      const unchanged = readProfile(() =>
        findUnchangedPersonAnnotation(db, id, effective, profileBudget),
      );
      if (unchanged.refusal !== null) return unchanged.refusal;
      // Confidence-only revision is the existing re-verification contract:
      // sweeps reaffirm a standing claim without inventing an editorial edit.
      // Replaying its prose (even with confidence attached) remains a no-op.
      const reaffirm =
        rest.confidence !== undefined &&
        rest.claimText === undefined &&
        rest.claimType === undefined &&
        rest.claimBasis === undefined &&
        reconciliationReason === undefined;
      if (unchanged.value && !reaffirm)
        return ok("person_annotation.unchanged", {
          id,
          unchanged: true,
          guidance:
            "This verified fact and its evidence already match. No revision or verification refresh was written.",
        });
      if (
        effective.claimText !== existing.claimText ||
        effective.claimType !== existing.claimType
      ) {
        const judging = db.transaction(() => {
          const profile = readPersonReconciliationContext(
            db,
            canonicalPerson,
            [id],
            "revise",
            reconciliationReason,
          );
          const payloadCapture =
            deps.checkRecord && (deps.checkRecord.needsDocumentContext?.() ?? true)
              ? (captureDecisionPayloadSubjects(
                  db,
                  {
                    sourceIds: [
                      existing.evidenceDocId,
                      ...atoms.map((atom) => atom.evidenceDocId),
                      ...profile.sourceIds,
                    ],
                    nodeIds: profile.nodeIds,
                  },
                  payloadGeneration,
                ) ?? undefined)
              : undefined;
          return {
            ...(payloadCapture
              ? {
                  personContext: personRecordContext(
                    canonicalPerson,
                    atoms.length
                      ? atoms.map((atom) => ({
                          docId: atom.evidenceDocId,
                          quote: atom.evidenceQuote,
                        }))
                      : [{ docId: existing.evidenceDocId, quote: existing.evidenceQuote }],
                    profile.reconciliation,
                  ),
                }
              : {}),
            ...(payloadCapture ? { payloadCapture } : {}),
          };
        })();
        const dropped = await recordCheckRefusal(
          deps,
          {
            recordId: id,
            record: { type: "person-fact", kind: effective.claimType, text: effective.claimText },
            documentId: existing.evidenceDocId,
            ...judging,
          },
          ctx.abortSignal,
        );
        if (dropped !== null) return dropped;
      }
      const gate = await runEntailmentGate(
        deps,
        {
          claim: rest.claimText ?? existing.claimText,
          context: annotationVerificationContext("person_annotation"),
          assessment: "annotation_atomic",
          evidence: annotationGateEvidence(
            db,
            atoms.length > 0
              ? atoms.map((atom) => ({ docId: atom.evidenceDocId, quote: atom.evidenceQuote }))
              : [{ docId: existing.evidenceDocId, quote: existing.evidenceQuote }],
          ),
        },
        clock(),
      );
      if (gate.kind === "refused") return entailmentRefusal(gate.verdict, gate.assertions);
      const patch: UpdatePersonAnnotationPatch = {
        ...(rest.claimType !== undefined ? { claimType: rest.claimType } : {}),
        ...(rest.claimText !== undefined ? { claimText: rest.claimText } : {}),
        ...(rest.claimBasis !== undefined ? { claimBasis: rest.claimBasis } : {}),
        ...(clampedConfidence !== undefined ? { confidence: clampedConfidence } : {}),
        // A configured verifier re-stamps state + time; with none configured a
        // successful revise still advances the last-checked stamp (the quote
        // firewall re-checked the evidence — see annotation_revise) and
        // leaves the verification state untouched.
        ...(gate.state !== null
          ? { verificationState: gate.state, lastVerifiedAt: gate.verifiedAt }
          : { lastVerifiedAt: clock() }),
      };
      const writing = await writeProfile(() =>
        writeGate.revisePersonAnnotation(id, patch, clock(), profileBudget),
      );
      if (writing.refusal !== null) return writing.refusal;
      const revised = writing.value;
      if (!revised) return notFound("person annotation", id);
      log.info(`Cognition Steward run ${runId} revised person annotation ${id}`);
      // Echo the post-revise row (the store returns a boolean), mirroring
      // annotation.revised — after a basis downgrade the agent must see the
      // re-clamped confidence even when nothing was capped.
      const after = getPersonAnnotation(db, id);
      return ok("person_annotation.revised", {
        id,
        ...(after !== null
          ? {
              claimType: after.claimType,
              confidence: after.confidence,
              claimBasis: after.claimBasis,
            }
          : {}),
        ...(cappedTo !== undefined ? { confidenceCappedTo: cappedTo } : {}),
      });
    },
  };

  const personAnnotationRetractSchema = z
    .object({ id: z.string().min(1).describe("Person-annotation id to retract.") })
    .strict();
  const personAnnotationRetract: ToolHandle = {
    name: "person_annotation_retract",
    description:
      "Withdraw a person annotation that turned out wrong, was superseded, " +
      "or does not belong in the compact person profile after explicit editorial review. Autonomous withdrawal " +
      "requires a complete profile read and a preservation assessment; keep useful supported meaning with an atomic " +
      "revision or annotate_person supersedes replacement, never delete first and recreate later. A claim that merely " +
      "weakened should be revised with lower confidence instead.",
    schema: personAnnotationRetractSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs, ctx): Promise<ToolResult> {
      const parsed = personAnnotationRetractSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const assessment = await assessPersonWithdrawal(
        db,
        personProfiles,
        deps.checkRecord,
        parsed.data.id,
        personBudget,
        ctx.abortSignal,
      );
      if (assessment.refusal) return assessment.refusal;
      const removed = await writeGate.retractPersonAnnotation(
        parsed.data.id,
        clock(),
        assessment.budget,
      );
      if (!removed) return notFound("person annotation", parsed.data.id);
      log.info(`Cognition Steward run ${runId} retracted person annotation ${parsed.data.id}`);
      return ok("person_annotation.retracted", { id: parsed.data.id });
    },
  };

  // ---- person_annotation_supersede ----
  // Pure belief retirement, person store — the sibling of annotation_supersede.
  // Subject identity is compared over CANONICAL person ids: two rows authored
  // against different merged-away ids still name the same person.
  const personAnnotationSupersedeSchema = z
    .object({
      id: z.string().min(1).describe("The OUTDATED live person annotation to retire."),
      supersededBy: z
        .string()
        .min(1)
        .describe(
          "The EXISTING live annotation on the SAME person that replaces it (no new row is created).",
        ),
    })
    .strict();
  const personAnnotationSupersede: ToolHandle = {
    name: "person_annotation_supersede",
    description:
      "Retire an outdated live person annotation in favour of another EXISTING " +
      "live annotation on the SAME person — belief revision with no new row. " +
      "The retired claim keeps an audit link to its successor. Use this when " +
      "two live claims disagree and one is simply right: keep it, supersede " +
      "the other. To replace a claim with a NEW corrected claim, use " +
      "annotate_person with supersedes instead.",
    schema: personAnnotationSupersedeSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs, ctx): Promise<ToolResult> {
      const parsed = personAnnotationSupersedeSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      if (a.id === a.supersededBy) {
        return invalidPureSupersede(`annotation ${a.id} cannot supersede itself`);
      }
      const target = getPersonAnnotation(db, a.id);
      if (target === null) return notFound("person annotation", a.id);
      if (target.invalidatedAt !== null) {
        return invalidPureSupersede(`annotation ${a.id} is no longer live`);
      }
      const successor = getPersonAnnotation(db, a.supersededBy);
      if (successor === null) {
        return invalidPureSupersede(
          `annotation ${a.supersededBy} does not exist in the person store`,
        );
      }
      if (successor.invalidatedAt !== null) {
        return invalidPureSupersede(`annotation ${a.supersededBy} is no longer live`);
      }
      const targetCanonical = resolveLoopPersonRef(db, target.personId) ?? target.personId;
      const successorCanonical = resolveLoopPersonRef(db, successor.personId) ?? successor.personId;
      if (targetCanonical !== successorCanonical) {
        return invalidPureSupersede(
          `annotation ${a.supersededBy} is about person ${successorCanonical}, not ${targetCanonical}`,
        );
      }
      const assessment = await assessPersonWithdrawal(
        db,
        personProfiles,
        deps.checkRecord,
        a.id,
        personBudget,
        ctx.abortSignal,
      );
      if (assessment.refusal) return assessment.refusal;
      const { superseded } = await writeGate.supersedePersonAnnotationBy(
        a.id,
        a.supersededBy,
        clock(),
        assessment.budget,
      );
      if (!superseded) {
        log.warn(
          `Cognition Steward run ${runId} lost the supersede of person annotation ${a.id} to a concurrent write`,
        );
        return {
          kind: "error",
          code: "supersede_lost",
          message: SUPERSEDE_LOST_GUIDANCE,
        };
      }
      log.info(
        `Cognition Steward run ${runId} superseded person annotation ${a.id} → ${a.supersededBy}`,
      );
      return ok("person_annotation.superseded", { id: a.id, supersededBy: a.supersededBy });
    },
  };

  return [
    annotationSearch,
    annotateDurable,
    annotationRevise,
    annotationRetract,
    annotationSupersede,
    annotatePerson,
    personAnnotationRevise,
    personAnnotationRetract,
    personAnnotationSupersede,
  ];
}

/**
 * The proposal a run's update makes to one of the user's own tasks, or null
 * when the update changes nothing the user owns. Resolving proposes
 * completion or striking; other field changes propose an edit. A snooze is
 * not proposed: when to do a task is the user's call.
 */
export function taskProposalFor(
  loop: OpenLoopRow,
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
