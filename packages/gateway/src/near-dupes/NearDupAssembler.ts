// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Main-thread assembly helpers for the three-phase near-dup pipeline.
 * These combine results from the fetch, sign, prepare and verify phases
 * into the `NearDupApplyBatch` that the writer applies. Nothing here
 * normalizes or shingles text: that runs on the CPU pool
 * (`signDocBatch`, `prepareCandidateBatch`), so what is left is
 * bookkeeping proportional to the number of pairs.
 */

import type {
  CandidateDocData,
  PreparedCandidate,
  SignedDoc,
  VerifyPairInput,
  VerifyDocMeta,
  VerifiedPair,
} from "./cpu-signing.js";
import type { NearDupFetchResult, NearDupCandidateFetchResult } from "./NearDupComputeService.js";
import type { NearDupApplyBatch } from "./types.js";

/** Most candidates one `prepareCandidateBatch` call prepares. */
const PREPARE_CHUNK_MAX_CANDIDATES = 128;

/**
 * Most content characters one `prepareCandidateBatch` call prepares. The
 * shingles come back to the main thread as one structured-clone message per
 * call, and a reply holds several times its input text (each shingle is a
 * window of words), so bounding the text bounds how long one reply takes to
 * deserialize. A candidate longer than this is a call of its own.
 */
const PREPARE_CHUNK_MAX_CHARS = 200_000;

/**
 * Split the fetched candidates into `prepareCandidateBatch` calls, so the
 * CPU pool prepares them in parallel and each reply stays small.
 */
export function chunkCandidatesForPreparation(
  candidates: Record<string, CandidateDocData>,
): CandidateDocData[][] {
  const chunks: CandidateDocData[][] = [];
  let current: CandidateDocData[] = [];
  let chars = 0;
  for (const candidate of Object.values(candidates)) {
    const length = candidate.content.length;
    if (
      current.length > 0 &&
      (current.length >= PREPARE_CHUNK_MAX_CANDIDATES || chars + length > PREPARE_CHUNK_MAX_CHARS)
    ) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(candidate);
    chars += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Prepare every fetched persisted candidate through `prepare` (the CPU
 * pool's `nearDupPrepareCandidates` in the gateway), one call per chunk, and
 * index the results by candidate id for {@link assembleVerifyPairs}.
 */
export async function preparePersistedCandidates(
  candidates: Record<string, CandidateDocData>,
  prepare: (chunk: CandidateDocData[]) => Promise<PreparedCandidate[]>,
): Promise<Map<string, PreparedCandidate>> {
  const prepared = await Promise.all(chunkCandidatesForPreparation(candidates).map(prepare));
  return new Map(prepared.flat().map((candidate) => [candidate.candidateId, candidate] as const));
}

/**
 * Assemble verify-pair inputs from signed docs, the persisted candidates
 * each one was matched to, and in-batch candidates.
 *
 * `prepared` holds the persisted candidates the CPU pool prepared; a
 * candidate missing from it was ineligible or yielded no shingle, and is
 * skipped.
 */
export function assembleVerifyPairs(
  signedDocs: SignedDoc[],
  candidateResult: Pick<NearDupCandidateFetchResult, "candidateIdsByDoc">,
  prepared: ReadonlyMap<string, PreparedCandidate>,
  maxCandidatesPerDoc: number,
): VerifyPairInput[] {
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

      // Get candidate shingles — either from in-batch signed docs or from prepared candidates
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
        const persisted = prepared.get(candId);
        if (!persisted) continue;
        candidateShingles = persisted.shingles;
        candidateMeta = persisted.meta;
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
