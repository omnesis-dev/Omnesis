// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import type { KnowledgeClaim, KnowledgeNode, KnowledgeReviewMetadata } from "./types.js";

/** Review metadata the steward may set on knowledge_save. Everything else is system-owned. */
export const EDITABLE_METADATA_KEYS = [
  "importance",
  "volatility",
  "uncertainty",
  "activity",
  "nextReviewAt",
  "checkpointAt",
] as const;

type EditableMetadata = Pick<KnowledgeReviewMetadata, (typeof EDITABLE_METADATA_KEYS)[number]>;

/** Claim state the steward may set on knowledge_save, keyed by claim id. */
export interface EditableClaimState {
  id: string;
  supportLogic: KnowledgeClaim["supportLogic"];
  attribution: string | null;
  modality: KnowledgeClaim["modality"];
  epistemicStatus: KnowledgeClaim["epistemicStatus"];
  validFrom: number | null;
  validUntil: number | null;
}

export type KnowledgeNodeView = Omit<KnowledgeNode, "metadata"> & {
  metadata: EditableMetadata;
  claims: EditableClaimState[];
  readOnly: {
    note: string;
    review: Omit<KnowledgeReviewMetadata, (typeof EDITABLE_METADATA_KEYS)[number]>;
    claims: Array<
      Pick<
        KnowledgeClaim,
        "id" | "text" | "parentId" | "refs" | "verification" | "witnessRefs" | "meaningRevision"
      >
    >;
  };
};

const READ_ONLY_NOTE =
  "System-owned state for reading only. knowledge_save never accepts these fields: claim refs come from the <claim refs> markup, support roles go in claims[].relations, and the verifier alone sets verification and review state.";

/**
 * The model-facing shape of a stored synthesis node. Its `metadata` and
 * `claims` hold exactly the fields knowledge_save accepts, so a revision can
 * copy them unchanged; references, verification and review state, which only
 * the markup or the verifier may change, sit under `readOnly`.
 */
export function knowledgeNodeView(
  node: KnowledgeNode & { claims: KnowledgeClaim[] },
): KnowledgeNodeView {
  const { metadata, claims, ...rest } = node;
  const editable: EditableMetadata = {};
  const review: KnowledgeNodeView["readOnly"]["review"] = {};
  for (const [key, value] of Object.entries(metadata) as Array<
    [keyof KnowledgeReviewMetadata, never]
  >) {
    if ((EDITABLE_METADATA_KEYS as readonly string[]).includes(key))
      editable[key as keyof EditableMetadata] = value;
    else review[key as keyof typeof review] = value;
  }
  return {
    ...rest,
    metadata: editable,
    claims: claims.map((claim) => ({
      id: claim.id,
      supportLogic: claim.supportLogic,
      attribution: claim.attribution,
      modality: claim.modality,
      epistemicStatus: claim.epistemicStatus,
      validFrom: claim.validFrom,
      validUntil: claim.validUntil,
    })),
    readOnly: {
      note: READ_ONLY_NOTE,
      review,
      claims: claims.map((claim) => ({
        id: claim.id,
        text: claim.text,
        parentId: claim.parentId,
        refs: claim.refs,
        verification: claim.verification,
        witnessRefs: claim.witnessRefs,
        meaningRevision: claim.meaningRevision,
      })),
    },
  };
}

const CLAIM_ECHO =
  "is read-only claim state from knowledge_fetch.readOnly: claim refs come from the <claim refs> markup in node.markdown, support roles go in claims[].relations, and the verifier sets verification. Remove it";
const REVIEW_ECHO = `is system-owned review state. Writable metadata keys are ${EDITABLE_METADATA_KEYS.join(", ")}. Remove it`;

/** Why a key a node read returns is refused on save, so a retry can fix the call in one step. */
const ECHO_HINTS: Record<"claim" | "metadata" | "node", Record<string, string>> = {
  claim: Object.fromEntries(
    ["refs", "text", "parentId", "verification", "witnessRefs", "meaningRevision", "verifier"].map(
      (key) => [key, CLAIM_ECHO],
    ),
  ),
  metadata: Object.fromEntries(
    [
      "lastVerifiedAt",
      "lastReviewedAt",
      "reviewDecision",
      "reviewReason",
      "reviewDecidedAt",
      "reviewRequests",
    ].map((key) => [key, REVIEW_ECHO]),
  ),
  node: {
    reviewedClaimIds: "belongs at the top level beside node, not inside it",
    revision: "is the stored revision; send it as node.expectedRevision",
    readOnly: "is read-only state from knowledge_fetch. Remove it",
    plainText: "is derived from node.markdown. Remove it",
    meaningRevision: "is system-owned. Remove it",
    validity: "is system-owned. Remove it",
    canonicalFields: "is read-only; change canonical fields with their owner's tools",
    createdAt: "is system-owned. Remove it",
    updatedAt: "is system-owned. Remove it",
  },
};

/**
 * Error for an unknown key on a knowledge_save object. A key that a node read
 * returns gets a message naming where its value belongs; any other key is
 * named as not accepted.
 */
export function echoKeyError(where: keyof typeof ECHO_HINTS) {
  return (issue: { code?: string; keys?: readonly string[] }): string | undefined => {
    if (issue.code !== "unrecognized_keys" || !issue.keys?.length) return undefined;
    const hints = issue.keys.map(
      (key) => `${JSON.stringify(key)} ${ECHO_HINTS[where][key] ?? "is not accepted here"}`,
    );
    return `Unrecognized ${issue.keys.length === 1 ? "key" : "keys"}: ${hints.join("; ")}`;
  };
}
