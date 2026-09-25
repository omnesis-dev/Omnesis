// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-compute functions for the near-duplicate signing and
 * verification pipeline. NO database imports — these run on CPU pool
 * workers that have no SQLite handle.
 *
 * The functions receive pre-fetched data (inbox docs, candidate docs,
 * DF entries) and return typed results that the main-thread
 * orchestrator assembles into a `NearDupApplyBatch` for the writer.
 */

import { personIdentifiers } from "@omnesis/types";
import {
  compileConfig,
  computeExclusivity,
  gatePair,
  IdfSketcher,
  idfWeight,
  normalizeText,
  packWeightedSignature,
  shingles,
  shouldSuppress,
  weightedJaccard,
  type FilterDocMeta,
  type GateDocMeta,
  type NearDupeConfig,
  type PairScores,
} from "@omnesis/near-dupes";
import { dfLookupFromSab } from "./df-sab.js";
import { isEligibleForNearDup } from "./eligibility.js";
import type { PersonIdentifierSource } from "@omnesis/types";

// ── Types for data flowing between phases ─────────────────────────────

/** Doc data fetched by the compute worker, shipped to the CPU pool. */
export interface NearDupDocForSigning {
  inboxId: number;
  docId: string;
  reason: "insert" | "update" | "algo-bump";
  content: string;
  contentHash: string | null;
  extractedContentHash: string | null;
  metadata: string;
}

/** Serializable DF table passed to the CPU worker. */
export interface SerializableDf {
  totalDocs: number;
  entries: Array<[string, number]>;
}

/** Per-doc result from the signing phase. */
export interface SignedDoc {
  docId: string;
  inboxId: number;
  reason: "insert" | "update" | "algo-bump";
  signatureBytes: number[] | null;
  shingleCount: number;
  bands: number[] | null;
  shingles: string[] | null;
  docType: string;
  threadId: string | null;
  senderAddress: string | null;
  contentHash: string | null;
  extractedContentHash: string | null;
  shouldDelete: boolean;
}

/** Candidate doc data fetched by the compute worker for verification. */
export interface CandidateDocData {
  candidateId: string;
  content: string;
  contentHash: string | null;
  extractedContentHash: string | null;
  metadata: string;
}

/** Input for the pairwise verification phase. */
export interface VerifyPairInput {
  docId: string;
  candidateId: string;
  docShingles: string[];
  candidateShingles: string[];
  docMeta: VerifyDocMeta;
  candidateMeta: VerifyDocMeta;
}

export interface VerifyDocMeta {
  contentHash: string | null;
  extractedContentHash: string | null;
  docType: string;
  threadId: string | null;
  senderAddress: string | null;
}

/** Output from the pairwise verification phase. */
export interface VerifiedPair {
  docA: string;
  docB: string;
  jaccard: number;
  pairUniqueDf2: number;
  pairUniqueDf5: number;
  containmentMin: number;
  gateFamily: string;
  accepted: boolean;
}

// ── Metadata parsing (extracted from NearDupComputeService) ───────────

interface DocMetaParsed {
  docType: string;
  threadId: string | null;
  senderAddress: string | null;
}

function parseDocMeta(metadataJson: string): DocMetaParsed {
  let docType = "document";
  let threadId: string | null = null;
  let senderAddress: string | null = null;
  try {
    const m = JSON.parse(metadataJson) as {
      documentType?: string;
      extra?: { threadId?: string };
      people?: Array<{ role?: string } & PersonIdentifierSource>;
    };
    if (typeof m.documentType === "string") docType = m.documentType;
    if (typeof m.extra?.threadId === "string") threadId = m.extra.threadId;
    if (Array.isArray(m.people)) {
      for (const p of m.people) {
        if (p.role !== "sender") continue;
        // Through the one reader: a sender naming its address by kind is the
        // same sender, and reading only the older spelling would drop the
        // address this signature groups a thread by.
        const address = personIdentifiers(p).find(({ kind }) => kind === "email")?.value;
        if (typeof address === "string") {
          senderAddress = address.toLowerCase();
          break;
        }
      }
    }
  } catch {
    // ignore malformed metadata
  }
  return { docType, threadId, senderAddress };
}

// ── Phase 2a: Sign a batch of docs (CPU pool) ────────────────────────

export function signDocBatch(
  docs: NearDupDocForSigning[],
  algoConfig: NearDupeConfig,
  dfSab: SharedArrayBuffer,
  eligibleDocTypes: string[],
): SignedDoc[] {
  const eligible = new Set(eligibleDocTypes);
  const compiled = compileConfig(algoConfig);
  const dfLookup = dfLookupFromSab(dfSab);
  const sketcher = new IdfSketcher(compiled.weightedMinhashParams, compiled.lshParams, dfLookup, {
    maxWeight: algoConfig.maxIdfWeight,
  });

  const results: SignedDoc[] = [];
  for (const doc of docs) {
    const parsed = parseDocMeta(doc.metadata);
    if (!isEligibleForNearDup(parsed.docType, eligible)) {
      results.push({
        docId: doc.docId,
        inboxId: doc.inboxId,
        reason: doc.reason,
        signatureBytes: null,
        shingleCount: 0,
        bands: null,
        shingles: null,
        docType: parsed.docType,
        threadId: parsed.threadId,
        senderAddress: parsed.senderAddress,
        contentHash: doc.contentHash,
        extractedContentHash: doc.extractedContentHash,
        shouldDelete: true,
      });
      continue;
    }

    const sh = shingles(
      normalizeText(doc.content, { stripQuotes: algoConfig.stripQuotes }),
      algoConfig.shingleSize,
    );
    if (sh.size === 0) {
      results.push({
        docId: doc.docId,
        inboxId: doc.inboxId,
        reason: doc.reason,
        signatureBytes: null,
        shingleCount: 0,
        bands: null,
        shingles: null,
        docType: parsed.docType,
        threadId: parsed.threadId,
        senderAddress: parsed.senderAddress,
        contentHash: doc.contentHash,
        extractedContentHash: doc.extractedContentHash,
        shouldDelete: true,
      });
      continue;
    }

    const sig = sketcher.sign(sh);
    const bands = sketcher.bands(sig);

    results.push({
      docId: doc.docId,
      inboxId: doc.inboxId,
      reason: doc.reason,
      signatureBytes: [...packWeightedSignature(sig)],
      shingleCount: sh.size,
      bands: Array.from(bands).map((b) => b | 0),
      shingles: [...sh],
      docType: parsed.docType,
      threadId: parsed.threadId,
      senderAddress: parsed.senderAddress,
      contentHash: doc.contentHash,
      extractedContentHash: doc.extractedContentHash,
      shouldDelete: false,
    });
  }
  return results;
}

// ── Phase 2d: Verify candidate pairs (CPU pool) ──────────────────────

export function verifyPairBatch(
  pairs: VerifyPairInput[],
  dfSab: SharedArrayBuffer,
  gateConfig: {
    recordThreshold: number;
    maxIdfWeight: number;
    emailJaccardMin: number;
    emailPairUniqueDf2Min: number;
    fileLikeJaccardMin: number;
    fileLikePairUniqueDf2Min: number;
    fileLikeContainmentMin: number;
    automatedSenderPrefixes: string[];
  },
): VerifiedPair[] {
  const dfLookup = dfLookupFromSab(dfSab);
  const results: VerifiedPair[] = [];

  for (const pair of pairs) {
    const docSh = new Set(pair.docShingles);
    const candSh = new Set(pair.candidateShingles);

    const j = weightedJaccard(
      (s) => idfWeight(dfLookup.df(s), dfLookup.totalDocs, { maxWeight: gateConfig.maxIdfWeight }),
      docSh,
      candSh,
    );
    if (j < gateConfig.recordThreshold) continue;

    const excl = computeExclusivity(dfLookup, docSh, candSh);
    const containmentMin = excl.intersectionSize / Math.min(docSh.size, candSh.size);

    const filterA: FilterDocMeta = {
      contentHash: pair.docMeta.contentHash,
      extractedContentHash: pair.docMeta.extractedContentHash,
      docType: pair.docMeta.docType,
      threadId: pair.docMeta.threadId,
    };
    const filterB: FilterDocMeta = {
      contentHash: pair.candidateMeta.contentHash,
      extractedContentHash: pair.candidateMeta.extractedContentHash,
      docType: pair.candidateMeta.docType,
      threadId: pair.candidateMeta.threadId,
    };
    if (shouldSuppress(filterA, filterB) !== null) continue;

    const gateA: GateDocMeta = {
      docType: pair.docMeta.docType,
      senderAddress: pair.docMeta.senderAddress,
    };
    const gateB: GateDocMeta = {
      docType: pair.candidateMeta.docType,
      senderAddress: pair.candidateMeta.senderAddress,
    };

    const scores: PairScores = {
      jaccard: j,
      pairUniqueDf2: excl.pairUniqueDf2,
      pairUniqueDf5: excl.pairUniqueDf5,
      containmentMin,
    };
    const decision = gatePair(scores, gateA, gateB, {
      thresholds: {
        emailJaccardMin: gateConfig.emailJaccardMin,
        emailPairUniqueDf2Min: gateConfig.emailPairUniqueDf2Min,
        fileLikeJaccardMin: gateConfig.fileLikeJaccardMin,
        fileLikePairUniqueDf2Min: gateConfig.fileLikePairUniqueDf2Min,
        fileLikeContainmentMin: gateConfig.fileLikeContainmentMin,
      },
      automatedSenderPrefixes: gateConfig.automatedSenderPrefixes,
    });

    const [docA, docB] =
      pair.docId < pair.candidateId
        ? [pair.docId, pair.candidateId]
        : [pair.candidateId, pair.docId];

    results.push({
      docA,
      docB,
      jaccard: scores.jaccard,
      pairUniqueDf2: scores.pairUniqueDf2,
      pairUniqueDf5: scores.pairUniqueDf5,
      containmentMin: scores.containmentMin,
      gateFamily: decision.family,
      accepted: decision.accept,
    });
  }
  return results;
}

export { parseDocMeta };
