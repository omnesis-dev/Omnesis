// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * The recall stage of a semantic match, against the install's real embeddings.
 *
 * Per-chunk max cosine, which is the measure the shipped semantic evaluator
 * already uses and the number every threshold in a compiled plan was chosen
 * against. Taking the max over chunks rather than a document-level vector is
 * what lets a long document match on the paragraph that is about the thing.
 *
 * Nomination is not firing. A score over the threshold puts a document in front
 * of the judge and nothing more, so this stage is allowed to be generous — and
 * the query embedding is cached per watch-node, because a watch asks the same
 * question of every document it sees.
 */

import { createLogger, type Logger } from "@omnesis/core";
import type { RecallRequest, RecallScorer } from "@omnesis/watch";
import type { Db } from "../data/types.js";

const log: Logger = createLogger("gateway").child("watch-v2:recall");

/**
 * Cosine similarity between two vectors.
 *
 * Both norms are divided out rather than assumed. An embedder is not obliged to
 * hand back unit vectors — the local nomic-embed model returns raw hidden
 * states with norms around 20 — and treating a dot product as a cosine on those
 * gives a number that is not a similarity at all. The extra pass is negligible
 * beside the embedding it compares.
 *
 * Vectors of different widths score zero. An install whose embedding model
 * changed leaves chunks of both widths behind, and arithmetic across them would
 * be arithmetic on unrelated numbers.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface ChunkVectorRow {
  embedding: Buffer;
}

export interface LiveRecallDeps {
  /** Read handle on `index.db`, where chunk embeddings live. */
  readonly indexDb: Db | null;
  /** The embedder, or null when the role is unassigned. */
  readonly embedder: () => { embedQuery(text: string): Promise<number[]> } | null;
}

export class LiveRecall implements RecallScorer {
  /** Query vectors, keyed by the query text. A watch asks one question. */
  private readonly queries = new Map<string, Float32Array>();

  constructor(private readonly deps: LiveRecallDeps) {}

  async score(request: RecallRequest): Promise<number> {
    const indexDb = this.deps.indexDb;
    if (!indexDb) return 0;

    const query = await this.queryVector(request.query);
    // A score of zero nominates nothing. That is the right answer when the
    // question cannot be embedded: a semantic arm with no embedder has not
    // declined a document, it has failed to consider it, and nominating on a
    // failure would put the whole corpus in front of the judge.
    if (!query) return 0;

    // An install whose embedding model changed leaves chunks of both widths
    // behind. `cosineSimilarity` scores a mismatched pair zero rather than
    // doing arithmetic on unrelated numbers, so a stale chunk simply never
    // wins the max.
    let best = 0;
    for (const chunk of this.chunkVectors(indexDb, request.documentId)) {
      const score = cosineSimilarity(query, chunk);
      if (score > best) best = score;
    }
    return best;
  }

  private async queryVector(query: string): Promise<Float32Array | null> {
    const cached = this.queries.get(query);
    if (cached) return cached;
    const embedder = this.deps.embedder();
    if (!embedder) return null;
    try {
      const vector = Float32Array.from(await embedder.embedQuery(query));
      this.queries.set(query, vector);
      return vector;
    } catch (err) {
      log.warn(
        `could not embed a watch query: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private chunkVectors(indexDb: Db, documentId: string): Float32Array[] {
    const rows = indexDb
      .prepare<
        [string],
        ChunkVectorRow
      >("SELECT embedding FROM chunks WHERE document_id = ? AND embedding IS NOT NULL")
      .all(documentId);
    return rows.map((row) =>
      new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ).slice(),
    );
  }
}
