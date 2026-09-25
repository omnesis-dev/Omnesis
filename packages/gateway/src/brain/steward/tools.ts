// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Cognition Steward's own tools — the mutating surface over open loops and
 * briefs, the agent-notes memory, and point-in-time scheduling. Built
 * fresh per claimed run so every handle carries the run's id: creates
 * stamp `created_by_run`, ledger appends stamp the run id, and a
 * re-claimed attempt can recognise its own partial work.
 *
 * Only the Cognition Steward gets these handles (V1: only the agent mutates
 * loops/briefs). Every mutating handle declares `mutates: true`, so a
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
import { getOpenLoop, listOpenLoopLedger, searchOpenLoopsLexical } from "../storage/open-loops.js";
import { searchRetiredLoopsLexical } from "../storage/retired-loops.js";
import { findActiveBriefsForLoops, getBrief, listBriefs } from "../storage/briefs.js";
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
  listLivePersonAnnotationsForPerson,
  listLiveSameClaimTypePersonAnnotations,
  listPersonAnnotationEvidence,
  type PersonAnnotationRow,
  type UpdatePersonAnnotationPatch,
} from "../storage/person-annotations.js";
import { listLiveBriefClaims, type BriefClaimInput } from "../storage/brief-claims.js";
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
  type CognitionBriefLane,
} from "../run-payloads.js";
import { fetchSelfPersonId } from "../../domain/InteractionScoreService.js";
import { OPEN_LOOP_DOCUMENT_TYPE } from "../open-loop-source/source-meta.js";
import {
  expandCanonical,
  getTemporalAnnotationById,
  listTemporalAnnotationEvidence,
  listTemporalAnnotationsForLoop,
  queryTemporalAnnotationReconcileCandidates,
  type TemporalAnnotation,
} from "../../enrichment/temporal-annotations/storage.js";
import { runBriefJudgeGate, type BriefJudge } from "./brief-judge.js";
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
import type { BriefRow, BriefState, Clock, OpenLoopRow, OpenLoopState } from "../storage/types.js";

type Db = Database.Database;

/** The write-gate slice the tool layer drives. */
export type CognitionWriteOps = Pick<
  WriteGate,
  | "applyMergeAdjudication"
  | "createOpenLoop"
  | "updateOpenLoop"
  | "appendOpenLoopLedger"
  | "deleteOpenLoop"
  | "createBrief"
  | "updateBrief"
  | "retireBrief"
  | "retractBriefsForResolvedLoop"
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
   * The editorial lane this run's briefs belong to ({@link cognitionBriefLane}),
   * selecting which push-bar gates `brief_create` faces. Required, so the
   * compiler — not a defensive default — is what stops a new caller from
   * silently landing on a laxer bar than it meant to.
   */
  briefLane: CognitionBriefLane;
  /**
   * Set only on a sweep run. A judge HOLD is the one thing a sweep produced
   * that leaves no trace in the artifact stores, so it is tallied here rather
   * than re-derived at settle time.
   */
  sweepId?: string;
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
  /** Id generator for created loops/briefs/scheduled runs (tests pin it). */
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
  /**
   * Resolve the entailment verifier for the annotation firewall, fresh per
   * call (so a model swap takes effect without rebuilding the toolset).
   * Absent, or resolving to null (role unset), the gate is skipped and
   * annotation writes behave exactly as without it.
   */
  getEntailmentVerifier?: () => Promise<EntailCapability | null>;
  /**
   * Resolve the brief judge (the push bar), read live so a config toggle or
   * model swap takes effect on the next brief. Absent, or resolving to null
   * (judge disabled or no backend), the gate is skipped and briefs ship
   * unjudged — exactly as before the judge existed.
   */
  getBriefJudge?: () => BriefJudge | null;
  /**
   * Per-run surfaced-prior tracker (consumption provenance). Search results,
   * prompt-inlined priors and self-memory become candidates that a later
   * brief/loop mutation can explicitly select as material dependencies.
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
  "brief_create",
  "brief_update",
  "brief_delete",
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

/**
 * One asserted claim on a brief write — the same evidence contract as
 * `annotate_durable`, applied to what the brief tells the user.
 */
const assertedClaimSchema = z
  .object({
    claimText: z
      .string()
      .min(1)
      .max(1000)
      .describe(
        "One factual, document-derived statement the brief asserts — concise, and never more than the evidence establishes.",
      ),
    evidenceDocId: z.string().min(1).describe("Document id the claim is grounded in."),
    evidenceQuote: z
      .string()
      .min(12)
      .max(500)
      .describe(
        "A VERBATIM quote (a substantive span, not a stray word) from evidenceDocId that establishes the FULL claim — not merely mentions its topic.",
      ),
    claimBasis: claimBasisEnum.describe(
      "How far the claim reasons from its evidence: 'quoted' (the evidence essentially states it), 'inferred' (one licensed deduction), or 'synthesized' (assembled across sources). Confidence is capped tighter the further down this ladder.",
    ),
    confidence: fraction.describe("Confidence in the claim (0-1; clamped per claimBasis)."),
  })
  .strict();

const assertedClaimsField = z.array(assertedClaimSchema).max(24);

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
  documentType: string | null;
}
function fetchEvidenceDoc(db: Db, id: string): EvidenceDoc | null {
  const row = db
    .prepare<
      [string],
      { content: string | null; content_hash: string; document_type: string | null }
    >("SELECT content, content_hash, json_extract(metadata, '$.documentType') AS document_type FROM documents WHERE id = ?")
    .get(id);
  return row === undefined
    ? null
    : {
        content: row.content ?? "",
        contentHash: row.content_hash,
        documentType: row.document_type,
      };
}

/** The evidence firewall's quote test, memoized on the doc's content hash so a
 *  run's repeated checks against one evidence doc normalize its body once. */
function quoteInEvidence(doc: EvidenceDoc, quote: string): boolean {
  return containsNormalizedForContent(doc.contentHash, doc.content, quote);
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
 * exist, must be a real source (never the agent's own derived open-loop
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
    if (doc.documentType === OPEN_LOOP_DOCUMENT_TYPE) {
      return {
        kind: "error",
        code: "invalid_evidence",
        message: `additionalEvidence[${i}]: ${item.docId} is a derived open-loop record, not a source document — ground the observation on the original source`,
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

/**
 * The entailment gate's evidence text for a multi-atom grounding: ONE gate
 * call judges the claim against ALL quotes jointly (the verifier contract is
 * evidence ⊨ claim, and a synthesized claim's atoms ground it together). A
 * single atom passes through byte-identically, so scalar-only calls are
 * unchanged.
 */
function concatenatedGateEvidence(quotes: readonly string[]): string {
  return quotes.length === 1 ? quotes[0]! : quotes.map((q, i) => `[${i + 1}] ${q}`).join("\n");
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
  | { kind: "refused"; verdict: "neutral" | "contradiction" };

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
  input: { claim: string; evidence: string },
  now: number,
): Promise<EntailmentGateOutcome> {
  if (!deps.getEntailmentVerifier) return { kind: "pass", state: null, verifiedAt: null };
  let verifier: EntailCapability | null = null;
  let resolveFailed = false;
  try {
    verifier = await deps.getEntailmentVerifier();
  } catch (err) {
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
    const verdict = await withDeadline(verifier.verify(input), ENTAILMENT_GATE_TIMEOUT_MS);
    if (verdict.label === "entailment") {
      return { kind: "pass", state: "verified", verifiedAt: now };
    }
    return { kind: "refused", verdict: verdict.label };
  } catch (err) {
    deps.log.warn(
      `entailment verification failed — marking write unverified: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { kind: "pass", state: "unverified", verifiedAt: null };
  }
}

/** Hard ceiling on one entailment check; beyond it the gate fails open. */
const ENTAILMENT_GATE_TIMEOUT_MS = 45_000;

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`entailment check timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The re-askable refusal the annotation tools return on a failed entailment check. */
function entailmentRefusal(verdict: "neutral" | "contradiction"): ToolResult {
  return {
    kind: "error",
    code: "evidence_does_not_entail_claim",
    message:
      `the evidence quote does not establish the claim at its stated modality ` +
      `(verifier verdict: ${verdict}) — weaken the claim to what the quote actually ` +
      `supports, or cite stronger evidence that establishes the full claim`,
  };
}

// ── asserted-claim teeth (brief_create / brief_update) ─────────────────────

/** One asserted claim as the brief tools accept it (zod-validated). */
interface AssertedClaimArg {
  claimText: string;
  evidenceDocId: string;
  evidenceQuote: string;
  claimBasis: AnnotationClaimBasis;
  confidence: number;
}

/**
 * One failing asserted claim of a refused set: which claim (index + text),
 * why (a re-askable reason under a stable `code`), and the verifier verdict
 * when the failure came from the entailment gate.
 */
interface AssertedClaimFailure {
  index: number;
  claimText: string;
  code: string;
  reason: string;
  verdict?: "neutral" | "contradiction";
}

/**
 * ONE refusal for a whole vetted set, naming EVERY failing claim (index +
 * text + reason), so the agent fixes them all in a single re-call instead of
 * discovering them one refusal at a time. A single-failure refusal keeps
 * that failure's specific code; a multi-failure one carries the aggregate
 * `asserted_claims_refused`.
 */
function assertedClaimsRefusal(failures: readonly AssertedClaimFailure[]): ToolResult {
  const lines = failures.map((f) => {
    const shown = f.claimText.length > 120 ? `${f.claimText.slice(0, 120)}…` : f.claimText;
    const verdict = f.verdict !== undefined ? ` (verifier verdict: ${f.verdict})` : "";
    return `assertedClaims[${f.index}] ("${shown}"): ${f.reason}${verdict}`;
  });
  return {
    kind: "error",
    code: failures.length === 1 ? failures[0]!.code : "asserted_claims_refused",
    message: `${lines.join("\n")}\n— fix (or drop) each claim named above and re-call with the corrected set`,
  };
}

/**
 * The brief-claims firewall — the same teeth annotations get, applied to
 * every asserted claim of a brief write. Cheap SQL checks run over the WHOLE
 * set first (evidence doc exists, quote appears in it, per-basis confidence
 * clamp, the persistence floor), so a routine refusal never spends a
 * verifier call; only then does the entailment gate judge each surviving
 * quote ⊨ claim (one call per claim, spend-recorded like every gate call).
 * Each stage collects EVERY failing claim and refuses once naming them all —
 * the gate stage keeps judging past a refused claim, so a refusal costs the
 * same ≤ one-call-per-claim a passing set does and a re-call never pays for
 * failures it could have been told about the first time. A claim that
 * passes with a `verified` verdict is born-verified. A configured verifier
 * that is unavailable yields an `unverified` row so callers can hold the
 * user-facing write without conflating an outage with a factual rejection;
 * with no verifier configured the stamp is null (no gate, no stamp).
 */
async function vetAssertedClaims(
  deps: Pick<
    CognitionToolDeps,
    | "db"
    | "getEntailmentVerifier"
    | "log"
    | "annotationBasisCeilings"
    | "annotationConfidenceCeiling"
    | "annotationConfidenceFloor"
  >,
  claims: readonly AssertedClaimArg[],
  now: number,
): Promise<
  { ok: true; rows: Array<Omit<BriefClaimInput, "id">> } | { ok: false; refusal: ToolResult }
> {
  const floor = deps.annotationConfidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR;
  const clamped: number[] = [];
  const cheapFailures: AssertedClaimFailure[] = [];
  for (const [i, c] of claims.entries()) {
    const { confidence } = clampConfidence(deps, c.claimBasis, c.confidence);
    clamped.push(confidence);
    const evidence = fetchEvidenceDoc(deps.db, c.evidenceDocId);
    if (evidence === null) {
      cheapFailures.push({
        index: i,
        claimText: c.claimText,
        code: "not_found",
        reason: `evidence document ${c.evidenceDocId} does not exist — cite a real document id`,
      });
      continue;
    }
    if (!quoteInEvidence(evidence, c.evidenceQuote)) {
      cheapFailures.push({
        index: i,
        claimText: c.claimText,
        code: "evidence_not_found",
        reason: `evidenceQuote was not found in ${c.evidenceDocId} — quote the source text exactly (whitespace-insensitive; curly/straight quotes and dash variants are also normalized — other punctuation must match the source exactly)`,
      });
      continue;
    }
    // Abstention floor, mirroring the annotation path: a claim this weak
    // after clamping is refused outright, never rendered as a ~0% assertion.
    if (confidence < floor) {
      cheapFailures.push({
        index: i,
        claimText: c.claimText,
        code: "insufficient_confidence_to_persist",
        reason:
          `confidence ${confidence.toFixed(2)} (after the claim-basis ceiling) is below the ` +
          `persistence floor ${floor.toFixed(2)} — cite stronger evidence or drop the claim`,
      });
    }
  }
  if (cheapFailures.length > 0) return { ok: false, refusal: assertedClaimsRefusal(cheapFailures) };
  const gateFailures: AssertedClaimFailure[] = [];
  const rows: Array<Omit<BriefClaimInput, "id">> = [];
  for (const [i, c] of claims.entries()) {
    const gate = await runEntailmentGate(
      deps,
      { claim: c.claimText, evidence: c.evidenceQuote },
      now,
    );
    if (gate.kind === "refused") {
      gateFailures.push({
        index: i,
        claimText: c.claimText,
        code: "evidence_does_not_entail_claim",
        reason:
          "the evidence quote does not establish this claim — weaken the claim to what the " +
          "quote actually supports, or cite stronger evidence",
        verdict: gate.verdict,
      });
      continue;
    }
    rows.push({
      claimText: c.claimText,
      evidenceDocId: c.evidenceDocId,
      evidenceQuote: c.evidenceQuote,
      claimBasis: c.claimBasis,
      confidence: clamped[i]!,
      verificationState: gate.state,
    });
  }
  if (gateFailures.length > 0) return { ok: false, refusal: assertedClaimsRefusal(gateFailures) };
  return { ok: true, rows };
}

/**
 * A configured verifier that could not decide is an operational hold for a
 * user-facing Brief, not permission to publish an unchecked factual claim.
 * Null remains the intentional no-gate state and does not hold the write.
 */
function unverifiedBriefClaimsHold(
  rows: ReadonlyArray<Omit<BriefClaimInput, "id">>,
): ToolResult | null {
  const count = rows.filter((row) => row.verificationState === "unverified").length;
  if (count === 0) return null;
  return ok("brief.held_for_verification", {
    reason: `${count} asserted ${count === 1 ? "claim could" : "claims could"} not be verified because the configured entailment verifier was unavailable`,
    guidance:
      "Not written — do not ship or retry this Brief during the current run. Keep any useful loop state, and let a later run reconsider the card after factual verification is available.",
  });
}

/**
 * The temporal-annotation conditional teeth: when a write declares its grounding
 * (`evidence: {docId, quote}`), the quote must appear in that document and
 * the entailment gate must find it establishes the entry's sentence. Cheap
 * checks first, gate last; a write without evidence is never gated (pure
 * scheduling / self-sourced entries stay legal). Returns null on pass — the
 * teeth are write-time only; no verification stamp is stored.
 */
async function vetTemporalAnnotationEvidence(
  deps: Pick<CognitionToolDeps, "db" | "getEntailmentVerifier" | "log">,
  evidence: { docId: string; quote: string },
  sentence: string,
  now: number,
): Promise<ToolResult | null> {
  const doc = fetchEvidenceDoc(deps.db, evidence.docId);
  if (doc === null) return notFound("evidence document", evidence.docId);
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
  const gate = await runEntailmentGate(deps, { claim: sentence, evidence: evidence.quote }, now);
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
 * revise. Mirrors the `brief_create` loop-conflict contract — a structured
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

interface BriefSummary {
  id: string;
  kind: string;
  title: string;
  state: BriefState;
}

/** Compact summaries of the briefs attached to a loop. */
function briefSummariesForLoop(db: Db, loopId: string): BriefSummary[] {
  return db
    .prepare<[string], { id: string; kind: string; title: string; state: string }>(
      `SELECT b.id, b.kind, b.title, b.state
       FROM briefs b JOIN brief_related_loops brl ON brl.brief_id = b.id
       WHERE brl.loop_id = ? ORDER BY b.created_at ASC`,
    )
    .all(loopId)
    .map((r) => ({ id: r.id, kind: r.kind, title: r.title, state: r.state as BriefState }));
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
    actors: loop.actors,
    involved: loop.involved,
    docs: loop.docs,
    blockedBy: loop.blockedBy,
    createdAt: msToIso(loop.createdAt),
    lastUpdate: msToIso(loop.lastUpdate),
    attachedBriefs: briefSummariesForLoop(db, loop.id),
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

function briefToModelJson(brief: BriefRow): unknown {
  return {
    id: brief.id,
    createdByRun: brief.createdByRun,
    kind: brief.kind,
    title: brief.title,
    description: brief.description,
    body: brief.body,
    citations: brief.citations,
    confidence: brief.confidence,
    urgency: brief.urgency,
    relevantUntil: msToIso(brief.relevantUntil),
    relatedLoopIds: brief.relatedLoopIds,
    nextShow: msToIso(brief.nextShow),
    eventAt: msToIso(brief.eventAt),
    userFeedback: brief.userFeedback,
    state: brief.state,
    createdAt: msToIso(brief.createdAt),
  };
}

/** The states `brief_list` shows — everything that can still surface. */
const ACTIVE_BRIEF_STATES: readonly BriefState[] = ["unread", "read", "dismissed_snoozed"];

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
      "a duplicate. Each result carries its current fields, attached-brief " +
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
      "run-stamped ledger history and attached-brief summaries.",
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
        .describe('Short imperative title, e.g. "Reply to the venue quote".'),
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
          'Optional deadline structure. Recommended shape: {"type": "any_time"|"by"|"approximate"|"on_day", "date"?: "YYYY-MM-DD", "note"?: string} — a due "date" lets the feed rank this loop\'s briefs as due/overdue once it arrives.',
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
      "while one request naming several parts stays one loop. The loop is " +
      "stamped with this run's id.",
    schema: openLoopCreateSchema,
    mutates: true,
    summarize: (args) => (args as { title?: string })?.title,
    async invoke(rawArgs): Promise<ToolResult> {
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
        dependencyContext(dependencies.refs),
        clock(),
      );
      if (!persisted.ok) return deadDependenciesResult(persisted.dead);
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
          "New deadline structure (same recommended shape as open_loop_create); pass null to clear.",
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
    })
    .strict();
  const openLoopUpdate: ToolHandle = {
    name: "open_loop_update",
    description:
      "Partially update an existing open loop — pass only the fields to " +
      "change (`docs`/`actors`/etc. replace the whole list). Bumps the " +
      "loop's last_update. Prefer this (plus open_loop_ledger_append) over " +
      "creating a new loop when the datum concerns the SAME obligation an " +
      "existing loop tracks — a different ask that merely shares the " +
      "person, day, or trip is its own new loop.",
    schema: openLoopUpdateSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = openLoopUpdateSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { id, docs, blockedBy, deadline, ...rest } = parsed.data;
      const dependencies = selectDeclaredDependencies(rest.annotationDependencies);
      if (!dependencies.ok) return dependencies.result;
      const docsPart = docs !== undefined ? partitionDocIds(db, docs) : null;
      const blockedPart = blockedBy !== undefined ? partitionLoopIds(db, blockedBy) : null;
      const actorsPart = rest.actors !== undefined ? partitionPersonRefs(db, rest.actors) : null;
      const involvedPart =
        rest.involved !== undefined ? partitionPersonRefs(db, rest.involved) : null;
      const persisted = await writeGate.updateOpenLoop(
        id,
        {
          ...(rest.state !== undefined ? { state: rest.state as OpenLoopState } : {}),
          ...(rest.confidence !== undefined ? { confidence: rest.confidence } : {}),
          ...(rest.importance !== undefined ? { importance: rest.importance } : {}),
          ...(rest.title !== undefined ? { title: rest.title } : {}),
          ...(rest.description !== undefined ? { description: rest.description } : {}),
          ...(deadline !== undefined ? { deadline } : {}),
          ...(actorsPart ? { actors: actorsPart.known } : {}),
          ...(involvedPart ? { involved: involvedPart.known } : {}),
          ...(docsPart ? { docs: docsPart.known } : {}),
          ...(blockedPart ? { blockedBy: blockedPart.known } : {}),
          ...(rest.decayCheckPassed === true ? { lastDecayCheck: clock() } : {}),
        },
        dependencyContext(dependencies.refs),
        clock(),
      );
      if (!persisted.ok) return deadDependenciesResult(persisted.dead);
      const updated = persisted.value;
      if (!updated) return notFound("open loop", id);
      await mirror.refresh(id);
      mutatedLoopIds.add(id);
      // Resolve cascade: a loop moving to a resolved state (done/dismissed)
      // (1) retracts its never-claimed scheduled checks, so an
      // already-handled loop never wakes an agent run to rediscover
      // "nothing to do" (mirrors the decay sweep's retraction of a resolved
      // loop's decay check), and (2) retracts the loop's still-actionable
      // briefs to a terminal handled state, so a resolved loop never leaves
      // a lingering brief that still reads as actionable on the feed. The
      // loop itself survives (state=done/dismissed) with its briefs kept.
      if (rest.state !== undefined && RESOLVED_OPEN_LOOP_STATES.has(rest.state as OpenLoopState)) {
        await writeGate.cancelScheduledRunsForLoop(id);
        const retracted = await writeGate.retractBriefsForResolvedLoop(id, clock());
        if (retracted.length > 0) {
          log.info(
            `Cognition Steward run ${runId} resolved loop ${id}: retracted ${retracted.length} brief(s)`,
          );
        }
      }
      return ok("open_loop.updated", {
        loop: loopToModelJson(db, updated, { ledger: false }),
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
      });
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
      "never marked done. Engine-enforced invariant: attached " +
      "not-yet-terminally-dismissed briefs are deleted with it (a shown " +
      "brief never points at a missing loop).",
    schema: openLoopDeleteSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = openLoopDeleteSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { id } = parsed.data;
      const result = await writeGate.deleteOpenLoop(id, clock());
      if (!result.deleted) return notFound("open loop", id);
      await mirror.remove([id]);
      // A deleted loop's scheduled checks would only wake a run to find
      // the loop gone — retract the never-claimed ones (same cascade the
      // resolve path uses). The loop's still-actionable briefs need no
      // separate retraction here: `deleteOpenLoop` enforces the deletion
      // invariant, which already deletes the attached non-terminal briefs
      // outright (a stronger clear than the resolve path's move-to-terminal,
      // required because the loop no longer exists to keep them attached to).
      await writeGate.cancelScheduledRunsForLoop(id);
      log.info(
        `Cognition Steward run ${runId} deleted open loop ${id} (+${result.deletedBriefIds.length} attached brief(s))`,
      );
      return ok("open_loop.deleted", { loopId: id, deletedBriefIds: result.deletedBriefIds });
    },
  };

  // ---- brief_list ----
  const briefListSchema = z.object({}).strict();
  const briefList: ToolHandle = {
    name: "brief_list",
    description:
      "List the active briefs (unread / read / snoozed) with their related " +
      "loop ids. Check this before creating a brief so you never duplicate " +
      "one that already exists — including loop-less info briefs.",
    schema: briefListSchema,
    // eslint-disable-next-line @typescript-eslint/require-await -- sync sqlite reads behind the async ToolHandle contract
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = briefListSchema.safeParse(rawArgs ?? {});
      if (!parsed.success) return invalidArgs(parsed.error);
      const briefs = listBriefs(db, { states: ACTIVE_BRIEF_STATES }).map((b) => ({
        id: b.id,
        kind: b.kind,
        title: b.title,
        description: b.description,
        state: b.state,
        relatedLoopIds: b.relatedLoopIds,
        nextShow: msToIso(b.nextShow),
        eventAt: msToIso(b.eventAt),
        relevantUntil: msToIso(b.relevantUntil),
      }));
      return ok("brief.list", { briefs });
    },
  };

  // ---- brief_fetch ----
  const briefFetchSchema = z.object({ id: z.string().min(1).describe("Brief id.") }).strict();
  const briefFetch: ToolHandle = {
    name: "brief_fetch",
    description:
      "Fetch one brief's full JSON, including its dismissal state, any " +
      "free-text feedback the user typed, and its live asserted claims " +
      "(the evidence-bound statements the card makes — a brief_update " +
      "passing assertedClaims replaces this whole set).",
    schema: briefFetchSchema,
    // eslint-disable-next-line @typescript-eslint/require-await -- sync sqlite reads behind the async ToolHandle contract
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = briefFetchSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const brief = getBrief(db, parsed.data.id);
      if (!brief) return notFound("brief", parsed.data.id);
      // Live claims ride along so a replace-set update can restate the
      // still-true ones instead of silently dropping them.
      const claims = listLiveBriefClaims(db, brief.id).map((c) => ({
        claimText: c.claimText,
        evidenceDocId: c.evidenceDocId,
        evidenceQuote: c.evidenceQuote,
        claimBasis: c.claimBasis,
        confidence: c.confidence,
        verificationState: c.verificationState,
      }));
      return ok("brief.fetched", {
        ...(briefToModelJson(brief) as Record<string, unknown>),
        assertedClaims: claims,
      });
    },
  };

  // ---- brief_create ----
  const briefCreateSchema = z
    .object({
      kind: z
        .enum(["info", "loop"])
        .describe('"loop" = attached to open loops; "info" = standalone awareness.'),
      title: z
        .string()
        .min(1)
        .max(200)
        .describe(
          "The specific thing, phrased as a person would text it. No date — " +
            "eventAt renders the live one.",
        ),
      description: z
        .string()
        .max(500)
        .optional()
        .describe(
          "ONE sentence carrying the whole point (<30 words). Doubles as the " +
            "push-notification line, so it must stand alone with no other context.",
        ),
      body: z
        .string()
        .max(20000)
        .optional()
        .describe(
          "What the user actually reads. Open with the action or the change, " +
            "then only what is needed to act: the number, the reference, the " +
            "deadline mechanics, the stakes. Required whenever the card carries " +
            "a deadline, a booking, or a named counterparty. Never a restatement " +
            "of the description, and never a pointer to the source or to another card.",
        ),
      citations: idList.optional().describe("Document ids backing the brief (shown to the user)."),
      confidence: fraction.describe(
        "How sure you are the card is RIGHT — not how sure you are of any one " +
          "claim (assertedClaims carry their own, capped per claimBasis). High " +
          "when the sources say it outright, lower the further the card reasons " +
          "from them, and low enough that you would not surface it means: do not.",
      ),
      urgency: fraction.describe(
        "Anchor on the WINDOW, not on how interesting it is. 0.9 = acting today " +
          "rather than tomorrow changes the outcome. 0.6 = this week. 0.3 = worth " +
          "knowing, no clock.",
      ),
      relevantUntil: isoDateTime.optional().describe("When the brief stops being relevant."),
      relatedLoopIds: idList.optional().describe("Open loops this brief is attached to."),
      nextShow: isoDateTime.optional().describe("Earliest display time (default: immediately)."),
      eventAt: isoDateTime.optional().describe("Time of the real-world event the brief concerns."),
      supersedes: idList
        .optional()
        .describe(
          "Active brief id(s) this card REPLACES — they leave the feed the moment " +
            "this one is created (history kept). Use when refreshing a card that " +
            "already covers the same obligation.",
        ),
      assertedClaims: assertedClaimsField
        .optional()
        .describe(
          "Every factual, document-derived statement this brief asserts, each bound " +
            "to its evidence. Verified at write time: the quote must appear in its " +
            "document and establish the claim, or the create is refused naming every " +
            "failing claim. A pure awareness card asserting no document-derived " +
            "facts may omit this.",
        ),
      force: z
        .boolean()
        .optional()
        .describe(
          "Create even though an active brief shares a related loop. Only set after " +
            "reviewing the conflict candidates a first attempt returned and confirming " +
            "this card is genuinely distinct (e.g. a multi-loop roll-up beside a " +
            "specific card), not the same obligation restated.",
        ),
      annotationDependencies: annotationDependenciesField,
    })
    .strict();
  const briefCreate: ToolHandle = {
    name: "brief_create",
    description:
      "Create a brief — the ONLY way anything you learn reaches the user. " +
      "Check brief_list first (never duplicate an active brief). One " +
      "obligation, ONE card: when a related loop already has an active " +
      "brief, the create is refused and the candidates returned — " +
      "brief_update the existing card, or re-call with supersedes:[id] to " +
      "replace it, or force:true only if this card is genuinely distinct. " +
      "Cite the source documents; pass each factual, document-derived " +
      "statement the card asserts as assertedClaims (verified at write time " +
      "against its quoted evidence); set eventAt for time-bound items and " +
      "relevantUntil when relevance expires. Do NOT create a brief whose " +
      "relevance has already passed. The brief is stamped with this run's id.",
    schema: briefCreateSchema,
    mutates: true,
    summarize: (args) => (args as { title?: string })?.title,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = briefCreateSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      const dependencies = selectDeclaredDependencies(a.annotationDependencies);
      if (!dependencies.ok) return dependencies.result;
      const citations = partitionDocIds(db, a.citations ?? []);
      const loops = partitionLoopIds(db, a.relatedLoopIds ?? []);
      const supersedeIds = new Set(a.supersedes ?? []);
      if (a.force !== true) {
        // One-card-per-loop as a tool contract, not prompt discipline:
        // an active card on any of this brief's loops refuses the create
        // and returns the candidates. Two near-identical cards for one
        // obligation is exactly the failure this guards against — the
        // model routinely fails to match differently-worded titles.
        //
        // Known bound: this is a read outside the serialized write op,
        // so two runs racing under brain.workerConcurrency > 1 can both
        // pass and both create (default concurrency is 1; the drainer
        // accepts the same read-then-write shape for daily batches).
        const conflicts = findActiveBriefsForLoops(db, loops.known, clock()).filter(
          (c) => !supersedeIds.has(c.id),
        );
        if (conflicts.length > 0) {
          return ok("brief.loop_conflict_candidates", {
            candidates: conflicts.map((c) => ({
              id: c.id,
              title: c.title,
              state: c.state,
              sharedLoopIds: c.loopIds,
            })),
            guidance:
              "Not created. These active briefs already cover the same loop(s). If " +
              "one is the SAME obligation, brief_update it — or re-call brief_create " +
              "with supersedes:[thatId] to replace it with this fresher card. Only " +
              "if this card is genuinely distinct (e.g. a roll-up spanning several " +
              "loops beside a specific card), re-call with force:true.",
          });
        }
      }
      // Validate supersede targets up front: they must exist and still be
      // active — a terminal or unknown id is reported, not silently eaten.
      // dismissed_snoozed IS supersedable: the card is parked, not gone,
      // and would otherwise wake up beside its replacement.
      const supersedable: string[] = [];
      const droppedSupersedes: string[] = [];
      for (const sid of supersedeIds) {
        const target = getBrief(db, sid);
        if (target && (ACTIVE_BRIEF_STATES as readonly string[]).includes(target.state)) {
          supersedable.push(sid);
        } else {
          droppedSupersedes.push(sid);
        }
      }
      // The asserted-claims teeth — after every cheap refusal above (a
      // loop-conflict refusal must never spend a verifier call), before the
      // write. A refusal names every failing claim and is re-askable.
      let claimRows: BriefClaimInput[] | undefined;
      if (a.assertedClaims !== undefined) {
        const vetted = await vetAssertedClaims(deps, a.assertedClaims, clock());
        if (!vetted.ok) return vetted.refusal;
        const verificationHold = unverifiedBriefClaimsHold(vetted.rows);
        if (verificationHold !== null) return verificationHold;
        claimRows = vetted.rows.map((r) => ({ id: `bclaim_${idGen()}`, ...r }));
      }
      // The push bar — the judge's ship/no-ship pass, last before persist so it
      // runs once on the fully-validated brief (a claim-fix re-call is refused
      // at the teeth above and never reaches the judge). A HOLD is not an error
      // the agent should fix-and-retry: the card simply does not clear the
      // interrupt bar, so it is not created. An absent/disabled judge means no
      // gate; a configured judge outage also holds rather than shipping an
      // unreviewed card.
      const judged = await runBriefJudgeGate(deps, {
        kind: a.kind,
        lane: deps.briefLane,
        title: a.title,
        ...(a.description !== undefined ? { description: a.description } : {}),
        ...(a.body !== undefined ? { body: a.body } : {}),
        citationCount: citations.known.length,
        relatedLoopCount: loops.known.length,
        scheduledForLater: a.nextShow !== undefined && isoToMs(a.nextShow) > clock(),
        hasEventAt: a.eventAt !== undefined,
      });
      if (judged.kind === "hold") {
        if (deps.sweepId !== undefined) {
          await writeGate.recordSweepTally({ sweepId: deps.sweepId, briefsHeld: 1 }, clock());
        }
        return ok("brief.held_by_judge", {
          reason: judged.reason,
          guidance:
            "Not created — the configured Brief review did not authorize shipping. Keep maintaining open loops and meaningful temporal annotations as needed, but do NOT resurface this as a Brief during the current run.",
        });
      }
      const id = `brief_${idGen()}`;
      const persisted = await writeGate.createBrief(
        {
          id,
          createdByRun: runId,
          kind: a.kind,
          title: a.title,
          ...(a.description !== undefined ? { description: a.description } : {}),
          ...(a.body !== undefined ? { body: a.body } : {}),
          citations: citations.known,
          confidence: a.confidence,
          urgency: a.urgency,
          ...(a.relevantUntil !== undefined ? { relevantUntil: isoToMs(a.relevantUntil) } : {}),
          relatedLoopIds: loops.known,
          ...(a.nextShow !== undefined ? { nextShow: isoToMs(a.nextShow) } : {}),
          ...(a.eventAt !== undefined ? { eventAt: isoToMs(a.eventAt) } : {}),
          ...(claimRows !== undefined ? { claims: claimRows } : {}),
        },
        dependencyContext(dependencies.refs),
        clock(),
      );
      if (!persisted.ok) return deadDependenciesResult(persisted.dead);
      const brief = persisted.value;
      // Retire the superseded cards: stamping relevantUntil = now drops
      // them from the feed immediately (and keeps a snoozed card from
      // resurfacing) while keeping their history — no dismissal reason
      // is minted, because a supersede is the agent refreshing its own
      // card, not user feedback. Deliberately AFTER the create: a crash
      // between the two ops fails open to a temporary duplicate (caught
      // by the next create's refusal) rather than losing the only card.
      const superseded: string[] = [];
      for (const sid of supersedable) {
        await writeGate.updateBrief(
          sid,
          { relevantUntil: clock() },
          dependencyContext([]),
          clock(),
        );
        superseded.push(sid);
      }
      log.info(
        `Cognition Steward run ${runId} created brief ${id}: ${a.title}` +
          (superseded.length > 0 ? ` (supersedes ${superseded.join(", ")})` : ""),
      );
      return ok("brief.created", {
        brief: briefToModelJson(brief),
        ...(claimRows !== undefined ? { assertedClaimCount: claimRows.length } : {}),
        ...(superseded.length > 0 ? { supersededBriefIds: superseded } : {}),
        ...(droppedSupersedes.length > 0 ? { droppedSupersedeIds: droppedSupersedes } : {}),
        ...(citations.dropped.length > 0 ? { droppedCitationIds: citations.dropped } : {}),
        ...(loops.dropped.length > 0 ? { droppedRelatedLoopIds: loops.dropped } : {}),
      });
    },
  };

  // ---- brief_update ----
  const briefUpdateSchema = z
    .object({
      id: z.string().min(1),
      title: z.string().min(1).max(200).optional().describe("Same house style as brief_create."),
      description: z
        .string()
        .max(500)
        .optional()
        .describe("ONE sentence carrying the whole point; doubles as the push line."),
      body: z
        .string()
        .max(20000)
        .nullable()
        .optional()
        .describe(
          "What the user reads — self-sufficient: the number, the reference, the " +
            "deadline mechanics, the stakes. Never a pointer to the source or to another card.",
        ),
      citations: idList.optional(),
      confidence: fraction.optional().describe("Same anchors as brief_create."),
      urgency: fraction.optional().describe("Same anchors as brief_create."),
      relevantUntil: isoDateTime.nullable().optional(),
      relatedLoopIds: idList.optional(),
      nextShow: isoDateTime.nullable().optional(),
      eventAt: isoDateTime.nullable().optional(),
      assertedClaims: assertedClaimsField
        .optional()
        .describe(
          "REPLACES the brief's live asserted-claim set (verified at write time " +
            "exactly like brief_create; the standing claims are retired). Omit to " +
            "leave the claims untouched — so restate every still-true claim when " +
            "passing this.",
        ),
      annotationDependencies: annotationDependenciesField,
    })
    .strict();
  const briefUpdate: ToolHandle = {
    name: "brief_update",
    description:
      "Partially update a brief's content/metadata — pass only the fields " +
      "to change (list fields replace; pass null to clear a nullable " +
      "field). A supplied assertedClaims replaces the live claim set. " +
      "Dismissal state is user-driven and not editable here.",
    schema: briefUpdateSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = briefUpdateSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { id, citations, relatedLoopIds, assertedClaims, ...rest } = parsed.data;
      const dependencies = selectDeclaredDependencies(rest.annotationDependencies);
      if (!dependencies.ok) return dependencies.result;
      const citationsPart = citations !== undefined ? partitionDocIds(db, citations) : null;
      const loopsPart = relatedLoopIds !== undefined ? partitionLoopIds(db, relatedLoopIds) : null;
      const preUpdate = getBrief(db, id);
      // Unknown brief refuses BEFORE the claims teeth — a missing target
      // must not spend verifier calls.
      if (!preUpdate) return notFound("brief", id);
      // The asserted-claims teeth (same as brief_create); a supplied set
      // atomically replaces the live one inside the update's transaction.
      let claimRows: BriefClaimInput[] | undefined;
      if (assertedClaims !== undefined) {
        const vetted = await vetAssertedClaims(deps, assertedClaims, clock());
        if (!vetted.ok) return vetted.refusal;
        const verificationHold = unverifiedBriefClaimsHold(vetted.rows);
        if (verificationHold !== null) return verificationHold;
        claimRows = vetted.rows.map((r) => ({ id: `bclaim_${idGen()}`, ...r }));
      }
      const persisted = await writeGate.updateBrief(
        id,
        {
          ...(rest.title !== undefined ? { title: rest.title } : {}),
          ...(rest.description !== undefined ? { description: rest.description } : {}),
          ...(rest.body !== undefined ? { body: rest.body } : {}),
          ...(citationsPart ? { citations: citationsPart.known } : {}),
          ...(rest.confidence !== undefined ? { confidence: rest.confidence } : {}),
          ...(rest.urgency !== undefined ? { urgency: rest.urgency } : {}),
          ...(rest.relevantUntil !== undefined
            ? { relevantUntil: rest.relevantUntil === null ? null : isoToMs(rest.relevantUntil) }
            : {}),
          ...(loopsPart ? { relatedLoopIds: loopsPart.known } : {}),
          ...(rest.nextShow !== undefined
            ? { nextShow: rest.nextShow === null ? null : isoToMs(rest.nextShow) }
            : {}),
          ...(rest.eventAt !== undefined
            ? { eventAt: rest.eventAt === null ? null : isoToMs(rest.eventAt) }
            : {}),
          ...(claimRows !== undefined ? { claims: claimRows } : {}),
        },
        dependencyContext(dependencies.refs),
        clock(),
      );
      if (!persisted.ok) return deadDependenciesResult(persisted.dead);
      const updated = persisted.value;
      if (!updated) return notFound("brief", id);
      // A retired card (relevance expired — e.g. superseded) accepts
      // edits but stays out of the feed; without a structured warning a
      // scheduled refresh run would edit it and the user would never see
      // the result.
      const editedWhileRetired =
        preUpdate.relevantUntil !== null &&
        preUpdate.relevantUntil <= clock() &&
        rest.relevantUntil === undefined;
      return ok("brief.updated", {
        brief: briefToModelJson(updated),
        ...(claimRows !== undefined ? { assertedClaimCount: claimRows.length } : {}),
        ...(editedWhileRetired
          ? {
              warning:
                "This brief's relevance has expired (it may have been superseded) — it is " +
                "NOT visible on the user's feed. Set relevantUntil to resurface it, or " +
                "apply this update to the active card for the same loop instead.",
            }
          : {}),
        ...(citationsPart && citationsPart.dropped.length > 0
          ? { droppedCitationIds: citationsPart.dropped }
          : {}),
        ...(loopsPart && loopsPart.dropped.length > 0
          ? { droppedRelatedLoopIds: loopsPart.dropped }
          : {}),
      });
    },
  };

  // ---- brief_delete ----
  // Withdraws the card rather than erasing the row. `retired` is terminal, so
  // the brief leaves the feed and every active-brief query by the same `state`
  // predicate the dismissals use, while the record of what was surfaced
  // survives — the only evidence a later run has that it already raised
  // something. The tool keeps its name because "make this card go away" is
  // exactly the contract the model is asking for; whether the row survives is
  // an audit concern rather than part of that contract.
  const briefDeleteSchema = z.object({ id: z.string().min(1).describe("Brief id.") }).strict();
  const briefDelete: ToolHandle = {
    name: "brief_delete",
    description:
      "Withdraw a brief from the feed (it became irrelevant, was superseded, " +
      "or its loop was silently closed). The related loops are untouched. The " +
      "card stops being shown immediately; its record is kept so later runs " +
      "can see what has already been surfaced.",
    schema: briefDeleteSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = briefDeleteSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const retired = await writeGate.retireBrief(parsed.data.id, clock());
      if (!retired) return notFound("brief", parsed.data.id);
      return ok("brief.retired", { briefId: parsed.data.id });
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
                `exact span from the notes shown in your system prompt`,
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
          "End of a range (same formats). Only for lived spans where each covered day " +
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
      "Record a dated fact in the time index, with a one-line sentence and its " +
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
      // The conditional teeth: declared evidence is verified (quote in doc,
      // then quote ⊨ sentence) AFTER the cheap overlap refusal above, so a
      // reconcile refusal never spends a verifier call. The evidence doc is
      // folded into the entry's source links, and the quote is persisted as
      // the entry's grounding atom — surgical invalidation checks against it
      // when the source document's content changes.
      if (a.evidence !== undefined) {
        const refusal = await vetTemporalAnnotationEvidence(deps, a.evidence, a.sentence, clock());
        if (refusal !== null) return refusal;
      }
      const docIdInputs = [
        ...new Set([...(a.documentIds ?? []), ...(a.evidence ? [a.evidence.docId] : [])]),
      ];
      const { known, dropped } = partitionDocIds(db, docIdInputs);
      const loops = partitionLoopIds(db, a.loopIds ?? []);
      const people = partitionPersonRefs(db, a.personIds ?? []);
      const id = `ta_${idGen()}`;
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
    briefList,
    briefFetch,
    briefCreate,
    briefUpdate,
    briefDelete,
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
  | "getEntailmentVerifier"
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
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = annotateDurableSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      // Firewall 1: both the subject and the grounding atom must be real docs
      // (grounding on a document, never another annotation — no compounding).
      if (!docExists(db, a.docId)) return notFound("document", a.docId);
      const evidence = fetchEvidenceDoc(db, a.evidenceDocId);
      if (evidence === null) return notFound("evidence document", a.evidenceDocId);
      // Firewall 2: the evidence must be a real source document, never one of
      // the agent's OWN derived open-loop mirror docs — grounding on your own
      // tracked state is exactly the self-reference the firewall forbids.
      if (evidence.documentType === OPEN_LOOP_DOCUMENT_TYPE) {
        return {
          kind: "error",
          code: "invalid_evidence",
          message:
            "evidenceDocId is a derived open-loop record, not a source document — " +
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
      // Firewall 5 (the entailment gate): the evidence must ESTABLISH the
      // claim, not merely appear in the documents — ONE call judging the
      // claim against the CONCATENATED quotes (a multi-atom grounding is
      // judged jointly; a scalar-only call is byte-identical to before).
      const gate = await runEntailmentGate(
        deps,
        {
          claim: a.claimText,
          evidence: concatenatedGateEvidence([a.evidenceQuote, ...additional.map((e) => e.quote)]),
        },
        clock(),
      );
      if (gate.kind === "refused") return entailmentRefusal(gate.verdict);
      const id = `anno_${idGen()}`;
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
          evidence:
            atoms.length > 0
              ? concatenatedGateEvidence(atoms.map((e) => e.evidenceQuote))
              : existing.evidenceQuote,
        },
        clock(),
      );
      if (gate.kind === "refused") return entailmentRefusal(gate.verdict);
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
    .object({ id: z.string().min(1).describe("The annotation id to retract (hard delete).") })
    .strict();
  const annotationRetract: ToolHandle = {
    name: "annotation_retract",
    description:
      "Retract (permanently delete) a durable observation you recorded earlier " +
      "when it is wrong or no longer relevant — a mistaken read, a superseded " +
      "conclusion. Hard delete: the derived text is removed outright.",
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
    })
    .strict()
    .refine((a) => (a.docId !== undefined) !== (a.personId !== undefined), {
      message: "supply exactly one of docId or personId",
    });
  const annotationSearch: ToolHandle = {
    name: "annotation_search",
    description:
      "List the durable annotations already recorded about ONE subject — a " +
      "document (docId) or a person (personId). Read this BEFORE recording a " +
      "new observation on the same subject: revise or supersede an existing " +
      "claim instead of duplicating or contradicting it. Each row carries its " +
      "evidence doc id and verbatim quote — priors to re-ground, never facts.",
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
      const rows = listLivePersonAnnotationsForPerson(db, personId, limit);
      deps.consumption?.note(
        "person",
        rows.map((r) => r.id),
      );
      return ok("annotation.search_results", {
        personId,
        annotations: project(rows),
      });
    },
  };

  // ---- annotate_person ----
  // Person-keyed sibling of annotate_durable. Same evidence firewall (real
  // evidence doc, verbatim quote, confidence ceiling, no self-grounding on a
  // derived open-loop mirror), but the subject is a PERSON resolved to its
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
        .string()
        .min(1)
        .optional()
        .describe(
          "Id of a LIVE annotation on this SAME person that this claim REPLACES (an updated or corrected belief) — it is retired the moment this one persists, audit-linked to its successor.",
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
      "PRIOR future runs can read (a role, a relationship, a stable preference). " +
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
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = annotatePersonSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const a = parsed.data;
      // Firewall 1 (person side): the subject must resolve to a known person
      // (walks merge chains / resolves an email through aliases). Unknown → 404.
      const personId = resolveLoopPersonRef(db, a.personId);
      if (personId === null) return notFound("person", a.personId);
      // Firewall 2: the grounding atom must be a real source document.
      const evidence = fetchEvidenceDoc(db, a.evidenceDocId);
      if (evidence === null) return notFound("evidence document", a.evidenceDocId);
      // Firewall 3: never ground on a derived open-loop mirror doc.
      if (evidence.documentType === OPEN_LOOP_DOCUMENT_TYPE) {
        return {
          kind: "error",
          code: "invalid_evidence",
          message:
            "evidenceDocId is a derived open-loop record, not a source document — " +
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
      if (a.supersedes !== undefined) {
        const target = getPersonAnnotation(db, a.supersedes);
        if (target === null) {
          return invalidSupersede(`annotation ${a.supersedes} does not exist in the person store`);
        }
        if (target.invalidatedAt !== null) {
          return invalidSupersede(`annotation ${a.supersedes} is no longer live`);
        }
        const targetCanonical = resolveLoopPersonRef(db, target.personId) ?? target.personId;
        if (targetCanonical !== personId) {
          return invalidSupersede(
            `annotation ${a.supersedes} is about person ${targetCanonical}, not ${personId}`,
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
        limit: CONFLICT_PROBE_LIMIT,
        ...(a.supersedes !== undefined ? { excludeId: a.supersedes } : {}),
      });
      if (standing.length > 0) {
        return annotationConflictRefusal(
          "person_annotation.conflict_candidates",
          standing,
          CREATE_CONFLICT_GUIDANCE,
        );
      }
      // Firewall 6 (the entailment gate): the evidence must ESTABLISH the
      // claim — ONE call judging it against the CONCATENATED quotes (a
      // scalar-only call is byte-identical to before).
      const gate = await runEntailmentGate(
        deps,
        {
          claim: a.claimText,
          evidence: concatenatedGateEvidence([a.evidenceQuote, ...additional.map((e) => e.quote)]),
        },
        clock(),
      );
      if (gate.kind === "refused") return entailmentRefusal(gate.verdict);
      const id = `panno_${idGen()}`;
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
        const res = await writeGate.createPersonAnnotationSuperseding(input, a.supersedes, clock());
        annotation = res.annotation;
        supersedeLost = !res.superseded;
      } else {
        annotation = await writeGate.createPersonAnnotation(input, clock());
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
        ...(a.supersedes !== undefined && !supersedeLost ? { supersededId: a.supersedes } : {}),
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
      "text/type or lower its confidence. The evidence grounding is immutable; " +
      "to re-ground on a different quote, retract and re-create.",
    schema: personAnnotationReviseSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = personAnnotationReviseSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const { id, ...rest } = parsed.data;
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
      const gate = await runEntailmentGate(
        deps,
        {
          claim: rest.claimText ?? existing.claimText,
          evidence:
            atoms.length > 0
              ? concatenatedGateEvidence(atoms.map((e) => e.evidenceQuote))
              : existing.evidenceQuote,
        },
        clock(),
      );
      if (gate.kind === "refused") return entailmentRefusal(gate.verdict);
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
      const revised = await writeGate.revisePersonAnnotation(id, patch, clock());
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
      "Retract (permanently delete) a person annotation that turned out wrong " +
      "or was superseded. Reserve for genuine mistakes; a claim that merely " +
      "weakened should be revised with lower confidence instead.",
    schema: personAnnotationRetractSchema,
    mutates: true,
    summarize: (args) => (args as { id?: string })?.id,
    async invoke(rawArgs): Promise<ToolResult> {
      const parsed = personAnnotationRetractSchema.safeParse(rawArgs);
      if (!parsed.success) return invalidArgs(parsed.error);
      const removed = await writeGate.retractPersonAnnotation(parsed.data.id, clock());
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
    async invoke(rawArgs): Promise<ToolResult> {
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
      const { superseded } = await writeGate.supersedePersonAnnotationBy(
        a.id,
        a.supersededBy,
        clock(),
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
