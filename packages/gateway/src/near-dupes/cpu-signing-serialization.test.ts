// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Structured-clone safety tests for types that cross the postMessage
 * boundary between the main thread and CPU pool workers. Any type that
 * contains a Set, Map, Buffer, or function will fail structuredClone —
 * this test catches those regressions before they surface as silent
 * data loss in production.
 */

import { describe, expect, test } from "vitest";
import { IDF_EXCL_CONFIG } from "@omnesis/near-dupes";
import { DEFAULT_NEAR_DUP_CONFIG } from "./config.js";
import { signDocBatch, verifyPairBatch } from "./cpu-signing.js";
import { buildDfSab } from "./df-sab.js";
import type {
  NearDupDocForSigning,
  SerializableDf,
  SignedDoc,
  VerifyPairInput,
  VerifyDocMeta,
  VerifiedPair,
} from "./cpu-signing.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const ELIGIBLE_DOC_TYPES = [...DEFAULT_NEAR_DUP_CONFIG.eligibleDocTypes];
const ALGO_CONFIG = IDF_EXCL_CONFIG;

const SMALL_DF_DATA: SerializableDf = {
  totalDocs: 100,
  entries: [
    ["the", 90],
    ["quick", 10],
    ["brown", 8],
    ["fox", 5],
    ["jumped", 3],
    ["over", 15],
    ["lazy", 4],
    ["dog", 6],
    ["alpha", 12],
    ["bravo", 11],
    ["charlie", 9],
  ],
};
// The CPU functions read the DF from a SharedArrayBuffer (shared across
// workers). Pack the fixture the same way the production path does.
const SMALL_DF = buildDfSab(SMALL_DF_DATA.entries, SMALL_DF_DATA.totalDocs);

const BODY = [
  "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
  "kilo lima mike november oscar papa quebec romeo sierra tango",
  "uniform victor whiskey xray yankee zulu apple banana cherry date",
  "elderberry fig grape honeydew kiwi lemon mango nectarine orange pear",
].join(" ");

// ── Individual type cloning ──────────────────────────────────────────

describe("structuredClone safety for postMessage types", () => {
  test("NearDupDocForSigning survives structuredClone", () => {
    const doc: NearDupDocForSigning = {
      inboxId: 42,
      docId: "doc-clone-1",
      reason: "insert",
      content: BODY,
      contentHash: "ch-1",
      extractedContentHash: null,
      metadata: JSON.stringify({
        documentType: "email",
        extra: { threadId: "t-1" },
        people: [{ role: "sender", emails: ["maya@example.com"] }],
      }),
    };

    const cloned = structuredClone(doc);
    expect(cloned).toEqual(doc);
  });

  test("SignedDoc survives structuredClone (signatureBytes is number[], not Buffer)", () => {
    const signed: SignedDoc = {
      docId: "doc-signed-1",
      inboxId: 7,
      reason: "insert",
      signatureBytes: [0, 1, 2, 255, 128, 64],
      shingleCount: 15,
      bands: [
        100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500, 1600,
      ],
      shingles: ["a b c d e", "b c d e f", "c d e f g"],
      docType: "email",
      threadId: "thread-42",
      senderAddress: "maya@example.com",
      contentHash: "ch-signed",
      extractedContentHash: null,
      shouldDelete: false,
    };

    const cloned = structuredClone(signed);
    expect(cloned).toEqual(signed);
  });

  test("SignedDoc with null fields survives structuredClone", () => {
    const signed: SignedDoc = {
      docId: "doc-deleted",
      inboxId: 8,
      reason: "insert",
      signatureBytes: null,
      shingleCount: 0,
      bands: null,
      shingles: null,
      docType: "contact",
      threadId: null,
      senderAddress: null,
      contentHash: null,
      extractedContentHash: null,
      shouldDelete: true,
    };

    const cloned = structuredClone(signed);
    expect(cloned).toEqual(signed);
  });

  test("SerializableDf survives structuredClone", () => {
    const cloned = structuredClone(SMALL_DF);
    expect(cloned).toEqual(SMALL_DF);
  });

  test("VerifyPairInput survives structuredClone", () => {
    const meta: VerifyDocMeta = {
      contentHash: "ch-1",
      extractedContentHash: null,
      docType: "file",
      threadId: null,
      senderAddress: null,
    };
    const input: VerifyPairInput = {
      docId: "doc-a",
      candidateId: "doc-b",
      docShingles: ["a b c d e", "b c d e f"],
      candidateShingles: ["a b c d e", "c d e f g"],
      docMeta: meta,
      candidateMeta: { ...meta, contentHash: "ch-2" },
    };

    const cloned = structuredClone(input);
    expect(cloned).toEqual(input);
  });

  test("VerifiedPair survives structuredClone", () => {
    const pair: VerifiedPair = {
      docA: "doc-a",
      docB: "doc-b",
      jaccard: 0.92,
      pairUniqueDf2: 7,
      pairUniqueDf5: 3,
      containmentMin: 0.98,
      gateFamily: "file-like",
      accepted: true,
    };

    const cloned = structuredClone(pair);
    expect(cloned).toEqual(pair);
  });
});

// ── End-to-end function output cloning ──────────────────────────────

describe("structuredClone safety for function outputs", () => {
  test("signDocBatch output survives structuredClone", () => {
    const docs: NearDupDocForSigning[] = [
      {
        inboxId: 1,
        docId: "doc-sign-clone",
        reason: "insert",
        content: BODY,
        contentHash: "ch-sc",
        extractedContentHash: null,
        metadata: JSON.stringify({ documentType: "file" }),
      },
    ];

    const result = signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES);
    const cloned = structuredClone(result);

    expect(cloned).toEqual(result);
    // Extra checks: arrays, not Sets or Buffers.
    expect(Array.isArray(cloned[0].shingles)).toBe(true);
    expect(Array.isArray(cloned[0].signatureBytes)).toBe(true);
    expect(Array.isArray(cloned[0].bands)).toBe(true);
  });

  test("signDocBatch output for shouldDelete doc survives structuredClone", () => {
    const docs: NearDupDocForSigning[] = [
      {
        inboxId: 2,
        docId: "doc-empty-clone",
        reason: "insert",
        content: "   ",
        contentHash: null,
        extractedContentHash: null,
        metadata: JSON.stringify({ documentType: "email" }),
      },
    ];

    const result = signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES);
    const cloned = structuredClone(result);

    expect(cloned).toEqual(result);
    expect(cloned[0].shouldDelete).toBe(true);
  });

  test("verifyPairBatch output survives structuredClone", () => {
    const shingles = ["a b c d e", "b c d e f", "c d e f g", "d e f g h"];
    const meta: VerifyDocMeta = {
      contentHash: null,
      extractedContentHash: null,
      docType: "file",
      threadId: null,
      senderAddress: null,
    };
    const pairs: VerifyPairInput[] = [
      {
        docId: "doc-v1",
        candidateId: "doc-v2",
        docShingles: shingles,
        candidateShingles: shingles,
        docMeta: meta,
        candidateMeta: meta,
      },
    ];

    const gateConfig = {
      recordThreshold: DEFAULT_NEAR_DUP_CONFIG.gate.recordThreshold,
      maxIdfWeight: ALGO_CONFIG.maxIdfWeight ?? 8.0,
      emailJaccardMin: DEFAULT_NEAR_DUP_CONFIG.gate.emailJaccardMin,
      emailPairUniqueDf2Min: DEFAULT_NEAR_DUP_CONFIG.gate.emailPairUniqueDf2Min,
      fileLikeJaccardMin: DEFAULT_NEAR_DUP_CONFIG.gate.fileLikeJaccardMin,
      fileLikePairUniqueDf2Min: DEFAULT_NEAR_DUP_CONFIG.gate.fileLikePairUniqueDf2Min,
      fileLikeContainmentMin: DEFAULT_NEAR_DUP_CONFIG.gate.fileLikeContainmentMin,
      automatedSenderPrefixes: [...DEFAULT_NEAR_DUP_CONFIG.gate.automatedSenderPrefixes],
    };

    const result = verifyPairBatch(pairs, SMALL_DF, gateConfig);
    expect(result.length).toBeGreaterThan(0);

    const cloned = structuredClone(result);
    expect(cloned).toEqual(result);
  });

  test("empty verifyPairBatch output survives structuredClone", () => {
    const result = verifyPairBatch([], SMALL_DF, {
      recordThreshold: 0.5,
      maxIdfWeight: 8.0,
      emailJaccardMin: 0.85,
      emailPairUniqueDf2Min: 5,
      fileLikeJaccardMin: 0.75,
      fileLikePairUniqueDf2Min: 1,
      fileLikeContainmentMin: 0.95,
      automatedSenderPrefixes: [],
    });

    const cloned = structuredClone(result);
    expect(cloned).toEqual(result);
    expect(cloned).toHaveLength(0);
  });
});
