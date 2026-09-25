// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Reciprocal Rank Fusion (RRF) — combines multiple ranked lists.
 * RRF_score(d) = Σ (weight_L / (k + rank_L(d)))
 */

import type { SearchCandidate, SearchResultItem, ScoreBreakdown } from "./types.js";

export interface FusionOptions {
  k: number; // RRF constant (default 60)
  bm25Weight: number; // Weight for BM25 list
  vectorWeight: number; // Weight for vector list
  limit: number; // Max results after fusion
  /**
   * Bonus added to the rank-1 result's RRF score after the initial
   * sort. Default 0.05 (preserves prior behaviour); 0 disables.
   * Surfaced as `ScoreBreakdown.rankBonus`.
   */
  topRankBonus?: number;
  /**
   * Bonus added to the rank-2 / rank-3 results' RRF scores. Default
   * 0.02 (preserves prior behaviour); 0 disables.
   */
  nearTopRankBonus?: number;
}

interface FusedCandidate {
  candidate: SearchCandidate;
  bm25Rank?: number;
  vectorRank?: number;
  /** Raw RRF score (no bonus). */
  rrfScore: number;
  /** Top-rank bonus applied to this candidate (0 below rank 4). */
  rankBonus: number;
}

/**
 * Project a candidate into a result item, given its already-computed score and
 * breakdown. The two fusion paths (`rrfFuse`, `singleStageFuse`) differ only in
 * how they derive `score`/`scoreBreakdown`; every other field — including the
 * `?? undefined` coercions on the optional columns and the key order — is
 * identical, so they share this projection to stay in lockstep when the result
 * shape changes.
 */
function candidateToResult(
  candidate: SearchCandidate,
  score: number,
  scoreBreakdown: ScoreBreakdown,
): SearchResultItem {
  return {
    documentId: candidate.documentId,
    chunkRowid: candidate.chunkRowid,
    sourceId: candidate.sourceId,
    documentType: candidate.documentType,
    title: candidate.title,
    sourceUrl: candidate.sourceUrl ?? undefined,
    sourceCreatedAt: candidate.sourceCreatedAt,
    author: candidate.author ?? undefined,
    chunkText: candidate.chunkText,
    score,
    scoreBreakdown,
    relevanceScore: candidate.relevanceScore ?? undefined,
  };
}

/**
 * Fuse BM25 and vector search results using Reciprocal Rank Fusion.
 * Deduplicates by document (keeps best chunk per document).
 */
export function rrfFuse(
  bm25Results: SearchCandidate[],
  vectorResults: SearchCandidate[],
  options: FusionOptions,
): SearchResultItem[] {
  const { k, bm25Weight, vectorWeight, limit } = options;
  const topBonus = options.topRankBonus ?? 0.05;
  const nearBonus = options.nearTopRankBonus ?? 0.02;

  // Build a map of documentId:chunkRowid → fused candidate
  const candidateMap = new Map<string, FusedCandidate>();

  const getKey = (c: SearchCandidate) => `${c.documentId}:${c.chunkRowid}`;

  // Add BM25 results
  for (const candidate of bm25Results) {
    const key = getKey(candidate);
    const rank = candidate.rank ?? 1;
    const score = bm25Weight / (k + rank);
    candidateMap.set(key, {
      candidate,
      bm25Rank: rank,
      rrfScore: score,
      rankBonus: 0,
    });
  }

  // Add vector results
  for (const candidate of vectorResults) {
    const key = getKey(candidate);
    const rank = candidate.rank ?? 1;
    const score = vectorWeight / (k + rank);
    const existing = candidateMap.get(key);
    if (existing) {
      existing.vectorRank = rank;
      existing.rrfScore += score;
    } else {
      candidateMap.set(key, {
        candidate,
        vectorRank: rank,
        rrfScore: score,
        rankBonus: 0,
      });
    }
  }

  // Sort by RRF score descending
  const fused = [...candidateMap.values()];
  fused.sort((a, b) => b.rrfScore - a.rrfScore);

  // Top-rank bonus — recorded per-candidate so the final
  // ScoreBreakdown carries `rrfScore` (raw) + `rankBonus` separately
  // and the displayed `finalScore = rrfScore + rankBonus` still adds
  // up correctly. Re-sort uses the combined value.
  for (let i = 0; i < fused.length; i++) {
    if (i === 0) fused[i].rankBonus = topBonus;
    else if (i <= 2) fused[i].rankBonus = nearBonus;
    // ranks 4+ keep rankBonus = 0
  }

  // Re-sort after bonus by combined score (rrfScore + rankBonus).
  fused.sort((a, b) => b.rrfScore + b.rankBonus - (a.rrfScore + a.rankBonus));

  // Dedup by document — keep highest-scoring chunk per document
  const seen = new Set<string>();
  const results: SearchResultItem[] = [];

  for (const { candidate, bm25Rank, vectorRank, rrfScore, rankBonus } of fused) {
    if (seen.has(candidate.documentId)) continue;
    seen.add(candidate.documentId);

    const finalScore = rrfScore + rankBonus;
    const breakdown: ScoreBreakdown = {
      bm25Rank,
      vectorRank,
      rrfScore,
      finalScore,
    };
    if (rankBonus !== 0) breakdown.rankBonus = rankBonus;

    results.push(candidateToResult(candidate, finalScore, breakdown));

    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Pass-through for the browse path, which lists documents newest-first from
 * BM25 alone rather than fusing two ranked lists. Deduplicates by document.
 */
export function singleStageFuse(candidates: SearchCandidate[], limit: number): SearchResultItem[] {
  const seen = new Set<string>();
  const results: SearchResultItem[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.documentId)) continue;
    seen.add(candidate.documentId);

    const breakdown: ScoreBreakdown = {
      bm25Rank: candidate.rank,
      finalScore: candidate.score,
    };

    results.push(candidateToResult(candidate, candidate.score, breakdown));

    if (results.length >= limit) break;
  }

  return results;
}
