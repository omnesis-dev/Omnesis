// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Edge-emission filters. Pure predicates over per-document metadata —
 * no I/O. Designed to live in the production writer path as well:
 * any near-duplicate edge for which `isExactDupe` or `isSameThread`
 * holds should be suppressed at emit time, because Omnesis already
 * carries a different (and more specific) edge for that relationship.
 */

export interface FilterDocMeta {
  /** Bytewise content hash recorded at ingest. */
  contentHash: string | null;
  /** Hash of the extracted-text payload for attachments / files. */
  extractedContentHash: string | null;
  /** "email", "attachment", etc. */
  docType: string;
  /** Email-thread identifier, when applicable. */
  threadId: string | null;
}

/**
 * True when Omnesis would already consider these documents exact
 * duplicates via its content-hash equality path. Production should
 * emit an `exact-duplicate` edge instead of a `near-duplicate` edge.
 */
export function isExactDupe(a: FilterDocMeta, b: FilterDocMeta): boolean {
  if (a.contentHash && b.contentHash && a.contentHash === b.contentHash) return true;
  if (
    a.extractedContentHash &&
    b.extractedContentHash &&
    a.extractedContentHash === b.extractedContentHash
  ) {
    return true;
  }
  return false;
}

/**
 * True when both docs are emails in the same provider thread. Reply
 * bodies routinely embed parent bodies, so same-thread pairs trigger
 * the near-duplicate signal without representing a new relationship —
 * the thread membership graph already captures it.
 */
export function isSameThread(a: FilterDocMeta, b: FilterDocMeta): boolean {
  if (a.docType !== "email" || b.docType !== "email") return false;
  return a.threadId !== null && a.threadId === b.threadId;
}

/**
 * Composite decision: should the product layer surface this pair as
 * a near-duplicate edge? Returns the reason for suppression, or null
 * if the pair survives.
 */
export type FilterReason = "exact-dupe" | "same-thread" | null;

export function shouldSuppress(a: FilterDocMeta, b: FilterDocMeta): FilterReason {
  if (isExactDupe(a, b)) return "exact-dupe";
  if (isSameThread(a, b)) return "same-thread";
  return null;
}
