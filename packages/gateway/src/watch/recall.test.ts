// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The recall stage, against real stored vectors.
 *
 * Recall decides which documents a judge is ever asked about, so its failure
 * modes are quiet in opposite directions: score too low and a semantic watch
 * never fires and nobody can tell it from a watch whose subject never came up;
 * score too high and every document in the corpus goes in front of a model,
 * which is the one thing the budget exists to prevent.
 *
 * The vectors here are hand-built and orthogonal, so what is asserted is the
 * arithmetic and the boundaries around it rather than an embedder's opinion.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { cosineSimilarity, LiveRecall } from "./recall.js";
import type { Db } from "../data/types.js";

const DOC = "aaaaaaaa-0000-4000-8000-000000000001";

let indexDb: Db;

/** A unit vector along one axis, as the chunk table stores one. */
function vector(values: number[]): Buffer {
  return Buffer.from(Float32Array.from(values).buffer);
}

function storeChunk(documentId: string, index: number, embedding: Buffer | null): void {
  indexDb
    .prepare(
      `INSERT INTO chunks (id, document_id, chunk_index, content, source_id, title,
                           source_created_at, embedding)
       VALUES (?, ?, ?, 'text', 'gmail', 'a title', '2026-01-01T00:00:00Z', ?)`,
    )
    .run(`${documentId}-${index}`, documentId, index, embedding);
}

beforeEach(() => {
  indexDb = new Database(":memory:") as unknown as Db;
  indexDb.exec(`
    CREATE TABLE chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_id TEXT NOT NULL,
      title TEXT NOT NULL,
      source_created_at TEXT NOT NULL,
      embedding BLOB
    )`);
});

afterEach(() => {
  indexDb.close();
});

/** An embedder that always answers with the same vector. */
function embedderFor(values: number[]): () => { embedQuery(text: string): Promise<number[]> } {
  return () => ({ embedQuery: () => Promise.resolve(values) });
}

describe("scoring a document", () => {
  it("takes the best chunk, not the average", async () => {
    // What lets a long document match on the one paragraph that is about the
    // thing. Averaging would bury a strong match under the rest of the text,
    // and the longer the document the more reliably it would.
    storeChunk(DOC, 0, vector([0, 1, 0]));
    storeChunk(DOC, 1, vector([1, 0, 0]));
    storeChunk(DOC, 2, vector([0, 0, 1]));

    const recall = new LiveRecall({ indexDb, embedder: embedderFor([1, 0, 0]) });
    const score = await recall.score({ nodeId: "mail", documentId: DOC, query: "roof" });

    expect(score).toBeCloseTo(1, 5);
  });

  it("scores a chunk of a different width at zero rather than comparing it", async () => {
    // An install whose embedding model changed leaves chunks of both widths
    // behind. Comparing across them would be arithmetic on unrelated numbers,
    // and a truncated comparison would score a stale chunk highly. Only the
    // mismatched chunk is stored, so a wrong answer has nowhere to hide behind
    // a good one.
    storeChunk(DOC, 0, vector([1, 0]));

    const recall = new LiveRecall({ indexDb, embedder: embedderFor([1, 0, 0]) });
    expect(await recall.score({ nodeId: "mail", documentId: DOC, query: "roof" })).toBe(0);
  });

  it("embeds a query once however many documents it is asked about", async () => {
    // A watch asks the same question of every document it sees. Re-embedding
    // per document would make the cost of a semantic arm scale with the corpus
    // rather than with the number of questions.
    storeChunk(DOC, 0, vector([1, 0, 0]));
    let embedded = 0;
    const recall = new LiveRecall({
      indexDb,
      embedder: () => ({
        embedQuery: () => {
          embedded += 1;
          return Promise.resolve([1, 0, 0]);
        },
      }),
    });

    await recall.score({ nodeId: "mail", documentId: DOC, query: "roof" });
    await recall.score({ nodeId: "mail", documentId: DOC, query: "roof" });
    await recall.score({ nodeId: "other", documentId: DOC, query: "roof" });

    expect(embedded, "the same question was embedded more than once").toBe(1);
  });
});

describe("scoring when the install cannot answer", () => {
  it("nominates nothing when the query cannot be embedded", async () => {
    // Zero is the honest answer. A failure is not a document declining to
    // match, and nominating on one would put the whole corpus in front of the
    // judge at exactly the moment the install is least able to cope.
    storeChunk(DOC, 0, vector([1, 0, 0]));
    const recall = new LiveRecall({ indexDb, embedder: () => null });
    expect(await recall.score({ nodeId: "mail", documentId: DOC, query: "roof" })).toBe(0);
  });

  it("nominates nothing when the embedder throws", async () => {
    storeChunk(DOC, 0, vector([1, 0, 0]));
    const recall = new LiveRecall({
      indexDb,
      embedder: () => ({ embedQuery: () => Promise.reject(new Error("embedder down")) }),
    });
    expect(await recall.score({ nodeId: "mail", documentId: DOC, query: "roof" })).toBe(0);
  });

  it("nominates nothing when there is no index at all", async () => {
    const recall = new LiveRecall({ indexDb: null, embedder: embedderFor([1, 0, 0]) });
    expect(await recall.score({ nodeId: "mail", documentId: DOC, query: "roof" })).toBe(0);
  });

  it("nominates nothing for a document with no vectors yet", async () => {
    // A document written but not yet embedded. Its `doc.indexed` event has not
    // arrived either, so this is mostly belt and braces — but scoring it as
    // anything other than zero would nominate on the absence of evidence.
    storeChunk(DOC, 0, null);
    const recall = new LiveRecall({ indexDb, embedder: embedderFor([1, 0, 0]) });
    expect(await recall.score({ nodeId: "mail", documentId: DOC, query: "roof" })).toBe(0);
  });
});

describe("cosineSimilarity helper", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([0.6, 0.8]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal unit vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite unit vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for mismatched dimensions", () => {
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0]))).toBe(0);
  });

  it("normalizes — dot product of large unrelated vectors gives a small cosine", () => {
    // llama.cpp returns un-normalized embeddings; norms ~20 are realistic for
    // nomic-embed-text-v1.5. Two roughly-orthogonal vectors of that scale must
    // still come out near 0, not at the dot-product magnitude.
    const a = new Float32Array(64);
    const b = new Float32Array(64);
    for (let i = 0; i < 32; i += 1) a[i] = 2.5;
    for (let i = 32; i < 64; i += 1) b[i] = 2.5;
    // dot is 0 here, norms are 20 each. Cosine is exactly 0.
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("normalizes — same direction at any magnitude returns 1", () => {
    const a = new Float32Array([3, 4]); // norm 5
    const b = new Float32Array([6, 8]); // norm 10
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});
