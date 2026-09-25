// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The Briefs / Cognition Steward feature module (experimental; inert unless the
 * feature is active). This barrel is the module's stable surface for the
 * handful of shared-code extension points (schema setup, the document
 * privacy-delete cascade, the hidden-search registration); feature-
 * internal code imports the submodules directly.
 */

export { createBriefsStorageTables } from "./storage/schema.js";
// Per-source coverage tallies. What crosses the module boundary: the DDL
// (schema setup + the migration that introduced the table) and the existence
// guard the cognitive-state cascade reads. The write ops ride the write gate,
// which imports the submodule directly, as do the feature-internal readers.
export { createCognitionCoverageTable, hasAnyCognitionCoverage } from "./storage/coverage.js";
// The retrospective lane's marker indexes. They live on `documents`, a shared
// table, but the predicates they serve are this module's, so the DDL does too —
// and schema setup and the migration call the same definition.
export { createBootstrapMarkerIndexes } from "./storage/bootstrap.js";
// Brief-claims sidecar — the per-brief atomic asserted claims. What crosses
// the module boundary: the DDL (schema setup + migration 58), the
// evidence-doc lifecycle ops the write gate dispatches (content-change
// invalidation + the privacy cascade), and the existence guard the
// DocumentService privacy-delete seam reads. The set writes ride inside the
// brief create/update writer ops (storage/briefs.ts) and the
// feature-internal readers import the submodule directly.
export {
  createBriefClaimsTables,
  invalidateBriefClaimsForDoc,
  cascadeBriefClaimPrivacyDelete,
  hasAnyBriefClaims,
} from "./storage/brief-claims.js";
// Durable doc-annotation store — DDL + write/read ops. Some are consumed
// by the write gate (single-writer), the rest read directly at prompt-build
// and invalidation time; `listLiveAnnotationsForDoc` also backs the
// GET /documents/:id/annotations read.
export {
  createAnnotationStorageTables,
  createDocAnnotation,
  createDocAnnotationSuperseding,
  supersedeDocAnnotationBy,
  updateDocAnnotation,
  deleteDocAnnotation,
  getDocAnnotation,
  invalidateAnnotationsForDoc,
  cascadeAnnotationPrivacyDelete,
  hasAnyDocAnnotations,
  listLiveAnnotationsForDoc,
  type AnnotationEvidenceInput,
  type CreateDocAnnotationInput,
  type UpdateDocAnnotationPatch,
  type DocAnnotationRow,
  type AnnotationInvalidationResult,
} from "./storage/annotations.js";
// Consumption provenance — which briefs/loops were built on which annotation
// priors. The DDL crosses the module boundary (schema setup + migration 59);
// The mutation helper is consumed by the write gate so dependent writes and
// their edges share one transaction; reads stay feature-internal imports.
export {
  createConsumptionEdgesTables,
  recordConsumptionEdges,
  mutateWithConsumptionDependencies,
  retractAnnotationWithDependentRechecks,
  enqueueRechecksForMissingConsumptionPriors,
  type ConsumptionEdgeInput,
  type ConsumptionDependencyContext,
  type ConsumptionMutationResult,
} from "./storage/consumption-edges.js";
// Durable PERSON-annotation store — the person-keyed sibling of the
// doc-annotation store above. This barrel carries the shared-code extension
// points: schema setup, the single-writer write-gate ops, and the
// privacy/existence guards the DocumentService cascade reads. Feature-internal
// readers (synthesis prime, person read-back, the invalidator, the revise
// firewall) import the submodule directly.
export {
  createPersonAnnotationStorageTables,
  createPersonAnnotation,
  createPersonAnnotationSuperseding,
  supersedePersonAnnotationBy,
  revisePersonAnnotation,
  deletePersonAnnotation,
  invalidatePersonAnnotationsForDoc,
  cascadePersonAnnotationPrivacyDelete,
  hasAnyPersonAnnotations,
  type CreatePersonAnnotationInput,
  type UpdatePersonAnnotationPatch,
  type PersonAnnotationRow,
} from "./storage/person-annotations.js";
// Open-loop / brief / notes write ops, consumed by the write gate (the
// Cognition Steward's tools mutate through it — single-writer invariant).
export {
  cascadeOpenLoopPrivacyDelete,
  listLoopIdsCitingDocs,
  hasAnyOpenLoops,
  createOpenLoop,
  updateOpenLoop,
  rewriteOpenLoopPeople,
  appendOpenLoopLedger,
  deleteOpenLoop,
  type CreateOpenLoopInput,
  type UpdateOpenLoopInput,
  type DeleteOpenLoopResult,
} from "./storage/open-loops.js";
export {
  createBrief,
  updateBrief,
  retractBriefsForResolvedLoop,
  retireBrief,
  markBriefRead,
  setBriefThreadConversation,
  restampBriefThreadConversation,
  resurfaceDueSnoozedBriefs,
  type CreateBriefInput,
  type UpdateBriefInput,
  type MarkBriefReadResult,
} from "./storage/briefs.js";
export {
  writeCognitionNotes,
  appendCognitionNotes,
  editCognitionNotes,
  wipeCognitionNotes,
  type AppendCognitionNotesResult,
  type EditCognitionNotesResult,
} from "./storage/notes.js";
// Dismissal (state flip + feedback-run enqueue, atomic) — consumed by the
// write gate; the HTTP dismiss route is its only production caller.
export {
  dismissBriefAndEnqueueFeedback,
  type DismissBriefInput,
  type DismissBriefResult,
} from "./feedback.js";
export type { OpenLoopRow, BriefRow } from "./storage/types.js";
export { OPEN_LOOP_SOURCE_ID, OPEN_LOOP_PROVIDER_ID } from "./open-loop-source/source-meta.js";
// NOTE: `cognition-authored.js` is deliberately NOT re-exported here. Its
// consumers are the watch runtime and the retrieval layer
// (search/hidden-sources), neither of which should pull this barrel in to
// reach a leaf module with no dependencies of its own.
export { bootBriefs, briefsFeatureStatus, type BriefsFeatureStatus } from "./feature-gate.js";
export { resolveBrainSettings } from "./config.js";
// NOTE: `backend-resolver.js` is deliberately NOT re-exported here — it
// pulls the agent-service graph, and this barrel is imported by the
// writer worker (via writer-handlers) and by schema setup, both of which
// must stay light. The composition root imports it by submodule path.
// Run-queue write ops, consumed by the writer worker's handler registry.
export {
  enqueueCognitionRun,
  claimDueCognitionRuns,
  finalizeCognitionRun,
  recordSettledCognitionRun,
  cancelPendingCognitionRunsByDedupeKeys,
  pullForwardReadyCognitionRun,
  cancelScheduledRunsForLoop,
  type EnqueueCognitionRunInput,
  type EnqueueCognitionRunResult,
  type FinalizeCognitionRunInput,
  type RecordSettledCognitionRunInput,
} from "./storage/run-queue.js";
export { addToCognitionEngineCounter, setCognitionEngineState } from "./storage/engine-state.js";
// Per-mechanism spend accounting — consumed by the write gate so non-run
// mechanisms (the entailment gate) fold their token usage into
// `cognition_spend` through the single writer.
export { recordCognitionSpend, cognitionSpendDay } from "./storage/spend.js";
export type { ClaimedCognitionRun, CognitionRunUsage } from "./storage/types.js";

// The sweep set — system sweeps layered with the operator's files. Crosses the
// module boundary because the composition root constructs it (the HTTP surface
// mounts before bootBriefs runs) and hands the same instance to both.
export { SweepService } from "./sweeps/service.js";
