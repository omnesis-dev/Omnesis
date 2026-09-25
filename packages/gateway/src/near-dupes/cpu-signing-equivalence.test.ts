// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Equivalence test: the old monolithic `computeNearDupBatch` and the new
 * decomposed three-phase pipeline (fetch → sign/verify on CPU pool →
 * assemble) must produce identical `NearDupApplyBatch` output given the
 * same DB state.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runSchemaSetup } from "../data/schema.js";
import { runMigrations } from "../data/migrations.js";
import { DEFAULT_NEAR_DUP_CONFIG } from "./config.js";
import { enqueueNearDupInbox } from "./inbox.js";
import { setActiveAlgoVersion } from "./meta.js";
import {
  computeNearDupBatch,
  fetchNearDupInbox,
  fetchNearDupCandidates,
  fetchNearDupDfData,
} from "./NearDupComputeService.js";
import { applyNearDupDfSnapshot } from "./NearDupWriterOps.js";
import { computeNearDupDfSnapshot } from "./NearDupDfService.js";
import { signDocBatch, verifyPairBatch } from "./cpu-signing.js";
import { assembleVerifyPairs, assembleFinalBatch } from "./NearDupAssembler.js";
import type { Db } from "../data/types.js";
import type {
  NearDupApplyBatch,
  NearDupEdgeUpsert,
  NearDupBucketUpsert,
  NearDupSignatureUpsert,
} from "./types.js";

let dir: string;
let db: Db;
const config = DEFAULT_NEAR_DUP_CONFIG;
const algoVersion = config.algorithm.algoVersion;
const eligibleDocTypes = [...config.eligibleDocTypes];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "omnesis-near-dup-equiv-"));
  db = new Database(join(dir, "omnesis.db")) as unknown as Db;
  // Match the gateway journal while retaining fully synchronized commits.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  runSchemaSetup(db);
  runMigrations(db);
  setActiveAlgoVersion(db, algoVersion);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedDoc(
  id: string,
  body: string,
  documentType = "email",
  extra: Record<string, unknown> = {},
): void {
  const metadata = JSON.stringify({ documentType, ...extra });
  db.prepare(
    `INSERT INTO documents (id, provider_id, source_id, external_id, title, content,
        content_hash, metadata, source_created_at, source_updated_at, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "p",
    "src:" + id,
    id,
    "title-" + id,
    body,
    "ch-" + id,
    metadata,
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
    "2025-01-01T00:00:00Z",
  );
}

/**
 * Run the new three-phase pipeline against the current DB state.
 * Returns the same `NearDupApplyBatch` shape as `computeNearDupBatch`.
 */
function runDecomposedPipeline(): NearDupApplyBatch {
  const batchSize = config.scheduler.computeBatchSize;
  const maxCandidatesPerDoc = config.scheduler.maxCandidatesPerDoc;
  const bandCount = config.algorithm.bands;

  // Phase 1: fetch
  const fetched = fetchNearDupInbox(db, batchSize, eligibleDocTypes);
  if (fetched.inboxRows.length === 0) {
    return {
      algoVersion,
      processedInboxIds: [],
      signatureDeletes: [],
      signatures: [],
      bucketRows: [],
      edgeUpserts: [],
      edgeDeletes: [],
    };
  }

  // Build DF data
  const dfData = fetchNearDupDfData(db, algoVersion);

  // Phase 2a: sign (CPU pool in production, inline here)
  const signedDocs = signDocBatch(fetched.docs, config.algorithm, dfData, eligibleDocTypes);

  // Phase 2b: fetch candidates from persisted buckets
  const signedDocsWithBands = signedDocs
    .filter((s) => !s.shouldDelete && s.bands !== null)
    .map((s) => ({ docId: s.docId, bands: s.bands!, reason: s.reason }));
  const candidateResult = fetchNearDupCandidates(
    db,
    signedDocsWithBands,
    algoVersion,
    bandCount,
    maxCandidatesPerDoc,
  );

  // Phase 2c: assemble verify pairs (main thread)
  const pairs = assembleVerifyPairs(
    signedDocs,
    candidateResult,
    config.algorithm,
    eligibleDocTypes,
    maxCandidatesPerDoc,
  );

  // Phase 2d: verify pairs (CPU pool in production, inline here)
  const gateConfig = {
    recordThreshold: config.gate.recordThreshold,
    maxIdfWeight: config.algorithm.maxIdfWeight ?? 8.0,
    emailJaccardMin: config.gate.emailJaccardMin,
    emailPairUniqueDf2Min: config.gate.emailPairUniqueDf2Min,
    fileLikeJaccardMin: config.gate.fileLikeJaccardMin,
    fileLikePairUniqueDf2Min: config.gate.fileLikePairUniqueDf2Min,
    fileLikeContainmentMin: config.gate.fileLikeContainmentMin,
    automatedSenderPrefixes: [...config.gate.automatedSenderPrefixes],
  };
  const verified = verifyPairBatch(pairs, dfData, gateConfig);

  // Phase 3: assemble final batch (main thread)
  return assembleFinalBatch(fetched, signedDocs, candidateResult, verified, algoVersion);
}

// ── Comparison helpers ────────────────────────────────────────────────

function sortedIds(ids: number[]): number[] {
  return [...ids].sort((a, b) => a - b);
}

function sortedStrings(arr: string[]): string[] {
  return [...arr].sort();
}

function sortedSigs(sigs: NearDupSignatureUpsert[]): NearDupSignatureUpsert[] {
  return [...sigs].sort((a, b) => a.docId.localeCompare(b.docId));
}

function sortedBuckets(buckets: NearDupBucketUpsert[]): NearDupBucketUpsert[] {
  return [...buckets].sort((a, b) => {
    const d = a.docId.localeCompare(b.docId);
    return d !== 0 ? d : a.bandIdx - b.bandIdx;
  });
}

function sortedEdges(edges: NearDupEdgeUpsert[]): NearDupEdgeUpsert[] {
  return [...edges].sort((a, b) => {
    const d = a.docA.localeCompare(b.docA);
    return d !== 0 ? d : a.docB.localeCompare(b.docB);
  });
}

function sortedEdgeDeletes(
  deletes: Array<{ docA: string; docB: string }>,
): Array<{ docA: string; docB: string }> {
  return [...deletes].sort((a, b) => {
    const d = a.docA.localeCompare(b.docA);
    return d !== 0 ? d : a.docB.localeCompare(b.docB);
  });
}

function compareBatches(reference: NearDupApplyBatch, decomposed: NearDupApplyBatch): void {
  // processedInboxIds
  expect(sortedIds(decomposed.processedInboxIds)).toEqual(sortedIds(reference.processedInboxIds));

  // signatureDeletes
  expect(sortedStrings(decomposed.signatureDeletes)).toEqual(
    sortedStrings(reference.signatureDeletes),
  );

  // signatures: same count, same docIds, same shingleCount
  const refSigs = sortedSigs(reference.signatures);
  const decSigs = sortedSigs(decomposed.signatures);
  expect(decSigs.length).toBe(refSigs.length);
  for (let i = 0; i < refSigs.length; i++) {
    expect(decSigs[i].docId).toBe(refSigs[i].docId);
    expect(decSigs[i].algoVersion).toBe(refSigs[i].algoVersion);
    expect(decSigs[i].shingleCount).toBe(refSigs[i].shingleCount);
    // Signature bytes: the monolithic path uses packWeightedSignature (Buffer),
    // the decomposed path converts via [...packWeightedSignature(sig)] then
    // assembleFinalBatch wraps in Buffer.from(number[]). The byte content
    // should be identical.
    expect(Buffer.compare(decSigs[i].signature, refSigs[i].signature)).toBe(0);
  }

  // bucketRows
  const refBuckets = sortedBuckets(reference.bucketRows);
  const decBuckets = sortedBuckets(decomposed.bucketRows);
  expect(decBuckets.length).toBe(refBuckets.length);
  for (let i = 0; i < refBuckets.length; i++) {
    expect(decBuckets[i]).toEqual(refBuckets[i]);
  }

  // edgeUpserts (scores compared within epsilon)
  const refEdges = sortedEdges(reference.edgeUpserts);
  const decEdges = sortedEdges(decomposed.edgeUpserts);
  expect(decEdges.length).toBe(refEdges.length);
  for (let i = 0; i < refEdges.length; i++) {
    expect(decEdges[i].docA).toBe(refEdges[i].docA);
    expect(decEdges[i].docB).toBe(refEdges[i].docB);
    expect(decEdges[i].algoVersion).toBe(refEdges[i].algoVersion);
    expect(decEdges[i].gateFamily).toBe(refEdges[i].gateFamily);
    expect(decEdges[i].jaccard).toBeCloseTo(refEdges[i].jaccard, 10);
    expect(decEdges[i].pairUniqueDf2).toBeCloseTo(refEdges[i].pairUniqueDf2, 10);
    expect(decEdges[i].pairUniqueDf5).toBeCloseTo(refEdges[i].pairUniqueDf5, 10);
    expect(decEdges[i].containmentMin).toBeCloseTo(refEdges[i].containmentMin, 10);
  }

  // edgeDeletes
  expect(sortedEdgeDeletes(decomposed.edgeDeletes)).toEqual(
    sortedEdgeDeletes(reference.edgeDeletes),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("monolithic vs. decomposed pipeline equivalence", () => {
  test("empty inbox produces identical empty batches", () => {
    const reference = computeNearDupBatch(db, config);
    const decomposed = runDecomposedPipeline();
    compareBatches(reference, decomposed);
  });

  test("single doc insert produces identical output", () => {
    const body = [
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      "kilo lima mike november oscar papa quebec romeo sierra tango",
      "uniform victor whiskey xray yankee zulu apple banana cherry date",
      "elderberry fig grape honeydew kiwi lemon mango nectarine orange pear",
    ].join(" ");

    seedDoc("solo", body, "file");
    enqueueNearDupInbox(db, ["solo"], "insert");

    const reference = computeNearDupBatch(db, config);

    // Re-enqueue so the decomposed pipeline sees the same inbox state.
    // The monolithic path consumed via peek (no delete), so rows are still there.
    // But computeNearDupBatch only peeks — it doesn't delete inbox rows.
    // We need to re-run from the same DB state, so we use a second DB.
    // Actually, peekNearDupInbox does NOT delete rows — both paths see the same inbox.
    const decomposed = runDecomposedPipeline();

    compareBatches(reference, decomposed);
  });

  test("delete-reason inbox row produces identical output", () => {
    enqueueNearDupInbox(db, ["phantom-doc"], "delete");

    const reference = computeNearDupBatch(db, config);
    const decomposed = runDecomposedPipeline();

    compareBatches(reference, decomposed);
    expect(reference.signatureDeletes).toContain("phantom-doc");
  });

  test("ineligible doc type produces identical output", () => {
    seedDoc("contact-doc", "some body text ".repeat(20), "contact");
    enqueueNearDupInbox(db, ["contact-doc"], "insert");

    const reference = computeNearDupBatch(db, config);
    const decomposed = runDecomposedPipeline();

    compareBatches(reference, decomposed);
    expect(reference.signatures).toHaveLength(0);
  });

  test("whitespace-only doc produces identical output", () => {
    seedDoc("ws-doc", "   \n\t   ");
    enqueueNearDupInbox(db, ["ws-doc"], "insert");

    const reference = computeNearDupBatch(db, config);
    const decomposed = runDecomposedPipeline();

    compareBatches(reference, decomposed);
  });

  test("in-batch near-identical docs produce identical edges", () => {
    const body = [
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      "kilo lima mike november oscar papa quebec romeo sierra tango",
      "uniform victor whiskey xray yankee zulu apple banana cherry date",
      "elderberry fig grape honeydew kiwi lemon mango nectarine orange pear",
      "quince raspberry strawberry tangerine ugli vanilla watermelon",
    ].join(" ");

    // Filler docs for a meaningful DF table.
    const fillerBody = [
      "completely separate words like xenon photon neutron proton electron",
      "another unique paragraph with airplane submarine rocket scooter unicycle",
      "yet more standalone content cement concrete granite marble limestone",
      "totally unrelated phrasing about violin trumpet saxophone clarinet flute",
      "distinct text covering oak maple birch sycamore willow poplar cedar",
    ].join(" ");
    seedDoc("filler-1", fillerBody, "file");
    seedDoc("filler-2", fillerBody.split(" ").reverse().join(" "), "file");

    // Bootstrap DF so IDF weights are meaningful.
    const dfSnapshot = computeNearDupDfSnapshot(db, config);
    applyNearDupDfSnapshot(db, dfSnapshot);

    // Three near-identical siblings in one batch.
    seedDoc("sib-a", body + " sibling a unique tail", "file");
    seedDoc("sib-b", body + " sibling b unique tail", "file");
    seedDoc("sib-c", body + " sibling c unique tail", "file");
    enqueueNearDupInbox(db, ["sib-a", "sib-b", "sib-c"], "insert");

    const reference = computeNearDupBatch(db, config);
    const decomposed = runDecomposedPipeline();

    compareBatches(reference, decomposed);
    // Sanity check: all three pairwise edges should exist.
    expect(reference.edgeUpserts.length).toBe(3);
  });

  test("mixed batch: valid doc + delete + ineligible doc", () => {
    const body = [
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
      "kilo lima mike november oscar papa quebec romeo sierra tango",
    ].join(" ");

    seedDoc("good-doc", body, "file");
    seedDoc("bad-type-doc", body, "contact");
    enqueueNearDupInbox(db, ["good-doc"], "insert");
    enqueueNearDupInbox(db, ["bad-type-doc"], "insert");
    enqueueNearDupInbox(db, ["deleted-doc"], "delete");

    const reference = computeNearDupBatch(db, config);
    const decomposed = runDecomposedPipeline();

    compareBatches(reference, decomposed);
  });
});
