// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { createLogger } from "@omnesis/core";
import { personIdentifiers } from "@omnesis/types";
import {
  compileConfig,
  computeExclusivity,
  IdfSketcher,
  normalizeText,
  packWeightedSignature,
  shingles,
  shouldSuppress,
  gatePair,
  idfWeight,
  weightedJaccard,
  type FilterDocMeta,
  type GateDocMeta,
  type PairScores,
} from "@omnesis/near-dupes";
import { isEligibleForNearDup } from "./eligibility.js";
import { buildInMemoryDfFromTable, type InMemoryDf } from "./NearDupDfService.js";
import { peekNearDupInbox } from "./inbox.js";
import { buildDfSab } from "./df-sab.js";
import type { PersonIdentifierSource } from "@omnesis/types";
import type { ResolvedNearDupConfig } from "./config.js";
import type { Db } from "../data/types.js";
import type {
  NearDupApplyBatch,
  NearDupBucketUpsert,
  NearDupEdgeDelete,
  NearDupEdgeUpsert,
  NearDupSignatureUpsert,
} from "./types.js";

const log = createLogger("gateway:near-dupes:compute");

interface OmnesisDocRow {
  id: string;
  content: string;
  content_hash: string | null;
  extracted_content_hash: string | null;
  metadata: string;
}

interface DocMetaExtracted {
  docType: string;
  threadId: string | null;
  senderAddress: string | null;
}

function parseDocMeta(metadataJson: string): DocMetaExtracted {
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

function toFilterAndGateMeta(
  contentHash: string | null,
  extractedContentHash: string | null,
  parsed: DocMetaExtracted,
): { filter: FilterDocMeta; gate: GateDocMeta } {
  return {
    filter: {
      contentHash,
      extractedContentHash,
      docType: parsed.docType,
      threadId: parsed.threadId,
    },
    gate: {
      docType: parsed.docType,
      senderAddress: parsed.senderAddress,
    },
  };
}

/**
 * Produce a `NearDupApplyBatch` covering up to `computeBatchSize`
 * inbox rows. Pure-read on the compute worker — does NOT mutate
 * any near-dup state directly; the writer applies the snapshot
 * atomically via `applyNearDupBatch`.
 *
 * Per-inbox-row behaviour:
 *   - reason 'delete'  → emit a signature delete (FK cascade prunes
 *     edges + bucket rows automatically on the writer side; we still
 *     queue the delete so an algo-bump can wipe old-algo signatures
 *     for a deleted doc).
 *   - reason 'insert' / 'update' / 'algo-bump' → re-shingle, sign,
 *     find candidates, verify+gate. For 'update' we also compute
 *     the symmetric difference of existing edges and queue removals.
 */
/** Per-doc state retained between phase 1 (sign) and phase 2 (verify). */
interface InBatchDocState {
  inbox: { id: number; docId: string; reason: "insert" | "update" | "algo-bump" };
  doc: OmnesisDocRow;
  parsed: DocMetaExtracted;
  shingles: Set<string>;
  bands: Uint32Array | ReadonlyArray<number>;
}

export function computeNearDupBatch(db: Db, config: ResolvedNearDupConfig): NearDupApplyBatch {
  const compiled = compileConfig(config.algorithm);
  const df = buildInMemoryDfFromTable(db, config.algorithm.algoVersion);
  const sketcher = new IdfSketcher(compiled.weightedMinhashParams, compiled.lshParams, df, {
    maxWeight: config.algorithm.maxIdfWeight,
  });

  const inboxRows = peekNearDupInbox(db, config.scheduler.computeBatchSize);
  const snapshot: NearDupApplyBatch = {
    algoVersion: config.algorithm.algoVersion,
    processedInboxIds: [],
    signatureDeletes: [],
    signatures: [],
    bucketRows: [],
    edgeUpserts: [],
    edgeDeletes: [],
  };
  if (inboxRows.length === 0) return snapshot;

  const candidateLookup = db.prepare<unknown[], { doc_id: string }>(
    `SELECT DISTINCT doc_id FROM near_dup_lsh_buckets
      WHERE algo_version = ?
        AND (band_idx, bucket_hash) IN (VALUES ${Array.from(
          { length: compiled.lshParams.bands },
          () => "(?, ?)",
        ).join(",")})
        AND doc_id != ?`,
  );

  const docFetch = db.prepare<[string], OmnesisDocRow>(
    `SELECT id, content, content_hash, extracted_content_hash, metadata
       FROM documents WHERE id = ?`,
  );

  const existingEdgesForDoc = db.prepare<
    [string, string, string],
    { doc_a: string; doc_b: string }
  >(
    `SELECT doc_a, doc_b FROM near_dup_edges
      WHERE algo_version = ? AND (doc_a = ? OR doc_b = ?)`,
  );

  // Phase 1 — sign every inbox doc, build the in-batch band index.
  //
  // Critical invariant: docs in the SAME batch must be able to see
  // each other as candidates. The persisted `near_dup_lsh_buckets`
  // table doesn't have their rows yet (those go in the apply snapshot
  // the writer applies after we return). Without this in-memory
  // index, a cluster of N highly-similar docs that the boot algo-bump
  // enqueued together (sequential UUIDs land in one 25-doc batch) all
  // miss each other — only the docs processed after a sibling lands
  // in a SUBSEQUENT batch ever observe the persisted bucket row.
  // That produced the partially-connected clusters observed on the
  // 13.6k-doc bootstrap run (e.g. 5 PDF mandat-de-vente docs landed 2
  // edges out of an expected 10).
  const inBatchDocs = new Map<string, InBatchDocState>();
  /** Key = `${bandIdx}|${bucketHash}` → docIds that hashed to that bucket. */
  const inBatchBuckets = new Map<string, string[]>();

  for (const inbox of inboxRows) {
    snapshot.processedInboxIds.push(inbox.id);

    if (inbox.reason === "delete") {
      snapshot.signatureDeletes.push(inbox.docId);
      continue;
    }

    const doc = docFetch.get(inbox.docId);
    if (!doc) {
      // Doc was deleted between enqueue and now. FK cascade has
      // already wiped signatures / bucket rows / edges. Just consume
      // the inbox row.
      snapshot.signatureDeletes.push(inbox.docId);
      continue;
    }
    const parsed = parseDocMeta(doc.metadata);
    if (!isEligibleForNearDup(parsed.docType, config.eligibleDocTypes)) {
      // Type became ineligible (e.g. algo-bump-time eligibility
      // narrowed). Wipe any leftover state and skip the verify step.
      snapshot.signatureDeletes.push(inbox.docId);
      continue;
    }

    const sh = shingles(
      normalizeText(doc.content, { stripQuotes: config.algorithm.stripQuotes }),
      config.algorithm.shingleSize,
    );
    if (sh.size === 0) {
      snapshot.signatureDeletes.push(inbox.docId);
      continue;
    }

    const sig = sketcher.sign(sh);
    const bands = sketcher.bands(sig);

    // Treat update as delete-then-add for signature and bucket rows.
    snapshot.signatureDeletes.push(inbox.docId);
    snapshot.signatures.push({
      docId: inbox.docId,
      algoVersion: config.algorithm.algoVersion,
      signature: packWeightedSignature(sig),
      shingleCount: sh.size,
    });
    for (let b = 0; b < bands.length; b++) {
      const bucketHash = bands[b] | 0;
      snapshot.bucketRows.push({
        algoVersion: config.algorithm.algoVersion,
        bandIdx: b,
        bucketHash,
        docId: inbox.docId,
      });
      const key = `${b}|${bucketHash}`;
      const existing = inBatchBuckets.get(key);
      if (existing) existing.push(inbox.docId);
      else inBatchBuckets.set(key, [inbox.docId]);
    }

    inBatchDocs.set(inbox.docId, {
      inbox: inbox as InBatchDocState["inbox"],
      doc,
      parsed,
      shingles: sh,
      bands,
    });
  }

  // Phase 2 — for each signed doc, look up candidates from BOTH the
  // persisted LSH table AND the in-batch band index, then verify and
  // gate. Per-doc shingle re-extraction is avoided for in-batch
  // candidates (we already have their normalized shingle set).
  //
  // Batch-wide edge dedup: when sib-a finds sib-b as a candidate and
  // emits (a, b), sib-b's loop later finds sib-a too and would emit
  // (a, b) again. The writer's apply path dedupes on `writtenEdges`,
  // but emitting twice wastes bytes and confuses tests.
  const batchEmittedEdges = new Set<string>();
  for (const [docId, state] of inBatchDocs) {
    const { inbox, doc, parsed, shingles: sh, bands } = state;

    const bandParams: number[] = [];
    for (let b = 0; b < bands.length; b++) bandParams.push(b, bands[b] | 0);
    const persistedRows = candidateLookup.all(config.algorithm.algoVersion, ...bandParams, docId);
    const candidateIds = new Set<string>();
    for (const r of persistedRows) candidateIds.add(r.doc_id);
    // Union with in-batch siblings sharing any band with this doc.
    for (let b = 0; b < bands.length; b++) {
      const arr = inBatchBuckets.get(`${b}|${bands[b] | 0}`);
      if (!arr) continue;
      for (const other of arr) if (other !== docId) candidateIds.add(other);
    }
    let cappedCandidates = [...candidateIds];
    if (cappedCandidates.length > config.scheduler.maxCandidatesPerDoc) {
      cappedCandidates = cappedCandidates.slice(0, config.scheduler.maxCandidatesPerDoc);
    }

    const ownExistingEdges = new Set<string>();
    if (inbox.reason === "update") {
      const existing = existingEdgesForDoc.all(config.algorithm.algoVersion, docId, docId);
      for (const e of existing) ownExistingEdges.add(`${e.doc_a}|${e.doc_b}`);
    }
    const reemittedEdgeKeys = new Set<string>();

    for (const candId of cappedCandidates) {
      const inBatch = inBatchDocs.get(candId);
      let candContentHash: string | null;
      let candExtractedContentHash: string | null;
      let candParsed: DocMetaExtracted;
      let candShingles: Set<string>;
      if (inBatch) {
        candContentHash = inBatch.doc.content_hash;
        candExtractedContentHash = inBatch.doc.extracted_content_hash;
        candParsed = inBatch.parsed;
        candShingles = inBatch.shingles;
      } else {
        const candDoc = docFetch.get(candId);
        if (!candDoc) continue;
        candParsed = parseDocMeta(candDoc.metadata);
        if (!isEligibleForNearDup(candParsed.docType, config.eligibleDocTypes)) continue;
        candShingles = shingles(
          normalizeText(candDoc.content, { stripQuotes: config.algorithm.stripQuotes }),
          config.algorithm.shingleSize,
        );
        if (candShingles.size === 0) continue;
        candContentHash = candDoc.content_hash;
        candExtractedContentHash = candDoc.extracted_content_hash;
      }

      const j = weightedJaccard(
        (s) => idfWeight(df.df(s), df.totalDocs, { maxWeight: config.algorithm.maxIdfWeight }),
        sh,
        candShingles,
      );
      if (j < config.gate.recordThreshold) continue;

      const excl = computeExclusivity(df, sh, candShingles);
      const containmentMin = excl.intersectionSize / Math.min(sh.size, candShingles.size);

      const filterA = toFilterAndGateMeta(doc.content_hash, doc.extracted_content_hash, parsed);
      const filterB = toFilterAndGateMeta(candContentHash, candExtractedContentHash, candParsed);
      if (shouldSuppress(filterA.filter, filterB.filter) !== null) continue;

      const scores: PairScores = {
        jaccard: j,
        pairUniqueDf2: excl.pairUniqueDf2,
        pairUniqueDf5: excl.pairUniqueDf5,
        containmentMin,
      };
      const decision = gatePair(scores, filterA.gate, filterB.gate, {
        thresholds: {
          emailJaccardMin: config.gate.emailJaccardMin,
          emailPairUniqueDf2Min: config.gate.emailPairUniqueDf2Min,
          fileLikeJaccardMin: config.gate.fileLikeJaccardMin,
          fileLikePairUniqueDf2Min: config.gate.fileLikePairUniqueDf2Min,
          fileLikeContainmentMin: config.gate.fileLikeContainmentMin,
        },
        automatedSenderPrefixes: config.gate.automatedSenderPrefixes,
      });
      if (!decision.accept) continue;

      const [docA, docB] = docId < candId ? [docId, candId] : [candId, docId];
      const edgeKey = `${docA}|${docB}`;
      if (batchEmittedEdges.has(edgeKey)) {
        reemittedEdgeKeys.add(edgeKey);
        continue;
      }
      const edge: NearDupEdgeUpsert = {
        docA,
        docB,
        algoVersion: config.algorithm.algoVersion,
        jaccard: scores.jaccard,
        pairUniqueDf2: scores.pairUniqueDf2,
        pairUniqueDf5: scores.pairUniqueDf5,
        containmentMin: scores.containmentMin,
        gateFamily: decision.family,
      };
      snapshot.edgeUpserts.push(edge);
      reemittedEdgeKeys.add(edgeKey);
      batchEmittedEdges.add(edgeKey);
    }

    // Edges that existed for this doc under the old signature but
    // weren't re-emitted this pass are stale — schedule removal.
    if (inbox.reason === "update" && ownExistingEdges.size > 0) {
      for (const key of ownExistingEdges) {
        if (reemittedEdgeKeys.has(key)) continue;
        const [docA, docB] = key.split("|");
        const edgeDelete: NearDupEdgeDelete = {
          docA,
          docB,
          algoVersion: config.algorithm.algoVersion,
        };
        snapshot.edgeDeletes.push(edgeDelete);
      }
    }
  }

  log.debug(
    `compute batch: ${inboxRows.length} inbox rows, ${snapshot.signatures.length} sigs, ${snapshot.edgeUpserts.length} edges, ${snapshot.edgeDeletes.length} edge deletes`,
  );

  return snapshot;
}

/** Test-only export — exposed so unit tests can inject a stub DF. */
export const __testing = { parseDocMeta, toFilterAndGateMeta };
export type { OmnesisDocRow, DocMetaExtracted };

// ── IO-only fetch functions for the three-phase pipeline ─────────────
//
// These run on the compute worker (read-only DB handle). They fetch
// data without doing CPU-heavy processing — that moves to the CPU pool.

import type { NearDupDocForSigning, SignedDoc, CandidateDocData } from "./cpu-signing.js";
import type { NearDupInboxRow } from "./inbox.js";

export interface NearDupFetchResult {
  inboxRows: NearDupInboxRow[];
  docs: NearDupDocForSigning[];
  deleteDocIds: string[];
}

/**
 * Phase 1 of the three-phase pipeline: fetch inbox rows and doc
 * content. IO-only — no signing, no shingles, no verification.
 */
export function fetchNearDupInbox(
  db: Db,
  batchSize: number,
  eligibleDocTypes: string[],
): NearDupFetchResult {
  const eligible = new Set(eligibleDocTypes);
  const inboxRows = peekNearDupInbox(db, batchSize);
  const docs: NearDupDocForSigning[] = [];
  const deleteDocIds: string[] = [];

  if (inboxRows.length === 0) return { inboxRows, docs, deleteDocIds };

  const docFetch = db.prepare<[string], OmnesisDocRow>(
    `SELECT id, content, content_hash, extracted_content_hash, metadata
       FROM documents WHERE id = ?`,
  );

  for (const inbox of inboxRows) {
    if (inbox.reason === "delete") {
      deleteDocIds.push(inbox.docId);
      continue;
    }
    const doc = docFetch.get(inbox.docId);
    if (!doc) {
      deleteDocIds.push(inbox.docId);
      continue;
    }
    // Quick metadata check — if the doc type isn't eligible, mark
    // for deletion without shipping content to the CPU pool.
    let docType = "document";
    try {
      const m = JSON.parse(doc.metadata) as { documentType?: string };
      if (typeof m.documentType === "string") docType = m.documentType;
    } catch {
      /* ignore */
    }
    if (!isEligibleForNearDup(docType, eligible)) {
      deleteDocIds.push(inbox.docId);
      continue;
    }
    docs.push({
      inboxId: inbox.id,
      docId: inbox.docId,
      reason: inbox.reason as "insert" | "update" | "algo-bump",
      content: doc.content,
      contentHash: doc.content_hash,
      extractedContentHash: doc.extracted_content_hash,
      metadata: doc.metadata,
    });
  }
  return { inboxRows, docs, deleteDocIds };
}

export interface NearDupCandidateFetchResult {
  /** candidateId → doc data for non-in-batch candidates */
  candidates: Record<string, CandidateDocData>;
  /** docId → candidate IDs from persisted LSH buckets (per-doc, not merged) */
  candidateIdsByDoc: Record<string, string[]>;
  /** docId → set of existing edge keys ("docA|docB") for update-reason docs */
  existingEdges: Record<string, string[]>;
}

/**
 * Phase 2b of the three-phase pipeline: given signed docs with band
 * values, look up LSH candidates from persisted buckets and fetch
 * their content. IO-only.
 */
export function fetchNearDupCandidates(
  db: Db,
  signedDocs: Array<{ docId: string; bands: number[]; reason: string }>,
  algoVersion: string,
  bandCount: number,
  maxCandidatesPerDoc: number,
): NearDupCandidateFetchResult {
  const allCandidates: Record<string, CandidateDocData> = {};
  const candidateIdsByDoc: Record<string, string[]> = {};
  const existingEdges: Record<string, string[]> = {};
  const inBatchDocIds = new Set(signedDocs.map((d) => d.docId));

  const candidateLookup = db.prepare<unknown[], { doc_id: string }>(
    `SELECT DISTINCT doc_id FROM near_dup_lsh_buckets
      WHERE algo_version = ?
        AND (band_idx, bucket_hash) IN (VALUES ${Array.from(
          { length: bandCount },
          () => "(?, ?)",
        ).join(",")})
        AND doc_id != ?`,
  );

  const docFetch = db.prepare<[string], OmnesisDocRow>(
    `SELECT id, content, content_hash, extracted_content_hash, metadata
       FROM documents WHERE id = ?`,
  );

  const existingEdgesStmt = db.prepare<[string, string, string], { doc_a: string; doc_b: string }>(
    `SELECT doc_a, doc_b FROM near_dup_edges
      WHERE algo_version = ? AND (doc_a = ? OR doc_b = ?)`,
  );

  for (const signed of signedDocs) {
    const bandParams: number[] = [];
    for (let b = 0; b < signed.bands.length; b++) {
      bandParams.push(b, signed.bands[b]);
    }
    const persistedRows = candidateLookup.all(algoVersion, ...bandParams, signed.docId);
    let candidateIds: string[] = [];
    for (const r of persistedRows) {
      if (!inBatchDocIds.has(r.doc_id)) candidateIds.push(r.doc_id);
    }
    if (candidateIds.length > maxCandidatesPerDoc) {
      candidateIds = candidateIds.slice(0, maxCandidatesPerDoc);
    }
    candidateIdsByDoc[signed.docId] = candidateIds;

    for (const candId of candidateIds) {
      if (allCandidates[candId]) continue;
      const candDoc = docFetch.get(candId);
      if (!candDoc) continue;
      allCandidates[candId] = {
        candidateId: candId,
        content: candDoc.content,
        contentHash: candDoc.content_hash,
        extractedContentHash: candDoc.extracted_content_hash,
        metadata: candDoc.metadata,
      };
    }

    if (signed.reason === "update") {
      const edges = existingEdgesStmt.all(algoVersion, signed.docId, signed.docId);
      existingEdges[signed.docId] = edges.map((e) => `${e.doc_a}|${e.doc_b}`);
    }
  }

  return { candidates: allCandidates, candidateIdsByDoc, existingEdges };
}

/**
 * Build the DF table for the active algorithm version into a
 * SharedArrayBuffer for the CPU pool to IDF-weight against during signing
 * and verification. Built here (on the read-only compute/IO worker, off the
 * main thread) once per DF change; every CPU worker reads the same buffer by
 * reference, so there's no per-cycle clone or Map rebuild. See `df-sab.ts`.
 */
export function fetchNearDupDfData(db: Db, algoVersion: string): SharedArrayBuffer {
  const metaRow = db
    .prepare<
      [string],
      { total_docs: number; live_generation: number }
    >(`SELECT total_docs, live_generation FROM near_dup_df_meta WHERE algo_version = ?`)
    .get(algoVersion);
  const totalDocs = metaRow?.total_docs ?? 0;
  // One generation, the live one — a rebuild in flight is filling the next
  // and is invisible here until it publishes.
  const generation = metaRow?.live_generation ?? 0;
  const entries: Array<[string, number]> = [];
  const rows = db
    .prepare<
      [string, number],
      { shingle: string; df: number }
    >(`SELECT shingle, df FROM near_dup_df WHERE algo_version = ? AND generation = ?`)
    .iterate(algoVersion, generation) as Iterable<{ shingle: string; df: number }>;
  for (const r of rows) entries.push([r.shingle, r.df]);
  return buildDfSab(entries, totalDocs);
}
