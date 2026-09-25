// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Wire shapes for the near-duplicate detection pipeline. Shared
 * between the compute and writer sides via the scheduler worker
 * dispatch; also re-exported by the HTTP service as the response DTO.
 */

/** Single row to write to `near_dup_signatures`. */
export interface NearDupSignatureUpsert {
  docId: string;
  algoVersion: string;
  /** Packed signature bytes. Encoding is implicit in `algoVersion`. */
  signature: Buffer;
  shingleCount: number;
}

/** Single row to write to `near_dup_lsh_buckets`. */
export interface NearDupBucketUpsert {
  algoVersion: string;
  bandIdx: number;
  bucketHash: number;
  docId: string;
}

/** Single row to write to `near_dup_edges`. Doc-ids in canonical order. */
export interface NearDupEdgeUpsert {
  docA: string;
  docB: string;
  algoVersion: string;
  jaccard: number;
  pairUniqueDf2: number;
  pairUniqueDf5: number;
  containmentMin: number;
  gateFamily: string;
}

export interface NearDupEdgeDelete {
  docA: string;
  docB: string;
  algoVersion: string;
}

/**
 * Snapshot emitted by the compute pass, applied atomically by the
 * writer pass. One snapshot covers up to `computeBatchSize` inbox
 * entries.
 */
export interface NearDupApplyBatch {
  algoVersion: string;
  /** Inbox row ids the writer should delete after applying. */
  processedInboxIds: number[];
  /**
   * Totals already written by the earlier calls of a yielded apply.
   * Present only on the remainder the writer hands its own continuation:
   * a batch counts what it wrote, and without this the caller sees only
   * the last continuation's slice of a batch that took several.
   */
  carried?: NearDupApplyResult;
  /** Doc ids whose existing signatures + bucket rows + edges must be cleared. */
  signatureDeletes: string[];
  signatures: NearDupSignatureUpsert[];
  bucketRows: NearDupBucketUpsert[];
  edgeUpserts: NearDupEdgeUpsert[];
  edgeDeletes: NearDupEdgeDelete[];
}

/** Result of applying a NearDupApplyBatch on the writer worker. */
export interface NearDupApplyResult {
  inboxConsumed: number;
  signaturesUpserted: number;
  bucketsUpserted: number;
  edgesUpserted: number;
  edgesDeleted: number;
}

/**
 * Snapshot of the per-shingle DF table produced by `NearDupDfService`
 * and applied atomically by the writer (with old rows wiped first).
 *
 * `capturedVersion` is the value of `refresh_meta(job='near_dup_df').dirty_version`
 * at the start of the compute scan — the writer advances
 * `last_computed_version` to this value on a successful apply so the
 * next periodic tick can tell whether a dirty bump landed during compute.
 */
export interface NearDupDfSnapshot {
  algoVersion: string;
  totalDocs: number;
  /** Iterable over shingle → df for memory-friendly streaming writes. */
  entries: ReadonlyArray<{ shingle: string; df: number }>;
  uniqueShingles: number;
  capturedVersion: number;
}

/** HTTP response edge — the shape the portal / iOS consume. */
export interface NearDupEdgeDto {
  otherDocId: string;
  otherTitle: string;
  otherSourceId: string;
  otherDocType: string;
  /** `metadata.sourceUrl` of the other doc — the link its provider
   *  published, when it has one. Clients prefer it over the in-app viewer. */
  otherSourceUrl: string | null;
  /** `metadata.appUrl` of the other doc — native deep link preferred
   *  on mobile over `otherSourceUrl` when present. */
  otherAppUrl: string | null;
  jaccard: number;
  pairUniqueDf2: number;
  pairUniqueDf5: number;
  containmentMin: number;
  gateFamily: string;
}

export interface NearDupEdgesResponse {
  edges: NearDupEdgeDto[];
  nextCursor: string | null;
}
