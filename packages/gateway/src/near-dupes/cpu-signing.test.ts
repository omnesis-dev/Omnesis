// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

import { describe, expect, test } from "vitest";
import { IDF_EXCL_CONFIG } from "@omnesis/near-dupes";
import { DEFAULT_NEAR_DUP_CONFIG } from "./config.js";
import { signDocBatch, verifyPairBatch } from "./cpu-signing.js";
import { buildDfSab } from "./df-sab.js";
import type {
  NearDupDocForSigning,
  SerializableDf,
  VerifyPairInput,
  VerifyDocMeta,
} from "./cpu-signing.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const ELIGIBLE_DOC_TYPES = [...DEFAULT_NEAR_DUP_CONFIG.eligibleDocTypes];

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
    ["delta", 7],
    ["echo", 6],
  ],
};
// The CPU functions read the DF from a SharedArrayBuffer (built once, shared
// across workers). Pack the fixture the same way the production path does.
const SMALL_DF = buildDfSab(SMALL_DF_DATA.entries, SMALL_DF_DATA.totalDocs);

const ALGO_CONFIG = IDF_EXCL_CONFIG;

function makeDoc(
  overrides: Partial<NearDupDocForSigning> & { docId: string },
): NearDupDocForSigning {
  return {
    inboxId: 1,
    reason: "insert",
    content: "default content that is long enough for shingling purposes",
    contentHash: "ch-" + overrides.docId,
    extractedContentHash: null,
    metadata: JSON.stringify({ documentType: "email" }),
    ...overrides,
  };
}

// ── signDocBatch ──────────────────────────────────────────────────────

describe("signDocBatch", () => {
  const BODY = [
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet",
    "kilo lima mike november oscar papa quebec romeo sierra tango",
    "uniform victor whiskey xray yankee zulu apple banana cherry date",
    "elderberry fig grape honeydew kiwi lemon mango nectarine orange pear",
  ].join(" ");

  test("valid content produces non-null signatures, bands, and shingles", () => {
    const docs = [makeDoc({ docId: "doc-1", content: BODY })];
    const results = signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.docId).toBe("doc-1");
    expect(r.shouldDelete).toBe(false);
    expect(r.signatureBytes).not.toBeNull();
    expect(r.signatureBytes!.length).toBeGreaterThan(0);
    expect(r.bands).not.toBeNull();
    expect(r.bands!.length).toBe(ALGO_CONFIG.bands);
    expect(r.shingles).not.toBeNull();
    expect(r.shingles!.length).toBeGreaterThan(0);
    expect(r.shingleCount).toBe(r.shingles!.length);
  });

  test("empty content after normalization produces shouldDelete=true", () => {
    const docs = [makeDoc({ docId: "doc-empty", content: "   \n\t   " })];
    const results = signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES);

    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.shouldDelete).toBe(true);
    expect(r.signatureBytes).toBeNull();
    expect(r.bands).toBeNull();
    expect(r.shingles).toBeNull();
    expect(r.shingleCount).toBe(0);
  });

  test("ineligible docType produces shouldDelete=true", () => {
    const docs = [
      makeDoc({
        docId: "doc-contact",
        content: BODY,
        metadata: JSON.stringify({ documentType: "contact" }),
      }),
    ];
    const results = signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES);

    expect(results).toHaveLength(1);
    expect(results[0].shouldDelete).toBe(true);
    expect(results[0].docType).toBe("contact");
  });

  test("content that normalizes to empty produces shouldDelete=true", () => {
    // Content that is non-empty but normalizes to empty (all whitespace/control chars).
    const docs = [makeDoc({ docId: "doc-short", content: "\r\n\r\n" })];
    const results = signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES);

    expect(results).toHaveLength(1);
    expect(results[0].shouldDelete).toBe(true);
    expect(results[0].shingleCount).toBe(0);
  });

  test("shingle count matches the number of unique shingles in the output", () => {
    const docs = [makeDoc({ docId: "doc-count", content: BODY })];
    const results = signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES);

    const r = results[0];
    expect(r.shingleCount).toBe(r.shingles!.length);
    // The set of shingles should have no duplicates (they come from a Set).
    expect(new Set(r.shingles!).size).toBe(r.shingles!.length);
  });

  test("batch of multiple docs all produce results in order", () => {
    const docs = [
      makeDoc({ docId: "doc-a", content: BODY }),
      makeDoc({ docId: "doc-b", content: BODY + " extra words at the end" }),
      makeDoc({ docId: "doc-c", content: "   " }), // empty after normalization
    ];
    const results = signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES);

    expect(results).toHaveLength(3);
    expect(results[0].docId).toBe("doc-a");
    expect(results[0].shouldDelete).toBe(false);
    expect(results[1].docId).toBe("doc-b");
    expect(results[1].shouldDelete).toBe(false);
    expect(results[2].docId).toBe("doc-c");
    expect(results[2].shouldDelete).toBe(true);
  });

  test("metadata parsing extracts docType, threadId, and senderAddress", () => {
    const metadata = JSON.stringify({
      documentType: "email",
      extra: { threadId: "thread-42" },
      people: [{ role: "sender", emails: ["Maya@Example.COM"] }],
    });
    const docs = [makeDoc({ docId: "doc-meta", content: BODY, metadata })];
    const results = signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES);

    const r = results[0];
    expect(r.docType).toBe("email");
    expect(r.threadId).toBe("thread-42");
    expect(r.senderAddress).toBe("maya@example.com"); // lowercased
  });

  test("a sender that names its address by kind signs the same way", () => {
    // This reads mentions out of stored JSON rather than through the
    // projection, so it is one of the places that goes blind if it only knows
    // the older spelling — and a lost sender address means a thread stops
    // grouping, silently.
    const metadata = JSON.stringify({
      documentType: "email",
      extra: { threadId: "thread-42" },
      people: [{ role: "sender", identifiers: [{ kind: "email", value: "Maya@Example.COM" }] }],
    });
    const docs = [makeDoc({ docId: "doc-meta-kind", content: BODY, metadata })];

    const r = signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES)[0];

    expect(r.senderAddress).toBe("maya@example.com");
  });

  test("a sender named only by a platform id has no address to sign by", () => {
    // The kind matters: a lid is not an address, and reading the first
    // identifier of any kind would put one in the signature.
    const metadata = JSON.stringify({
      documentType: "email",
      people: [{ role: "sender", identifiers: [{ kind: "lid", value: "whatsapp:44770090111" }] }],
    });
    const docs = [makeDoc({ docId: "doc-meta-lid", content: BODY, metadata })];

    expect(signDocBatch(docs, ALGO_CONFIG, SMALL_DF, ELIGIBLE_DOC_TYPES)[0]!.senderAddress).toBe(
      null,
    );
  });
});

// ── verifyPairBatch ──────────────────────────────────────────────────

describe("verifyPairBatch", () => {
  const GATE_CONFIG = {
    recordThreshold: DEFAULT_NEAR_DUP_CONFIG.gate.recordThreshold,
    maxIdfWeight: ALGO_CONFIG.maxIdfWeight ?? 8.0,
    emailJaccardMin: DEFAULT_NEAR_DUP_CONFIG.gate.emailJaccardMin,
    emailPairUniqueDf2Min: DEFAULT_NEAR_DUP_CONFIG.gate.emailPairUniqueDf2Min,
    fileLikeJaccardMin: DEFAULT_NEAR_DUP_CONFIG.gate.fileLikeJaccardMin,
    fileLikePairUniqueDf2Min: DEFAULT_NEAR_DUP_CONFIG.gate.fileLikePairUniqueDf2Min,
    fileLikeContainmentMin: DEFAULT_NEAR_DUP_CONFIG.gate.fileLikeContainmentMin,
    automatedSenderPrefixes: [...DEFAULT_NEAR_DUP_CONFIG.gate.automatedSenderPrefixes],
  };

  function makeMeta(overrides: Partial<VerifyDocMeta> = {}): VerifyDocMeta {
    return {
      contentHash: null,
      extractedContentHash: null,
      docType: "file",
      threadId: null,
      senderAddress: null,
      ...overrides,
    };
  }

  test("identical shingle sets produce an accepted pair", () => {
    const shingles = ["a b c d e", "b c d e f", "c d e f g", "d e f g h"];
    const pair: VerifyPairInput = {
      docId: "doc-a",
      candidateId: "doc-b",
      docShingles: shingles,
      candidateShingles: shingles,
      docMeta: makeMeta(),
      candidateMeta: makeMeta(),
    };
    const results = verifyPairBatch([pair], SMALL_DF, GATE_CONFIG);

    expect(results.length).toBe(1);
    expect(results[0].accepted).toBe(true);
    expect(results[0].jaccard).toBeCloseTo(1.0, 5);
  });

  test("completely different shingle sets are filtered out (below threshold)", () => {
    const pair: VerifyPairInput = {
      docId: "doc-a",
      candidateId: "doc-b",
      docShingles: ["a b c d e", "b c d e f"],
      candidateShingles: ["x y z w v", "y z w v u"],
      docMeta: makeMeta(),
      candidateMeta: makeMeta(),
    };
    const results = verifyPairBatch([pair], SMALL_DF, GATE_CONFIG);

    expect(results).toHaveLength(0);
  });

  test("same-thread email pair is suppressed by shouldSuppress", () => {
    const shingles = ["a b c d e", "b c d e f", "c d e f g"];
    const pair: VerifyPairInput = {
      docId: "doc-a",
      candidateId: "doc-b",
      docShingles: shingles,
      candidateShingles: shingles,
      docMeta: makeMeta({ docType: "email", threadId: "thread-1" }),
      candidateMeta: makeMeta({ docType: "email", threadId: "thread-1" }),
    };
    const results = verifyPairBatch([pair], SMALL_DF, GATE_CONFIG);

    // Same-thread suppression removes the pair before it reaches the gate.
    expect(results).toHaveLength(0);
  });

  test("docA < docB canonical order is enforced in the output", () => {
    const shingles = ["a b c d e", "b c d e f", "c d e f g"];
    const pair: VerifyPairInput = {
      docId: "z-doc",
      candidateId: "a-doc",
      docShingles: shingles,
      candidateShingles: shingles,
      docMeta: makeMeta(),
      candidateMeta: makeMeta(),
    };
    const results = verifyPairBatch([pair], SMALL_DF, GATE_CONFIG);

    expect(results.length).toBe(1);
    expect(results[0].docA).toBe("a-doc");
    expect(results[0].docB).toBe("z-doc");
    expect(results[0].docA < results[0].docB).toBe(true);
  });

  test("exact-dupe content hashes are suppressed", () => {
    const shingles = ["a b c d e", "b c d e f", "c d e f g"];
    const pair: VerifyPairInput = {
      docId: "doc-a",
      candidateId: "doc-b",
      docShingles: shingles,
      candidateShingles: shingles,
      docMeta: makeMeta({ contentHash: "same-hash" }),
      candidateMeta: makeMeta({ contentHash: "same-hash" }),
    };
    const results = verifyPairBatch([pair], SMALL_DF, GATE_CONFIG);

    expect(results).toHaveLength(0);
  });

  test("multiple pairs are processed independently", () => {
    const shinglesIdentical = ["a b c d e", "b c d e f", "c d e f g"];
    const pairs: VerifyPairInput[] = [
      {
        docId: "doc-1",
        candidateId: "doc-2",
        docShingles: shinglesIdentical,
        candidateShingles: shinglesIdentical,
        docMeta: makeMeta(),
        candidateMeta: makeMeta(),
      },
      {
        docId: "doc-3",
        candidateId: "doc-4",
        docShingles: ["x y z w v"],
        candidateShingles: ["m n o p q"],
        docMeta: makeMeta(),
        candidateMeta: makeMeta(),
      },
    ];
    const results = verifyPairBatch(pairs, SMALL_DF, GATE_CONFIG);

    // First pair passes (identical), second fails (disjoint).
    expect(results.length).toBe(1);
    expect(results[0].docA).toBe("doc-1");
    expect(results[0].docB).toBe("doc-2");
  });
});
