// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Pure-compute DF shingle extraction. NO database imports — runs on
 * CPU pool workers. Receives a chunk of document content and returns
 * per-shingle document-frequency counts for that chunk.
 */

import { normalizeText, shingles } from "@omnesis/near-dupes";

export interface DfChunkInput {
  contents: string[];
  shingleSize: number;
  stripQuotes: boolean;
}

export interface DfChunkResult {
  docsProcessed: number;
  shingleCounts: Array<[string, number]>;
}

/**
 * Extract shingles from a chunk of document contents and return
 * per-shingle DF counts (how many docs in this chunk contain each
 * shingle). The dedicated staging worker merges counts across chunks.
 */
export function extractDfChunk(input: DfChunkInput): DfChunkResult {
  const counts = new Map<string, number>();
  let docsProcessed = 0;

  for (const content of input.contents) {
    const sh = shingles(
      normalizeText(content, { stripQuotes: input.stripQuotes }),
      input.shingleSize,
    );
    if (sh.size === 0) continue;
    docsProcessed++;
    for (const s of sh) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
  }

  return {
    docsProcessed,
    shingleCounts: [...counts.entries()],
  };
}
