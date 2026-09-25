// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `assembleVerifyPairs` runs on the gateway's main thread, between two CPU
 * pool phases. Anything it does per pair is charged to every in-flight HTTP
 * request, so the shape of its work is what these tests pin.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_NEAR_DUP_CONFIG } from "./config.js";
import type { CandidateDocData, SignedDoc } from "./cpu-signing.js";
import type { NearDupCandidateFetchResult } from "./NearDupComputeService.js";

const counters = vi.hoisted(() => ({ shingleCalls: 0 }));

vi.mock("@omnesis/near-dupes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/near-dupes")>();
  return {
    ...actual,
    shingles: (text: string, size: number) => {
      counters.shingleCalls++;
      return actual.shingles(text, size);
    },
  };
});

const { assembleVerifyPairs } = await import("./NearDupAssembler.js");

const algoConfig = DEFAULT_NEAR_DUP_CONFIG.algorithm;
const eligibleDocTypes = [...DEFAULT_NEAR_DUP_CONFIG.eligibleDocTypes];

/** A signed doc that shares no band with any other, so its only
 *  candidates are the persisted ones the fetch phase handed us. */
function signedDoc(docId: string, band: number): SignedDoc {
  return {
    docId,
    inboxId: band,
    reason: "insert",
    signatureBytes: [1, 2, 3],
    shingleCount: 3,
    bands: [band],
    shingles: [`${docId} alpha`, `${docId} bravo`],
    docType: "email",
    threadId: null,
    senderAddress: "maya.reeves@example.com",
    contentHash: `ch-${docId}`,
    extractedContentHash: null,
    shouldDelete: false,
  };
}

function candidate(candidateId: string): CandidateDocData {
  return {
    candidateId,
    content: "Quarterly planning notes for the launch review meeting. ".repeat(20),
    contentHash: `ch-${candidateId}`,
    extractedContentHash: null,
    metadata: JSON.stringify({ documentType: "email" }),
  };
}

beforeEach(() => {
  counters.shingleCalls = 0;
});

describe("assembleVerifyPairs", () => {
  test("shingles a persisted candidate once per batch, not once per pair", () => {
    // The same stored document is an LSH candidate for many of the docs in
    // a batch — that is what an LSH bucket is. Re-shingling it per pair
    // makes a background job's main-thread stretch scale with
    // batch-size x candidates-per-doc x document length.
    const docs = ["doc-a", "doc-b", "doc-c"].map((id, i) => signedDoc(id, i + 1));
    const candidateResult: NearDupCandidateFetchResult = {
      candidates: { shared: candidate("shared") },
      candidateIdsByDoc: {
        "doc-a": ["shared"],
        "doc-b": ["shared"],
        "doc-c": ["shared"],
      },
      existingEdges: {},
    };

    const pairs = assembleVerifyPairs(
      docs,
      candidateResult,
      algoConfig,
      eligibleDocTypes,
      DEFAULT_NEAR_DUP_CONFIG.scheduler.maxCandidatesPerDoc,
    );

    // One pair per signed doc — the candidate really is reached three times.
    expect(pairs.map((p) => `${p.docId}|${p.candidateId}`).sort()).toEqual([
      "doc-a|shared",
      "doc-b|shared",
      "doc-c|shared",
    ]);
    // …and every pair carries the same shingle set.
    for (const p of pairs) expect(p.candidateShingles).toEqual(pairs[0].candidateShingles);
    expect(counters.shingleCalls).toBe(1);
  });

  test("an ineligible candidate is examined once and then skipped", () => {
    const docs = ["doc-a", "doc-b"].map((id, i) => signedDoc(id, i + 1));
    const contact = candidate("contact");
    contact.metadata = JSON.stringify({ documentType: "contact" });
    const candidateResult: NearDupCandidateFetchResult = {
      candidates: { contact },
      candidateIdsByDoc: { "doc-a": ["contact"], "doc-b": ["contact"] },
      existingEdges: {},
    };

    const pairs = assembleVerifyPairs(
      docs,
      candidateResult,
      algoConfig,
      eligibleDocTypes,
      DEFAULT_NEAR_DUP_CONFIG.scheduler.maxCandidatesPerDoc,
    );

    expect(pairs).toHaveLength(0);
    expect(counters.shingleCalls).toBe(0);
  });
});
