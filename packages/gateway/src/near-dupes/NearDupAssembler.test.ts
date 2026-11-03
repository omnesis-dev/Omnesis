// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * `assembleVerifyPairs` runs on the gateway's main thread, between two CPU
 * pool phases. Anything it does per pair is charged to every in-flight HTTP
 * request, so the shape of its work is what these tests pin: it never
 * normalizes or shingles text, which `prepareCandidateBatch` does on the
 * pool, once per candidate.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_NEAR_DUP_CONFIG } from "./config.js";
import type { CandidateDocData, SignedDoc } from "./cpu-signing.js";
import type { NearDupCandidateFetchResult } from "./NearDupComputeService.js";

const counters = vi.hoisted(() => ({ shingleCalls: 0, normalizeCalls: 0 }));

vi.mock("@omnesis/near-dupes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@omnesis/near-dupes")>();
  return {
    ...actual,
    shingles: (text: string, size: number) => {
      counters.shingleCalls++;
      return actual.shingles(text, size);
    },
    normalizeText: (...args: Parameters<typeof actual.normalizeText>) => {
      counters.normalizeCalls++;
      return actual.normalizeText(...args);
    },
  };
});

const { assembleVerifyPairs, chunkCandidatesForPreparation } =
  await import("./NearDupAssembler.js");
const { prepareCandidateBatch } = await import("./cpu-signing.js");

const algoConfig = DEFAULT_NEAR_DUP_CONFIG.algorithm;
const eligibleDocTypes = [...DEFAULT_NEAR_DUP_CONFIG.eligibleDocTypes];
const maxCandidatesPerDoc = DEFAULT_NEAR_DUP_CONFIG.scheduler.maxCandidatesPerDoc;

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

function candidate(candidateId: string, content?: string): CandidateDocData {
  return {
    candidateId,
    content: content ?? "Quarterly planning notes for the launch review meeting. ".repeat(20),
    contentHash: `ch-${candidateId}`,
    extractedContentHash: null,
    metadata: JSON.stringify({ documentType: "email" }),
  };
}

function preparedMap(candidates: CandidateDocData[]) {
  return new Map(
    prepareCandidateBatch(candidates, algoConfig, eligibleDocTypes).map(
      (c) => [c.candidateId, c] as const,
    ),
  );
}

beforeEach(() => {
  counters.shingleCalls = 0;
  counters.normalizeCalls = 0;
});

describe("assembleVerifyPairs", () => {
  test("pairs every signed doc with a shared candidate without shingling anything", () => {
    // The same stored document is an LSH candidate for many of the docs in
    // a batch — that is what an LSH bucket is. Its shingles come prepared,
    // so the main thread only looks them up.
    const docs = ["doc-a", "doc-b", "doc-c"].map((id, i) => signedDoc(id, i + 1));
    const prepared = preparedMap([candidate("shared")]);
    counters.shingleCalls = 0;
    counters.normalizeCalls = 0;
    const candidateResult: Pick<NearDupCandidateFetchResult, "candidateIdsByDoc"> = {
      candidateIdsByDoc: {
        "doc-a": ["shared"],
        "doc-b": ["shared"],
        "doc-c": ["shared"],
      },
    };

    const pairs = assembleVerifyPairs(docs, candidateResult, prepared, maxCandidatesPerDoc);

    expect(pairs.map((p) => `${p.docId}|${p.candidateId}`).sort()).toEqual([
      "doc-a|shared",
      "doc-b|shared",
      "doc-c|shared",
    ]);
    for (const p of pairs) expect(p.candidateShingles).toBe(prepared.get("shared")!.shingles);
    expect(counters.shingleCalls).toBe(0);
    expect(counters.normalizeCalls).toBe(0);
  });

  test("skips a candidate that was not prepared", () => {
    const docs = ["doc-a", "doc-b"].map((id, i) => signedDoc(id, i + 1));
    const pairs = assembleVerifyPairs(
      docs,
      { candidateIdsByDoc: { "doc-a": ["contact"], "doc-b": ["contact"] } },
      new Map(),
      maxCandidatesPerDoc,
    );
    expect(pairs).toHaveLength(0);
  });
});

describe("assembleVerifyPairs and in-batch candidates", () => {
  /** Two signed docs sharing a band, so each is the other's in-batch candidate. */
  function sharingBand(id: string, shingles: string[] | null = [`${id} alpha`]): SignedDoc {
    return { ...signedDoc(id, 7), shingles };
  }

  test("an in-batch doc's own shingles win over a prepared copy of it", () => {
    const prepared = preparedMap([candidate("doc-b")]);
    const pairs = assembleVerifyPairs(
      [sharingBand("doc-a"), sharingBand("doc-b")],
      { candidateIdsByDoc: { "doc-a": ["doc-b"] } },
      prepared,
      maxCandidatesPerDoc,
    );
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.candidateShingles).toEqual(["doc-b alpha"]);
  });

  test("an in-batch doc without shingles falls back to its prepared copy", () => {
    const prepared = preparedMap([candidate("doc-b")]);
    const pairs = assembleVerifyPairs(
      [sharingBand("doc-a"), sharingBand("doc-b", null)],
      { candidateIdsByDoc: { "doc-a": ["doc-b"] } },
      prepared,
      maxCandidatesPerDoc,
    );
    expect(pairs.map((p) => p.candidateShingles)).toEqual([prepared.get("doc-b")!.shingles]);
  });

  test("the per-doc cap keeps in-batch candidates before persisted ones", () => {
    const prepared = preparedMap([candidate("stored")]);
    const pairs = assembleVerifyPairs(
      [sharingBand("doc-a"), sharingBand("doc-b")],
      { candidateIdsByDoc: { "doc-a": ["stored"] } },
      prepared,
      1,
    );
    expect(pairs.map((p) => `${p.docId}|${p.candidateId}`)).toEqual(["doc-a|doc-b"]);
  });
});

describe("prepareCandidateBatch", () => {
  test("prepares each candidate once and leaves out the ineligible and the empty", () => {
    const contact = candidate("contact");
    contact.metadata = JSON.stringify({ documentType: "contact" });
    const blank = candidate("blank", "   \n\t  ");
    const prepared = prepareCandidateBatch(
      [candidate("kept"), contact, blank],
      algoConfig,
      eligibleDocTypes,
    );

    expect(prepared.map((c) => c.candidateId)).toEqual(["kept"]);
    expect(prepared[0]!.meta).toEqual({
      contentHash: "ch-kept",
      extractedContentHash: null,
      docType: "email",
      threadId: null,
      senderAddress: null,
    });
    expect(prepared[0]!.shingles.length).toBeGreaterThan(0);
    // The contact is rejected on its metadata, before its text is read.
    expect(counters.shingleCalls).toBe(2);
  });
});

describe("chunkCandidatesForPreparation", () => {
  test("bounds each call by candidate count and by text, keeping every candidate once", () => {
    const many = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`c${i}`, candidate(`c${i}`, "short text")]),
    );
    expect(chunkCandidatesForPreparation(many).map((c) => c.length)).toEqual([128, 128, 44]);

    const big = "word ".repeat(30_000);
    const large = {
      a: candidate("a", big),
      b: candidate("b", big),
      c: candidate("c", "tiny"),
      huge: candidate("huge", big.repeat(3)),
    };
    expect(chunkCandidatesForPreparation(large).map((c) => c.map((x) => x.candidateId))).toEqual([
      ["a"],
      ["b", "c"],
      ["huge"],
    ]);
    expect(chunkCandidatesForPreparation({})).toEqual([]);
  });
});
