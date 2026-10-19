// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Finding the owner's past reactions that resemble a new item.
 *
 * The owner's interests are several unrelated things, so nothing here is
 * averaged: for a new item the lookup returns the few most similar things the
 * owner reacted to, split by what they did (wanted it, did not), and the
 * decision model weighs them. Similarity is cosine between vectors when the
 * query and a signal both have one from the same embedder; without an
 * embedder every comparison falls back to word overlap, which is coarse but
 * never silent. A signal whose vector came from another embedder is compared
 * by words until the backlog re-embeds it.
 */

import type { InterestSignal } from "../storage/interest.js";

/** One past reaction, as the decision model sees it. */
export interface InterestExample {
  /** What the owner reacted to. */
  text: string;
  /** The owner's own words about it, when they gave any. */
  note?: string;
  /** Which reaction it was (`task_accepted`, `brief_not_interested`, …). */
  source: string;
  ageDays: number;
  /** 0..1, two decimals; cosine or word overlap, whichever was available. */
  similarity: number;
}

export interface InterestStatementExample extends Omit<InterestExample, "source"> {
  direction: "more" | "less";
}

/**
 * The block a gate puts in its state. Absent (null) when nothing in the
 * ledger resembles the item, so an empty ledger changes no request at all.
 */
export interface OwnerInterest {
  /** Things like this one the owner wanted: accepted, created, thumbs up. */
  positive: InterestExample[];
  /** Things like this one the owner did not want: ignored, thumbs down. */
  negative: InterestExample[];
  /** What the owner said in words about things like this one. */
  statements: InterestStatementExample[];
}

export interface InterestLookupOptions {
  /** How many examples of each polarity to return at most. */
  perPolarity: number;
  /** Below this cosine a signal is not an example. */
  cosineFloor: number;
  /** Below this word overlap a signal is not an example (no vectors). */
  overlapFloor: number;
}

export const DEFAULT_LOOKUP_OPTIONS: InterestLookupOptions = {
  perPolarity: 4,
  cosineFloor: 0.55,
  overlapFloor: 0.2,
};

const DAY_MS = 24 * 60 * 60 * 1000;

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

const WORD_RE = /[\p{L}\p{N}]{3,}/gu;

/** The distinct words of three letters or more, lowercased. */
export function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(WORD_RE) ?? []);
}

/** Jaccard overlap of two word sets. */
export function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface InterestQuery {
  text: string;
  /** The query's vector and the embedder that made it, when one is available. */
  vector?: { values: Float32Array; model: string } | null;
}

interface Scored {
  signal: InterestSignal;
  similarity: number;
}

function matchText(signal: InterestSignal): string {
  return signal.note ? `${signal.subjectText}\n${signal.note}` : signal.subjectText;
}

/**
 * Rank live signals against the query and keep the few most similar of each
 * polarity. Pure: given the same signals and query it returns the same block.
 */
export function lookupOwnerInterest(
  signals: readonly InterestSignal[],
  query: InterestQuery,
  now: number,
  options: InterestLookupOptions = DEFAULT_LOOKUP_OPTIONS,
): OwnerInterest | null {
  if (signals.length === 0) return null;
  const words = wordSet(query.text);
  const scored: Scored[] = [];
  for (const signal of signals) {
    if (signal.supersededAt !== null) continue;
    const vector = query.vector;
    let similarity: number;
    if (
      vector &&
      signal.embedding &&
      signal.embeddingModel === vector.model &&
      signal.embedding.length === vector.values.length
    ) {
      similarity = cosineSimilarity(vector.values, signal.embedding);
      if (similarity < options.cosineFloor) continue;
    } else {
      similarity = wordOverlap(words, wordSet(matchText(signal)));
      if (similarity < options.overlapFloor) continue;
    }
    scored.push({ signal, similarity });
  }
  if (scored.length === 0) return null;
  // Most similar first; newest first on a tie, so the block is stable.
  scored.sort(
    (a, b) =>
      b.similarity - a.similarity ||
      b.signal.createdAt - a.signal.createdAt ||
      a.signal.id.localeCompare(b.signal.id),
  );
  const example = ({ signal, similarity }: Scored): InterestExample => ({
    text: signal.subjectText,
    ...(signal.note ? { note: signal.note } : {}),
    source: signal.source,
    ageDays: Math.max(0, Math.floor((now - signal.createdAt) / DAY_MS)),
    similarity: Math.round(similarity * 100) / 100,
  });
  const statements = scored.filter((s) => s.signal.kind === "statement");
  const reactions = scored.filter((s) => s.signal.kind !== "statement");
  return {
    positive: reactions
      .filter((s) => s.signal.polarity === 1)
      .slice(0, options.perPolarity)
      .map(example),
    negative: reactions
      .filter((s) => s.signal.polarity === -1)
      .slice(0, options.perPolarity)
      .map(example),
    statements: statements.slice(0, options.perPolarity).map((s) => {
      const { source: _source, ...rest } = example(s);
      return { ...rest, direction: s.signal.polarity === 1 ? "more" : "less" };
    }),
  };
}

/** Whether a block carries anything a gate would act on. */
export function hasOwnerInterest(block: OwnerInterest | null): block is OwnerInterest {
  return (
    block !== null &&
    (block.positive.length > 0 || block.negative.length > 0 || block.statements.length > 0)
  );
}
