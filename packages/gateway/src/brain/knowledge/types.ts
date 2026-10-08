// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

export type KnowledgeNodeKind =
  | "wiki"
  | "root"
  | "loop"
  | "doc_annotation"
  | "person_annotation"
  | "brief";
export type KnowledgeValidity = "current" | "stale";
export type KnowledgeVerification = "unverified" | "verified" | "rejected" | "stale";
export type KnowledgeRelation = "supports" | "contradicts" | "context" | "depends_on";
export type KnowledgeModality =
  | "observation"
  | "reported"
  | "proposal"
  | "commitment"
  | "inference"
  | "recommendation"
  | "question";
export type KnowledgeEpistemicStatus = "asserted" | "disputed" | "unsupported";
export type KnowledgeRevision = string | number;

export interface KnowledgeReviewMetadata {
  importance?: number;
  volatility?: number;
  uncertainty?: number;
  activity?: "active" | "quiet" | "historical";
  nextReviewAt?: number | null;
  lastVerifiedAt?: number | null;
  lastReviewedAt?: number | null;
  checkpointAt?: number | null;
  reviewDecision?: "now" | "defer" | "dormant";
  reviewReason?: string;
  reviewDecidedAt?: number;
}

export interface KnowledgeNode {
  id: string;
  kind: KnowledgeNodeKind;
  ownerId: string | null;
  title: string;
  markdown: string;
  plainText: string;
  revision: number;
  meaningRevision: number;
  validity: KnowledgeValidity;
  metadata: KnowledgeReviewMetadata;
  canonicalFields: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeClaimState {
  /** Claim IDs come from the markup; every supplied state must match a parsed claim. */
  id: string;
  supportLogic?: "all" | "any";
  attribution?: string | null;
  modality?: KnowledgeModality;
  epistemicStatus?: KnowledgeEpistemicStatus;
  relations?: Record<string, KnowledgeRelation>;
  validFrom?: number | null;
  validUntil?: number | null;
  /** Attestations are produced by the trusted verifier, never accepted from model tools. */
  verification?: {
    status: "verified" | "rejected";
    fingerprint: string;
    verifier: string;
    /** Exact sufficient branch accepted for any-support entailment. */
    witnessRefs?: string[];
  };
}

export interface KnowledgeClaim {
  id: string;
  meaningRevision: number;
  nodeId: string;
  text: string;
  parentId: string | null;
  start: number;
  end: number;
  refs: string[];
  supportLogic: "all" | "any";
  attribution: string | null;
  modality: KnowledgeModality;
  epistemicStatus: KnowledgeEpistemicStatus;
  verification: KnowledgeVerification;
  fingerprint: string;
  witnessRefs: string[];
  validFrom: number | null;
  validUntil: number | null;
}

export interface KnowledgeSaveResult {
  node: KnowledgeNode;
  meaningChanged: boolean;
  /** Internal writer receipt; stripped before exposing tool results. */
  reconciliationReceipt?: import("./reconciliation.js").KnowledgeReconciliationReceipt;
}

export interface SaveKnowledgeNodeInput {
  runFence?: import("./run-fence.js").KnowledgeRunFence;
  /** Internal scheduler lease, never supplied by model arguments. */
  maintenance?: {
    batchId: string;
    runId: string;
    inputFingerprint: string;
    reviewedClaimIds?: readonly string[];
  };
  id: string;
  kind: KnowledgeNodeKind;
  ownerId?: string | null;
  title: string;
  markdown: string;
  /** Zero means create; updates must name the exact revision read by the caller. */
  expectedRevision: number;
  /** Every reference names its observed source content hash or synthesis meaningRevision; edit revision is only for OCC. */
  inputVersions: Record<string, KnowledgeRevision>;
  claims?: KnowledgeClaimState[];
  /** Explicit intent for omitted wiki/root claims; independent of review completion. */
  claimRemovals?: Array<{ id: string; reason: string }>;
  /** Internal model-save boundary flag, never accepted from tool arguments. */
  enforceClaimPreservation?: boolean;
  metadata?: KnowledgeReviewMetadata;
  canonicalFields?: Record<string, unknown>;
  /** Root budget applies to the tagged representation too, so prompt injection stays bounded. */
  rootMaxChars?: number;
}

export interface KnowledgeChange {
  seq: number;
  kind:
    | "source_changed"
    | "source_evidence_changed"
    | "source_deleted"
    | "node_changed"
    | "node_invalidated"
    | "node_deleted";
  entityId: string;
  revision: string;
  at: number;
}

export interface KnowledgeDependency {
  nodeId: string;
  claimId: string;
  ref: string;
  targetId: string;
  targetKind: "source" | "node";
  relation: KnowledgeRelation;
  inputVersion: KnowledgeRevision;
}

export class KnowledgeStorageError extends Error {
  constructor(
    readonly code:
      | "revision_conflict"
      | "reference_invalid"
      | "claim_invalid"
      | "cycle"
      | "root_conflict",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeStorageError";
  }
}
