// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Telling the voices of one recorded conversation apart.
 *
 * A recording arrives as one-minute chunks, and each chunk's audio is deleted
 * once it is transcribed, so the voices cannot be separated over the whole
 * recording at once. Instead each chunk is cut into short voice windows — the
 * stretches where one person speaks, split to at most `MAX_WINDOW_MS` — and
 * each window gets a voice vector (an embedding of how it sounds). When the
 * session's document is written, the windows of every chunk are grouped by
 * similarity into the session's speakers, and the vectors are deleted: they
 * never outlive the session's processing, and nothing recognises a voice
 * across sessions.
 *
 * Pure: window cutting and grouping, shared by the worker subprocess and the
 * in-process replay separator.
 */

/** One stretch of a chunk where a single voice speaks; ms from the chunk's start. */
export interface VoiceWindow {
  startMs: number;
  endMs: number;
  /** The session's speaker (1-based), once the session's voices are grouped. */
  speaker?: number;
}

/** A chunk's voice windows, each with its vector (same order, same length). */
export interface SeparatedVoices {
  windows: VoiceWindow[];
  vectors: Float32Array[];
}

/** Separates voices on one chunk's audio and groups vectors into speakers. */
export interface VoiceSeparator {
  readonly name: string;
  /** The chunk's voice windows and their vectors; empty when nobody spoke. */
  separate(audio: Uint8Array, mimeType: string): Promise<SeparatedVoices>;
  /** Speaker index (0-based, numbered by first appearance) for each vector. */
  group(vectors: readonly Float32Array[]): Promise<number[]>;
  dispose(): Promise<void>;
}

/** A window longer than this is split, so one window rarely holds two voices. */
export const MAX_WINDOW_MS = 8_000;
/** A stretch shorter than this is too short for a reliable voice vector. */
export const MIN_WINDOW_MS = 1_000;
/**
 * Two groups of windows at least this similar (mean cosine similarity) are
 * the same speaker. With the bundled embedding model, a two-speaker
 * recording grouped correctly at any threshold from 0.70 to 0.80 and split
 * one voice in two at 0.85; this is the middle of that range.
 */
export const SAME_SPEAKER_SIMILARITY = 0.75;

/**
 * Cut the stretches a separator found (one voice each) into voice windows:
 * stretches shorter than `MIN_WINDOW_MS` are dropped, longer ones are split
 * evenly into pieces of at most `MAX_WINDOW_MS`.
 */
export function voiceWindows(
  stretches: readonly { startMs: number; endMs: number }[],
): VoiceWindow[] {
  const out: VoiceWindow[] = [];
  for (const { startMs, endMs } of stretches) {
    const length = endMs - startMs;
    if (length < MIN_WINDOW_MS) continue;
    const pieces = Math.ceil(length / MAX_WINDOW_MS);
    const step = length / pieces;
    for (let i = 0; i < pieces; i += 1) {
      out.push({
        startMs: Math.round(startMs + i * step),
        endMs: Math.round(i === pieces - 1 ? endMs : startMs + (i + 1) * step),
      });
    }
  }
  return out;
}

/**
 * Group voice vectors into speakers: average-linkage agglomerative clustering
 * on cosine similarity, stopping below `threshold`. Returns a 0-based speaker
 * index per vector, numbered in order of first appearance.
 *
 * Uses the nearest-neighbour chain, which finds the same merges as the naive
 * algorithm for average linkage in O(n²) time — a four-hour recording has
 * about two thousand windows.
 */
export function groupVoices(
  vectors: readonly Float32Array[],
  threshold: number = SAME_SPEAKER_SIMILARITY,
): number[] {
  const n = vectors.length;
  if (n === 0) return [];
  const unit = vectors.map(normalize);
  // Similarity between active clusters, kept up to date by Lance–Williams.
  const sim: Float64Array[] = unit.map((a) => {
    const row = new Float64Array(n);
    for (let j = 0; j < n; j += 1) row[j] = dot(a, unit[j]!);
    return row;
  });
  const size = new Array<number>(n).fill(1);
  const active = new Array<boolean>(n).fill(true);
  const merges: Array<{ a: number; b: number; similarity: number }> = [];
  const chain: number[] = [];
  let remaining = n;

  while (remaining > 1) {
    if (chain.length === 0) chain.push(active.indexOf(true));
    const top = chain[chain.length - 1]!;
    // The most similar other active cluster; prefer the previous chain link on a tie.
    const previous = chain.length > 1 ? chain[chain.length - 2]! : -1;
    let best = previous;
    let bestSim = previous >= 0 ? sim[top]![previous]! : -Infinity;
    for (let j = 0; j < n; j += 1) {
      if (!active[j] || j === top) continue;
      if (sim[top]![j]! > bestSim) {
        bestSim = sim[top]![j]!;
        best = j;
      }
    }
    if (best === previous) {
      // Reciprocal nearest neighbours: merge `previous` into `top`.
      chain.pop();
      chain.pop();
      merges.push({ a: top, b: previous, similarity: bestSim });
      const sa = size[top]!;
      const sb = size[previous]!;
      for (let j = 0; j < n; j += 1) {
        if (!active[j] || j === top || j === previous) continue;
        const s = (sa * sim[top]![j]! + sb * sim[previous]![j]!) / (sa + sb);
        sim[top]![j] = s;
        sim[j]![top] = s;
      }
      size[top] = sa + sb;
      active[previous] = false;
      remaining -= 1;
    } else {
      chain.push(best);
    }
  }

  // Cut the dendrogram: apply the merges at or above the threshold, most
  // similar first (average linkage is monotone, so the order is consistent).
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (const m of merges.sort((x, y) => y.similarity - x.similarity)) {
    if (m.similarity < threshold) break;
    parent[find(m.b)] = find(m.a);
  }
  const label = new Map<number, number>();
  return unit.map((_, i) => {
    const root = find(i);
    if (!label.has(root)) label.set(root, label.size);
    return label.get(root)!;
  });
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return new Float32Array(v.length);
  return v.map((x) => x / norm);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i]! * b[i]!;
  return s;
}

/** Vectors packed into one buffer for storage, and back. */
export function packVectors(vectors: readonly Float32Array[]): Uint8Array | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]!.length;
  const out = new Float32Array(vectors.length * dim);
  vectors.forEach((v, i) => out.set(v, i * dim));
  return new Uint8Array(out.buffer);
}

export function unpackVectors(packed: Uint8Array, count: number): Float32Array[] {
  if (count === 0) return [];
  const aligned = new Float32Array(packed.byteLength / 4);
  new Uint8Array(aligned.buffer).set(packed);
  const dim = aligned.length / count;
  return Array.from({ length: count }, (_, i) => aligned.slice(i * dim, (i + 1) * dim));
}
