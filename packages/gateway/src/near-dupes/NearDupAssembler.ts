// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Main-thread assembly helpers for the three-phase near-dup pipeline.
 * These combine results from the fetch, sign, and verify phases into
 * the `NearDupApplyBatch` that the writer applies.
 */

import { normalizeText, shingles, type NearDupeConfig } from "@omnesis/near-dupes";
import { isEligibleForNearDup } from "./eligibility.js";
import { parseDocMeta } from "./cpu-signing.js";
import type {
  NearDupDocForSigning,
  SignedDoc,
  CandidateDocData,
  VerifyPairInput,
  VerifyDocMeta,
  VerifiedPair,
} from "./cpu-signing.js";
import type { NearDupFetchResult, NearDupCandidateFetchResult } from "./NearDupComputeService.js";
import type {
  NearDupApplyBatch,
  NearDupEdgeDelete,
  NearDupEdgeUpsert,
  NearDupSignatureUpsert,
} from "./types.js";

/**
 * Assemble verify-pair inputs from signed docs, persisted candidates,
 * and in-batch candidates. Runs on the main thread.
 */
export function assembleVerifyPairs(
  signedDocs: SignedDoc[],
  candidateResult: NearDupCandidateFetchResult,
  algoConfig: NearDupeConfig,
  eligibleDocTypes: string[],
  maxCandidatesPerDoc: number,
): VerifyPairInput[] {
  const eligible = new Set(eligibleDocTypes);
  const signedByDocId = new Map<string, SignedDoc>();
  for (const s of signedDocs) {
    if (!s.shouldDelete && s.bands) signedByDocId.set(s.docId, s);
  }

  // Build in-batch band index for cross-batch candidate detection.
  const inBatchBuckets = new Map<string, string[]>();
  for (const s of signedByDocId.values()) {
    if (!s.bands) continue;
    for (let b = 0; b < s.bands.length; b++) {
      const key = `${b}|${s.bands[b]}`;
      const arr = inBatchBuckets.get(key);
      if (arr) arr.push(s.docId);
      else inBatchBuckets.set(key, [s.docId]);
    }
  }

  const pairs: VerifyPairInput[] = [];
  const emittedPairs = new Set<string>();

  // A persisted candidate is typically proposed by several documents in the
  // same batch, and normalizing + shingling it costs time proportional to
  // its length. This runs on the gateway's main thread, where that cost is
  // charged to every in-flight HTTP request, so each candidate is prepared
  // once per batch rather than once per pair. `null` records a candidate
  // that yields no usable shingle set, so it is not re-examined either.
  const preparedCandidates = new Map<string, { shingles: string[]; meta: VerifyDocMeta } | null>();
  const prepareCandidate = (candId: string): { shingles: string[]; meta: VerifyDocMeta } | null => {
    const cached = preparedCandidates.get(candId);
    if (cached !== undefined) return cached;
    let prepared: { shingles: string[]; meta: VerifyDocMeta } | null = null;
    const candData = candidateResult.candidates[candId];
    if (candData) {
      const parsed = parseDocMeta(candData.metadata);
      if (isEligibleForNearDup(parsed.docType, eligible)) {
        const sh = shingles(
          normalizeText(candData.content, { stripQuotes: algoConfig.stripQuotes }),
          algoConfig.shingleSize,
        );
        if (sh.size > 0) {
          prepared = {
            shingles: [...sh],
            meta: {
              contentHash: candData.contentHash,
              extractedContentHash: candData.extractedContentHash,
              docType: parsed.docType,
              threadId: parsed.threadId,
              senderAddress: parsed.senderAddress,
            },
          };
        }
      }
    }
    preparedCandidates.set(candId, prepared);
    return prepared;
  };

  for (const signed of signedByDocId.values()) {
    if (!signed.bands || !signed.shingles) continue;

    const candidateIds = new Set<string>();

    // In-batch candidates
    for (let b = 0; b < signed.bands.length; b++) {
      const arr = inBatchBuckets.get(`${b}|${signed.bands[b]}`);
      if (!arr) continue;
      for (const other of arr) if (other !== signed.docId) candidateIds.add(other);
    }

    // Persisted candidates for THIS doc (per-doc, not merged)
    const perDocCandIds = candidateResult.candidateIdsByDoc[signed.docId] ?? [];
    for (const cid of perDocCandIds) candidateIds.add(cid);

    let cappedCandidates = [...candidateIds];
    if (cappedCandidates.length > maxCandidatesPerDoc) {
      cappedCandidates = cappedCandidates.slice(0, maxCandidatesPerDoc);
    }

    for (const candId of cappedCandidates) {
      const [docA, docB] = signed.docId < candId ? [signed.docId, candId] : [candId, signed.docId];
      const pairKey = `${docA}|${docB}`;
      if (emittedPairs.has(pairKey)) continue;
      emittedPairs.add(pairKey);

      // Get candidate shingles — either from in-batch signed docs or from fetched candidates
      const inBatch = signedByDocId.get(candId);
      let candidateShingles: string[] | null;
      let candidateMeta: VerifyDocMeta;

      if (inBatch && inBatch.shingles) {
        candidateShingles = inBatch.shingles;
        candidateMeta = {
          contentHash: inBatch.contentHash,
          extractedContentHash: inBatch.extractedContentHash,
          docType: inBatch.docType,
          threadId: inBatch.threadId,
          senderAddress: inBatch.senderAddress,
        };
      } else {
        const prepared = prepareCandidate(candId);
        if (!prepared) continue;
        candidateShingles = prepared.shingles;
        candidateMeta = prepared.meta;
      }

      if (!candidateShingles) continue;

      pairs.push({
        docId: signed.docId,
        candidateId: candId,
        docShingles: signed.shingles,
        candidateShingles,
        docMeta: {
          contentHash: signed.contentHash,
          extractedContentHash: signed.extractedContentHash,
          docType: signed.docType,
          threadId: signed.threadId,
          senderAddress: signed.senderAddress,
        },
        candidateMeta,
      });
    }
  }

  return pairs;
}

/**
 * Assemble the final `NearDupApplyBatch` from all phase results.
 */
export function assembleFinalBatch(
  fetched: NearDupFetchResult,
  signedDocs: SignedDoc[],
  candidateResult: NearDupCandidateFetchResult,
  verifiedPairs: VerifiedPair[],
  algoVersion: string,
): NearDupApplyBatch {
  const batch: NearDupApplyBatch = {
    algoVersion,
    processedInboxIds: [],
    signatureDeletes: [],
    signatures: [],
    bucketRows: [],
    edgeUpserts: [],
    edgeDeletes: [],
  };

  // Inbox IDs
  for (const row of fetched.inboxRows) {
    batch.processedInboxIds.push(row.id);
  }

  // Signature deletes for delete-reason and ineligible docs
  for (const docId of fetched.deleteDocIds) {
    batch.signatureDeletes.push(docId);
  }

  // Process signed docs
  for (const signed of signedDocs) {
    // All signed docs get a signature delete (delete-then-add pattern)
    batch.signatureDeletes.push(signed.docId);

    if (!signed.shouldDelete && signed.signatureBytes && signed.bands) {
      batch.signatures.push({
        docId: signed.docId,
        algoVersion,
        signature: Buffer.from(signed.signatureBytes),
        shingleCount: signed.shingleCount,
      });
      for (let b = 0; b < signed.bands.length; b++) {
        batch.bucketRows.push({
          algoVersion,
          bandIdx: b,
          bucketHash: signed.bands[b],
          docId: signed.docId,
        });
      }
    }
  }

  // Edge upserts from verified pairs
  const writtenEdges = new Set<string>();
  for (const pair of verifiedPairs) {
    if (!pair.accepted) continue;
    const edgeKey = `${pair.docA}|${pair.docB}`;
    if (writtenEdges.has(edgeKey)) continue;
    writtenEdges.add(edgeKey);
    batch.edgeUpserts.push({
      docA: pair.docA,
      docB: pair.docB,
      algoVersion,
      jaccard: pair.jaccard,
      pairUniqueDf2: pair.pairUniqueDf2,
      pairUniqueDf5: pair.pairUniqueDf5,
      containmentMin: pair.containmentMin,
      gateFamily: pair.gateFamily,
    });
  }

  // Edge deletes for update-reason docs: edges that existed before but
  // weren't re-emitted by the verify phase are stale.
  for (const signed of signedDocs) {
    if (signed.reason !== "update") continue;
    const existing = candidateResult.existingEdges[signed.docId];
    if (!existing) continue;
    for (const edgeKey of existing) {
      if (writtenEdges.has(edgeKey)) continue;
      const [docA, docB] = edgeKey.split("|");
      batch.edgeDeletes.push({ docA, docB, algoVersion });
    }
  }

  return batch;
}
