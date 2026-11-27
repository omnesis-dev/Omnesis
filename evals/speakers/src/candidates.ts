// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Adrien Conrath

/**
 * Candidate ways to group a session's voice windows into speakers.
 *
 * Every candidate is a pure function of the session's window vectors and
 * durations. They share the production average-linkage clustering,
 * re-implemented here so the dendrogram of a session can be built once and
 * cut at many thresholds; a test holds the copy to the production
 * `groupVoices`.
 *
 *  - C0: the rule production had before this eval, kept as the baseline:
 *        speakers under `min(8 s, 15 %)` are folded away.
 *
 *  - C1: the small-speaker floor grows with the session,
 *        `max(8 s, share × voiced time)`, instead of `min(8 s, 15 %)`.
 *  - C2: only windows of at least L ms are clustered; shorter ones join the
 *        nearest resulting speaker, then the production floor applies.
 *  - C3: C2 with the C1 floor.
 *  - C5: Omi's conversation resolution — AHC, anchor voices with enough talk
 *        absorb nearby fragments, and only voices with enough talk count.
 *  - C4: spectral clustering on the reliable windows with the speaker count
 *        estimated from the eigengap (NME-SC), see `spectral.ts`.
 */

import {
  LONG_SESSION_SPEAKER_SHARE,
  MIN_SPEAKER_MS,
  MIN_SPEAKER_SHARE,
} from "@omnesis/gateway/src/recordings/voices/voices.js";

import { spectralGroups } from "./spectral.js";
import { dot, normalize } from "./vectors.js";

export { dot, normalize };

export interface Merge {
  a: number;
  b: number;
  similarity: number;
}

/** Average-linkage merges (nearest-neighbour chain), most similar first. Same as production. */
export function ahcMerges(unit: readonly Float32Array[]): Merge[] {
  const n = unit.length;
  if (n < 2) return [];
  const sim: Float64Array[] = unit.map((a) => {
    const row = new Float64Array(n);
    for (let j = 0; j < n; j += 1) row[j] = dot(a, unit[j]!);
    return row;
  });
  const size = new Array<number>(n).fill(1);
  const active = new Array<boolean>(n).fill(true);
  const merges: Merge[] = [];
  const chain: number[] = [];
  let remaining = n;
  while (remaining > 1) {
    if (chain.length === 0) chain.push(active.indexOf(true));
    const top = chain[chain.length - 1]!;
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
  return merges.sort((x, y) => y.similarity - x.similarity);
}

/** Cluster roots after applying the merges at or above `threshold`. */
export function cutMerges(n: number, merges: readonly Merge[], threshold: number): number[] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  for (const m of merges) {
    if (m.similarity < threshold) break;
    parent[find(m.b)] = find(m.a);
  }
  return parent.map((_, i) => find(i));
}

/** Unit mean vector of each group (optionally weighted). */
export function centroids(
  groups: readonly number[],
  unit: readonly Float32Array[],
  weights?: readonly number[],
): Map<number, Float32Array> {
  const sums = new Map<number, Float32Array>();
  groups.forEach((g, i) => {
    if (g < 0) return;
    let s = sums.get(g);
    if (!s) sums.set(g, (s = new Float32Array(unit[i]!.length)));
    const w = weights ? weights[i]! : 1;
    const u = unit[i]!;
    for (let j = 0; j < u.length; j += 1) s[j]! += w * u[j]!;
  });
  const out = new Map<number, Float32Array>();
  for (const [g, s] of sums) out.set(g, normalize(s));
  return out;
}

function talk(groups: readonly number[], durations: readonly number[]): Map<number, number> {
  const t = new Map<number, number>();
  groups.forEach((g, i) => t.set(g, (t.get(g) ?? 0) + durations[i]!));
  return t;
}

/** The floor production had before this eval, `min(8 s, 15 % of voiced time)`. */
export const originalFloor = (voicedMs: number): number =>
  Math.min(MIN_SPEAKER_MS, voicedMs * MIN_SPEAKER_SHARE);

/** The floor production uses now: the original one, or 5 % of a long session. */
export const productionFloor = (voicedMs: number): number =>
  Math.max(originalFloor(voicedMs), voicedMs * LONG_SESSION_SPEAKER_SHARE);

/** The proportional floor, `max(8 s, share × voiced time)`. */
export const proportionalFloor =
  (share: number, minMs = MIN_SPEAKER_MS) =>
  (voicedMs: number): number =>
    Math.max(minMs, voicedMs * share);

/**
 * Move the windows of groups below `floorMs` to the most similar large group
 * (by unweighted mean vector); the longest group always counts as large.
 * The production rule, with the floor as a parameter.
 */
export function absorbSmall(
  groups: readonly number[],
  unit: readonly Float32Array[],
  durations: readonly number[],
  floorMs: number,
): number[] {
  const time = talk(groups, durations);
  const longest = [...time].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const large = [...time].filter(([g, t]) => t >= floorMs || g === longest).map(([g]) => g);
  if (large.length === time.size) return [...groups];
  const c = centroids(
    groups.map((g) => (large.includes(g) ? g : -1)),
    unit,
  );
  return groups.map((g, i) => (c.has(g) ? g : nearest(unit[i]!, c)));
}

function nearest(v: Float32Array, c: Map<number, Float32Array>): number {
  let best = -1;
  let bestSim = -Infinity;
  for (const [g, m] of c) {
    const s = dot(v, m);
    if (s > bestSim) {
      bestSim = s;
      best = g;
    }
  }
  return best;
}

/** 0-based labels numbered by first appearance. */
export function relabel(groups: readonly number[]): number[] {
  const label = new Map<number, number>();
  return groups.map((g) => {
    if (!label.has(g)) label.set(g, label.size);
    return label.get(g)!;
  });
}

/** One session's windows, with the dendrograms candidates reuse. */
export class Session {
  readonly unit: Float32Array[];
  readonly voicedMs: number;
  private readonly memo = new Map<number, { idx: number[]; merges: Merge[] }>();

  constructor(
    readonly vectors: readonly Float32Array[],
    readonly durations: readonly number[],
  ) {
    this.unit = vectors.map(normalize);
    this.voicedMs = durations.reduce((a, b) => a + b, 0);
  }

  private readonly results = new Map<string, unknown>();

  /** A per-session memo for work several parameter sets share. */
  cached<T>(key: string, compute: () => T): T {
    if (!this.results.has(key)) this.results.set(key, compute());
    return this.results.get(key) as T;
  }

  /** Windows of at least `minMs` (all when fewer than two qualify) and their merges. */
  reliable(minMs: number): { idx: number[]; merges: Merge[] } {
    let m = this.memo.get(minMs);
    if (!m) {
      let idx = this.durations.flatMap((d, i) => (d >= minMs ? [i] : []));
      if (idx.length < 2) idx = this.durations.map((_, i) => i);
      m = { idx, merges: ahcMerges(idx.map((i) => this.unit[i]!)) };
      this.memo.set(minMs, m);
    }
    return m;
  }
}

export interface Candidate {
  name: string;
  family: string;
  params: Record<string, number>;
  group(s: Session): number[];
}

export function c0(threshold: number): Candidate {
  return {
    name: `C0 t=${threshold}`,
    family: "C0",
    params: { threshold },
    group: (s) => clusterReliable(s, threshold, 0, originalFloor),
  };
}

/**
 * C1/C2/C3: cluster windows ≥ `minWindowMs` at `threshold`, place the others
 * at the nearest speaker, then fold speakers under `floor(voiced)`.
 */
export function clusterReliable(
  s: Session,
  threshold: number,
  minWindowMs: number,
  floor: (voicedMs: number) => number,
): number[] {
  const n = s.unit.length;
  if (n === 0) return [];
  const { idx, merges } = s.reliable(minWindowMs);
  const roots = cutMerges(idx.length, merges, threshold);
  const groups = new Array<number>(n).fill(-1);
  idx.forEach((i, k) => (groups[i] = idx[roots[k]!]!));
  if (idx.length < n) {
    const c = centroids(groups, s.unit);
    for (let i = 0; i < n; i += 1) if (groups[i]! < 0) groups[i] = nearest(s.unit[i]!, c);
  }
  return relabel(absorbSmall(groups, s.unit, s.durations, floor(s.voicedMs)));
}

export function c1(threshold: number, share: number): Candidate {
  return {
    name: `C1 t=${threshold} share=${share}`,
    family: "C1",
    params: { threshold, share },
    group: (s) => clusterReliable(s, threshold, 0, proportionalFloor(share)),
  };
}

export function c2(threshold: number, minWindowMs: number): Candidate {
  return {
    name: `C2 t=${threshold} L=${minWindowMs / 1000}s`,
    family: "C2",
    params: { threshold, minWindowMs },
    group: (s) => clusterReliable(s, threshold, minWindowMs, originalFloor),
  };
}

export function c3(threshold: number, minWindowMs: number, share: number): Candidate {
  return {
    name: `C3 t=${threshold} L=${minWindowMs / 1000}s share=${share}`,
    family: "C3",
    params: { threshold, minWindowMs, share },
    group: (s) => clusterReliable(s, threshold, minWindowMs, proportionalFloor(share)),
  };
}

export interface OmiParams {
  /** AHC cut, cosine similarity (Omi: 1 − 0.70). */
  threshold: number;
  /** A voice with at least this much talk is an anchor (Omi: 30 s). */
  anchorMs: number;
  /** A fragment this similar to its nearest anchor joins it (Omi: 1 − 0.60). */
  absorbSimilarity: number;
  /** A voice is a participant once it has this much talk (Omi: 10 s). */
  participantMs: number;
}

/**
 * Omi's resolution (`conversation_speakers.py`, incumbent grouping): AHC cut,
 * anchors' duration-weighted centroids absorb fragments smallest first, and a
 * voice under the participant floor is not a participant. Omi leaves such a
 * voice as an unlabelled extra id; here its windows go to the nearest
 * participant, since every Omnesis speaker is shown to the owner.
 */
export function omiGroups(s: Session, p: OmiParams): number[] {
  const n = s.unit.length;
  if (n === 0) return [];
  const { merges } = s.reliable(0);
  const groups = cutMerges(n, merges, p.threshold);
  const time = talk(groups, s.durations);
  const weighted = centroids(groups, s.unit, s.durations);
  const anchors = new Map([...weighted].filter(([g]) => time.get(g)! >= p.anchorMs));
  if (anchors.size > 0) {
    const target = new Map<number, number>();
    const fragments = [...time.keys()]
      .filter((g) => !anchors.has(g))
      .sort((a, b) => time.get(a)! - time.get(b)!);
    for (const g of fragments) {
      const a = nearest(weighted.get(g)!, anchors);
      if (dot(weighted.get(g)!, anchors.get(a)!) > p.absorbSimilarity) target.set(g, a);
    }
    for (let i = 0; i < n; i += 1) groups[i] = target.get(groups[i]!) ?? groups[i]!;
  }
  return relabel(absorbSmall(groups, s.unit, s.durations, p.participantMs));
}

export function c5(p: OmiParams): Candidate {
  return {
    name: `C5 t=${p.threshold} anchor=${p.anchorMs / 1000}s absorb=${p.absorbSimilarity} part=${p.participantMs / 1000}s`,
    family: "C5",
    params: { ...p },
    group: (s) => omiGroups(s, p),
  };
}

export interface SpectralParams {
  minWindowMs: number;
  maxSpeakers: number;
  /** Speakers under this floor share of voiced time fold into larger ones. */
  share: number;
}

export function c4(p: SpectralParams): Candidate {
  return {
    name: `C4 L=${p.minWindowMs / 1000}s max=${p.maxSpeakers} share=${p.share}`,
    family: "C4",
    params: { ...p },
    group: (s) => {
      const n = s.unit.length;
      if (n === 0) return [];
      const { idx } = s.reliable(p.minWindowMs);
      const sub = s.cached(`spectral:${p.minWindowMs}:${p.maxSpeakers}`, () =>
        spectralGroups(
          idx.map((i) => s.unit[i]!),
          p.maxSpeakers,
        ),
      );
      const groups = new Array<number>(n).fill(-1);
      idx.forEach((i, k) => (groups[i] = sub[k]!));
      if (idx.length < n) {
        const c = centroids(groups, s.unit);
        for (let i = 0; i < n; i += 1) if (groups[i]! < 0) groups[i] = nearest(s.unit[i]!, c);
      }
      return relabel(
        absorbSmall(groups, s.unit, s.durations, proportionalFloor(p.share)(s.voicedMs)),
      );
    },
  };
}

/** The owner's enrolled voice: the unit mean of the enrolment vectors. */
export function meanVoice(vectors: readonly Float32Array[]): Float32Array {
  if (vectors.length === 0) return new Float32Array(0);
  const sum = new Float32Array(vectors[0]!.length);
  for (const v of vectors) normalize(v).forEach((x, j) => (sum[j]! += x));
  return normalize(sum);
}

/**
 * The self-voice rule under review on the self-voice branch: the speaker
 * whose mean vector is most similar to the profile, when that reaches
 * `threshold`. Identical semantics to its `matchSelf`.
 */
export function matchSelf(
  vectors: readonly Float32Array[],
  labels: readonly number[],
  profile: Float32Array,
  threshold: number,
): { label: number; similarity: number } | null {
  const byLabel = new Map<number, Float32Array[]>();
  labels.forEach((label, i) => {
    const v = vectors[i];
    if (!v || v.length !== profile.length) return;
    byLabel.set(label, [...(byLabel.get(label) ?? []), v]);
  });
  const unit = normalize(profile);
  let best: { label: number; similarity: number } | null = null;
  for (const [label, group] of byLabel) {
    const similarity = dot(meanVoice(group), unit);
    if (similarity >= threshold && (!best || similarity > best.similarity))
      best = { label, similarity };
  }
  return best;
}

/**
 * Window-level pinning: windows at least `threshold` similar to the profile,
 * and `margin` more similar to it than to any other speaker the grouping
 * finds, are the owner's; the rest are grouped by `group`. A speaker whose
 * mean is itself that similar to the profile is the owner as well.
 * Returns labels numbered by first appearance.
 */
export function pinOwner(
  s: Session,
  profile: Float32Array,
  threshold: number,
  margin: number,
  group: (s: Session) => number[],
): number[] {
  const n = s.unit.length;
  const simOwner = s.unit.map((u) => dot(u, profile));
  const pinned = simOwner.map((x) => x >= threshold);
  const restIdx = pinned.flatMap((p, i) => (p ? [] : [i]));
  const labels = new Array<number>(n).fill(0);
  if (restIdx.length > 0) {
    const rest = new Session(
      restIdx.map((i) => s.vectors[i]!),
      restIdx.map((i) => s.durations[i]!),
    );
    const sub = group(rest);
    const c = centroids(sub, rest.unit);
    const ownerLike = new Set(
      [...c].filter(([, m]) => dot(m, profile) >= threshold).map(([g]) => g),
    );
    restIdx.forEach((i, k) => (labels[i] = ownerLike.has(sub[k]!) ? 0 : sub[k]! + 1));
    const others = new Map([...c].filter(([g]) => !ownerLike.has(g)).map(([g, m]) => [g + 1, m]));
    if (others.size > 0) {
      for (let i = 0; i < n; i += 1) {
        if (!pinned[i]) continue;
        const g = nearest(s.unit[i]!, others);
        if (simOwner[i]! - dot(s.unit[i]!, others.get(g)!) < margin) labels[i] = g;
      }
    }
  }
  return relabel(labels);
}
